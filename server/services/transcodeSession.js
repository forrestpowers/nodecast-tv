const { parseProgram } = require('./mpegTsProgram');
const { redactUrl, redactText, validateHttpUrl, FFMPEG_PROTOCOL_WHITELIST } = require('./urlSecurity');
/**
 * Transcode Session Service
 * 
 * Manages HLS transcoding sessions with segment caching for VOD seeking.
 * Each session transcodes a source URL to HLS segments on disk.
 * 
 * Key features:
 * - Session-based transcoding with unique IDs
 * - HLS segment output for seeking support
 * - Segment caching for fast access
 * - Session persistence for recovery after restart
 * - Automatic cleanup of stale sessions
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const EventEmitter = require('events');
const hwDetect = require('./hwDetect');

// Session storage
const sessions = new Map();
const leases = new Map();
let managerQueue = Promise.resolve();
const serializeManager = task => {
    const next = managerQueue.then(task);
    managerQueue = next.catch(() => {});
    return next;
};
const leaseError = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
function normalizePlaybackLeaseId(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw leaseError("Invalid playback lease", 400);
    return value;
}
function pruneLeases() {
    const now = Date.now();
    for (const [key, lease] of leases) if (lease.until <= now) leases.delete(key);
}


// Cache directory for transcoded segments
const CACHE_DIR = path.join(process.cwd(), 'transcode-cache');

// Session settings
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes idle timeout
const SEGMENT_DURATION = 4; // seconds per HLS segment
const CLEANUP_INTERVAL_MS = 30 * 1000; // Check every 5 minutes

/**
 * Generate a unique session ID
 */
function generateSessionId() {
    return crypto.randomBytes(8).toString('hex');
}

/**
 * Ensure cache directory exists
 */
async function ensureCacheDir() {
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
    }
}

/**
 * TranscodeSession class
 * Manages a single transcoding session from source URL to HLS segments
 */
class TranscodeSession extends EventEmitter {
    constructor(url, options = {}) {
        super();
        this.id = generateSessionId();
        this.url = url;
        this.ownerId = options.ownerId ?? null;
        this.playbackLeaseId = normalizePlaybackLeaseId(options.playbackLeaseId);
        this.lastHeartbeat = Date.now();
        this.retired = false;
        this.stopping = false;
        this.startTask = null;
        this.restartTimer = null;
        this.restartCount = 0;
        this.dir = path.join(CACHE_DIR, this.id);
        this.playlistPath = path.join(this.dir, 'stream.m3u8');
        this.process = null;
        this.segments = new Map(); // segment index -> { ready: boolean, path: string }
        this.status = 'pending'; // pending | starting | running | stopped | error
        this.error = null;
        this.startTime = Date.now();
        this.lastAccess = Date.now();
        this.options = {
            ffmpegPath: options.ffmpegPath || 'ffmpeg',
            userAgent: options.userAgent || 'Mozilla/5.0',
            seekOffset: options.seekOffset || 0,
            hwEncoder: options.hwEncoder || 'software',
            maxResolution: options.maxResolution || '480p',
            quality: options.quality || 'medium',
            // Upscaling options
            upscaleEnabled: options.upscaleEnabled || false,
            upscaleMethod: options.upscaleMethod || 'hardware', // 'hardware' or 'software'
            upscaleTarget: options.upscaleTarget || '1080p',
            ...options,
            program: parseProgram(options.program)
        };
    }

    /**
     * Start the transcoding process
     */
    async start() {
        if (this.retired) throw leaseError('Playback session was retired');
        if (this.startTask) return this.startTask;
        if (this.process) return;
        this.stopping = false;
        const task = this.startProcess();
        this.startTask = task;
        try { await task; }
        catch (error) {
            if (!this.retired) { this.status = 'error'; this.error = error.message; }
            throw error;
        } finally { if (this.startTask === task) this.startTask = null; }
    }

