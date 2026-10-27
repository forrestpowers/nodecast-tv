/**
 * JSMpeg engine for CanvasVideo (browsers without WebCodecs, e.g. the Tesla browser).
 *
 * MPEG-1 + MP2 MPEG-TS -> JSMpeg (WebAssembly decoders, WebGL renderer, Web Audio output).
 * JSMpeg syncs video to the audio it plays, so picture and sound come from one stream and
 * stay together. JsmpegFetchSource paces how much of the HTTP stream is handed to JSMpeg;
 * whatever it holds back applies TCP backpressure to ffmpeg on the server.
 *
 * Host callbacks: resize, started, time, waiting, playing, ended, error(code, message)
 */

const JSMPEG_SCRIPT = '/js/vendor/jsmpeg/jsmpeg.min.js?v=924acfb';
const JSMPEG_TARGET_HEADROOM = 2.5;             // seconds demuxed ahead of the playhead
const JSMPEG_START_HEADROOM = 0.8;              // seconds needed before playback starts
const JSMPEG_MAX_QUEUED_BYTES = 4 * 1024 * 1024; // network data held before reading pauses
const JSMPEG_STALL_GRACE_MS = 400;
const JSMPEG_PUMP_INTERVAL_MS = 10;

let jsmpegLoading = null;
function loadJsmpeg() {
    if (window.JSMpeg) return Promise.resolve();
    return jsmpegLoading ||= new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = JSMPEG_SCRIPT;
        script.onload = () => resolve();
        script.onerror = () => { jsmpegLoading = null; reject(new Error('Could not load the JSMpeg decoder')); };
        document.head.appendChild(script);
    });
}

/** JSMpeg source (connect/start/resume/destroy + established/completed/progress). */
class JsmpegFetchSource {
    constructor(url, options) {
        this.url = url;
        this.pipeline = options.pipeline;
        // Report a streaming source so JSMpeg sizes its decoder buffers as fixed rings instead of
        // keeping the whole stream in memory. JsmpegPipeline then switches the player to its
        // static-file update loop, which syncs video to audio and calls resume() every frame.
        this.streaming = true;
        this.established = false;
        this.completed = false;
        this.progress = 0;
        this.destination = null;
        this.queue = [];
        this.queuedBytes = 0;
        this.done = false;
        this.baseTime = null;   // first PTS handed to the demuxer
        this.abort = new AbortController();
        this.wake = null;
    }

    connect(destination) {
        this.destination = destination;
    }

    start() {
        this.read().catch((error) => {
            if (error.name !== 'AbortError') this.pipeline.sourceError('network', error.message || 'Stream error');
        });
    }

    async read() {
        const response = await fetch(this.url, { signal: this.abort.signal, cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) {
            let detail = '';
            try { detail = (await response.json()).error || ''; } catch (_) {}
            this.pipeline.sourceError('http', `HTTP ${response.status}${detail ? ': ' + detail : ''}`);
            return;
        }
        const reader = response.body.getReader();
        for (;;) {
            while (this.queuedBytes > JSMPEG_MAX_QUEUED_BYTES && !this.abort.signal.aborted) {
                await new Promise((resolve) => { this.wake = resolve; setTimeout(resolve, 100); });
                this.wake = null;
            }
            const { value, done } = await reader.read();
            if (done || this.abort.signal.aborted) break;
            this.queue.push(value);
            this.queuedBytes += value.byteLength;
            this.feed();
        }
        this.done = true;
        this.feed();
    }

    /** Called by the player every frame. Its headroom argument mixes time bases, so measure our own. */
    resume() {
        this.feed();
    }

    headroom() {
        const fed = this.baseTime === null ? 0 : this.destination.currentTime - this.baseTime;
        const player = this.pipeline.player;
        return fed - (player ? player.currentTime : 0);
    }

    feed() {
        if (this.abort.signal.aborted || !this.destination) return;
        while (this.queue.length && this.headroom() < JSMPEG_TARGET_HEADROOM) {
            const chunk = this.queue.shift();
            this.queuedBytes -= chunk.byteLength;
            this.destination.write(chunk);
            if (this.baseTime === null && this.destination.currentTime > 0) this.baseTime = this.destination.currentTime;
        }
        if (!this.established && (this.headroom() >= JSMPEG_START_HEADROOM || this.done)) {
            this.established = true;
            this.progress = 1;
        }
        if (this.done && !this.queue.length) this.completed = true;
        this.wake?.();
    }

    destroy() {
        this.abort.abort();
        this.queue = [];
        this.queuedBytes = 0;
        this.wake?.();
    }
}

class JsmpegPipeline {
    static isSupported() {
        return typeof WebAssembly === 'object'
            && typeof ReadableStream === 'function'
            && typeof Response === 'function' && 'body' in Response.prototype;
    }

