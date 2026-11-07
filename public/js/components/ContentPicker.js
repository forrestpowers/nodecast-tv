/**
 * Manage Content for live channels: which groups this device downloads.
 *
 * The provider's list stays on the server. This shows one row per group with a count, and only
 * fetches a group's channels when the group is opened or a search matches them, so the page costs
 * the car little however large the provider is. Ticks are kept here until Save, which sends the
 * group-level changes first (the server cascades them to the group's channels) and then the single
 * channels that differ from their group.
 */
class ContentPicker {
    constructor({ container, onChanged }) {
        this.container = container;
        this.onChanged = onChanged || (() => {});
        this.sourceId = null;
        this.groups = [];
        this.groupChoice = new Map(); // group id -> 'all' | 'none': the whole group ticked or unticked here
        this.itemChoice = new Map();  // channel id -> true (download) | false
        this.itemIndex = new Map();   // channel id -> { hidden, groupId } as the server has it
        this.expanded = new Set();
        this.query = '';
        this.results = null;          // while searching: [{ group, items }]
        this.container.addEventListener('click', (e) => this.onClick(e));
        this.container.addEventListener('change', (e) => this.onChange(e));
    }

    async load(sourceId) {
        this.sourceId = sourceId;
        this.groups = [];
        this.groupChoice.clear();
        this.itemChoice.clear();
        this.itemIndex.clear();
        this.expanded.clear();
        this.results = null;
        this.container.innerHTML = '<p class="hint">Loading...</p>';
        try {
            const groups = await API.channels.groups(sourceId);
            if (sourceId !== this.sourceId) return;
            this.groups = groups.map(g => ({ ...g, id: String(g.categoryId), items: null }));
            if (this.query) await this.runSearch();
            else this.render();
        } catch (err) {
            console.error('[ContentPicker] Could not load groups:', err);
            this.container.innerHTML = '<p class="hint" style="color: var(--color-error);">Error loading content</p>';
        }
    }

    // ----- state -----

    /** Whether a channel is ticked: its own tick, else its group's tick here, else what the server has. */
    itemOn(group, item) {
        if (this.itemChoice.has(item.id)) return this.itemChoice.get(item.id);
        const choice = this.groupChoice.get(group.id);
        return choice ? choice === 'all' : !item.hidden;
    }

    groupState(group) {
        const choice = this.groupChoice.get(group.id);
        const items = group.items || [];
        if (items.length) {
            const on = items.filter(item => this.itemOn(group, item)).length;
            return { checked: on > 0, mixed: on > 0 && on < items.length };
        }
        if (choice) return { checked: choice === 'all', mixed: false };
        return { checked: group.visible > 0, mixed: group.visible > 0 && group.visible < group.total };
    }

    /** How many of the group's channels would be downloaded after Save. */
    selectedCount(group) {
        const choice = this.groupChoice.get(group.id);
        let count = choice === 'all' ? group.total : choice === 'none' ? 0 : group.visible;
        for (const [id, on] of this.itemChoice) {
            const known = this.itemIndex.get(id);
            if (!known || known.groupId !== group.id) continue;
            const base = choice ? choice === 'all' : !known.hidden;
            if (on !== base) count += on ? 1 : -1;
        }
        return count;
    }

    remember(group, items) {
        items.forEach(item => this.itemIndex.set(item.id, { hidden: item.hidden, groupId: group.id }));
    }

    // ----- rendering -----