    async startProcess() {
        this.status = 'starting';
        await fs.mkdir(this.dir, { recursive: true });
        if (this.retired) throw leaseError('Playback session was retired');
        const child = spawn(this.options.ffmpegPath, this.buildFFmpegArgs(), { cwd: this.dir, windowsHide: true });
        this.process = child;
        this.processStartedAt = Date.now();
        this.status = 'running';
        let processError = false;
        child.stdout.on('data', () => {});
        let logBuffer = '', droppingLogLine = false;
        child.stderr.on('data', data => {
            logBuffer += data.toString();
            const lines = logBuffer.split('\n');
            logBuffer = lines.pop();
            for (const line of lines) {
                if (droppingLogLine) droppingLogLine = false;
                else console.log(`[FFmpeg ${this.id}] ${redactText(line)}`);
            }
            if (logBuffer.length > 65536) { logBuffer = ''; droppingLogLine = true; }
        });
        child.on('error', error => {
            processError = true;
            this.status = 'error';
            this.error = error.message;
            if (this.listenerCount('error')) this.emit('error', error);
        });
        this.processClosed = new Promise(resolve => child.once('close', code => {
            if (this.process === child) this.process = null;
            if (!this.retired && !this.stopping && this.options.isLive && !processError) this.scheduleLiveRestart();
            else if (!processError) {
                this.status = code === 0 || code === null || this.stopping ? 'stopped' : 'error';
                if (this.status === 'error') this.error = 'FFmpeg exited unsuccessfully';
            }
            this.emit('exit', code);
            resolve();
        }));
        await this.persist();
        if (this.retired) throw leaseError('Playback session was retired');
    }

    scheduleLiveRestart() {
        if (this.retired || this.stopping) return;
        if (Date.now() - this.processStartedAt >= 30000) this.restartCount = 0;
        if (++this.restartCount > 3) {
            this.status = 'error';
            this.error = 'Live input repeatedly disconnected';
            return;
        }
        this.status = 'reconnecting';
        this.restartTimer = setTimeout(async () => {
            this.restartTimer = null;
            if (this.startTask) await this.startTask.catch(() => {});
            if (!this.retired && !this.stopping) this.start().catch(error => { this.status = 'error'; this.error = error.message; });
        }, 1000);
        this.restartTimer.unref?.();
    }

    /**
     * Build FFmpeg arguments for HLS output with optional GPU encoding
     */
    buildFFmpegArgs() {
        const segmentPattern = path.join(this.dir, 'seg%04d.m4s');
        const videoMode = this.options.videoMode || 'encode';

        // Resolve 'auto' encoder to detected hardware, fallback to software
        let encoder = this.options.hwEncoder || 'software';
        if (encoder === 'auto') {
            const hwCaps = hwDetect.getCapabilities();
            encoder = hwCaps?.recommended || 'software';
            console.log(`[TranscodeSession ${this.id}] Auto encoder resolved to: ${encoder}`);
        }

        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST,
            '-user_agent', this.options.userAgent,
        ];

        // Add hardware acceleration input options based on encoder (only if encoding)
        if (videoMode === 'encode') {
            this.addHwAccelInputArgs(args, encoder);
        }

        // Input options (common)
        args.push(
            '-probesize', '5000000',
            '-analyzeduration', '5000000',
            '-fflags', '+genpts+discardcorrupt',
            '-err_detect', 'ignore_err',
            '-multiple_requests', '0',
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_on_http_error', '4xx,5xx',
            '-reconnect_delay_max', '10'
        );

        args.push('-i', this.url);

        // Add seek offset if specified (as output option to avoid Range requests)
        if (this.options.seekOffset > 0) {
            args.push('-ss', String(this.options.seekOffset));
        }

        // Map streams
        // Only map video/audio from the program: mapping the whole program pulls in
        // DVB teletext/subtitle streams, which can't be encoded to HLS and kill FFmpeg
        if (this.options.program) {
            args.push('-map', `0:p:${this.options.program}:v:0`);
            args.push('-map', `0:p:${this.options.program}:a:0?`);
        } else {
            args.push('-map', '0:v:0');
            args.push('-map', '0:a:0?');
        }

        // Add video encoder and filters based on selected encoder OR copy
        if (videoMode === 'copy') {
            args.push('-c:v', 'copy');

            // Critical for MKV/MP4 -> TS copy: Convert bitstream from AVCC/HVCC to Annex B
            if (this.options.videoCodec === 'hevc' || this.options.videoCodec === 'h265') {
                args.push('-bsf:v', 'hevc_mp4toannexb');
            } else if (this.options.videoCodec === 'h264' || this.options.videoCodec === 'avc') {
                args.push('-bsf:v', 'h264_mp4toannexb');
            } else {
                // Fallback (e.g. unknown codec), try strict extraction
                args.push('-bsf:v', 'dump_extra');
            }
        } else {
            this.addVideoEncoderArgs(args, encoder);
        }

