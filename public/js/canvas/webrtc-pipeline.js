/**
 * WebRTC engine for CanvasVideo ("Enhanced").
 *
 * /api/canvas/webrtc/session starts the server side (ffmpeg -> MediaMTX) and stays open as a
 * Server-Sent Events stream for the session's lifetime. Once it reports ready, the page sends a
 * WHEP offer, receives H.264 + Opus over WebRTC and pulls decoded video frames off the track with
 * MediaStreamTrackProcessor. webrtc-render-worker.js draws them on the canvas (as an
 * OffscreenCanvas) once per display refresh, off the main thread; browsers that can't transfer
 * the canvas draw here instead. Sound plays through an <audio> element, which browsers that
 * suspend <video> leave running. WebRTC's own jitter buffer keeps the two in sync.
 *
 * Host callbacks: resize, started, time, waiting, playing, ended, error(code, message)
 */

const WEBRTC_ICE_GATHER_MS = 3000;
const WEBRTC_CONNECT_MS = 8000;
const WEBRTC_FIRST_FRAME_MS = 12000;
const WEBRTC_STALL_MS = 1500;
const WEBRTC_TIME_INTERVAL_MS = 250;

class WebRtcPipeline {
    static isSupported() {
        return typeof RTCPeerConnection === 'function'
            && typeof MediaStreamTrackProcessor === 'function'
            && typeof ReadableStream === 'function';
    }

    constructor(host, canvas, url) {
        this.host = host;
        this.canvas = canvas;
        this.url = url;
        this.live = new URL(url, window.location.href).searchParams.get('live') === '1';
        this.restartOnResume = false;
        this.ctx = null;            // main-thread drawing only; the worker path transfers the canvas instead
        this.renderWorker = null;
        this.renderStats = { drawn: 0, superseded: 0, maxGapMs: 0 };
        this.paused = false;
        this.destroyed = false;
        this.serverEnded = false;
        this.started = false;
        this.waiting = false;
        this.firstTimestamp = null;
        this.readyAt = 0;
        this.joinOffset = 0;        // seconds of the stream published before our first frame
        this.lastFrameAt = 0;
        this.lastTimeAt = 0;
        this.volume = 1;
        const audio = this.audio = document.createElement('audio');
        audio.autoplay = true;
        audio.style.display = 'none';
        canvas.insertAdjacentElement('afterend', audio);
    }

    start() {
        this.abort = new AbortController();
        this.watchdog = setInterval(() => this.checkProgress(), 500);
        this.openSession().catch((error) => {
            if (error.name !== 'AbortError') this.fail(error.code || 'webrtc-session', error.message);
        });
    }

