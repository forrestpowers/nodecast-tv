const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { createRequire } = require('node:module');
const parser = require('../server/services/epgParser');

const programme = (title, channel = '1') => `<programme channel="${channel}" start="202607140600 +0000" stop="202607140700 +0000"><title>${title}</title></programme>`;
const channel = (id = '1', name = 'Guide channel') => `<channel id="${id}"><display-name>${name}</display-name></channel>`;
const guide = (title = 'Old', id = '1') => `<tv>${channel(id)}${programme(title, id)}</tv>`;

async function collect(input, batchSize = 7) {
    const result = { channels: [], programmes: [], skipped: 0, final: 0 };
    for await (const batch of parser.parseStreaming(input, batchSize)) {
        assert.ok(batch.programmes.length <= batchSize);
        assert.ok(batch.channels.length <= batchSize);
        result.channels.push(...batch.channels);
        result.programmes.push(...batch.programmes);
        result.skipped += batch.skippedProgrammes;
        result.final += Number(batch.isLast);
    }
    return result;
}

test('XMLTV accepts reduced precision and rejects impossible timestamps', async () => {
    for (const [value, expected] of [
        ['20260714061234 +0000', '2026-07-14T06:12:34.000Z'],
        ['202607140612 +0000', '2026-07-14T06:12:00.000Z'],
        ['2026071406 -0500', '2026-07-14T11:00:00.000Z'],
        ['20260714 +0230', '2026-07-13T21:30:00.000Z'],
        ['202607', '2026-07-01T00:00:00.000Z'], ['2026', '2026-01-01T00:00:00.000Z'],
        ['20260714061234Z', '2026-07-14T06:12:34.000Z'],
        ['2026-07-14T06:12:34+02:00', '2026-07-14T04:12:34.000Z']
    ]) assert.equal(parser.parseXmltvDate(value).toISOString(), expected, value);
    for (const value of ['', 'garbage', '20260230060000 +0000', '20261301060000',
        '20260714240000', '20260714066000', '20260714060060', '20260714060000 +2460',
        '20260714060 +0000', '2026-02-30T06:00:00Z']) assert.equal(parser.parseXmltvDate(value), null, value);
    const xml = `<tv>${channel()}${programme('Valid')}${programme('Invalid').replace('202607140600', '202602300600')}</tv>`;
    assert.equal((await parser.parse(xml)).programmes.length, 1);
    const streamed = await collect(xml);
    assert.equal(streamed.programmes.length, 1);
    assert.equal(streamed.skipped, 1);
});

test('streaming XMLTV retains every batch in one chunk and channels arriving after programmes', async () => {
    const titles = Array.from({ length: 2501 }, (_, i) => `Programme ${i}`);
    const xml = `<tv>${channel()}${titles.map(title => programme(title)).join('')}${channel('10', 'Late')}</tv>`;
    const result = await collect(Readable.from([Buffer.from(xml)]));
    assert.deepEqual(result.programmes.map(p => p.title), titles);
    assert.deepEqual(result.channels.map(c => c.id), ['1', '10']);
    assert.equal(result.final, 1);
    const unicode = Buffer.from(guide('Café 東京'));
    const split = await collect(Readable.from(Array.from(unicode, byte => Buffer.from([byte]))));
    assert.equal(split.programmes[0].title, 'Café 東京');
});

test('both XMLTV parsers reject malformed or incomplete documents and propagate stream errors', async () => {
    for (const xml of ['', '<html>Failure</html>', '<tv>', `<tv>${programme('Partial')}`,
        '<tv><channel id="1"></tv>', '<tv/><tv/>']) {
        await assert.rejects(parser.parse(xml), /XMLTV/);
        await assert.rejects(collect(xml), /XMLTV/);
    }
    const broken = () => Readable.from((async function* () { yield '<tv>'; throw new Error('Network interrupted'); })());
    await assert.rejects(parser.parse(broken()), /Network interrupted/);
    await assert.rejects(collect(broken()), /Network interrupted/);
});

