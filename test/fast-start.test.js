const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const assets = require('../server/services/assetVersions');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

async function startApp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-fast-test-'));
    const child = spawn(process.execPath, ['server/index.js'], { cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: '0', NODECAST_DATA_DIR: dir, NODECAST_DISABLE_BACKGROUND_JOBS: 'true', JWT_SECRET: '', SESSION_SECRET: '',
            OIDC_ISSUER_URL: '', ALLOW_LOCAL_MEDIA_URLS: 'true', AUTH_COOKIE_SECURE: 'false', WEBRTC_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    return { base, headers: { Cookie: setup.headers.getSetCookie().find((v) => v.startsWith('nodecast_auth_')).split(';')[0] } };
}

test('local files are served with content versions, and cached only when asked for by that version', async (t) => {
    const { base } = await startApp(t);
    const page = await fetch(`${base}/`);
    const html = await page.text();
    assert.equal(page.headers.get('cache-control'), 'no-cache', 'the page itself is always revalidated');
    const tagged = /src="(\/js\/app\.js)\?v=([0-9a-f]{10})"/.exec(html);
    assert.ok(tagged, 'app.js carries its content version');
    assert.match(html, /src="https:\/\/cdn\.jsdelivr\.net[^"]*hls\.min\.js"/, 'external scripts are left alone');
    assert.match(html, /href="css\/main\.css\?v=[0-9a-f]{10}"/, 'relative paths work too');

    const current = await fetch(`${base}${tagged[1]}?v=${tagged[2]}`);
    assert.equal(current.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const stale = await fetch(`${base}${tagged[1]}?v=0000000000`);
    assert.equal(stale.headers.get('cache-control'), 'no-cache');
    assert.equal(stale.status, 200, 'a stale tag still gets the file, just revalidated');
    assert.equal((await fetch(`${base}${tagged[1]}`)).headers.get('cache-control'), 'no-cache');

    const login = await fetch(`${base}/login.html`);
    assert.match(await login.text(), /src="\/js\/canvas\/webrtc-pipeline\.js\?v=[0-9a-f]{10}"/);
    assert.equal(login.headers.get('cache-control'), 'no-cache');
});

test('rewriting leaves data, anchor and protocol-relative values alone', () => {
    assets.load();
    const html = '<a href="#top"><img src="data:image/png;base64,AA"><script src="//cdn.test/x.js"></script><script src="/js/app.js?v=old"></script>';
    const out = assets.rewriteHtml(html);
    assert.match(out, /href="#top"/);
    assert.match(out, /src="data:image\/png;base64,AA"/);
    assert.match(out, /src="\/\/cdn\.test\/x\.js"/);
    assert.match(out, /src="\/js\/app\.js\?v=[0-9a-f]{10}"/);
    assert.ok(!out.includes('v=old'));
});

function makeSample(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-sample-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'sample.ts');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
        '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-f', 'mpegts', file]);
    assert.equal(made.status, 0, String(made.stderr));
    return fs.readFileSync(file);
}

test('a fast probe never touches the provider, and the running stream fills the cache', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async (t) => {
    const sample = makeSample(t);
    let hits = 0;
    const provider = http.createServer((req, res) => {
        hits++;
        res.setHeader('Content-Type', 'video/mp2t');
        let offset = 0;
        const timer = setInterval(() => {
            if (res.destroyed) return clearInterval(timer);
            res.write(sample.subarray(offset, offset + 64 * 1024));
            offset = (offset + 64 * 1024) % sample.length;
        }, 50);
        res.once('close', () => clearInterval(timer));
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    t.after(() => { provider.closeAllConnections(); return new Promise((resolve) => provider.close(resolve)); });
    const url = `http://127.0.0.1:${provider.address().port}/live/1.ts`;

    const { base, headers } = await startApp(t);
    const probe = async () => (await fetch(`${base}/api/probe?${new URLSearchParams({ url, fast: '1' })}`, { headers })).json();
    assert.deepEqual(await probe(), { pending: true });
    assert.equal(hits, 0, 'nothing asked the provider');

    const client = 'a'.repeat(32);
    const stream = await fetch(`${base}/api/canvas/stream?${new URLSearchParams({ url, video: 'encode', audio: 'encode', live: '1', client })}`, { headers });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const { value } = await reader.read();
    assert.ok(value?.length > 0, 'the stream started');
    assert.equal(hits, 1, 'one provider connection in total');

    let info;
    for (let attempt = 0; attempt < 60 && !(info = await probe()).video; attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual({ video: info.video, audio: info.audio, size: `${info.width}x${info.height}`, channels: info.audioChannels, source: info.source },
        { video: 'h264', audio: 'aac', size: '320x180', channels: 2, source: 'stream' });
    await reader.cancel();
});
