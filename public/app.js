const socket = io();

const SUIT_SYMBOLS = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
const RED_SUITS = new Set(['hearts', 'diamonds']);

let state = null;
let myPlayerId = null;
let callValue = 1;
let showLastTrick = false;

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function showScreen(id) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $(`#${id}`).classList.add('active');
}

function emit(ev, data) {
  return new Promise((resolve) => {
    socket.emit(ev, data || {}, (res) => resolve(res || {}));
  });
}

// --- Menu ---
$('#btn-create').addEventListener('click', () => {
  const name = $('#input-name').value.trim();
  if (!name) { $('#menu-error').textContent = 'Enter your name'; return; }
  localStorage.setItem('tcr_name', name);
  showScreen('screen-create');
});

$('#btn-join').addEventListener('click', async () => {
  const name = $('#input-name').value.trim();
  const code = $('#input-code').value.trim().toUpperCase();
  if (!name) { $('#menu-error').textContent = 'Enter your name'; return; }
  if (!code || code.length !== 4) { $('#menu-error').textContent = 'Enter 4-letter room code'; return; }
  localStorage.setItem('tcr_name', name);
  const res = await emit('join-room', { roomCode: code, playerName: name });
  if (res.error) { $('#menu-error').textContent = res.error; return; }
  myPlayerId = res.playerId;
  localStorage.setItem('tcr_pid', myPlayerId);
  rememberRoom(code);
  showScreen('screen-lobby');
});

$('#btn-back-menu').addEventListener('click', () => showScreen('screen-menu'));

// --- Create Room ---
let selectedPC = 4;
let selectedMode = '2v2';

$$('[data-pc]').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('[data-pc]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedPC = parseInt(btn.dataset.pc);
    if (selectedPC === 6) {
      $('#mode-group').style.display = 'none';
      $('#mode-label').style.display = 'none';
      selectedMode = '3v3';
    } else if (selectedPC === 5) {
      $('#mode-group').style.display = 'none';
      $('#mode-label').style.display = 'none';
      selectedMode = 'ffa';
    } else {
      $('#mode-group').style.display = 'flex';
      $('#mode-label').style.display = 'block';
      // Re-sync with the highlighted toggle, which 5- and 6-player left behind.
      selectedMode = $('[data-mode].active')?.dataset.mode || '2v2';
    }
  });
});

$$('[data-mode]').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('[data-mode]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedMode = btn.dataset.mode;
  });
});

$('#btn-confirm-create').addEventListener('click', async () => {
  const name = $('#input-name').value.trim();
  const res = await emit('create-room', { playerName: name, gameMode: selectedMode, playerCount: selectedPC });
  if (res.error) { alert(res.error); return; }
  myPlayerId = res.playerId;
  localStorage.setItem('tcr_pid', myPlayerId);
  rememberRoom(res.roomCode);
  showScreen('screen-lobby');
});

// --- Lobby ---
$('#btn-start').addEventListener('click', async () => {
  const res = await emit('start-game');
  if (res.error) alert(res.error);
});

// --- Call UI ---
$('#call-minus').addEventListener('click', () => {
  if (callValue > 1) { callValue--; $('#call-value').textContent = callValue; }
});
$('#call-plus').addEventListener('click', () => {
  callValue++;
  $('#call-value').textContent = callValue;
});
$('#btn-submit-call').addEventListener('click', async () => {
  const res = await emit('submit-call', { call: callValue });
  if (res.error) alert(res.error);
});

// --- Scoreboard ---
$('#score-toggle-btn').addEventListener('click', () => {
  const sb = $('#scoreboard');
  sb.style.display = sb.style.display === 'none' ? 'flex' : 'none';
});
$('#close-scores').addEventListener('click', () => {
  $('#scoreboard').style.display = 'none';
});

$('#btn-back-home').addEventListener('click', () => {
  state = null;
  myPlayerId = null;
  forgetRoom();
  showScreen('screen-menu');
});

// --- Install / service worker ---
// The worker exists for the cold-start shell, not for offline play: a
// multiplayer game is useless without the server either way.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

