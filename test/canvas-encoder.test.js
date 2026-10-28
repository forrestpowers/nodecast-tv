const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCanvasArgs, buildWebrtcArgs } = require('../server/services/canvasStream');
const { resolveCanvasEncoder, fallbackEncoder, describeEncoder, resolveSetting, _resetForTests } = require('../server/services/canvasEncoder');

const intel = { recommended: 'qsv', qsv: { available: true, device: '/dev/dri/renderD128' }, vaapi: { available: true, device: '/dev/dri/renderD128' } };
const vaapi = { kind: 'vaapi', device: '/dev/dri/renderD128', lowPower: false, hwDecode: true };

/** A stand-in ffmpeg: exits 0 unless its arguments match `failWhen`. */
function fakeFfmpeg(t, failWhen = null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-fake-ffmpeg-'));
    const file = path.join(dir, 'ffmpeg');
    const log = path.join(dir, 'calls.log');
    fs.writeFileSync(file, `#!/bin/sh\necho "$*" >> "${log}"\n${failWhen ? `case "$*" in *"${failWhen}"*) echo "Failed to initialise VAAPI" >&2; exit 1;; esac\n` : ''}exit 0\n`, { mode: 0o755 });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { file, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n') };
}

test('full GPU args: decode, deinterlace, scale and encode without B-frames on the GPU', () => {
    const args = buildWebrtcArgs('https://example.test/live.m3u8', 'rtsp://127.0.0.1:18554/x', { userAgent: 'ua', live: true, encoder: vaapi });
    const input = args.indexOf('-i');
    assert.deepEqual(args.slice(args.indexOf('-init_hw_device'), input),
        ['-init_hw_device', 'vaapi=va:/dev/dri/renderD128', '-filter_hw_device', 'va',
            '-hwaccel', 'vaapi', '-hwaccel_device', 'va', '-hwaccel_output_format', 'vaapi']);
    assert.equal(args[args.indexOf('-vf') + 1], "deinterlace_vaapi=auto=1,scale_vaapi=w=-2:h='min(ih,720)':format=nv12");
    const double = buildWebrtcArgs('https://example.test/live.m3u8', 'x', { userAgent: 'ua', live: true, deinterlace: 'double', encoder: vaapi });
    assert.match(double[double.indexOf('-vf') + 1], /^deinterlace_vaapi=rate=field:auto=1,/);
    assert.equal(args[args.indexOf('-c:v') + 1], 'h264_vaapi');
    assert.equal(args[args.indexOf('-profile:v') + 1], 'constrained_baseline');
    assert.equal(args[args.indexOf('-bf') + 1], '0');
    assert.equal(args[args.indexOf('-force_key_frames') + 1], 'expr:gte(t,n_forced*1)');
    assert.ok(!args.includes('libx264') && !args.includes('-low_power'));

    const stream = buildCanvasArgs('https://example.test/live.ts', { userAgent: 'ua', live: true, encoder: { ...vaapi, lowPower: true, hwDecode: false } });
    assert.equal(stream[stream.indexOf('-profile:v') + 1], 'main');
    assert.equal(stream[stream.indexOf('-low_power') + 1], '1');
    assert.ok(!stream.includes('-hwaccel'), 'CANVAS_HW_DECODE=false keeps decoding on the CPU');
    assert.equal(stream[stream.indexOf('-vf') + 1], "bwdif=mode=send_frame:deint=interlaced,scale=-2:'min(ih,720)',format=nv12,hwupload");
    assert.equal(stream[stream.indexOf('-force_key_frames') + 1], 'expr:gte(t,n_forced*2)');
});

test('the GPU is only opened when it encodes', () => {
    const copy = buildCanvasArgs('https://example.test/live.ts', { userAgent: 'ua', live: true, videoMode: 'copy', encoder: vaapi });
    assert.ok(!copy.includes('-init_hw_device'));
    assert.equal(copy[copy.indexOf('-c:v') + 1], 'copy');
    const mpeg1 = buildCanvasArgs('https://example.test/live.ts', { userAgent: 'ua', live: true, codec: 'mpeg1', encoder: vaapi });
    assert.ok(!mpeg1.includes('-init_hw_device'));
    assert.equal(mpeg1[mpeg1.indexOf('-c:v') + 1], 'mpeg1video');
});

test('the Hardware Encoder setting picks the canvas encoder', async (t) => {
    _resetForTests();
    const ffmpeg = fakeFfmpeg(t);
    assert.equal(resolveSetting('auto', intel), 'qsv');
    assert.deepEqual(await resolveCanvasEncoder('auto', ffmpeg.file, intel, {}), vaapi);
    assert.deepEqual(await resolveCanvasEncoder('vaapi', ffmpeg.file, intel, { CANVAS_HW_DECODE: 'false' }), { ...vaapi, hwDecode: false });
    assert.equal((await resolveCanvasEncoder('software', ffmpeg.file, intel, {})).kind, 'software');
    assert.equal((await resolveCanvasEncoder('nvenc', ffmpeg.file, intel, {})).kind, 'software', 'only VAAPI is wired up for canvas');
    assert.equal((await resolveCanvasEncoder('auto', ffmpeg.file, { recommended: 'software' }, {})).kind, 'software');
    // One test encode per profile, then cached.
    assert.equal(ffmpeg.calls().length, 2);
    assert.ok(ffmpeg.calls().every((call) => call.includes('h264_vaapi') && call.includes('-bf 0')));
    assert.equal(describeEncoder(vaapi), 'h264_vaapi (full GPU)');
});

test('a GPU that fails the test encode falls back to low power, then to libx264', async (t) => {
    _resetForTests();
    const lowPowerOnly = fakeFfmpeg(t, 'constrained_baseline -bf 0 -rc_mode');
    assert.deepEqual(await resolveCanvasEncoder('vaapi', lowPowerOnly.file, intel, {}), { ...vaapi, lowPower: true });

    _resetForTests();
    const broken = fakeFfmpeg(t, 'h264_vaapi');
    assert.deepEqual(await resolveCanvasEncoder('vaapi', broken.file, intel, {}), { kind: 'software' });
    assert.equal(describeEncoder({ kind: 'software' }), 'libx264');
});

test('a stream that fails before any output steps down: full GPU, CPU decode, libx264', () => {
    const cpuDecode = fallbackEncoder(vaapi);
    assert.deepEqual(cpuDecode, { ...vaapi, hwDecode: false });
    assert.equal(describeEncoder(cpuDecode), 'h264_vaapi (CPU decode)');
    assert.deepEqual(fallbackEncoder(cpuDecode), { kind: 'software' });
});
