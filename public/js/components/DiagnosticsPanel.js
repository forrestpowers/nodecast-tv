/**
 * Settings > Diagnostics (admin only): what is playing, which path each player took and why, and
 * how source refreshes went. Refreshes while the tab is open and the page is visible.
 */
class DiagnosticsPanel {
    constructor() {
        this.container = document.getElementById('diagnostics-content');
        this.timer = null;
        document.getElementById('diagnostics-refresh')?.addEventListener('click', () => this.load());
    }

    start() {
        this.stop();
        this.load();
        this.timer = setInterval(() => { if (!document.hidden) this.load(); }, 5000);
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
    }

    async load() {
        try {
            this.render(await API.diagnostics.get());
        } catch (err) {
            this.container.innerHTML = `<p class="hint error">${this.escape(err.message)}</p>`;
        }
    }

    escape(text) {
        const el = document.createElement('div');
        el.textContent = text ?? '';
        return el.innerHTML;
    }

    time(value) {
        return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    }

    duration(seconds) {
        const total = Math.max(0, Math.round(seconds));
        const hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60;
        return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${total % 60}s` : `${total}s`;
    }

    table(headers, rows, empty) {
        if (rows.length === 0) return `<p class="hint">${empty}</p>`;
        return `<div class="diagnostics-table-wrap"><table class="diagnostics-table">
            <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
            <tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${this.escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>`;
    }

    eventLabel(event) {
        const labels = {
            'playback-start': 'Stream started', 'playback-end': 'Stream ended', 'provider-retry': 'Provider refused, retrying',
            'encoder-fallback': 'Encoder fell back', 'sync-finished': 'Source refreshed', 'sync-failed': 'Source refresh failed',
            'client-plan': 'Player path', 'client-fallback': 'Player fell back', 'client-error': 'Player error'
        };
        return labels[event.type] || event.type;
    }

    eventDetail(event) {
        const parts = [event.path, event.engine, event.video, event.encoder, event.outcome].filter(Boolean);
        return [parts.join(' · '), event.reason].filter(Boolean).join(' — ');
    }

    render({ app, sessions, sources, events }) {
        const counts = (items) => Object.entries(items).map(([type, total]) => `${total.toLocaleString()} ${type}`).join(', ');
        this.container.innerHTML = `
            <div class="settings-section">
              <h3>Server</h3>
              <div class="diagnostics-facts">
                <span>Version <strong>${this.escape(app.version)}</strong></span>
                <span>Node <strong>${this.escape(app.node)}</strong></span>
                <span>Up <strong>${this.duration(app.uptimeSeconds)}</strong></span>
                <span>Memory <strong>${app.memoryMb} MB</strong></span>
                <span>WebRTC <strong>${app.webrtc ? 'available' : 'not available'}</strong></span>
                <span>Encoder <strong>${this.escape(app.recommendedEncoder)}</strong></span>
              </div>
            </div>
            <div class="settings-section">
              <h3>Playing now</h3>
              ${this.table(['Login', 'Engine', 'Video', 'Encoder', 'Started'],
                  sessions.map(s => [s.user || '', s.engine, s.video || s.status || '', s.encoder || '', this.time(s.startedAt)]),
                  'Nothing is playing through the server.')}
            </div>
            <div class="settings-section">
              <h3>Sources</h3>
              ${this.table(['Source', 'Login', 'Items', 'Last refresh', 'Status'],
                  sources.map(s => [s.name, s.owners.join(', ') || 'Everyone', counts(s.items), s.lastSync ? new Date(s.lastSync).toLocaleString() : 'Never',
                      s.syncError ? `${s.syncStatus}: ${s.syncError}` : s.syncStatus]),
                  'No sources yet.')}
            </div>
            <div class="settings-section">
              <h3>Recent events</h3>
              ${this.table(['Time', 'Login', 'Event', 'Channel', 'Details'],
                  events.map(e => [this.time(e.time), e.user || '', this.eventLabel(e), e.title || '', this.eventDetail(e)]),
                  'No events since the server started.')}
            </div>
        `;
    }
}

window.DiagnosticsPanel = DiagnosticsPanel;
