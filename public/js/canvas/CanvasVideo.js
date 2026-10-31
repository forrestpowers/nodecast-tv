/**
 * Canvas playback
 *
 * Plays streams without a <video> element, which browsers like the Tesla in-car browser
 * suspend outside of Park. /api/canvas/stream delivers MPEG-TS, the browser decodes it itself
 * and draws onto a <canvas>; sound goes through Web Audio. Three engines:
 *
 *   webcodecs  H.264 + AAC, decoded with WebCodecs in a worker (webcodecs-pipeline.js)
 *   jsmpeg     MPEG-1 + MP2, decoded by JSMpeg in WebAssembly (jsmpeg-pipeline.js); works
 *              without WebCodecs, which the Tesla browser does not have today
 *   webrtc     H.264 + Opus over WebRTC from the server's MediaMTX, frames drawn via
 *              MediaStreamTrackProcessor, sound through an <audio> element (webrtc-pipeline.js).
 *              Opt-in ("Enhanced"): it needs the server's WebRTC media port reachable.
 *
 * CanvasVideo takes over the existing <video> element's media API while active (play, pause,
 * paused, currentTime, duration, volume, muted, src, ...) and fires the usual media events on
 * it, so the player pages' controls, seek bar and history tracking work unchanged.
 */

const CanvasPlayback = {
    MODE_KEY: 'nodecast-canvas-mode',       // 'auto' | 'on' | 'off' (per device)
    ENGINE_KEY: 'nodecast-canvas-engine',   // 'auto' | 'webcodecs' | 'jsmpeg' | 'webrtc'
    HEIGHT_KEY: 'nodecast-canvas-height',   // max decoded height
    ACK_KEY: 'nodecast-canvas-ack',

    /** Whether this looks like the Tesla in-car browser (see detectTesla). */
    isTeslaBrowser() {
        return this.detectTesla().isTesla;
    },

    /**
     * Tesla browser detection, after EVStream's: a Tesla token in the user agent is certain.
     * Without one, only desktop-Linux Chromium qualifies, scored by the car's screen (1254x784 or
     * 1410x833 CSS pixels; 1920x1200 Model 3/Y or 2200x1300 Model S/X panels), touch without hover, a
     * fractional pixel ratio and few CPU cores. 3 points or more counts as likely.
     * @returns {{ isTesla: boolean, confidence: 'certain'|'likely'|'unlikely', score: number, reasons: string[] }}
     */
    detectTesla(signals = this.readDeviceSignals()) {
        const result = (confidence, score, reasons) => ({ isTesla: confidence !== 'unlikely', confidence, score, reasons });
        const ua = signals.userAgent || '';
        if (/Tesla(?:Browser)?\/[\w.-]+|\bTesla(?:Browser)?\b|QtCarBrowser/i.test(ua)) return result('certain', 10, ['ua-token']);
        if (/Android|iPhone|iPad|iPod|Mobile Safari|Windows Phone/i.test(ua) || !/X11;[^)]*Linux/i.test(ua)) return result('unlikely', 0, ['not-linux-x11']);
        if (!/Chrom(?:e|ium)\/\d+/i.test(ua)) return result('unlikely', 0, ['not-chromium']);

        const near = (value, target) => Math.abs(value - target) <= Math.max(2, target * 0.02);
        const matches = (w, h, sizes) => sizes.some(([a, b]) => (near(w, a) && near(h, b)) || (near(w, b) && near(h, a)));
        const { screenWidth: w = 0, screenHeight: h = 0, devicePixelRatio: ratio = 1 } = signals;
        const reasons = [];
        let score = 0;
        const add = (reason, points) => { reasons.push(reason); score += points; };
        if (matches(w, h, [[1254, 784], [1410, 833]])) add('known-css-screen', 2.5);
        if (matches(Math.round(w * ratio), Math.round(h * ratio), [[1920, 1200], [2200, 1300]])) add('known-panel', 1.5);
        if (signals.maxTouchPoints > 0 || signals.coarsePointer) add('touchscreen', 2);
        if (!signals.hoverCapable) add('no-hover', 1);
        if (Number.isFinite(ratio) && ratio > 1.05 && Math.abs(ratio - Math.round(ratio)) > 0.05) add('fractional-ratio', 1);
        if (signals.cpuCores > 0 && signals.cpuCores <= 4) add('few-cores', 0.5);
        return result(score >= 3 ? 'likely' : 'unlikely', score, reasons);
    },

    readDeviceSignals() {
        const media = (query) => { try { return window.matchMedia(query).matches; } catch (_) { return false; } };
        return {
            userAgent: navigator.userAgent || '',
            screenWidth: window.screen?.width || 0,
            screenHeight: window.screen?.height || 0,
            devicePixelRatio: window.devicePixelRatio || 1,
            maxTouchPoints: navigator.maxTouchPoints || 0,
            coarsePointer: media('(pointer: coarse)'),
            hoverCapable: media('(hover: hover)'),
            cpuCores: navigator.hardwareConcurrency || 0
        };
    },

    hasAudio() {
        return typeof (window.AudioContext || window.webkitAudioContext) === 'function';
    },

    /**
     * The engine this device will use, or null when canvas playback is impossible here.
     * WebRTC is only used when chosen; `streamEngine` skips it (the fallback when WebRTC fails).
     */
    getEngine({ streamEngine = false } = {}) {
        if (!this.hasAudio()) return null;
        const webcodecs = window.WebCodecsPipeline?.isSupported() ? 'webcodecs' : null;
        const jsmpeg = window.JsmpegPipeline?.isSupported() ? 'jsmpeg' : null;
        const preference = this.read(this.ENGINE_KEY, 'auto');
        if (preference === 'webrtc' && !streamEngine && window.WebRtcPipeline?.isSupported()) return 'webrtc';
        if (preference === 'jsmpeg') return jsmpeg || webcodecs;
        if (preference === 'webcodecs') return webcodecs || jsmpeg;
        return webcodecs || jsmpeg;
    },
    getEnginePreference() { return this.read(this.ENGINE_KEY, 'auto'); },
    setEnginePreference(engine) { if (['auto', 'webcodecs', 'jsmpeg', 'webrtc'].includes(engine)) this.write(this.ENGINE_KEY, engine); },

    isSupported() { return this.getEngine() !== null; },

    getMode() { return this.read(this.MODE_KEY, 'auto'); },
    setMode(mode) { if (['auto', 'on', 'off'].includes(mode)) this.write(this.MODE_KEY, mode); },

    getMaxHeight() {
        const height = Number(this.read(this.HEIGHT_KEY, '720'));
        return [360, 480, 720, 1080].includes(height) ? height : 720;
    },
    setMaxHeight(height) { this.write(this.HEIGHT_KEY, String(height)); },

    isEnabled() {
        const mode = this.getMode();
        if (mode === 'off' || !this.isSupported()) return false;
        return mode === 'on' || this.isTeslaBrowser();
    },

    isInterlaced(info) {
        return ['tt', 'bb', 'tb', 'bt'].includes(info?.fieldOrder);
    },

    /** WebCodecs engine: copy progressive H.264 the device can decode as-is; re-encode everything else. */
    videoModeFor(info) {
        const h264 = /h264|avc/i.test(info?.video || '');
        const height = Number(info?.height) || 0;
        return h264 && height > 0 && height <= this.getMaxHeight() && !this.isInterlaced(info) ? 'copy' : 'encode';
    },

    /** WebCodecs engine: AAC that is already mono/stereo needs no re-encode. */
    audioModeFor(info) {
        const channels = Number(info?.audioChannels) || 0;
        return info?.audio === 'aac' && channels >= 1 && channels <= 2 ? 'copy' : 'encode';
    },

    /** WebRTC engine: copy only when the probe saw no B-frames, which WebRTC cannot carry (most IPTV H.264 has them). */
    webrtcVideoModeFor(info) {
        return this.videoModeFor(info) === 'copy' && info?.hasBFrames === false ? 'copy' : 'encode';
    },

    planForEngine(engine, info) {
        const videoMode = engine === 'webcodecs' ? this.videoModeFor(info)
            : engine === 'webrtc' ? this.webrtcVideoModeFor(info) : 'encode';
        return {
            engine,
            videoMode,
            // WebRTC always gets Opus from the server.
            audioMode: engine === 'webcodecs' ? this.audioModeFor(info) : 'encode',
            // Known interlaced sources keep their full field rate (1080i59.94 -> 59.94p).
            deinterlace: this.isInterlaced(info) ? 'double' : 'auto'
        };
    },

    /** How to play a probed stream on this device (probe info may be null). */
    planFor(info) {
        const plan = this.planForEngine(this.getEngine(), info);
        // If the WebRTC media port turns out to be unreachable, carry on with a streaming engine.
        if (plan.engine === 'webrtc') plan.fallback = this.planForEngine(this.getEngine({ streamEngine: true }), info);
        return plan;
    },

    /** Status label for the player badge. */
    describe(engine, videoMode) {
        if (engine === 'jsmpeg') return 'Canvas (MPEG-1)';
        if (engine === 'webrtc') return videoMode === 'copy' ? 'Canvas (WebRTC)' : 'Canvas (WebRTC, Transcoding)';
        return videoMode === 'copy' ? 'Canvas' : 'Canvas (Transcoding)';
    },

    /** One-time per-device notice: this mode exists for passengers. */
    confirmPassengerUse() {
        if (this.read(this.ACK_KEY, '') === '1') return true;
        const ok = window.confirm(
            'Canvas playback keeps video running while the vehicle is moving.\n\n' +
            'It is intended for passengers only. The driver must not watch video while driving.\n\n' +
            'Continue?'
        );
        if (ok) this.write(this.ACK_KEY, '1');
        return ok;
    },

    read(key, fallback) {
        try { return localStorage.getItem(key) ?? fallback; } catch (_) { return fallback; }
    },
    write(key, value) {
        try { localStorage.setItem(key, value); } catch (_) { /* storage unavailable */ }
    },

    /** ?canvas=on|off|auto and ?canvasEngine=auto|webcodecs|jsmpeg|webrtc set this device's choices. */
    applyUrlOverride(search = window.location.search) {
        const params = new URLSearchParams(search);
        const mode = params.get('canvas');
        if (mode) this.setMode(mode === '1' ? 'on' : mode === '0' ? 'off' : mode);
        const engine = params.get('canvasEngine');
        if (engine) this.setEnginePreference(engine);
    }
};

