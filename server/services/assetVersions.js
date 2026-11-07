/**
 * Browser caching for the app's files. Each file under public/ gets a version from its content
 * (hashed once at startup, so a new build means new versions). The HTML pages are served with
 * every local script, stylesheet and icon tagged ?v=<version>, and a file requested with its
 * current version is cached for a year; anything else is revalidated on each load. The car then
 * downloads the app once, and only index.html on later loads.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

let versions = new Map();
const pages = new Map();

function scan(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) scan(file, out);
        else if (entry.isFile()) {
            const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
            out.set(path.relative(PUBLIC_DIR, file).split(path.sep).join('/'), hash);
        }
    }
    return out;
}

function load() {
    versions = scan(PUBLIC_DIR, new Map());
    pages.clear();
}

function versionOf(urlPath) {
    try { return versions.get(decodeURIComponent(urlPath).replace(/^\//, '')) || null; } catch (_) { return null; }
}

/** Local src/href values get the file's current version; external and inline ones are left alone. */
function rewriteHtml(html) {
    return html.replace(/((?:src|href)=")([^"]+)"/g, (whole, attr, value) => {
        if (/^(?:[a-z]+:|\/\/|#)/i.test(value)) return whole;
        const file = value.split(/[?#]/)[0];
        const version = versionOf(file);
        return version ? `${attr}${file}?v=${version}"` : whole;
    });
}

/** The HTML page as sent to the browser, rewritten once per load(). */
function html(file) {
    if (!pages.has(file)) pages.set(file, rewriteHtml(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8')));
    return pages.get(file);
}

/** Cache-Control for a static request: a year when it names the file's current version. */
function cacheControl(req) {
    const url = new URL(req.originalUrl || req.url, 'http://local');
    const version = versionOf(url.pathname);
    return version && url.searchParams.get('v') === version ? IMMUTABLE : REVALIDATE;
}

module.exports = { PUBLIC_DIR, IMMUTABLE, REVALIDATE, load, versionOf, rewriteHtml, html, cacheControl };
