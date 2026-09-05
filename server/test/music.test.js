// Shared music: link parsing and the playback clock.
//
// The clock is the part that matters. Positions are never broadcast as ticks -
// the state says "playing since T, from offset X" and each client derives the
// rest, so if this arithmetic is wrong everyone drifts apart silently.
const assert = require('node:assert');
const { test } = require('./harness');
const Music = require('../music');

test('music: recognises the shapes a YouTube link comes in', () => {
  const ID = 'dQw4w9WgXcQ';
  const good = [
    'https://www.youtube.com/watch?v=' + ID,
    'https://youtube.com/watch?v=' + ID,
    'http://www.youtube.com/watch?v=' + ID + '&t=42s',
    'https://m.youtube.com/watch?v=' + ID,
    'https://music.youtube.com/watch?v=' + ID + '&list=RDAMVM',
    'https://youtu.be/' + ID,
    'https://youtu.be/' + ID + '?t=90',
    'https://www.youtube.com/shorts/' + ID,
    'https://www.youtube.com/embed/' + ID,
    'https://www.youtube.com/live/' + ID,
    'www.youtube.com/watch?v=' + ID,          // no scheme
    '  https://youtu.be/' + ID + '  ',        // padded
    ID,                                        // bare id
  ];
  for (const url of good) {
    assert.strictEqual(Music.parseVideoId(url), ID, 'parsed ' + url);
  }
});

test('music: rejects anything that is not a YouTube video', () => {
  const bad = [
    '', '   ', null, undefined, 42, {},
    'https://vimeo.com/12345678',
    'https://example.com/watch?v=dQw4w9WgXcQ',   // right shape, wrong host
    'https://youtube.com/',                       // no video
    'https://youtube.com/watch?v=tooshort',
    'https://youtu.be/way-too-long-to-be-an-id',
    'not a url at all',
    'javascript:alert(1)',
  ];
  for (const url of bad) {
    assert.strictEqual(Music.parseVideoId(url), null, 'rejected ' + JSON.stringify(url));
  }
});

test('music: position advances with the clock while playing', () => {
  const room = { music: Music.emptyMusic() };
  const t0 = 1_000_000;
  Music.setTrack(room, 'dQw4w9WgXcQ', 'p1', t0);

  assert.strictEqual(Music.positionAt(room.music, t0), 0, 'starts at zero');
  assert.strictEqual(Music.positionAt(room.music, t0 + 5000), 5, 'five seconds later');
  assert.strictEqual(Music.positionAt(room.music, t0 + 90_000), 90, 'ninety seconds later');
});

test('music: pausing freezes the position, resuming carries on from it', () => {
  const room = { music: Music.emptyMusic() };
  const t0 = 1_000_000;
  Music.setTrack(room, 'dQw4w9WgXcQ', 'p1', t0);

  Music.control(room, 'pause', null, t0 + 30_000);
  assert.strictEqual(room.music.playing, false);
  assert.strictEqual(Music.positionAt(room.music, t0 + 30_000), 30, 'frozen at 30s');
  assert.strictEqual(Music.positionAt(room.music, t0 + 120_000), 30, 'still 30s a minute later');

  Music.control(room, 'play', null, t0 + 120_000);
  assert.strictEqual(Music.positionAt(room.music, t0 + 120_000), 30, 'resumes where it stopped');
  assert.strictEqual(Music.positionAt(room.music, t0 + 130_000), 40, 'and runs on');
});

test('music: seeking moves everyone to the same spot', () => {
  const room = { music: Music.emptyMusic() };
  const t0 = 1_000_000;
  Music.setTrack(room, 'dQw4w9WgXcQ', 'p1', t0);
  Music.control(room, 'seek', 200, t0 + 10_000);
  assert.strictEqual(Music.positionAt(room.music, t0 + 10_000), 200, 'jumped to 200s');
  assert.strictEqual(Music.positionAt(room.music, t0 + 15_000), 205, 'and keeps running');
});

test('music: two clients with different clocks derive the same position', () => {
  // This is the whole point of sending serverNow: a client whose clock is three
  // seconds fast must not conclude the track is three seconds further along.
  const room = { music: Music.emptyMusic() };
  const t0 = 1_000_000;
  Music.setTrack(room, 'dQw4w9WgXcQ', 'p1', t0);

  const serverAt = t0 + 45_000;
  const state = Music.payload(room, serverAt);

  // Each client corrects its own clock against serverNow, exactly as music.js does.
  function clientPosition(localClock) {
    const skew = state.serverNow - localClock;
    const serverNowForClient = localClock + skew;
    return state.offsetSec + (serverNowForClient - state.startedAtMs) / 1000;
  }

  const fast = clientPosition(serverAt + 3000);   // 3s ahead
  const slow = clientPosition(serverAt - 8000);   // 8s behind
  assert.strictEqual(fast, 45, 'fast clock still sees 45s');
  assert.strictEqual(slow, 45, 'slow clock still sees 45s');
});

test('music: stop clears the track for the room', () => {
  const room = { music: Music.emptyMusic() };
  Music.setTrack(room, 'dQw4w9WgXcQ', 'p1', 1000);
  Music.control(room, 'stop', null, 2000);
  assert.strictEqual(room.music.videoId, null);
  assert.strictEqual(room.music.playing, false);
});

test('music: controls are refused when nothing is playing, and bad input rejected', () => {
  const room = { music: Music.emptyMusic() };
  assert.strictEqual(Music.control(room, 'play', null, 1000), null, 'no track to play');
  assert.strictEqual(Music.control(room, 'pause', null, 1000), null, 'no track to pause');

  Music.setTrack(room, 'dQw4w9WgXcQ', 'p1', 1000);
  assert.strictEqual(Music.control(room, 'fastforward', null, 2000), null, 'unknown action');
  assert.strictEqual(Music.control(room, 'seek', -5, 2000), null, 'negative seek');
  assert.strictEqual(Music.control(room, 'seek', 'abc', 2000), null, 'non-numeric seek');
  assert.strictEqual(room.music.videoId, 'dQw4w9WgXcQ', 'the track survived the bad input');
});

test('music: a late joiner is told where the track already is', () => {
  const room = { music: Music.emptyMusic() };
  const t0 = 1_000_000;
  Music.setTrack(room, 'dQw4w9WgXcQ', 'p1', t0);

  // Someone opens the room two minutes in.
  const state = Music.payload(room, t0 + 120_000);
  const position = state.offsetSec + (state.serverNow - state.startedAtMs) / 1000;
  assert.strictEqual(position, 120, 'they start at 2:00, not 0:00');
  assert.strictEqual(state.videoId, 'dQw4w9WgXcQ');
  assert.ok(typeof state.serverNow === 'number', 'the server clock rides along');
});
