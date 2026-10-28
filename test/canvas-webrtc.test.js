const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const { buildWebrtcArgs } = require('../server/services/canvasStream');
const { WebrtcRelay, readConfig, buildMediaMtxConfig } = require('../server/services/webrtcRelay');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const mediamtx = readConfig().binary;

test('WebRTC args publish H.264 without B-frames + Opus to RTSP, paced in real time', () => {
    const args = buildWebrtcArgs('https://example.test/live.m3u8', 'rtsp://127.0.0.1:18554/ncabc', { userAgent: 'ua', live: true, maxHeight: 720 });
    assert.ok(args.indexOf('-re') >= 0 && args.indexOf('-re') < args.indexOf('-i'), '-re is an input option');
    assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
    assert.equal(args[args.indexOf('-tune') + 1], 'zerolatency');
    assert.equal(args[args.indexOf('-profile:v') + 1], 'baseline');
    assert.equal(args[args.indexOf('-force_key_frames') + 1], 'expr:gte(t,n_forced*1)');
    assert.equal(args[args.indexOf('-c:a') + 1], 'libopus');
    assert.equal(args[args.indexOf('-ar') + 1], '48000');
    assert.deepEqual(args.slice(-5, -1), ['-f', 'rtsp', '-rtsp_transport', 'tcp']);
    assert.equal(args.at(-1), 'rtsp://127.0.0.1:18554/ncabc');

    const copy = buildWebrtcArgs('https://example.test/movie.mp4', 'rtsp://127.0.0.1:18554/ncabc', { userAgent: 'ua', videoMode: 'copy', seek: 30 });
    assert.equal(copy[copy.indexOf('-c:v') + 1], 'copy');
    assert.ok(!copy.includes('-vf'));
    assert.ok(copy.indexOf('-ss') < copy.indexOf('-i'));
    // Opus is required by WebRTC even when the video is copied.
    assert.equal(copy[copy.indexOf('-c:a') + 1], 'libopus');
});

test('relay config reads the environment and keeps MediaMTX private', () => {
    const config = readConfig({ MEDIAMTX_PATH: '/opt/mediamtx', WEBRTC_PORT: '9000', WEBRTC_HOSTS: ' 203.0.113.7, tv.example.org ', MEDIAMTX_API_PORT: 'nope' });
    assert.equal(config.enabled, true);
    assert.equal(config.binary, '/opt/mediamtx');
    assert.equal(config.mediaPort, 9000);
    assert.deepEqual(config.hosts, ['203.0.113.7', 'tv.example.org']);
    assert.equal(config.apiPort, 19997, 'invalid ports fall back to the default');
    assert.equal(readConfig({ WEBRTC_ENABLED: 'false', MEDIAMTX_PATH: '/opt/mediamtx' }).enabled, false);
    assert.equal(new WebrtcRelay({ ...config, binary: null }).isAvailable(), false);

    const yaml = buildMediaMtxConfig(config);
    for (const line of ['apiAddress: 127.0.0.1:19997', 'rtspAddress: 127.0.0.1:18554', 'webrtcAddress: 127.0.0.1:18889',
        'webrtcLocalUDPAddress: :9000', 'webrtcLocalTCPAddress: :9000', 'webrtcIPsFromInterfaces: false',
        'webrtcAdditionalHosts: ["203.0.113.7", "tv.example.org"]', 'rtmp: false', 'hls: false', 'srt: false', 'moq: false',
        '    ips: ["127.0.0.1", "::1"]']) {
        assert.ok(yaml.split('\n').includes(line), `config has ${line}`);
    }
    // Without public hosts (bare-metal LAN installs) MediaMTX advertises its interface addresses.
    assert.match(buildMediaMtxConfig(readConfig({})), /^webrtcIPsFromInterfaces: true$/m);
    assert.match(buildMediaMtxConfig({ ...config, stun: 'stun:stun.example.org:3478' }), /webrtcICEServers2:\n {2}- url: "stun:stun\.example\.org:3478"/);
});

