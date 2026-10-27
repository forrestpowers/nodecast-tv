const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { parseCanvasOptions, buildCanvasArgs } = require('../server/services/canvasStream');
const { TsDemuxer, readTimestamp, parseSps } = require('../public/js/canvas/ts-demuxer.js');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('canvas options default to a 720p H.264 re-encode from the start', () => {
    assert.deepEqual(parseCanvasOptions({}),
        { program: null, seek: 0, codec: 'h264', maxHeight: 720, deinterlace: 'auto', live: false, videoMode: 'encode', audioMode: 'encode' });
    assert.deepEqual(parseCanvasOptions({ seek: '61.5', video: 'copy', audio: 'copy', deinterlace: 'double', height: '480', program: '7', live: '1' }),
        { program: '7', seek: 61.5, codec: 'h264', maxHeight: 480, deinterlace: 'double', live: true, videoMode: 'copy', audioMode: 'copy' });
    // MPEG-1 is always encoded, audio included.
    const mpeg1 = parseCanvasOptions({ codec: 'mpeg1', video: 'copy', audio: 'copy' });
    assert.deepEqual([mpeg1.videoMode, mpeg1.audioMode], ['encode', 'encode']);
});

test('canvas options reject malformed input', () => {
    for (const query of [{ seek: '-1' }, { seek: 'abc' }, { video: 'hevc' }, { audio: 'opus' }, { deinterlace: 'yes' },
        { codec: 'vp9' }, { height: '2160' }, { program: '0' }, { program: 'x' }]) {
        assert.throws(() => parseCanvasOptions(query), undefined, JSON.stringify(query));
    }
});

test('canvas args emit H.264 + AAC in MPEG-TS and only seek VOD', () => {
    const vod = buildCanvasArgs('https://example.test/movie.mp4', { userAgent: 'ua', seek: 90, videoMode: 'encode', maxHeight: 480 });
    assert.equal(vod[vod.indexOf('-ss') + 1], '90');
    assert.ok(vod.indexOf('-ss') < vod.indexOf('-i'), 'input seeking');
    assert.ok(!vod.includes('-seekable'));
    assert.equal(vod[vod.indexOf('-c:v') + 1], 'libx264');
    assert.equal(vod[vod.indexOf('-vf') + 1], "bwdif=mode=send_frame:deint=interlaced,scale=-2:'min(ih,480)'");
    assert.equal(vod[vod.indexOf('-c:a') + 1], 'aac');
    assert.ok(vod.includes('-af'));
    assert.equal(vod[vod.indexOf('-f') + 1], 'mpegts');
    assert.equal(vod.at(-1), '-');

    const live = buildCanvasArgs('https://example.test/live.m3u8', { userAgent: 'ua', seek: 90, videoMode: 'copy', live: true, program: '3' });
    assert.ok(!live.includes('-ss'));
    assert.equal(live[live.indexOf('-seekable') + 1], '0');
    assert.equal(live[live.indexOf('-c:v') + 1], 'copy');
    assert.equal(live[live.indexOf('-map') + 1], '0:p:3:v:0');
});

test('copied AAC skips the audio filter, and known interlaced sources keep one frame per field', () => {
    const copy = buildCanvasArgs('https://example.test/live.ts', { userAgent: 'ua', videoMode: 'copy', audioMode: 'copy', live: true });
    assert.deepEqual(copy.slice(copy.indexOf('-c:v'), copy.indexOf('-c:v') + 4), ['-c:v', 'copy', '-c:a', 'copy']);
    assert.ok(!copy.includes('-af') && !copy.includes('-vf'));

    const interlaced = buildCanvasArgs('https://example.test/live.ts', { userAgent: 'ua', deinterlace: 'double', live: true });
    assert.equal(interlaced[interlaced.indexOf('-vf') + 1], "bwdif=mode=send_field,scale=-2:'min(ih,720)'");
});

test('SPS parsing flags interlaced H.264 so copy mode can fall back before decoding', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
    const spsOf = (extra) => {
        const encoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=30',
            '-frames:v', '2', ...extra, '-c:v', 'libx264', '-profile:v', 'high', '-f', 'mpegts', '-'], { maxBuffer: 16 * 1024 * 1024 });
        assert.equal(encoded.status, 0, encoded.stderr?.toString());
        let sps = null;
        const demuxer = new TsDemuxer({ onVideo: (au) => { sps ||= au.sps; } });
        demuxer.push(new Uint8Array(encoded.stdout));
        demuxer.flush();
        return parseSps(sps);
    };
    assert.deepEqual(spsOf([]), { profileIdc: 100, chromaFormatIdc: 1, bitDepth: 8, frameMbsOnly: true, width: 640, height: 480 });
    const interlaced = spsOf(['-flags', '+ildct+ilme', '-x264-params', 'tff=1']);
    assert.equal(interlaced.frameMbsOnly, false);
    assert.equal(interlaced.height, 480);
});

