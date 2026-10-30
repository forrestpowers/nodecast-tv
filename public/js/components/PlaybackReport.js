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
