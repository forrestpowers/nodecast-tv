const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const server = require('./server');

test('every path plays the video, the file supports ranges, the health check answers', async (t) => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const size = fs.statSync(`${__dirname}/public/video.mp4`).size;

    for (const path of ['/', '/index.html', '/login.html', '/watch/123?x=1', '/api/sources']) {
        const response = await fetch(base + path);
        assert.equal(response.status, 200, path);
        assert.match(response.headers.get('content-type'), /text\/html/, path);
        assert.match(await response.text(), /<video[^>]* src="\/video\.mp4"[^>]* autoplay/, path);
    }

    const whole = await fetch(`${base}/video.mp4`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'video/mp4');
    assert.equal(Number(whole.headers.get('content-length')), size);
    assert.equal((await whole.arrayBuffer()).byteLength, size);

    const range = await fetch(`${base}/video.mp4`, { headers: { Range: 'bytes=100-199' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes 100-199/${size}`);
    assert.equal((await range.arrayBuffer()).byteLength, 100);
    const tail = await fetch(`${base}/video.mp4`, { headers: { Range: `bytes=${size - 10}-` } });
    assert.equal(tail.status, 206);
    assert.equal((await tail.arrayBuffer()).byteLength, 10);
    assert.equal((await fetch(`${base}/video.mp4`, { headers: { Range: `bytes=${size + 5}-` } })).status, 416);

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    assert.equal((await fetch(`${base}/api/auth/login`, { method: 'POST' })).status, 405);
});
