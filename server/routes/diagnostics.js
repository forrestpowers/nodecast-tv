const express = require('express');
const router = express.Router();
const db = require('../db');
const { getDb } = require('../db/sqlite');
const { requireAdmin } = require('../auth');
const { requestLimit } = require('../services/requestLimits');
const { relay } = require('../services/webrtcRelay');
const hwDetect = require('../services/hwDetect');
const transcodeSession = require('../services/transcodeSession');
const diagnostics = require('../services/diagnostics');

/**
 * Diagnostics
 *   GET  /api/diagnostics         admin summary for the Settings tab
 *   POST /api/diagnostics/client  a player reports the path it took, for any login
 *
 * Browsers choose the playback path, so the server only learns it when the player says so.
 */

const CLIENT_KINDS = ['plan', 'fallback', 'error'];

router.post('/client', requestLimit(60), (req, res) => {
    const { kind, path, engine, video, title, tesla, reason } = req.body || {};
    if (!CLIENT_KINDS.includes(kind)) return res.status(400).json({ error: 'Unknown report' });
    diagnostics.record(`client-${kind}`, { userId: req.user?.id, path, engine, video, title, tesla: tesla === true, reason });
    res.status(204).end();
});

router.get('/', requireAdmin, requestLimit(120), async (req, res) => {
    try {
        const [users, sources] = await Promise.all([db.users.getAll(), db.sources.getAll()]);
        const userNames = new Map(users.map((user) => [user.id, user.username]));
        const name = (id) => userNames.get(id) || (id ? `user ${id}` : 'unknown');
        const sqlite = getDb();
        const statuses = new Map(sqlite.prepare(`SELECT source_id, last_sync, status, error FROM sync_status WHERE type = 'all'`).all()
            .map((row) => [row.source_id, row]));
        const counts = new Map();
        for (const row of sqlite.prepare('SELECT source_id, type, COUNT(*) AS total FROM playlist_items GROUP BY source_id, type').all()) {
            counts.set(row.source_id, { ...counts.get(row.source_id), [row.type]: row.total });
        }

        const memory = process.memoryUsage();
        res.json({
            app: {
                version: require('../../package.json').version,
                node: process.version,
                uptimeSeconds: Math.round(process.uptime()),
                memoryMb: Math.round(memory.rss / 1048576),
                webrtc: relay.isAvailable(),
                recommendedEncoder: hwDetect.getCapabilities()?.recommended || 'software'
            },
            sessions: [
                ...diagnostics.getSessions().map((session) => ({ ...session, user: name(session.userId) })),
                ...transcodeSession.getAllSessions().map((session) => ({
                    id: `hls-${session.id}`, engine: 'hls', status: session.status, startedAt: session.startTime
                }))
            ],
            sources: sources.map((source) => {
                const status = statuses.get(source.id);
                return {
                    id: source.id, name: source.name, type: source.type, enabled: Boolean(source.enabled),
                    owners: (source.allowedUsers || []).map(name), items: counts.get(source.id) || {},
                    syncStatus: status?.status || 'never', lastSync: status?.last_sync || null,
                    syncError: diagnostics.clean(status?.error, 300) || null
                };
            }),
            events: diagnostics.getEvents().map((event) => ({ ...event, user: event.userId ? name(event.userId) : undefined }))
        });
    } catch (error) {
        console.error('[Diagnostics]', error);
        res.status(500).json({ error: 'Failed to read diagnostics' });
    }
});

module.exports = router;
