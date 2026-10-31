const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');

/** Runs App.navigateTo against a fake page, and reports where each request ends up. */
function appFor(role) {
    const context = vm.createContext({ console, document: { addEventListener() {}, querySelectorAll: () => [] }, history: { pushState() {}, replaceState() {} } });
    vm.runInContext(read('js/app.js'), context);
    const app = vm.runInContext('Object.create(App.prototype)', context);
    app.currentPage = 'live';
    app.pages = {};
    app.currentUser = { role };
    return app;
}

test('Movies and Series are out of reach, from the navbar and by address', () => {
    const html = read('index.html');
    for (const page of ['movies', 'series']) {
        assert.match(html, new RegExp(`data-page="${page}" hidden`), `${page} is hidden in the navbar`);
        const app = appFor('viewer');
        app.navigateTo(page);
        assert.equal(app.currentPage, 'home', `${page} sends you Home`);
    }
    assert.match(html, /id="content-type-movies" hidden/);
    assert.match(html, /id="content-type-series" hidden/);

    const app = appFor('viewer');
    app.navigateTo('guide');
    assert.equal(app.currentPage, 'guide', 'other pages still open');
});

test('the navbar scales with the window, and the guide grid takes the height that is left', () => {
    const css = read('css/main.css');
    const navLink = /\.nav-link \{[^}]*\}/.exec(css)[0];
    assert.match(navLink, /white-space: nowrap/);
    assert.match(navLink, /padding: [^;]*clamp\(/, 'spacing follows the window, down to the Model Y at 773 px');
    assert.match(/\.epg-grid \{[^}]*\}/.exec(css)[0], /flex: 1 1 0/);
});
