const { redactUrl, redactText, validateHttpUrl } = require('../services/urlSecurity');
const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const db = require('../db');
const { parseCanvasOptions, buildCanvasArgs, buildWebrtcArgs, SOFTWARE_ENCODER } = require('../services/canvasStream');
const { resolveCanvasEncoder, fallbackEncoder, describeEncoder } = require('../services/canvasEncoder');
const { relay } = require('../services/webrtcRelay');

/**
 * Canvas playback stream
 * GET /api/canvas/stream?url=...&codec=h264|mpeg1&seek=...&video=copy|encode&audio=copy|encode
 *                        &deinterlace=auto|double&height=720&program=...&live=1
 *
 * Streams MPEG-TS for the canvas player (public/js/canvas/): H.264 + AAC for the WebCodecs
 * engine, MPEG-1 + MP2 for the JSMpeg engine.
 * The client reads the response body incrementally; closing it kills ffmpeg.
 */
router.get('/stream', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL parameter is required' });
    try { validateHttpUrl(url); } catch (error) { return res.status(400).json({ error: error.message }); }

    let options;
    try { options = parseCanvasOptions(req.query); } catch (error) { return res.status(400).json({ error: error.message }); }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);
    const encodesH264 = options.codec === 'h264' && options.videoMode === 'encode';
    const encoder = encodesH264 ? await resolveCanvasEncoder(settings.hwEncoder, ffmpegPath) : SOFTWARE_ENCODER;

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');

    let closed = false, ffmpeg = null;
    res.on('close', () => {
        closed = true;
        ffmpeg?.kill('SIGKILL');
    });

    const start = (encoder) => {
        console.log(`[Canvas] Starting ${options.codec} (video ${options.videoMode}${encodesH264 ? ` via ${describeEncoder(encoder)}` : ''}, audio ${options.audioMode}, deinterlace ${options.deinterlace}) stream at ${options.seek}s for: ${redactUrl(url)}`);
        const child = ffmpeg = spawn(ffmpegPath, buildCanvasArgs(url, { ...options, userAgent, encoder }));
        let produced = false, stderrTail = '';
        child.stdout.once('data', () => { produced = true; });
        child.stdout.pipe(res, { end: false });

        child.stderr.on('data', (data) => {
            const msg = data.toString();
            stderrTail = (stderrTail + msg).slice(-2000);
            if (/error/i.test(msg)) console.log(`[Canvas FFmpeg] ${redactText(msg)}`);
        });

        child.on('close', (code) => {
            if (closed || ffmpeg !== child) return;
            // The GPU failed before a single byte went out: the client never noticed, so step down.
            if (!produced && code !== 0 && encoder.kind !== 'software') {
                const next = fallbackEncoder(encoder);
                console.warn(`[Canvas] ${describeEncoder(encoder)} failed (${redactText(stderrTail.trim().split('\n').pop() || `code ${code}`)}), retrying with ${describeEncoder(next)}`);
                child.stdout.unpipe(res);
                return start(next);
            }
            if (code !== null && code !== 0 && code !== 255) console.error(`[Canvas] FFmpeg exited with code ${code}`);
            res.end();
        });

        child.on('error', (err) => {
            console.error('[Canvas] Failed to spawn FFmpeg:', redactText(err.message));
            if (!res.headersSent) res.status(500).json({ error: 'Canvas stream failed to start' });
        });
    };
    start(encoder);
});

/**
 * WebRTC canvas session ("Enhanced" engine)
 * GET /api/canvas/webrtc/session?url=...&video=copy|encode&deinterlace=auto|double&height=720&seek=...&program=...&live=1
 *
 * Starts ffmpeg publishing to the local MediaMTX and answers with a Server-Sent Events stream:
 *   data: {"type":"ready","id":"..."}    the browser may now POST its WHEP offer
 *   data: {"type":"ended"}               the source finished (VOD)
 *   data: {"type":"error","message":""}  ffmpeg failed
 * The open response is the session: closing it stops ffmpeg, like /stream.
 */