    constructor(host, canvas, url, audioContext) {
        this.host = host;
        this.canvas = canvas;
        this.url = url;
        this.ctx = audioContext;
        this.player = null;
        this.volume = 1;
        this.paused = false;
        this.started = false;
        this.waiting = false;
        this.destroyed = false;
        this.lastDecode = 0;
        this.width = 0;
        this.height = 0;
    }

    start() {
        loadJsmpeg()
            .then(() => { if (!this.destroyed) this.createPlayer(); })
            .catch((error) => this.sourceError('load', error.message));
    }

    createPlayer() {
        // Share the page's AudioContext (already allowed to play by earlier taps). Pin it with an
        // extra connection so destroying a JSMpeg player never closes it.
        if (!this.ctx.nodecastPinned) {
            this.ctx._connections = (this.ctx._connections || 0) + 1;
            this.ctx.nodecastPinned = true;
        }
        JSMpeg.AudioOutput.WebAudio.CachedContext = this.ctx;
        this.ctx.resume().catch(() => {});

        const player = new JSMpeg.Player(this.url, {
            canvas: this.canvas,
            source: JsmpegFetchSource,
            pipeline: this,
            autoplay: true,
            loop: false,
            pauseWhenHidden: false,
            decodeFirstFrame: false,
            videoBufferSize: 6 * 1024 * 1024,
            audioBufferSize: 1024 * 1024,
            onVideoDecode: () => this.onVideoDecode(),
            onStalled: () => this.onStalled(),
            onEnded: () => this.host.ended()
        });
        player.options.streaming = false; // see JsmpegFetchSource
        player.volume = this.volume;
        this.player = player;
        if (this.paused) player.pause();
        this.timeTimer = setInterval(() => this.tick(), 250);
        this.pumpTimer = setInterval(() => this.pump(), JSMPEG_PUMP_INTERVAL_MS);
    }

    /**
     * JSMpeg advances only from requestAnimationFrame, and each call refills at most 0.25s of
     * audio and one video frame. When rAF is throttled (hidden panes, and apparently the Tesla
     * browser in Drive) audio starves and playback slows down. Run the same sync step from a
     * timer as well; extra calls only decode what is due.
     */
    pump() {
        const player = this.player;
        if (!player || player.paused || !player.isPlaying || !player.source.established) return;
        player.updateForStaticFile();
    }

    onVideoDecode() {
        const { width, height } = this.canvas;
        if (width !== this.width || height !== this.height) {
            this.width = width;
            this.height = height;
            this.host.resize(width, height);
        }
        this.lastDecode = performance.now();
        if (!this.started) {
            this.started = true;
            this.host.started();
        } else if (this.waiting) {
            this.waiting = false;
            this.host.playing();
        }
    }

    onStalled() {
        if (!this.started || this.waiting || this.paused) return;
        if (performance.now() - this.lastDecode > JSMPEG_STALL_GRACE_MS) {
            this.waiting = true;
            this.host.waiting();
        }
    }

    tick() {
        if (this.started && this.player && !this.paused) this.host.time(Math.max(0, this.player.currentTime));
    }

    sourceError(code, message) {
        if (!this.destroyed) this.host.error(code, message);
    }

    pause() {
        this.paused = true;
        this.player?.pause();
    }

    resume() {
        this.paused = false;
        this.lastDecode = performance.now();
        this.player?.play();
    }

    setVolume(gain) {
        this.volume = gain;
        if (this.player) this.player.volume = gain;
    }

    unlockAudio() {
        if (!this.paused) this.ctx.resume().catch(() => {});
    }

    destroy() {
        this.destroyed = true;
        clearInterval(this.timeTimer);
        clearInterval(this.pumpTimer);
        this.player?.destroy();
        this.player = null;
    }
}

window.JsmpegPipeline = JsmpegPipeline;