function fixture(t, epg = parser) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-epg-test-'));
    const filename = path.join(__dirname, '..', 'server/db/sqlite.js');
    const sqliteModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: sqliteModule,
        require: createRequire(filename), __dirname: path.dirname(filename),
        process: { env: { NODECAST_DATA_DIR: dir } }, console: { log() {} } }, { filename });
    const db = sqliteModule.exports.getDb();
    t.after(() => {
        db.close();
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const configured = new Map([[1, { id: 1 }], [2, { id: 2 }]]);
    const sources = { getById: async id => configured.get(Number(id)), delete: async id => configured.delete(Number(id)) };
    const syncFile = path.join(__dirname, '..', 'server/services/syncService.js');
    const syncModule = { exports: {} }, realRequire = createRequire(syncFile);
    vm.runInNewContext(fs.readFileSync(syncFile, 'utf8'), { module: syncModule, URL, process, setImmediate,
        console: { log() {}, warn() {} }, require(id) {
            if (id === '../db/sqlite') return { getDb: () => db };
            if (id === '../db') return { sources, settings: {} };
            if (id === './epgParser') return epg;
            if (id === './xtreamApi' || id === './m3uParser') return {};
            return realRequire(id);
        } }, { filename: syncFile });
    const sync = syncModule.exports;
    const snapshot = sourceId => ({
        programmes: db.prepare('SELECT channel_id,title,start_time,end_time FROM epg_programs WHERE source_id=? ORDER BY title').all(sourceId),
        channels: db.prepare("SELECT id,item_id,name FROM playlist_items WHERE source_id=? AND type='epg_channel' ORDER BY id").all(sourceId)
    });
    const stagedCount = () => db.prepare('SELECT COUNT(*) AS count FROM temp.epg_programs_staging').get().count
        + db.prepare('SELECT COUNT(*) AS count FROM temp.epg_channels_staging').get().count;
    return { db, sync, sources, configured, snapshot, stagedCount };
}

async function origin(t, handler) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return `http://127.0.0.1:${server.address().port}`;
}

test('EPG replacement preserves live media and other sources while clearing stale guide entries', async t => {
    const { db, sync, snapshot, stagedCount } = fixture(t);
    let xml = guide();
    const base = await origin(t, (req, res) => res.end(xml));
    const insert = db.prepare('INSERT INTO playlist_items (id,source_id,item_id,type,name,stream_url,data) VALUES (?,?,?,?,?,?,?)');
    for (const id of ['1', '10']) insert.run(`1:${id}`, 1, id, 'live', `Live ${id}`, `http://provider.test/${id}`, '{"retained":true}');
    insert.run('1:legacy', 1, 'legacy', 'epg_channel', 'Legacy guide', null, '{}');
    const liveBefore = db.prepare("SELECT * FROM playlist_items WHERE type='live' ORDER BY id").all();
    await sync.syncEpgFromUrl(2, base);
    const otherBefore = snapshot(2);
    xml = `<tv>${channel('1')}${channel('10')}${programme('Fresh', '10')}</tv>`;
    await sync.syncEpgFromUrl(1, base);
    assert.deepEqual(db.prepare("SELECT * FROM playlist_items WHERE type='live' ORDER BY id").all(), liveBefore);
    assert.deepEqual(snapshot(1).channels.map(c => c.id), ['1:epg_channel:1', '1:epg_channel:10']);
    assert.equal(snapshot(1).programmes[0].title, 'Fresh');
    assert.deepEqual(snapshot(2), otherBefore);
    xml = '<tv/>';
    await sync.syncEpgFromUrl(1, base);
    assert.deepEqual(snapshot(1), { programmes: [], channels: [] });
    assert.deepEqual(db.prepare("SELECT * FROM playlist_items WHERE type='live' ORDER BY id").all(), liveBefore);
    assert.equal(stagedCount(), 0);
});

test('failed XML, gzip, HTTP and interrupted downloads preserve the complete previous guide', async t => {
    const { sync, snapshot, stagedCount } = fixture(t);
    const prefix = `<tv>${channel()}${Array.from({ length: 1001 }, (_, i) => programme(`New ${i}`)).join('')}`;
    const base = await origin(t, (req, res) => {
        if (req.url === '/good') res.end(guide());
        else if (req.url === '/truncated') res.end(prefix);
        else if (req.url === '/bad.gz') res.end(Buffer.from([0x1f, 0x8b, 0, 0, 0]));
        else if (req.url === '/http') { res.writeHead(503); res.end('Unavailable'); }
        else { res.writeHead(200, { 'Content-Length': Buffer.byteLength(prefix) + 100 }); res.write(prefix); setImmediate(() => res.destroy()); }
    });
    await sync.syncEpgFromUrl(1, `${base}/good`);
    const old = snapshot(1);
    for (const suffix of ['truncated', 'bad.gz', 'http', 'interrupted']) {
        await assert.rejects(sync.syncEpgFromUrl(1, `${base}/${suffix}`));
        assert.deepEqual(snapshot(1), old, suffix);
        assert.equal(stagedCount(), 0, suffix);
    }
    await sync.syncEpgFromUrl(1, `${base}/good`);
    assert.deepEqual(snapshot(1), old);
});

