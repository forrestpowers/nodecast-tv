/**
 * What ffprobe (or a running stream) learned about a stream URL, kept for a day: a channel's
 * codecs rarely change, and a cached answer lets a channel change skip the probe entirely.
 * Failures are kept briefly, so a provider hiccup is retried soon. Bounded, oldest out first.
 */
const TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;
const MAX_ENTRIES = 5000;

const entries = new Map();
let now = () => Date.now();

function key(url, ua, program) {
    return JSON.stringify([url, ua || '', program ?? null]);
}

function get(cacheKey) {
    const entry = entries.get(cacheKey);
    if (!entry) return null;
    if (now() > entry.expires) {
        entries.delete(cacheKey);
        return null;
    }
    return entry.result;
}

function set(cacheKey, result, { failed = false } = {}) {
    entries.delete(cacheKey);
    entries.set(cacheKey, { result, expires: now() + (failed ? FAILURE_TTL_MS : TTL_MS) });
    if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
}

module.exports = {
    TTL_MS, FAILURE_TTL_MS, MAX_ENTRIES, key, get, set,
    _resetForTests(clock) { entries.clear(); now = clock || (() => Date.now()); }
};
