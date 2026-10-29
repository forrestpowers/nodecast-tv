const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** Runs the worker script against a fake worker scope with a manual refresh clock. */
function loadWorker() {
    const posted = [], drawn = [], refreshes = [];
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: (frame) => drawn.push(frame.id) }) };
    const self = {
        postMessage: (message) => posted.push({ ...message }), // copy out of the sandbox realm
        requestAnimationFrame: (callback) => refreshes.push(callback)
    };
    let now = 0;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/canvas/webrtc-render-worker.js'), 'utf8'),
        { self, setTimeout, performance: { now: () => now } });
    const send = (data) => self.onmessage({ data });
    send({ t: 'init', canvas, paused: false });
    const frame = (id, width = 1280, height = 720) => ({ id, timestamp: id * 33333, displayWidth: width, displayHeight: height, closed: false, close() { this.closed = true; } });
    const refresh = () => refreshes.splice(0).forEach((callback) => callback());
    return { send, frame, refresh, posted, drawn, canvas, tick: (ms) => { now += ms; } };
}

test('the newest frame wins: frames that arrive within one refresh are never drawn', () => {
    const w = loadWorker();
    const frames = [w.frame(1), w.frame(2), w.frame(3)];
    frames.forEach((frame) => w.send({ t: 'frame', frame }));
    assert.deepEqual(w.drawn, [], 'nothing is drawn before the refresh');
    w.refresh();
    assert.deepEqual(w.drawn, [3]);
    assert.ok(frames.every((frame) => frame.closed), 'every frame is released');
    assert.deepEqual([w.canvas.width, w.canvas.height], [1280, 720]);

    w.tick(300);
    w.send({ t: 'frame', frame: w.frame(4) });
    w.refresh();
    const progress = w.posted.filter((m) => m.t === 'progress').at(-1);
    assert.deepEqual({ drawn: progress.drawn, superseded: progress.superseded }, { drawn: 1, superseded: 2 });
    assert.deepEqual(w.drawn, [3, 4]);
});

test('first frame, size changes, pause and stop', () => {
    const w = loadWorker();
    w.send({ t: 'frame', frame: w.frame(1) });
    assert.deepEqual(w.posted[0], { t: 'first', timestamp: 33333, width: 1280, height: 720 });
    w.refresh();
    assert.equal(w.posted.filter((m) => m.t === 'resize').length, 0, 'the first frame\'s size comes with "first"');

    w.send({ t: 'frame', frame: w.frame(2, 1920, 1080) });
    w.refresh();
    assert.deepEqual(w.posted.filter((m) => m.t === 'resize'), [{ t: 'resize', width: 1920, height: 1080 }]);

    w.send({ t: 'pause' });
    const paused = w.frame(3);
    w.send({ t: 'frame', frame: paused });
    w.refresh();
    assert.equal(paused.closed, true);
    assert.deepEqual(w.drawn, [1, 2], 'nothing is drawn while paused, so the last picture stays');

    w.send({ t: 'resume' });
    w.send({ t: 'stop' });
    const late = w.frame(4);
    w.send({ t: 'frame', frame: late });
    w.refresh();
    assert.equal(late.closed, true);
    assert.deepEqual(w.drawn, [1, 2]);
});
