const express = require('express');
const router = express.Router();
const { favorites, getDb } = require('../db/sqlite');
const { sources } = require('../db');
const { toLiveStream, favoriteStreamId } = require('../services/channelFields');
const { requireAuth } = require('../auth');
const sourceAccess = require('../services/sourceAccess');

// All favorites routes require authentication
router.use(requireAuth);

// Get all favorites for current user
router.get('/', async (req, res) => {
    try {
        const { sourceId, itemType } = req.query;
        const items = favorites.getAll(req.user.id, sourceId || null, itemType || null);
        res.json(await sourceAccess.filterBySource(req.user, items));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get the current user's favorite channels, ready to show: Home needs no channel list for this
router.get('/channels', async (req, res) => {
    try {
        const items = await sourceAccess.filterBySource(req.user, favorites.getAll(req.user.id, null, 'channel'));
        const enabled = new Map((await sources.getAll()).filter(s => s.enabled).map(s => [s.id, s]));
        const lookup = getDb().prepare(`
            SELECT item_id, name, stream_icon, category_id, data FROM playlist_items
            WHERE id = ? AND type = 'live' AND is_hidden = 0
        `);

        const channels = [];
        for (const favorite of items) {
            const source = enabled.get(favorite.source_id);
            const row = source && lookup.get(`${source.id}:${favoriteStreamId(favorite)}`);
            if (!row) continue;
            const stream = toLiveStream(row);
            channels.push({
                id: `${source.type}_${source.id}_${stream.stream_id}`,
                name: stream.name,
                tvgLogo: stream.stream_icon,
                sourceId: source.id
            });
        }
        res.json(channels);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add favorite for current user
router.post('/', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.body;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        favorites.add(req.user.id, sourceId, itemId, itemType);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Remove favorite for current user
router.delete('/', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.body;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        favorites.remove(req.user.id, sourceId, itemId, itemType);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Check if item is favorited by current user
router.get('/check', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.query;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        const isFav = favorites.isFavorite(req.user.id, sourceId, itemId, itemType);
        res.json({ isFavorite: isFav });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

