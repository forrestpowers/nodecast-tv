const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

/** PlayerButtons against fake buttons, a fake player and a per-browser storage. */
function setup({ userId = 2, storage = new Map() } = {}) {
    const element = () => ({ hidden: true, disabled: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
    const elements = { 'player-buttons': element(), 'player-play': element(), 'player-stop': element() };
    const video = new EventEmitter();
    video.addEventListener = video.on.bind(video);
    video.paused = true;
    const played = [];
    const app = {
        currentUser: { id: userId },
        player: { video, currentChannel: null, stopped: false, stop() { video.paused = true; video.emit('pause'); } },
        playChannel: async (id) => { played.push(id); app.player.currentChannel = { id }; video.paused = false; video.emit('playing'); }
    };
    const context = vm.createContext({
        window: {}, document: { getElementById: (id) => elements[id] },
        localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/components/PlayerButtons.js'), 'utf8'), context);
    const buttons = new context.window.PlayerButtons(app);
    const state = () => ({ shown: !elements['player-buttons'].hidden, play: !elements['player-play'].disabled, stop: !elements['player-stop'].disabled });
    return { app, video, played, storage, buttons, state, click: (id) => elements[id].listeners.click() };
}

test('hidden until a channel has played; then Stop while playing, Play once stopped', async () => {
    const t = setup();
    assert.deepEqual(t.state(), { shown: false, play: true, stop: false });

    t.app.player.currentChannel = { id: 'xtream_4_8150' };
    t.video.paused = false;
    t.video.emit('playing');
    assert.deepEqual(t.state(), { shown: true, play: false, stop: true });

    t.click('player-stop');
    assert.deepEqual(t.state(), { shown: true, play: true, stop: false });
    assert.equal(t.app.player.stopped, true);

    await t.click('player-play');
    assert.deepEqual(t.played, ['xtream_4_8150']);
    assert.deepEqual(t.state(), { shown: true, play: false, stop: true });
});

test('the last channel is kept per login, so a reload can play it again', async () => {
    const storage = new Map();
    const first = setup({ storage });
    first.app.player.currentChannel = { id: 'xtream_4_8150' };
    first.video.paused = false;
    first.video.emit('playing');

    const later = setup({ storage });
    assert.deepEqual(later.state(), { shown: true, play: true, stop: false }, 'offered straight after a reload');
    await later.click('player-play');
    assert.deepEqual(later.played, ['xtream_4_8150']);

    assert.deepEqual(setup({ storage, userId: 3 }).state().shown, false, 'another login has its own');
});
