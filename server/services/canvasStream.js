const { parseProgram } = require('./mpegTsProgram');
const { HTTP_RECONNECT_ARGS } = require('./ffmpegNetwork');
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
 *
 * buildWebrtcArgs publishes the same input to the local MediaMTX instead (H.264 without B-frames
 * + Opus over RTSP), which serves it to the browser over WebRTC (see webrtcRelay.js).
 */

const MAX_HEIGHTS = new Set([360, 480, 720, 1080]);
const DEFAULT_MAX_HEIGHT = 720;
const MAX_SEEK_SECONDS = 7 * 24 * 60 * 60;
const MPEG1_BITRATES = { 360: 900, 480: 1400, 720: 2500, 1080: 4500 }; // kbit/s; MPEG-1 needs more than H.264
const VAAPI_BITRATES = { 360: 1000, 480: 1600, 720: 3000, 1080: 5000 };  // kbit/s; VBR targets for h264_vaapi
const SOFTWARE_ENCODER = Object.freeze({ kind: 'software' });

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

/**
 * Encoder for H.264 re-encodes: { kind: 'software' } (libx264) or
 * { kind: 'vaapi', device, lowPower, hwDecode } (Intel/AMD GPU, see canvasEncoder.js).
 */
function h264Args(videoMode, maxHeight, deinterlace, { profile = 'main', keyframeSeconds = 2, encoder = SOFTWARE_ENCODER } = {}) {
    if (videoMode === 'copy') return ['-c:v', 'copy'];
    if (encoder.kind === 'vaapi') return vaapiArgs(maxHeight, deinterlace, { profile, keyframeSeconds, encoder });
    return [
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        // No B-frames or lookahead: frames leave the encoder in display order with low latency.
        '-tune', 'zerolatency',
        '-profile:v', profile,
        '-pix_fmt', 'yuv420p',
        '-vf', `${deinterlaceFilter(deinterlace)},scale=-2:'min(ih,${maxHeight})'`,
        '-crf', '23',
        '-maxrate', maxHeight > 720 ? '6M' : '3500k',
        '-bufsize', maxHeight > 720 ? '12M' : '7M',
        // Regular IDR frames let the client start, recover and resync quickly.
        '-force_key_frames', `expr:gte(t,n_forced*${keyframeSeconds})`,
        '-sc_threshold', '0'
    ];
}

/**
 * GPU encode. With hwDecode, frames never leave the GPU: decode, deinterlace_vaapi (auto=1 only
 * touches interlaced frames; rate=field is the 'double' mode), scale_vaapi, h264_vaapi. That is
 * ~10% of one core for 1080p59.94 -> 720p on an Intel iGPU, against ~75% when the CPU decodes and
 * scales and ~105% for libx264. Without hwDecode (sources the GPU can't decode), the CPU decodes,
 * deinterlaces and scales with the libx264 filters, and only the encode runs on the GPU.
 */
function vaapiArgs(maxHeight, deinterlace, { profile, keyframeSeconds, encoder }) {
    const kbps = VAAPI_BITRATES[maxHeight];
    const filters = encoder.hwDecode
        ? `deinterlace_vaapi=${deinterlace === 'double' ? 'rate=field:' : ''}auto=1,scale_vaapi=w=-2:h='min(ih,${maxHeight})':format=nv12`
        : `${deinterlaceFilter(deinterlace)},scale=-2:'min(ih,${maxHeight})',format=nv12,hwupload`;
    return [
        '-vf', filters,
        '-c:v', 'h264_vaapi',
        '-profile:v', profile === 'baseline' ? 'constrained_baseline' : profile,
        '-bf', '0',
        ...(encoder.lowPower ? ['-low_power', '1'] : []),
        '-rc_mode', 'VBR',
        '-b:v', `${kbps}k`,
        '-maxrate', `${Math.round(kbps * 1.25)}k`,
        '-bufsize', `${kbps * 2}k`,
        '-force_key_frames', `expr:gte(t,n_forced*${keyframeSeconds})`
    ];
}

