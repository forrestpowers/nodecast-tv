const { redactUrl, redactText, validateHttpUrl } = require('../services/urlSecurity');
const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const db = require('../db');
const { parseCanvasOptions, buildCanvasArgs } = require('../services/canvasStream');

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
    const args = buildCanvasArgs(url, { ...options, userAgent: db.getUserAgent(settings) });

    console.log(`[Canvas] Starting ${options.codec} (video ${options.videoMode}, audio ${options.audioMode}, deinterlace ${options.deinterlace}) stream at ${options.seek}s for: ${redactUrl(url)}`);

    let ffmpeg;
    try {
        ffmpeg = spawn(ffmpegPath, args);
    } catch (spawnErr) {
        console.error('[Canvas] Failed to spawn FFmpeg:', redactText(spawnErr.message));
        return res.status(500).json({ error: 'FFmpeg spawn failed' });
    }

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        if (/error/i.test(msg)) console.log(`[Canvas FFmpeg] ${redactText(msg)}`);
    });

    res.on('close', () => ffmpeg.kill('SIGKILL'));

    ffmpeg.on('exit', (code) => {
        if (code !== null && code !== 0 && code !== 255) console.error(`[Canvas] FFmpeg exited with code ${code}`);
    });

    ffmpeg.on('error', (err) => {
        console.error('[Canvas] Failed to spawn FFmpeg:', redactText(err.message));
        if (!res.headersSent) res.status(500).json({ error: 'Canvas stream failed to start' });
    });
});

module.exports = router;
