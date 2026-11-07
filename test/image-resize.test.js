const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { parseWidth } = require('../server/services/imageResize');

test('requested widths are rounded and bounded, so the cache stays small', () => {
    assert.equal(parseWidth('128'), 128);
    assert.equal(parseWidth('100'), 112);
    assert.equal(parseWidth('5000'), 512);
    assert.equal(parseWidth('1'), 16);
    for (const value of [undefined, '', 'big', '0', '-5']) assert.equal(parseWidth(value), null);
});

async function startApp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-image-test-'));
    const child = spawn(process.execPath, ['server/index.js'], { cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: '0', NODECAST_DATA_DIR: dir, NODECAST_DISABLE_BACKGROUND_JOBS: 'true', JWT_SECRET: '', SESSION_SECRET: '',
            OIDC_ISSUER_URL: '', ALLOW_LOCAL_MEDIA_URLS: 'true', AUTH_COOKIE_SECURE: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
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

test('the image proxy sends a small copy of a large logo, and anything else as it was', async (t) => {
    const big = await sharp({ create: { width: 1200, height: 900, channels: 4, background: { r: 200, g: 30, b: 60, alpha: 1 } } })
        .composite([{ input: Buffer.from('<svg width="1200" height="900"><circle cx="600" cy="450" r="400" fill="white"/></svg>') }]).png().toBuffer();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    let requests = 0;
    const provider = http.createServer((req, res) => {
        requests++;
        if (req.url === '/logo.png') { res.setHeader('Content-Type', 'image/png'); return res.end(big); }
        if (req.url === '/logo.svg') { res.setHeader('Content-Type', 'image/svg+xml'); return res.end(svg); }
        res.setHeader('Content-Type', 'text/html');
        res.end('<html>not an image</html>');
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => provider.close(resolve)));
    const origin = `http://127.0.0.1:${provider.address().port}`;

    const { base, headers } = await startApp(t);
    const get = async (url, w) => {
        const response = await fetch(`${base}/api/proxy/image?url=${encodeURIComponent(url)}${w ? `&w=${w}` : ''}`, { headers });
        return { status: response.status, type: response.headers.get('content-type'), body: Buffer.from(await response.arrayBuffer()) };
    };

    const small = await get(`${origin}/logo.png`, 128);
    assert.equal(small.status, 200);
    assert.equal(small.type, 'image/webp');
    const { width, height } = await sharp(small.body).metadata();
    assert.deepEqual([width, height], [128, 96], 'fits inside 128 px and keeps its shape');
    assert.ok(small.body.length < big.length / 10, `${small.body.length} bytes instead of ${big.length}`);

    const before = requests;
    await get(`${origin}/logo.png`, 128);
    assert.equal(requests, before, 'a second request is served from the cache');

    const full = await get(`${origin}/logo.png`);
    assert.equal(full.type, 'image/png');
    assert.ok(full.body.equals(big), 'without ?w= the original goes out untouched');

    assert.ok((await get(`${origin}/logo.svg`, 128)).body.equals(svg), 'SVG is not rasterized');
    const page = await get(`${origin}/page`, 128);
    assert.match(page.type, /^text\/html/);
});
