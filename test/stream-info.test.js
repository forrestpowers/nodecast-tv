const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInputInfo, InputInfoCapture, classify } = require('../server/services/streamInfo');
const probeCache = require('../server/services/probeCache');

const TS = `Input #0, mpegts, from 'http://provider.test/live/8150.ts':
  Duration: N/A, start: 61824.636756, bitrate: N/A
  Program 1
  Stream #0:0[0x100]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p(tv, bt709, top first), 1920x1080 [SAR 1:1 DAR 16:9], 29.97 fps, 59.94 tbr, 90k tbn
  Stream #0:1[0x101](eng): Audio: ac3 ([129][0][0][0] / 0x0081), 48000 Hz, 5.1(side), fltp, 384 kb/s
  Program 2
  Stream #0:2[0x200]: Video: mpeg2video (Main) ([2][0][0][0] / 0x0002), yuv420p(tv, progressive), 720x576 [SAR 16:15 DAR 4:3], 25 fps, 25 tbr, 90k tbn
  Stream #0:3[0x201](deu): Audio: mp2 ([3][0][0][0] / 0x0003), 48000 Hz, stereo, s16p, 192 kb/s
Stream mapping:
  Stream #0:0 -> #0:0 (h264 (native) -> h264 (h264_vaapi))
`;

const HLS = `Input #0, hls, from 'https://provider.test/live/abc/index.m3u8':
  Duration: N/A, start: 1.400000, bitrate: N/A
  Stream #0:0: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p(tv, bt709), 1280x720 [SAR 1:1 DAR 16:9], 50 fps, 50 tbr, 90k tbn
  Stream #0:1: Audio: aac (LC) ([15][0][0][0] / 0x000F), 48000 Hz, stereo, fltp
Output #0, rtsp, to 'rtsp://127.0.0.1:18554/nc1':
`;

test('the input block of a re-encoding ffmpeg reads like a probe result', () => {
    const info = parseInputInfo(TS, { url: 'http://provider.test/live/8150.ts' });
    assert.deepEqual({ video: info.video, audio: info.audio, size: `${info.width}x${info.height}`, channels: info.audioChannels, fieldOrder: info.fieldOrder, container: info.container, needsTranscode: info.needsTranscode, source: info.source },
        { video: 'h264', audio: 'ac3', size: '1920x1080', channels: 6, fieldOrder: 'tt', container: 'mpegts', needsTranscode: true, source: 'stream' });
    assert.equal(info.hasBFrames, null, 'unknown from this output');

    const second = parseInputInfo(TS, { program: '2' });
    assert.deepEqual([second.video, second.audio, second.height, second.audioChannels, second.fieldOrder], ['mpeg2video', 'mp2', 576, 2, 'progressive']);

    const hls = parseInputInfo(HLS, { url: 'https://provider.test/live/abc/index.m3u8' });
    assert.deepEqual([hls.video, hls.audio, hls.width, hls.audioChannels, hls.fieldOrder, hls.container, hls.compatible], ['h264', 'aac', 1280, 2, 'unknown', 'hls', true]);
});

test('nothing is reported until the block is complete, and then only once', () => {
    const seen = [];
    const capture = new InputInfoCapture((info) => seen.push(info), { url: 'x' });
    const lines = TS.split('\n');
    for (const line of lines.slice(0, 5)) capture.feed(line + '\n');
    assert.equal(seen.length, 0, 'the block is still open');
    for (const line of lines.slice(5)) capture.feed(line + '\n');
    capture.feed('frame=  120 fps= 30\n[http @ 0x1] error\n');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].video, 'h264');

    const none = [];
    const noVideo = new InputInfoCapture((info) => none.push(info), {});
    noVideo.feed("Input #0, mp3, from 'x':\n  Stream #0:0: Audio: mp3, 44100 Hz, stereo\nStream mapping:\n");
    assert.equal(none.length, 0, 'audio-only input is not a probe result');
});

test('classification matches what the browser can play', () => {
    assert.deepEqual(classify({ video: 'h264', audio: 'aac', container: 'hls', url: 'x.m3u8' }), { compatible: true, needsRemux: false, needsTranscode: false });
    assert.deepEqual(classify({ video: 'h264', audio: 'aac', container: 'mpegts', url: 'x.ts' }), { compatible: false, needsRemux: true, needsTranscode: false });
    assert.deepEqual(classify({ video: 'h264', audio: 'ac3', container: 'mpegts', url: 'x.ts' }).needsTranscode, true);
    assert.deepEqual(classify({ video: 'h264', audio: 'aac', container: 'matroska,webm', url: 'x.mkv' }).needsTranscode, true);
});

test('the probe cache keeps answers for a day, failures for 30 seconds, and stays bounded', () => {
    let now = 1000;
    probeCache._resetForTests(() => now);
    const key = probeCache.key('http://a/1.ts', undefined, '1');
    assert.equal(key, probeCache.key('http://a/1.ts', '', '1'), 'no user agent and an empty one are the same key');
    probeCache.set(key, { video: 'h264' });
    now += 23 * 3600 * 1000;
    assert.equal(probeCache.get(key)?.video, 'h264');
    now += 2 * 3600 * 1000;
    assert.equal(probeCache.get(key), null);

    probeCache.set(key, { error: 'down' }, { failed: true });
    now += 29 * 1000;
    assert.equal(probeCache.get(key)?.error, 'down');
    now += 2 * 1000;
    assert.equal(probeCache.get(key), null);

    for (let i = 0; i <= probeCache.MAX_ENTRIES; i++) probeCache.set(probeCache.key(`http://a/${i}`, '', null), { i });
    assert.equal(probeCache.get(probeCache.key('http://a/0', '', null)), null, 'the oldest entry went');
    assert.equal(probeCache.get(probeCache.key(`http://a/${probeCache.MAX_ENTRIES}`, '', null))?.i, probeCache.MAX_ENTRIES);
    probeCache._resetForTests();
});