        // Audio: Apply mix preset
        const audioCodec = this.options.audioCodec?.toLowerCase() || 'unknown';
        const audioChannels = this.options.audioChannels || 0;
        const audioMixPreset = this.options.audioMixPreset || 'auto';
        const isStereoAac = audioCodec.includes('aac') && audioChannels === 2;

        // Define pan filter presets for 5.1 -> Stereo downmix
        const AUDIO_MIX_FILTERS = {
            // ITU-R BS.775 Standard: Mathematically balanced, transparent
            itu: 'pan=stereo|FL=FL+0.707*FC+0.707*BL+0.5*LFE|FR=FR+0.707*FC+0.707*BR+0.5*LFE',
            // Night Mode: Heavy dialogue boost, reduced bass/surrounds for quiet viewing
            night: 'pan=stereo|FL=0.5*FL+1.2*FC+0.3*BL+0.1*LFE|FR=0.5*FR+1.2*FC+0.3*BR+0.1*LFE',
            // Cinematic: Wide soundstage, immersive (original "dialogue boost" mix)
            cinematic: 'pan=stereo|FL=FC+0.80*FL+0.60*BL+0.5*LFE|FR=FC+0.80*FR+0.60*BR+0.5*LFE'
        };

        if (audioMixPreset === 'passthrough') {
            // Passthrough: Always copy audio, no processing
            console.log(`[TranscodeSession ${this.id}] Audio: Passthrough (copy)`);
            args.push('-c:a', 'copy');
        } else if (audioMixPreset === 'auto' && isStereoAac) {
            // Auto + Stereo AAC source: Smart copy
            console.log(`[TranscodeSession ${this.id}] Audio: Auto (Smart Copy) - Source is Stereo AAC`);
            args.push('-c:a', 'copy');
        } else {
            // Transcode to AAC with selected mix preset (default to ITU for 'auto')
            const mixPreset = (audioMixPreset === 'auto') ? 'itu' : audioMixPreset;
            const panFilter = AUDIO_MIX_FILTERS[mixPreset] || AUDIO_MIX_FILTERS.itu;

            console.log(`[TranscodeSession ${this.id}] Audio: ${mixPreset.toUpperCase()} mix (${audioCodec} ${audioChannels}ch -> Stereo AAC)`);
            args.push(
                '-c:a', 'aac',
                '-ar', '48000',
                '-b:a', '192k',
                '-af', `${panFilter},aresample=async=1`
            );
        }

        // HLS output options
        args.push(
            '-f', 'hls',
            '-hls_time', String(SEGMENT_DURATION),
            '-hls_list_size', this.options.isLive ? '6' : '0',
            '-hls_flags', this.options.isLive ? 'independent_segments+append_list+delete_segments+omit_endlist' : 'independent_segments+append_list',
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', path.join(this.dir, 'seg%04d.ts'),
            this.playlistPath
        );

