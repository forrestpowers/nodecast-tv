const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { toLiveStream, favoriteStreamId } = require('../server/services/channelFields');

test('a live channel keeps only what the player uses', () => {
    const data = JSON.stringify({ num: 7, stream_type: 'live', tv_archive: 1, custom_sid: 'x', tvgId: 'news.us', stream_url: 'http://a/1.ts', program: '101' });
    assert.deepEqual(toLiveStream({ item_id: '1', name: 'News', stream_icon: 'logo.png', category_id: '2', data }), {
        stream_id: '1', name: 'News', stream_icon: 'logo.png', category_id: '2', epg_channel_id: 'news.us', stream_url: 'http://a/1.ts', program: '101'
    });
});

test('both stored forms of a favorite find the channel', () => {
    assert.equal(favoriteStreamId({ source_id: 3, item_id: 'xtream_3_8150' }), '8150');
    assert.equal(favoriteStreamId({ source_id: 3, item_id: 'm3u_3_1:0:1:65' }), '1:0:1:65');
    assert.equal(favoriteStreamId({ source_id: 3, item_id: '8150' }), '8150');
    assert.equal(favoriteStreamId({ source_id: 3, item_id: 'xtream_4_8150' }), 'xtream_4_8150');
});

async function startApp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-home-test-'));
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
    return async (endpoint, { body, headers, method } = {}) => {
        const response = await fetch(`${base}${endpoint}`, { method: method || (body ? 'POST' : 'GET'),
            headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null,
            cookie: response.headers.getSetCookie().find((value) => value.startsWith('nodecast_auth_')) };
    };
}

test('Home gets favorites without the channel list', async (t) => {
    const provider = http.createServer((req, res) => res.end(['#EXTM3U',
        '#EXTINF:-1 tvg-id="one.us" group-title="News",One', 'http://127.0.0.1:1/1.ts',
        '#EXTINF:-1 group-title="News",Two', 'http://127.0.0.1:1/2.ts',
        '#EXTINF:-1 group-title="News",Three', 'http://127.0.0.1:1/3.ts', ''].join('\n')));
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => provider.close(resolve)));

    const request = await startApp(t);
    const cookie = (response) => ({ Cookie: response.cookie.split(';')[0] });
    const admin = cookie(await request('/api/auth/setup', { body: { username: 'Admin', password: 'password123' } }));
    const login = async (name) => {
        await request('/api/auth/users', { headers: admin, body: { username: name, password: 'password123', role: 'viewer' } });
        return cookie(await request('/api/auth/login', { body: { username: name, password: 'password123' } }));
    };
    const alice = await login('Alice');
    const bob = await login('Bob');

    const source = (await request('/api/sources', { headers: alice, body: { type: 'm3u', name: 'Mine', url: `http://127.0.0.1:${provider.address().port}/list.m3u` } })).body;
    let streams;
    for (let attempt = 0; attempt < 100 && !streams?.length; attempt++) {
        streams = (await request(`/api/proxy/xtream/${source.id}/live_streams`, { headers: alice })).body;
        if (!streams?.length) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(streams.length, 3);
    assert.deepEqual(Object.keys(streams[0]).sort(), ['category_id', 'epg_channel_id', 'name', 'program', 'stream_icon', 'stream_id', 'stream_url']);
    assert.equal(streams.find((s) => s.name === 'One').epg_channel_id, 'one.us');

    const [one, two, three] = ['One', 'Two', 'Three'].map((name) => streams.find((s) => s.name === name));
    const favorite = (itemId) => request('/api/favorites', { headers: alice, body: { sourceId: source.id, itemId, itemType: 'channel' } });
    await favorite(`m3u_${source.id}_${one.stream_id}`); // what the channel list stores
    await favorite(String(two.stream_id));               // what older rows hold
    await favorite(`m3u_${source.id}_gone`);             // a channel the provider dropped

    const names = async (who = alice) => (await request('/api/favorites/channels', { headers: who })).body.map((c) => c.name).sort();
    assert.deepEqual(await names(), ['One', 'Two']);
    const [channel] = (await request('/api/favorites/channels', { headers: alice })).body.filter((c) => c.name === 'One');
    assert.deepEqual(channel, { id: `m3u_${source.id}_${one.stream_id}`, name: 'One', tvgLogo: one.stream_icon, sourceId: source.id });
    assert.deepEqual(await names(bob), [], 'favorites are per login');

    // Hidden channels and disabled sources stay off Home, as they do in Live TV
    await request('/api/channels/hide', { headers: alice, body: { sourceId: source.id, itemType: 'channel', itemId: two.stream_id } });
    assert.deepEqual(await names(), ['One']);
    await request(`/api/sources/${source.id}/toggle`, { headers: alice, method: 'POST' });
    assert.deepEqual(await names(), []);
    assert.ok(three, 'the rest of the list was never needed');
});

test('the Watch page can ask for a few movies instead of a whole category', async (t) => {
    const movies = Array.from({ length: 30 }, (_, i) => ({ name: `Movie ${i + 1}`, stream_id: 1000 + i, category_id: '7', container_extension: 'mp4' }));
    const answers = { get_vod_categories: [{ category_id: '7', category_name: 'Films' }], get_vod_streams: movies };
    const provider = http.createServer((req, res) => {
        const action = new URL(req.url, 'http://x').searchParams.get('action');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(action ? answers[action] ?? [] : { user_info: { auth: 1 } }));
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    t.after(() => { provider.closeAllConnections(); return new Promise((resolve) => provider.close(resolve)); });

    const request = await startApp(t);
    const setup = await request('/api/auth/setup', { body: { username: 'Admin', password: 'password123' } });
    const headers = { Cookie: setup.cookie.split(';')[0] };
    const source = (await request('/api/sources', { headers, body: { type: 'xtream', name: 'Films', url: `http://127.0.0.1:${provider.address().port}`, username: 'u', password: 'p' } })).body;

    const count = async (query) => (await request(`/api/proxy/xtream/${source.id}/vod_streams${query}`, { headers })).body.length;
    for (let attempt = 0; attempt < 100 && await count('') < 30; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await count(''), 30);
    assert.equal(await count('?category_id=7&limit=13'), 13);
    assert.equal(await count('?limit=nonsense'), 30);
    assert.equal(await count('?limit=-1'), 30);
});
