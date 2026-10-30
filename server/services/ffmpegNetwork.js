/**
 * How the canvas and WebRTC paths react to provider HTTP errors.
 *
 * ffmpeg reconnects by itself on 5xx. A 4xx is left to us: a dead channel (404) should fail at
 * once rather than loop for ten seconds, and any other 4xx is usually the provider refusing a
 * second connection while the previous one is still closing on its side, so it gets one retry.
 */
const HTTP_RECONNECT_ARGS = Object.freeze([
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_on_http_error', '5xx',
    '-reconnect_delay_max', '10'
]);

const PROVIDER_RETRY_DELAY_MS = 1500;

/** Whether ffmpeg/ffprobe output shows a provider rejection worth one retry. */
function isProviderRejection(output) {
    const match = /(?:Server returned|HTTP error) (4\d\d|4XX)/i.exec(output || '');
    return Boolean(match) && !['404', '410'].includes(match[1]);
}

module.exports = { HTTP_RECONNECT_ARGS, PROVIDER_RETRY_DELAY_MS, isProviderRejection };