test('gzip downloads and transparent HTTP gzip decode once, including split magic bytes', async t => {
    const { sync, snapshot } = fixture(t);
    const compressed = zlib.gzipSync(guide('Compressed'));
    const base = await origin(t, (req, res) => {
        if (req.url === '/encoded.gz') res.setHeader('Content-Encoding', 'gzip');
        res.write(compressed.subarray(0, 1));
        setImmediate(() => res.end(compressed.subarray(1)));
    });
    for (const suffix of ['download.gz?token=test', 'encoded.gz']) {
        await sync.syncEpgFromUrl(1, `${base}/${suffix}`);
        assert.equal(snapshot(1).programmes[0].title, 'Compressed');
    }
    assert.equal((await parser.fetchAndParse(`${base}/encoded.gz`)).programmes[0].title, 'Compressed');
});

test('different sources can refresh concurrently without mixing staged data', async t => {
    const { sync, snapshot, stagedCount } = fixture(t);
    const base = await origin(t, (req, res) => res.end(`<tv>${channel()}${Array.from({ length: 1101 }, (_, i) => programme(`${req.url}-${i}`)).join('')}</tv>`));
    await Promise.all([sync.syncEpgFromUrl(1, `${base}/one`), sync.syncEpgFromUrl(2, `${base}/two`)]);
    for (const [sourceId, prefix] of [[1, '/one-'], [2, '/two-']]) {
        const data = snapshot(sourceId);
        assert.equal(data.programmes.length, 1101);
        assert.ok(data.programmes.every(p => p.title.startsWith(prefix)));
        assert.equal(data.channels.length, 1);
    }
    assert.equal(stagedCount(), 0);
});

test('activation is atomic, rolls back SQL failures, and serializes same-source refreshes', async t => {
    let streamFactory = async function* () { yield* parser.parseStreaming(guide()); };
    const epg = { fetchAndParseStreaming: (...args) => streamFactory(...args) };
    const { db, sync, snapshot, stagedCount } = fixture(t, epg);
    const url = 'http://provider.test/guide';
    await sync.syncEpgFromUrl(1, url);
    const old = snapshot(1);
    streamFactory = async function* () {
        for await (const batch of parser.parseStreaming(guide('New', '10'), 1)) {
            yield batch;
            assert.deepEqual(snapshot(1), old);
            await assert.rejects(sync.syncEpgFromUrl(1, url), /already in progress/);
        }
    };
    db.exec("CREATE TRIGGER fail_guide BEFORE INSERT ON playlist_items WHEN NEW.type='epg_channel' BEGIN SELECT RAISE(ABORT,'activation failed'); END;");
    await assert.rejects(sync.syncEpgFromUrl(1, url), /activation failed/);
    assert.deepEqual(snapshot(1), old);
    assert.equal(stagedCount(), 0);
    db.exec('DROP TRIGGER fail_guide');
    await sync.syncEpgFromUrl(1, url);
    assert.equal(snapshot(1).programmes[0].title, 'New');
});

test('deleting a source through its route invalidates an in-flight guide refresh', async t => {
    let release, staged;
    const paused = new Promise(resolve => { staged = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const epg = { async *fetchAndParseStreaming() {
        for await (const batch of parser.parseStreaming(guide('Deleted'), 1)) {
            yield batch;
            if (!batch.isLast) { staged(); await gate; }
        }
    } };
    const { db, sync, sources, snapshot, stagedCount } = fixture(t, epg);
    const filename = path.join(__dirname, '..', 'server/routes/sources.js');
    let deleteRoute;
    const router = { param() {}, get() {}, post() {}, put() {}, delete(route, handler) { deleteRoute = handler; } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: { exports: {} }, console: { log() {}, error() {} }, require(id) {
        if (id === 'express') return { Router: () => router };
        if (id === '../db') return { sources };
        if (id === '../db/sqlite') return { getDb: () => db };
        if (id === '../services/syncService') return sync;
        return {};
    } }, { filename });
    const refreshing = sync.syncEpgFromUrl(1, 'http://provider.test/guide');
    const rejected = assert.rejects(refreshing, /removed during refresh/);
    await paused;
    const res = { status(code) { this.code = code; return this; }, json(value) { this.value = value; } };
    await deleteRoute({ params: { id: '1' } }, res);
    assert.equal(res.value.success, true);
    release();
    await rejected;
    assert.deepEqual(snapshot(1), { programmes: [], channels: [] });
    assert.equal(stagedCount(), 0);
});
