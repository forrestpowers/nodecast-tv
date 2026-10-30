const { getDb } = require('../db/sqlite');
const { sources, settings } = require('../db'); // For source config and settings
const xtreamApi = require('./xtreamApi');
const m3uParser = require('./m3uParser');
const epgParser = require('./epgParser');
const { randomUUID } = require('node:crypto');
const diagnostics = require('./diagnostics');

// Sync tracking
const activeSyncs = new Set(); // sourceId
const activeEpgSyncs = new Set();
const epgSourceGenerations = new Map();

// A fresh list this much smaller than the stored one looks like a provider hiccup, not a real
// change, so the stored list is kept. Lists under the minimum may legitimately swing that much.
const SUSPICIOUS_SHRINK = 0.5;
const SHRINK_GUARD_MINIMUM = 20;
const pendingShrinks = new Map(); // `${sourceId}:${type}` -> size of the list we refused

class SyncService {
    constructor() {
        this.lastSyncTime = null; // Track when global sync last completed
        this._syncTimer = null;   // Server-side sync timer
        this._currentInterval = null;
    }

    invalidateEpgSource(sourceId) {
        const key = String(sourceId);
        epgSourceGenerations.set(key, (epgSourceGenerations.get(key) || 0) + 1);
    }

    /**
     * Get when the last global sync completed
     */
    getLastSyncTime() {
        return this.lastSyncTime;
    }

    /**
     * Start the server-side sync timer based on settings
     * Should be called once on server startup after initial sync
     */
    async startSyncTimer() {
        // Get interval from settings
        const currentSettings = await settings.get();
        const intervalHours = parseInt(currentSettings.epgRefreshInterval) || 24;

        // If interval is 0, don't start timer (manual only mode)
        if (intervalHours <= 0) {
            console.log('[Sync] Auto-sync disabled (manual only mode)');
            this.stopSyncTimer();
            this._currentInterval = 0;
            return;
        }

        const intervalMs = intervalHours * 60 * 60 * 1000;

        // Don't restart if interval hasn't changed and timer exists
        if (this._currentInterval === intervalHours && this._syncTimer) {
            console.log(`[Sync] Timer already running for ${intervalHours} hours, not restarting`);
            return;
        }

        // Clear existing timer
        this.stopSyncTimer();

        const nextSyncTime = new Date(Date.now() + intervalMs);
        console.log(`[Sync] Starting server-side sync timer: every ${intervalHours} hours`);
        console.log(`[Sync] Next scheduled sync at: ${nextSyncTime.toLocaleString()}`);

        this._syncTimer = setInterval(async () => {
            console.log('[Sync] Scheduled sync triggered');
            await this.syncAll();
            // Log next sync time
            const next = new Date(Date.now() + intervalMs);
            console.log(`[Sync] Next scheduled sync at: ${next.toLocaleString()}`);
        }, intervalMs);

        this._currentInterval = intervalHours;
    }

    /**
     * Stop the server-side sync timer
     */
    stopSyncTimer() {
        if (this._syncTimer) {
            clearInterval(this._syncTimer);
            this._syncTimer = null;
        }
    }

    /**
     * Restart the sync timer with updated settings
     * Called when sync interval setting changes
     */
    async restartSyncTimer() {
        await this.startSyncTimer();
    }

    /**
     * Sync all enabled sources
     */
    async syncAll() {
        console.log('[Sync] Starting global sync...');
        try {
            const allSources = await sources.getAll();
            for (const source of allSources) {
                if (source.enabled) {
                    // Run sequentially to not overload
                    await this.syncSource(source.id);
                }
            }
            this.lastSyncTime = new Date();
            console.log('[Sync] Global sync completed at', this.lastSyncTime.toISOString());
        } catch (err) {
            console.error('[Sync] Global sync failed:', err);
        }
    }

