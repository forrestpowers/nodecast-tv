# Tesplayer

Tesplayer has signed off. This repository now holds the farewell: a tiny Node server that plays
one video for anyone who visits, whatever address they use.

- `server.js` serves `public/index.html` for every path, `public/video.mp4` with range requests,
  and `/api/health` for the container health check.
- No dependencies. `npm start` listens on `PORT` (default 3000); `npm test` runs the one test.
- `docker compose up --build` runs it in a container.

The IPTV player this repository used to be lives on in its history.
