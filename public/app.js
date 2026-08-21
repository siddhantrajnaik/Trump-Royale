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
    } else {
      $('#mode-group').style.display = 'flex';
      $('#mode-label').style.display = 'block';
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
  showScreen('screen-menu');
});

// --- Restore name ---
const savedName = localStorage.getItem('tcr_name');
if (savedName) $('#input-name').value = savedName;

// --- Sound ---
const soundBtn = $('#sound-toggle-btn');
function refreshSoundBtn() {
  soundBtn.textContent = Sound.isEnabled() ? '🔊' : '🔇';
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
  if (isMyTurn) parts.push('<span class="val">YOUR TURN</span>');
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
  let roundText = `Round ${state.roundNumber} · Trick ${state.trickNumber || '-'}/${state.maxTricks}`;
  if (state.colorCard) {
    const cc = state.colorCard;
    const ccSym = cc.rank === 'JOKER' ? '🃏' : cc.rank + SUIT_SYMBOLS[cc.suit];
    roundText += ` · Color card: ${ccSym}`;
  }
  $('#round-display').textContent = roundText;
}

function seatPositions(count, mySeat) {
  const positions = count === 4
    ? [{ x: 50, y: 85 }, { x: 8, y: 50 }, { x: 50, y: 12 }, { x: 92, y: 50 }]
    : [{ x: 50, y: 85 }, { x: 8, y: 68 }, { x: 8, y: 28 }, { x: 50, y: 12 }, { x: 92, y: 28 }, { x: 92, y: 68 }];

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

  for (const pos of positions) {
    if (pos.seat === mySeat) continue;
    const p = state.players.find(pl => pl.seat === pos.seat);
    if (!p) continue;

    const div = document.createElement('div');
    div.className = 'seat';
    div.style.left = pos.x + '%';
    div.style.top = pos.y + '%';

    let nameClass = 'seat-name';
    if (p.isDealer) nameClass += ' dealer';
    if (p.isCurrentTurn) nameClass += ' current-turn';

    const entityId = getEntityId(p);
    const tricks = state.tricksWon[entityId] ?? '';
    const callText = state.callsRevealed && state.calls ? `Call: ${state.calls[entityId]}` : '';
    const partnerMark = getPartnerMark(p);

    div.innerHTML = `
      <div class="${nameClass}">${esc(p.name)}${partnerMark}</div>
      <div class="seat-cards">${p.cardsRemaining} cards${p.isDealer ? ' · D' : ''}${p.isColorPicker ? ' · CP' : ''}</div>
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

function renderHand() {
  const container = $('#hand');
  container.innerHTML = '';

  const hand = state.you.hand || [];
  const isMyTurn = state.phase === 'playing' && state.currentPlayerSeat === state.you.seat;

  for (const card of hand) {
    const el = document.createElement('div');
    el.innerHTML = renderCardHTML(card);
    const cardEl = el.firstElementChild;

    if (isMyTurn && !card.isLegal) {
      cardEl.classList.add('disabled');
    }

    if (isMyTurn && card.isLegal) {
      cardEl.addEventListener('click', () => playCard(card.id));
    }

    container.appendChild(cardEl);
  }
}

async function playCard(cardId) {
  const res = await emit('play-card', { cardId });
  if (res.error) alert(res.error);
}

function renderCardHTML(card) {
  if (card.rank === 'JOKER') {
    return `<div class="card card-front joker"><span class="rank">JOKER</span><span class="suit">🃏</span></div>`;
  }
  const sym = SUIT_SYMBOLS[card.suit];
  const isRed = RED_SUITS.has(card.suit);
  const isTrump = card.suit === state.trumpSuit;
  let cls = 'card card-front';
  if (isRed) cls += ' red';
  if (isTrump) cls += ' trump-card';
  return `<div class="${cls}"><span class="rank">${card.rank}</span><span class="suit">${sym}</span></div>`;
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
    info.textContent = `${state.endGameRequests.length}/${state.playerCount} want to end`;
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