router.get('/webrtc/session', async (req, res) => {
    if (!relay.isAvailable()) return res.status(503).json({ error: 'WebRTC playback is not available on this server', code: 'webrtc-unavailable' });
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL parameter is required' });
    try { validateHttpUrl(url); } catch (error) { return res.status(400).json({ error: error.message }); }

    let options;
    try { options = parseCanvasOptions({ ...req.query, codec: undefined, audio: undefined }); } catch (error) { return res.status(400).json({ error: error.message }); }

    try {
        await relay.ensureStarted();
    } catch (error) {
        console.error('[WebRTC]', error.message);
        return res.status(503).json({ error: 'WebRTC media server failed to start', code: 'webrtc-unavailable' });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);
    const encoder = options.videoMode === 'encode' ? await resolveCanvasEncoder(settings.hwEncoder, ffmpegPath) : SOFTWARE_ENCODER;
    const session = relay.createSession(req.user?.id);

    let closed = false, ready = false;
    const send = (event) => { if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    // Comments keep proxies (and Cloudflare's 100 s idle limit) from closing a quiet session.
    const heartbeat = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15000);
    const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        relay.endSession(session.id);
        res.end();
    };
    res.on('close', finish);

    const start = (encoder) => {
        console.log(`[WebRTC] Session ${session.id.slice(0, 8)}: video ${options.videoMode}${options.videoMode === 'encode' ? ` via ${describeEncoder(encoder)}` : ''}, deinterlace ${options.deinterlace}, at ${options.seek}s for: ${redactUrl(url)}`);
        const child = session.ffmpeg = spawn(ffmpegPath, buildWebrtcArgs(url, relay.rtspUrl(session.name), { ...options, userAgent, encoder }));
        let stderrTail = '';
        child.stderr.on('data', (data) => {
            const msg = data.toString();
            stderrTail = (stderrTail + msg).slice(-2000);
            if (/error/i.test(msg)) console.log(`[WebRTC FFmpeg] ${redactText(msg)}`);
        });
        child.on('error', (error) => {
            console.error('[WebRTC] Failed to spawn FFmpeg:', redactText(error.message));
            send({ type: 'error', message: 'FFmpeg failed to start' });
            finish();
        });
        child.on('exit', (code, signal) => {
            if (closed || session.ffmpeg !== child) return;
            const reason = redactText(stderrTail.trim().split('\n').pop() || '');
            // The GPU failed before the stream went live: the browser is still waiting, so step down.
            if (!ready && code !== 0 && encoder.kind !== 'software') {
                const next = fallbackEncoder(encoder);
                console.warn(`[WebRTC] ${describeEncoder(encoder)} failed (${reason || signal || `code ${code}`}), retrying with ${describeEncoder(next)}`);
                return start(next);
            }
            if (code === 0) send({ type: 'ended' });
            else {
                console.error(`[WebRTC] FFmpeg exited with ${signal || `code ${code}`}: ${reason}`);
                send({ type: 'error', message: 'The stream stopped unexpectedly' });
            }
            finish();
        });
    };
    start(encoder);

    try {
        await relay.waitForPath(session.name, () => closed || session.ffmpeg.exitCode !== null);
        ready = true;
        send({ type: 'ready', id: session.id });
    } catch (error) {
        if (!closed) {
            send({ type: 'error', message: error.message });
            finish();
        }
    }
});

/** POST /api/canvas/webrtc/:id/whep  (application/sdp offer -> answer), relayed to MediaMTX. */
router.post('/webrtc/:id/whep', express.text({ type: 'application/sdp', limit: '64kb' }), async (req, res) => {
    const session = relay.getSession(req.params.id, req.user?.id);
    if (!session) return res.status(404).json({ error: 'Unknown WebRTC session' });
    if (typeof req.body !== 'string' || !req.body.startsWith('v=0')) return res.status(400).json({ error: 'Expected an SDP offer' });
    try {
        const answer = await relay.whep(session.name, req.body);
        if (answer.status !== 201) {
            console.warn(`[WebRTC] WHEP refused (${answer.status}): ${answer.body.slice(0, 200)}`);
            return res.status(502).json({ error: 'WebRTC negotiation failed' });
        }
        res.status(201).type('application/sdp').send(answer.body);
    } catch (error) {
        console.error('[WebRTC] WHEP relay failed:', error.message);
        res.status(502).json({ error: 'WebRTC media server unavailable' });
    }
});

module.exports = router;
