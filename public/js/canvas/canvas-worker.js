/**
 * Canvas playback worker
 *
 * fetch(MPEG-TS) -> TsDemuxer -> H.264 VideoDecoder -> OffscreenCanvas
 *                             -> AAC AudioDecoder   -> PCM posted to the page (Web Audio)
 *
 * The page owns the audio clock and sends `clock` messages; video frames are presented
 * against it with setTimeout pacing (rAF is unreliable in workers and in throttled tabs).
 *
 * Messages in:  init {canvas} | play {url} | stop | pause | resume | clock {mediaUs, at}
 * Messages out: tracks | resize | started | time | waiting | playing | audio | ended | error | stats
 */
'use strict';
importScripts('/js/canvas/ts-demuxer.js?v=2');

const MAX_DECODED_FRAMES = 8;      // decoded VideoFrames held for presentation
const MAX_DECODE_QUEUE = 6;        // chunks in flight inside the VideoDecoder
const MAX_BUFFER_AHEAD_US = 6e6;   // stop reading the network when this far ahead of the clock
const START_BUFFER_US = 500e3;     // decoded/demuxed video required before starting or resuming
const STALL_GRACE_US = 400e3;      // how far the clock may pass the last frame before buffering
const LATE_DROP_US = 50e3;         // a frame this late is dropped unless it is the only one

let canvas = null, ctx2d = null;
let session = null;

self.onmessage = (event) => {
    const msg = event.data;
    switch (msg.t) {
        case 'init':
            canvas = msg.canvas;
            ctx2d = canvas.getContext('2d', { alpha: false });
            break;
        case 'play': startSession(msg.url); break;
        case 'stop': stopSession(); break;
        case 'pause': session?.setPaused(true); break;
        case 'resume': session?.setPaused(false); break;
        case 'clock': session?.syncClock(msg.mediaUs, msg.at - performance.timeOrigin); break;
    }
};

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

function startSession(url) {
    stopSession();
    session = new Session(url);
    session.run();
}

function stopSession() {
    if (!session) return;
    session.close();
    session = null;
}

class Session {
    constructor(url) {
        this.url = url;
        this.abort = new AbortController();
        this.closed = false;
        this.demuxer = new TsDemuxer({
            onTracks: (tracks) => this.onTracks(tracks),
            onVideo: (au) => this.onVideoAccessUnit(au),
            onAudio: (frame) => this.onAudioFrame(frame)
        });

        this.baseUs = null;          // stream PTS mapped to media time 0
        this.lastDemuxedUs = 0;      // newest video media time seen in the stream

        this.video = { decoder: null, pending: [], frames: [], configured: false, codec: null, failed: false };
        this.audio = { decoder: null, configured: false, enabled: false, failed: false };

        // Clock: media time advances from an anchor while running.
        this.clockAnchorUs = 0;
        this.clockAnchorPerf = 0;
        this.started = false;
        this.paused = false;
        this.buffering = false;
        this.ended = false;
        this.streamDone = false;
        this.drained = false;
        this.lastPresentedUs = -1;
        this.lastTimePost = 0;
        this.dropped = 0;
        this.presentTimer = null;
        this.wake = null;            // resolves when the reader may continue
    }

    // ---------- network ----------

    async run() {
        try {
            const response = await fetch(this.url, { signal: this.abort.signal, cache: 'no-store', credentials: 'same-origin' });
            if (!response.ok) {
                let detail = '';
                try { detail = (await response.json()).error || ''; } catch (_) {}
                return this.fail('http', `HTTP ${response.status}${detail ? ': ' + detail : ''}`);
            }
            const reader = response.body.getReader();
            this.reader = reader;
            for (;;) {
                await this.waitForRoom();
                if (this.closed) return;
                const { value, done } = await reader.read();
                if (this.closed) return;
                if (done) break;
                this.demuxer.push(value);
                this.pumpVideo();
            }
            this.demuxer.flush();
            this.streamDone = true;
            await this.drainDecoders();
            this.drained = true;
            this.schedulePresent(0);
        } catch (error) {
            if (this.closed || error.name === 'AbortError') return;
            this.fail('network', error.message || 'Stream error');
        }
    }

    /** Network backpressure: TCP flow control makes ffmpeg wait while we are far enough ahead. */
    async waitForRoom() {
        while (!this.closed && this.isFull()) {
            await new Promise((resolve) => { this.wake = resolve; setTimeout(resolve, 100); });
            this.wake = null;
        }
    }

    isFull() {
        if (this.video.pending.length > 600) return true;
        if (!this.started) return false;
        return this.lastDemuxedUs - this.nowUs() > MAX_BUFFER_AHEAD_US;
    }

    // ---------- demux callbacks ----------

    onTracks({ video, audio }) {
        this.audio.enabled = !!audio;
        post({ t: 'tracks', video: !!video, audio: !!audio });
    }

