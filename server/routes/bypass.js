const path = require('path');
const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { relay } = require('../services/webrtcRelay');
const { requestLimit } = require('../services/requestLimits');

/**
 * The login page's joke "Bypass login" button.
 *
 * It never touches authentication: it plays one fixed video through the WebRTC canvas engine,
 * so it also plays in the Tesla browser while driving. Mounted before the auth middleware, so it
 * is locked down: no parameters, the file is fixed, a few sessions at a time, rate limited.
 *
 *   GET  /api/bypass/session    Server-Sent Events session, as /api/canvas/webrtc/session
 *   POST /api/bypass/:id/whep   WHEP offer -> answer for that session
 *   GET  /api/bypass/video      the file itself, for browsers without the WebRTC engine
 *
 * assets/bypass.mp4 is pre-rendered for WebRTC (constrained baseline H.264, a keyframe every
 * second, Opus) and starts with 4 s of black: a viewer joins a moment after publishing starts,
 * and the login page covers the black with a fake progress screen.
 */

const VIDEO = path.join(__dirname, '..', 'assets', 'bypass.mp4');
const MAX_SESSIONS = 3;
const OWNER = 'bypass';
let active = 0;

router.use(requestLimit(20));

router.get('/video', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(VIDEO);
});

router.get('/session', async (req, res) => {
    if (!relay.isAvailable()) return res.status(503).json({ error: 'WebRTC playback is not available', code: 'webrtc-unavailable' });
    try {
        await relay.ensureStarted();
    } catch (error) {
        console.error('[Bypass]', error.message);
        return res.status(503).json({ error: 'WebRTC media server failed to start', code: 'webrtc-unavailable' });
    }
    if (active >= MAX_SESSIONS) return res.status(429).json({ error: 'Busy, try again shortly' });
    active++;
    let closed = false;
    const session = relay.createSession(OWNER);
    const send = (event) => { if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    const finish = () => {
        if (closed) return;
        closed = true;
        active--;
        relay.endSession(session.id);
        res.end();
    };
    res.on('close', finish);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Already WebRTC-ready, so it is only relayed in real time: no encoding.
    const ffmpeg = session.ffmpeg = spawn(req.app.locals.ffmpegPath || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-re', '-i', VIDEO,
        '-c', 'copy', '-f', 'rtsp', '-rtsp_transport', 'tcp', relay.rtspUrl(session.name)
    ]);
    ffmpeg.on('error', () => { send({ type: 'error', message: 'Playback failed to start' }); finish(); });
    ffmpeg.on('exit', (code) => {
        if (closed) return;
        send(code === 0 ? { type: 'ended' } : { type: 'error', message: 'Playback stopped' });
        finish();
    });

    try {
        await relay.waitForPath(session.name, () => closed || ffmpeg.exitCode !== null, 10000);
        send({ type: 'ready', id: session.id, whep: `/api/bypass/${session.id}/whep` });
    } catch (error) {
        send({ type: 'error', message: error.message });
        finish();
    }
});

router.post('/:id/whep', express.text({ type: 'application/sdp', limit: '64kb' }), async (req, res) => {
    const session = relay.getSession(req.params.id, OWNER);
    if (!session) return res.status(404).json({ error: 'Unknown session' });
    if (typeof req.body !== 'string' || !req.body.startsWith('v=0')) return res.status(400).json({ error: 'Expected an SDP offer' });
    try {
        const answer = await relay.whep(session.name, req.body);
        if (answer.status !== 201) return res.status(502).json({ error: 'WebRTC negotiation failed' });
        res.status(201).type('application/sdp').send(answer.body);
    } catch (error) {
        res.status(502).json({ error: 'WebRTC media server unavailable' });
    }
});

module.exports = router;
