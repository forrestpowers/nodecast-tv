const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const RTP1 = '1:0:1:65:65:53:CE40000:0:0:0:';

async function listen(t, handler) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}`;
}

// Minimal OpenWebif: bouquet export plus a zap endpoint that records calls
async function fakeReceiver(t) {
    const zaps = [];
    const base = await listen(t, (req, res) => {
        const url = new URL(req.url, 'http://receiver');
        if (url.pathname === '/web/services.m3u') {
            res.end([
                '#EXTM3U',
                `#EXTINF:-1 tvg-id="${RTP1}",RTP1`,
                '#EXTVLCOPT:program=101',
                `http://127.0.0.1:1/${RTP1}`,
                ''
            ].join('\n'));
        } else if (url.pathname === '/web/zap') {
            zaps.push(url.searchParams.get('sRef'));
            res.setHeader('Content-Type', 'text/xml');
            res.end('<e2simplexmlresult><e2state>True</e2state></e2simplexmlresult>');
        } else {
            res.statusCode = 404;
            res.end();
        }
    });
    return { base, zaps };
}

async function startApp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-zap-test-'));
    const child = spawn(process.execPath, ['server/index.js'], { cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: '0', NODECAST_DATA_DIR: dir,
            NODECAST_DISABLE_BACKGROUND_JOBS: 'true', JWT_SECRET: '', SESSION_SECRET: '',
            OIDC_ISSUER_URL: '', ALLOW_LOCAL_MEDIA_URLS: 'true', AUTH_COOKIE_SECURE: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(async () => {
        if (child.exitCode === null) {
            const closed = new Promise(resolve => child.once('close', resolve));
            child.kill();
            await closed;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });
    let output = '';
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 15000);
        child.stdout.on('data', chunk => {
            output += chunk;
            const match = output.match(/server running on http:\/\/localhost:(\d+)/);
            if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
        });
        child.stderr.on('data', chunk => { output += chunk; });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
    });
    const request = async (endpoint, { body, headers, method } = {}) => {
        const response = await fetch(`${base}${endpoint}`, { method: method || (body ? 'POST' : 'GET'),
            headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null,
            cookie: response.headers.getSetCookie().find(value => value.startsWith('nodecast_auth_')) };
    };
    return { request };
}

async function waitForChannels(request, headers, sourceId) {
    for (let attempt = 0; attempt < 50; attempt++) {
        const { body } = await request(`/api/proxy/xtream/${sourceId}/live_streams?includeHidden=true`, { headers });
        if (Array.isArray(body) && body.length) return body;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('M3U source did not sync');
}

test('zap endpoint requires authentication and only zaps channels of zap-enabled sources', async t => {
    const receiver = await fakeReceiver(t);
    const elsewhere = [];
    const attacker = await listen(t, (req, res) => { elsewhere.push(req.url); res.end(); });
    const { request } = await startApp(t);

    assert.equal((await request('/api/openwebif/zap', { body: { sourceId: 1, streamId: RTP1 } })).status, 401);

    const admin = await request('/api/auth/setup', { body: { username: 'Admin', password: 'password123' } });
    const adminHeaders = { Cookie: admin.cookie.split(';')[0] };
    await request('/api/auth/users', { headers: adminHeaders, body: { username: 'Viewer', password: 'password123', role: 'viewer' } });
    const login = await request('/api/auth/login', { body: { username: 'Viewer', password: 'password123' } });
    const headers = { Cookie: login.cookie.split(';')[0] };

    const zapSource = await request('/api/sources', { headers: adminHeaders, body: {
        type: 'm3u', name: 'Receiver', url: `${receiver.base}/web/services.m3u`, zapBeforeStreaming: true, zapDelay: 0 } });
    const plainSource = await request('/api/sources', { headers: adminHeaders, body: {
        type: 'm3u', name: 'Plain', url: `${receiver.base}/web/services.m3u` } });
    assert.equal(zapSource.body.zapDelay, 0);
    for (const program of [['101'], {}, true, '102:a', '65536', 0]) {
        assert.equal((await request('/api/transcode/session', { headers: adminHeaders, body: { url: 'http://provider.test/media.ts', program } })).status, 400);
    }
    const [channel] = await waitForChannels(request, adminHeaders, zapSource.body.id);
    assert.equal(channel.stream_id, RTP1);
    assert.equal(channel.program, '101');
    await waitForChannels(request, adminHeaders, plainSource.body.id);

    const zap = body => request('/api/openwebif/zap', { headers, body });

    // Client-supplied receiver addresses are ignored; the configured source decides
    const ok = await zap({ sourceId: zapSource.body.id, streamId: RTP1, boxUrl: attacker });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { success: true });
    assert.deepEqual(receiver.zaps, [RTP1]);
    assert.deepEqual(elsewhere, []);

    for (const [body, status] of [
        [{ boxUrl: attacker, serviceRef: RTP1 }, 400],
        [{ sourceId: zapSource.body.id, streamId: 'http://127.0.0.1/admin' }, 400],
        [{ sourceId: zapSource.body.id, streamId: '1:0:1:66:65:53:CE40000:0:0:0:' }, 404],
        [{ sourceId: plainSource.body.id, streamId: RTP1 }, 404],
        [{ sourceId: 999, streamId: RTP1 }, 404]
    ]) {
        assert.equal((await zap(body)).status, status, JSON.stringify(body));
    }
    assert.deepEqual(receiver.zaps, [RTP1]);
    assert.deepEqual(elsewhere, []);
});
