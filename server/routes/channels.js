const express = require('express');
const router = express.Router();
const { getDb } = require('../db/sqlite');
const sourceAccess = require('../services/sourceAccess');

// Hiding changes a source for everyone using it, so it needs a source this login manages.
router.use(sourceAccess.requireManagedBody);
router.param('sourceId', sourceAccess.manageParam);

/**
 * Manage Content, kept light for the car: the groups of a source with how many of their channels
 * are selected, then one group's channels only when it is opened, and a search over the rest.
 * The provider's full list never leaves the server.
 */
router.get('/:sourceId/groups', (req, res) => {
    try {
        const sourceId = Number(req.params.sourceId);
        const db = getDb();
        const names = new Map(db.prepare(`SELECT category_id, name FROM categories WHERE source_id = ? AND type = 'live'`)
            .all(sourceId).map((row) => [row.category_id, row.name]));
        const groups = db.prepare(`
            SELECT category_id, COUNT(*) AS total, SUM(is_hidden = 0) AS visible
            FROM playlist_items WHERE source_id = ? AND type = 'live' GROUP BY category_id
        `).all(sourceId).map((row) => ({
            categoryId: row.category_id,
            name: names.get(row.category_id) || (row.category_id == null ? 'Uncategorized' : String(row.category_id)),
            total: row.total,
            visible: row.visible
        }));
        groups.sort((a, b) => a.name.localeCompare(b.name));
        res.json(groups);
    } catch (err) {
        console.error('Error listing groups:', err);
        res.status(500).json({ error: 'Failed to list groups' });
    }
});

const liveItem = (row) => ({ id: row.item_id, name: row.name, hidden: row.is_hidden !== 0 });

router.get('/:sourceId/groups/:categoryId/items', (req, res) => {
    try {
        const rows = getDb().prepare(`
            SELECT item_id, name, is_hidden FROM playlist_items
            WHERE source_id = ? AND type = 'live' AND category_id = ? ORDER BY name COLLATE NOCASE
        `).all(Number(req.params.sourceId), req.params.categoryId);
        res.json(rows.map(liveItem));
    } catch (err) {
        console.error('Error listing group items:', err);
        res.status(500).json({ error: 'Failed to list channels' });
    }
});

const SEARCH_LIMIT = 300;

router.get('/:sourceId/search', (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (!q) return res.json([]);
        const sourceId = Number(req.params.sourceId);
        const db = getDb();
        const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const rows = db.prepare(`
            SELECT item_id, name, is_hidden, category_id FROM playlist_items
            WHERE source_id = ? AND type = 'live' AND name LIKE ? ESCAPE '\\'
            ORDER BY name COLLATE NOCASE LIMIT ?
        `).all(sourceId, pattern, SEARCH_LIMIT + 1);
        const names = new Map(db.prepare(`SELECT category_id, name FROM categories WHERE source_id = ? AND type = 'live'`)
            .all(sourceId).map((row) => [row.category_id, row.name]));
        res.json({
            truncated: rows.length > SEARCH_LIMIT,
            items: rows.slice(0, SEARCH_LIMIT).map((row) => ({
                ...liveItem(row), categoryId: row.category_id, categoryName: names.get(row.category_id) || String(row.category_id)
            }))
        });
    } catch (err) {
        console.error('Error searching channels:', err);
        res.status(500).json({ error: 'Search failed' });
    }
});

// Helper to map API item types to DB types and tables
function mapItemType(apiType) {
    switch (apiType) {
        case 'channel': return { table: 'playlist_items', type: 'live' };
        case 'group': return { table: 'categories', type: 'live' };
        case 'vod_category': return { table: 'categories', type: 'movie' };
        case 'series_category': return { table: 'categories', type: 'series' };
        case 'movie': return { table: 'playlist_items', type: 'movie' };
        case 'series': return { table: 'playlist_items', type: 'series' };
        default: return null;
    }
}