let canvasAudioContext = null;
/** One AudioContext for every canvas player on the page, so taps that allow audio carry over. */
function sharedCanvasAudioContext() {
    if (!canvasAudioContext || canvasAudioContext.state === 'closed') {
        const Context = window.AudioContext || window.webkitAudioContext;
        canvasAudioContext = new Context({ latencyHint: 'playback' });
    }
    return canvasAudioContext;
}

const OVERRIDDEN = ['play', 'pause', 'paused', 'ended', 'currentTime', 'duration', 'volume', 'muted',
    'videoWidth', 'videoHeight', 'readyState', 'error', 'src', 'currentSrc', 'seeking'];

class CanvasVideo {
    constructor(video) {
        this.video = video;
        this.active = false;
        this.pipeline = null;
        this.canvas = null;
        this.generation = 0;
        this.volumeValue = video.volume;
        this.mutedValue = video.muted;
        this.unlockAudio = () => { if (this.active) this.pipeline?.unlockAudio(); };
        document.addEventListener('pointerdown', this.unlockAudio, true);
        document.addEventListener('keydown', this.unlockAudio, true);
        this.resetState();
    }

    resetState() {
        this.pausedValue = false;
        this.endedValue = false;
        this.seekingValue = false;
        this.errorValue = null;
        this.readyStateValue = 0;
        this.width = 0;
        this.height = 0;
        this.started = false;
        this.mediaTime = 0;         // seconds since the first presented frame
    }

