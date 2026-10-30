/**
 * Home Dashboard Page
 * Shows the login's favorite channels
 */
class HomePage {
    constructor(app) {
        this.app = app;
        this.container = null; // Will be set in renderLayout
        this.isLoading = false;
    }

    async init() {
        // Initialization if needed
    }

    async show() {
        this.renderLayout();
        await this.loadDashboardData();
    }

    hide() {
        // Cleanup if needed
        if (this.container) {
            this.container.innerHTML = '';
        }
    }

    renderLayout() {
        const pageHome = document.getElementById('page-home');
        if (!pageHome) return;

        pageHome.innerHTML = `
            <div class="dashboard-content" id="home-content">
                <section class="dashboard-section" id="favorite-channels-section">
                    <div class="section-header">
                        <h2>Favorite Channels</h2>
                    </div>
                    <div class="scroll-wrapper">
                        <button class="scroll-arrow scroll-left" aria-label="Scroll left">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        </button>
                        <div class="horizontal-scroll channel-tiles" id="favorite-channels-list">
                            <div class="loading-state">
                                <div class="loading"></div>
                                <span>Loading favorites...</span>
                            </div>
                        </div>
                        <button class="scroll-arrow scroll-right" aria-label="Scroll right">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
                        </button>
                    </div>
                </section>
            </div>
        `;
        this.container = document.getElementById('home-content');

        // Attach scroll arrow handlers
        this.initScrollArrows();
    }

    initScrollArrows() {
        this.container.querySelectorAll('.scroll-wrapper').forEach(wrapper => {
            const scrollContainer = wrapper.querySelector('.horizontal-scroll');
            const leftBtn = wrapper.querySelector('.scroll-left');
            const rightBtn = wrapper.querySelector('.scroll-right');

            if (!scrollContainer || !leftBtn || !rightBtn) return;

            const scrollAmount = 300; // pixels to scroll per click

            leftBtn.addEventListener('click', () => {
                scrollContainer.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
            });

            rightBtn.addEventListener('click', () => {
                scrollContainer.scrollBy({ left: scrollAmount, behavior: 'smooth' });
            });

            // Update arrow visibility based on scroll position
            const updateArrows = () => {
                const { scrollLeft, scrollWidth, clientWidth } = scrollContainer;
                leftBtn.classList.toggle('hidden', scrollLeft <= 0);
                rightBtn.classList.toggle('hidden', scrollLeft + clientWidth >= scrollWidth - 5);
            };

            // Store reference for later updates
            wrapper._updateArrows = updateArrows;

            scrollContainer.addEventListener('scroll', updateArrows);
            // Initial check after content loads
            setTimeout(updateArrows, 100);
        });
    }

    /**
     * Re-check scroll arrow visibility for all sections
     * Call this after dynamically loading content
     */
    updateScrollArrows() {
        this.container?.querySelectorAll('.scroll-wrapper').forEach(wrapper => {
            if (wrapper._updateArrows) {
                wrapper._updateArrows();
            }
        });
    }


    async loadDashboardData() {
        if (this.isLoading) return;
        this.isLoading = true;

        try {
            await this.renderFavoriteChannels();
        } catch (err) {
            console.error('[Dashboard] Error loading data:', err);
        } finally {
            this.isLoading = false;
        }
    }

    async renderFavoriteChannels() {
        const list = document.getElementById('favorite-channels-list');
        const section = document.getElementById('favorite-channels-section');
        if (!list || !section) return;

        try {
            // The server resolves favorites, so Home never loads the whole channel list
            const channels = await window.API.request('GET', '/favorites/channels');

            if (!channels || channels.length === 0) {
                list.innerHTML = '<div class="empty-state hint">Add channels to favorites from Live TV</div>';
                return;
            }

            // Render channel tiles
            list.innerHTML = channels.map(ch => this.createChannelTile(ch)).join('');

            // Attach click handlers
            list.querySelectorAll('.channel-tile').forEach(tile => {
                tile.addEventListener('click', () => this.playChannel(tile.dataset.channelId));
            });

            // Update scroll arrows after content renders
            this.updateScrollArrows();

        } catch (err) {
            console.error('[Dashboard] Error loading favorite channels:', err);
            list.innerHTML = '<div class="empty-state hint">Error loading favorites</div>';
        }
    }

    createChannelTile(channel) {
        const logo = channel.tvgLogo || '/img/placeholder.png';
        const logoUrl = logo.startsWith('http') ? `/api/proxy/image?url=${encodeURIComponent(logo)}` : logo;
        const name = channel.name || 'Unknown';

        return `
            <div class="channel-tile" data-channel-id="${channel.id}" data-source-id="${channel.sourceId}">
                <div class="tile-logo">
                    <img src="${logoUrl}" alt="${name}" loading="lazy" onerror="this.onerror=null;this.src='/img/placeholder.png'">
                </div>
                <div class="tile-name" title="${name}">${name}</div>
            </div>
        `;
    }

    async playChannel(channelId) {
        // Live TV holds the player and the channel list, which starts loading now
        this.app.navigateTo('live');
        await this.app.pages.live.ready;
        await this.app.channelList.selectChannel({ channelId });
    }
}

window.HomePage = HomePage;
