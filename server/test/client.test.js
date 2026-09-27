// Does the browser code actually start?
//
// Every other test here runs server-side. None of them open app.js, so the
// suite once reported 33/33 while the client was throwing on load and half the
// app never wired up - the Create button did nothing and the table never
// updated. Nothing would have caught that before a player did.
//
// This loads index.html in a real DOM implementation, runs the three browser
// scripts the way a browser would, and pushes genuine engine states through the
// renderer. It cannot see layout or styling; it answers one question: does the
// thing come up, and can it draw itself.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { test } = require('./harness');
const { GameEngine } = require('../game/engine');
const MusicServer = require('../music');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

// Scripts in the order index.html loads them, minus socket.io which we fake.
const SCRIPTS = ['sound.js', 'app.js', 'music.js'];

// Enough of the Web Audio API for sound.js to build its graph for real, so a
// mistake inside a cue surfaces here rather than as silence in a game.
function fakeAudioContext() {
  const node = () => ({
    connect() {}, disconnect() {},
    gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    type: '', Q: { value: 0 }, buffer: null,
    start() {}, stop() {},
  });
  return function AudioContextStub() {
    return {
      state: 'running',
      currentTime: 0,
      sampleRate: 44100,
      destination: node(),
      resume() { return Promise.resolve(); },
      createGain: node,
      createOscillator: node,
      createBiquadFilter: node,
      createBufferSource: node,
      createBuffer: (ch, len) => ({ getChannelData: () => new Float32Array(len) }),
    };
  };
}

// Minimal YouTube IFrame API so music.js takes its real path instead of
// bailing out before it builds a player.
//
// onReady fires synchronously here, where the real API fires it once the iframe
// has loaded. That is deliberately stricter: code that survives the harsher
// ordering survives the real one too, and it caught music.js depending on a
// variable that is not assigned until the constructor returns.
//
// `ctl` lets a test play the browser: set ctl.state to what getPlayerState()
// reports (5 = CUED is what a refused autoplay looks like), and call
// ctl.onStateChange({ data: 1 }) to stand in for a tap on the video itself.
// Left alone it reports PLAYING, as it always has.
function fakeYT(ctl) {
  ctl = ctl || {};
  if (ctl.state === undefined) ctl.state = 1;
  return {
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    Player: function PlayerStub(_id, opts) {
      this._t = 0;
      if (opts && opts.events) ctl.onStateChange = opts.events.onStateChange;
      this.getPlayerState = () => ctl.state;
      this.getCurrentTime = () => this._t;
      this.setVolume = () => {};
      this.playVideo = () => {};
      this.pauseVideo = () => {};
      this.stopVideo = () => {};
      this.seekTo = (t) => { this._t = t; };
      this.loadVideoById = () => {};
      this.cueVideoById = () => {};
      if (opts && opts.events && opts.events.onReady) opts.events.onReady({ target: this });
    },
  };
}