    /** Read the session's event stream until it closes. */
    async openSession() {
        const res = await fetch(this.url, { signal: this.abort.signal, cache: 'no-store' });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw Object.assign(new Error(body.error || `Session request failed (${res.status})`), { code: body.code || 'webrtc-session' });
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
                const block = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                for (const line of block.split('\n')) {
                    if (line.startsWith('data:')) this.onEvent(JSON.parse(line.slice(5)));
                }
            }
        }
        if (!this.serverEnded) this.fail('webrtc-session', 'Stream session closed');
    }

    onEvent(event) {
        if (this.destroyed) return;
        if (event.type === 'ready') {
            this.readyAt = performance.now();
            this.connect(event.id).catch((error) => {
                if (error.name !== 'AbortError') this.fail('webrtc-connect', error.message);
            });
        } else if (event.type === 'ended') {
            this.serverEnded = true;
        } else if (event.type === 'error') {
            this.fail('webrtc-stream', event.message);
        }
    }

    async connect(id) {
        const pc = this.pc = new RTCPeerConnection({ iceServers: [] });
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
        pc.ontrack = (event) => {
            if (event.track.kind === 'video') this.readVideo(event.track);
            else if (event.track.kind === 'audio') this.playAudio(event.track);
        };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed') this.fail('webrtc-connect', 'Could not reach the WebRTC media port');
            if (pc.connectionState === 'connected' && !this.firstFrameTimer) {
                // Connected but silent usually means the copied video had B-frames, which WebRTC cannot carry.
                this.firstFrameTimer = setTimeout(() => {
                    if (!this.started) this.fail('decode', 'No video arrived over WebRTC');
                }, WEBRTC_FIRST_FRAME_MS);
            }
        };

        await pc.setLocalDescription(await pc.createOffer());
        // Non-trickle WHEP: send the offer once candidate gathering is done (or has had long enough).
        await new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') return resolve();
            pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); });
            setTimeout(resolve, WEBRTC_ICE_GATHER_MS);
        });
        const res = await fetch(`/api/canvas/webrtc/${encodeURIComponent(id)}/whep`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: pc.localDescription.sdp,
            signal: this.abort.signal
        });
        if (!res.ok) throw new Error(`WebRTC negotiation failed (${res.status})`);
        await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });

        // The media port is unreachable from here (not forwarded, or UDP and TCP both blocked).
        this.connectTimer = setTimeout(() => {
            if (pc.connectionState !== 'connected') this.fail('webrtc-connect', 'Could not reach the WebRTC media port');
        }, WEBRTC_CONNECT_MS);
    }

    readVideo(track) {
        const readable = new MediaStreamTrackProcessor({ track }).readable;
        if (!this.startRenderWorker(readable)) this.drawOnMainThread(readable);
    }

    /** Hand the canvas and the frames to webrtc-render-worker.js; false when this browser can't. */
    startRenderWorker(readable) {
        if (typeof Worker !== 'function' || typeof this.canvas.transferControlToOffscreen !== 'function') return false;
        let offscreen;
        try { offscreen = this.canvas.transferControlToOffscreen(); } catch (_) { return false; }

        const worker = this.renderWorker = new Worker('/js/canvas/webrtc-render-worker.js?v=2');
        worker.onmessage = (event) => this.onWorkerMessage(event.data);
        worker.onerror = (event) => this.fail('webrtc-stream', event.message || 'Video render worker failed');
        worker.postMessage({ t: 'init', canvas: offscreen, paused: this.paused }, [offscreen]);
        try {
            worker.postMessage({ t: 'stream', stream: readable }, [readable]);
        } catch (_) {
            // No transferable streams: read here and pass each frame across (VideoFrame transfers cheaply).
            this.forEachFrame(readable, (frame) => worker.postMessage({ t: 'frame', frame }, [frame]));
        }
        return true;
    }

    onWorkerMessage(message) {
        if (this.destroyed) return;
        if (message.t === 'first') {
            this.host.resize(message.width, message.height);
            this.onFrame(message.timestamp);
        } else if (message.t === 'progress') {
            this.renderStats = { drawn: message.drawn, superseded: message.superseded, maxGapMs: message.maxGapMs };
            this.onFrame(message.timestamp);
        } else if (message.t === 'resize') {
            this.host.resize(message.width, message.height);
        } else if (message.t === 'error') {
            this.fail('webrtc-stream', message.message);
        }
    }

    /** Fallback without OffscreenCanvas transfer: draw each frame as it arrives. */
    drawOnMainThread(readable) {
        this.ctx = this.canvas.getContext('2d');
        this.forEachFrame(readable, (frame) => {
            try {
                if (!this.paused) {
                    const width = frame.displayWidth, height = frame.displayHeight;
                    if (this.canvas.width !== width || this.canvas.height !== height) {
                        this.canvas.width = width;
                        this.canvas.height = height;
                        this.host.resize(width, height);
                    }
                    this.ctx.drawImage(frame, 0, 0, width, height);
                }
                this.onFrame(frame.timestamp);
            } finally {
                frame.close();
            }
        });
    }

    async forEachFrame(readable, handle) {
        const reader = this.videoReader = readable.getReader();
        try {
            for (;;) {
                const { value: frame, done } = await reader.read();
                if (done || this.destroyed) { frame?.close(); return; }
                handle(frame);
            }
        } catch (error) {
            if (!this.destroyed) this.fail('webrtc-stream', `Video track failed: ${error.message}`);
        }
    }

    /** Playback bookkeeping for a frame (timestamp in µs) that arrived; drawing happens elsewhere. */
    onFrame(timestamp) {
        const now = performance.now();
        this.lastFrameAt = now;
        if (this.paused) return;
        if (this.firstTimestamp === null) {
            this.firstTimestamp = timestamp;
            // The server publishes in real time from the moment the stream is ready; negotiating
            // and waiting for a keyframe took this long, so that much of the stream went by unseen.
            this.joinOffset = this.readyAt ? (now - this.readyAt) / 1000 : 0;
        }
        if (!this.started) {
            this.started = true;
            clearTimeout(this.connectTimer);
            clearTimeout(this.firstFrameTimer);
            this.host.started();
        } else if (this.waiting) {
            this.waiting = false;
            this.host.playing();
        }
        if (now - this.lastTimeAt >= WEBRTC_TIME_INTERVAL_MS) {
            this.lastTimeAt = now;
            this.host.time(this.joinOffset + Math.max(0, (timestamp - this.firstTimestamp) / 1e6));
        }
    }

    playAudio(track) {
        this.audio.srcObject = new MediaStream([track]);
        this.audio.volume = this.volume;
        if (!this.paused) this.audio.play().catch(() => { /* autoplay blocked: unlockAudio retries on the next tap */ });
    }

    checkProgress() {
        if (!this.started || this.paused || this.destroyed) return;
        const quiet = performance.now() - this.lastFrameAt;
        if (this.serverEnded && quiet > 1000) {
            this.destroyed = true;
            this.host.ended();
        } else if (!this.waiting && quiet > WEBRTC_STALL_MS) {
            this.waiting = true;
            this.host.waiting();
        }
    }

    /**
     * Live: keep the session and just stop presenting, so resuming is instant (at the live edge).
     * VOD: the server reads in real time, so stop it; CanvasVideo restarts at this position on play.
     */
    pause() {
        this.paused = true;
        this.audio.pause();
        this.renderWorker?.postMessage({ t: 'pause' });
        if (!this.live && !this.restartOnResume) {
            this.restartOnResume = true;
            this.release();
        }
    }

    resume() {
        this.paused = false;
        this.renderWorker?.postMessage({ t: 'resume' });
        this.lastFrameAt = performance.now();
        this.audio.play().catch(() => {});
    }

    setVolume(gain) {
        this.volume = Math.min(1, Math.max(0, gain));
        this.audio.volume = this.volume;
    }

    /** Autoplay policies may block the audio element until the user taps. */
    unlockAudio() {
        if (!this.paused && this.audio.srcObject && this.audio.paused) this.audio.play().catch(() => {});
    }

    fail(code, message) {
        if (this.destroyed) return;
        this.destroyed = true;
        this.host.error(code, message);
    }

    /** Stop the session and connection but leave the last frame on the canvas (the worker keeps it). */
    release() {
        this.destroyed = true;
        clearInterval(this.watchdog);
        clearTimeout(this.connectTimer);
        clearTimeout(this.firstFrameTimer);
        this.abort?.abort();
        this.videoReader?.cancel().catch(() => {});
        this.renderWorker?.postMessage({ t: 'stop' });
        this.pc?.close();
    }

    destroy() {
        this.destroyed = true;
        clearInterval(this.watchdog);
        clearTimeout(this.connectTimer);
        clearTimeout(this.firstFrameTimer);
        this.abort?.abort();
        this.videoReader?.cancel().catch(() => {});
        this.renderWorker?.terminate();
        this.renderWorker = null;
        this.pc?.close();
        this.audio.pause();
        this.audio.srcObject = null;
        this.audio.remove();
    }
}

window.WebRtcPipeline = WebRtcPipeline;
