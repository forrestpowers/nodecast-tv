const { parseProgram } = require('./mpegTsProgram');
const { FFMPEG_PROTOCOL_WHITELIST } = require('./urlSecurity');

/**
 * Canvas playback stream
 *
 * Produces one continuous MPEG-TS stream that the browser demuxes and decodes itself,
 * then draws on a <canvas>. No <video> element is involved, which is what lets playback
 * continue in browsers that suspend media elements (e.g. the Tesla in-car browser outside
 * of Park). Two codec profiles, one per client engine:
 *
 *   h264   H.264 Annex-B + AAC/ADTS  -> WebCodecs (hardware decode where available)
 *   mpeg1  MPEG-1 video + MP2        -> JSMpeg (WebAssembly; for browsers without WebCodecs,
 *                                       which includes the Tesla browser today)
 */

const MAX_HEIGHTS = new Set([360, 480, 720, 1080]);
const DEFAULT_MAX_HEIGHT = 720;
const MAX_SEEK_SECONDS = 7 * 24 * 60 * 60;
const MPEG1_BITRATES = { 360: 900, 480: 1400, 720: 2500, 1080: 4500 }; // kbit/s; MPEG-1 needs more than H.264

function parseCanvasOptions(query = {}) {
    const program = parseProgram(query.program);

    const seek = query.seek === undefined || query.seek === '' ? 0 : Number(query.seek);
    if (!Number.isFinite(seek) || seek < 0 || seek > MAX_SEEK_SECONDS) throw new Error('Invalid seek offset');

    const codec = query.codec === undefined ? 'h264' : String(query.codec);
    if (!['h264', 'mpeg1'].includes(codec)) throw new Error('Codec must be h264 or mpeg1');

    const videoMode = query.video === undefined ? 'encode' : String(query.video);
    if (!['copy', 'encode'].includes(videoMode)) throw new Error('Video mode must be copy or encode');

    const maxHeight = query.height === undefined ? DEFAULT_MAX_HEIGHT : Number(query.height);
    if (!MAX_HEIGHTS.has(maxHeight)) throw new Error('Height must be one of 360, 480, 720, 1080');

    const audioMode = query.audio === undefined ? 'encode' : String(query.audio);
    if (!['copy', 'encode'].includes(audioMode)) throw new Error('Audio mode must be copy or encode');

    const deinterlace = query.deinterlace === undefined ? 'auto' : String(query.deinterlace);
    if (!['auto', 'double'].includes(deinterlace)) throw new Error('Deinterlace must be auto or double');

    // MPEG-1 output is always encoded.
    const mpeg1 = codec === 'mpeg1';
    return {
        program, seek, codec, maxHeight, deinterlace, live: query.live === '1',
        videoMode: mpeg1 ? 'encode' : videoMode,
        audioMode: mpeg1 ? 'encode' : audioMode
    };
}

/**
 * Re-encodes always pass through bwdif. 'auto' only touches frames flagged interlaced and keeps
 * the frame rate (1080i59.94 becomes 29.97p, progressive input is untouched). 'double' is for
 * sources known to be interlaced: one frame per field, so 1080i59.94 keeps its 59.94 motion.
 * (Doubling unconditionally would also double the declared rate of progressive input and halve
 * x264's per-frame bitrate budget.)
 */
function deinterlaceFilter(deinterlace) {
    return deinterlace === 'double' ? 'bwdif=mode=send_field' : 'bwdif=mode=send_frame:deint=interlaced';
}

function h264Args(videoMode, maxHeight, deinterlace) {
    if (videoMode === 'copy') return ['-c:v', 'copy'];
    return [
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        // No B-frames or lookahead: frames leave the encoder in display order with low latency.
        '-tune', 'zerolatency',
        '-profile:v', 'main',
        '-pix_fmt', 'yuv420p',
        '-vf', `${deinterlaceFilter(deinterlace)},scale=-2:'min(ih,${maxHeight})'`,
        '-crf', '23',
        '-maxrate', maxHeight > 720 ? '6M' : '3500k',
        '-bufsize', maxHeight > 720 ? '12M' : '7M',
        // Regular IDR frames let the client start, recover and resync quickly.
        '-force_key_frames', 'expr:gte(t,n_forced*2)',
        '-sc_threshold', '0'
    ];
}

function mpeg1Args(maxHeight, deinterlace) {
    const kbps = MPEG1_BITRATES[maxHeight];
    return [
        '-c:v', 'mpeg1video',
        // MPEG-1 (and JSMpeg) only know the standard rates: snap to 24, 25 or 30 fps.
        '-vf', `${deinterlaceFilter(deinterlace)},fps=fps='if(lt(source_fps,24.5),24,if(lt(source_fps,27.5),25,30))',scale=-2:'min(ih,${maxHeight})'`,
        '-b:v', `${kbps}k`,
        '-maxrate', `${Math.round(kbps * 1.5)}k`,
        '-bufsize', `${kbps * 2}k`,
        // JSMpeg decodes I and P frames only.
        '-bf', '0',
        '-g', '60'
    ];
}

function audioArgs(codec, audioMode) {
    // AAC that is already stereo/mono goes out untouched (the client checked the codec and layout).
    if (audioMode === 'copy') return ['-c:a', 'copy'];
    const encoder = codec === 'mpeg1'
        ? ['-c:a', 'mp2', '-ac', '2', '-ar', '44100', '-b:a', '128k']
        : ['-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '160k'];
    return [...encoder, '-af', 'aresample=async=1:first_pts=0'];
}

function buildCanvasArgs(url, {
    userAgent, program = null, seek = 0, codec = 'h264', videoMode = 'encode', audioMode = 'encode',
    deinterlace = 'auto', maxHeight = DEFAULT_MAX_HEIGHT, live = false
} = {}) {
    const seeking = seek > 0 && !live;
    const media = [
        ...(codec === 'mpeg1' ? mpeg1Args(maxHeight, deinterlace) : h264Args(videoMode, maxHeight, deinterlace)),
        ...audioArgs(codec, audioMode)
    ];

    return [
        '-hide_banner',
        '-loglevel', 'warning',
        '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST,
        '-user_agent', userAgent,
        '-probesize', '2000000',
        '-analyzeduration', '3000000',
        '-fflags', '+genpts+discardcorrupt',
        '-err_detect', 'ignore_err',
        '-multiple_requests', '0',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_on_http_error', '4xx,5xx',
        '-reconnect_delay_max', '10',
        // Seeking needs Range requests; otherwise avoid them for providers that reject them.
        ...(seeking ? ['-ss', String(seek)] : ['-seekable', '0']),
        '-i', url,
        '-map', program === null ? '0:v:0' : `0:p:${program}:v:0`,
        '-map', program === null ? '0:a:0?' : `0:p:${program}:a:0?`,
        '-sn', '-dn',
        ...media,
        '-max_muxing_queue_size', '2048',
        '-f', 'mpegts',
        '-muxdelay', '0',
        '-muxpreload', '0',
        '-flush_packets', '1',
        '-'
    ];
}

module.exports = { parseCanvasOptions, buildCanvasArgs, DEFAULT_MAX_HEIGHT };
