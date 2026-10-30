/** Metadata probes belong to the active playback, and share an ordered lease across replacements. */
class PlaybackProbe {
    constructor(fetchImpl = fetch) {
        this.fetch = (url, options) => fetchImpl(url, options);
        this.sequence = 0;
        this.leaseId = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),
            byte => byte.toString(16).padStart(2, '0')).join('');
    }
    async read(url, { program = null, userAgent } = {}) {
        this.cancel();
        const controller = this.controller = new AbortController();
        const query = new URLSearchParams({ url, probeLeaseId: this.leaseId, requestSequence: String(++this.sequence), client: PlaybackProbe.clientId });
        if (program != null) query.set('program', program);
        if (userAgent !== undefined) query.set('ua', userAgent);
        try {
            const response = await this.fetch('/api/probe?' + query, { signal: controller.signal, credentials: 'same-origin' });
            const info = await response.json();
            if (controller.signal.aborted || this.controller !== controller || response.status === 409) {
                throw Object.assign(new Error('Playback probe was superseded'), { name: 'AbortError' });
            }
            if (response.ok === false) throw new Error(info.error || 'Unable to probe stream');
            return info;
        } finally { if (this.controller === controller) this.controller = null; }
    }
    cancel() { this.controller?.abort(); this.controller = null; }
}
// Names this tab to the server: one provider connection per player, across channels and engines.
PlaybackProbe.clientId = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, '0')).join('');
if (typeof window !== 'undefined') window.PlaybackProbe = PlaybackProbe;
if (typeof module !== 'undefined') module.exports = PlaybackProbe;
