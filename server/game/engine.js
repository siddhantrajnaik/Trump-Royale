const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
const RANK_VALUES = { A: 14, K: 13, Q: 12, J: 11, '10': 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2 };
const SUIT_SYMBOLS = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };

function cardId(suit, rank) {
  if (rank === 'JOKER') return 'JOKER';
  return `${rank}${SUIT_SYMBOLS[suit]}`;
}

function makeCard(suit, rank) {
  return { suit, rank, id: cardId(suit, rank) };
}

function buildDeck(playerCount) {
  const cards = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      cards.push(makeCard(suit, rank));
    }
  }

  if (playerCount === 4) {
    const idx = cards.findIndex(c => c.suit === 'diamonds' && c.rank === '2');
    cards.splice(idx, 1);
  } else if (playerCount === 5) {
    // 5P_FFA: standard 52 minus 2S, 2C and 2H, plus the Joker pushed below,
    // giving exactly 50 cards / 10 per player. The third 2 is what makes room
    // for the Joker while keeping the count divisible, so the color card still
    // lands as the dealer's final card the way it does in the other decks.
    for (const suit of ['spades', 'clubs', 'hearts']) {
      const idx = cards.findIndex(c => c.suit === suit && c.rank === '2');
      cards.splice(idx, 1);
    }
  } else {
    for (let i = cards.length - 1; i >= 0; i--) {
      if (cards[i].rank === '2') cards.splice(i, 1);
    }
    const idx = cards.findIndex(c => c.suit === 'diamonds' && c.rank === '3');
    cards.splice(idx, 1);
  }

  cards.push({ suit: null, rank: 'JOKER', id: 'JOKER' });
  return cards;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function calculateScore(call, tricksTaken, playerCount) {
  // 5P_FFA uses the plain formula only - no doubled call.
  const specialCall = playerCount === 5 ? null : (playerCount === 4 ? 7 : 5);
  if (tricksTaken >= call) {
    const base = call === specialCall ? call * 2 : call;
    const over = tricksTaken - call;
    return base + over * 0.1;
  }
  return -call;
}

class GameEngine {
  constructor(gameMode, playerCount) {
    this.gameMode = gameMode;
    this.playerCount = playerCount;
    this.maxTricks = playerCount === 4 ? 13 : playerCount === 5 ? 10 : 8;
    this.players = [];
    this.teams = [];
    this.phase = 'lobby';
    this.roundNumber = 0;
    this.dealerSeat = -1;
    this.colorPickerSeat = -1;
    this.trumpSuit = null;
    this.colorCard = null;
    this.hands = {};
    this.calls = {};
    this.callOrder = [];
    this.callsRevealed = false;
    this.currentTrick = [];
    this.trickNumber = 0;
    this.leadSuit = null;
    this.currentPlayerSeat = -1;
    this.leaderSeat = -1;
    this.tricksWon = {};
    this.roundScores = {};
    this.cumulativeScores = {};
    this.previousTrickWinnerSeat = null;
    this.endGameRequests = new Set();
    this.lastTrick = null;
    this.pendingTrickWinner = null;
  }

  addPlayer(id, name) {
    if (this.players.length >= this.playerCount) return null;
    const seat = this.players.length;
    const player = { id, name, seat, connected: true };
    this.players.push(player);
    return player;
  }

  removePlayer(id) {
    const idx = this.players.findIndex(p => p.id === id);
    if (idx === -1) return;
    if (this.phase === 'lobby') {
      this.players.splice(idx, 1);
      this.players.forEach((p, i) => p.seat = i);
    } else {
      this.players[idx].connected = false;
    }
  }

  reconnectPlayer(oldId, newId) {
    const p = this.players.find(p => p.id === oldId);
    if (p) { p.id = newId; p.connected = true; }
    return p;
  }

  _buildTeams() {
    this.teams = [];
    if (this.gameMode === 'ffa') return;
    const half = this.playerCount / 2;
    const teamCount = this.playerCount === 4 ? 2 : 3;
    for (let t = 0; t < teamCount; t++) {
      this.teams.push({
        id: `team_${t}`,
        seats: [t, t + half],
        playerIds: [this.players[t].id, this.players[t + half].id],
      });
    }
  }

  _entityId(seat) {
    if (this.gameMode === 'ffa') return this.players[seat].id;
    const half = this.playerCount / 2;
    const teamIdx = seat < half ? seat : seat - half;
    return this.teams[teamIdx].id;
  }

