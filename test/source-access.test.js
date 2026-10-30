const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { canUseSource, parseAllowedUsers } = require('../server/services/sourceAccess');

test('a source without allowedUsers is shared, a restricted one only reaches its logins and admins', () => {
    const viewer = { id: 7, role: 'viewer' };
    assert.equal(canUseSource(viewer, { id: 1 }), true);
    assert.equal(canUseSource(viewer, { id: 1, allowedUsers: [] }), true);
    assert.equal(canUseSource(viewer, { id: 1, allowedUsers: [7, 9] }), true);
    assert.equal(canUseSource(viewer, { id: 1, allowedUsers: [9] }), false);
    assert.equal(canUseSource({ id: 1, role: 'admin' }, { id: 1, allowedUsers: [9] }), true);
    assert.equal(canUseSource(viewer, undefined), false);

    assert.deepEqual(parseAllowedUsers(['3', 3, 4, -1, 0, 1.5, 'x', null]), [3, 4]);
    assert.deepEqual(parseAllowedUsers('3'), []);
});

async function startApp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-access-test-'));
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
    return async (endpoint, { body, headers, method } = {}) => {
        const response = await fetch(`${base}${endpoint}`, { method: method || (body ? 'POST' : 'GET'),
            headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null,
            cookie: response.headers.getSetCookie().find(value => value.startsWith('nodecast_auth_')) };
    };
}

test('each login only sees the sources it may use', async t => {
    const playlist = http.createServer((req, res) => res.end('#EXTM3U\n#EXTINF:-1 group-title="News",Channel\nhttp://127.0.0.1:1/live.ts\n'));
    await new Promise(resolve => playlist.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => playlist.close(resolve)));
    const playlistUrl = `http://127.0.0.1:${playlist.address().port}/list.m3u`;

    const request = await startApp(t);
    const cookie = response => ({ Cookie: response.cookie.split(';')[0] });
    const admin = cookie(await request('/api/auth/setup', { body: { username: 'Admin', password: 'password123' } }));
    const login = async name => {
        const user = await request('/api/auth/users', { headers: admin, body: { username: name, password: 'password123', role: 'viewer' } });
        const session = await request('/api/auth/login', { body: { username: name, password: 'password123' } });
        assert.ok(session.cookie, `${name} login: ${session.status} ${JSON.stringify(session.body)} / create: ${user.status} ${JSON.stringify(user.body)}`);
        return { id: user.body.id, headers: cookie(session) };
    };
    const alice = await login('Alice');
    const bob = await login('Bob');

    const create = async (name, allowedUsers) => (await request('/api/sources', { headers: admin,
        body: { type: 'm3u', name, url: playlistUrl, allowedUsers } })).body;
    const aliceSource = await create('Alice TV', [alice.id]);
    const bobSource = await create('Bob TV', [bob.id, 'junk']);
    const shared = await create('Shared');
    assert.deepEqual([aliceSource.allowedUsers, bobSource.allowedUsers, shared.allowedUsers], [[alice.id], [bob.id], []]);

    const names = async who => (await request('/api/sources', { headers: who.headers || who })).body.map(s => s.name).sort();
    assert.deepEqual(await names(admin), ['Alice TV', 'Bob TV', 'Shared']);
    assert.deepEqual(await names(alice), ['Alice TV', 'Shared']);
    assert.deepEqual(await names(bob), ['Bob TV', 'Shared']);

    // Another login's source looks like it does not exist, through the source and proxy routes alike
    assert.equal((await request(`/api/sources/${bobSource.id}`, { headers: alice.headers })).status, 404);
    assert.equal((await request(`/api/sources/${aliceSource.id}`, { headers: alice.headers })).status, 200);
    assert.equal((await request(`/api/proxy/xtream/${bobSource.id}/live_categories`, { headers: alice.headers })).status, 404);
    assert.equal((await request(`/api/proxy/epg/${bobSource.id}`, { headers: alice.headers })).status, 404);
    assert.equal((await request(`/api/proxy/xtream/${aliceSource.id}/live_categories`, { headers: alice.headers })).status, 200);
    assert.equal((await request(`/api/proxy/xtream/${bobSource.id}/live_categories`, { headers: admin })).status, 200);

    // Viewers still cannot change who has access
    assert.equal((await request(`/api/sources/${bobSource.id}`, { headers: alice.headers, method: 'PUT', body: { allowedUsers: [] } })).status, 403);

    // Favorites of a source a login loses are hidden, and come back when access returns
    await request('/api/favorites', { headers: alice.headers, body: { sourceId: shared.id, itemId: 'ch1', itemType: 'channel' } });
    const favorites = async () => (await request('/api/favorites', { headers: alice.headers })).body.length;
    assert.equal(await favorites(), 1);
    await request(`/api/sources/${shared.id}`, { headers: admin, method: 'PUT', body: { allowedUsers: [bob.id] } });
    assert.equal(await favorites(), 0);
    assert.deepEqual(await names(alice), ['Alice TV']);

    // Sharing with everyone again
    await request(`/api/sources/${shared.id}`, { headers: admin, method: 'PUT', body: { allowedUsers: [] } });
    assert.equal(await favorites(), 1);
    assert.deepEqual(await names(alice), ['Alice TV', 'Shared']);
});
