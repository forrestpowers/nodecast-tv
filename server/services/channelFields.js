/**
 * What the browser needs of a live channel. The provider's full record stays in the database:
 * a large list is read in one go in the browser, so every field sent costs memory there.
 */
function toLiveStream(row) {
    const data = JSON.parse(row.data || '{}');
    return {
        stream_id: row.item_id,
        name: row.name,
        stream_icon: row.stream_icon,
        category_id: row.category_id,
        // Normalize EPG channel ID: Xtream uses epg_channel_id, M3U uses tvgId
        epg_channel_id: data.epg_channel_id || data.tvgId || null,
        stream_url: data.stream_url,
        program: data.program
    };
}

/** A favorite stores the browser's channel id (xtream_3_8150) or, on older rows, the bare stream id. */
function favoriteStreamId({ source_id: sourceId, item_id: itemId }) {
    const prefix = [`xtream_${sourceId}_`, `m3u_${sourceId}_`].find((value) => itemId.startsWith(value));
    return prefix ? itemId.slice(prefix.length) : itemId;
}

module.exports = { toLiveStream, favoriteStreamId };
