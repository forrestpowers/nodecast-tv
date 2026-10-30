const test = require('node:test');
const assert = require('node:assert/strict');
const diagnostics = require('../server/services/diagnostics');

test.beforeEach(() => diagnostics.reset());

test('events carry no stream address or credentials, in any field', () => {
    diagnostics.record('playback-end', {
        reason: 'http://user:pass@provider.test:8080/live/user/pass/1.ts: Server returned 403 Forbidden',
        path: 'rtsp://secret.test/x', title: 'Channel\nOne'
    });
    const [event] = diagnostics.getEvents();
    const text = JSON.stringify(event);
    assert.ok(!/provider\.test|user:pass|secret\.test/.test(text), text);
    assert.match(event.reason, /Server returned 403 Forbidden/);
    assert.equal(event.title, 'Channel One');
});

test('the history is bounded, newest first', () => {
    for (let i = 0; i < diagnostics.MAX_EVENTS + 25; i++) diagnostics.record('provider-retry', { reason: String(i) });
    const events = diagnostics.getEvents();
    assert.equal(events.length, diagnostics.MAX_EVENTS);
    assert.equal(events[0].reason, String(diagnostics.MAX_EVENTS + 24));
});

test('a session shows while it runs and logs how it ended, once', () => {
    const session = diagnostics.startSession({ userId: 2, engine: 'webrtc', video: 'encode', encoder: 'h264_vaapi (full GPU)' });
    assert.equal(diagnostics.getSessions()[0].engine, 'webrtc');
    session.update({ encoder: 'libx264' });
    assert.equal(diagnostics.getSessions()[0].encoder, 'libx264');
    session.end('failed', 'boom');
    session.end('closed');
    assert.equal(diagnostics.getSessions().length, 0);
    assert.deepEqual(diagnostics.getEvents().map((event) => [event.type, event.outcome]), [['playback-end', 'failed'], ['playback-start', undefined]]);
});