    toMediaUs(ptsUs) {
        if (this.baseUs === null) this.baseUs = ptsUs;
        return ptsUs - this.baseUs;
    }

    onVideoAccessUnit(au) {
        if (this.video.failed) return;
        if (!this.video.configured) {
            // Decoding has to begin at an IDR frame that carries its SPS.
            if (!au.key || !au.sps) return;
            this.configureVideo(au.sps);
        }
        const ts = this.toMediaUs(au.ptsUs);
        if (ts > this.lastDemuxedUs) this.lastDemuxedUs = ts;
        this.video.pending.push(new EncodedVideoChunk({ type: au.key ? 'key' : 'delta', timestamp: ts, data: au.data }));
    }

    onAudioFrame(frame) {
        if (!this.audio.enabled || this.audio.failed) return;
        if (!this.audio.configured) this.configureAudio(frame);
        if (!this.audio.decoder || this.audio.decoder.state !== 'configured') return;
        const ts = this.toMediaUs(frame.ptsUs);
        if (ts < 0) return;
        this.audio.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, data: frame.data }));
    }

    // ---------- video ----------

    configureVideo(sps) {
        const codec = 'avc1.' + [sps[1], sps[2], sps[3]].map((b) => b.toString(16).padStart(2, '0')).join('');
        const config = { codec, optimizeForLatency: true };
        this.video.configured = true;
        this.video.codec = codec;
        // Browser decoders reject field/MBAFF pictures; say so up front instead of failing mid-decode.
        let info = null;
        try { info = parseSps(sps); } catch (_) { /* unreadable SPS: let the decoder decide */ }
        if (info && !info.frameMbsOnly) return this.fail('interlaced', `Interlaced H.264 (${codec})`, { codec });
        this.video.decoder = new VideoDecoder({
            output: (frame) => this.onDecodedFrame(frame),
            error: (error) => this.fail('decode', `Video decoder: ${error.message}`, { codec })
        });
        VideoDecoder.isConfigSupported(config).then((support) => {
            if (this.closed) return;
            if (!support.supported) return this.fail('unsupported-video', `This browser cannot decode ${codec}`, { codec });
            this.video.decoder.configure(config);
            this.pumpVideo();
        }).catch((error) => this.fail('unsupported-video', error.message, { codec }));
    }

    pumpVideo() {
        const { decoder, pending, frames } = this.video;
        if (!decoder || decoder.state !== 'configured') return;
        while (pending.length && decoder.decodeQueueSize < MAX_DECODE_QUEUE && frames.length < MAX_DECODED_FRAMES) {
            decoder.decode(pending.shift());
        }
    }

    onDecodedFrame(frame) {
        if (this.closed) { frame.close(); return; }
        // Frames arrive in presentation order; anything before media time 0 belongs to the
        // pre-roll of a seek and is never shown.
        if (frame.timestamp < 0 && this.started) { frame.close(); return; }
        this.video.frames.push(frame);
        if (!this.started) this.maybeStart();
        else if (this.buffering) this.maybeResume();
        this.schedulePresent(0);
    }

    bufferedUs() {
        const { frames } = this.video;
        const decodedTip = frames.length ? frames[frames.length - 1].timestamp : this.lastPresentedUs;
        return Math.max(decodedTip, this.lastDemuxedUs) - this.nowUs();
    }

    maybeStart() {
        const { frames } = this.video;
        if (!frames.length) return;
        const first = frames[0].timestamp;
        const ahead = Math.max(frames[frames.length - 1].timestamp, this.lastDemuxedUs) - first;
        if (ahead < START_BUFFER_US && !this.streamDone && frames.length < MAX_DECODED_FRAMES) return;
        this.started = true;
        this.setClock(first);
        this.drawFrame(frames[0]);
        post({ t: 'resize', width: canvas.width, height: canvas.height, codec: this.video.codec });
        post({ t: 'started', mediaUs: first });
    }

    maybeResume() {
        if (this.bufferedUs() < START_BUFFER_US && !this.streamDone && this.video.frames.length < MAX_DECODED_FRAMES) return;
        this.buffering = false;
        this.setClock(this.lastPresentedUs >= 0 ? this.lastPresentedUs : this.nowUs());
        post({ t: 'playing', mediaUs: this.nowUs() });
    }

    async drainDecoders() {
        try {
            while (this.video.pending.length && !this.closed) {
                this.pumpVideo();
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            if (this.video.decoder?.state === 'configured') await this.video.decoder.flush();
            if (this.audio.decoder?.state === 'configured') await this.audio.decoder.flush();
        } catch (_) { /* closed during flush */ }
        if (!this.started && this.video.frames.length) this.maybeStart();
    }

    // ---------- presentation ----------

    nowUs() {
        if (!this.started) return 0;
        if (this.paused || this.buffering) return this.clockAnchorUs;
        return this.clockAnchorUs + (performance.now() - this.clockAnchorPerf) * 1000;
    }

    setClock(mediaUs) {
        this.clockAnchorUs = mediaUs;
        this.clockAnchorPerf = performance.now();
    }

    /** The page reports where its audio output actually is; follow it while playing. */
    syncClock(mediaUs, perf) {
        if (!this.started || this.paused || this.buffering) return;
        this.clockAnchorUs = mediaUs;
        this.clockAnchorPerf = perf;
    }

    setPaused(paused) {
        if (this.paused === paused) return;
        if (paused) this.clockAnchorUs = this.nowUs();
        this.paused = paused;
        if (!paused) this.clockAnchorPerf = performance.now();
        this.schedulePresent(0);
    }

    schedulePresent(delayMs) {
        if (this.closed || this.presentTimer !== null) return;
        this.presentTimer = setTimeout(() => { this.presentTimer = null; this.present(); }, delayMs);
    }

    present() {
        if (this.closed) return;
        const { frames } = this.video;
        if (!this.started) { this.pumpVideo(); return; }
        if (this.paused) { this.pumpVideo(); return; }

        const now = this.nowUs();
        // Skip frames whose successor is already due, so a slow decoder catches up.
        while (frames.length > 1 && frames[1].timestamp <= now - LATE_DROP_US) {
            frames.shift().close();
            this.dropped++;
        }
        if (frames.length && frames[0].timestamp <= now) {
            this.drawFrame(frames.shift());
        }
        this.pumpVideo();
        this.wake?.();

        if (performance.now() - this.lastTimePost > 250) {
            this.lastTimePost = performance.now();
            post({ t: 'time', mediaUs: now, buffered: Math.max(0, this.bufferedUs()), dropped: this.dropped });
        }

        if (!frames.length) {
            if (this.drained) {
                if (!this.ended) { this.ended = true; post({ t: 'ended' }); }
                return;
            }
            if (!this.buffering && !this.streamDone && now - this.lastPresentedUs > STALL_GRACE_US) {
                this.clockAnchorUs = now;
                this.buffering = true;
                post({ t: 'waiting' });
            }
            this.schedulePresent(15);
            return;
        }
        const wait = (frames[0].timestamp - now) / 1000;
        this.schedulePresent(Math.max(1, Math.min(wait, 30)));
    }

    drawFrame(frame) {
        const width = frame.displayWidth, height = frame.displayHeight;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
            if (this.started) post({ t: 'resize', width, height, codec: this.video.codec });
        }
        try { ctx2d.drawImage(frame, 0, 0, width, height); } catch (_) { /* one bad frame must not stop playback */ }
        this.lastPresentedUs = frame.timestamp;
        frame.close();
    }

    // ---------- audio ----------

    configureAudio(frame) {
        this.audio.configured = true;
        const config = {
            codec: 'mp4a.40.' + frame.objectType,
            sampleRate: frame.sampleRate,
            numberOfChannels: frame.channels,
            description: frame.audioSpecificConfig
        };
        const decoder = this.audio.decoder = new AudioDecoder({
            output: (data) => this.onDecodedAudio(data),
            error: (error) => this.disableAudio(`Audio decoder: ${error.message}`)
        });
        AudioDecoder.isConfigSupported(config).then((support) => {
            if (this.closed) return;
            if (!support.supported) return this.disableAudio(`This browser cannot decode ${config.codec}`);
            decoder.configure(config);
        }).catch((error) => this.disableAudio(error.message));
    }

    disableAudio(message) {
        if (this.audio.failed) return;
        this.audio.failed = true;
        this.audio.enabled = false;
        try { this.audio.decoder?.close(); } catch (_) {}
        post({ t: 'tracks', video: true, audio: false, audioError: message });
    }

    onDecodedAudio(data) {
        if (this.closed) { data.close(); return; }
        const channels = [];
        const transfer = [];
        for (let c = 0; c < data.numberOfChannels; c++) {
            const plane = new Float32Array(data.numberOfFrames);
            data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
            channels.push(plane);
            transfer.push(plane.buffer);
        }
        post({ t: 'audio', mediaUs: data.timestamp, sampleRate: data.sampleRate, channels }, transfer);
        data.close();
    }

    // ---------- teardown ----------

    fail(code, message, extra = {}) {
        if (this.closed) return;
        post({ t: 'error', code, message, ...extra });
        this.close();
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.abort.abort();
        try { this.reader?.cancel(); } catch (_) {}
        clearTimeout(this.presentTimer);
        for (const frame of this.video.frames) frame.close();
        this.video.frames = [];
        this.video.pending = [];
        for (const decoder of [this.video.decoder, this.audio.decoder]) {
            try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch (_) {}
        }
        this.wake?.();
    }
}