    /**
     * Start playback.
     * @param {object} options
     *   url        upstream stream URL (passed to /api/canvas/stream)
     *   live       true for live channels (no seeking)
     *   seek       start offset in seconds (VOD)
     *   duration   known duration in seconds (VOD)
     *   program    MPEG-TS program number
     *   engine       'webcodecs' | 'jsmpeg' | 'webrtc' (defaults to CanvasPlayback.getEngine())
     *   videoMode    'copy' | 'encode' (WebCodecs and WebRTC engines)
     *   audioMode    'copy' | 'encode' (WebCodecs engine)
     *   fallback     plan ({ engine, videoMode, audioMode, deinterlace }) to switch to if WebRTC fails
     *   deinterlace  'auto' | 'double'
     *   height       max decoded height
     *   onError      (message) => void
     *   onModeChange ({ engine, videoMode, audioMode, deinterlace }) => void, after a fallback
     */
    start(options) {
        this.options = {
            live: false, seek: 0, videoMode: 'encode', audioMode: 'encode', deinterlace: 'auto',
            height: CanvasPlayback.getMaxHeight(), engine: CanvasPlayback.getEngine(), ...options
        };
        if (!this.active) this.attach();
        this.restart(this.options.seek || 0);
    }

    stop() {
        if (!this.active) return;
        this.teardownPipeline();
        this.detach();
    }

