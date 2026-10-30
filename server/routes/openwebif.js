const express = require('express');
const router = express.Router();
const { sources } = require('../db');
const { getDb } = require('../db/sqlite');
const { validateHttpUrl } = require('../services/urlSecurity');
const { canUseSource } = require('../services/sourceAccess');

const ZAP_TIMEOUT_MS = 5000;
// Enigma2 service reference: ten hex fields, e.g. 1:0:1:65:65:53:CE40000:0:0:0:
const SERVICE_REF = /^[0-9A-Fa-f]{1,8}(?::[0-9A-Fa-f]{1,8}){9}:?$/;

/**
 * Zap an Enigma2 receiver to a channel before streaming it.
 * POST /api/openwebif/zap
 * Body: { sourceId: number, streamId: string }
 *
 * The receiver address is never taken from the client: it is derived from the
 * configured (admin-managed) M3U source URL, and the channel must belong to
 * that source.
 */
router.post('/zap', async (req, res) => {
    const { sourceId, streamId } = req.body || {};
    const id = Number(sourceId);

    if (!Number.isInteger(id) || typeof streamId !== 'string' || !SERVICE_REF.test(streamId)) {
        return res.status(400).json({ error: 'Valid sourceId and streamId are required' });
    }

    let source, item;
    try {
        source = await sources.getById(id);
        if (source && source.type === 'm3u' && source.enabled && source.zapBeforeStreaming) {
            item = getDb().prepare(`
                SELECT item_id FROM playlist_items
                WHERE source_id = ? AND type = 'live' AND item_id = ?
            `).get(id, streamId);
        }
    } catch (err) {
        console.error('[ZAP] Lookup failed:', err.message);
        return res.status(500).json({ error: 'Server error' });
    }

    if (!source || !canUseSource(req.user, source) || source.type !== 'm3u' || !source.enabled || !source.zapBeforeStreaming) {
        return res.status(404).json({ error: 'Zap is not enabled for this source' });
    }
    if (!item) {
        return res.status(404).json({ error: 'Channel not found' });
    }

    let zapUrl;
    try {
        const boxOrigin = new URL(validateHttpUrl(source.url, 'Source URL')).origin;
        zapUrl = `${boxOrigin}/web/zap?sRef=${encodeURIComponent(item.item_id)}`;
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    try {
        const response = await fetch(zapUrl, {
            redirect: 'manual',
            signal: AbortSignal.timeout(ZAP_TIMEOUT_MS)
        });
        await response.body?.cancel();
        res.json({ success: response.ok });
    } catch (err) {
        console.error('[ZAP] Failed:', err.message);
        res.status(502).json({ error: 'Receiver did not respond' });
    }
});

module.exports = router;
