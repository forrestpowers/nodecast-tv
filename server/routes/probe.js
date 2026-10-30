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

// Probe cache (URL → result)
const probeCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Browser-compatible codecs
const BROWSER_VIDEO_CODECS = ['h264', 'avc', 'avc1'];
const BROWSER_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis'];

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

    // Check codec compatibility
    const videoOk = BROWSER_VIDEO_CODECS.some(c => videoCodec.includes(c));
    const audioOk = BROWSER_AUDIO_CODECS.some(c => audioCodec.includes(c));

    // Browser-safe containers
    // Note: We exclude 'webm' because ffprobe reports MKV as "matroska,webm", 
    // and H.264/AAC in MKV/WebM is not universally supported. Best to remux to MP4.
    const BROWSER_CONTAINERS = ['hls', 'mp4', 'mov'];
    const containerOk = BROWSER_CONTAINERS.some(c => container.includes(c));

    // Check if it's a raw TS stream (not HLS)
    const isRawTs = (container.includes('mpegts') || url.endsWith('.ts')) && !url.includes('.m3u8');

    // Extract subtitle tracks
    const subtitles = streams
        .filter(s => s.codec_type === 'subtitle' && s.codec_name !== 'timed_id3' && s.codec_name !== 'bin_data')
        .map(s => ({
            index: s.index,
            language: s.tags?.language || 'und',
            title: s.tags?.title || s.tags?.language || `Track ${s.index}`,
            codec: s.codec_name
        }));

    // Determine what processing is needed
    // 4. MKV files often cause OOM/decoding issues in browser fMP4 remux, 
    // so we force them to "needsTranscode" which uses HLS (more robust).
    // The frontend will still use "copy" mode if codecs are compatible.
    const isMkv = container.includes('matroska') || container.includes('webm') || url.endsWith('.mkv');

    // 1. Incompatible audio/video OR MKV -> Transcode (or HLS Copy)
    const needsTranscode = !audioOk || !videoOk || isMkv;

    // 2. Compatible audio/video but incompatible container (non-MKV) -> Remux (fMP4 pipe)
    const needsRemux = !needsTranscode && (!containerOk || isRawTs);

    const compatible = !needsTranscode && !needsRemux;

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
        compatible: compatible,
        needsRemux: needsRemux,
        needsTranscode: needsTranscode,
        subtitles: subtitles
    };
}

router.get('/', async (req, res) => {
    const { url, ua } = req.query;
    let program, lease;
    try {
        program = parseProgram(req.query.program);
        lease = parseProbeLease(req.query);
        validateHttpUrl(url);
        if (ua !== undefined && (typeof ua !== 'string' || ua.length > 1024 || /[\x00-\x1f\x7f]/.test(ua))) throw new Error('Invalid probe user agent');
    } catch (error) { return res.status(400).json({ error: error.message }); }

    const cancellation = requestCancellation(req, res);
    const cacheKey = JSON.stringify([url, ua || '', program]);
    try {
        const result = await probeLeases.run(req.user?.id ?? null, lease, cancellation.signal, async signal => {
            const ffprobePath = req.app.locals.ffprobePath;
            if (!ffprobePath) return { video: 'unknown', audio: 'unknown', container: 'unknown', compatible: false, needsRemux: false, needsTranscode: true };
            const cached = probeCache.get(cacheKey);
            if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.result;
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
                probeCache.set(cacheKey, { result: analysis, timestamp: Date.now() });
                return analysis;
            } catch (error) {
                if (signal.aborted || error.name === 'AbortError' || holder?.stopped) throw cancelled();
                const message = redactText(error.message);
                console.error('[Probe] Failed:', message);
                const fallback = { video: 'unknown', audio: 'unknown', container: 'unknown', compatible: false,
                    needsRemux: false, needsTranscode: true, error: message };
                probeCache.set(cacheKey, { result: fallback, timestamp: Date.now() - (CACHE_TTL - 30000) });
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
