const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

async function startApp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-category-test-'));
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
    for (let attempt = 0; attempt < 100; attempt++) {
        const value = await check();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

test('one category ID used by live, movies and series stays three separate categories', async (t) => {
    const names = { live: 'News', movie: 'Action', series: 'Drama' };
    const provider = http.createServer((req, res) => {
        const answers = {
            get_live_categories: [{ category_id: '1', category_name: names.live }],
            get_vod_categories: [{ category_id: '1', category_name: names.movie }],
            get_series_categories: [{ category_id: '1', category_name: names.series }],
            get_live_streams: [{ stream_id: 1, name: 'Channel', category_id: '1' }],
            get_vod_streams: [{ stream_id: 2, name: 'Film', category_id: '1' }],
            get_series: [{ series_id: 3, name: 'Show', category_id: '1' }]
        };
        const action = new URL(req.url, 'http://provider').searchParams.get('action');
        if (!answers[action]) res.statusCode = 404;
        res.end(JSON.stringify(answers[action] || {}));
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => provider.close(resolve)));

    const request = await startApp(t);
    const admin = await request('/api/auth/setup', { body: { username: 'Admin', password: 'password123' } });
    const headers = { Cookie: admin.cookie.split(';')[0] };
    const source = (await request('/api/sources', { headers, body: { type: 'xtream', name: 'Provider',
        url: `http://127.0.0.1:${provider.address().port}`, username: 'user', password: 'pass' } })).body;

    const status = async () => (await request('/api/sources/status', { headers })).body.find((row) => row.source_id === source.id && row.type === 'all');
    const synced = (after = 0) => waitFor(async () => {
        const row = await status();
        return row?.status === 'success' && row.last_sync > after;
    }, 'a successful sync');
    const list = async (type, query = '') => (await request(`/api/proxy/xtream/${source.id}/${type}_categories${query}`, { headers })).body.map((c) => [c.category_id, c.category_name]);
    await synced();

    assert.deepEqual(await list('live'), [['1', 'News']]);
    assert.deepEqual(await list('vod'), [['1', 'Action']]);
    assert.deepEqual(await list('series'), [['1', 'Drama']]);

    // Hiding the category in one type leaves the other two alone
    await request('/api/channels/hide', { headers, body: { sourceId: source.id, itemType: 'vod_category', itemId: '1' } });
    const assertOnlyMoviesHidden = async (movieName) => {
        assert.deepEqual(await list('live'), [['1', 'News']]);
        assert.deepEqual(await list('vod'), []);
        assert.deepEqual(await list('vod', '?includeHidden=true'), [['1', movieName]]);
        assert.deepEqual(await list('series'), [['1', 'Drama']]);
        const hidden = (await request(`/api/channels/hidden?sourceId=${source.id}`, { headers })).body;
        assert.deepEqual(hidden, [{ source_id: source.id, item_type: 'vod_category', item_id: '1' }]);
    };
    await assertOnlyMoviesHidden('Action');

    // A later sync updates each type's own row, so a rename stays in its type and hidden state survives
    names.movie = 'Thrillers';
    const before = (await status()).last_sync;
    await request(`/api/sources/${source.id}/sync`, { headers, method: 'POST' });
    await synced(before);
    await assertOnlyMoviesHidden('Thrillers');
});

test('category rows from before the key included the type move across with their hidden state', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-category-test-'));
    const Database = require('better-sqlite3');
    const old = new Database(path.join(dir, 'content.db'));
    old.exec(`
        CREATE TABLE categories (
            id TEXT PRIMARY KEY, source_id INTEGER NOT NULL, category_id TEXT NOT NULL, type TEXT NOT NULL,
            name TEXT NOT NULL, parent_id TEXT, is_hidden INTEGER DEFAULT 0, data JSON
        );
    `);
    const insert = old.prepare('INSERT INTO categories (id, source_id, category_id, type, name, is_hidden) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('1:1', 1, '1', 'live', 'News', 1);
    insert.run('1:7', 1, '7', 'movie', 'Action', 1);
    insert.run('1:8', 1, '8', 'series', 'Drama', 0);
    insert.run('2:1', 2, '1', 'live', 'Sport', 0);
    // A group name that spells another row's new key
    insert.run('1:Kids', 1, 'Kids', 'live', 'Kids', 1);
    insert.run('1:live:Kids', 1, 'live:Kids', 'live', 'live:Kids', 0);
    old.close();

    process.env.NODECAST_DATA_DIR = dir;
    const { getDb, initSchema } = require('../server/db/sqlite');
    const syncService = require('../server/services/syncService');
    t.after(() => {
        getDb().close();
        delete process.env.NODECAST_DATA_DIR;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const rows = () => getDb().prepare('SELECT id, type, name, is_hidden FROM categories ORDER BY id').all().map((row) => [row.id, row.type, row.name, row.is_hidden]);
    const migrated = [
        ['1:live:1', 'live', 'News', 1],
        ['1:live:Kids', 'live', 'Kids', 1],
        ['1:live:live:Kids', 'live', 'live:Kids', 0],
        ['1:movie:7', 'movie', 'Action', 1],
        ['1:series:8', 'series', 'Drama', 0],
        ['2:live:1', 'live', 'Sport', 0]
    ];
    assert.deepEqual(rows(), migrated);

    // Starting up again changes nothing
    initSchema();
    assert.deepEqual(rows(), migrated);

    // The next sync lands on the same rows, and the types that had lost their category get it back
    await syncService.saveCategories(1, 'live', [{ category_id: 1, category_name: 'Headlines' }]);
    await syncService.saveCategories(1, 'movie', [{ category_id: 1, category_name: 'Comedy' }]);
    assert.deepEqual(rows(), [
        ['1:live:1', 'live', 'Headlines', 1],
        ['1:live:Kids', 'live', 'Kids', 1],
        ['1:live:live:Kids', 'live', 'live:Kids', 0],
        ['1:movie:1', 'movie', 'Comedy', 0],
        ['1:movie:7', 'movie', 'Action', 1],
        ['1:series:8', 'series', 'Drama', 0],
        ['2:live:1', 'live', 'Sport', 0]
    ]);
});
