const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCanvasPlayback() {
    const window = { location: { search: '' }, AudioContext: function AudioContext() {}, screen: { width: 0, height: 0 }, matchMedia: () => ({ matches: false }) };
    const context = vm.createContext({
        window, URLSearchParams, navigator: { userAgent: '' },
        localStorage: { getItem: () => null, setItem() {} },
        document: { addEventListener() {} }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/canvas/CanvasVideo.js'), 'utf8'), context);
    return window.CanvasPlayback;
}

const playback = loadCanvasPlayback();
const detect = (signals) => {
    const { isTesla, confidence, score, reasons } = playback.detectTesla(signals);
    return { isTesla, confidence, score, reasons: [...reasons] };
};

const LINUX_CHROMIUM = 'Mozilla/5.0 (X11; GNU/Linux) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/118.0.5993.88 Chrome/118.0.5993.88 Safari/537.36';
// Model 3/Y: 1920x1200 panel shown as 1254x784 CSS pixels; touch only, no hover, 4 cores.
const MODEL_3 = { screenWidth: 1254, screenHeight: 784, devicePixelRatio: 1.53, maxTouchPoints: 10, coarsePointer: true, hoverCapable: false, cpuCores: 4 };

test('a Tesla token in the user agent is certain', () => {
    for (const ua of [
        `${LINUX_CHROMIUM} Tesla/2021.4.15.1-c227d6fb1ecf`,
        `${LINUX_CHROMIUM} TeslaBrowser/2024.20`,
        'Mozilla/5.0 (X11; Linux) AppleWebKit/534.34 (KHTML, like Gecko) QtCarBrowser Safari/534.34',
        `${LINUX_CHROMIUM} Tesla`
    ]) {
        assert.equal(detect({ userAgent: ua }).confidence, 'certain', ua);
    }
});

test('without the token, the car screen, touch and no hover make it likely', () => {
    assert.deepEqual(detect({ userAgent: LINUX_CHROMIUM, ...MODEL_3 }),
        { isTesla: true, confidence: 'likely', score: 8.5, reasons: ['known-css-screen', 'known-panel', 'touchscreen', 'no-hover', 'fractional-ratio', 'few-cores'] });
    // Model S/X 2200x1300 panel at a fractional ratio, rotated, still counts.
    assert.equal(detect({ userAgent: LINUX_CHROMIUM, screenWidth: 867, screenHeight: 1467, devicePixelRatio: 1.5, maxTouchPoints: 5, hoverCapable: false }).confidence, 'likely');
    // The screen size alone (2.5 points) falls short; with a touchscreen it qualifies.
    assert.equal(detect({ userAgent: LINUX_CHROMIUM, screenWidth: 1254, screenHeight: 784, devicePixelRatio: 1, hoverCapable: true }).isTesla, false);
    assert.equal(detect({ userAgent: LINUX_CHROMIUM, screenWidth: 1254, screenHeight: 784, devicePixelRatio: 1, hoverCapable: true, maxTouchPoints: 1 }).isTesla, true);
});

test('ordinary desktops, phones and other browsers are not Teslas', () => {
    const desktop = { screenWidth: 1920, screenHeight: 1080, devicePixelRatio: 1, maxTouchPoints: 0, coarsePointer: false, hoverCapable: true, cpuCores: 8 };
    assert.deepEqual(detect({ userAgent: LINUX_CHROMIUM, ...desktop }), { isTesla: false, confidence: 'unlikely', score: 0, reasons: [] });
    // Even with a Tesla-like screen, phones, Macs, Windows and non-Chromium Linux browsers are excluded outright.
    for (const userAgent of [
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'
    ]) {
        assert.equal(detect({ userAgent, ...MODEL_3 }).isTesla, false, userAgent);
    }
});

test('isTeslaBrowser reads the live device signals', () => {
    assert.equal(playback.isTeslaBrowser(), false, 'empty user agent and screen');
});