    // ---------- pipeline ----------

    streamUrl(seek) {
        const { url, live, engine, videoMode, audioMode, deinterlace, height, program } = this.options;
        const query = new URLSearchParams({ url, height: String(height) });
        if (engine === 'jsmpeg') query.set('codec', 'mpeg1');
        else if (engine === 'webrtc') query.set('video', videoMode);
        else { query.set('video', videoMode); query.set('audio', audioMode); }
        if (deinterlace !== 'auto') query.set('deinterlace', deinterlace);
        if (live) query.set('live', '1');
        else if (seek > 0) query.set('seek', seek.toFixed(3));
        if (program != null) query.set('program', String(program));
        if (window.PlaybackProbe) query.set('client', PlaybackProbe.clientId);
        return (engine === 'webrtc' ? '/api/canvas/webrtc/session?' : '/api/canvas/stream?') + query;
    }

    restart(seek) {
        this.teardownPipeline();
        const generation = ++this.generation;
        this.resetState();
        this.seekOffset = Math.max(0, seek);

        const canvas = this.canvas = document.createElement('canvas');
        canvas.className = 'canvas-player';
        this.video.insertAdjacentElement('afterend', canvas);

        const Pipeline = { jsmpeg: JsmpegPipeline, webrtc: WebRtcPipeline }[this.options.engine] || WebCodecsPipeline;
        this.pipeline = new Pipeline(this.hostFor(generation), canvas, this.streamUrl(this.seekOffset), sharedCanvasAudioContext());
        this.pipeline.setVolume(this.gainValue());
        this.pipeline.start();
        this.emit('loadstart');
        this.emit('waiting');
    }

    teardownPipeline() {
        this.generation++;
        this.pipeline?.destroy();
        this.pipeline = null;
        this.canvas?.remove();
        this.canvas = null;
    }

    /** Callbacks for one pipeline; anything from a replaced pipeline is ignored. */
    hostFor(generation) {
        const live = (fn) => (...args) => { if (generation === this.generation) fn.apply(this, args); };
        return {
            resize: live(this.onResize),
            started: live(this.onStarted),
            time: live(this.onTime),
            waiting: live(this.onWaiting),
            playing: live(this.onPlaying),
            ended: live(this.onEnded),
            error: live(this.onPipelineError)
        };
    }