  _entityIds() {
    if (this.gameMode === 'ffa') return this.players.map(p => p.id);
    return this.teams.map(t => t.id);
  }

  _getTeamForPlayer(playerId) {
    return this.teams.find(t => t.playerIds.includes(playerId));
  }

  _seatOfPlayer(playerId) {
    const p = this.players.find(p => p.id === playerId);
    return p ? p.seat : -1;
  }

  startGame() {
    if (this.players.length !== this.playerCount) return { error: 'Not enough players' };
    if (this.phase !== 'lobby') return { error: 'Game already started' };
    this._buildTeams();
    for (const eid of this._entityIds()) {
      this.cumulativeScores[eid] = 0;
    }
    this.dealerSeat = 0;
    this.startRound();
    return { ok: true };
  }

  startRound() {
    this.roundNumber++;
    this.colorPickerSeat = (this.dealerSeat + 1) % this.playerCount;
    this.callsRevealed = false;
    this.calls = {};
    this.currentTrick = [];
    this.trickNumber = 0;
    this.previousTrickWinnerSeat = null;
    this.lastTrick = null;

    for (const eid of this._entityIds()) {
      this.tricksWon[eid] = 0;
      this.roundScores[eid] = 0;
    }

    let deck = shuffle(buildDeck(this.playerCount));
    const colorCard = deck.shift();
    this.colorCard = colorCard;
    this.trumpSuit = colorCard.suit;
    deck.push(colorCard);

    const cardsPerPlayer = this.playerCount === 4 ? 13 : this.playerCount === 5 ? 10 : 8;
    this.hands = {};
    for (let i = 0; i < this.playerCount; i++) {
      const seat = (this.colorPickerSeat + i) % this.playerCount;
      const pid = this.players[seat].id;
      this.hands[pid] = [];
    }

    let dealIdx = 0;
    for (let c = 0; c < cardsPerPlayer; c++) {
      for (let i = 0; i < this.playerCount; i++) {
        const seat = (this.colorPickerSeat + i) % this.playerCount;
        const pid = this.players[seat].id;
        this.hands[pid].push(deck[dealIdx++]);
      }
    }

    for (const pid of Object.keys(this.hands)) {
      this.hands[pid].sort((a, b) => {
        if (a.rank === 'JOKER') return -1;
        if (b.rank === 'JOKER') return 1;
        const suitOrder = SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
        if (suitOrder !== 0) return suitOrder;
        return RANK_VALUES[b.rank] - RANK_VALUES[a.rank];
      });
    }

    this._buildCallOrder();
    this.phase = 'calling';
  }

  _buildCallOrder() {
    this.callOrder = [];
    if (this.gameMode === 'ffa') {
      for (let i = 0; i < this.playerCount; i++) {
        const seat = (this.colorPickerSeat + i) % this.playerCount;
        this.callOrder.push(this.players[seat].id);
      }
    } else {
      const cpEntity = this._entityId(this.colorPickerSeat);
      const entities = this._entityIds();
      const ordered = [cpEntity, ...entities.filter(e => e !== cpEntity)];
      this.callOrder = ordered;
    }
  }

  _currentCaller() {
    for (const eid of this.callOrder) {
      if (this.calls[eid] === undefined) return eid;
    }
    return null;
  }

  _canSubmitCall(playerId) {
    const currentCaller = this._currentCaller();
    if (!currentCaller) return false;

    if (this.gameMode === 'ffa') {
      return playerId === currentCaller;
    }

    const team = this._getTeamForPlayer(playerId);
    return team && team.id === currentCaller && this.calls[team.id] === undefined;
  }

  submitCall(playerId, call) {
    if (this.phase !== 'calling') return { error: 'Not in calling phase' };
    if (!Number.isInteger(call) || call < 1) return { error: 'Call must be a positive integer' };
    if (!this._canSubmitCall(playerId)) return { error: 'Not your turn to call' };

    const eid = this.gameMode === 'ffa' ? playerId : this._getTeamForPlayer(playerId).id;
    this.calls[eid] = call;

    if (this._currentCaller() === null) {
      this.callsRevealed = true;
      this.phase = 'playing';
      this.trickNumber = 1;
      this.leaderSeat = this.colorPickerSeat;
      this.currentPlayerSeat = this.colorPickerSeat;
    }

    return { ok: true };
  }

  _getHand(playerId) {
    return this.hands[playerId] || [];
  }

