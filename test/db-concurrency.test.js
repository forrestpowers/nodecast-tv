const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nodecast-db-test-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
        await fs.rm(dir, { recursive: true, force: true });
    });
    const filename = path.join(__dirname, '..', 'server', 'db.js');
    const module = { exports: {} };
    vm.runInNewContext(await fs.readFile(filename, 'utf8'), {
        module, require: createRequire(filename), __dirname: path.dirname(filename),
        process: { env: { NODECAST_DATA_DIR: dir } }, console: { error() {}, log() {} }, setTimeout
    }, { filename });
    return { db: module.exports, dir };
}

test('concurrent source creation retains every record and unique ID', async t => {
    const { db } = await fixture(t);
    const created = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        db.sources.create({ name: `Source ${index}`, type: 'm3u', url: `https://example.invalid/${index}` })));
    assert.equal((await db.sources.getAll()).length, 12);
    assert.equal(new Set(created.map(source => source.id)).size, 12);
    await Promise.all([db.sources.update(created[0].id, { name: 'Renamed' }),
        db.sources.update(created[0].id, { url: 'https://example.invalid/new' })]);
    const source = await db.sources.getById(created[0].id);
    assert.equal(source.name, 'Renamed');
    assert.equal(source.url, 'https://example.invalid/new');
});

test('mixed writes and duplicate checks are atomic across all JSON stores', async t => {
    const { db } = await fixture(t);
    await Promise.all([db.sources.create({ name: 'Source' }), db.users.create({ username: 'Viewer' }),
        db.settings.update({ defaultVolume: 37 }), db.hiddenItems.hide(1, 'channel', '1'), db.favorites.add(1, '2')]);
    const data = await db.loadDb();
    assert.equal(data.sources.length, 1);
    assert.equal(data.users.length, 1);
    assert.equal(data.hiddenItems.length, 1);
    assert.equal(data.favorites.length, 1);
    assert.equal(data.settings.defaultVolume, 37);
    const duplicates = await Promise.allSettled([db.users.create({ username: 'Same' }), db.users.create({ username: 'Same' })]);
    assert.equal(duplicates.filter(result => result.status === 'fulfilled').length, 1);
    await Promise.all([db.favorites.add(1, '2'), db.favorites.add(1, '2'), db.hiddenItems.hide(1, 'channel', '1')]);
    assert.equal((await db.favorites.getAll()).length, 1);
    assert.equal((await db.hiddenItems.getAll()).length, 1);
});

test('concurrent demotions and deletions cannot remove the last administrator', async t => {
    const { db } = await fixture(t);
    const first = await db.users.create({ username: 'First', role: 'admin' });
    const second = await db.users.create({ username: 'Second', role: 'admin' });
    const results = await Promise.allSettled([db.users.update(first.id, { role: 'viewer' }), db.users.delete(second.id)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await db.users.getAll()).filter(user => user.role === 'admin').length, 1);
});

test('write failures preserve data and do not poison the queue; corrupt data is never overwritten', async t => {
    const { db, dir } = await fixture(t);
    await db.sources.create({ name: 'Kept' });
    await fs.mkdir(path.join(dir, 'db.json.tmp'));
    await assert.rejects(db.sources.create({ name: 'Failed' }));
    assert.equal((await db.sources.getAll()).length, 1);
    await fs.rmdir(path.join(dir, 'db.json.tmp'));
    await db.sources.create({ name: 'Recovered' });
    assert.equal((await db.sources.getAll()).length, 2);
    const corrupt = '{invalid-json';
    await fs.writeFile(path.join(dir, 'db.json'), corrupt);
    await assert.rejects(db.settings.update({ defaultVolume: 1 }));
    assert.equal(await fs.readFile(path.join(dir, 'db.json'), 'utf8'), corrupt);
});

test('legacy user IDs and unknown metadata survive new writes', async t => {
    const { db, dir } = await fixture(t);
    await fs.writeFile(path.join(dir, 'db.json'), JSON.stringify({ users: [{ id: 30, username: 'Legacy' }], nextUserId: 31 }));
    const created = await db.users.create({ username: 'New' });
    assert.equal(created.id, 31);
    assert.equal((await db.loadDb()).nextUserId, 31);
});

test('source route does not reapply fields from a stale read', async t => {
    const { db } = await fixture(t);
    const source = await db.sources.create({ name: 'Original', url: 'https://example.invalid/original' });
    const stale = await db.sources.getById(source.id);
    await db.sources.update(source.id, { url: 'https://example.invalid/current' });
    const filename = path.join(__dirname, '..', 'server', 'routes', 'sources.js');
    const realRequire = createRequire(filename), routes = [];
    const router = { param() {}, get() {}, post() {}, delete() {}, put(route, handler) { routes.push(handler); } };
    const module = { exports: {} };
    vm.runInNewContext(await fs.readFile(filename, 'utf8'), {
        module, console, require(id) {
            if (id === 'express') return { Router: () => router };
            if (id === '../db') return { sources: { ...db.sources, getById: async () => stale } };
            if (id === '../db/sqlite') return {};
            if (id === '../services/syncService') return { syncSource: async () => {} };
            return realRequire(id);
        }
    }, { filename });
    const res = { status() { return this; }, json(value) { this.value = value; } };
    await routes[0]({ params: { id: source.id }, body: { name: 'Renamed' } }, res);
    assert.equal(res.value.url, 'https://example.invalid/current');
    assert.equal(res.value.name, 'Renamed');
});

test('case-folded username creation and renames are atomic without merging legacy accounts', async t => {
    const { db, dir } = await fixture(t);
    const created = await Promise.allSettled(['Alice', 'ALICE', 'alice'].map(username => db.users.create({ username })));
    assert.equal(created.filter(result => result.status === 'fulfilled').length, 1);
    const alice = (await db.users.getAll())[0]; assert.equal((await db.users.getByUsername('aLiCe')).id, alice.id);
    for (const username of [null, [], {}, '', '  ', 'a'.repeat(65), 'bad\nname']) await assert.rejects(db.users.create({ username }));
    const bob = await db.users.create({ username: 'Bob' });
    await assert.rejects(db.users.update(bob.id, { username: 'ALICE' }), /already exists/);
    await db.users.update(alice.id, { username: 'ALICE' }); assert.equal((await db.users.getByUsername('alice')).id, alice.id);
    const renames = await Promise.allSettled([db.users.update(alice.id, { username: 'Shared' }), db.users.update(bob.id, { username: 'SHARED' })]);
    assert.equal(renames.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await db.users.getAll()).length, 2);
    const legacy = { users: [{ id: 1, username: 'Old', role: 'admin' }, { id: 2, username: 'old', role: 'viewer' }], nextId: 3 };
    await fs.writeFile(path.join(dir, 'db.json'), JSON.stringify(legacy));
    assert.equal((await db.users.getByUsername('Old')).id, 1); assert.equal((await db.users.getByUsername('old')).id, 2);
    assert.equal(await db.users.getByUsername('OLD'), undefined);
    await db.users.update(2, { username: 'old', passwordHash: 'changed' });
    const saved = await db.loadDb(); assert.equal(saved.users.length, 2); assert.equal(saved.users[1].authVersion, 1);
});
