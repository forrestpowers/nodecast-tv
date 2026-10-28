const { execFile } = require('child_process');
const hwDetect = require('./hwDetect');
const { vaapiArgs, SOFTWARE_ENCODER } = require('./canvasStream');

/**
 * Picks the H.264 encoder for canvas playback re-encodes (WebCodecs stream and WebRTC).
 *
 * Follows Settings -> Hardware Encoder: 'vaapi' and 'qsv' (Intel) — or 'auto' resolving to one of
 * them — use h264_vaapi on the GPU; everything else uses libx264. Before the GPU is used, one
 * short test encode with the real canvas settings (no B-frames, both H.264 profiles) proves the
 * driver can do it; if it can't, canvas playback stays on libx264. Results are cached per device.
 *
 * A stream whose ffmpeg fails before any output steps down (fallbackEncoder): full GPU ->
 * GPU encode with CPU decode (codecs the GPU can't decode) -> libx264.
 *
 * Environment: CANVAS_HW_DECODE=false keeps decoding and scaling on the CPU even when encoding on the GPU.
 */

const TEST_TIMEOUT_MS = 10000;
const tested = new Map(); // device -> Promise<{ lowPower } | null>

function vaapiDevice(capabilities) {
    return capabilities?.vaapi?.device || capabilities?.qsv?.device || null;
}

/** 'auto' resolves to the detected recommendation, like the regular transcoder does. */
function resolveSetting(setting, capabilities) {
    return setting === 'auto' ? (capabilities?.recommended || 'software') : (setting || 'software');
}

function runTestEncode(ffmpegPath, device, lowPower) {
    const encoder = { kind: 'vaapi', device, lowPower };
    const encode = (profile) => new Promise((resolve) => {
        execFile(ffmpegPath, [
            '-hide_banner', '-loglevel', 'error',
            '-init_hw_device', `vaapi=va:${device}`, '-filter_hw_device', 'va',
            '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
            '-frames:v', '10',
            ...vaapiArgs(360, 'auto', { profile, keyframeSeconds: 1, encoder }),
            '-f', 'null', '-'
        ], { timeout: TEST_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 256 * 1024 },
        (error, stdout, stderr) => resolve(error ? String(stderr || error.message).trim().split('\n').pop() : null));
    });
    return Promise.all([encode('main'), encode('baseline')]).then((errors) => errors.find(Boolean) || null);
}

/** Resolves to { lowPower } when the GPU encodes canvas output, or null. */
function testDevice(ffmpegPath, device) {
    if (!tested.has(device)) {
        tested.set(device, (async () => {
            // Some Intel generations only encode H.264 in low-power (VDENC) mode.
            for (const lowPower of [false, true]) {
                const error = await runTestEncode(ffmpegPath, device, lowPower);
                if (!error) {
                    console.log(`[Canvas] GPU encode verified on ${device}${lowPower ? ' (low power)' : ''}`);
                    return { lowPower };
                }
                console.warn(`[Canvas] GPU test encode failed on ${device}${lowPower ? ' (low power)' : ''}: ${error}`);
            }
            console.warn('[Canvas] Using libx264 for canvas playback');
            return null;
        })());
    }
    return tested.get(device);
}

/**
 * The encoder for a canvas re-encode given Settings -> Hardware Encoder.
 * Returns SOFTWARE_ENCODER or { kind: 'vaapi', device, lowPower, hwDecode }.
 */
async function resolveCanvasEncoder(setting, ffmpegPath = 'ffmpeg', capabilities, env = process.env) {
    // Startup detection runs a few seconds after boot; a request before that does it now (cached).
    capabilities ||= hwDetect.getCapabilities() || await hwDetect.detect(ffmpegPath);
    const resolved = resolveSetting(setting, capabilities);
    if (resolved !== 'vaapi' && resolved !== 'qsv') return SOFTWARE_ENCODER;
    const device = vaapiDevice(capabilities);
    if (!device) return SOFTWARE_ENCODER;
    const verified = await testDevice(ffmpegPath, device);
    if (!verified) return SOFTWARE_ENCODER;
    return { kind: 'vaapi', device, lowPower: verified.lowPower, hwDecode: env.CANVAS_HW_DECODE !== 'false' };
}

/** The next encoder to try after `encoder` failed before producing any output. */
function fallbackEncoder(encoder) {
    if (encoder.kind === 'vaapi' && encoder.hwDecode) return { ...encoder, hwDecode: false };
    return SOFTWARE_ENCODER;
}

/** Label for logs. */
function describeEncoder(encoder) {
    if (encoder.kind !== 'vaapi') return 'libx264';
    return `h264_vaapi${encoder.lowPower ? ' low-power' : ''}${encoder.hwDecode ? ' (full GPU)' : ' (CPU decode)'}`;
}

module.exports = { resolveCanvasEncoder, fallbackEncoder, describeEncoder, resolveSetting, _resetForTests: () => tested.clear() };
