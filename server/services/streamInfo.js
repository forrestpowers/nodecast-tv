/**
 * Stream facts without a separate probe. A re-encoding ffmpeg prints its input's streams as it
 * starts ("Stream #0:0: Video: h264 ..., yuv420p(tv, progressive), 1920x1080 ..."): read from
 * there, they describe the stream the same way ffprobe would, for the probe cache and the quality
 * badge, without a second connection to the provider.
 */

const BROWSER_VIDEO_CODECS = ['h264', 'avc', 'avc1'];
const BROWSER_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis'];
const BROWSER_CONTAINERS = ['hls', 'mp4', 'mov'];

/** Whether a browser could play this as is, and what it needs otherwise (shared with ffprobe results). */
function classify({ video, audio, container, url }) {
    const videoOk = BROWSER_VIDEO_CODECS.some((c) => video.includes(c));
    const audioOk = BROWSER_AUDIO_CODECS.some((c) => audio.includes(c));
    const containerOk = BROWSER_CONTAINERS.some((c) => container.includes(c));
    const isRawTs = (container.includes('mpegts') || url.endsWith('.ts')) && !url.includes('.m3u8');
    // MKV often fails the browser fMP4 remux, so it goes through HLS like a transcode would
    const isMkv = container.includes('matroska') || container.includes('webm') || url.endsWith('.mkv');
    const needsTranscode = !audioOk || !videoOk || isMkv;
    const needsRemux = !needsTranscode && (!containerOk || isRawTs);
    return { compatible: !needsTranscode && !needsRemux, needsRemux, needsTranscode };
}

const CHANNEL_LAYOUTS = { mono: 1, stereo: 2, '2.1': 3, quad: 4, '5.0': 5, '5.1': 6, '6.1': 7, '7.1': 8 };
const FIELD_ORDERS = [['top coded first (swapped)', 'tb'], ['bottom coded first (swapped)', 'bt'], ['top first', 'tt'], ['bottom first', 'bb'], ['progressive', 'progressive']];

/**
 * Reads the "Input #0" block of ffmpeg's startup output. With a program number, only that
 * program's streams count (a multi-program TS lists each program's streams under its header).
 * @returns {object|null} a probe-shaped result, or null until the block is complete
 */
function parseInputInfo(text, { url = '', program = null } = {}) {
    const start = text.indexOf('Input #0');
    if (start < 0) return null;
    const endMatch = /\n(?:Output #0|Stream mapping:)/.exec(text.slice(start));
    if (!endMatch) return null;
    const block = text.slice(start, start + endMatch.index);

    const container = (/^Input #0, ([^,]+), from/.exec(block)?.[1] || 'unknown').toLowerCase();
    let video = null, audio = null, inProgram = program === null;
    for (const line of block.split('\n')) {
        const header = /^\s*Program (\d+)/.exec(line);
        if (header) { inProgram = program === null || Number(header[1]) === Number(program); continue; }
        if (!inProgram) continue;
        const stream = /^\s*Stream #0:\d+[^:]*: (Video|Audio): ([a-z0-9_]+)(.*)$/i.exec(line);
        if (!stream) continue;
        const [, kind, codec, rest] = stream;
        if (kind === 'Video' && !video) {
            const size = /(\d{2,5})x(\d{2,5})/.exec(rest);
            const fieldOrder = FIELD_ORDERS.find(([label]) => rest.includes(label))?.[1] || 'unknown';
            video = { codec: codec.toLowerCase(), width: Number(size?.[1]) || 0, height: Number(size?.[2]) || 0, fieldOrder };
        } else if (kind === 'Audio' && !audio) {
            const layout = /\d+ Hz, ([^,]+)/.exec(rest)?.[1].trim() || '';
            const counted = /^(\d+) channels/.exec(layout);
            audio = { codec: codec.toLowerCase(), channels: counted ? Number(counted[1]) : CHANNEL_LAYOUTS[layout.replace(/\(.*\)$/, '')] || 0 };
        }
    }
    if (!video) return null;

    const videoCodec = video.codec, audioCodec = audio?.codec || 'unknown';
    return {
        video: videoCodec,
        audio: audioCodec,
        duration: 0,
        audioCodecs: audio ? [audioCodec] : [],
        width: video.width,
        height: video.height,
        audioChannels: audio?.channels || 0,
        fieldOrder: video.fieldOrder,
        hasBFrames: null, // not in this output: WebRTC keeps re-encoding until a real probe says otherwise
        container,
        ...classify({ video: videoCodec, audio: audioCodec, container, url }),
        subtitles: [],
        source: 'stream'
    };
}

/** Feeds ffmpeg's stderr in, and reports the input's streams once, as soon as they are complete. */
class InputInfoCapture {
    constructor(onInfo, options) {
        this.onInfo = onInfo;
        this.options = options;
        this.text = '';
        this.done = false;
    }

    feed(chunk) {
        if (this.done) return;
        this.text = (this.text + chunk).slice(-16384);
        const info = parseInputInfo(this.text, this.options);
        if (!info && !/\n(?:Output #0|Stream mapping:)/.test(this.text)) return;
        this.done = true;
        this.text = '';
        if (info) this.onInfo(info);
    }
}

module.exports = { classify, parseInputInfo, InputInfoCapture };
