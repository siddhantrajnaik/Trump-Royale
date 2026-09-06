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
function fakeYT() {
  return {
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    Player: function PlayerStub(_id, opts) {
      this._t = 0;
      this.getPlayerState = () => 1;
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
function bootClient() {
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
  window.YT = fakeYT();
  // Desktop, so the music module takes its full path rather than standing down.
  window.matchMedia = (q) => ({
    matches: /hover: hover|pointer: fine/.test(q),
    media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });

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

  return { window, errors, missingIds, socketHandlers, emitted, dom };
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
function withClient(fn) {
  const c = bootClient();
  try { return fn(c); } finally { try { c.dom.window.close(); } catch (e) {} }
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
