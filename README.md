# Tesplayer

Tesplayer has signed off. This repository now holds the farewell: a tiny Node server that plays
one video for anyone who visits, whatever address they use.

- `server.js` serves `public/index.html` for every path, the media files with range requests,
  and `/api/health` for the container health check.
- `public/player.js` plays the way Tesplayer did: WebCodecs decodes `video.h264` onto a canvas
  and Web Audio plays `audio.m4a`, so it keeps playing in a Tesla outside Park. Sound starts
  by itself where the browser allows it; otherwise the first touch anywhere restarts with sound.
  Browsers without WebCodecs get `video.mp4` in a plain video element.
- No dependencies. `npm start` listens on `PORT` (default 3000); `npm test` runs the one test.
- `docker compose up --build` runs it in a container.

The IPTV player this repository used to be lives on in its history.
