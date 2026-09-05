// Synthesized sound effects. No audio files: every cue is generated with the
// Web Audio API, so there is nothing to download and nothing to license.
const Sound = (() => {
  let ctx = null;
  let master = null;
  let enabled = localStorage.getItem('tcr_sound') !== 'off';

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.3;
      master.connect(ctx.destination);
    }
    // resume() can reject when called without user activation; that is fine,
    // the next gesture tries again.
    if (ctx.state !== 'running') { try { ctx.resume(); } catch (e) { /* retried later */ } }
    return ctx;
  }

  // Browsers keep audio suspended until the user interacts with the page. A
  // single attempt is not enough: the context can be created suspended by a cue
  // that fires before anyone has touched the screen, and one resume() that does
  // not take would then leave the whole session silent. So keep listening until
  // the context is genuinely running, and listen in the capture phase so a
  // handler calling stopPropagation cannot swallow the gesture.
  const GESTURES = ['pointerdown', 'touchend', 'keydown'];
  function unlock() {
    const c = ensure();
    if (c && c.state === 'running') {
      for (const g of GESTURES) window.removeEventListener(g, unlock, true);
    }
  }
  for (const g of GESTURES) window.addEventListener(g, unlock, true);

  function tone({ freq, to, type = 'sine', dur = 0.2, delay = 0, gain = 0.3 }) {
    const c = enabled ? ensure() : null;
    if (!c) return;
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  // Filtered noise burst - the papery "fwip" of a card hitting the table.
  function noise({ freq = 2000, q = 1, dur = 0.09, delay = 0, gain = 0.3 }) {
    const c = enabled ? ensure() : null;
    if (!c) return;
    const t0 = c.currentTime + delay;
    const len = Math.max(1, Math.ceil(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(bp);
    bp.connect(g);
    g.connect(master);
    src.start(t0);
  }

  return {
    isEnabled: () => enabled,
    // Diagnostic: tells apart "muted by the user" from "the browser has not
    // unlocked audio yet".
    state: () => ({
      enabled,
      context: ctx ? ctx.state : 'not-created',
      stored: localStorage.getItem('tcr_sound'),
    }),
    toggle() {
      enabled = !enabled;
      localStorage.setItem('tcr_sound', enabled ? 'on' : 'off');
      if (enabled) { ensure(); tone({ freq: 880, dur: 0.12, gain: 0.25 }); }
      return enabled;
    },

    cardPlay() {
      noise({ freq: 1800, q: 0.8, dur: 0.08, gain: 0.35 });
      tone({ freq: 190, to: 120, dur: 0.09, type: 'sine', gain: 0.22 });
    },

    deal(count = 6) {
      for (let i = 0; i < count; i++) {
        noise({ freq: 1900, q: 0.9, dur: 0.07, delay: i * 0.075, gain: 0.26 });
      }
    },

    trumpReveal() {
      tone({ freq: 240, to: 720, type: 'triangle', dur: 0.34, gain: 0.24 });
      [523.25, 659.25, 783.99].forEach((f, i) => {
        tone({ freq: f, type: 'triangle', dur: 0.5, delay: 0.3 + i * 0.02, gain: 0.14 });
      });
    },

    yourTurn() {
      tone({ freq: 659.25, type: 'sine', dur: 0.14, gain: 0.2 });
      tone({ freq: 880, type: 'sine', dur: 0.22, delay: 0.1, gain: 0.2 });
    },

    callMade() {
      tone({ freq: 784, type: 'sine', dur: 0.1, gain: 0.18 });
    },

    // Rising arpeggio - you or your team took the trick.
    trickWin() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        tone({ freq: f, type: 'triangle', dur: 0.22, delay: i * 0.055, gain: 0.2 });
      });
    },

    // Deliberately quiet and neutral: this one fires most of the time.
    trickLose() {
      tone({ freq: 300, to: 220, type: 'sine', dur: 0.18, gain: 0.14 });
    },

    roundEnd() {
      [523.25, 659.25, 783.99].forEach((f, i) => {
        tone({ freq: f, type: 'triangle', dur: 0.7, delay: i * 0.05, gain: 0.16 });
      });
    },

    gameOver() {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => {
        tone({ freq: f, type: 'triangle', dur: 0.28, delay: i * 0.13, gain: 0.22 });
      });
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        tone({ freq: f, type: 'triangle', dur: 1.1, delay: 0.55 + i * 0.03, gain: 0.16 });
      });
    },
  };
})();