        return args;
    }

    /**
     * Add hardware acceleration input arguments
     */
    addHwAccelInputArgs(args, encoder) {
        switch (encoder) {
            case 'nvenc':
                // NVIDIA CUDA/NVDEC hardware decoding
                args.push(
                    '-hwaccel', 'cuda',
                    '-hwaccel_output_format', 'cuda'
                );
                break;
            case 'vaapi':
                // VAAPI hardware decoding (Linux)
                args.push(
                    '-hwaccel', 'vaapi',
                    '-hwaccel_device', '/dev/dri/renderD128',
                    '-hwaccel_output_format', 'vaapi'
                );
                break;
            case 'qsv': {
                const device = hwDetect.getCapabilities()?.qsv?.device;
                if (typeof device === 'string' && /^\/dev\/dri\/renderD\d+$/.test(device)) {
                    args.push('-init_hw_device', 'qsv=nodecast:hw,child_device=' + device + ',child_device_type=vaapi',
                        '-filter_hw_device', 'nodecast', '-hwaccel_device', 'nodecast');
                }
                // Intel QuickSync hardware decoding
                args.push(
                    '-hwaccel', 'qsv',
                    '-hwaccel_output_format', 'qsv'
                );
                break;
            }
            case 'amf':
                // AMD AMF (no hwaccel input, AMF is encode-only)
                // Decode on CPU, encode on GPU
                break;
            case 'software':
            case 'auto':
            default:
                // No hardware acceleration for input
                break;
        }
    }

    /**
     * Add video encoder arguments based on selected encoder
     */
    addVideoEncoderArgs(args, encoder) {
        const resolution = this.getTargetHeight();
        const quality = this.options.quality || 'medium';

        // Quality presets mapping
        const qualityPresets = {
            'high': { nvenc: 18, vaapi: 18, qsv: 18, amf: 18, software: 18 },
            'medium': { nvenc: 24, vaapi: 24, qsv: 24, amf: 24, software: 23 },
            'low': { nvenc: 30, vaapi: 30, qsv: 30, amf: 30, software: 28 }
        };
        const qp = qualityPresets[quality] || qualityPresets.medium;

        switch (encoder) {
            case 'nvenc':
                this.addNvencEncoderArgs(args, resolution, qp.nvenc);
                break;
            case 'amf':
                this.addAmfEncoderArgs(args, resolution, qp.amf);
                break;
            case 'vaapi':
                this.addVaapiEncoderArgs(args, resolution, qp.vaapi);
                break;
            case 'qsv':
                this.addQsvEncoderArgs(args, resolution, qp.qsv);
                break;
            case 'software':
            case 'auto':
            default:
                this.addSoftwareEncoderArgs(args, resolution, qp.software);
                break;
        }
    }

    /**
     * Get target height based on maxResolution or upscaleTarget setting
     * When upscaling is enabled, uses the upscaleTarget resolution.
     * Otherwise, uses maxResolution to cap the output.
     */
    getTargetHeight() {
        const resolutionMap = {
            '4k': 2160,
            '1080p': 1080,
            '720p': 720,
            '480p': 480
        };

        // When upscaling is enabled, use the upscale target resolution
        if (this.options.upscaleEnabled) {
            const target = resolutionMap[this.options.upscaleTarget] || 1080;
            console.log(`[TranscodeSession ${this.id}] Upscale target height: ${target}p`);
            return target;
        }

        // Otherwise, use max resolution as the cap
        return resolutionMap[this.options.maxResolution] || 480;
    }

    /**
     * Build scale filter string based on encoder and upscaling settings
     * @param {string} encoder - The encoder being used
     * @param {number} height - Target height
     */
    buildScaleFilter(encoder, height) {
        const useUpscale = this.options.upscaleEnabled;
        const upscaleMethod = this.options.upscaleMethod || 'hardware';
        const sourceHeight = this.options.videoHeight | 0;

        const effectiveHeight = useUpscale
            ? height
            : (sourceHeight > 0 ? Math.min(height, sourceHeight) : height);

        // Log upscaling / passthrough decision
        if (useUpscale) {
            console.log(`[TranscodeSession ${this.id}] Upscaling: ${upscaleMethod} method to ${effectiveHeight}p`);
        } else if (sourceHeight > 0 && sourceHeight <= height) {
            console.log(`[TranscodeSession ${this.id}] Source ${sourceHeight}p is within cap ${height}p, passing through`);
        }

        const h = effectiveHeight;

        // Hardware scaling filters (for both upscale and downscale)
        if (upscaleMethod === 'hardware' || !useUpscale) {
            switch (encoder) {
                case 'nvenc':
                    // NVIDIA CUDA scaling with Lanczos
                    // Force nv12 (8-bit) output to handle 10-bit inputs (fixes "10 bit encode not supported")
                    return `scale_cuda=-2:${h}:interp_algo=lanczos:format=nv12`;
                case 'vaapi':
                    return `scale_vaapi=w=-2:h=${h}:format=nv12`;
                case 'qsv':
                    return `scale_qsv=w=-2:h=${h}:format=nv12`;
                case 'amf':
                    // AMF uses CPU decode, so use software scale
                    return useUpscale ? `scale=-2:${h}:flags=lanczos` : `scale=-2:${h}`;
                case 'software':
                default:
                    return useUpscale ? `scale=-2:${h}:flags=lanczos` : `scale=-2:${h}`;
            }
        }

        // Software Lanczos scaling (high quality, slower)
        return `scale=-2:${h}:flags=lanczos`;
    }

    /**
     * NVIDIA NVENC encoder arguments
     */
    addNvencEncoderArgs(args, height, qp) {
        // Video filter for scaling on GPU
        args.push('-vf', this.buildScaleFilter('nvenc', height));

        // NVENC encoder with quality settings
        // Using portable options that work across FFmpeg builds
        args.push(
            '-c:v', 'h264_nvenc',
            '-preset', 'p4',           // Balanced preset (p1=fastest, p7=best)
            '-rc', 'constqp',          // Constant QP mode
            '-qp', String(qp),
            '-bf', '3'                 // B-frames for better compression
        );
    }

    /**
     * AMD AMF encoder arguments
     */
    addAmfEncoderArgs(args, height, qp) {
        // CPU decoding + software scale + AMF encode
        args.push('-vf', this.buildScaleFilter('amf', height));

        args.push(
            '-c:v', 'h264_amf',
            '-quality', 'quality',     // Quality preset
            '-rc', 'cqp',              // Constant QP
            '-qp_i', String(qp),
            '-qp_p', String(qp + 2),
            '-qp_b', String(qp + 4),
            '-pix_fmt', 'yuv420p'      // Force 8-bit output for compatibility
        );
    }

    /**
     * VAAPI encoder arguments (Linux)
     */
    addVaapiEncoderArgs(args, height, qp) {
        // VAAPI filter chain:
        // 1. scale_vaapi to resize on GPU
        // 2. Ensure output format is nv12 for maximum encoder compatibility
        // The format is handled automatically when using -hwaccel_output_format vaapi
        args.push('-vf', this.buildScaleFilter('vaapi', height));

        // VAAPI encoder with quality setting
        // Note: -global_quality is the portable way to set quality for VAAPI
        args.push(
            '-c:v', 'h264_vaapi',
            '-profile:v', 'main',      // Use main profile for compatibility
            '-global_quality', String(qp),
            '-bf', '3',
            '-pix_fmt', 'yuv420p'      // Force 8-bit output for compatibility
        );
    }

    /**
     * Intel QuickSync encoder arguments
     */
    addQsvEncoderArgs(args, height, qp) {
        // Scale on QSV
        args.push('-vf', this.buildScaleFilter('qsv', height));

        args.push(
            '-c:v', 'h264_qsv',
            '-preset', 'medium',
            '-global_quality', String(qp),
            '-look_ahead', '1',
            '-look_ahead_depth', '40',
            '-pix_fmt', 'yuv420p'      // Force 8-bit output for compatibility
        );
    }

    /**
     * Software encoder arguments (fallback)
     */
    addSoftwareEncoderArgs(args, height, crf) {
        // Software scaling (use Lanczos for upscaling if enabled)
        args.push('-vf', this.buildScaleFilter('software', height));

        args.push(
            '-c:v', 'libx264',
            '-preset', 'veryfast',     // Fast for real-time
            '-crf', String(crf),
            '-profile:v', 'high',
            '-level', '4.1',
            '-pix_fmt', 'yuv420p'      // Force 8-bit output for compatibility (fixes 10-bit input errors)
        );
    }

    /**
     * Stop the transcoding process
     */
    async stop() {
        this.stopping = true;
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
        const child = this.process;
        if (child) {
            const force = setTimeout(() => child.kill('SIGKILL'), 2000);
            force.unref?.();
            try { child.kill('SIGTERM'); await this.processClosed; }
            finally { clearTimeout(force); }
        }
        this.status = 'stopped';
    }

    /**
     * Update last access time (prevents cleanup)
     */
    touch() {
        this.lastAccess = Date.now();
    }

    /**
     * Check if playlist exists and is ready
     */
    async isPlaylistReady() {
        try {
            await fs.access(this.playlistPath);
            const content = await fs.readFile(this.playlistPath, 'utf8');
            // Check if playlist has at least one segment
            return content.includes('.ts');
        } catch {
            return false;
        }
    }

    /**
     * Wait for playlist to be ready (with timeout)
     */
    async waitForPlaylist(timeoutMs = 10000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            if (this.retired || this.status === 'error') return false;
            if (await this.isPlaylistReady()) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return false;
    }

    /**
     * Get the HLS playlist content
     */
    async getPlaylist() {
        if (this.retired || this.status === 'error') return null;
        this.touch();
        try {
            return await fs.readFile(this.playlistPath, 'utf8');
        } catch (err) {
            return null;
        }
    }

    /**
     * Get a specific segment
     */
    async getSegment(segmentName) {
        this.touch();
        if (!/^seg[0-9]+\.ts$/.test(segmentName)) return null;
        const segmentPath = path.join(this.dir, segmentName);
        try {
            await fs.access(segmentPath);
            return segmentPath;
        } catch {
            return null;
        }
    }

    /**
     * Save session metadata to disk for recovery
     */
    async persist() {
        const metadata = {
            id: this.id,
            url: this.url,
            status: this.status,
            startTime: this.startTime,
            lastAccess: this.lastAccess,
            options: this.options,
            seekOffset: this.options.seekOffset
        };
        const metaPath = path.join(this.dir, 'session.json');
        await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2));
    }

    /**
     * Restore a session from disk metadata
     */
    static async restore(sessionDir) {
        const metaPath = path.join(sessionDir, 'session.json');
        try {
            const data = await fs.readFile(metaPath, 'utf8');
            const metadata = JSON.parse(data);
            const session = new TranscodeSession(metadata.url, metadata.options);
            session.id = metadata.id;
            session.dir = sessionDir;
            session.playlistPath = path.join(sessionDir, 'stream.m3u8');
            session.startTime = metadata.startTime;
            session.lastAccess = metadata.lastAccess;
            session.status = 'stopped'; // Not running after restart
            return session;
        } catch (err) {
            console.error(`Failed to restore session from ${sessionDir}:`, err.message);
            return null;
        }
    }

    /**
     * Delete session directory and all segments
     */
    async cleanup() {
        this.retired = true;
        clearTimeout(this.restartTimer);
        if (this.startTask) await this.startTask.catch(() => {});
        await this.stop();
        try {
            const target = path.resolve(this.dir);
            if (path.dirname(target) !== path.resolve(CACHE_DIR) || !/^[0-9a-f]{16}$/.test(path.basename(target))) {
                throw new Error('Invalid session cache directory');
            }
            await fs.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
            console.log(`[TranscodeSession ${this.id}] Cleaned up session directory`);
        } catch (err) {
            console.error(`[TranscodeSession ${this.id}] Failed to cleanup:`, err.message);
        }
    }
}