  getLegalCards(playerId) {
    const hand = this._getHand(playerId);
    if (hand.length === 0) return [];

    const seat = this._seatOfPlayer(playerId);
    const isLeading = this.currentTrick.length === 0;
    const isFirstTrick = this.trickNumber === 1;
    const isFinalTrick = this.trickNumber === this.maxTricks;

    if (isLeading) {
      if (this.previousTrickWinnerSeat === seat) {
        const nonJoker = hand.filter(c => c.rank !== 'JOKER');
        // The Joker being the last card standing outranks the no-Joker-lead
        // rule: without this the player has no legal move and the round cannot
        // be completed at all.
        if (nonJoker.length > 0) return nonJoker;
      }
      return [...hand];
    }

    if (this.leadSuit === null) {
      return [...hand];
    }

    const suitCards = hand.filter(c => c.suit === this.leadSuit);
    if (suitCards.length === 0) {
      return [...hand];
    }

    const joker = hand.find(c => c.rank === 'JOKER');
    const legal = [...suitCards];
    if (joker) legal.push(joker);
    return legal;
  }

  playCard(playerId, cardId) {
    if (this.phase !== 'playing') return { error: 'Not in playing phase' };
    if (this.pendingTrickWinner) return { error: 'Trick resolving' };
    const seat = this._seatOfPlayer(playerId);
    if (seat !== this.currentPlayerSeat) return { error: 'Not your turn' };

    const hand = this._getHand(playerId);
    const cardIdx = hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return { error: 'Card not in hand' };

    const legal = this.getLegalCards(playerId);
    if (!legal.find(c => c.id === cardId)) return { error: 'Illegal card' };

    const card = hand.splice(cardIdx, 1)[0];

    if (this.currentTrick.length === 0) {
      if (card.rank === 'JOKER') {
        this.leadSuit = null;
      } else {
        this.leadSuit = card.suit;
      }
    } else if (this.leadSuit === null && card.rank !== 'JOKER') {
      this.leadSuit = card.suit;
    }

    this.currentTrick.push({ playerId, seat, card });

    if (this.currentTrick.length < this.playerCount) {
      this.currentPlayerSeat = (this.currentPlayerSeat + 1) % this.playerCount;
      return { ok: true, trickComplete: false };
    }

    return this._resolveTrick();
  }

  _resolveTrick() {
    const isFirst = this.trickNumber === 1;
    const isFinal = this.trickNumber === this.maxTricks;
    const jokerZero = isFirst || isFinal;

    let winnerIdx = 0;
    let winnerValue = -1;

    for (let i = 0; i < this.currentTrick.length; i++) {
      const { card } = this.currentTrick[i];

      if (card.rank === 'JOKER') {
        if (!jokerZero) {
          winnerIdx = i;
          winnerValue = Infinity;
          break;
        }
        continue;
      }

      let value = RANK_VALUES[card.rank];
      let priority = 0;

      if (card.suit === this.trumpSuit) {
        priority = 2;
      } else if (card.suit === this.leadSuit) {
        priority = 1;
      }

      const score = priority * 100 + value;

      if (score > winnerValue) {
        winnerValue = score;
        winnerIdx = i;
      }
    }

    const winner = this.currentTrick[winnerIdx];
    this.pendingTrickWinner = {
      seat: winner.seat,
      playerId: winner.playerId,
    };

    return { ok: true, trickComplete: true, pending: true };
  }

  resolvePendingTrick() {
    if (!this.pendingTrickWinner) return { error: 'No pending trick' };

    const winner = this.pendingTrickWinner;
    const winnerEntityId = this._entityId(winner.seat);
    this.tricksWon[winnerEntityId]++;

    this.lastTrick = {
      cards: [...this.currentTrick],
      winnerSeat: winner.seat,
      winnerId: winner.playerId,
      trickNumber: this.trickNumber,
    };

    this.previousTrickWinnerSeat = winner.seat;
    this.currentTrick = [];
    this.leadSuit = null;
    this.pendingTrickWinner = null;

    if (this.trickNumber >= this.maxTricks) {
      return this._endRound();
    }

    this.trickNumber++;
    this.leaderSeat = winner.seat;
    this.currentPlayerSeat = winner.seat;

    return { ok: true };
  }

