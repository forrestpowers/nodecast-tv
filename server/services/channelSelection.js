const { getDb, favorites } = require('../db/sqlite');
const { toLiveStream, favoriteStreamId } = require('./channelFields');

/**
 * What one login's device downloads of a provider's live list: the groups selected in Manage
 * Content (is_hidden = 0 on the items) plus that login's favorites, wherever they sit. The rest
 * of the list stays on the server, and so does the guide data for it.
 */

const CHUNK = 500;

function favoriteIds(user, sourceId) {
    if (!user) return [];
    return favorites.getAll(user.id, sourceId, 'channel').map(favoriteStreamId);
}

function inChunks(ids, run) {
    const rows = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        rows.push(...run(chunk.map(() => '?').join(','), chunk));
    }
    return rows;
}

/** Favorites outside the selected groups, flagged so the player lists them under Favorites only. */
function favoriteOnlyLive(user, sourceId) {
    const ids = favoriteIds(user, sourceId);
    if (ids.length === 0) return [];
    const db = getDb();
    const rows = inChunks(ids, (marks, chunk) => db.prepare(`
        SELECT item_id, name, stream_icon, category_id, data FROM playlist_items
        WHERE source_id = ? AND type = 'live' AND is_hidden <> 0 AND item_id IN (${marks})
    `).all(sourceId, ...chunk));
    return rows.map((row) => ({ ...toLiveStream(row), hidden: true }));
}

/** The guide ids and names of the channels this login downloads, for trimming the EPG to them. */
function selectedEpg(user, sourceId) {
    const db = getDb();
    const columns = `name, COALESCE(json_extract(data, '$.epg_channel_id'), json_extract(data, '$.tvgId')) AS epg`;
    const rows = db.prepare(`SELECT ${columns} FROM playlist_items WHERE source_id = ? AND type = 'live' AND is_hidden = 0`).all(sourceId);
    const ids = favoriteIds(user, sourceId);
    if (ids.length > 0) {
        rows.push(...inChunks(ids, (marks, chunk) => db.prepare(`
            SELECT ${columns} FROM playlist_items WHERE source_id = ? AND type = 'live' AND is_hidden <> 0 AND item_id IN (${marks})
        `).all(sourceId, ...chunk)));
    }
    return {
        ids: new Set(rows.map((row) => row.epg).filter((id) => id != null && id !== '').map(String)),
        names: new Set(rows.map((row) => row.name).filter(Boolean))
    };
}

module.exports = { favoriteOnlyLive, selectedEpg, favoriteIds };
