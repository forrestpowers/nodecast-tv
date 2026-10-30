const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { ProviderSlots, playbackKey } = require('../server/services/providerSlots');
const { isProviderRejection } = require('../server/services/ffmpegNetwork');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const client = (id) => JSON.stringify([1, id]);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('only provider rejections worth retrying count: a dead channel fails straight away', () => {
    assert.equal(isProviderRejection('[http] HTTP error 403 Forbidden'), true);
    assert.equal(isProviderRejection('x: Server returned 4XX Client Error, but not one of 40{0,1,3,4}'), true);
    assert.equal(isProviderRejection('x: Server returned 404 Not Found'), false);
    assert.equal(isProviderRejection('x: Server returned 5XX Server Error reply'), false);
    assert.equal(isProviderRejection('Connection refused'), false);
});

test('a client id must look like one to get a slot', () => {
    const key = (value, id = 1) => playbackKey({ query: { client: value }, user: { id } });
    assert.equal(key('a'.repeat(32)), JSON.stringify([1, 'a'.repeat(32)]));
    assert.notEqual(key('a'.repeat(32), 1), key('a'.repeat(32), 2));
    for (const bad of [undefined, 'short', 'a'.repeat(129), 'has spaces in the middle', ['a'.repeat(32)]]) assert.equal(key(bad), null);
});

test('the next stream stops the old one and waits for its process to exit', async () => {
    const slots = new ProviderSlots();
    const child = new EventEmitter();
    let stopped = 0;
    const first = await slots.acquire(client('a'), { url: 'one', stop: () => { stopped++; } });
    first.track(child);

    let acquired = false;
    const next = slots.acquire(client('a'), { url: 'two' }).then((holder) => { acquired = true; return holder; });
    await delay(20);
    assert.equal(stopped, 1);
    assert.equal(acquired, false, 'still waiting for the old process');

    child.emit('close');
    const second = await next;
    assert.equal(acquired, true);
    second.finish();
    await delay(0);
    assert.equal(slots.slots.size, 0, 'free slots are forgotten');
});

test('rapid channel changes: only the newest request gets the slot', async () => {
    const slots = new ProviderSlots();
    const child = new EventEmitter();
    (await slots.acquire(client('a'), { url: 'one' })).track(child);
    const stale = slots.acquire(client('a'), { url: 'two' });
    const newest = slots.acquire(client('a'), { url: 'three' });
    child.emit('close');
    await assert.rejects(stale, { name: 'AbortError' });
    assert.equal((await newest).url, 'three');
});

test('other tabs, and a probe of the stream already playing, leave a stream alone', async () => {
    const slots = new ProviderSlots();
    let stopped = 0;
    await slots.acquire(client('a'), { url: 'one', stop: () => { stopped++; } });
    await slots.acquire(client('b'), { url: 'two' });
    await slots.acquire(client('a'), { url: 'one', keepSameUrl: true });
    await slots.acquire(null, { url: 'three' });
    assert.equal(stopped, 0);
});

test('a process that will not exit cannot block the next channel for long', async () => {
    const slots = new ProviderSlots({ closeTimeoutMs: 30 });
    (await slots.acquire(client('a'), { url: 'one' })).track(new EventEmitter());
    assert.equal((await slots.acquire(client('a'), { url: 'two' })).url, 'two');
});

test('a retry keeps the slot taken between its two processes', async () => {
    const slots = new ProviderSlots();
    const holder = await slots.acquire(client('a'), { url: 'one' });
    const first = new EventEmitter();
    holder.track(first);
    first.emit('close'); // the refused attempt: more may start, so the slot stays
    let released = false;
    holder.released.then(() => { released = true; });
    await delay(5);
    assert.equal(released, false);
    holder.finish();
    await delay(5);
    assert.equal(released, true);
});

async function startApp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-provider-test-'));
    const child = spawn(process.execPath, ['server/index.js'], { cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: '0', NODECAST_DATA_DIR: dir, NODECAST_DISABLE_BACKGROUND_JOBS: 'true', JWT_SECRET: '', SESSION_SECRET: '',
            OIDC_ISSUER_URL: '', ALLOW_LOCAL_MEDIA_URLS: 'true', AUTH_COOKIE_SECURE: 'false', WEBRTC_ENABLED: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(async () => {
        if (child.exitCode === null) {
            const closed = new Promise((resolve) => child.once('close', resolve));
            child.kill();
            await closed;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });
    let output = '';
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 15000);
        child.stdout.on('data', (chunk) => {
            output += chunk;
            const match = output.match(/server running on http:\/\/localhost:(\d+)/);
            if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
        });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
    });
    const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Admin', password: 'password123' }) });
    const cookie = setup.headers.getSetCookie().find((value) => value.startsWith('nodecast_auth_')).split(';')[0];
    return { base, headers: { Cookie: cookie } };
}

/** A provider that streams a TS sample forever and counts how many connections it holds. */
async function fakeProvider(t, sample, { refuseFirst = false } = {}) {
    const stats = { open: 0, peak: 0, total: 0, refused: 0 };
    const server = http.createServer((req, res) => {
        stats.total++;
        if (refuseFirst && stats.refused === 0) {
            stats.refused++;
            res.statusCode = 403;
            return res.end();
        }
        stats.peak = Math.max(stats.peak, ++stats.open);
        res.once('close', () => { stats.open--; });
        res.setHeader('Content-Type', 'video/mp2t');
        const send = () => { if (!res.destroyed) res.write(sample); };
        send();
        const timer = setInterval(send, 200);
        res.once('close', () => clearInterval(timer));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
    return { url: `http://127.0.0.1:${server.address().port}`, stats };
}

function makeSample(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-sample-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'sample.ts');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
        '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts', file]);
    assert.equal(made.status, 0, String(made.stderr));
    return fs.readFileSync(file);
}

const streamUrl = (base, url, id) => `${base}/api/canvas/stream?${new URLSearchParams({ url, video: 'copy', audio: 'copy', live: '1', client: id })}`;

async function firstBytes(response) {
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const { value } = await reader.read();
    assert.ok(value?.length > 0, 'the stream produced data');
    return reader;
}

test('a channel change never holds two provider connections', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async (t) => {
    const sample = makeSample(t);
    const provider = await fakeProvider(t, sample);
    const { base, headers } = await startApp(t);
    const id = 'a'.repeat(32);

    // The old request stays open on purpose: the server must not wait for the browser to close it.
    const first = await firstBytes(await fetch(streamUrl(base, `${provider.url}/one.ts`, id), { headers }));
    const second = await firstBytes(await fetch(streamUrl(base, `${provider.url}/two.ts`, id), { headers }));
    assert.equal(provider.stats.peak, 1, 'one connection at a time');

    // Another tab is another player: it gets its own connection and leaves this one playing.
    const otherTab = await firstBytes(await fetch(streamUrl(base, `${provider.url}/three.ts`, 'c'.repeat(32)), { headers }));
    assert.equal(provider.stats.peak, 2);
    await otherTab.cancel();
    await second.cancel();
    await first.cancel().catch(() => {});
});

test('a provider that refuses the connection gets one retry', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async (t) => {
    const sample = makeSample(t);
    const provider = await fakeProvider(t, sample, { refuseFirst: true });
    const { base, headers } = await startApp(t);
    const reader = await firstBytes(await fetch(streamUrl(base, `${provider.url}/one.ts`, 'b'.repeat(32)), { headers }));
    assert.equal(provider.stats.refused, 1);
    assert.ok(provider.stats.total >= 2);
    await reader.cancel();
});