let deferredInstall = null;
const installBtn = $('#btn-install');

window.addEventListener('beforeinstallprompt', (e) => {
  // Chrome and Edge let us defer this and offer it in our own UI.
  e.preventDefault();
  deferredInstall = e;
  if (installBtn) installBtn.style.display = 'block';
});

if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!deferredInstall) return;
    installBtn.disabled = true;
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    deferredInstall = null;
    installBtn.style.display = 'none';
    installBtn.disabled = false;
  });
}

window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  if (installBtn) installBtn.style.display = 'none';
});

// iOS never fires beforeinstallprompt, so Safari users get instructions instead.
(function iosInstallHint() {
  const hint = $('#ios-install-hint');
  if (!hint) return;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  const installed = window.navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches;
  if (isIOS && isSafari && !installed) hint.style.display = 'block';
})();

// --- Rejoin ---
// A dropped player keeps their seat as long as somebody is still in the room,
// but they can only get back in with the room code, which is exactly what gets
// lost when a phone locks and the tab reloads. So we hang on to it for them.
function rememberRoom(code) {
  if (code) localStorage.setItem('tcr_room', String(code).toUpperCase());
  refreshRejoin();
}

function forgetRoom() {
  localStorage.removeItem('tcr_room');
  refreshRejoin();
}

function refreshRejoin() {
  const btn = $('#btn-rejoin');
  const hint = $('#rejoin-hint');
  const divider = $('#rejoin-divider');
  const createBtn = $('#btn-create');
  if (!btn) return;

  const code = localStorage.getItem('tcr_room');
  const name = localStorage.getItem('tcr_name');
  const show = !!(code && name);

  btn.style.display = show ? 'block' : 'none';
  hint.style.display = show ? 'block' : 'none';
  divider.style.display = show ? 'block' : 'none';
  if (show) {
    btn.textContent = 'Rejoin room ' + code;
    hint.textContent = 'as ' + name;
  }
  // Only one gold button at a time, so the obvious action stays obvious.
  createBtn.classList.toggle('primary', !show);
}

$('#btn-rejoin').addEventListener('click', async () => {
  const code = localStorage.getItem('tcr_room');
  const name = localStorage.getItem('tcr_name');
  if (!code || !name) { forgetRoom(); return; }

  const btn = $('#btn-rejoin');
  btn.disabled = true;
  $('#menu-error').textContent = '';
  const res = await emit('join-room', { roomCode: code, playerName: name });
  btn.disabled = false;

  if (res.error) {
    $('#menu-error').textContent = res.error;
    // The room is gone for good; stop offering a door that leads nowhere.
    if (/not found/i.test(res.error)) forgetRoom();
    return;
  }
  myPlayerId = res.playerId;
  localStorage.setItem('tcr_pid', myPlayerId);
  rememberRoom(code);
});

// --- Restore name ---
const savedName = localStorage.getItem('tcr_name');
if (savedName) $('#input-name').value = savedName;
refreshRejoin();

// --- Sound ---
const soundBtn = $('#sound-toggle-btn');
function refreshSoundBtn() {
  const on = Sound.isEnabled();
  soundBtn.textContent = on ? '🔊' : '🔇';
  soundBtn.classList.toggle('muted', !on);
  soundBtn.title = on ? 'Sound on - tap to mute' : 'Sound is OFF - tap to turn it back on';
}
soundBtn.addEventListener('click', () => {
  Sound.toggle();
  refreshSoundBtn();
});
refreshSoundBtn();

function myTeamSeats(s) {
  if (!s.teams || !s.you) return null;
  const team = s.teams.find(t => t.seats.includes(s.you.seat));
  return team ? team.seats : null;
}

