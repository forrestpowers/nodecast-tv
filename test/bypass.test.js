const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const hasFfprobe = spawnSync('ffprobe', ['-version']).status === 0;
const VIDEO = path.join(__dirname, '../server/assets/bypass.mp4');

// /api/bypass relays this file with -c copy, so it has to be WebRTC-ready as it sits on disk.
test('the bypass video is WebRTC-ready and outlasts the login page\'s lead-in', { skip: !hasFfprobe && 'ffprobe not installed' }, () => {
    const probe = (args) => spawnSync('ffprobe', ['-v', 'error', ...args, VIDEO], { encoding: 'utf8' }).stdout.trim();
    const [video, audio] = JSON.parse(probe(['-show_entries', 'stream=codec_name,profile,has_b_frames,sample_rate', '-of', 'json'])).streams;
    assert.deepEqual([video.codec_name, video.profile, video.has_b_frames], ['h264', 'Constrained Baseline', 0]);
    assert.deepEqual([audio.codec_name, audio.sample_rate], ['opus', '48000']);

    // Viewers can only start at a keyframe: one every second.
    const keyframes = probe(['-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0'])
        .split('\n').map((line) => parseFloat(line)); // the first line can end in a stray comma
    assert.ok(keyframes.slice(1).every((t, i) => t - keyframes[i] <= 1.01), 'a keyframe at least every second');

    // The page hides its fake progress screen at the end of the black lead-in.
    const leadIn = Number(/BYPASS_LEAD_IN = (\d+)/.exec(require('node:fs').readFileSync(path.join(__dirname, '../public/login.html'), 'utf8'))[1]);
    const duration = Number(probe(['-show_entries', 'format=duration', '-of', 'csv=p=0']));
    assert.ok(duration > leadIn, `longer than the lead-in (${duration} s)`);

    const frame = (time) => spawnSync('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', VIDEO, '-frames:v', '1', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8' }).stdout;
    const brightness = (time) => Number(/YAVG=([\d.]+)/.exec(frame(time))?.[1]);
    assert.ok(brightness(leadIn - 0.5) < 20, 'still black just before the lead-in ends');
    assert.ok(brightness(leadIn + 0.5) > 20, 'the clip starts when the lead-in ends');
});

test('the bypass route takes no input that could choose what it streams', () => {
    const router = require('../server/routes/bypass');
    const routes = router.stack.filter((layer) => layer.route).map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
    assert.deepEqual(routes, ['GET /video', 'GET /session', 'POST /:id/whep']);
    const source = require('node:fs').readFileSync(path.join(__dirname, '../server/routes/bypass.js'), 'utf8');
    assert.ok(!/req\.query/.test(source), 'no query parameters are read');
});