// Get all hidden items (formatted like db.json for frontend compatibility)
router.get('/hidden', async (req, res) => {
    try {
        const { sourceId } = req.query;
        const db = getDb();

        let hidden = [];
        const resultFormat = (row, itemType) => ({
            source_id: row.source_id,
            item_type: itemType,
            item_id: itemType.includes('category') || itemType === 'group' ? row.category_id : row.item_id
        });

        // Query Categories
        let catQuery = `SELECT source_id, category_id, type FROM categories WHERE is_hidden = 1`;
        let itemQuery = `SELECT source_id, item_id, type FROM playlist_items WHERE is_hidden = 1`;

        const params = [];
        if (sourceId) {
            catQuery += ` AND source_id = ?`;
            itemQuery += ` AND source_id = ?`;
            const sid = parseInt(sourceId);
            params.push(sid);
        }

        const hiddenCats = db.prepare(catQuery).all(...params);
        const hiddenItems = db.prepare(itemQuery).all(...params);

        hiddenCats.forEach(row => {
            let apiType;
            if (row.type === 'live') apiType = 'group';
            else if (row.type === 'movie') apiType = 'vod_category';
            else if (row.type === 'series') apiType = 'series_category';

            if (apiType) hidden.push(resultFormat(row, apiType));
        });

        hiddenItems.forEach(row => {
            let apiType;
            if (row.type === 'live') apiType = 'channel';
            else if (row.type === 'movie') apiType = 'movie';
            else if (row.type === 'series') apiType = 'series';

            if (apiType) hidden.push(resultFormat(row, apiType));
        });

        res.json(await sourceAccess.filterBySource(req.user, hidden));
    } catch (err) {
        console.error('Error getting hidden items:', err);
        res.status(500).json({ error: 'Failed to get hidden items' });
    }
});

// Hide item
router.post('/hide', async (req, res) => {
    try {
        const { sourceId, itemType, itemId } = req.body;
        const mapping = mapItemType(itemType);

        if (!mapping) return res.status(400).json({ error: 'Invalid item type' });

        const db = getDb();
        const idCol = mapping.table === 'categories' ? 'category_id' : 'item_id';

        const stmt = db.prepare(`
            UPDATE ${mapping.table} 
            SET is_hidden = 1 
            WHERE source_id = ? AND type = ? AND ${idCol} = ?
        `);

        stmt.run(sourceId, mapping.type, itemId);

        res.json({ success: true });
    } catch (err) {
        console.error('Error hiding item:', err);
        res.status(500).json({ error: 'Failed to hide item' });
    }
});

// Show item
router.post('/show', async (req, res) => {
    try {
        const { sourceId, itemType, itemId } = req.body;
        const mapping = mapItemType(itemType);

        if (!mapping) return res.status(400).json({ error: 'Invalid item type' });

        const db = getDb();
        const idCol = mapping.table === 'categories' ? 'category_id' : 'item_id';

        const stmt = db.prepare(`
            UPDATE ${mapping.table} 
            SET is_hidden = 0 
            WHERE source_id = ? AND type = ? AND ${idCol} = ?
        `);

        stmt.run(sourceId, mapping.type, itemId);

        res.json({ success: true });
    } catch (err) {
        console.error('Error showing item:', err);
        res.status(500).json({ error: 'Failed to show item' });
    }
});

// Check hidden status
router.get('/hidden/check', async (req, res) => {
    try {
        const { sourceId, itemType, itemId } = req.query;
        const mapping = mapItemType(itemType);
        if (!mapping) return res.json({ hidden: false });

        const db = getDb();
        const idCol = mapping.table === 'categories' ? 'category_id' : 'item_id';

        const row = db.prepare(`
            SELECT is_hidden FROM ${mapping.table} 
            WHERE source_id = ? AND type = ? AND ${idCol} = ?
        `).get(sourceId, mapping.type, itemId);

        res.json({ hidden: !!(row && row.is_hidden) });
    } catch (err) {
        console.error('Error checking hidden:', err);
        res.status(500).json({ error: 'Failed to check status' });
    }
});

// Bulk Hide
router.post('/hide/bulk', async (req, res) => {
    try {
        const { items } = req.body;
        if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });

        const db = getDb();

        // Prepare statements once
        const hideCat = db.prepare('UPDATE categories SET is_hidden = 1 WHERE source_id = ? AND type = ? AND category_id = ?');
        const hideItem = db.prepare('UPDATE playlist_items SET is_hidden = 1 WHERE source_id = ? AND type = ? AND item_id = ?');

        // Cascading statements (hide all children of a category)
        const hideCatChildren = db.prepare('UPDATE playlist_items SET is_hidden = 1 WHERE source_id = ? AND type = ? AND category_id = ?');

        const runBulk = db.transaction((list) => {
            for (const item of list) {
                const mapping = mapItemType(item.itemType);
                if (mapping) {
                    if (mapping.table === 'categories') {
                        // Hide the category
                        hideCat.run(item.sourceId, mapping.type, item.itemId);
                        // Cascade to children
                        hideCatChildren.run(item.sourceId, mapping.type, item.itemId);
                    } else {
                        // Hide individual item
                        hideItem.run(item.sourceId, mapping.type, item.itemId);
                    }
                }
            }
        });

        runBulk(items);
        res.json({ success: true, count: items.length });
    } catch (err) {
        if (err.code === 'SQLITE_BUSY') {
            return res.status(503).json({ error: 'Database is busy, please try again' });
        }
        console.error('Error bulk hide:', err);
        res.status(500).json({ error: 'Failed' });
    }
});

