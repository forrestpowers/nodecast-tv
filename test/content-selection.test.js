const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

/**
 * The car downloads only the channel groups picked in Manage Content, plus favorites. The rest of
 * the provider's list, and the guide for it, stays on the server.
 */

async function startApp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-selection-test-'));
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

async function waitFor(check, label) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const value = await check();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

const xmltvTime = (date) => date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';

test('only the picked groups and favorites come down, with their guide', async (t) => {
    const categories = [{ category_id: '1', category_name: 'News' }, { category_id: '2', category_name: 'Sports' }, { category_id: '3', category_name: 'Kids' }];
    const streams = [
        { stream_id: 1, name: 'One', category_id: '1', epg_channel_id: 'one.us' },
        { stream_id: 2, name: 'Two', category_id: '1', epg_channel_id: 'two.us' },
        { stream_id: 3, name: 'Three', category_id: '2', epg_channel_id: 'three.us' },
        { stream_id: 4, name: 'Four', category_id: '3', epg_channel_id: 'four.us' }
    ];
    const now = Date.now();
    const programme = (id) => `<programme start="${xmltvTime(new Date(now - 3600e3))}" stop="${xmltvTime(new Date(now + 3600e3))}" channel="${id}"><title>Now on ${id}</title></programme>`;
    const provider = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://provider');
        if (url.pathname === '/xmltv.php') {
            res.setHeader('Content-Type', 'application/xml');
            return res.end(`<?xml version="1.0"?><tv>${['one.us', 'two.us', 'three.us', 'four.us'].map((id) =>
                `<channel id="${id}"><display-name>${id}</display-name></channel>`).join('')}${['one.us', 'two.us', 'three.us', 'four.us'].map(programme).join('')}</tv>`);
        }
        const answers = { get_live_categories: categories, get_live_streams: streams, get_vod_categories: [], get_vod_streams: [], get_series_categories: [], get_series: [] };
        const action = url.searchParams.get('action');
        if (!answers[action]) res.statusCode = 404;
        res.end(JSON.stringify(answers[action] || { user_info: { auth: 1 } }));
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => provider.close(resolve)));

    const request = await startApp(t);
    const cookie = (response) => ({ Cookie: response.cookie.split(';')[0] });
    const admin = cookie(await request('/api/auth/setup', { body: { username: 'Admin', password: 'password123' } }));
    await request('/api/auth/users', { headers: admin, body: { username: 'Alice', password: 'password123', role: 'viewer' } });
    const alice = cookie(await request('/api/auth/login', { body: { username: 'Alice', password: 'password123' } }));
    const source = (await request('/api/sources', { headers: alice, body: { type: 'xtream', name: 'Mine',
        url: `http://127.0.0.1:${provider.address().port}`, username: 'user', password: 'pass' } })).body;

    const status = async () => (await request('/api/sources/status', { headers: alice })).body.find((row) => row.source_id === source.id && row.type === 'all');
    const synced = (after = 0) => waitFor(async () => { const row = await status(); return row?.status === 'success' && row.last_sync > after; }, 'a sync');
    const list = async () => (await request(`/api/proxy/xtream/${source.id}/live_streams`, { headers: alice })).body.map((s) => s.hidden ? `${s.name}*` : s.name).sort();
    const groups = async () => (await request(`/api/channels/${source.id}/groups`, { headers: alice })).body;
    const guide = async () => {
        const { body } = await request(`/api/proxy/epg/${source.id}?window=now`, { headers: alice });
        return { channels: body.channels.map((c) => c.id).sort(), programmes: body.programmes.map((p) => p.channelId).sort() };
    };
    await synced();

    // Fresh from the provider, nothing is selected: the car gets an empty list and a small set of groups
    assert.deepEqual(await list(), []);
    assert.deepEqual((await request(`/api/proxy/xtream/${source.id}/live_categories`, { headers: alice })).body, []);
    assert.deepEqual(await groups(), [
        { categoryId: '3', name: 'Kids', total: 1, visible: 0 },
        { categoryId: '1', name: 'News', total: 2, visible: 0 },
        { categoryId: '2', name: 'Sports', total: 1, visible: 0 }
    ]);
    assert.deepEqual(await guide(), { channels: [], programmes: [] });

    // Manage Content opens one group at a time, and searches the rest on the server
    assert.deepEqual((await request(`/api/channels/${source.id}/groups/1/items`, { headers: alice })).body,
        [{ id: '1', name: 'One', hidden: true }, { id: '2', name: 'Two', hidden: true }]);
    assert.deepEqual((await request(`/api/channels/${source.id}/search?q=thr`, { headers: alice })).body,
        { truncated: false, items: [{ id: '3', name: 'Three', hidden: true, categoryId: '2', categoryName: 'Sports' }] });
    assert.deepEqual((await request(`/api/channels/${source.id}/search?q=%25`, { headers: alice })).body.items, [], 'wildcards are plain text');

    // Picking News brings its channels, its category and its guide down, and nothing else
    await request('/api/channels/show/bulk', { headers: alice, body: { items: [{ sourceId: source.id, itemType: 'group', itemId: '1' }] } });
    assert.deepEqual(await list(), ['One', 'Two']);
    assert.deepEqual((await request(`/api/proxy/xtream/${source.id}/live_categories`, { headers: alice })).body.map((c) => c.category_name), ['News']);
    assert.equal((await groups()).find((g) => g.name === 'News').visible, 2);
    assert.deepEqual(await guide(), { channels: ['one.us', 'two.us'], programmes: ['one.us', 'two.us'] });

    // A favorite outside the picked groups comes down too, marked for the Favorites row only, with its guide
    await request('/api/favorites', { headers: alice, body: { sourceId: source.id, itemId: `xtream_${source.id}_3`, itemType: 'channel' } });
    assert.deepEqual(await list(), ['One', 'Three*', 'Two']);
    assert.deepEqual((await request('/api/favorites/channels', { headers: alice })).body.map((c) => c.name), ['Three']);
    assert.deepEqual(await guide(), { channels: ['one.us', 'three.us', 'two.us'], programmes: ['one.us', 'three.us', 'two.us'] });
    assert.deepEqual((await request(`/api/proxy/xtream/${source.id}/live_streams?includeHidden=true`, { headers: alice })).body.length, 4, 'Manage Content still sees everything');

    // One channel can be left out of a picked group
    await request('/api/channels/hide/bulk', { headers: alice, body: { items: [{ sourceId: source.id, itemType: 'channel', itemId: '1' }] } });
    assert.deepEqual(await list(), ['Three*', 'Two']);
    assert.equal((await groups()).find((g) => g.name === 'News').visible, 1);

    // The provider grows: a new channel in a picked group comes down, a new group does not, and choices survive
    streams.push({ stream_id: 5, name: 'Five', category_id: '1', epg_channel_id: 'five.us' });
    streams.push({ stream_id: 6, name: 'Six', category_id: '4', epg_channel_id: 'six.us' });
    categories.push({ category_id: '4', category_name: 'Movies' });
    const before = (await status()).last_sync;
    await request(`/api/sources/${source.id}/sync`, { headers: alice, method: 'POST' });
    await synced(before);
    assert.deepEqual(await list(), ['Five', 'Three*', 'Two']);
    assert.deepEqual((await groups()).map((g) => [g.name, g.visible, g.total]), [['Kids', 0, 1], ['Movies', 0, 1], ['News', 2, 3], ['Sports', 0, 1]]);

    // Another login on the same source has its own favorites, and the list is per login
    await request('/api/auth/users', { headers: admin, body: { username: 'Bob', password: 'password123', role: 'viewer' } });
    const bob = cookie(await request('/api/auth/login', { body: { username: 'Bob', password: 'password123' } }));
    assert.equal((await request(`/api/proxy/xtream/${source.id}/live_streams`, { headers: bob })).status, 404, "Bob cannot see Alice's provider");
    assert.equal((await request(`/api/channels/${source.id}/groups`, { headers: bob })).status, 404);
});
