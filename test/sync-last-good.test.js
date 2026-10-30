const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

function playlist(count, prefix = 'Channel') {
    const lines = ['#EXTM3U'];
    for (let i = 1; i <= count; i++) lines.push(`#EXTINF:-1 group-title="News",${prefix} ${i}`, `http://127.0.0.1:1/${i}.ts`);
    return `${lines.join('\n')}\n`;
}

async function startApp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-sync-test-'));
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
    const request = async (endpoint, { body, headers, method } = {}) => {
        const response = await fetch(`${base}${endpoint}`, { method: method || (body ? 'POST' : 'GET'),
            headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
        const text = await response.text();
        return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null,
            cookie: response.headers.getSetCookie().find((value) => value.startsWith('nodecast_auth_')) };
    };
    return { request, base };
}

async function waitFor(check, label) {
    for (let attempt = 0; attempt < 100; attempt++) {
        const value = await check();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

test('a bad refresh keeps the last good channel list', async (t) => {
    let serve = { status: 200, body: playlist(100) };
    const provider = http.createServer((req, res) => {
        res.statusCode = serve.status;
        res.end(serve.body);
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => provider.close(resolve)));
    const url = `http://127.0.0.1:${provider.address().port}/list.m3u`;

    const { request } = await startApp(t);
    const admin = await request('/api/auth/setup', { body: { username: 'Admin', password: 'password123' } });
    const headers = { Cookie: admin.cookie.split(';')[0] };
    const source = (await request('/api/sources', { headers, body: { type: 'm3u', name: 'Provider', url } })).body;

    const channels = async () => (await request(`/api/proxy/xtream/${source.id}/live_streams`, { headers })).body.length;
    const status = async () => (await request('/api/sources/status', { headers })).body.find((row) => row.source_id === source.id && row.type === 'all');
    const refreshed = async (expected) => waitFor(async () => {
        const row = await status();
        return row?.status === expected && row;
    }, `a ${expected} refresh`);
    const refresh = async (expected) => {
        await request(`/api/proxy/cache/${source.id}`, { headers, method: 'DELETE' });
        const before = (await status())?.last_sync || 0;
        await request(`/api/sources/${source.id}/sync`, { headers, method: 'POST' });
        return waitFor(async () => {
            const row = await status();
            return row?.status === expected && row.last_sync > before && row;
        }, `a ${expected} refresh`);
    };
    await refreshed('success');
    assert.equal(await channels(), 100);

    // A failing provider, an error page sent with a 200, and an empty playlist change nothing
    serve = { status: 500, body: 'down' };
    await refresh('error');
    assert.equal(await channels(), 100);
    serve = { status: 200, body: '<html>Service unavailable</html>' };
    assert.match((await refresh('error')).error, /Previous list kept/);
    assert.equal(await channels(), 100);

    // A partial list is held back, and a second identical answer shows it is real
    serve = { status: 200, body: playlist(30) };
    assert.match((await refresh('error')).error, /only 30 of 100 items/);
    assert.equal(await channels(), 100);
    await refresh('success');
    assert.equal(await channels(), 30);

    // Normal changes go straight through
    serve = { status: 200, body: playlist(25) };
    await refresh('success');
    assert.equal(await channels(), 25);

    const { body } = await request('/api/diagnostics', { headers });
    assert.ok(body.events.some((event) => event.type === 'sync-failed' && event.title === 'Provider'));
    assert.equal(body.sources[0].items.live, 25);
});

test('players report their path to diagnostics, which only admins can read', async (t) => {
    const { request } = await startApp(t);
    const admin = await request('/api/auth/setup', { body: { username: 'Admin', password: 'password123' } });
    const headers = { Cookie: admin.cookie.split(';')[0] };

    await request('/api/auth/users', { headers, body: { username: 'Viewer', password: 'password123', role: 'viewer' } });
    const login = await request('/api/auth/login', { body: { username: 'Viewer', password: 'password123' } });
    const viewer = { Cookie: login.cookie.split(';')[0] };
    assert.equal((await request('/api/diagnostics', { headers: viewer })).status, 403);
    assert.equal((await request('/api/diagnostics/client', { headers: viewer, body: { kind: 'nonsense' } })).status, 400);
    assert.equal((await request('/api/diagnostics/client', { headers: viewer, body: { kind: 'plan', path: 'Canvas (WebRTC)', title: 'News', tesla: true, reason: 'http://secret.test/x failed' } })).status, 204);

    const { body } = await request('/api/diagnostics', { headers });
    const [plan] = body.events.filter((event) => event.type === 'client-plan');
    assert.equal(plan.user, 'Viewer');
    assert.equal(plan.path, 'Canvas (WebRTC)');
    assert.equal(plan.tesla, true);
    assert.ok(!plan.reason.includes('secret.test'));
});

test('JSON and scripts are compressed, video and live event streams never are', async (t) => {
    const { base } = await startApp(t);
    const gzip = (response) => response.headers.get('content-encoding');
    const script = await fetch(`${base}/js/app.js`, { headers: { 'Accept-Encoding': 'gzip' } });
    await script.arrayBuffer();
    assert.equal(gzip(script), 'gzip');

    const server = require('node:fs').readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
    const filter = /compression\(\{ filter: \(req, res\) => (\/.*?\/)\.test/.exec(server)[1];
    const pattern = new Function(`return ${filter}`)();
    for (const type of ['application/json; charset=utf-8', 'text/html', 'application/javascript']) assert.equal(pattern.test(type), true, type);
    for (const type of ['video/mp2t', 'video/mp4', 'text/event-stream', 'application/sdp', 'image/png', 'application/vnd.apple.mpegurl']) assert.equal(pattern.test(type), false, type);
});

test('the Live TV guide window holds what is on now and next, the guide page the full one', async (t) => {
    const stamp = (offsetHours) => `${new Date(Date.now() + offsetHours * 3600000).toISOString().replace(/[-:T]/g, '').slice(0, 14)} +0000`;
    const programme = (title, from, to) => `<programme start="${stamp(from)}" stop="${stamp(to)}" channel="ch1"><title>${title}</title></programme>`;
    const guide = `<?xml version="1.0"?><tv><channel id="ch1"><display-name>One</display-name></channel>
        ${programme('Earlier', -10, -9)}${programme('Now', -1, 1)}${programme('Next', 1, 2)}${programme('Tonight', 10, 11)}</tv>`;
    const provider = http.createServer((req, res) => res.end(guide));
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => provider.close(resolve)));

    const { request } = await startApp(t);
    const admin = await request('/api/auth/setup', { body: { username: 'Admin', password: 'password123' } });
    const headers = { Cookie: admin.cookie.split(';')[0] };
    const source = (await request('/api/sources', { headers, body: { type: 'epg', name: 'Guide', url: `http://127.0.0.1:${provider.address().port}/guide.xml` } })).body;

    const titles = async (query = '') => (await request(`/api/proxy/epg/${source.id}${query}`, { headers })).body.programmes.map((p) => p.title).sort();
    await waitFor(async () => (await titles()).length === 4, 'the guide to sync');
    assert.deepEqual(await titles(), ['Earlier', 'Next', 'Now', 'Tonight']);
    assert.deepEqual(await titles('?window=now'), ['Next', 'Now']);
});