/**
 * Session Manager
 */

/**
 * Create a new transcode session
 */
async function createSession(url, options = {}) {
    validateHttpUrl(url);
    const playbackLeaseId = normalizePlaybackLeaseId(options.playbackLeaseId);
    const key = playbackLeaseId ? `${options.ownerId}:${playbackLeaseId}` : null;
    const sequence = options.requestSequence ?? 1;
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw leaseError('Invalid request sequence', 400);
    return serializeManager(async () => {
        pruneLeases();
        if (key) {
            const previous = leases.get(key);
            if (previous?.released || (previous && sequence <= previous.sequence)) throw leaseError('Playback request was superseded');
            if (!previous && leases.size >= 10000) throw leaseError('Too many playback requests', 429);
            leases.set(key, { sequence, released: false, until: Date.now() + 5 * 60 * 1000 });
            for (const session of [...sessions.values()]) {
                if (session.ownerId === options.ownerId && session.playbackLeaseId === playbackLeaseId) await removeSession(session.id, options.ownerId);
            }
        }
        const active = [...sessions.values()].filter(session => !['stopped', 'error'].includes(session.status));
        if (active.length >= 12 || active.filter(session => session.ownerId === options.ownerId).length >= 4) throw leaseError('Too many transcode sessions', 429);
        await ensureCacheDir();
        const session = new TranscodeSession(url, { ...options, playbackLeaseId });
        sessions.set(session.id, session);
        return session;
    });
}

