const express = require('express');
require('dotenv').config();
const path = require('path');
const passport = require('passport');
const auth = require('./auth');
const security = require('./config/security');
const { requestLimit } = require('./services/requestLimits');
const { validateHttpUrl, redactText } = require('./services/urlSecurity');
const syncService = require('./services/syncService');

// Initialize database
require('./db');

const app = express();
app.locals.ready = false;
const PORT = process.env.PORT || 3000;

// Trust proxy headers (X-Forwarded-Proto, X-Forwarded-For, etc.)
// Required for correct protocol detection behind reverse proxies (nginx, Caddy, etc.)
const trustProxy = process.env.TRUST_PROXY;
app.set('trust proxy', trustProxy === 'true' ? true : trustProxy === 'false' ? false : trustProxy || 'loopback, linklocal, uniquelocal');

// Middleware
app.use(express.json({ limit: '50mb' }));

// Initialize Passport
const session = require('express-session');
app.use(session({
    name: security.sessionCookieName,
    secret: security.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

app.use(express.static(path.join(__dirname, '..', 'public')));

// FFMPEG Configuration (optional - for transcoding support)
// Priority: 1. System FFmpeg (better Docker DNS support), 2. ffmpeg-static npm package
const { execSync } = require('child_process');

function findFFmpeg() {
    // Try system FFmpeg first (better Docker compatibility)
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        console.log('FFmpeg binary configured at: ffmpeg (system)');
        return 'ffmpeg';
    } catch (e) {
        // System FFmpeg not found, try ffmpeg-static
    }

    // Try ffmpeg-static npm package
    try {
        let ffmpegPath = require('ffmpeg-static');
        // In packaged Electron apps, ffmpeg-static returns path inside .asar archive
        // but the binary is actually unpacked to app.asar.unpacked
        if (ffmpegPath && ffmpegPath.includes('app.asar')) {
            ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
        }
        console.log('FFmpeg binary configured at:', ffmpegPath);
        return ffmpegPath;
    } catch (err) {
        console.warn('FFmpeg not available - transcoding/remuxing will be disabled.');
        console.warn('Install FFmpeg via your package manager or npm install ffmpeg-static');
        return null;
    }
}

function findFFprobe() {
    // Try system ffprobe first
    try {
        execSync('ffprobe -version', { stdio: 'ignore' });
        console.log('FFprobe binary configured at: ffprobe (system)');
        return 'ffprobe';
    } catch (e) {
        // Not found in system
    }

    // Try @ffprobe-installer/ffprobe package
    try {
        const ffprobePath = require('@ffprobe-installer/ffprobe').path;
        if (ffprobePath) {
            console.log('FFprobe binary configured at:', ffprobePath);
            return ffprobePath;
        }
    } catch (err) {
        // Package not available
    }

    console.warn('FFprobe not available - auto transcode will fallback to always transcode');
    return null;
}

app.locals.ffmpegPath = findFFmpeg();
app.locals.ffprobePath = findFFprobe();

// Dynamic services loader - collects exports from files in ./services
const fs = require('fs');
const services = {};
try {
    const servicesDir = path.join(__dirname, 'services');
    const serviceFiles = fs.readdirSync(servicesDir).filter(f => f.endsWith('.js'));
    for (const file of serviceFiles) {
        const name = file.replace(/\.js$/, '');
        try {
            services[name] = require(path.join(servicesDir, file));
        } catch (e) {
            console.warn(`Failed to load service ${file}:`, e.message);
        }
    }
} catch (e) {
    console.warn('No services directory found or failed to read services:', e.message);
}

// Freeze services object to prevent plugins from mutating shared state
Object.freeze(services);

// Plugin loader: loads any .js file inside server/plugins and calls the
// exported function with (app, services).
// Supports both function exports and object exports with lifecycle hooks.
const loadedPlugins = [];

async function loadPlugins() {
    try {
        const pluginsDir = path.join(__dirname, 'plugins');
        if (fs.existsSync(pluginsDir)) {
            // Sort plugin files alphabetically for deterministic load order
            const pluginFiles = fs.readdirSync(pluginsDir)
                .filter(f => f.endsWith('.js'))
                .sort();

            for (const file of pluginFiles) {
                const pluginPath = path.join(pluginsDir, file);
                try {
                    const plugin = require(pluginPath);

                    // Support both function exports and object exports with lifecycle hooks
                    if (typeof plugin === 'function') {
                        // Direct function export (sync or async)
                        await plugin(app, services);
                        loadedPlugins.push({ name: file, plugin: null });
                        console.log(`✓ Loaded plugin: ${file}`);
                    } else if (plugin && typeof plugin.init === 'function') {
                        // Object export with init/shutdown lifecycle
                        await plugin.init(app, services);
                        loadedPlugins.push({ name: file, plugin });
                        console.log(`✓ Loaded plugin: ${file} (with lifecycle hooks)`);
                    } else {
                        console.warn(`⚠ Plugin ${file} does not export a function or object with init(), skipping.`);
                    }
                } catch (err) {
                    console.error(`✗ Failed to load plugin ${file}:`, err);
                }
            }
        }
    } catch (err) {
        console.warn('Plugin loader failed:', err.message);
    }
}

// Graceful shutdown handler for plugins with shutdown hooks
process.on('SIGTERM', async () => {
    app.locals.ready = false;
    console.log('SIGTERM received, shutting down plugins...');
    for (const { name, plugin } of loadedPlugins) {
        if (plugin && typeof plugin.shutdown === 'function') {
            try {
                await plugin.shutdown();
                console.log(`✓ Shutdown plugin: ${name}`);
            } catch (err) {
                console.error(`✗ Error shutting down plugin ${name}:`, err);
            }
        }
    }
    process.exit(0);
});

// API Routes
app.get('/api/health', require('./services/health'));
app.get('/api/version', (req, res) => res.json({ version: require('../package.json').version }));
app.use('/api', auth.requireSameOrigin);
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);
// The login page's joke "Bypass login" button: plays one fixed video, before (and without) auth.
app.use('/api/bypass', require('./routes/bypass'));
app.use('/api', auth.requireAuth);
app.use('/api', (req, res, next) => {
    try {
        if (req.query.url !== undefined) validateHttpUrl(req.query.url);
        if (req.body?.url !== undefined) validateHttpUrl(req.body.url);
        next();
    } catch (error) { res.status(400).json({ error: error.message }); }
});
app.use('/api', (req, res, next) => {
    // Sources and what hangs off them are guarded per source: see services/sourceAccess
    const adminAction = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && /^\/settings(\/|$)/.test(req.path);
    if (adminAction) return auth.requireAdmin(req, res, next);
    next();
});
const mediaLimit = requestLimit(60);
app.use(['/api/remux', '/api/probe', '/api/subtitle', '/api/canvas'], mediaLimit);
app.use('/api/sources', require('./routes/sources'));
app.use('/api/proxy', require('./routes/proxy'));
app.use('/api/channels', require('./routes/channels'));
app.use('/api/favorites', require('./routes/favorites'));
app.use('/api/transcode', require('./routes/transcode'));
app.use('/api/remux', require('./routes/remux'));
app.use('/api/canvas', require('./routes/canvas'));
app.use('/api/probe', require('./routes/probe'));
app.use('/api/subtitle', require('./routes/subtitle'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/history', require('./routes/history'));
app.use('/api/openwebif', require('./routes/openwebif'));

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Server error:', redactText(err.message));
    res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, async () => {
    console.log(`NodeCast TV server running on http://localhost:${server.address().port}`);

    // Finish SSO discovery before announcing readiness. Local login remains available on failure.
    await authRoutes.oidcReady;
    // Load plugins
    await loadPlugins().catch(err => {
        console.error('Plugin initialization failed:', err);
    });
    app.locals.ready = true;
    if (process.env.NODECAST_DISABLE_BACKGROUND_JOBS === 'true') return;

    // Trigger background sync with delay to allow server to settle
    setTimeout(async () => {
        await syncService.syncAll().catch(console.error);
        // Start the server-side sync timer after initial sync
        await syncService.startSyncTimer().catch(console.error);

        // Detect hardware acceleration capabilities
        try {
            const hwDetect = require('./services/hwDetect');
            await hwDetect.detect(app.locals.ffmpegPath || 'ffmpeg');
            // Run canvas playback's one-time GPU test encode now rather than on the first stream.
            const { resolveCanvasEncoder } = require('./services/canvasEncoder');
            await resolveCanvasEncoder((await require('./db').settings.get()).hwEncoder, app.locals.ffmpegPath || 'ffmpeg');
        } catch (err) {
            console.warn('Hardware detection failed:', err.message);
        }
    }, 5000);
});
