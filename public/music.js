// Shared YouTube playback.
//
// The server owns a logical playback clock - which video, whether it is
// running, and what position it was at when it last changed. Every client works
// out where the track *should* be from that, compares it with where their
// player actually is, and seeks when they have drifted too far. Nobody's player
// is the source of truth, so a player that stalls, buffers or sits through an
// ad rejoins the others instead of dragging everyone with it.
//
// Two things are outside our control and worth knowing: an ad interrupts only
// the person watching it, and iOS stops playback when the screen locks.
//
// Phones and tablets take part too. The catch is that browsers - iOS Safari
// hardest of all - may refuse to start sound unless the tap lands on the video
// itself, and a button of ours does not count. So instead of assuming our
// playVideo() worked, we watch: if the track should be playing and ours still
// isn't a moment later, we are blocked, and we ask for a tap on the video.
// Locking an iPhone and coming back lands in exactly the same state.
const Music = (() => {
  const DRIFT_TOLERANCE_S = 1.5;   // below this, seeking is more disruptive than the drift
  const SYNC_INTERVAL_MS = 3000;
  const SETTLE_MS = 2500;          // ignore drift right after a seek or a state change
  const BLOCKED_CHECK_MS = 1500;   // how long a started track may take before we call it blocked

  let player = null;
  let apiLoading = false;
  let apiReady = false;
  let current = null;              // the room's music state, as last broadcast
  let loadedVideoId = null;
  let started = false;             // has this browser been allowed to play audio
  let skewMs = 0;                  // serverClock - localClock
  let lastNudge = 0;
  let volume = clampVolume(localStorage.getItem('tcr_music_vol'));
  // Dropping out is personal and local: nothing is sent to the server, so the
  // track keeps playing for everyone else. It is remembered because somebody who
  // does not want music now will not want it after the next reload either.
  let optedOut = localStorage.getItem('tcr_music_out') === '1';
  // Joined, but the browser would not let our code start the sound: waiting for
  // a tap on the video. Counts as not listening, so the 🎧 tells the truth.
  let needsTap = false;
  let stuckTicks = 0;

  function clampVolume(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 35;
  }

  const $m = (id) => document.getElementById(id);

  // ---- clock ---------------------------------------------------------------
  // Local clocks differ from the server's by seconds sometimes, which would
  // wreck the position maths. Sample the round trip a few times and take the
  // median, which throws out the worst of the jitter.
  async function measureSkew(rounds) {
    const samples = [];
    for (let i = 0; i < (rounds || 5); i++) {
      const sent = Date.now();
      const res = await new Promise(r => socket.emit('music-time', {}, x => r(x || {})));
      const back = Date.now();
      if (typeof res.serverNow === 'number') {
        samples.push(res.serverNow + (back - sent) / 2 - back);
      }
      await new Promise(r => setTimeout(r, 100));
    }
    if (!samples.length) return;
    samples.sort((a, b) => a - b);
    skewMs = samples[Math.floor(samples.length / 2)];
  }

  const serverNow = () => Date.now() + skewMs;

  function targetSeconds(m) {
    if (!m || !m.videoId) return 0;
    if (!m.playing) return m.offsetSec;
    return m.offsetSec + (serverNow() - m.startedAtMs) / 1000;
  }

  // ---- the YouTube player --------------------------------------------------
  function loadApi() {
    if (apiReady || apiLoading) return;
    if (window.YT && window.YT.Player) { apiReady = true; apply(); return; }
    apiLoading = true;
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      apiReady = true;
      if (typeof prev === 'function') prev();
      apply();
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  }

  function createPlayer(videoId) {
    const host = $m('yt-player');
    if (!host) return;
    loadedVideoId = videoId;
    player = new YT.Player('yt-player', {
      width: '100%',
      height: '100%',
      videoId,
      playerVars: {
        autoplay: 0, controls: 1, disablekb: 1,
        modestbranding: 1, playsinline: 1, rel: 0,
      },
      events: {
        // Take the player from the event: the assignment below has not
        // happened yet if onReady fires during construction.
        onReady: (e) => {
          player = player || (e && e.target);
          if (player && player.setVolume) player.setVolume(volume);
          render(); sync();
        },
        onStateChange: (e) => {
          lastNudge = Date.now();
          // Playing - whether our code started it or a tap on the video did.
          // On an iPhone the tap is the only thing allowed to, so it counts
          // as joining.
          if (e && e.data === YT.PlayerState.PLAYING) {
            if (!started && !optedOut) started = true;
            stuckTicks = 0;
            needsTap = false;
          }
          render();
        },
        onError: () => {
          const note = $m('music-note');
          if (note) note.textContent = 'That video will not play embedded. Try another link.';
        },
      },
    });
  }

  // Bring the local player into line with the room.
  function sync() {
    if (!player || !player.getPlayerState || !current || !current.videoId) return;
    if (!started || optedOut) return;

    let state;
    try { state = player.getPlayerState(); } catch (e) { return; }

    if (!current.playing) {
      if (state === YT.PlayerState.PLAYING) player.pauseVideo();
      stuckTicks = 0;
      return;
    }
    if (state !== YT.PlayerState.PLAYING) {
      if (state !== YT.PlayerState.BUFFERING) {
        player.playVideo();
        // Asked twice and still not playing: the browser is refusing us.
        if (++stuckTicks >= 2 && !needsTap) { needsTap = true; render(); }
      }
      return;                      // never chase position while buffering
    }
    stuckTicks = 0;
    if (needsTap) { needsTap = false; render(); }
    // An ad or a fresh seek reports a position that is not the track's, so let
    // things settle before judging drift.
    if (Date.now() - lastNudge < SETTLE_MS) return;

    let actual;
    try { actual = player.getCurrentTime(); } catch (e) { return; }
    const target = targetSeconds(current);
    if (target < 0) return;
    if (Math.abs(target - actual) > DRIFT_TOLERANCE_S) {
      lastNudge = Date.now();
      player.seekTo(target, true);
    }
  }

  // Reconcile the DOM and the player with the room's music state.
  function apply() {
    const card = $m('music-card');
    const chip = $m('music-chip');
    if (!card) return;

    if (!current || !current.videoId) {
      card.style.display = 'none';
      if (chip) chip.style.display = 'none';
      loadedVideoId = null;
      needsTap = false;
      if (player && player.stopVideo) { try { player.stopVideo(); } catch (e) {} }
      return;
    }

    if (optedOut) {
      // No video on their table and the API never loaded for them - just a
      // small chip saying the others are listening, as the way back in. Pause
      // rather than stop a player built before they left, so coming back only
      // has to seek instead of rebuilding an iframe.
      card.style.display = 'none';
      if (chip) chip.style.display = 'flex';
      if (player && player.pauseVideo) { try { player.pauseVideo(); } catch (e) {} }
      render();
      return;
    }

    if (chip) chip.style.display = 'none';
    card.style.display = 'block';
    loadApi();
    if (!apiReady) return;

    if (!player) { createPlayer(current.videoId); return; }
    if (loadedVideoId !== current.videoId) {
      loadedVideoId = current.videoId;
      lastNudge = Date.now();
      const at = Math.max(0, targetSeconds(current));
      // loadVideoById starts playing; cueVideoById does not. Only autoplay once
      // this browser has already been allowed to make noise.
      if (started) player.loadVideoById({ videoId: current.videoId, startSeconds: at });
      else player.cueVideoById({ videoId: current.videoId, startSeconds: at });
      render();
      return;
    }
    sync();
    render();
  }

  function render() {
    const joinBtn = $m('music-join');
    const playBtn = $m('music-playpause');
    const note = $m('music-note');
    renderMe();
    reportPresence();
    if (!joinBtn) return;
    if (optedOut) return;

    joinBtn.style.display = started ? 'none' : 'flex';
    if (playBtn) playBtn.textContent = current && current.playing ? '⏸' : '▶';
    const card = $m('music-card');
    // While blocked, the video must be tappable, and the tap must be asked for.
    if (card) card.classList.toggle('needs-tap', needsTap);
    if (note && started) {
      note.textContent = needsTap ? 'Tap ▶ on the video to start the music'
        : current && current.playing ? '' : 'Paused for everyone';
    }
  }

  // Straight after a join, check whether the sound actually started. If the
  // browser refused, ask for a tap on the video now rather than two sync
  // ticks from now.
  function checkBlocked() {
    setTimeout(() => {
      if (!player || !player.getPlayerState || !started || optedOut) return;
      if (!current || !current.playing) return;
      let state;
      try { state = player.getPlayerState(); } catch (e) { return; }
      if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING) {
        needsTap = true;
        render();
      }
    }, BLOCKED_CHECK_MS);
  }

  // The overlay row that says where *you* stand, independent of the room.
  function renderMe() {
    const openBtn = $m('music-toggle-btn');
    const status = $m('music-me-status');
    const btn = $m('music-me-btn');
    if (openBtn) {
      openBtn.classList.toggle('off', optedOut);
      openBtn.title = optedOut ? 'Music is off for you - click to join back' : 'Shared music';
    }
    if (status) {
      status.textContent = optedOut
        ? 'Music is off for you. The others can still hear it.'
        : "You are in. Leaving only affects you - it won't stop anyone else's.";
    }
    if (btn) btn.textContent = optedOut ? 'Join the music' : 'Leave the music';
  }

  function setOptedOut(value) {
    optedOut = value;
    if (value) localStorage.setItem('tcr_music_out', '1');
    else localStorage.removeItem('tcr_music_out');
    apply();
    renderMe();
    reportPresence();
  }

  // ---- presence ------------------------------------------------------------
  // Tell the room whether this player has their music on, so a 🎧 shows by
  // their name. Rather than firing on each click, compare what we are doing
  // with what the server last said and correct it when they differ - which
  // also heals itself after a reconnect or a server restart wiped the list.
  let lastMusic = null;
  let myId = null;
  let presenceSent = null;   // what we last told the server, until a broadcast confirms it

  // Blocked waiting for a tap is not listening: the 🎧 should mean sound.
  const listeningNow = () => started && !optedOut && !needsTap;

  function reportPresence() {
    if (!lastMusic || lastMusic.enabled === false || !myId) return;
    const serverThinks = (lastMusic.listeners || []).includes(myId);
    const actual = listeningNow();
    if (serverThinks === actual) { presenceSent = null; return; }
    // Already said so and the broadcast is on its way. Clearing this on the ack
    // instead would re-send in the gap between the ack and the broadcast.
    if (presenceSent === actual) return;
    presenceSent = actual;
    socket.emit('music-presence', { listening: actual }, (res) => {
      if (!res || res.error) presenceSent = null;   // refused: free to try again
    });
  }

  function onState(music, playerId) {
    lastMusic = music || null;
    if (playerId) myId = playerId;
    reportPresence();
    const openBtn = $m('music-toggle-btn');
    if (music && music.enabled === false) {
      // The host turned it off for this room: leave no trace of it.
      current = null;
      if (openBtn) openBtn.style.display = 'none';
      apply();
      return;
    }
    if (openBtn) openBtn.style.display = '';
    current = music || null;
    apply();
    renderMe();   // apply() returns early when nothing is playing
  }

  // ---- wiring --------------------------------------------------------------
  function init() {
    const openBtn = $m('music-toggle-btn');
    const overlay = $m('music-overlay');
    const input = $m('music-url');
    const setBtn = $m('music-set');
    const closeBtn = $m('music-close');
    const stopBtn = $m('music-stop');
    const joinBtn = $m('music-join');
    const playBtn = $m('music-playpause');
    const resyncBtn = $m('music-resync');
    const vol = $m('music-volume');
    const err = $m('music-error');

    if (openBtn && overlay) {
      openBtn.addEventListener('click', () => {
        overlay.style.display = 'flex';
        if (err) err.textContent = '';
        if (input) input.focus();
      });
    }
    if (closeBtn) closeBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
    if (overlay) {
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
    }

    async function setTrack() {
      const url = input ? input.value.trim() : '';
      if (!url) return;
      setBtn.disabled = true;
      const res = await new Promise(r => socket.emit('music-set', { url }, x => r(x || {})));
      setBtn.disabled = false;
      if (res.error) { if (err) err.textContent = res.error; return; }
      // Setting a track is a gesture, so this browser may start playing now -
      // and choosing one plainly means you want to hear it, so it un-drops you.
      started = true;
      if (optedOut) setOptedOut(false);
      if (err) err.textContent = '';
      if (input) input.value = '';
      overlay.style.display = 'none';
    }
    if (setBtn) setBtn.addEventListener('click', setTrack);
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') setTrack(); });

    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        socket.emit('music-control', { action: 'stop' }, () => {});
        overlay.style.display = 'none';
      });
    }

    // Browsers will not start audio on their own, so each player opts in once.
    // If this browser still refuses (iPhones), checkBlocked asks for a tap on
    // the video instead.
    if (joinBtn) {
      joinBtn.addEventListener('click', () => {
        started = true;
        lastNudge = Date.now();
        if (player && current) {
          const at = Math.max(0, targetSeconds(current));
          try { player.seekTo(at, true); player.playVideo(); } catch (e) {}
        }
        render();
        checkBlocked();
      });
    }

    // Joining and leaving are local only - no socket traffic, so the rest of the
    // table never notices. Pausing for *everyone* is the ⏸ button, deliberately
    // somewhere else.
    function joinMe() {
      started = true;            // the click is the gesture that allows audio
      lastNudge = Date.now();
      setOptedOut(false);
      if (player && current) {
        const at = Math.max(0, targetSeconds(current));
        try { player.seekTo(at, true); if (current.playing) player.playVideo(); } catch (e) {}
      }
      checkBlocked();
    }
    const leaveBtn = $m('music-leave');
    const meBtn = $m('music-me-btn');
    // The chip is what someone who left sees while others listen: one tap back in.
    const chip = $m('music-chip');
    if (chip) chip.addEventListener('click', joinMe);
    // ✕ on the card: the quick way out while a track is playing.
    if (leaveBtn) leaveBtn.addEventListener('click', () => setOptedOut(true));
    // The overlay row: works either way, and whether or not anything is playing,
    // so somebody can opt out before the first track is ever set.
    if (meBtn) {
      meBtn.addEventListener('click', () => {
        if (optedOut) joinMe();
        else setOptedOut(true);
      });
    }

    if (playBtn) {
      playBtn.addEventListener('click', () => {
        started = true;
        const action = current && current.playing ? 'pause' : 'play';
        socket.emit('music-control', { action }, () => {});
      });
    }

    if (resyncBtn) {
      resyncBtn.addEventListener('click', async () => {
        await measureSkew(5);
        lastNudge = 0;
        started = true;
        sync();
        reportPresence();
      });
    }

    if (vol) {
      vol.value = String(volume);
      vol.addEventListener('input', () => {
        volume = clampVolume(vol.value);
        localStorage.setItem('tcr_music_vol', String(volume));
        if (player && player.setVolume) { try { player.setVolume(volume); } catch (e) {} }
      });
    }

    renderMe();   // a choice remembered from last time shows straight away
    measureSkew(5);
    setInterval(sync, SYNC_INTERVAL_MS);
    // Coming back from a locked screen or another app is exactly when drift is
    // worst, so re-measure and correct straight away.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { measureSkew(3).then(sync); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return {
    onState,
    // Diagnostics: skew and drift are the things that go wrong here.
    debug: () => ({
      skewMs,
      started,
      optedOut,
      needsTap,
      listening: listeningNow(),
      videoId: current && current.videoId,
      playing: current && current.playing,
      target: current ? targetSeconds(current) : null,
      actual: player && player.getCurrentTime ? (() => { try { return player.getCurrentTime(); } catch (e) { return null; } })() : null,
    }),
  };
})();