// Sounds are driven off state transitions rather than local actions, so every
// player hears the same cues no matter who triggered them.
function playTransitionSounds(prev, next) {
  if (!prev || !next || !next.you) return;

  if (prev.phase !== next.phase && next.phase === 'calling') {
    Sound.deal(next.playerCount);
    setTimeout(() => Sound.trumpReveal(), 550);
  }

  const prevCalls = prev.callInfo ? prev.callInfo.submitted : 0;
  const nextCalls = next.callInfo ? next.callInfo.submitted : 0;
  if (nextCalls > prevCalls) Sound.callMade();

  const prevCards = prev.currentTrick ? prev.currentTrick.length : 0;
  const nextCards = next.currentTrick ? next.currentTrick.length : 0;
  if (nextCards > prevCards) Sound.cardPlay();

  if (next.pendingTrickWinner && !prev.pendingTrickWinner) {
    const winSeat = next.pendingTrickWinner.seat;
    const mates = myTeamSeats(next);
    const ours = mates ? mates.includes(winSeat) : winSeat === next.you.seat;
    // Let the card-play sound land before the verdict.
    setTimeout(() => ours ? Sound.trickWin() : Sound.trickLose(), 260);
  }

  const wasMyTurn = prev.phase === 'playing' && prev.currentPlayerSeat === prev.you.seat;
  const isMyTurn = next.phase === 'playing' && next.currentPlayerSeat === next.you.seat;
  if (isMyTurn && !wasMyTurn && !next.pendingTrickWinner) Sound.yourTurn();

  if (prev.phase !== next.phase) {
    if (next.phase === 'round_end') Sound.roundEnd();
    else if (next.phase === 'game_over') Sound.gameOver();
  }
}

// --- State rendering ---
socket.on('game-state', (s) => {
  const prev = state;
  state = s;
  render();
  playTransitionSounds(prev, s);
});

function render() {
  if (!state) return;

  if (state.phase === 'lobby') {
    renderLobby();
    if (!$('#screen-lobby').classList.contains('active') && !$('#screen-game').classList.contains('active')) {
      showScreen('screen-lobby');
    }
  } else {
    if (!$('#screen-game').classList.contains('active')) {
      showScreen('screen-game');
    }
    renderGame();
  }
}

