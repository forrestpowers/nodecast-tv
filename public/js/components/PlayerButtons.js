/**
 * Play and Stop in the top bar, for the Live TV player. They appear once a channel has played,
 * or straight away when this login watched one before in this browser, so the car can pick up
 * where it left off. Play restarts the channel on Live TV; Stop ends playback, wherever you are.
 */
class PlayerButtons {
    constructor(app) {
        this.app = app;
        this.container = document.getElementById('player-buttons');
        this.playButton = document.getElementById('player-play');
        this.stopButton = document.getElementById('player-stop');
        this.playButton.addEventListener('click', () => this.play());
        this.stopButton.addEventListener('click', () => this.stop());

        const video = app.player.video;
        for (const type of ['loadstart', 'play', 'playing', 'pause', 'emptied', 'ended', 'error']) {
            video.addEventListener(type, () => this.update());
        }
        video.addEventListener('playing', () => this.remember());
        this.update();
    }

    storageKey() {
        return `tesplayer.lastChannel.${this.app.currentUser?.id}`;
    }

    lastChannelId() {
        try { return localStorage.getItem(this.storageKey()); } catch (_) { return null; }
    }

    remember() {
        const channel = this.app.player.currentChannel;
        if (!channel) return;
        try { localStorage.setItem(this.storageKey(), channel.id); } catch (_) { /* storage unavailable */ }
    }

    channelId() {
        return this.app.player.currentChannel?.id || this.lastChannelId();
    }

    isPlaying() {
        const player = this.app.player;
        return Boolean(player.currentChannel) && !player.stopped && !player.video.paused;
    }

    update() {
        const playing = this.isPlaying();
        this.container.hidden = !this.channelId();
        this.playButton.disabled = playing;
        this.stopButton.disabled = !playing;
    }

    async play() {
        const channelId = this.channelId();
        if (!channelId) return;
        this.app.player.stopped = false;
        await this.app.playChannel(channelId);
        this.update();
    }

    stop() {
        this.app.player.stopped = true;
        this.app.player.stop();
        this.update();
    }
}

window.PlayerButtons = PlayerButtons;
