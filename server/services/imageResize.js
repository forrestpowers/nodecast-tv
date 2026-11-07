/**
 * Small copies of channel logos for the browser: providers serve logos up to a few thousand pixels
 * wide, which the car then decodes in full to show at 64 px. Copies are WebP, kept in a small
 * in-memory cache, and never larger than the original. Anything that cannot be resized (SVG,
 * non-images, or sharp missing) goes out unchanged.
 */
let sharp = null;
try {
    sharp = require('sharp');
} catch (error) {
    console.warn('[Image] sharp is unavailable, logos are sent at full size:', error.message);
}

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_CACHED = 500;
const cache = new Map(); // `${width}:${url}` -> { type, body }, oldest first

/** The ?w= a request asked for, as a multiple of 16 from 16 to 512, or null for full size. */
function parseWidth(value) {
    const width = Number.parseInt(value, 10);
    if (!Number.isFinite(width) || width <= 0) return null;
    return Math.min(512, Math.max(16, Math.ceil(width / 16) * 16));
}

async function readBody(response) {
    const declared = Number(response.headers.get('content-length'));
    if (declared > MAX_SOURCE_BYTES) throw new Error('Image too large');
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_SOURCE_BYTES) throw new Error('Image too large');
    return body;
}

/** A copy made earlier, so the provider is not asked again. */
function cached(url, width) {
    const key = `${width}:${url}`;
    const image = cache.get(key);
    if (!image) return null;
    cache.delete(key);
    cache.set(key, image);
    return image;
}

/** @returns {Promise<{ type: string, body: Buffer }>} */
async function resize(url, width, type, response) {
    const key = `${width}:${url}`;
    const original = { type, body: await readBody(response) };
    let image = original;
    if (sharp && /^image\//i.test(type) && !/svg/i.test(type)) {
        try {
            const body = await sharp(original.body, { limitInputPixels: 40e6 })
                .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 80 })
                .toBuffer();
            if (body.length < original.body.length) image = { type: 'image/webp', body };
        } catch (error) {
            // Not an image sharp understands: the original still works in the browser
        }
    }

    cache.set(key, image);
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
    return image;
}

module.exports = { parseWidth, cached, resize, available: () => Boolean(sharp) };