/** Input options that open the GPU for a VAAPI encode (and optionally decode). */
function hwInputArgs(videoMode, encoder) {
    if (videoMode === 'copy' || encoder.kind !== 'vaapi') return [];
    return [
        '-init_hw_device', `vaapi=va:${encoder.device}`,
        '-filter_hw_device', 'va',
        ...(encoder.hwDecode ? ['-hwaccel', 'vaapi', '-hwaccel_device', 'va', '-hwaccel_output_format', 'vaapi'] : [])
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

function inputArgs(url, { userAgent, seek = 0, live = false, realtime = false, hw = [] }) {
    const seeking = seek > 0 && !live;
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
        ...HTTP_RECONNECT_ARGS,
        // Seeking needs Range requests; otherwise avoid them for providers that reject them.
        ...(seeking ? ['-ss', String(seek)] : ['-seekable', '0']),
        // Read at the source's own pace (for a server that relays in real time, not a client that buffers).
        ...(realtime ? ['-re'] : []),
        ...hw,
        '-i', url
    ];
}

function mapArgs(program) {
    return [
        '-map', program === null ? '0:v:0' : `0:p:${program}:v:0`,
        '-map', program === null ? '0:a:0?' : `0:p:${program}:a:0?`,
        '-sn', '-dn'
    ];
}

function buildCanvasArgs(url, {
    userAgent, program = null, seek = 0, codec = 'h264', videoMode = 'encode', audioMode = 'encode',
    deinterlace = 'auto', maxHeight = DEFAULT_MAX_HEIGHT, live = false, encoder = SOFTWARE_ENCODER
} = {}) {
    // MPEG-1 has no GPU encoder; JSMpeg output is always libavcodec.
    const gpu = codec === 'mpeg1' ? SOFTWARE_ENCODER : encoder;
    const media = [
        ...(codec === 'mpeg1' ? mpeg1Args(maxHeight, deinterlace) : h264Args(videoMode, maxHeight, deinterlace, { encoder: gpu })),
        ...audioArgs(codec, audioMode)
    ];

    return [
        ...inputArgs(url, { userAgent, seek, live, hw: hwInputArgs(videoMode, gpu) }),
        ...mapArgs(program),
        ...media,
        '-max_muxing_queue_size', '2048',
        '-f', 'mpegts',
        '-muxdelay', '0',
        '-muxpreload', '0',
        '-flush_packets', '1',
        '-'
    ];
}

/**
 * WebRTC target: publish to MediaMTX over RTSP. WebRTC carries neither B-frames (MediaMTX drops
 * such readers) nor AAC, so video is copied only when the client saw no B-frames, and audio is
 * always Opus. Encodes use constrained baseline and a 1 s GOP: WebRTC players can only join or
 * recover from packet loss at a keyframe, and the server cannot request one from ffmpeg.
 */
function buildWebrtcArgs(url, rtspUrl, {
    userAgent, program = null, seek = 0, videoMode = 'encode', deinterlace = 'auto',
    maxHeight = DEFAULT_MAX_HEIGHT, live = false, encoder = SOFTWARE_ENCODER
} = {}) {
    return [
        ...inputArgs(url, { userAgent, seek, live, realtime: true, hw: hwInputArgs(videoMode, encoder) }),
        ...mapArgs(program),
        ...h264Args(videoMode, maxHeight, deinterlace, { profile: 'baseline', keyframeSeconds: 1, encoder }),
        '-c:a', 'libopus', '-ac', '2', '-ar', '48000', '-b:a', '128k',
        '-af', 'aresample=async=1:first_pts=0',
        '-max_muxing_queue_size', '2048',
        '-f', 'rtsp',
        '-rtsp_transport', 'tcp',
        rtspUrl
    ];
}

module.exports = { parseCanvasOptions, buildCanvasArgs, buildWebrtcArgs, vaapiArgs, SOFTWARE_ENCODER, DEFAULT_MAX_HEIGHT };
