const { ProbeLeases, parseProbeLease, requestCancellation, cancelled } = require('../services/probeLeases');
const probeLeases = new ProbeLeases();
const { providerSlots, playbackKey } = require('../services/providerSlots');
const { HTTP_RECONNECT_ARGS, PROVIDER_RETRY_DELAY_MS, isProviderRejection } = require('../services/ffmpegNetwork');
const { parseProgram, selectProgramStreams } = require('../services/mpegTsProgram');
const { redactUrl, redactText, validateHttpUrl, FFMPEG_PROTOCOL_WHITELIST } = require('../services/urlSecurity');
const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');

/**
 * Probe endpoint - detects stream codecs and container
 * GET /api/probe?url=...
 * 
 * Returns:
 * {
 *   video: "h264",
 *   audio: "aac",
 *   container: "mpegts",
 *   compatible: true,
 *   needsRemux: false,
 *   needsTranscode: false
 * }
 */

const probeCache = require('../services/probeCache');
const { classify } = require('../services/streamInfo');

/**
 * Probe stream with ffprobe
 */
function probeStream(url, ffprobePath, userAgent = null, timeout = 15000, signal, holder) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'error',
            '-user_agent', userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            '-multiple_requests', '0',
            ...HTTP_RECONNECT_ARGS,
            '-print_format', 'json',
            '-show_streams',
            '-show_programs',
            '-show_format',
            '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST,
            '-probesize', '5000000',
            '-analyzeduration', '5000000',
            url
        ];

        if (signal?.aborted) { reject(cancelled()); return; }
        const proc = spawn(ffprobePath, args, { windowsHide: true });
        let stdout = '', stderr = '', failure;
        const stop = error => {
            if (failure) return;
            failure = error;
            proc.kill('SIGKILL');
        };
        const abort = () => stop(cancelled());
        holder?.track(proc);
        holder?.onStopped(abort);
        const timer = setTimeout(() => stop(new Error('Probe timeout')), timeout);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        proc.stdout.on('data', data => { stdout += data; });
        proc.stderr.on('data', data => { stderr = (stderr + data).slice(-65536); });
        proc.on('error', error => { failure ||= error; });
        proc.once('close', code => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (failure) { reject(failure); return; }
            if (code !== 0) { reject(new Error(`ffprobe exited with code ${code}: ${redactText(stderr)}`)); return; }
            try { resolve(JSON.parse(stdout)); }
            catch { reject(new Error('Failed to parse ffprobe output')); }
        });
    });
}

/**
 * Analyze probe result and determine compatibility
 */
function analyzeProbeResult(probeResult, url, program = null) {
    const streams = selectProgramStreams(probeResult, program);
    const format = probeResult.format || {};

    const videoStream = streams.find(s => s.codec_type === 'video');
    const audioStream = streams.find(s => s.codec_type === 'audio');

    const videoCodec = videoStream?.codec_name?.toLowerCase() || 'unknown';
    const audioCodec = audioStream?.codec_name?.toLowerCase() || 'unknown';
    const container = format.format_name?.toLowerCase() || 'unknown';

    // Extract subtitle tracks
    const subtitles = streams
        .filter(s => s.codec_type === 'subtitle' && s.codec_name !== 'timed_id3' && s.codec_name !== 'bin_data')
        .map(s => ({
            index: s.index,
            language: s.tags?.language || 'und',
            title: s.tags?.title || s.tags?.language || `Track ${s.index}`,
            codec: s.codec_name
        }));

    return {
        video: videoCodec,
        audio: audioCodec,
        duration: Number.isFinite(Number(format.duration)) && Number(format.duration) > 0
            ? Number(format.duration) : 0,
        audioCodecs: streams.filter(s => s.codec_type === 'audio')
            .map(s => s.codec_name?.toLowerCase() || 'unknown'),
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        audioChannels: audioStream?.channels || 0, // For Smart Audio Copy
        // progressive, tt, bb, tb, bt or unknown (HLS playlists usually report unknown)
        fieldOrder: videoStream?.field_order || 'unknown',
        // B-frames rule out copying into WebRTC (null when unknown)
        hasBFrames: videoStream?.has_b_frames === undefined ? null : Number(videoStream.has_b_frames) > 0,
        container: container,
        ...classify({ video: videoCodec, audio: audioCodec, container, url }),
        subtitles: subtitles
    };
}

router.get('/', async (req, res) => {
    const { url, ua } = req.query;
    // ?fast=1: answer from the cache or say "pending", never probe. The player then starts the
    // stream at once (re-encoding everything), and the running stream fills the cache itself.
    const fast = req.query.fast === '1';
    let program, lease;
    try {
        program = parseProgram(req.query.program);
        lease = parseProbeLease(req.query);
        validateHttpUrl(url);
        if (ua !== undefined && (typeof ua !== 'string' || ua.length > 1024 || /[\x00-\x1f\x7f]/.test(ua))) throw new Error('Invalid probe user agent');
    } catch (error) { return res.status(400).json({ error: error.message }); }

    const cancellation = requestCancellation(req, res);
    const cacheKey = probeCache.key(url, ua, program);
    try {
        const result = await probeLeases.run(req.user?.id ?? null, lease, cancellation.signal, async signal => {
            const ffprobePath = req.app.locals.ffprobePath;
            if (!ffprobePath) return { video: 'unknown', audio: 'unknown', container: 'unknown', compatible: false, needsRemux: false, needsTranscode: true };
            const cached = probeCache.get(cacheKey);
            if (cached) return cached;
            if (fast) return { pending: true };
            console.log(`[Probe] Probing: ${redactUrl(url)}...`);
            // The probe is a provider connection too: it waits for this player's old stream to go.
            let holder;
            try {
                holder = await providerSlots.acquire(playbackKey(req), { url, keepSameUrl: true });
                const probe = () => probeStream(url, ffprobePath, ua, req.app.locals.probeTimeoutMs || 15000, signal, holder);
                const data = await probe().catch(async error => {
                    if (signal.aborted || holder.stopped || !isProviderRejection(error.message)) throw error;
                    console.warn(`[Probe] Provider rejected the connection, retrying once: ${redactText(error.message)}`);
                    await new Promise(resolve => setTimeout(resolve, PROVIDER_RETRY_DELAY_MS));
                    if (signal.aborted || holder.stopped) throw cancelled();
                    return probe();
                });
                if (signal.aborted) throw cancelled();
                const analysis = analyzeProbeResult(data, url, program);
                probeCache.set(cacheKey, analysis);
                return analysis;
            } catch (error) {
                if (signal.aborted || error.name === 'AbortError' || holder?.stopped) throw cancelled();
                const message = redactText(error.message);
                console.error('[Probe] Failed:', message);
                const fallback = { video: 'unknown', audio: 'unknown', container: 'unknown', compatible: false,
                    needsRemux: false, needsTranscode: true, error: message };
                probeCache.set(cacheKey, fallback, { failed: true });
                return fallback;
            } finally {
                holder?.finish();
            }
        });
        if (!cancellation.signal.aborted && !res.destroyed) res.json(result);
    } catch (error) {
        if (cancellation.signal.aborted || res.destroyed) return;
        if (error.name === 'AbortError') return res.status(409).json({ error: 'Playback probe was superseded' });
        res.status(error.code === 'PROBE_LIMIT' ? 503 : 500).json({ error: 'Unable to probe stream' });
    } finally { cancellation.dispose(); }
});

module.exports = router;
