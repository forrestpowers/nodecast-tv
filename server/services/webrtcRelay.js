const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

/**
 * WebRTC relay for canvas playback (the "Enhanced" engine)
 *
 * ffmpeg publishes each session to a private MediaMTX instance over RTSP; the browser fetches it
 * over WebRTC (WHEP, proxied through /api/canvas/webrtc/:id/whep) and draws the frames on a
 * canvas with MediaStreamTrackProcessor. MediaMTX's HTTP, RTSP and API listeners are bound to
 * localhost; only the WebRTC media port (UDP + ICE-TCP, default 8189) faces the network, and it
 * only carries sessions negotiated through nodecast.
 *
 * Environment:
 *   WEBRTC_ENABLED=false     turn the engine off
 *   MEDIAMTX_PATH            mediamtx binary (default: `mediamtx` on PATH)
 *   WEBRTC_PORT=8189         media port, UDP and TCP; forward it to this host for use outside the LAN
 *   WEBRTC_HOSTS             comma-separated public IPs / DNS-only hostnames advertised to browsers.
 *                            When set, interface addresses are not advertised (inside Docker they
 *                            are bridge IPs nobody can reach).
 *   WEBRTC_STUN              optional STUN server (e.g. stun:stun.l.google.com:19302) so MediaMTX
 *                            can discover and advertise the public IP itself
 *   MEDIAMTX_RTSP_PORT=18554, MEDIAMTX_WEBRTC_PORT=18889, MEDIAMTX_API_PORT=19997   localhost ports
 */

const READY_TIMEOUT_MS = 20000;
const POLL_MS = 250;

function envList(value) {
    return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function envPort(value, fallback) {
    const port = Number(value);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

function findOnPath(name) {
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, name);
        try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch (_) { /* keep looking */ }
    }
    return null;
}