test('mpeg1 args target JSMpeg: MPEG-1 without B-frames, MP2 audio, standard frame rates', () => {
    const args = buildCanvasArgs('https://example.test/live.m3u8', { userAgent: 'ua', codec: 'mpeg1', maxHeight: 480, live: true });
    assert.equal(args[args.indexOf('-c:v') + 1], 'mpeg1video');
    assert.equal(args[args.indexOf('-bf') + 1], '0');
    assert.equal(args[args.indexOf('-c:a') + 1], 'mp2');
    assert.equal(args[args.indexOf('-b:v') + 1], '1400k');
    assert.match(args[args.indexOf('-vf') + 1], /^bwdif=mode=send_frame:deint=interlaced,fps=fps='if\(lt\(source_fps,24\.5\),24,if\(lt\(source_fps,27\.5\),25,30\)\)',scale=-2:'min\(ih,480\)'$/);
    assert.equal(args.filter((arg) => arg === '-c:v').length, 1);
    assert.equal(args.filter((arg) => arg === '-c:a').length, 1);
});

test('mpeg1 output decodes as MPEG-1 + MP2 at a frame rate JSMpeg knows', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
    const routeArgs = buildCanvasArgs('unused', { userAgent: 'ua', codec: 'mpeg1', maxHeight: 360 });
    for (const [rate, expected] of [['15', '24/1'], ['25', '25/1'], ['59.94', '30/1']]) {
        const args = [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', `testsrc2=size=640x480:rate=${rate}`,
            '-f', 'lavfi', '-i', 'sine=sample_rate=48000',
            '-t', '2', '-map', '0:v:0', '-map', '1:a:0',
            ...routeArgs.slice(routeArgs.indexOf('-sn'))
        ];
        const encoded = spawnSync('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 });
        assert.equal(encoded.status, 0, encoded.stderr?.toString());
        const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,avg_frame_rate,height,sample_rate',
            '-of', 'json', '-i', 'pipe:0'], { input: encoded.stdout });
        const streams = JSON.parse(probe.stdout.toString()).streams;
        const video = streams.find((s) => s.codec_name === 'mpeg1video');
        const audio = streams.find((s) => s.codec_name === 'mp2');
        assert.ok(video && audio, JSON.stringify(streams));
        assert.equal(video.avg_frame_rate, expected, `source ${rate} fps`);
        assert.equal(video.height, 360);
        assert.equal(audio.sample_rate, '44100');
    }
});

test('PTS reads all 33 bits', () => {
    // 0x1_FFFF_FFFF encoded in PES timestamp layout (marker bits set).
    const bytes = Uint8Array.from([0x2f, 0xff, 0xff, 0xff, 0xff]);
    assert.equal(readTimestamp(bytes, 0), 2 ** 33 - 1);
});

test('demuxer extracts H.264 access units and AAC frames from ffmpeg output', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
    // Real output options from the route, fed by two synthetic inputs instead of a network URL.
    const routeArgs = buildCanvasArgs('unused', { userAgent: 'ua', maxHeight: 360 });
    const args = [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
        '-t', '4',
        '-map', '0:v:0', '-map', '1:a:0',
        ...routeArgs.slice(routeArgs.indexOf('-sn'))
    ];

    const video = [], audio = [];
    let tracks = null;
    const demuxer = new TsDemuxer({
        onTracks: (t) => { tracks = t; },
        onVideo: (au) => video.push(au),
        onAudio: (frame) => audio.push(frame)
    });
    await new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', args);
        // Feed odd-sized slices so packets and PES units straddle reads.
        ffmpeg.stdout.on('data', (chunk) => {
            for (let i = 0; i < chunk.length; i += 1001) demuxer.push(new Uint8Array(chunk.subarray(i, i + 1001)));
        });
        ffmpeg.on('error', reject);
        ffmpeg.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg exited ' + code)));
    });
    demuxer.flush();

    assert.deepEqual(tracks, { video: true, audio: true });
    assert.equal(video.length, 100);
    assert.ok(video[0].key && video[0].sps, 'stream starts on an IDR with SPS');
    assert.equal(video.filter((au) => au.key).length, 2, 'IDR every 2 seconds');
    const deltas = video.slice(1).map((au, i) => au.ptsUs - video[i].ptsUs);
    assert.ok(deltas.every((d) => d === 40000), 'monotonic 25 fps timestamps');

    assert.ok(audio.length >= 185 && audio.length <= 190, `about 4s of 1024-sample frames (${audio.length})`);
    assert.deepEqual([audio[0].objectType, audio[0].sampleRate, audio[0].channels], [2, 48000, 2]);
    assert.deepEqual([...audio[0].audioSpecificConfig], [0x11, 0x90]);
    assert.ok(Math.abs(audio[0].ptsUs - video[0].ptsUs) < 100000, 'audio and video start together');
});