async function releasePlaybackLease(ownerId, value) {
    const leaseId = normalizePlaybackLeaseId(value);
    if (!leaseId) throw leaseError('Playback lease is required', 400);
    return serializeManager(async () => {
        pruneLeases();
        const key = `${ownerId}:${leaseId}`;
        if (!leases.has(key) && leases.size >= 10000) throw leaseError('Too many playback requests', 429);
        leases.set(key, { released: true, sequence: Number.MAX_SAFE_INTEGER, until: Date.now() + 5 * 60 * 1000 });
        for (const session of [...sessions.values()]) if (session.ownerId === ownerId && session.playbackLeaseId === leaseId) await removeSession(session.id, ownerId);
    });
}

function refreshPlaybackLease(ownerId, value) {
    const leaseId = normalizePlaybackLeaseId(value);
    const key = `${ownerId}:${leaseId}`, lease = leases.get(key);
    if (!lease || lease.released) return false;
    lease.until = Date.now() + 5 * 60 * 1000;
    for (const session of sessions.values()) if (session.ownerId === ownerId && session.playbackLeaseId === leaseId) session.lastHeartbeat = Date.now();
    return true;
}

/**
 * Get an existing session by ID
 */
function getSession(sessionId, ownerId = null) {
    const session = sessions.get(sessionId);
    if (session && ownerId !== null && session.ownerId !== ownerId) return null;
    if (session) {
        session.touch();
    }
    return session;
}

