/**
 * Tells the server which playback path this browser took, and why it changed, for the admin
 * Diagnostics tab. Only the browser knows this: the server just sees requests. Best effort.
 */
const PlaybackReport = {
    last: '',

    send(report) {
        const body = JSON.stringify(report);
        if (body === this.last) return;
        this.last = body;
        fetch('/api/diagnostics/client', {
            method: 'POST', credentials: 'same-origin', keepalive: true,
            headers: { 'Content-Type': 'application/json' }, body
        }).catch(() => {});
    },

    /**
     * Which codecs this browser can decode for the canvas, asked of WebCodecs once per visit: the
     * car is the only place that can answer whether HEVC decodes there, and whether in hardware.
     * Chrome answers a hardware or software preference only when such a decoder exists.
     */
    async decoders() {
        if (this.decodersSent) return;
        this.decodersSent = true;
        const codecs = [['H.264', 'avc1.640028'], ['HEVC', 'hvc1.1.6.L123.B0'], ['HEVC 10-bit', 'hvc1.2.4.L123.B0']];
        const supported = async (codec, hardwareAcceleration) => {
            try {
                return (await VideoDecoder.isConfigSupported({ codec, width: 1920, height: 1080, hardwareAcceleration })).supported === true;
            } catch (_) {
                return false;
            }
        };
        let path;
        if (typeof VideoDecoder !== 'function') {
            path = 'No WebCodecs';
        } else {
            const parts = [];
            for (const [name, codec] of codecs) {
                const hw = await supported(codec, 'prefer-hardware');
                const sw = await supported(codec, 'prefer-software');
                parts.push(`${name} ${hw && sw ? 'hw+sw' : hw ? 'hw' : sw ? 'sw' : 'no'}`);
            }
            path = parts.join(' · ');
        }
        const device = typeof CanvasPlayback === 'undefined' ? null : CanvasPlayback.detectTesla();
        const browser = (navigator.userAgent.match(/(Chrome|Firefox|Safari)\/(\d+)/) || []).slice(1, 3).join(' ') || 'unknown browser';
        this.send({
            kind: 'decoders', path, tesla: device?.isTesla === true,
            reason: `${browser} · ${window.screen.width}x${window.screen.height} screen · ${window.innerWidth}x${window.innerHeight} window`
        });
    },

    /** The path a player settled on, with what the Tesla detection saw on this device. */
    plan(path, title) {
        const device = typeof CanvasPlayback === 'undefined' ? null : CanvasPlayback.detectTesla();
        this.send({
            kind: 'plan', path, title, tesla: device?.isTesla === true,
            reason: device ? `${device.isTesla ? 'Tesla' : 'Not a Tesla'} (${device.confidence}): ${device.reasons.join(', ')}` : undefined
        });
    }
};

window.PlaybackReport = PlaybackReport;