function readConfig(env = process.env) {
    return {
        enabled: env.WEBRTC_ENABLED !== 'false',
        binary: env.MEDIAMTX_PATH || findOnPath(process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx'),
        mediaPort: envPort(env.WEBRTC_PORT, 8189),
        hosts: envList(env.WEBRTC_HOSTS),
        stun: env.WEBRTC_STUN || '',
        rtspPort: envPort(env.MEDIAMTX_RTSP_PORT, 18554),
        whepPort: envPort(env.MEDIAMTX_WEBRTC_PORT, 18889),
        apiPort: envPort(env.MEDIAMTX_API_PORT, 19997)
    };
}

const yamlString = (value) => JSON.stringify(String(value)); // JSON strings are valid YAML scalars

/**
 * MediaMTX configuration (written for 1.21; MediaMTX rejects keys it does not know, such as `moq`
 * on older releases): RTSP in, WebRTC out, everything but the media port on localhost.
 */
function buildMediaMtxConfig(config) {
    const lines = [
        'logLevel: warn',
        'api: true',
        `apiAddress: 127.0.0.1:${config.apiPort}`,
        'metrics: false',
        'pprof: false',
        'playback: false',
        'rtsp: true',
        'rtspTransports: [tcp]',
        `rtspAddress: 127.0.0.1:${config.rtspPort}`,
        // Every other server off; MediaMTX enables them by default on all interfaces.
        'rtmp: false',
        'hls: false',
        'srt: false',
        'moq: false',
        'webrtc: true',
        `webrtcAddress: 127.0.0.1:${config.whepPort}`,
        `webrtcLocalUDPAddress: :${config.mediaPort}`,
        // ICE-TCP on the same port for networks that block UDP (some cellular carriers).
        `webrtcLocalTCPAddress: :${config.mediaPort}`,
        `webrtcIPsFromInterfaces: ${config.hosts.length === 0}`,
        `webrtcAdditionalHosts: [${config.hosts.map(yamlString).join(', ')}]`,
        config.stun ? `webrtcICEServers2:\n  - url: ${yamlString(config.stun)}` : 'webrtcICEServers2: []',
        'webrtcHandshakeTimeout: 15s',
        'authMethod: internal',
        'authInternalUsers:',
        '  - user: any',
        '    ips: ["127.0.0.1", "::1"]',
        '    permissions:',
        '      - action: publish',
        '      - action: read',
        '      - action: api',
        'paths:',
        '  all_others:',
        ''
    ];
    return lines.join('\n');
}

class WebrtcRelay {
    constructor(config = readConfig()) {
        this.config = config;
        this.process = null;
        this.starting = null;
        this.sessions = new Map();
    }

    isAvailable() {
        return this.config.enabled && !!this.config.binary;
    }

    rtspUrl(name) {
        return `rtsp://127.0.0.1:${this.config.rtspPort}/${name}`;
    }

    /** Start MediaMTX on first use (and again if it died); resolves once its API answers. */
    ensureStarted() {
        if (this.process && this.process.exitCode === null) return this.starting || Promise.resolve();
        this.starting = this.start().finally(() => { this.starting = null; });
        return this.starting;
    }

    async start() {
        const configPath = path.join(os.tmpdir(), `nodecast-mediamtx-${process.pid}.yml`);
        fs.writeFileSync(configPath, buildMediaMtxConfig(this.config), { mode: 0o600 });
        console.log(`[WebRTC] Starting MediaMTX (${this.config.binary}), media port ${this.config.mediaPort} UDP/TCP, advertising ${this.config.hosts.join(', ') || 'interface addresses'}`);

        // Run from the temp dir: anything MediaMTX writes next to itself stays out of the app directory.
        const child = this.process = spawn(this.config.binary, [configPath], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
        const log = (data) => {
            for (const line of data.toString().split('\n')) {
                // waitForPath polls before ffmpeg has published; those 404s are expected.
                if (line.trim() && !line.includes('[API] path not found')) console.log(`[MediaMTX] ${line.trim()}`);
            }
        };
        child.stdout.on('data', log);
        child.stderr.on('data', log);
        child.on('exit', (code, signal) => {
            if (this.process === child) this.process = null;
            console.warn(`[WebRTC] MediaMTX exited (${signal || code})`);
        });
        const failed = new Promise((_, reject) => {
            child.once('error', (error) => reject(new Error(`MediaMTX failed to start: ${error.message}`)));
            child.once('exit', (code) => reject(new Error(`MediaMTX exited during startup (code ${code})`)));
        });

        const deadline = Date.now() + 10000;
        const ready = (async () => {
            while (Date.now() < deadline) {
                try {
                    const res = await fetch(`http://127.0.0.1:${this.config.apiPort}/v3/paths/list`);
                    if (res.ok) return;
                } catch (_) { /* not listening yet */ }
                await new Promise(resolve => setTimeout(resolve, POLL_MS));
            }
            throw new Error('MediaMTX did not start in time');
        })();
        try {
            await Promise.race([ready, failed]);
        } catch (error) {
            child.kill('SIGKILL');
            throw error;
        }
    }

    /** Resolves once ffmpeg's stream is live in MediaMTX; rejects on timeout or if `stopped()` turns true. */
    async waitForPath(name, stopped = () => false, timeoutMs = READY_TIMEOUT_MS) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (stopped()) throw new Error('Stream stopped before it was ready');
            try {
                const res = await fetch(`http://127.0.0.1:${this.config.apiPort}/v3/paths/get/${name}`);
                if (res.ok && (await res.json()).ready) return;
            } catch (_) { /* MediaMTX restarting */ }
            await new Promise(resolve => setTimeout(resolve, POLL_MS));
        }
        throw new Error('Stream did not become ready in time');
    }

    /** Forward a WHEP offer to MediaMTX; returns { status, body } with the SDP answer on success. */
    async whep(name, offer) {
        const res = await fetch(`http://127.0.0.1:${this.config.whepPort}/${name}/whep`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: offer
        });
        return { status: res.status, body: await res.text() };
    }

    createSession(userId) {
        const id = crypto.randomBytes(16).toString('hex');
        const session = { id, name: `nc${id}`, userId: userId ?? null, ffmpeg: null };
        this.sessions.set(id, session);
        return session;
    }

    getSession(id, userId) {
        const session = this.sessions.get(String(id));
        return session && session.userId === (userId ?? null) ? session : null;
    }

    endSession(id) {
        const session = this.sessions.get(id);
        if (!session) return;
        this.sessions.delete(id);
        session.ffmpeg?.kill('SIGKILL');
    }

    shutdown() {
        for (const id of [...this.sessions.keys()]) this.endSession(id);
        this.process?.kill('SIGTERM');
    }
}

const relay = new WebrtcRelay();
process.on('exit', () => relay.shutdown());

module.exports = { relay, WebrtcRelay, readConfig, buildMediaMtxConfig };