    /**
     * Start sync for a source
     */
    async syncSource(sourceId) {
        if (activeSyncs.has(sourceId)) {
            console.log(`[Sync] Source ${sourceId} is already syncing`);
            return;
        }

        activeSyncs.add(sourceId);

        try {
            const db = getDb();
            const source = await sources.getById(sourceId);

            if (!source) {
                throw new Error(`Source ${sourceId} not found`);
            }

            console.log(`[Sync] Starting sync for source ${source.name} (ID: ${sourceId})`);

            if (!source.enabled) {
                console.log(`[Sync] Skipping disabled source ${source.name}`);
                activeSyncs.delete(sourceId);
                return;
            }

            // Update status
            this.updateSyncStatus(sourceId, 'all', 'syncing');

            if (source.type === 'xtream') {
                await this.syncXtream(source);
            } else if (source.type === 'm3u') {
                await this.syncM3u(source);
            } else if (source.type === 'epg') {
                await this.syncEpg(source);
            }

            this.updateSyncStatus(sourceId, 'all', 'success');
            diagnostics.record('sync-finished', { title: source.name, outcome: 'success' });
            console.log(`[Sync] Completed sync for source ${source.name}`);

        } catch (err) {
            console.error(`[Sync] Failed sync for source ${sourceId}:`, err);
            this.updateSyncStatus(sourceId, 'all', 'error', err.message);
            diagnostics.record('sync-failed', { title: (await sources.getById(sourceId).catch(() => null))?.name, outcome: 'error', reason: err.message });
        } finally {
            activeSyncs.delete(sourceId);
        }
    }

    /**
     * Update sync status in DB
     */
    updateSyncStatus(sourceId, type, status, error = null) {
        const db = getDb();
        const stmt = db.prepare(`
            INSERT INTO sync_status (source_id, type, last_sync, status, error)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(source_id, type) DO UPDATE SET
                last_sync = excluded.last_sync,
                status = excluded.status,
                error = excluded.error
        `);
        stmt.run(sourceId, type, Date.now(), status, error);
    }

    /**
     * Xtream Sync Logic
     */
    async syncXtream(source) {
        const api = xtreamApi.createFromSource(source);
        const problems = [];

        // Each list is fetched in full before anything is written, and one failing leaves the others
        // to refresh: whatever could not be refreshed stays as it was.
        const refresh = async (label, type, getCategories, getItems) => {
            try {
                console.log(`[Sync] Fetching ${label} for ${source.name}`);
                const categories = await getCategories();
                const items = await getItems();
                if (!Array.isArray(items)) throw new Error('the provider sent an unexpected response');
                const held = this.holdList(source.id, type, items.length, this.countItems(source.id, type));
                await this.saveCategories(source.id, type, categories);
                await this.saveStreams(source.id, type, items, { skipPurge: Boolean(held) });
                if (held) problems.push(`${label}: ${held}`);
            } catch (error) {
                console.warn(`[Sync] ${label} refresh failed for ${source.name}, keeping the stored list:`, error.message);
                problems.push(`${label}: ${error.message}`);
            }
        };

        await refresh('live channels', 'live', () => api.getLiveCategories(), () => api.getLiveStreams());
        await refresh('movies', 'movie', () => api.getVodCategories(), () => api.getVodStreams());
        await refresh('series', 'series', () => api.getSeriesCategories(), () => api.getSeries());

        // 7. EPG (Xmltv)
        // Try to fetch XMLTV if available
        console.log(`[Sync] Fetching EPG for ${source.name}`);
        try {
            const xmltvUrl = api.getXmltvUrl();
            await this.syncEpgFromUrl(source.id, xmltvUrl);
        } catch (e) {
            console.warn('[Sync] XMLTV fetch failed, skipping EPG sync for now:', e.message);
        }

        if (problems.length > 0) throw new Error(`Previous list kept for ${problems.join('; ')}`);
    }

    countItems(sourceId, type) {
        return getDb().prepare('SELECT COUNT(*) AS total FROM playlist_items WHERE source_id = ? AND type = ?').get(sourceId, type).total;
    }