    onResize(width, height) {
        this.width = width;
        this.height = height;
        if (this.readyStateValue < 1) {
            this.readyStateValue = 1;
            this.emit('loadedmetadata');
        } else {
            this.emit('resize');
        }
    }

    onStarted() {
        this.started = true;
        this.mediaTime = 0;
        this.readyStateValue = 4;
        this.emit('loadeddata');
        this.emit('canplay');
        if (this.seekingValue) { this.seekingValue = false; this.emit('seeked'); }
        if (!this.pausedValue) { this.emit('play'); this.emit('playing'); }
    }

    onTime(seconds) {
        this.mediaTime = seconds;
        this.emit('timeupdate');
    }

    onWaiting() {
        this.readyStateValue = 2;
        this.emit('waiting');
    }

    onPlaying() {
        this.readyStateValue = 4;
        this.emit('canplay');
        this.emit('playing');
    }

    onEnded() {
        this.endedValue = true;
        this.pausedValue = true;
        this.emit('timeupdate');
        this.emit('pause');
        this.emit('ended');
    }

    onPipelineError(code, message) {
        const options = this.options;
        const position = options.live ? 0 : this.getCurrentTime();
        const retry = (changes, reason) => {
            console.warn(`[CanvasVideo] ${reason}:`, message);
            window.PlaybackReport?.send({ kind: 'fallback', engine: options.engine, video: options.videoMode, reason: `${reason}: ${message}` });
            Object.assign(options, changes);
            options.onModeChange?.({ engine: options.engine, videoMode: options.videoMode, audioMode: options.audioMode, deinterlace: options.deinterlace });
            this.restart(position);
        };

        if (options.engine === 'webrtc') {
            // Copied H.264 that never showed up (B-frames): let the server encode it.
            if (code === 'decode' && options.videoMode === 'copy') return retry({ videoMode: 'encode' }, 'WebRTC copy produced no video, re-encoding');
            // Media port unreachable, MediaMTX missing, ...: stream over HTTP instead.
            if (options.fallback?.engine) return retry({ ...options.fallback, fallback: null }, 'WebRTC unavailable, switching engines');
        }
        if (code === 'unsupported-audio') {
            // Copied AAC the browser cannot decode (e.g. HE-AAC variants): re-encode it.
            if (options.audioMode === 'copy') return retry({ audioMode: 'encode' }, 'Copied audio failed, re-encoding');
            console.warn('[CanvasVideo] Playing without sound:', message);
            return;
        }
        if (options.engine === 'webcodecs') {
            // Interlaced H.264: deinterlace on the server, one frame per field.
            if (code === 'interlaced') return retry({ videoMode: 'encode', deinterlace: 'double' }, 'Interlaced source, deinterlacing');
            if (['unsupported-video', 'decode'].includes(code)) {
                // Copied H.264 the browser cannot decode (10-bit, 4:2:2, odd levels): re-encode it.
                if (options.videoMode === 'copy') return retry({ videoMode: 'encode' }, 'Copy mode failed, re-encoding');
                // No usable H.264 decoder at all (e.g. Chromium builds without proprietary codecs).
                if (window.JsmpegPipeline?.isSupported()) return retry({ engine: 'jsmpeg' }, 'WebCodecs cannot decode H.264 here, switching to JSMpeg');
            }
        }
        this.fail(message);
    }

    fail(message) {
        console.error('[CanvasVideo]', message);
        window.PlaybackReport?.send({ kind: 'error', engine: this.options?.engine, video: this.options?.videoMode, reason: message });
        this.teardownPipeline();
        this.errorValue = { code: 4, message };
        this.emit('error');
        this.options?.onError?.(message);
    }

    // ---------- media element surface ----------

