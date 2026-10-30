const { sources } = require('../db');

/**
 * Which logins can use which IPTV sources, so each login gets its own profile.
 *
 * A source's `allowedUsers` lists the user IDs that may use it. A source without the list (every
 * source made before this existed) is shared with everyone, and admins always see every source.
 *
 * This scopes what each login sees: source lists, channels, guide, movies, series, favorites and
 * history. It is not a security boundary: playback routes take a stream URL, not a source.
 */

function isRestricted(source) {
    return Array.isArray(source?.allowedUsers) && source.allowedUsers.length > 0;
}

function canUseSource(user, source) {
    if (!source) return false;
    if (user?.role === 'admin' || !isRestricted(source)) return true;
    return source.allowedUsers.includes(Number(user?.id));
}

function filterSources(user, list) {
    return list.filter((source) => canUseSource(user, source));
}

/** The source IDs this user may use, or null when that is every source (admins). */
async function allowedSourceIds(user) {
    if (user?.role === 'admin') return null;
    return new Set(filterSources(user, await sources.getAll()).map((source) => source.id));
}

/** Keeps the rows (favorites, history) whose source this user may use. */
async function filterBySource(user, rows, key = 'source_id') {
    const allowed = await allowedSourceIds(user);
    if (!allowed) return rows;
    return rows.filter((row) => row[key] == null || allowed.has(Number(row[key])));
}

/** router.param handler: answers 404 for a :sourceId this user may not use. */
async function sourceParam(req, res, next, id) {
    try {
        const source = await sources.getById(id);
        if (source && !canUseSource(req.user, source)) return res.status(404).json({ error: 'Source not found' });
        next();
    } catch (error) {
        next(error);
    }
}

/** Cleans the allowedUsers sent by the source form: unique positive integer IDs, [] for everyone. */
function parseAllowedUsers(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
}

module.exports = { canUseSource, filterSources, allowedSourceIds, filterBySource, sourceParam, parseAllowedUsers };
