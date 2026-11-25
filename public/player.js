// Canvas player: WebCodecs decodes the H.264 track and draws it on a canvas, Web Audio plays the
// AAC track. The Tesla browser suspends <video> outside Park but leaves canvas and Web Audio
// alone, which is why Tesplayer played this way. A browser without WebCodecs gets <video>.
(async () => {
    const CODEC = 'avc1.42E029'; // Constrained Baseline, level 4.1: matches public/video.h264
    const AHEAD = 12;            // decoded frames kept waiting, so the decoder never starves or floods
    const canvas = document.getElementById('canvas');
    const video = document.getElementById('video');
    const hint = document.getElementById('hint');
    const unlockEvents = ['pointerdown', 'touchstart', 'keydown'];

    const onceTapped = (fn) => {
        const handler = () => { unlockEvents.forEach((e) => window.removeEventListener(e, handler, true)); fn(); };
        unlockEvents.forEach((e) => window.addEventListener(e, handler, true));
    };
    const blocked = () => { hint.hidden = false; };
    const unblocked = () => { hint.hidden = true; };

    // Plain <video>: browsers without WebCodecs.
    const playWithVideo = async () => {
        canvas.hidden = true;
        video.hidden = false;
        video.muted = false;
        try { await video.play(); unblocked(); } catch {
            video.muted = true;
            video.play().catch(() => {});
            blocked();
            onceTapped(() => { video.muted = false; video.currentTime = 0; video.play().catch(() => {}); unblocked(); });
        }
    };

    let supported = false;
    try { supported = 'VideoDecoder' in window && (await VideoDecoder.isConfigSupported({ codec: CODEC })).supported; } catch {}
    if (!supported) return playWithVideo();

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const [h264, aac] = await Promise.all([
        fetch('/video.h264').then((r) => r.arrayBuffer()),
        fetch('/audio.m4a').then((r) => r.arrayBuffer())
    ]);
    const audio = await ctx.decodeAudioData(aac);
    const units = accessUnits(new Uint8Array(h264));
    const fps = Math.round(units.length / audio.duration);
    const period = audio.duration; // audio loops seamlessly; the video restarts on the same beat

    let frames = [], decoder, next = 0, lap = 0, failed = false;
    const newDecoder = () => {
        frames.forEach((f) => f.close());
        frames = []; next = 0; lap = 0;
        if (decoder && decoder.state !== 'closed') decoder.close();
        decoder = new VideoDecoder({
            output: (frame) => frames.push(frame),
            error: (e) => { console.error('[player] decoder', e); failed = true; playWithVideo(); }
        });
        decoder.configure({ codec: CODEC, optimizeForLatency: true });
    };
    const feed = () => {
        while (!failed && decoder.state === 'configured' && frames.length + decoder.decodeQueueSize < AHEAD) {
            const unit = units[next];
            decoder.decode(new EncodedVideoChunk({
                type: unit.key ? 'key' : 'delta',
                timestamp: Math.round((lap * period + next / fps) * 1e6),
                data: unit.data
            }));
            if (++next === units.length) { next = 0; lap++; }
        }
    };

    // The clock is the audio context when it runs, otherwise the wall clock (silent playback).
    let t0 = 0, wall0 = 0, source = null;
    const now = () => ctx.state === 'running' && source ? ctx.currentTime - t0 : performance.now() / 1000 - wall0;
    const start = (withSound) => {
        if (source) { try { source.stop(); } catch {} source = null; }
        newDecoder();
        wall0 = performance.now() / 1000;
        if (withSound) {
            source = ctx.createBufferSource();
            source.buffer = audio;
            source.loop = true;
            source.connect(ctx.destination);
            t0 = ctx.currentTime + 0.05;
            source.start(t0);
            wall0 += 0.05;
        }
        feed();
    };

    const g = canvas.getContext('2d');
    let shown = null;
    const fit = () => {
        if (!canvas.width) return;
        const scale = Math.min(innerWidth / canvas.width, innerHeight / canvas.height);
        canvas.style.width = `${Math.round(canvas.width * scale)}px`;
        canvas.style.height = `${Math.round(canvas.height * scale)}px`;
    };
    addEventListener('resize', fit);
    const tick = () => {
        const t = now();
        // Drop frames whose time has passed when a newer one is also due; keep the current one.
        while (frames.length > 1 && frames[1].timestamp / 1e6 <= t) frames.shift().close();
        const frame = frames[0];
        if (frame && frame !== shown && frame.timestamp / 1e6 <= t) {
            if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                canvas.width = frame.displayWidth;
                canvas.height = frame.displayHeight;
                fit();
            }
            g.drawImage(frame, 0, 0, canvas.width, canvas.height);
            shown = frame;
        }
        feed();
    };
    const loop = () => { tick(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    setInterval(tick, 50); // keeps feeding and drawing when animation frames are throttled

    // Sound without a tap where the browser allows it (a site it has played audible video on
    // before); otherwise the picture starts now and the first touch anywhere restarts with sound.
    const running = await Promise.race([ctx.resume().then(() => true), new Promise((r) => setTimeout(() => r(false), 400))]);
    if (running && ctx.state === 'running') { start(true); unblocked(); return; }
    start(false);
    blocked();
    onceTapped(() => ctx.resume().then(() => { start(true); unblocked(); }));

    // Splits an Annex B H.264 stream into access units: every NAL up to and including each
    // picture NAL (type 1 or 5), so parameter sets travel with the keyframe that follows them.
    function accessUnits(bytes) {
        const starts = [];
        for (let i = 0; i + 2 < bytes.length; i++) {
            if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) { starts.push(i); i += 2; }
        }
        const out = [];
        let auStart = starts[0], key = false;
        starts.forEach((s, n) => {
            const type = bytes[s + 3] & 0x1f;
            const end = n + 1 < starts.length ? starts[n + 1] : bytes.length;
            if (type === 5) key = true;
            if (type === 1 || type === 5) {
                out.push({ data: bytes.subarray(auStart, end), key });
                auStart = end; key = false;
            }
        });
        return out;
    }
})();
