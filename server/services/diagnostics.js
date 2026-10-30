const { redactText } = require('./urlSecurity');

/**
 * What the admin Diagnostics tab shows: active canvas and WebRTC sessions, and a short in-memory
 * history of playback and sync events. Nothing here survives a restart, and nothing here may hold
 * a stream URL, provider address or credential: free text goes through clean() on the way in.
 */

const MAX_EVENTS = 200;
const events = [];
const sessions = new Map();
let nextEventId = 1;
let nextSessionId = 1;

function clean(value, maxLength = 160) {
    if (value === undefined || value === null) return undefined;
    return redactText(String(value))
        .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[stream]')
        .replace(/[\x00-\x1f\x7f]+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function record(type, { userId = null, engine, video, encoder, path, title, tesla, outcome, reason } = {}) {
    events.push({
        id: nextEventId++, time: Date.now(), type, userId,
        engine: clean(engine, 20), video: clean(video, 20), encoder: clean(encoder, 60), path: clean(path, 80),
        title: clean(title, 80), tesla: typeof tesla === 'boolean' ? tesla : undefined,
        outcome: clean(outcome, 20), reason: clean(reason)
    });
    if (events.length > MAX_EVENTS) events.shift();
}

/** Tracks one running stream. end() is safe to call more than once. */
function startSession({ userId = null, engine, video, audio, encoder, live }) {
    const session = { id: nextSessionId++, userId, engine, video, audio, encoder: clean(encoder, 60), live: Boolean(live), startedAt: Date.now() };
    sessions.set(session.id, session);
    record('playback-start', { userId, engine, video, encoder });
    return {
        update(changes) { Object.assign(session, changes); },
        end(outcome = 'closed', reason) {
            if (!sessions.delete(session.id)) return;
            record('playback-end', { userId, engine, video: session.video, encoder: session.encoder, outcome, reason });
        }
    };
}

const getEvents = () => [...events].reverse();
const getSessions = () => [...sessions.values()].map((session) => ({ ...session }));

function reset() {
    events.length = 0;
    sessions.clear();
}

module.exports = { MAX_EVENTS, clean, record, startSession, getEvents, getSessions, reset };