// Boot the page. Returns the window, the captured socket handlers, any errors
// thrown while loading, and the ids the scripts looked for but did not find.
//
// Options, all defaulting to the desktop setup every older test relies on:
//   touch: true       - a phone: no hover, no fine pointer, 375px wide
//   optedOut: true    - this browser left the music on a previous visit
function bootClient(opts) {
  opts = opts || {};
  const errors = [];
  // Real script execution, not eval. Top-level const/let in a classic script
  // land in the global lexical scope and are visible to the next script; inside
  // eval they are confined to that eval, so app.js's socket would be invisible
  // to music.js and the harness would be testing something a browser never does.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => errors.push(err && err.message ? err.message : String(err)));

  const dom = new JSDOM(read('index.html'), {
    runScripts: 'dangerously',   // only our own files are ever injected
    url: 'https://trump.example/',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;

  const missingIds = [];
  const socketHandlers = {};
  const emitted = [];

  window.addEventListener('error', (e) => errors.push(String(e.message || e)));

  // Fake socket.io: record handlers so tests can deliver a game-state, and
  // answer acks so nothing hangs.
  window.io = () => ({
    on(ev, fn) { socketHandlers[ev] = fn; },
    emit(ev, data, ack) {
      emitted.push({ ev, data });
      if (typeof ack === 'function') ack({ ok: true, serverNow: Date.now() });
    },
    disconnect() {},
  });

  window.AudioContext = fakeAudioContext();
  const yt = {};
  window.YT = fakeYT(yt);
  // Desktop by default. A touch device matches none of the hover/pointer queries.
  window.matchMedia = (q) => ({
    matches: !opts.touch && /hover: hover|pointer: fine/.test(q),
    media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  if (opts.touch) {
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 812, configurable: true });
  }
  // Before the scripts run: music.js reads this once, at load.
  if (opts.optedOut) window.localStorage.setItem('tcr_music_out', '1');
  else window.localStorage.removeItem('tcr_music_out');

  // Record every id the scripts ask for that the markup does not contain.
  const realGetById = window.document.getElementById.bind(window.document);
  window.document.getElementById = (id) => {
    const el = realGetById(id);
    if (!el && !missingIds.includes(id)) missingIds.push(id);
    return el;
  };

  // Inject each file as a real script element, the way index.html does.
  for (const file of SCRIPTS) {
    const before = errors.length;
    const el = window.document.createElement('script');
    el.textContent = read(file);
    window.document.body.appendChild(el);
    if (errors.length > before) {
      errors[errors.length - 1] = file + ': ' + errors[errors.length - 1];
    }
  }

  return { window, errors, missingIds, socketHandlers, emitted, dom, yt };
}

// A genuine state straight out of the engine, so the renderer is fed the real
// shape rather than something hand-written that can drift from it.
function engineState(count, mode, phase) {
  const e = new GameEngine(mode, count);
  const names = ['Alice', 'Bob', 'Charlie', 'Diana', 'Evan', 'Fiona'];
  for (let i = 0; i < count; i++) e.addPlayer('p' + i, names[i]);
  e.startGame();

  if (phase !== 'calling') {
    for (let g = 0; g < 40; g++) {
      const c = e.players.find(p => e._canSubmitCall(p.id));
      if (!c) break;
      e.submitCall(c.id, 2);
    }
  }
  if (phase === 'playing-midtrick') {
    for (let i = 0; i < Math.min(2, count - 1); i++) {
      const pid = e.players[e.currentPlayerSeat].id;
      e.playCard(pid, e.getLegalCards(pid)[0].id);
    }
  }
  if (phase === 'pending' || phase === 'round_end') {
    let guard = 0;
    while (e.phase === 'playing' && guard++ < 500) {
      const pid = e.players[e.currentPlayerSeat].id;
      const legal = e.getLegalCards(pid);
      if (!legal.length) break;
      const res = e.playCard(pid, legal[0].id);
      if (res.pending) {
        if (phase === 'pending') break;
        e.resolvePendingTrick();
      }
    }
  }
  if (phase === 'game_over') {
    e.phase = 'game_over';
  }

  const st = e.getStateForPlayer('p0');
  st.roomCode = 'TEST';
  st.hostId = 'p0';
  st.music = MusicServer.payload({ music: MusicServer.emptyMusic(), musicEnabled: true }, Date.now());
  return st;
}

// A jsdom window keeps its timers running - music.js sets a sync interval - so
// every window must be closed or the test process never exits.
function withClient(fn, opts) {
  const c = bootClient(opts);
  const close = () => { try { c.dom.window.close(); } catch (e) {} };
  let out;
  try {
    out = fn(c);
  } catch (err) {
    close();
    throw err;
  }
  // An async body must keep its window until it finishes, so close on settle.
  if (out && typeof out.then === 'function') return out.then(
    (v) => { close(); return v; },
    (e) => { close(); throw e; },
  );
  close();
  return out;
}

// Both scripts defer their setup to DOMContentLoaded, which jsdom fires after
// the constructor returns - so straight after booting, nothing is wired to a
// button yet. Any test that clicks something has to wait here first.
async function wired(c) {
  for (let i = 0; i < 50 && c.window.document.readyState !== 'complete'; i++) {
    await new Promise(r => setTimeout(r, 10));
  }
  await new Promise(r => setTimeout(r, 0));
}

test("client: the browser scripts load without throwing", () => {
  withClient(c => assert.deepStrictEqual(c.errors, [], "no script threw while loading"));
});

test("client: every element the scripts reach for exists in the markup", () => {
  withClient(c => assert.deepStrictEqual(c.missingIds, [],
    "scripts asked for ids index.html does not contain: " + c.missingIds.join(", ")));
});

test("client: each script finishes and defines what it should", () => {
  withClient(c => {
    const w = c.window;
    // Spread across the files, including statements near the end of each one:
    // if a script dies partway, the later names are simply absent.
    const expected = [
      "socket", "showScreen", "emit",
      "selectedPC", "selectedMode", "selectedMusic",
      "renderConnectionBanner", "isTrumpCard", "fitHand",
      "refreshRejoin", "playTransitionSounds",
      "Sound", "Music",
    ];
    for (const name of expected) {
      assert.notStrictEqual(w.eval("typeof " + name), "undefined", name + " is defined");
    }
    assert.strictEqual(w.eval("typeof Sound.state"), "function", "sound.js ran to completion");
    assert.strictEqual(w.eval("typeof Music.debug"), "function", "music.js ran to completion");
  });
});

test("client: the socket listener is registered", () => {
  withClient(c => assert.strictEqual(typeof c.socketHandlers["game-state"], "function",
    "app.js registered its game-state handler - the bug that hid last time stopped this running"));
});

test("client: can draw every phase, in every mode, without throwing", () => {
  for (const [count, mode] of [[4, "2v2"], [4, "ffa"], [5, "ffa"], [6, "3v3"]]) {
    for (const phase of ["calling", "playing", "playing-midtrick", "pending", "round_end"]) {
      const label = count + "P " + mode + " / " + phase;
      const state = engineState(count, mode, phase);
      withClient(c => {
        assert.deepStrictEqual(c.errors, [], "clean boot for " + label);
        try {
          c.socketHandlers["game-state"](state);
        } catch (err) {
          assert.fail(label + " threw while rendering: " + err.message);
        }
        assert.deepStrictEqual(c.errors, [], label + " raised: " + c.errors.join("; "));
      });
    }
  }
});

test("client: the table renders content, not just an empty shell", () => {
  const state = engineState(4, "ffa", "playing");
  withClient(c => {
    c.socketHandlers["game-state"](state);
    const doc = c.window.document;
    assert.ok(doc.getElementById("screen-game").classList.contains("active"), "switched to the game screen");
    assert.strictEqual(doc.querySelectorAll("#hand .card").length, 13, "thirteen cards in hand");
    assert.strictEqual(doc.querySelectorAll("#seats .seat").length, 3, "the other three seats drawn");
    assert.ok(doc.getElementById("trump-display").textContent.trim().length > 0, "trump is shown");
    assert.ok(/Round 1/.test(doc.getElementById("round-display").textContent), "round is shown");
  });
});

test("client: a disconnected player surfaces in the banner", () => {
  const state = engineState(4, "ffa", "playing");
  state.players[1].connected = false;
  withClient(c => {
    c.socketHandlers["game-state"](state);
    const banner = c.window.document.getElementById("connection-banner");
    assert.notStrictEqual(banner.style.display, "none", "the banner is shown");
    assert.ok(/Bob/.test(banner.textContent), "it names who is missing");
  });
});

test("client: round titles land on the right names, and vanish when off", () => {
  const state = engineState(4, "2v2", "playing");     // teams p0+p2, p1+p3
  state.titles = { rajaBabu: ["p1", "p3"], maichia: ["p0", "p2"] };

  withClient(c => {
    c.socketHandlers["game-state"](state);
    const doc = c.window.document;
    const seats = [...doc.querySelectorAll("#seats .seat")];
    const bannerFor = (name) => {
      const s = seats.find(el => el.querySelector(".seat-name").textContent.includes(name));
      const b = s && s.querySelector(".title-banner");
      return b ? b.textContent : null;
    };
    assert.ok(/Raja Babu/.test(bannerFor("Bob")), "opponent 1 is Raja Babu");
    assert.ok(/Raja Babu/.test(bannerFor("Diana")), "and so is their teammate");
    assert.ok(/Maichia/.test(bannerFor("Charlie")), "your teammate is Maichia");
    assert.ok(/Maichia/.test(doc.getElementById("your-info").textContent), "and so are you");
    assert.deepStrictEqual(c.errors, []);
  });

  // The server sends titles: null when the room has them off.
  const off = engineState(4, "2v2", "playing");
  off.titles = null;
  withClient(c => {
    c.socketHandlers["game-state"](off);
    assert.strictEqual(c.window.document.querySelectorAll(".title-banner").length, 0, "no banners at all");
  });
});

test("client: headphones show who has joined the music", () => {
  const room = { music: MusicServer.emptyMusic(), musicEnabled: true };
  MusicServer.setTrack(room, "dQw4w9WgXcQ", "p0", Date.now());
  MusicServer.setListening(room, "p0", true);
  MusicServer.setListening(room, "p2", true);
  const state = engineState(4, "ffa", "playing");
  state.music = MusicServer.payload(room, Date.now());

  withClient(c => {
    c.socketHandlers["game-state"](state);
    const doc = c.window.document;
    const seatHas = (name) => {
      const s = [...doc.querySelectorAll("#seats .seat-name")].find(el => el.textContent.includes(name));
      return !!(s && s.querySelector(".listening"));
    };
    assert.ok(seatHas("Charlie"), "Charlie joined: 🎧");
    assert.ok(!seatHas("Bob"), "Bob did not");
    assert.ok(!seatHas("Diana"), "nor Diana");
    assert.ok(doc.querySelector("#your-info .listening"), "you joined, and see it on your own name");
    assert.strictEqual(doc.getElementById("music-listeners").textContent, "🎧 2 of 4 listening");
    const who = doc.getElementById("music-who").textContent;
    assert.ok(/Not listening:.*Bob.*Diana/.test(who), "the overlay names who can't hear: " + who);
    assert.deepStrictEqual(c.errors, []);
  });

  // No track, no headphones: listening to nothing means nothing.
  const quiet = engineState(4, "ffa", "playing");
  const q = { music: MusicServer.emptyMusic(), musicEnabled: true };
  MusicServer.setListening(q, "p2", true);
  quiet.music = MusicServer.payload(q, Date.now());
  withClient(c => {
    c.socketHandlers["game-state"](quiet);
    assert.strictEqual(c.window.document.querySelectorAll(".listening").length, 0);
  });
});

test("client: joining and leaving tell the room, and nothing else", async () => {
  const room = { music: MusicServer.emptyMusic(), musicEnabled: true };
  MusicServer.setTrack(room, "dQw4w9WgXcQ", "p1", Date.now());
  const state = () => {
    const s = engineState(4, "ffa", "playing");
    s.music = MusicServer.payload(room, Date.now());
    return s;
  };

  return withClient(async c => {
    const doc = c.window.document;
    const presence = () => c.emitted.filter(e => e.ev === "music-presence").map(e => e.data.listening);
    await wired(c);
    c.window.localStorage.removeItem("tcr_music_out");
    c.socketHandlers["game-state"](state());
    assert.deepStrictEqual(presence(), [], "not joined yet, and the server agrees: silence");

    doc.getElementById("music-join").click();
    assert.deepStrictEqual(presence(), [true], "joining is announced");

    MusicServer.setListening(room, "p0", true);            // the server takes note and rebroadcasts
    c.socketHandlers["game-state"](state());
    assert.deepStrictEqual(presence(), [true], "and not repeated once the server agrees");

    doc.getElementById("music-leave").click();
    assert.deepStrictEqual(presence(), [true, false], "leaving is announced, once");
    assert.deepStrictEqual(c.emitted.filter(e => e.ev === "music-control"), [],
      "and still never pauses anyone else");
  });
});

// Dropping out has to be strictly personal. If it ever reached the server it
// would pause the track for the whole table, which is the opposite of the point.
test("client: a player can drop out of the music on their own", async () => {
  const room = { music: MusicServer.emptyMusic(), musicEnabled: true };
  MusicServer.setTrack(room, "dQw4w9WgXcQ", "p0", Date.now());
  const state = engineState(4, "ffa", "playing");
  state.music = MusicServer.payload(room, Date.now());

  return withClient(async c => {
    const doc = c.window.document;
    await wired(c);
    c.socketHandlers["game-state"](state);

    doc.getElementById("music-leave").click();
    assert.strictEqual(c.window.eval("Music.debug().optedOut"), true, "the client knows it is out");
    assert.strictEqual(doc.getElementById("music-card").style.display, "none",
      "the card is gone from their table entirely");
    assert.ok(doc.getElementById("music-toggle-btn").classList.contains("off"),
      "the corner button shows they are out, and is still there to come back through");
    assert.strictEqual(doc.getElementById("music-me-btn").textContent, "Join the music",
      "the overlay offers the way back in");
    assert.deepStrictEqual(c.emitted.filter(e => e.ev === "music-control"), [],
      "leaving told the server nothing - everyone else keeps listening");

    doc.getElementById("music-me-btn").click();
    assert.strictEqual(c.window.eval("Music.debug().optedOut"), false, "and can come back");
    assert.strictEqual(doc.getElementById("music-card").style.display, "block", "the card returns");
    assert.strictEqual(doc.getElementById("music-me-btn").textContent, "Leave the music",
      "and can leave again");
    assert.deepStrictEqual(c.emitted.filter(e => e.ev === "music-control"), [],
      "rejoining is just as quiet");
    assert.deepStrictEqual(c.errors, [], "no error either way");
  });
});

// Opting out has to work before anything is playing, or the only way to say
// "not for me" is to wait for someone else to start a track first.
test("client: opting out up front keeps a later track off your table", async () => {
  const quiet = engineState(4, "ffa", "playing");   // music enabled, nothing set

  const room = { music: MusicServer.emptyMusic(), musicEnabled: true };
  MusicServer.setTrack(room, "dQw4w9WgXcQ", "p0", Date.now());
  const withTrack = engineState(4, "ffa", "playing");
  withTrack.music = MusicServer.payload(room, Date.now());

  return withClient(async c => {
    const doc = c.window.document;
    await wired(c);
    c.socketHandlers["game-state"](quiet);

    doc.getElementById("music-me-btn").click();      // out, with nothing playing
    assert.strictEqual(c.window.eval("Music.debug().optedOut"), true, "out before it starts");

    c.socketHandlers["game-state"](withTrack);       // somebody starts a track
    assert.strictEqual(doc.getElementById("music-card").style.display, "none",
      "it never appears for them");
    assert.deepStrictEqual(c.emitted.filter(e => e.ev === "music-set"), [],
      "and they interfered with nobody");
    assert.deepStrictEqual(c.errors, []);
  });
});

test("client: music state drives the player card", () => {
  const room = { music: MusicServer.emptyMusic(), musicEnabled: true };
  MusicServer.setTrack(room, "dQw4w9WgXcQ", "p0", Date.now());
  const on = engineState(4, "ffa", "playing");
  on.music = MusicServer.payload(room, Date.now());
  withClient(c => {
    c.socketHandlers["game-state"](on);
    assert.strictEqual(c.window.document.getElementById("music-card").style.display, "block",
      "the card appears when a track is set");
    assert.deepStrictEqual(c.errors, [], "no error while wiring the player up");
  });

  const off = engineState(4, "ffa", "playing");
  off.music = MusicServer.payload({ music: MusicServer.emptyMusic(), musicEnabled: false }, Date.now());
  withClient(c => {
    c.socketHandlers["game-state"](off);
    assert.strictEqual(c.window.document.getElementById("music-toggle-btn").style.display, "none",
      "the music button is hidden when the room has it off");
  });
});

// ---- phones, blocked playback, and the way back in ------------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A room with a track playing, and whoever the server believes is listening.
function musicRoom(listeners) {
  const room = { music: MusicServer.emptyMusic(), musicEnabled: true };
  MusicServer.setTrack(room, "dQw4w9WgXcQ", "p1", Date.now());
  for (const pid of listeners || []) MusicServer.setListening(room, pid, true);
  return room;
}
function stateFor(room) {
  const s = engineState(4, "ffa", "playing");
  s.music = MusicServer.payload(room, Date.now());
  return s;
}
const presenceOf = (c) => c.emitted.filter(e => e.ev === "music-presence").map(e => e.data.listening);
const debugOf = (c) => c.window.eval("Music.debug()");

// An iPhone refuses to let our join button start the sound: the player sits
// CUED. If we believed our own playVideo() the table would show a 🎧 by
// someone hearing nothing, and they would never be told to tap the video. The
// join itself may announce "listening" before the check runs - what matters is
// that once the block is spotted, the room is corrected.
test("client: a browser that refuses to play is caught, and the 🎧 is withdrawn", async () => {
  const room = musicRoom();
  return withClient(async c => {
    const doc = c.window.document;
    await wired(c);
    c.yt.state = 5;                                        // CUED: the browser said no
    c.socketHandlers["game-state"](stateFor(room));

    doc.getElementById("music-join").click();
    assert.ok(!doc.getElementById("music-card").classList.contains("needs-tap"),
      "not judged blocked the instant the button is pressed");
    await sleep(1650);                                     // past BLOCKED_CHECK_MS

    const card = doc.getElementById("music-card");
    assert.ok(card.classList.contains("needs-tap"), "the card asks for a tap once playback failed to start");
    assert.strictEqual(doc.getElementById("music-note").textContent, "Tap ▶ on the video to start the music",
      "and says so in words");
    assert.strictEqual(doc.getElementById("music-join").style.display, "none",
      "the join overlay stays out of the way so the video itself can be tapped");
    assert.strictEqual(debugOf(c).listening, false, "the client knows it cannot hear anything");

    // The server heard the join and now lists p0 as listening.
    const before = presenceOf(c).length;
    MusicServer.setListening(room, "p0", true);
    c.socketHandlers["game-state"](stateFor(room));
    assert.deepStrictEqual(presenceOf(c).slice(before), [false],
      "the client corrects the server: blocked is not listening");
    assert.ok(card.classList.contains("needs-tap"), "and a fresh state does not paper over the block");
    assert.deepStrictEqual(c.emitted.filter(e => e.ev === "music-control"), [], "nobody else was paused");
    assert.deepStrictEqual(c.errors, []);
  });
});

// The sync loop is the other way a block is found - and the one that catches
// an iPhone whose screen was locked mid-song. Each pass asks the player to play;
// two refusals in a row mean we are blocked. The tap on the video is then the
// only thing that can start it, and it has to clear the prompt and bring the 🎧
// back, or a player who did everything right still shows as deaf.
test("client: tapping the video after a block starts the music and restores the 🎧", async () => {
  const room = musicRoom();
  return withClient(async c => {
    const doc = c.window.document;
    const card = doc.getElementById("music-card");
    await wired(c);
    c.socketHandlers["game-state"](stateFor(room));
    doc.getElementById("music-join").click();              // announced true
    MusicServer.setListening(room, "p0", true);
    c.socketHandlers["game-state"](stateFor(room));

    c.yt.state = 2;                                        // paused under us (screen lock)
    c.socketHandlers["game-state"](stateFor(room));        // each state runs sync once
    assert.ok(!card.classList.contains("needs-tap"), "one refusal is not yet a block");
    c.socketHandlers["game-state"](stateFor(room));
    assert.ok(card.classList.contains("needs-tap"), "two refusals are");
    assert.deepStrictEqual(presenceOf(c), [true, false], "and the room is told they dropped out");

    MusicServer.setListening(room, "p0", false);           // server takes note
    c.socketHandlers["game-state"](stateFor(room));
    assert.deepStrictEqual(presenceOf(c), [true, false], "no repeat once the server agrees");

    c.yt.state = 1;                                        // the user taps play on the video
    c.yt.onStateChange({ data: 1 });
    assert.ok(!card.classList.contains("needs-tap"), "the tap prompt goes");
    assert.strictEqual(doc.getElementById("music-note").textContent, "", "the note clears");
    assert.strictEqual(debugOf(c).listening, true, "they are listening again");
    assert.deepStrictEqual(presenceOf(c), [true, false, true], "and the room hears it straight away");
    assert.deepStrictEqual(c.errors, []);
  });
});

// The same tap is how an iPhone user joins without ever pressing our button:
// it has to count as joining, not leave them marked as outside the music.
test("client: a tap on the video with no join first still counts as joining", async () => {
  const room = musicRoom();
  return withClient(async c => {
    await wired(c);
    c.socketHandlers["game-state"](stateFor(room));
    assert.strictEqual(debugOf(c).started, false, "not joined yet");
    c.yt.onStateChange({ data: 1 });
    assert.strictEqual(debugOf(c).started, true, "the tap joined them");
    assert.strictEqual(c.window.document.getElementById("music-join").style.display, "none",
      "and the join overlay is gone");
    assert.deepStrictEqual(presenceOf(c), [true], "the room is told");
  });
});

// The check must not cry wolf: on a desktop (or any phone that allows it) the
// track plays, and a "tap the video" prompt would be confusing noise.
test("client: when playback works, joining never asks for a tap", async () => {
  const room = musicRoom();
  return withClient(async c => {
    const doc = c.window.document;
    await wired(c);
    c.socketHandlers["game-state"](stateFor(room));
    doc.getElementById("music-join").click();
    await sleep(1650);
    assert.ok(!doc.getElementById("music-card").classList.contains("needs-tap"), "no tap prompt");
    assert.strictEqual(doc.getElementById("music-note").textContent, "", "no note");
    assert.strictEqual(debugOf(c).listening, true, "listening");
    assert.deepStrictEqual(presenceOf(c), [true], "announced once, never withdrawn");
  });
});

// Someone who left the music still needs to know it is on and to get back in
// with one tap - without the video taking up their table. The chip is that, and
// coming back through it must be as private as leaving was.
test("client: after opting out, a chip shows the music is on and brings you back", async () => {
  const room = musicRoom(["p1", "p2"]);
  await withClient(async c => {
    const doc = c.window.document;
    const chip = doc.getElementById("music-chip");
    const card = doc.getElementById("music-card");
    await wired(c);
    c.socketHandlers["game-state"](stateFor(room));

    assert.strictEqual(debugOf(c).optedOut, true, "the choice from last visit was remembered");
    assert.strictEqual(chip.style.display, "flex", "the chip is shown");
    assert.strictEqual(card.style.display, "none", "the video card is not");
    assert.strictEqual(doc.getElementById("music-chip-count").textContent, "2 listening",
      "the chip says how many are listening");
    assert.deepStrictEqual(presenceOf(c), [], "an opted-out player claims nothing");

    chip.click();
    assert.strictEqual(debugOf(c).optedOut, false, "one tap and they are back in");
    assert.strictEqual(c.window.localStorage.getItem("tcr_music_out"), null, "and it is remembered");
    assert.strictEqual(chip.style.display, "none", "the chip goes");
    assert.strictEqual(card.style.display, "block", "the card returns");
    assert.strictEqual(debugOf(c).listening, true, "listening");
    assert.deepStrictEqual(presenceOf(c), [true], "the room is told they joined");
    assert.deepStrictEqual(c.emitted.filter(e => e.ev === "music-control"), [],
      "and nobody else's playback was touched");
    assert.deepStrictEqual(c.errors, []);
  }, { optedOut: true });

  // Nobody listening yet: the chip still says the music exists.
  await withClient(async c => {
    await wired(c);
    c.socketHandlers["game-state"](stateFor(musicRoom()));
    assert.strictEqual(c.window.document.getElementById("music-chip-count").textContent, "Music on");
    assert.strictEqual(c.window.document.getElementById("music-chip").style.display, "flex");
  }, { optedOut: true });

  // Opting out by the x on the card lands in the same place.
  await withClient(async c => {
    const doc = c.window.document;
    await wired(c);
    c.socketHandlers["game-state"](stateFor(musicRoom()));
    assert.strictEqual(doc.getElementById("music-chip").style.display, "none", "no chip while you are in");
    doc.getElementById("music-leave").click();
    assert.strictEqual(doc.getElementById("music-chip").style.display, "flex", "leaving brings up the chip");
    assert.strictEqual(doc.getElementById("music-card").style.display, "none");
  });
});

// A chip reading "Join" with nothing to join would be a dead button.
test("client: with no track, neither the chip nor the card shows", async () => {
  return withClient(async c => {
    const doc = c.window.document;
    await wired(c);
    c.socketHandlers["game-state"](stateFor(musicRoom()));
    assert.strictEqual(doc.getElementById("music-chip").style.display, "flex", "chip up while a track plays");

    c.socketHandlers["game-state"](engineState(4, "ffa", "playing"));   // track stopped
    assert.strictEqual(doc.getElementById("music-chip").style.display, "none", "the chip goes with the track");
    assert.strictEqual(doc.getElementById("music-card").style.display, "none", "and no card either");
    assert.strictEqual(debugOf(c).optedOut, true, "they are still opted out for next time");
  }, { optedOut: true });
});

// Music used to be desktop-only. A phone - no hover, coarse pointer, narrow -
// must now get the card like anyone else. (jsdom does not apply CSS media
// queries, so this checks only what the scripts do.)
test("client: a touch-only phone takes part in the music", async () => {
  const room = musicRoom();
  return withClient(async c => {
    const doc = c.window.document;
    assert.strictEqual(c.window.matchMedia("(hover: hover)").matches, false, "the stub really is a phone");
    assert.strictEqual(c.window.innerWidth, 375, "a narrow one");
    await wired(c);
    c.socketHandlers["game-state"](stateFor(room));
    assert.strictEqual(doc.getElementById("music-card").style.display, "block", "the card is shown");
    assert.notStrictEqual(doc.getElementById("music-toggle-btn").style.display, "none",
      "and the music button is not hidden by script");
    doc.getElementById("music-join").click();
    assert.strictEqual(debugOf(c).listening, true, "joining works");
    assert.deepStrictEqual(presenceOf(c), [true]);
    assert.deepStrictEqual(c.errors, []);
  }, { touch: true });
});