    play() {
        if (!this.active) return Promise.resolve();
        if (this.endedValue && !this.options.live) {
            this.restart(0);
            return Promise.resolve();
        }
        if (!this.pausedValue) return Promise.resolve();
        if (this.pipeline?.restartOnResume) {
            // The pipeline let its server session go while paused: pick up where it stopped.
            this.restart(this.getCurrentTime());
            this.emit('play');
            return Promise.resolve();
        }
        this.pausedValue = false;
        this.pipeline?.resume();
        this.emit('play');
        if (this.readyStateValue >= 3) this.emit('playing');
        return Promise.resolve();
    }

    pause() {
        if (!this.active || this.pausedValue) return;
        this.pausedValue = true;
        this.pipeline?.pause();
        this.emit('pause');
    }

    getCurrentTime() {
        return Math.max(0, (this.seekOffset || 0) + (this.started ? this.mediaTime : 0));
    }

    seek(seconds) {
        if (!this.active || this.options.live || !Number.isFinite(seconds)) return;
        const wasPaused = this.pausedValue && !this.endedValue;
        this.restart(seconds);
        this.seekingValue = true;
        this.emit('seeking');
        this.emit('timeupdate');
        if (wasPaused) this.emit('play');
    }

    getDuration() {
        const duration = Number(this.options?.duration);
        if (duration > 0) return duration;
        return this.options?.live ? Infinity : NaN;
    }

    gainValue() {
        return this.mutedValue ? 0 : this.volumeValue;
    }

    setVolume(value) {
        const volume = Math.min(1, Math.max(0, Number(value) || 0));
        if (volume === this.volumeValue) return;
        this.volumeValue = volume;
        this.pipeline?.setVolume(this.gainValue());
        this.emit('volumechange');
    }

    setMuted(muted) {
        if (!!muted === this.mutedValue) return;
        this.mutedValue = !!muted;
        this.pipeline?.setVolume(this.gainValue());
        this.emit('volumechange');
    }

    attach() {
        const self = this, video = this.video;
        this.volumeValue = video.volume;
        this.mutedValue = video.muted;
        const define = (name, descriptor) => Object.defineProperty(video, name, { configurable: true, ...descriptor });
        define('play', { value: () => self.play(), writable: true });
        define('pause', { value: () => self.pause(), writable: true });
        define('paused', { get: () => self.pausedValue });
        define('ended', { get: () => self.endedValue });
        define('seeking', { get: () => self.seekingValue });
        define('currentTime', { get: () => self.getCurrentTime(), set: (value) => self.seek(Number(value)) });
        define('duration', { get: () => self.getDuration() });
        define('volume', { get: () => self.volumeValue, set: (value) => self.setVolume(value) });
        define('muted', { get: () => self.mutedValue, set: (value) => self.setMuted(value) });
        define('videoWidth', { get: () => self.width });
        define('videoHeight', { get: () => self.height });
        define('readyState', { get: () => self.readyStateValue });
        define('error', { get: () => self.errorValue });
        define('src', {
            get: () => self.options?.url || '',
            // Any page code that loads a new source takes the element back first.
            set: (value) => { self.stop(); video.src = value; }
        });
        define('currentSrc', { get: () => self.options?.url || '' });
        video.classList.add('canvas-player-host');
        this.active = true;
    }

    detach() {
        if (!this.active) return;
        this.active = false;
        const video = this.video;
        for (const name of OVERRIDDEN) delete video[name];
        video.classList.remove('canvas-player-host');
        // Hand the volume state back to the real element.
        video.volume = this.volumeValue;
        video.muted = this.mutedValue;
        this.resetState();
    }

    /** Media events fire asynchronously, like the element's own; stale ones from a replaced pipeline are dropped. */
    emit(type) {
        const video = this.video, generation = this.generation;
        setTimeout(() => {
            if (generation === this.generation) video.dispatchEvent(new Event(type));
        }, 0);
    }
}

CanvasPlayback.applyUrlOverride();
window.CanvasPlayback = CanvasPlayback;
window.CanvasVideo = CanvasVideo;
