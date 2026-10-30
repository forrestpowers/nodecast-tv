/**
 * One provider connection per player.
 *
 * Many IPTV accounts allow a single connection, so a channel change has to end the old connection
 * before the next one opens. The browser closing its old request is not enough: that can reach the
 * server after the probe of the next channel. So each browser tab names itself (?client=...) and
 * holds one slot: whoever takes the slot stops the holder and waits for its ffmpeg to really exit.
 * Other tabs and devices have their own slots, so they never stop each other.
 */

const CLIENT_ID = /^[A-Za-z0-9_-]{16,128}$/;
const CLOSE_TIMEOUT_MS = 3000;

const superseded = () => Object.assign(new Error('Playback was superseded'), { name: 'AbortError' });

/** The slot key for a request, or null when it names no client (it then takes no slot). */
function playbackKey(req) {
    const { client } = req.query;
    return typeof client === 'string' && CLIENT_ID.test(client) ? JSON.stringify([req.user?.id ?? null, client]) : null;
}

class Holder {
    constructor(url, onStop) {
        this.url = url;
        this.onStop = onStop;
        this.stopped = false;
        this.finished = false;
        this.running = 0;
        this.released = new Promise((resolve) => { this.release = resolve; });
    }

    /** Counts a process: the slot stays taken until it has exited. */
    track(child) {
        this.running++;
        child.once('close', () => {
            this.running--;
            this.settle();
        });
    }

    /** Replaces what stop() does, for a holder whose work starts after it took the slot. */
    onStopped(handler) {
        this.onStop = handler;
        if (this.stopped) handler();
    }

    /** Nothing further will start: the slot frees once running processes are gone. */
    finish() {
        this.finished = true;
        this.settle();
    }

    stop() {
        if (this.stopped) return;
        this.stopped = true;
        this.onStop?.();
        this.finish();
    }

    settle() {
        if (this.finished && this.running === 0) this.release();
    }
}

class ProviderSlots {
    constructor({ closeTimeoutMs = CLOSE_TIMEOUT_MS } = {}) {
        this.closeTimeoutMs = closeTimeoutMs;
        this.slots = new Map();
    }

    /**
     * Takes the slot, stopping whatever holds it and waiting for its process to exit.
     * @param {string|null} key  from playbackKey
     * @param {object} options
     *   url          the stream this connection is for
     *   stop         called to stop this holder when the next one arrives
     *   keepSameUrl  leave a holder of the same URL alone and share its connection (probes)
     * @throws AbortError when a newer request for this slot arrived while waiting
     */
    async acquire(key, { url, stop, keepSameUrl = false } = {}) {
        if (!key) return new Holder(url, stop);
        let slot = this.slots.get(key);
        if (keepSameUrl && slot?.holder?.url === url) return new Holder(url, stop);
        if (!slot) this.slots.set(key, slot = { ticket: 0, waiting: 0, holder: null });

        const ticket = ++slot.ticket;
        const previous = slot.holder;
        if (previous) {
            previous.stop();
            slot.waiting++;
            let timer;
            await Promise.race([previous.released, new Promise((resolve) => { timer = setTimeout(resolve, this.closeTimeoutMs); })]);
            clearTimeout(timer);
            slot.waiting--;
        }
        if (ticket !== slot.ticket) throw superseded();

        const holder = slot.holder = new Holder(url, stop);
        holder.released.then(() => {
            if (slot.holder === holder) slot.holder = null;
            if (!slot.holder && slot.waiting === 0 && this.slots.get(key) === slot) this.slots.delete(key);
        });
        return holder;
    }
}

module.exports = { ProviderSlots, Holder, providerSlots: new ProviderSlots(), playbackKey };