function renderLobby() {
  $('#lobby-code').textContent = state.roomCode;
  const modeNames = { '2v2': '2v2 Teams', 'ffa': 'Free-for-All', '3v3': '3v3 Teams' };
  $('#lobby-info').textContent = `${state.playerCount} Players · ${modeNames[state.gameMode]}`;

  const ul = $('#lobby-players');
  ul.innerHTML = '';
  state.players.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="seat-num">S${p.seat + 1}</span> ${esc(p.name)}${p.id === state.hostId ? ' ⭐' : ''}`;
    ul.appendChild(li);
  });

  const isHost = myPlayerId === state.hostId;
  const full = state.players.length >= state.playerCount;
  $('#btn-start').style.display = isHost && full ? 'block' : 'none';
  $('#lobby-waiting').style.display = full ? 'none' : 'block';
  $('#lobby-waiting').textContent = `Waiting for players... (${state.players.length}/${state.playerCount})`;
}

function renderGame() {
  renderHeader();
  renderSeats();
  renderTrick();
  renderConnectionBanner();
  renderYourInfo();
  renderHand();
  renderCallOverlay();
  renderRoundEnd();
  renderGameOver();
  renderScoreboard();
}

function renderYourInfo() {
  const bar = $('#your-info');
  if (state.phase === 'lobby') { bar.innerHTML = ''; return; }
  const me = state.players.find(p => p.id === myPlayerId);
  const myEntity = state.you.entityId;
  const call = state.callsRevealed && state.calls ? state.calls[myEntity] : null;
  const tricks = state.tricksWon[myEntity] ?? 0;
  const isMyTurn = state.currentPlayerSeat === state.you.seat && state.phase === 'playing';

  let parts = [`<span>${esc(me?.name || 'You')}</span>`];
  if (me?.isDealer) parts.push('<span>Dealer</span>');
  if (me?.isColorPicker) parts.push('<span>Color Picker</span>');
  if (call !== null) parts.push(`<span>Call: <span class="val">${call}</span></span>`);
  if (state.phase === 'playing') parts.push(`<span>Tricks: <span class="val">${tricks}</span></span>`);
  if (isMyTurn && selectedCardId) parts.push('<span class="val">Tap again to play</span>');
  else if (isMyTurn) parts.push('<span class="val">YOUR TURN</span>');
  bar.innerHTML = parts.join('');
}

function renderHeader() {
  if (state.trumpSuit) {
    const sym = SUIT_SYMBOLS[state.trumpSuit];
    const cls = RED_SUITS.has(state.trumpSuit) ? 'red' : '';
    $('#trump-display').innerHTML = `Trump: <span class="trump-${state.trumpSuit}" style="font-size:1.4rem">${sym}</span>`;
  } else {
    $('#trump-display').textContent = '';
  }
  const compact = window.innerWidth < 600;
  let roundText = compact
    ? `R${state.roundNumber} · ${state.trickNumber || '-'}/${state.maxTricks}`
    : `Round ${state.roundNumber} · Trick ${state.trickNumber || '-'}/${state.maxTricks}`;
  if (state.colorCard) {
    const cc = state.colorCard;
    const ccSym = cc.rank === 'JOKER' ? '🃏' : cc.rank + SUIT_SYMBOLS[cc.suit];
    roundText += compact ? ` · ${ccSym}` : ` · Color card: ${ccSym}`;
  }
  $('#round-display').textContent = roundText;
}

function seatPositions(count, mySeat) {
  const LAYOUTS = {
    4: [{ x: 50, y: 85 }, { x: 8, y: 50 }, { x: 50, y: 12 }, { x: 92, y: 50 }],
    5: [{ x: 50, y: 85 }, { x: 9, y: 62 }, { x: 26, y: 14 }, { x: 74, y: 14 }, { x: 91, y: 62 }],
    6: [{ x: 50, y: 85 }, { x: 8, y: 68 }, { x: 8, y: 28 }, { x: 50, y: 12 }, { x: 92, y: 28 }, { x: 92, y: 68 }],
  };
  const positions = LAYOUTS[count] || LAYOUTS[6];

  const rotated = [];
  for (let i = 0; i < count; i++) {
    const actualSeat = (mySeat + i) % count;
    rotated.push({ seat: actualSeat, ...positions[i] });
  }
  return rotated;
}

function renderSeats() {
  const container = $('#seats');
  container.innerHTML = '';
  const mySeat = state.you.seat;
  const positions = seatPositions(state.playerCount, mySeat);

  const narrow = window.innerWidth < 600;

  for (const pos of positions) {
    if (pos.seat === mySeat) continue;
    const p = state.players.find(pl => pl.seat === pos.seat);
    if (!p) continue;

    const div = document.createElement('div');
    div.className = 'seat';
    // Seats are centred on their point, so an 8% seat hangs half off a 375px
    // screen. Keep the whole block on screen instead.
    div.style.left = (narrow ? Math.min(82, Math.max(18, pos.x)) : pos.x) + '%';
    div.style.top = pos.y + '%';

    let nameClass = 'seat-name';
    if (p.isDealer) nameClass += ' dealer';
    if (p.isCurrentTurn) nameClass += ' current-turn';
    if (!p.connected) nameClass += ' offline';

    const entityId = getEntityId(p);
    const tricks = state.tricksWon[entityId] ?? '';
    const callText = state.callsRevealed && state.calls ? `Call: ${state.calls[entityId]}` : '';
    const partnerMark = getPartnerMark(p);

    div.innerHTML = `
      <div class="${nameClass}">${esc(p.name)}${partnerMark}</div>
      <div class="seat-cards">${p.connected ? '' : 'offline · '}${p.cardsRemaining} cards${p.isDealer ? ' · D' : ''}${p.isColorPicker ? ' · CP' : ''}</div>
      ${callText ? `<div class="seat-call">${callText}</div>` : ''}
      ${tricks !== '' && state.phase === 'playing' ? `<div class="seat-tricks">Tricks: ${tricks}</div>` : ''}
    `;
    container.appendChild(div);
  }
}

function getEntityId(player) {
  if (state.gameMode === 'ffa') return player.id;
  if (!state.teams) return player.id;
  const team = state.teams.find(t => t.playerIds.includes(player.id));
  return team ? team.id : player.id;
}

function getPartnerMark(player) {
  if (state.gameMode === 'ffa' || !state.teams) return '';
  const myTeam = state.teams.find(t => t.playerIds.includes(myPlayerId));
  if (myTeam && myTeam.playerIds.includes(player.id)) return ' 🤝';
  return '';
}

function renderTrick() {
  const area = $('#trick-area');
  area.innerHTML = '';

  const cards = state.currentTrick;
  if (!cards || cards.length === 0) {
    const info = $('#trick-info');
    info.innerHTML = '';
    if (state.lastTrick && state.phase === 'playing') {
      const winner = state.players.find(p => p.seat === state.lastTrick.winnerSeat);
      info.textContent = winner ? `${winner.name} won trick ${state.lastTrick.trickNumber}` : '';
    }
    return;
  }

  const pendingWinner = state.pendingTrickWinner;

  for (const entry of cards) {
    const slot = document.createElement('div');
    slot.className = 'played-card-slot';
    if (pendingWinner && entry.seat === pendingWinner.seat) slot.classList.add('winner');

    const p = state.players.find(pl => pl.seat === entry.seat);
    slot.innerHTML = renderCardHTML(entry.card) + `<span class="who">${esc(p?.name || '')}</span>`;
    area.appendChild(slot);
  }

  const info = $('#trick-info');
  info.innerHTML = '';
  if (pendingWinner) {
    const winner = state.players.find(p => p.seat === pendingWinner.seat);
    const label = document.createElement('div');
    label.className = 'trick-winner-label';
    label.textContent = winner ? `${winner.name} wins the trick` : '';
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.id = 'btn-next-trick';
    btn.textContent = 'Next Trick';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      socket.emit('next-trick', {}, () => {});
    });
    info.appendChild(label);
    info.appendChild(btn);
  }
}

function renderConnectionBanner() {
  const el = $('#connection-banner');
  if (!el) return;
  const offline = (state.players || []).filter(p => !p.connected);

  if (!offline.length) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }

  const stalled = state.waitingFor;
  el.style.display = 'block';
  el.className = stalled ? 'stalled' : '';

  const head = document.createElement('strong');
  const sub = document.createElement('span');
  if (stalled) {
    head.textContent = 'Waiting for ' + stalled.name + ' to reconnect';
    sub.textContent = 'It is their turn, so play is paused. They can rejoin with the room code and the exact name "' + stalled.name + '".';
  } else {
    head.textContent = 'Disconnected: ' + offline.map(p => p.name).join(', ');
    sub.textContent = 'They can rejoin with the room code and their exact name.';
  }
  el.innerHTML = '';
  el.appendChild(head);
  el.appendChild(sub);
}

// A pointer that can hover reveals a card before it is clicked. Touch cannot,
// so on those devices the first tap stands in for the hover and the second
// commits - otherwise a tap on a heavily overlapped card is a guess, and a
// misplay cannot be taken back.
const CAN_HOVER = window.matchMedia('(hover: hover)').matches;
let selectedCardId = null;

// Never let the hand scroll: overlap the cards just enough to fit the width,
// leaving each one's corner index showing.
const MIN_CARD_SLIVER = 20;

function fitHand() {
  const area = $('#hand-area');
  const container = $('#hand');
  if (!area || !container) return;
  const count = container.children.length;
  if (!count) return;

  const cardW = container.firstElementChild.offsetWidth;
  if (!cardW) return;
  const pad = getComputedStyle(area);
  const box = Math.min(area.clientWidth, document.documentElement.clientWidth);
  const avail = box - parseFloat(pad.paddingLeft || 0) - parseFloat(pad.paddingRight || 0);

  let overlap = 12; // the roomy default, matching the original fan
  if (count > 1) {
    const required = Math.ceil((count * cardW - avail) / (count - 1));
    overlap = Math.max(overlap, required);
    overlap = Math.min(overlap, Math.max(0, cardW - MIN_CARD_SLIVER));
  }
  container.style.setProperty('--hand-overlap', overlap + 'px');
}

function renderHand() {
  const container = $('#hand');
  container.innerHTML = '';

  const hand = state.you.hand || [];
  const isMyTurn = state.phase === 'playing' && state.currentPlayerSeat === state.you.seat;

  // Drop a stale selection if that card is gone or is no longer playable.
  if (selectedCardId && !(isMyTurn && hand.some(c => c.id === selectedCardId && c.isLegal))) {
    selectedCardId = null;
  }

  for (const card of hand) {
    const el = document.createElement('div');
    el.innerHTML = renderCardHTML(card);
    const cardEl = el.firstElementChild;

    if (isMyTurn && !card.isLegal) {
      cardEl.classList.add('disabled');
    }

    if (isMyTurn && card.isLegal) {
      if (CAN_HOVER) {
        cardEl.addEventListener('click', () => playCard(card.id));
      } else {
        if (card.id === selectedCardId) cardEl.classList.add('selected');
        cardEl.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (selectedCardId === card.id) {
            selectedCardId = null;
            playCard(card.id);
          } else {
            selectedCardId = card.id;
            renderHand();
            renderYourInfo();
          }
        });
      }
    }

    container.appendChild(cardEl);
  }

  fitHand();
}

// Tapping away from the hand cancels a pending selection.
if (!CAN_HOVER) {
  document.addEventListener('click', () => {
    if (!selectedCardId) return;
    selectedCardId = null;
    if (state) { renderHand(); renderYourInfo(); }
  });
}

window.addEventListener('resize', () => { fitHand(); if (state) render(); });
window.addEventListener('orientationchange', () => setTimeout(fitHand, 150));

async function playCard(cardId) {
  const res = await emit('play-card', { cardId });
  if (res.error) alert(res.error);
}

// Trump is a property of the four real suits only. The Joker is suitless and
// carries its own priority, so it must never render as a Trump card.
function isTrumpCard(card) {
  if (!card || card.rank === 'JOKER') return false;
  if (card.isTrump !== undefined) return card.isTrump;
  return !!state.trumpSuit && card.suit === state.trumpSuit;
}

function renderCardHTML(card) {
  if (card.rank === 'JOKER') {
    return `<div class="card card-front joker"><span class="corner"><span class="cr">J</span><span class="cs">🃏</span></span><span class="rank">JOKER</span><span class="suit">🃏</span></div>`;
  }
  const sym = SUIT_SYMBOLS[card.suit];
  const isRed = RED_SUITS.has(card.suit);
  const isTrump = isTrumpCard(card);
  let cls = 'card card-front';
  if (isRed) cls += ' red';
  if (isTrump) cls += ' trump-card';
  return `<div class="${cls}"><span class="corner"><span class="cr">${card.rank}</span><span class="cs">${sym}</span></span><span class="rank">${card.rank}</span><span class="suit">${sym}</span></div>`;
}

function renderCallOverlay() {
  const callOverlay = $('#call-overlay');
  const waitOverlay = $('#call-waiting');

  if (state.phase !== 'calling') {
    callOverlay.style.display = 'none';
    waitOverlay.style.display = 'none';
    return;
  }

  const ci = state.callInfo;
  if (ci && ci.canYouCall) {
    callOverlay.style.display = 'flex';
    waitOverlay.style.display = 'none';
    $('#call-prompt').textContent = `Your hand has ${state.you.hand.length} cards. Trump: ${SUIT_SYMBOLS[state.trumpSuit] || '?'}`;
  } else {
    callOverlay.style.display = 'none';
    waitOverlay.style.display = 'flex';
    const text = ci ? `${ci.submitted}/${ci.total} calls submitted...` : 'Waiting...';
    $('#call-wait-text').textContent = text;
  }
}

function renderRoundEnd() {
  const overlay = $('#round-end-overlay');
  if (state.phase !== 'round_end') {
    overlay.style.display = 'none';
    return;
  }
  overlay.style.display = 'flex';

  const table = $('#round-end-table');
  const entities = getEntities();
  let html = '<tr><th>Name</th><th>Call</th><th>Tricks</th><th>Round</th><th>Total</th></tr>';
  for (const e of entities) {
    const rs = state.roundScores[e.id];
    const cs = state.cumulativeScores[e.id];
    const cls = rs >= 0 ? 'positive' : 'negative';
    html += `<tr><td>${esc(e.name)}</td><td>${state.calls[e.id]}</td><td>${state.tricksWon[e.id]}</td><td class="${cls}">${fmt(rs)}</td><td class="${cls}">${fmt(cs)}</td></tr>`;
  }
  table.innerHTML = html;

  const actions = $('#round-end-actions');
  const isHost = myPlayerId === state.hostId;
  actions.innerHTML = '';
  if (isHost) {
    const nr = document.createElement('button');
    nr.className = 'btn primary';
    nr.textContent = 'Next Round';
    nr.addEventListener('click', async () => {
      const res = await emit('next-round');
      if (res.error) alert(res.error);
    });
    actions.appendChild(nr);
  }

  const endBtn = document.createElement('button');
  endBtn.className = 'btn';
  const hasRequested = state.endGameRequests.includes(myPlayerId);
  endBtn.textContent = hasRequested ? 'Cancel End Request' : 'Request End Game';
  endBtn.addEventListener('click', () => {
    emit(hasRequested ? 'cancel-end-game' : 'request-end-game');
  });
  actions.appendChild(endBtn);

  if (state.endGameRequests.length > 0) {
    const info = document.createElement('p');
    info.className = 'subtle';
    info.textContent = `${state.endGameRequests.length}/${state.endGameNeeded ?? state.playerCount} want to end`;
    actions.appendChild(info);
  }
}

function renderGameOver() {
  const overlay = $('#game-over-overlay');
  if (state.phase !== 'game_over') {
    overlay.style.display = 'none';
    return;
  }
  overlay.style.display = 'flex';

  const table = $('#game-over-table');
  const entities = getEntities();
  entities.sort((a, b) => (state.cumulativeScores[b.id] || 0) - (state.cumulativeScores[a.id] || 0));

  let html = '<tr><th>#</th><th>Name</th><th>Score</th></tr>';
  entities.forEach((e, i) => {
    const cs = state.cumulativeScores[e.id];
    const cls = cs >= 0 ? 'positive' : 'negative';
    html += `<tr><td>${i + 1}</td><td>${esc(e.name)}</td><td class="${cls}">${fmt(cs)}</td></tr>`;
  });
  table.innerHTML = html;
}

function renderScoreboard() {
  if ($('#scoreboard').style.display === 'none') return;
  const table = $('#score-table');
  const entities = getEntities();
  let html = '<tr><th>Name</th><th>Call</th><th>Tricks</th><th>Total</th></tr>';
  for (const e of entities) {
    const cs = state.cumulativeScores[e.id] ?? 0;
    const cls = cs >= 0 ? 'positive' : 'negative';
    const call = state.callsRevealed && state.calls ? state.calls[e.id] ?? '-' : '-';
    const tricks = state.tricksWon[e.id] ?? '-';
    html += `<tr><td>${esc(e.name)}</td><td>${call}</td><td>${tricks}</td><td class="${cls}">${fmt(cs)}</td></tr>`;
  }
  table.innerHTML = html;
}

function getEntities() {
  if (state.gameMode === 'ffa') {
    return state.players.map(p => ({ id: p.id, name: p.name }));
  }
  return (state.teams || []).map(t => ({
    id: t.id,
    name: t.playerNames.join(' & '),
  }));
}

function fmt(n) {
  if (n == null) return '-';
  return Number.isInteger(n) ? n.toFixed(1) : n.toFixed(1);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
