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
const Music = (() => {
  // Desktop only. On a phone the layout has no room for a video, and iOS stops
  // playback the moment the screen locks or you switch apps - which is most of
  // a card game. Mobile players simply do not take part in the music.
  const IS_DESKTOP = window.matchMedia("(hover: hover) and (pointer: fine)").matches
    && window.innerWidth >= 820;

  const DRIFT_TOLERANCE_S = 1.5;   // below this, seeking is more disruptive than the drift
  const SYNC_INTERVAL_MS = 3000;
  const SETTLE_MS = 2500;          // ignore drift right after a seek or a state change

  let player = null;
  let apiLoading = false;
  let apiReady = false;
  let current = null;              // the room's music state, as last broadcast
  let loadedVideoId = null;
  let started = false;             // has this browser been allowed to play audio
  let skewMs = 0;                  // serverClock - localClock
  let lastNudge = 0;
  let volume = clampVolume(localStorage.getItem('tcr_music_vol'));

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
        onStateChange: () => { lastNudge = Date.now(); render(); },
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
    if (!started) return;

    let state;
    try { state = player.getPlayerState(); } catch (e) { return; }

    if (!current.playing) {
      if (state === YT.PlayerState.PLAYING) player.pauseVideo();
      return;
    }
    if (state !== YT.PlayerState.PLAYING) {
      if (state !== YT.PlayerState.BUFFERING) player.playVideo();
      return;                      // never chase position while buffering
    }
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
    if (!card) return;

    if (!current || !current.videoId) {
      card.style.display = 'none';
      loadedVideoId = null;
      if (player && player.stopVideo) { try { player.stopVideo(); } catch (e) {} }
      return;
    }

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
    if (!joinBtn) return;

    joinBtn.style.display = started ? 'none' : 'flex';
    if (playBtn) playBtn.textContent = current && current.playing ? '⏸' : '▶';
    if (note && started) {
      note.textContent = current && current.playing ? '' : 'Paused for everyone';
    }
  }

  function onState(music) {
    if (!IS_DESKTOP) return;
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
  }

  // ---- wiring --------------------------------------------------------------
  function init() {
    const openBtn = $m('music-toggle-btn');
    if (!IS_DESKTOP) {
      // Leave no trace of the feature on a phone.
      if (openBtn) openBtn.style.display = 'none';
      const card = $m('music-card');
      if (card) card.style.display = 'none';
      return;
    }
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
      // Setting a track is a gesture, so this browser may start playing now.
      started = true;
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
    if (joinBtn) {
      joinBtn.addEventListener('click', () => {
        started = true;
        lastNudge = Date.now();
        if (player && current) {
          const at = Math.max(0, targetSeconds(current));
          try { player.seekTo(at, true); player.playVideo(); } catch (e) {}
        }
        render();
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
      videoId: current && current.videoId,
      playing: current && current.playing,
      target: current ? targetSeconds(current) : null,
      actual: player && player.getCurrentTime ? (() => { try { return player.getCurrentTime(); } catch (e) { return null; } })() : null,
    }),
  };
})();
