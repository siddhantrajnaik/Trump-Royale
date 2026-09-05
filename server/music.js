// The room's shared music state.
//
// Kept out of the game engine on purpose: this is not a rule, and the engine's
// state is covered by tests that should not have to care about it.
//
// The state is a logical clock rather than a position. Storing "playing since
// T, from offset X" means any client can work out where the track should be at
// any instant, so a player who joins late, tabs away, or buffers can rejoin the
// others without anyone broadcasting ticks.

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com']);

// Accept the handful of shapes a YouTube link actually comes in, and a bare id.
function parseVideoId(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  if (YT_ID.test(s)) return s;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
  } catch (e) {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '');

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return YT_ID.test(id) ? id : null;
  }
  if (!HOSTS.has(host)) return null;

  const v = url.searchParams.get('v');
  if (v && YT_ID.test(v)) return v;

  const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function emptyMusic() {
  return { videoId: null, playing: false, offsetSec: 0, startedAtMs: 0, setBy: null };
}

// Where the track stands right now, given the logical clock.
function positionAt(music, now) {
  if (!music || !music.videoId) return 0;
  if (!music.playing) return music.offsetSec;
  return music.offsetSec + (now - music.startedAtMs) / 1000;
}

function setTrack(room, videoId, playerId, now) {
  room.music = {
    videoId,
    playing: true,
    offsetSec: 0,
    startedAtMs: now,
    setBy: playerId,
  };
  return room.music;
}

// Returns null when the action is not one we accept, so the caller can reject.
function control(room, action, seconds, now) {
  const m = room.music;
  if (!m || !m.videoId) return null;

  if (action === 'stop') {
    room.music = emptyMusic();
    return room.music;
  }

  const pos = positionAt(m, now);

  if (action === 'pause') {
    m.offsetSec = pos;
    m.playing = false;
    m.startedAtMs = now;
  } else if (action === 'play') {
    m.offsetSec = pos;
    m.playing = true;
    m.startedAtMs = now;
  } else if (action === 'seek') {
    const t = Number(seconds);
    if (!Number.isFinite(t) || t < 0) return null;
    m.offsetSec = t;
    m.startedAtMs = now;
  } else {
    return null;
  }
  return m;
}

// Clients need the server's clock to convert the logical clock into a position,
// so it rides along with the state.
function payload(room, now) {
  const m = room.music || emptyMusic();
  return { ...m, serverNow: now, enabled: room.musicEnabled !== false };
}

module.exports = { parseVideoId, emptyMusic, positionAt, setTrack, control, payload };
