/**
 * Render worker for webrtc-pipeline.js: draws WebRTC video frames on an OffscreenCanvas, off the
 * page's main thread, so nodecast's UI, timers and garbage collection can't delay a frame.
 *
 * Frames are presented at most once per display refresh (requestAnimationFrame), newest frame
 * wins. Drawing each frame the moment it arrives looks like micro-stutter on a fixed-rate panel:
 * network arrival isn't aligned with the refresh, so some refreshes get two frames (the first is
 * never seen) and the next gets none (the old picture repeats).
 *
 * In:  init { canvas, paused }, stream { stream: ReadableStream<VideoFrame> }, frame { frame },
 *      pause, resume, stop
 * Out: first { timestamp, width, height }, resize { width, height },
 *      progress { timestamp, drawn, superseded, maxGapMs } (every 250 ms while frames arrive;
 *      maxGapMs is the longest wait between two drawn frames since the last report), error { message }
 */

const PROGRESS_INTERVAL_MS = 250;

let canvas = null;
let ctx = null;
let paused = false;
let stopped = false;
let pending = null;          // newest frame not yet presented
let presentQueued = false;
let reportedWidth = 0;
let reportedHeight = 0;
let firstSent = false;
let lastProgressAt = 0;
let drawn = 0;
let superseded = 0;          // frames replaced by a newer one before their refresh came
let lastDrawAt = 0;
let maxGapMs = 0;

const nextRefresh = typeof self.requestAnimationFrame === 'function'
    ? (callback) => self.requestAnimationFrame(callback)
    : (callback) => setTimeout(callback, 16);

function accept(frame) {
    if (stopped || !ctx) {
        frame.close();
        return;
    }
    if (!firstSent) {
        firstSent = true;
        reportedWidth = frame.displayWidth;
        reportedHeight = frame.displayHeight;
        self.postMessage({ t: 'first', timestamp: frame.timestamp, width: reportedWidth, height: reportedHeight });
    }
    const now = performance.now();
    if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        lastProgressAt = now;
        self.postMessage({ t: 'progress', timestamp: frame.timestamp, drawn, superseded, maxGapMs: Math.round(maxGapMs) });
        maxGapMs = 0;
    }
    if (paused) {
        frame.close();
        return;
    }
    if (pending) {
        pending.close();
        superseded++;
    }
    pending = frame;
    if (!presentQueued) {
        presentQueued = true;
        nextRefresh(present);
    }
}

function present() {
    presentQueued = false;
    const frame = pending;
    pending = null;
    if (!frame) return;
    try {
        const width = frame.displayWidth, height = frame.displayHeight;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        if (width !== reportedWidth || height !== reportedHeight) {
            reportedWidth = width;
            reportedHeight = height;
            self.postMessage({ t: 'resize', width, height });
        }
        ctx.drawImage(frame, 0, 0, width, height);
        drawn++;
        const now = performance.now();
        if (lastDrawAt) maxGapMs = Math.max(maxGapMs, now - lastDrawAt);
        lastDrawAt = now;
    } finally {
        frame.close();
    }
}

async function read(stream) {
    const reader = stream.getReader();
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            accept(value);
        }
    } catch (error) {
        if (!stopped) self.postMessage({ t: 'error', message: `Video track failed: ${error.message}` });
    }
}

self.onmessage = ({ data }) => {
    switch (data.t) {
        case 'init':
            canvas = data.canvas;
            // Not `desynchronized`: that presents outside the compositor's refresh cycle, which is
            // exactly the timing this worker exists to keep.
            ctx = canvas.getContext('2d', { alpha: false });
            paused = !!data.paused;
            break;
        case 'stream':
            read(data.stream);
            break;
        case 'frame':
            accept(data.frame);
            break;
        case 'pause':
            paused = true;
            break;
        case 'resume':
            paused = false;
            lastDrawAt = 0;
            break;
        case 'stop':
            stopped = true;
            pending?.close();
            pending = null;
            break;
    }
};