// Bulk Show
router.post('/show/bulk', async (req, res) => {
    try {
        const { items } = req.body;
        if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });

        const db = getDb();

        // Prepare statements once
        const showCat = db.prepare('UPDATE categories SET is_hidden = 0 WHERE source_id = ? AND type = ? AND category_id = ?');
        const showItem = db.prepare('UPDATE playlist_items SET is_hidden = 0 WHERE source_id = ? AND type = ? AND item_id = ?');

        // Cascading statements (show all children of a category)
        const showCatChildren = db.prepare('UPDATE playlist_items SET is_hidden = 0 WHERE source_id = ? AND type = ? AND category_id = ?');

        const runBulk = db.transaction((list) => {
            for (const item of list) {
                const mapping = mapItemType(item.itemType);
                if (mapping) {
                    if (mapping.table === 'categories') {
                        // Show the category
                        showCat.run(item.sourceId, mapping.type, item.itemId);
                        // Cascade to children
                        showCatChildren.run(item.sourceId, mapping.type, item.itemId);
                    } else {
                        // Show individual item
                        showItem.run(item.sourceId, mapping.type, item.itemId);
                    }
                }
            }
        });

        runBulk(items);
        res.json({ success: true, count: items.length });
    } catch (err) {
        if (err.code === 'SQLITE_BUSY') {
            return res.status(503).json({ error: 'Database is busy, please try again' });
        }
        console.error('Error bulk show:', err);
        res.status(500).json({ error: 'Failed' });
    }
});

// Show ALL items for a source (single SQL statement - much faster than bulk)
router.post('/show/all', async (req, res) => {
    try {
        const { sourceId, contentType } = req.body;
        if (!sourceId) return res.status(400).json({ error: 'sourceId required' });

        const db = getDb();
        let catCount = 0;
        let itemCount = 0;

        // Determine which types to update based on contentType
        const types = contentType === 'movies' ? ['movie']
            : contentType === 'series' ? ['series']
                : ['live']; // default to channels

        for (const type of types) {
            const catResult = db.prepare(`UPDATE categories SET is_hidden = 0 WHERE source_id = ? AND type = ?`).run(sourceId, type);
            const itemResult = db.prepare(`UPDATE playlist_items SET is_hidden = 0 WHERE source_id = ? AND type = ?`).run(sourceId, type);
            catCount += catResult.changes;
            itemCount += itemResult.changes;
        }

        console.log(`[Channels] Show all for source ${sourceId} (${contentType}): ${catCount} categories, ${itemCount} items`);
        res.json({ success: true, categoriesUpdated: catCount, itemsUpdated: itemCount });
    } catch (err) {
        console.error('Error show all:', err);
        res.status(500).json({ error: 'Failed to show all' });
    }
});

// Hide ALL items for a source (single SQL statement - much faster than bulk)
router.post('/hide/all', async (req, res) => {
    try {
        const { sourceId, contentType } = req.body;
        if (!sourceId) return res.status(400).json({ error: 'sourceId required' });

        const db = getDb();
        let catCount = 0;
        let itemCount = 0;

        // Determine which types to update based on contentType
        const types = contentType === 'movies' ? ['movie']
            : contentType === 'series' ? ['series']
                : ['live']; // default to channels

        for (const type of types) {
            const catResult = db.prepare(`UPDATE categories SET is_hidden = 1 WHERE source_id = ? AND type = ?`).run(sourceId, type);
            const itemResult = db.prepare(`UPDATE playlist_items SET is_hidden = 1 WHERE source_id = ? AND type = ?`).run(sourceId, type);
            catCount += catResult.changes;
            itemCount += itemResult.changes;
        }

        console.log(`[Channels] Hide all for source ${sourceId} (${contentType}): ${catCount} categories, ${itemCount} items`);
        res.json({ success: true, categoriesUpdated: catCount, itemsUpdated: itemCount });
    } catch (err) {
        console.error('Error hide all:', err);
        res.status(500).json({ error: 'Failed to hide all' });
    }
});

module.exports = router;

