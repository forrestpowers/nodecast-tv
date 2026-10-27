/**
 * WebCodecs engine for CanvasVideo.
 *
 * H.264 + AAC MPEG-TS -> canvas-worker.js (demux, VideoDecoder -> OffscreenCanvas, AudioDecoder)
 * -> PCM scheduled here through Web Audio. Audio output is the master clock: its position is
 * reported to the worker, which presents video frames against it.
 *
 * Host callbacks: tracks, resize, started, time, waiting, playing, ended, error(code, message)
 */

const WEBCODECS_AUDIO_START_LEAD = 0.12;   // seconds of audio scheduled before the first frame is due
const WEBCODECS_AUDIO_JOIN_TOLERANCE = 0.002;
const WEBCODECS_CLOCK_INTERVAL_MS = 200;

class WebCodecsPipeline {
    static isSupported() {
        return typeof Worker === 'function'
            && typeof VideoDecoder === 'function'
            && typeof AudioDecoder === 'function'
            && typeof HTMLCanvasElement !== 'undefined'
            && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function';
    }

    constructor(host, canvas, url, audioContext) {
        this.host = host;
        this.canvas = canvas;
        this.url = url;
        this.ctx = audioContext;
        this.gain = audioContext.createGain();
        this.gain.connect(audioContext.destination);
        this.paused = false;
        this.waiting = false;
        this.hasAudio = false;
        this.startUs = null;
        this.audioMap = null;       // { ctxTime, mediaUs } anchor between AudioContext time and media time
        this.pendingAudio = [];
        this.nextAudioTime = 0;
        this.sources = new Set();
    }

    start() {
        const offscreen = this.canvas.transferControlToOffscreen();
        const worker = this.worker = new Worker('/js/canvas/canvas-worker.js?v=2');
        worker.onmessage = (event) => this.onMessage(event.data);
        worker.onerror = (event) => this.host.error('worker', event.message || 'Canvas worker failed');
        worker.postMessage({ t: 'init', canvas: offscreen }, [offscreen]);
        worker.postMessage({ t: 'play', url: this.url });
        this.clockTimer = setInterval(() => this.sendClock(), WEBCODECS_CLOCK_INTERVAL_MS);
        this.ctx.resume().catch(() => {});
    }

    onMessage(msg) {
        switch (msg.t) {
            case 'tracks':
                this.hasAudio = msg.audio;
                if (msg.audioError) this.host.error('unsupported-audio', msg.audioError);
                break;
            case 'resize':
                this.host.resize(msg.width, msg.height);
                break;
            case 'started':
                this.startUs = msg.mediaUs;
                this.startAudioClock(msg.mediaUs);
                this.host.started();
                break;
            case 'time':
                if (this.startUs !== null) this.host.time((msg.mediaUs - this.startUs) / 1e6);
                break;
            case 'waiting':
                this.waiting = true;
                if (!this.paused) this.ctx.suspend().catch(() => {});
                this.host.waiting();
                break;
            case 'playing':
                this.waiting = false;
                if (!this.paused) this.ctx.resume().catch(() => {});
                this.host.playing();
                break;
            case 'audio':
                if (this.audioMap) this.scheduleAudio(msg);
                else if (this.pendingAudio.push(msg) > 400) this.pendingAudio.shift();
                break;
            case 'ended':
                this.host.ended();
                break;
            case 'error':
                this.host.error(msg.code, msg.message);
                break;
        }
    }

    startAudioClock(firstUs) {
        this.audioMap = { ctxTime: this.ctx.currentTime + WEBCODECS_AUDIO_START_LEAD, mediaUs: firstUs };
        this.nextAudioTime = 0;
        const queued = this.pendingAudio;
        this.pendingAudio = [];
        for (const chunk of queued) this.scheduleAudio(chunk);
        this.sendClock();
    }

    scheduleAudio({ mediaUs, sampleRate, channels }) {
        const ctx = this.ctx;
        const frames = channels[0]?.length || 0;
        if (!frames) return;
        const duration = frames / sampleRate;
        let when = this.audioMap.ctxTime + (mediaUs - this.audioMap.mediaUs) / 1e6;
        // Keep consecutive chunks sample-contiguous instead of re-rounding every start time.
        if (Math.abs(when - this.nextAudioTime) < WEBCODECS_AUDIO_JOIN_TOLERANCE) when = this.nextAudioTime;
        const now = ctx.currentTime;
        if (when + duration <= now) return; // too late to be heard

        const buffer = ctx.createBuffer(channels.length, frames, sampleRate);
        channels.forEach((data, index) => buffer.copyToChannel(data, index));
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gain);
        source.onended = () => this.sources.delete(source);
        this.sources.add(source);
        if (when >= now) source.start(when);
        else source.start(now, now - when);
        this.nextAudioTime = when + duration;
    }

    /** Tell the worker which media time is leaving the speakers right now. */
    sendClock() {
        const ctx = this.ctx;
        if (!this.worker || !this.audioMap || !this.hasAudio || ctx.state !== 'running') return;
        const stamp = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
        const contextTime = stamp?.contextTime || ctx.currentTime;
        const performanceTime = stamp?.performanceTime || performance.now();
        if (!(performanceTime > 0)) return;
        const mediaUs = this.audioMap.mediaUs + (contextTime - this.audioMap.ctxTime) * 1e6;
        this.worker.postMessage({ t: 'clock', mediaUs, at: performance.timeOrigin + performanceTime });
    }

    pause() {
        this.paused = true;
        this.worker?.postMessage({ t: 'pause' });
        this.ctx.suspend().catch(() => {});
    }

    resume() {
        this.paused = false;
        this.worker?.postMessage({ t: 'resume' });
        if (!this.waiting) this.ctx.resume().catch(() => {});
    }

    setVolume(gain) {
        this.gain.gain.value = gain;
    }

    /** Autoplay policies may start the context suspended; a tap resumes it. */
    unlockAudio() {
        if (!this.paused && !this.waiting) this.ctx.resume().catch(() => {});
    }

    destroy() {
        clearInterval(this.clockTimer);
        if (this.worker) {
            this.worker.postMessage({ t: 'stop' });
            this.worker.terminate();
            this.worker = null;
        }
        for (const source of this.sources) {
            try { source.stop(); } catch (_) {}
            source.disconnect();
        }
        this.sources.clear();
        this.pendingAudio = [];
        this.gain.disconnect();
    }
}

window.WebCodecsPipeline = WebCodecsPipeline;