  _endRound() {
    this.phase = 'round_end';

    for (const eid of this._entityIds()) {
      this.roundScores[eid] = calculateScore(
        this.calls[eid],
        this.tricksWon[eid],
        this.playerCount
      );
      this.cumulativeScores[eid] = Math.round((this.cumulativeScores[eid] + this.roundScores[eid]) * 10) / 10;
    }

    return { ok: true, trickComplete: true, roundEnd: true };
  }

  nextRound() {
    if (this.phase !== 'round_end') return { error: 'Not at round end' };
    this.dealerSeat = (this.dealerSeat + 1) % this.playerCount;
    this.startRound();
    return { ok: true };
  }

  _endGameTally() {
    // Only players who are present can vote, so requiring every seat makes
    // ending the game impossible as soon as one person drops.
    const present = this.players.filter(p => p.connected);
    const votes = present.filter(p => this.endGameRequests.has(p.id)).length;
    return { votes, needed: present.length };
  }

  requestEndGame(playerId) {
    this.endGameRequests.add(playerId);
    const { votes, needed } = this._endGameTally();
    if (needed > 0 && votes >= needed) {
      this.phase = 'game_over';
      return { ok: true, gameOver: true };
    }
    return { ok: true, gameOver: false };
  }

  cancelEndGame(playerId) {
    this.endGameRequests.delete(playerId);
    return { ok: true };
  }

  getStateForPlayer(playerId) {
    const seat = this._seatOfPlayer(playerId);
    const hand = (this._getHand(playerId) || []).map(c => ({
      ...c,
      isLegal: this.phase === 'playing' && this.currentPlayerSeat === seat
        ? !!this.getLegalCards(playerId).find(lc => lc.id === c.id)
        : false,
    }));

    const players = this.players.map(p => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      connected: p.connected,
      cardsRemaining: (this.hands[p.id] || []).length,
      isDealer: p.seat === this.dealerSeat,
      isColorPicker: p.seat === this.colorPickerSeat,
      isCurrentTurn: p.seat === this.currentPlayerSeat && this.phase === 'playing',
      isYou: p.id === playerId,
    }));

    let callInfo = null;
    if (this.phase === 'calling') {
      const currentCaller = this._currentCaller();
      let canYouCall = this._canSubmitCall(playerId);
      const submitted = Object.keys(this.calls).length;
      const total = this.callOrder.length;

      callInfo = { currentCaller, canYouCall, submitted, total, callOrder: this.callOrder };
    }

    let teamInfo = null;
    if (this.gameMode !== 'ffa') {
      teamInfo = this.teams.map(t => ({
        id: t.id,
        seats: t.seats,
        playerIds: t.playerIds,
        playerNames: t.playerIds.map(pid => this.players.find(p => p.id === pid)?.name),
      }));
    }

    const entityId = this.phase !== 'lobby' ? this._entityId(seat) : null;

    return {
      phase: this.phase,
      gameMode: this.gameMode,
      playerCount: this.playerCount,
      maxTricks: this.maxTricks,
      roundNumber: this.roundNumber,
      players,
      teams: teamInfo,
      you: {
        id: playerId,
        seat,
        hand,
        entityId,
      },
      trumpSuit: this.trumpSuit,
      colorCard: this.colorCard,
      dealerSeat: this.dealerSeat,
      colorPickerSeat: this.colorPickerSeat,
      callInfo,
      callsRevealed: this.callsRevealed,
      calls: this.callsRevealed ? { ...this.calls } : null,
      currentTrick: this.currentTrick.map(t => ({
        playerId: t.playerId,
        seat: t.seat,
        card: t.card,
      })),
      trickNumber: this.trickNumber,
      leaderSeat: this.leaderSeat,
      currentPlayerSeat: this.currentPlayerSeat,
      tricksWon: { ...this.tricksWon },
      roundScores: this.phase === 'round_end' || this.phase === 'game_over' ? { ...this.roundScores } : null,
      cumulativeScores: { ...this.cumulativeScores },
      endGameRequests: [...this.endGameRequests],
      endGameNeeded: this._endGameTally().needed,
      waitingFor: this.phase === 'playing' && !this.pendingTrickWinner
        ? (this.players.find(p => p.seat === this.currentPlayerSeat && !p.connected) || null)
        : null,
      lastTrick: this.lastTrick,
      pendingTrickWinner: this.pendingTrickWinner ? {
        seat: this.pendingTrickWinner.seat,
        playerId: this.pendingTrickWinner.playerId,
      } : null,
    };
  }
}

module.exports = { GameEngine, SUIT_SYMBOLS, SUITS, RANKS };