    escape(text) {
        return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    render() {
        if (this.results) return this.renderResults();
        if (!this.groups.length) {
            this.container.innerHTML = '<p class="hint">No channels synced for this source yet</p>';
            return;
        }
        this.container.innerHTML = this.groups.map(group => this.groupHtml(group, group.items)).join('');
        this.syncIndeterminate();
    }

    renderResults() {
        const q = this.query.toLowerCase();
        const listed = new Set(this.results.map(r => r.group.id));
        const byName = this.groups.filter(group => !listed.has(group.id) && group.name.toLowerCase().includes(q));
        if (!this.results.length && !byName.length) {
            this.container.innerHTML = '<p class="hint">No matches found</p>';
            return;
        }
        const note = this.truncated ? '<p class="hint">Showing the first 300 matching channels. Narrow the search for more.</p>' : '';
        this.container.innerHTML = note
            + this.results.map(r => this.groupHtml(r.group, r.items, { partial: true })).join('')
            + byName.map(group => this.groupHtml(group, group.items)).join('');
        this.syncIndeterminate();
    }

    groupHtml(group, items, { partial = false } = {}) {
        const state = this.groupState(group);
        const open = partial || this.expanded.has(group.id);
        const id = this.escape(group.id);
        let list = '';
        if (open) {
            list = items
                ? `<div class="content-channels">${items.map(item => this.itemHtml(group, item)).join('')}</div>`
                : '<div class="content-channels"><p class="hint">Loading...</p></div>';
        }
        return `
            <div class="content-group ${open ? '' : 'collapsed'}" data-group-id="${id}">
                <div class="content-group-header">
                    <span class="group-expander">${Icons.chevronDown}</span>
                    <label class="checkbox-label">
                        <input type="checkbox" class="group-checkbox" data-group-id="${id}" ${state.checked ? 'checked' : ''}>
                        <span class="group-name">${this.escape(group.name)}</span>
                        <span class="group-count">${this.selectedCount(group)} of ${group.total}</span>
                    </label>
                </div>
                ${list}
            </div>`;
    }

    itemHtml(group, item) {
        return `
            <label class="checkbox-label channel-item" title="${this.escape(item.name)}">
                <input type="checkbox" class="channel-checkbox" data-id="${this.escape(item.id)}" data-group-id="${this.escape(group.id)}" ${this.itemOn(group, item) ? 'checked' : ''}>
                <span class="channel-name">${this.escape(item.name)}</span>
            </label>`;
    }

    /** A group with some of its channels ticked shows a dash, which only a property can set. */
    syncIndeterminate() {
        this.container.querySelectorAll('.group-checkbox').forEach(cb => {
            const group = this.groups.find(g => g.id === cb.dataset.groupId);
            if (group) cb.indeterminate = this.groupState(group).mixed;
        });
    }

    rerenderGroup(group) {
        const el = this.container.querySelector(`.content-group[data-group-id="${CSS.escape(group.id)}"]`);
        if (!el) return;
        const result = this.results?.find(r => r.group === group);
        el.outerHTML = this.groupHtml(group, result ? result.items : group.items, { partial: Boolean(result) });
        this.syncIndeterminate();
    }

    // ----- events -----

    onClick(e) {
        const header = e.target.closest('.content-group-header');
        if (!header || e.target.closest('label') || e.target.closest('input')) return;
        const group = this.groups.find(g => g.id === header.parentElement.dataset.groupId);
        if (group && !this.results?.some(r => r.group === group)) this.toggleExpand(group);
    }

    async toggleExpand(group) {
        if (this.expanded.has(group.id)) {
            this.expanded.delete(group.id);
            return this.rerenderGroup(group);
        }
        this.expanded.add(group.id);
        this.rerenderGroup(group);
        if (group.items) return;
        try {
            const items = await API.channels.groupItems(this.sourceId, group.categoryId);
            group.items = items;
            this.remember(group, items);
        } catch (err) {
            console.error('[ContentPicker] Could not load the group:', err);
            group.items = [];
        }
        this.rerenderGroup(group);
    }

    onChange(e) {
        const cb = e.target;
        if (!(cb instanceof HTMLInputElement)) return;
        const group = this.groups.find(g => g.id === cb.dataset.groupId);
        if (!group) return;
        if (cb.classList.contains('group-checkbox')) {
            this.groupChoice.set(group.id, cb.checked ? 'all' : 'none');
            for (const id of [...this.itemChoice.keys()]) {
                if (this.itemIndex.get(id)?.groupId === group.id) this.itemChoice.delete(id);
            }
        } else {
            this.itemChoice.set(cb.dataset.id, cb.checked);
        }
        this.rerenderGroup(group);
    }

    // ----- search -----

    search(text) {
        this.query = text.trim();
        clearTimeout(this.searchTimer);
        if (!this.sourceId) return;
        if (!this.query) {
            this.results = null;
            return this.render();
        }
        this.searchTimer = setTimeout(() => this.runSearch(), 300);
    }

    async runSearch() {
        const { query, sourceId } = this;
        try {
            const { items, truncated } = await API.channels.search(sourceId, query);
            if (query !== this.query || sourceId !== this.sourceId) return;
            const byGroup = new Map();
            for (const item of items) {
                const group = this.groups.find(g => g.id === String(item.categoryId));
                if (!group) continue;
                this.remember(group, [item]);
                if (!byGroup.has(group.id)) byGroup.set(group.id, { group, items: [] });
                byGroup.get(group.id).items.push(item);
            }
            this.results = [...byGroup.values()];
            this.truncated = truncated;
            this.renderResults();
        } catch (err) {
            console.error('[ContentPicker] Search failed:', err);
            this.container.innerHTML = '<p class="hint" style="color: var(--color-error);">Search failed</p>';
        }
    }

    // ----- saving -----

    busy(text) {
        const btn = document.getElementById('content-save');
        if (!btn) return () => {};
        this.saveHtml ||= btn.innerHTML;
        btn.disabled = true;
        btn.textContent = text;
        return (done) => {
            if (done) btn.textContent = done;
            setTimeout(() => { btn.innerHTML = this.saveHtml; btn.disabled = false; }, done ? 1500 : 0);
        };
    }

    async setAll(visible) {
        if (!this.sourceId) return;
        const finish = this.busy(visible ? '⏳ Selecting all...' : '⏳ Clearing...');
        try {
            await (visible ? API.channels.showAll(this.sourceId, 'channels') : API.channels.hideAll(this.sourceId, 'channels'));
            await this.load(this.sourceId);
            this.onChanged();
            finish('✓ Done');
        } catch (err) {
            console.error('[ContentPicker] Could not change the selection:', err);
            alert('Failed: ' + err.message);
            finish();
        }
    }

    /** What Save sends: group ticks that differ from the server, then channel ticks that differ from their group. */
    changes() {
        const sourceId = this.sourceId;
        const groups = { show: [], hide: [] };
        const items = { show: [], hide: [] };
        for (const group of this.groups) {
            const choice = this.groupChoice.get(group.id);
            if (!choice) continue;
            const already = choice === 'all' ? group.visible === group.total : group.visible === 0;
            if (!already) groups[choice === 'all' ? 'show' : 'hide'].push({ sourceId, itemType: 'group', itemId: String(group.categoryId) });
        }
        for (const [id, on] of this.itemChoice) {
            const known = this.itemIndex.get(id);
            if (!known) continue;
            const choice = this.groupChoice.get(known.groupId);
            const base = choice ? choice === 'all' : !known.hidden;
            if (on !== base) items[on ? 'show' : 'hide'].push({ sourceId, itemType: 'channel', itemId: id });
        }
        return { groups, items };
    }

    async save() {
        if (!this.sourceId) return;
        const { groups, items } = this.changes();
        const total = groups.show.length + groups.hide.length + items.show.length + items.hide.length;
        if (total === 0) return this.busy('No changes')('No changes');
        const finish = this.busy('⏳ Saving...');
        const BATCH = 5000;
        const send = async (list, call) => {
            for (let i = 0; i < list.length; i += BATCH) await call(list.slice(i, i + BATCH));
        };
        try {
            // Groups first: a channel ticked on its own inside an unticked group must survive the cascade
            await send(groups.show, API.channels.bulkShow);
            await send(groups.hide, API.channels.bulkHide);
            await send(items.show, API.channels.bulkShow);
            await send(items.hide, API.channels.bulkHide);
            await this.load(this.sourceId);
            this.onChanged();
            finish('✓ Saved!');
        } catch (err) {
            console.error('[ContentPicker] Save failed:', err);
            alert('Failed to save changes: ' + err.message);
            finish();
        }
    }
}

window.ContentPicker = ContentPicker;
