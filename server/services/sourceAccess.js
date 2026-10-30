const { sources } = require('../db');

/**
 * Which logins can use and manage which IPTV sources, so each login has its own services.
 *
 * A source's `allowedUsers` lists the user IDs that may use it. A source without the list (every
 * source made before this existed) is shared with everyone, and admins always see every source.
 * A source a viewer adds is limited to that viewer. Viewers manage a source only when they are
 * its one allowed user; shared sources are read-only to them, and admins manage everything.
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

function canManageSource(user, source) {
    if (!source) return false;
    if (user?.role === 'admin') return true;
    return isRestricted(source) && source.allowedUsers.length === 1 && source.allowedUsers[0] === Number(user?.id);
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

/** A source as this user may read it: the password stays with the people who manage it. */
function forUser(user, source) {
    const canManage = canManageSource(user, source);
    return { ...source, canManage, password: !canManage && source.password ? '••••••••' : source.password };
}

async function guard(req, res, next, id, mustManage) {
    try {
        const source = await sources.getById(id);
        if (source && !canUseSource(req.user, source)) return res.status(404).json({ error: 'Source not found' });
        if (source && mustManage && !canManageSource(req.user, source)) return res.status(403).json({ error: 'This source is managed by an admin' });
        next();
    } catch (error) {
        next(error);
    }
}

/** router.param handler: answers 404 for a source this user may not use. */
const sourceParam = (req, res, next, id) => guard(req, res, next, id, false);

/** As sourceParam, and anything but a read needs a source this user manages. */
const manageParam = (req, res, next, id) => guard(req, res, next, id, req.method !== 'GET');

/** Route middleware: :sourceId must be a source this user manages. */
const requireManage = (req, res, next) => guard(req, res, next, req.params.sourceId, true);

/** For routes naming sources in the body (sourceId, items[].sourceId): all must be managed. */
async function requireManagedBody(req, res, next) {
    if (['GET', 'HEAD'].includes(req.method) || req.user?.role === 'admin') return next();
    try {
        const ids = Array.isArray(req.body?.items) ? req.body.items.map((item) => item?.sourceId) : [req.body?.sourceId];
        for (const id of new Set(ids.map(Number))) {
            if (!canManageSource(req.user, await sources.getById(id))) {
                return res.status(403).json({ error: 'This source is managed by an admin' });
            }
        }
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

module.exports = { canUseSource, canManageSource, filterSources, filterBySource, forUser, sourceParam, manageParam, requireManage, requireManagedBody, parseAllowedUsers };