    /**
     * Decides whether a fresh list may replace the stored one.
     * A much smaller list is held back, so a provider sending a partial list cannot wipe a good one.
     * If the next refresh sends about the same size again, the change is real and goes through.
     * @returns {string|null} why the list was held back, or null when it may replace the stored one
     */
    holdList(sourceId, type, incoming, stored) {
        const key = `${sourceId}:${type}`;
        if (stored < SHRINK_GUARD_MINIMUM ? incoming > 0 || stored === 0 : incoming >= stored * SUSPICIOUS_SHRINK) {
            pendingShrinks.delete(key);
            return null;
        }
        if (incoming === 0) return 'the provider sent an empty list';
        const refused = pendingShrinks.get(key);
        if (refused !== undefined && Math.abs(incoming - refused) <= Math.max(5, refused * 0.1)) {
            console.log(`[Sync] Accepting smaller ${type} list for source ${sourceId}: ${incoming} of ${stored} items, seen twice`);
            pendingShrinks.delete(key);
            return null;
        }
        pendingShrinks.set(key, incoming);
        return `the provider sent only ${incoming} of ${stored} items (refresh again to accept this list)`;
    }

    /**
     * Batch save categories
     */
    async saveCategories(sourceId, type, categories) {
        if (!categories || categories.length === 0) return;
        console.log(`[Sync] Saving ${categories.length} ${type} categories for source ${sourceId}...`);
        const db = getDb();
        const stmt = db.prepare(`
            INSERT INTO categories (id, source_id, category_id, type, name, parent_id, data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                data = excluded.data
        `);

        const insertBatch = db.transaction((batch) => {
            for (const cat of batch) {
                const catId = cat.category_id; // standard xtream field
                const name = cat.category_name;
                const id = `${sourceId}:${catId}`;
                stmt.run(id, sourceId, String(catId), type, name, cat.parent_id || null, JSON.stringify(cat));
            }
        });

        // Reduced batch size for better event loop interleaving
        const BATCH_SIZE = 100;
        for (let i = 0; i < categories.length; i += BATCH_SIZE) {
            insertBatch(categories.slice(i, i + BATCH_SIZE));
            // Yield to event loop between batches to allow other requests
            await new Promise(resolve => setImmediate(resolve));
        }

        console.log(`[Sync] Saved ${categories.length} ${type} categories`);
    }

    /**
     * Batch save streams (channels, vod, series)
     * Also purges stale entries that no longer exist in the source (unless skipPurge is true)
     * @param {number} sourceId - Source ID
     * @param {string} type - Type of items (live, movie, series)
     * @param {Array} items - Items to save
     * @param {Object} options - Options { skipPurge: boolean }
     * @returns {Set} Set of synced IDs (for external purge if skipPurge was true)
     */
    async saveStreams(sourceId, type, items, options = {}) {
        if (!items || items.length === 0) return new Set();
        const db = getDb();
        const { skipPurge = false } = options;

        // Collect all IDs we're syncing
        const syncedIds = new Set();

        const stmt = db.prepare(`
            INSERT INTO playlist_items (
                id, source_id, item_id, type, name, category_id, 
                stream_icon, stream_url, program, container_extension,
                rating, year, added_at, data
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                category_id = excluded.category_id,
                stream_icon = excluded.stream_icon,
                stream_url = excluded.stream_url,
                program = excluded.program,
                container_extension = excluded.container_extension,
                data = excluded.data
        `);

        const insertBatch = db.transaction((batch) => {
            for (const item of batch) {
                // Map fields based on type
                let itemId, name, catId, icon, container;
                let rating = null, year = null, added = null;

                if (type === 'live') {
                    itemId = item.stream_id;
                    name = item.name || `Channel ${item.stream_id}`;
                    catId = item.category_id;
                    icon = item.stream_icon;
                    added = item.added;
                } else if (type === 'movie') {
                    itemId = item.stream_id;
                    name = item.name || `Movie ${item.stream_id}`;
                    catId = item.category_id;
                    icon = item.stream_icon; // or cover
                    container = item.container_extension;
                    rating = item.rating;
                    added = item.added;
                } else if (type === 'series') {
                    itemId = item.series_id;
                    name = item.name || `Series ${item.series_id}`;
                    catId = item.category_id;
                    icon = item.cover;
                    rating = item.rating;
                    year = item.releaseDate;
                    added = item.last_modified;
                }

                const id = `${sourceId}:${itemId}`;
                syncedIds.add(id);

                stmt.run(
                    id,
                    sourceId,
                    String(itemId),
                    type,
                    name,
                    String(catId),
                    icon,
                    null, // Direct URL not stored for Xtream usually, built on fly
                    item.program || null,
                    container,
                    rating,
                    year,
                    added,
                    JSON.stringify(item)
                );
            }
        });

        // Reduced batch size for better event loop interleaving
        const BATCH_SIZE = 100;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            insertBatch(items.slice(i, i + BATCH_SIZE));
            // Yield to event loop between batches to allow other requests
            await new Promise(resolve => setImmediate(resolve));
        }

