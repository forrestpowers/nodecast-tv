const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('browser startup uses its cookie without requiring a stored token and migrates bearer tokens once', async () => {
    for (const legacy of [false, true]) {
        const storage = new Map(legacy ? [['authToken', 'old-token']] : []);
        const requests = [], redirects = [];
        const context = vm.createContext({ console: { error() {} },
            window: { location: { replace: url => redirects.push(url) } },
            document: { addEventListener() {}, querySelector: () => null, body: { classList: { toggle() {} } } },
            localStorage: { getItem: key => storage.get(key), removeItem: key => storage.delete(key) },
            fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ id: 1, role: 'viewer' }) }; } });
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8'), context);
        const app = vm.runInContext('Object.create(App.prototype)', context);
        app.addLogoutButton = () => {};
        assert.equal(await app.checkAuth(), true);
        assert.deepEqual(requests.map(r => r.url), legacy ? ['/api/auth/session', '/api/auth/me'] : ['/api/auth/me']);
        assert.equal(requests.at(-1).options.credentials, 'same-origin');
        assert.equal(storage.has('authToken'), false);
        assert.equal(redirects.length, 0);
    }
});

test('HTTP media URLs reject protected destinations and redact provider credentials', () => {
    const filename = path.join(__dirname, '../server/services/urlSecurity.js');
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, URL, process: { env: {} } });
    const { validateHttpUrl, redactText, redactUrl } = module.exports;
    for (const value of ['file:///etc/passwd', 'http://localhost/a', 'http://127.0.0.1/a',
        'http://[::1]/a', 'http://[::ffff:127.0.0.1]/a', 'http://169.254.169.254/a',
        'http://[::ffff:169.254.169.254]/a', 'http://metadata.google.internal/a', 'http://provider.test/a\n', ['http://provider.test/a']]) {
        assert.throws(() => validateHttpUrl(value), undefined, String(value));
    }
    const url = 'https://name:secret@provider.test/live/name/password/1.ts?token=private';
    assert.equal(validateHttpUrl(url), url);
    assert.equal(validateHttpUrl('http://192.168.1.10/provider'), 'http://192.168.1.10/provider');
    assert.equal(redactUrl(url), 'https://provider.test/…');
    assert.equal(redactText(`Input ${url} failed`), 'Input [redacted URL] failed');
});
