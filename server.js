// Tesplayer, retired: one video, served to everyone who comes by.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const FILES = {
    '/player.js': { file: 'player.js', type: 'text/javascript; charset=utf-8' },
    '/video.h264': { file: 'video.h264', type: 'application/octet-stream' }, // the canvas player's video track
    '/audio.m4a': { file: 'audio.m4a', type: 'audio/mp4' },                  // and its audio track
    '/video.mp4': { file: 'video.mp4', type: 'video/mp4' },                  // <video> fallback
    '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' }
};

function sendFile(req, res, { file, type }) {
    const filePath = path.join(PUBLIC, file);
    const { size } = fs.statSync(filePath);
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0, end = size - 1, status = 200;
    if (range && (range[1] || range[2])) {
        start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : end;
        if (start > end || start >= size) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}` });
            return res.end();
        }
        status = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.writeHead(status, {
        'Content-Type': type, 'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath, { start, end }).pipe(res);
}

const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end('{"status":"ok"}');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end();
    }
    if (FILES[pathname]) return sendFile(req, res, FILES[pathname]);
    // Every other path, old deep links included, is the player.
    const page = fs.readFileSync(path.join(PUBLIC, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.length, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : page);
});

if (require.main === module) {
    server.listen(PORT, () => console.log(`Tesplayer running on http://localhost:${server.address().port}`));
}
module.exports = server;