        // Purge stale entries (skip if doing batch sync like M3U)
        if (!skipPurge && syncedIds.size > 0) {
            await this.purgeStaleItems(sourceId, type, syncedIds);
        }

        console.log(`[Sync] Saved ${items.length} ${type} items`);
        return syncedIds;
    }

    /**
     * Purge stale items that are no longer in the source
     * @param {number} sourceId - Source ID
     * @param {string} type - Type of items (live, movie, series)
     * @param {Set} syncedIds - Set of IDs that should be kept
     */
    async purgeStaleItems(sourceId, type, syncedIds) {
        if (!syncedIds || syncedIds.size === 0) return;

        const db = getDb();
        db.exec('CREATE TEMP TABLE IF NOT EXISTS synced_ids (id TEXT PRIMARY KEY)');
        db.exec('DELETE FROM synced_ids');

        const insertTemp = db.prepare('INSERT OR IGNORE INTO synced_ids (id) VALUES (?)');
        const insertTempBatch = db.transaction((ids) => {
            for (const id of ids) {
                insertTemp.run(id);
            }
        });
        insertTempBatch([...syncedIds]);

        const deleteStmt = db.prepare(`
            DELETE FROM playlist_items 
            WHERE source_id = ? AND type = ? 
            AND id NOT IN (SELECT id FROM synced_ids)
        `);
        const deleted = deleteStmt.run(sourceId, type);

        if (deleted.changes > 0) {
            console.log(`[Sync] Purged ${deleted.changes} stale ${type} items`);
        }
    }


    /**
     * Sync EPG from URL (Streaming - Memory Efficient)
     * Processes EPG files in batches to avoid OOM on large EPG data
     */
    async syncEpgFromUrl(sourceId, url) {
        console.log(`[Sync] Fetching EPG from: ${new URL(url).origin}`);

        const sourceKey = String(sourceId);
        if (activeEpgSyncs.has(sourceKey)) {
            throw new Error(`EPG refresh already in progress for source ${sourceId}`);
        }
        activeEpgSyncs.add(sourceKey);
        const sourceGeneration = epgSourceGenerations.get(sourceKey) || 0;
        let cleanupRun = null;
        let refreshError = null;

        try {

            // Temporary memory logging for verification
            const logMemory = () => {
                const used = process.memoryUsage();
                console.log(`[Sync] Memory: ${Math.round(used.heapUsed / 1024 / 1024)}MB heap`);
            };

            logMemory();

            const db = getDb();
            const runId = randomUUID();
            let totalChannels = 0;
            let totalProgrammes = 0;
            let skippedProgrammes = 0;
            let batchCount = 0;
            let sawFinalBatch = false;

            db.exec(`
                CREATE TEMP TABLE IF NOT EXISTS epg_programs_staging (
                    run_id TEXT NOT NULL,
                    source_id INTEGER NOT NULL,
                    channel_id TEXT NOT NULL,
                    start_time INTEGER NOT NULL,
                    end_time INTEGER NOT NULL,
                    title TEXT,
                    description TEXT,
                    data JSON
                );
                CREATE INDEX IF NOT EXISTS temp.idx_epg_programs_staging_run
                    ON epg_programs_staging(run_id, source_id);

                CREATE TEMP TABLE IF NOT EXISTS epg_channels_staging (
                    run_id TEXT NOT NULL,
                    source_id INTEGER NOT NULL,
                    id TEXT NOT NULL,
                    item_id TEXT NOT NULL,
                    name TEXT,
                    stream_icon TEXT,
                    data JSON,
                    PRIMARY KEY (run_id, id)
                );
            `);

            const deleteStagedProgrammes = db.prepare(
                'DELETE FROM temp.epg_programs_staging WHERE run_id = ?'
            );
            const deleteStagedChannels = db.prepare(
                'DELETE FROM temp.epg_channels_staging WHERE run_id = ?'
            );
            cleanupRun = () => {
                deleteStagedProgrammes.run(runId);
                deleteStagedChannels.run(runId);
            };

            // A prior interrupted attempt in this process must never be reused.
            db.prepare('DELETE FROM temp.epg_programs_staging WHERE source_id = ?').run(sourceId);
            db.prepare('DELETE FROM temp.epg_channels_staging WHERE source_id = ?').run(sourceId);

            const programmeStmt = db.prepare(`
                INSERT INTO temp.epg_programs_staging (
                    run_id, source_id, channel_id, start_time, end_time, title, description, data
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const channelStmt = db.prepare(`
                INSERT INTO temp.epg_channels_staging (
                    run_id, source_id, id, item_id, name, stream_icon, data
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(run_id, id) DO UPDATE SET
                    item_id = excluded.item_id,
                    name = excluded.name,
                    stream_icon = excluded.stream_icon,
                    data = excluded.data
            `);

            const stageProgrammes = db.transaction((programmes) => {
                for (const programme of programmes) {
                    programmeStmt.run(
                        runId,
                        sourceId,
                        programme.channelId,
                        programme.start ? programme.start.getTime() : 0,
                        programme.stop ? programme.stop.getTime() : 0,
                        programme.title,
                        programme.description || programme.desc,
                        JSON.stringify(programme)
                    );
                }
            });
            const stageChannels = db.transaction((channels) => {
                for (const channel of channels) {
                    // EPG channel IDs often overlap Xtream stream IDs. Keep the
                    // staged row in the same dedicated namespace as the active row.
                    const id = `${sourceId}:epg_channel:${channel.id}`;
                    channelStmt.run(
                        runId,
                        sourceId,
                        id,
                        channel.id,
                        channel.name,
                        channel.icon || null,
                        JSON.stringify(channel)
                    );
                }
            });

            const activateStagedGuide = db.transaction(() => {
                db.prepare('DELETE FROM epg_programs WHERE source_id = ?').run(sourceId);
                db.prepare(`
                    INSERT INTO epg_programs (
                        channel_id, source_id, start_time, end_time, title, description, data
                    )
                    SELECT channel_id, source_id, start_time, end_time, title, description, data
                    FROM temp.epg_programs_staging
                    WHERE run_id = ? AND source_id = ?
                `).run(runId, sourceId);

                db.prepare(`
                    DELETE FROM playlist_items
                    WHERE source_id = ? AND type = 'epg_channel'
                `).run(sourceId);
                db.prepare(`
                    INSERT INTO playlist_items (
                        id, source_id, item_id, type, name, stream_icon,
                        stream_url, category_id, data
                    )
                    SELECT id, source_id, item_id, 'epg_channel', name, stream_icon,
                           NULL, NULL, data
                    FROM temp.epg_channels_staging
                    WHERE run_id = ? AND source_id = ?
                `).run(runId, sourceId);

                cleanupRun();
            });

            const sourceAtStart = await sources.getById(sourceId);

            // Stream into isolated staging tables. The active guide remains
            // readable throughout download and parsing.
            for await (const batch of epgParser.fetchAndParseStreaming(url)) {
                batchCount++;
                skippedProgrammes += batch.skippedProgrammes || 0;

                if (batch.channels !== null && batch.channels !== undefined) {
                    stageChannels(batch.channels);
                    totalChannels += batch.channels.length;
                }

                if (batch.programmes.length > 0) {
                    stageProgrammes(batch.programmes);
                    totalProgrammes += batch.programmes.length;
                }

                if (batch.isLast) sawFinalBatch = true;

                if (batchCount % 10 === 0) {
                    console.log(`[Sync] Staged ${totalProgrammes} programmes so far...`);
                    logMemory();
                }

                // Keep requests responsive between SQLite batches.
                await new Promise(resolve => setImmediate(resolve));
            }

            if (!sawFinalBatch) {
                throw new Error('EPG refresh ended before the XMLTV document completed');
            }

            // If a real configured source disappeared while its download was
            // running, do not recreate any of its guide data.
            const sourceStillExists = !sourceAtStart || await sources.getById(sourceId);
            const sourceWasInvalidated = (epgSourceGenerations.get(sourceKey) || 0) !== sourceGeneration;
            if (sourceWasInvalidated || !sourceStillExists) {
                throw new Error(`EPG source ${sourceId} was removed during refresh`);
            }

            console.log(`[Sync] EPG Parsed: ${totalChannels} channels, ${totalProgrammes} programmes`);
            if (skippedProgrammes > 0) {
                console.warn(`[Sync] Skipped ${skippedProgrammes} programme entries with invalid XMLTV timestamps`);
            }
            logMemory();

            // One short transaction makes programmes and channel mapping
            // visible together. A valid empty feed intentionally clears both.
            activateStagedGuide();
            console.log(`[Sync] Activated ${totalChannels} EPG channels and ${totalProgrammes} programmes`);
        } catch (error) {
            refreshError = error;
            throw error;
        } finally {
            try {
                if (cleanupRun) cleanupRun();
            } catch (cleanupError) {
                console.warn('[Sync] Failed to clean EPG staging data:', cleanupError.message);
                if (!refreshError) throw cleanupError;
            } finally {
                activeEpgSyncs.delete(sourceKey);
            }
        }
    }

    /**
     * M3U Sync Logic (Streaming - Memory Efficient)
     * Processes M3U files in batches to avoid OOM on large playlists
     */
    async syncM3u(source) {
        console.log(`[Sync] Fetching M3U playlist for ${source.name}`);

        // Temporary memory logging for verification
        const logMemory = () => {
            const used = process.memoryUsage();
            console.log(`[Sync] Memory: ${Math.round(used.heapUsed / 1024 / 1024)}MB heap`);
        };

        logMemory();

        const stored = this.countItems(source.id, 'live');
        const allGroups = new Set();
        const allSyncedIds = new Set(); // Collect IDs across all batches
        let totalChannels = 0;
        let batchCount = 0;

        // Stream and process in batches (default 500 channels per batch)
        for await (const batch of m3uParser.fetchAndParseStreaming(source.url)) {
            batchCount++;

            // Map M3U channel format to our schema
            const playlistItems = batch.channels.map(ch => ({
                stream_id: ch.id,
                name: ch.name,
                category_id: ch.groupTitle || 'Uncategorized',
                stream_icon: ch.tvgLogo,
                stream_url: ch.url,
                tvgId: ch.tvgId || null,
                program: ch.program || null,
            }));

            // Save this batch immediately (skip purge - we'll do it at the end)
            if (playlistItems.length > 0) {
                const batchIds = await this.saveStreams(source.id, 'live', playlistItems, { skipPurge: true });
                batchIds.forEach(id => allSyncedIds.add(id));
                totalChannels += playlistItems.length;
            }

            // Collect groups for category creation at the end
            batch.groups.forEach(g => allGroups.add(g));

            // Log progress every 10 batches
            if (batchCount % 10 === 0) {
                console.log(`[Sync] Processed ${totalChannels} channels so far...`);
                logMemory();
            }
        }

        console.log(`[Sync] M3U Parsed: ${totalChannels} channels, ${allGroups.size} groups`);
        logMemory();

        // Purge stale items after all batches are complete, unless the list looks incomplete
        const held = this.holdList(source.id, 'live', allSyncedIds.size, stored);
        if (allSyncedIds.size > 0 && !held) {
            await this.purgeStaleItems(source.id, 'live', allSyncedIds);
        }

        // Save Categories (Groups) at the end
        const categories = Array.from(allGroups).map(name => ({
            category_id: name,
            category_name: name,
            parent_id: null
        }));

        await this.saveCategories(source.id, 'live', categories);
        if (held) throw new Error(`Previous list kept for live channels: ${held}`);
        console.log(`[Sync] M3U sync complete for ${source.name}`);
    }

    /**
     * EPG Source Sync Logic
     */
    async syncEpg(source) {
        console.log(`[Sync] Fetching standalone EPG for ${source.name}`);
        await this.syncEpgFromUrl(source.id, source.url);
    }
}

module.exports = new SyncService();