/**
 * Get or create a session for a URL (reuses existing if still valid)
 */
async function getOrCreateSession(url, options = {}) {
    // A URL cannot identify an account or its processing settings.
    return createSession(url, options);
}

/**
 * Stop and remove a session
 */
async function removeSession(sessionId, ownerId = null) {
    const session = sessions.get(sessionId);
    if (session && ownerId !== null && session.ownerId !== ownerId) return false;
    if (session) {
        sessions.delete(sessionId);
        await session.cleanup();
        return true;
    }
    return false;
}

/**
 * Cleanup stale sessions (idle for too long)
 */
async function cleanupStaleSessions() {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if ((session.playbackLeaseId && now - session.lastHeartbeat > 150000) || now - session.lastAccess > SESSION_TIMEOUT_MS) {
            console.log(`[TranscodeSession] Cleaning up stale session ${id}`);
            if (session.playbackLeaseId) await releasePlaybackLease(session.ownerId, session.playbackLeaseId);
            else await removeSession(id);
        }
    }
}

/**
 * Recover sessions from disk after server restart
 */
async function recoverSessions() {
    try {
        await fs.access(CACHE_DIR);
        const dirs = await fs.readdir(CACHE_DIR, { withFileTypes: true });

        for (const dirent of dirs) {
            if (dirent.isDirectory()) {
                const sessionDir = path.join(CACHE_DIR, dirent.name);
                const session = await TranscodeSession.restore(sessionDir);
                if (session) {
                    sessions.set(session.id, session);
                    console.log(`[TranscodeSession] Recovered session ${session.id}`);
                }
            }
        }
    } catch (err) {
        // Cache dir doesn't exist yet, that's fine
        if (err.code !== 'ENOENT') {
            console.error('[TranscodeSession] Error recovering sessions:', err.message);
        }
    }
}

/**
 * Start cleanup interval
 */
let cleanupInterval = null;
function startCleanupInterval() {
    if (!cleanupInterval) {
        cleanupInterval = setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
        cleanupInterval.unref(); // Don't prevent process exit
    }
}

/**
 * Get all active sessions (for debugging/monitoring)
 */
function getAllSessions() {
    return Array.from(sessions.values()).map(s => ({
        id: s.id,
        url: redactUrl(s.url),
        status: s.status,
        startTime: s.startTime,
        lastAccess: s.lastAccess,
        idleMs: Date.now() - s.lastAccess
    }));
}

module.exports = {
    TranscodeSession,
    createSession,
    releasePlaybackLease,
    refreshPlaybackLease,
    normalizePlaybackLeaseId,
    getSession,
    getOrCreateSession,
    removeSession,
    cleanupStaleSessions,
    recoverSessions,
    startCleanupInterval,
    getAllSessions,
    CACHE_DIR,
    SEGMENT_DURATION
};