test('sessions are only visible to the user that created them', () => {
    const relay = new WebrtcRelay(readConfig({}));
    const session = relay.createSession(7);
    assert.match(session.id, /^[0-9a-f]{32}$/);
    assert.equal(relay.getSession(session.id, 7), session);
    assert.equal(relay.getSession(session.id, 8), null);
    assert.equal(relay.getSession('missing', 7), null);
    relay.endSession(session.id);
    assert.equal(relay.getSession(session.id, 7), null);
});

test('MediaMTX accepts the published stream and refuses a malformed WHEP offer',
    { skip: (!hasFfmpeg && 'ffmpeg not installed') || (!mediamtx && 'mediamtx not installed') }, async (t) => {
        const relay = new WebrtcRelay({
            ...readConfig({}), binary: mediamtx, hosts: ['127.0.0.1'],
            mediaPort: 28189, rtspPort: 28554, whepPort: 28889, apiPort: 29997
        });
        t.after(() => relay.shutdown());
        await relay.ensureStarted();

        const session = relay.createSession(null);
        const routeArgs = buildWebrtcArgs('unused', relay.rtspUrl(session.name), { userAgent: 'ua', maxHeight: 360 });
        const ffmpeg = session.ffmpeg = spawn('ffmpeg', [
            '-hide_banner', '-loglevel', 'error', '-re',
            '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
            '-f', 'lavfi', '-i', 'sine=sample_rate=44100',
            '-t', '20', '-map', '0:v:0', '-map', '1:a:0',
            ...routeArgs.slice(routeArgs.indexOf('-sn'))
        ]);
        t.after(() => ffmpeg.kill('SIGKILL'));

        await relay.waitForPath(session.name, () => ffmpeg.exitCode !== null, 15000);
        const info = await fetch(`http://127.0.0.1:29997/v3/paths/get/${session.name}`).then(res => res.json());
        assert.deepEqual(info.tracks2.map(track => track.codec), ['H264', 'Opus']);
        assert.deepEqual([info.tracks2[0].codecProps.profile, info.tracks2[0].codecProps.height], ['Baseline', 360]);

        const refused = await relay.whep(session.name, 'v=0\r\nnot an offer\r\n');
        assert.equal(refused.status, 400);
    });

test('the WebRTC engine is opt-in and falls back to a streaming engine', () => {
    const storage = new Map();
    const window = {
        location: { search: '' },
        AudioContext: function AudioContext() {},
        WebCodecsPipeline: { isSupported: () => true },
        JsmpegPipeline: { isSupported: () => true },
        WebRtcPipeline: { isSupported: () => true }
    };
    const context = vm.createContext({
        window, URLSearchParams, navigator: { userAgent: 'test' },
        localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
        document: { addEventListener() {} }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/canvas/CanvasVideo.js'), 'utf8'), context);
    const playback = window.CanvasPlayback;
    const progressiveH264 = { video: 'h264', height: 720, fieldOrder: 'progressive', audio: 'aac', audioChannels: 2 };

    assert.equal(playback.getEngine(), 'webcodecs', 'auto never picks WebRTC');
    playback.setEnginePreference('webrtc');
    assert.equal(playback.getEnginePreference(), 'webrtc');
    assert.equal(playback.getEngine(), 'webrtc');

    const withBFrames = playback.planFor({ ...progressiveH264, hasBFrames: true });
    assert.equal(withBFrames.engine, 'webrtc');
    assert.equal(withBFrames.videoMode, 'encode');
    assert.equal(withBFrames.audioMode, 'encode');
    assert.deepEqual({ ...withBFrames.fallback }, { engine: 'webcodecs', videoMode: 'copy', audioMode: 'copy', deinterlace: 'auto' });
    assert.equal(playback.planFor({ ...progressiveH264, hasBFrames: false }).videoMode, 'copy');
    assert.equal(playback.planFor({ ...progressiveH264, hasBFrames: null }).videoMode, 'encode', 'unknown B-frames are encoded');
    assert.equal(playback.describe('webrtc', 'encode'), 'Canvas (WebRTC, Transcoding)');

    window.WebRtcPipeline.isSupported = () => false;
    assert.equal(playback.getEngine(), 'webcodecs', 'browsers without MediaStreamTrackProcessor use WebCodecs');
});
