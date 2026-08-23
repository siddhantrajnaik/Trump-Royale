// Mode rules: deck composition, round shape and scoring.
//
// Requirement 8 in the Joker rule correction is that 4- and 6-player behaviour
// is unchanged, so those expectations are written out as literals here rather
// than diffed against a git revision.
const assert = require('node:assert');
const { test } = require('./harness');
const { GameEngine } = require('../game/engine');

function build(mode, count) {
  const e = new GameEngine(mode, count);
  for (let i = 0; i < count; i++) e.addPlayer('p' + i, 'P' + i);
  e.startGame();
  return e;
}
function dealt(e) {
  const all = [];
  for (const pid of Object.keys(e.hands)) all.push(...e.hands[pid].map(c => c.id));
  return all.sort();
}
// Score one entity by driving the round end with fixed calls and tricks.
function score(mode, count, call, tricks) {
  const e = build(mode, count);
  const eid = e._entityIds()[0];
  e.calls = {}; e.tricksWon = {}; e.cumulativeScores = {};
  for (const id of e._entityIds()) { e.calls[id] = call; e.tricksWon[id] = 0; e.cumulativeScores[id] = 0; }
  e.tricksWon[eid] = tricks;
  e._endRound();
  return e.roundScores[eid];
}

const MODES = [
  { mode: '2v2', count: 4, cards: 52, per: 13, tricks: 13, teams: 2 },
  { mode: 'ffa', count: 4, cards: 52, per: 13, tricks: 13, teams: 0 },
  { mode: 'ffa', count: 5, cards: 50, per: 10, tricks: 10, teams: 0 },
  { mode: '3v3', count: 6, cards: 48, per: 8, tricks: 8, teams: 3 },
];

test('deck composition and round shape per mode', () => {
  for (const m of MODES) {
    const label = m.count + 'P ' + m.mode;
    const e = build(m.mode, m.count);
    const ids = dealt(e);

    assert.strictEqual(ids.length, m.cards, label + ': deck size');
    assert.strictEqual(new Set(ids).size, m.cards, label + ': all cards distinct');
    assert.strictEqual(e.maxTricks, m.tricks, label + ': tricks per round');
    assert.strictEqual(e.teams.length, m.teams, label + ': team count');
    assert.ok(Object.values(e.hands).every(h => h.length === m.per), label + ': cards per player');
    assert.strictEqual(m.per * m.count, m.cards, label + ': deck divides exactly');
    assert.ok(ids.includes('JOKER'), label + ': Joker is in the deck');
    assert.ok(ids.includes(e.colorCard.id), label + ': color card is dealt');
    assert.strictEqual(e.colorPickerSeat, (e.dealerSeat + 1) % m.count, label + ': color picker is dealer + 1');
  }
});

test('4P removes only the 2 of diamonds', () => {
  const ids = dealt(build('2v2', 4));
  assert.ok(!ids.includes('2♦'), '2D removed');
  for (const s of ['♠', '♥', '♣']) {
    assert.ok(ids.includes('2' + s), '2' + s + ' kept');
  }
});

test('5P removes 2S, 2C and 2H only', () => {
  const ids = dealt(build('ffa', 5));
  for (const s of ['♠', '♣', '♥']) {
    assert.ok(!ids.includes('2' + s), '2' + s + ' removed');
  }
  assert.ok(ids.includes('2♦'), '2D kept');
  assert.ok(ids.includes('3♦'), '3D kept');
});

test('6P removes every 2 and the 3 of diamonds', () => {
  const ids = dealt(build('3v3', 6));
  for (const s of ['♠', '♥', '♦', '♣']) {
    assert.ok(!ids.includes('2' + s), '2' + s + ' removed');
  }
  assert.ok(!ids.includes('3♦'), '3D removed');
});

test('scoring: plain formula, and the doubled call per mode', () => {
  // Base rule everywhere: call + 0.1 per overtrick, or minus the call.
  assert.strictEqual(score('ffa', 5, 3, 3), 3.0, 'call 3 take 3');
  assert.ok(Math.abs(score('ffa', 5, 3, 4) - 3.1) < 1e-9, 'call 3 take 4');
  assert.ok(Math.abs(score('ffa', 5, 3, 5) - 3.2) < 1e-9, 'call 3 take 5');
  assert.strictEqual(score('ffa', 5, 10, 10), 10.0, 'call 10 take 10');
  assert.strictEqual(score('ffa', 5, 20, 10), -20.0, 'call 20 take 10 misses');

  // 4P doubles a successful call of 7; 6P doubles a successful call of 5.
  assert.strictEqual(score('2v2', 4, 7, 7), 14.0, '4P call 7 doubled');
  assert.strictEqual(score('2v2', 4, 7, 6), -7.0, '4P call 7 missed is not doubled');
  assert.strictEqual(score('2v2', 4, 5, 5), 5.0, '4P call 5 is not special');
  assert.strictEqual(score('3v3', 6, 5, 5), 10.0, '6P call 5 doubled');
  assert.strictEqual(score('3v3', 6, 7, 7), 7.0, '6P call 7 is not special');

  // 5P uses neither doubling rule.
  assert.strictEqual(score('ffa', 5, 5, 5), 5.0, '5P call 5 not doubled');
  assert.strictEqual(score('ffa', 5, 7, 7), 7.0, '5P call 7 not doubled');
});

test('every mode plays a full round out without deadlocking', () => {
  for (const m of MODES) {
    const label = m.count + 'P ' + m.mode;
    let stuck = 0, wrongTricks = 0;

    for (let r = 0; r < 200; r++) {
      const e = build(m.mode, m.count);
      for (let g = 0; g < 30; g++) {
        const c = e.players.find(p => e._canSubmitCall(p.id));
        if (!c) break;
        e.submitCall(c.id, 2);
      }
      while (e.phase === 'playing') {
        const pid = e.players[e.currentPlayerSeat].id;
        const legal = e.getLegalCards(pid);
        if (!legal.length) { stuck++; break; }
        const res = e.playCard(pid, legal[Math.floor(Math.random() * legal.length)].id);
        if (res.error) { stuck++; break; }
        if (res.pending) e.resolvePendingTrick();
      }
      if (e.phase !== 'round_end') { stuck++; continue; }
      if (Object.values(e.tricksWon).reduce((a, b) => a + b, 0) !== m.tricks) wrongTricks++;
    }

    assert.strictEqual(stuck, 0, label + ': 200 rounds completed without a deadlock');
    assert.strictEqual(wrongTricks, 0, label + ': every round distributed exactly ' + m.tricks + ' tricks');
  }
});

test('reconnecting keeps the seat, hand, call, tricks and score', () => {
  for (const m of MODES) {
    const label = m.count + 'P ' + m.mode;
    const e = build(m.mode, m.count);
    for (let g = 0; g < 30; g++) {
      const c = e.players.find(p => e._canSubmitCall(p.id));
      if (!c) break;
      e.submitCall(c.id, 2);
    }
    const pid = e.players[2].id;
    const ent = e._entityId(2);
    const before = {
      hand: e.hands[pid].map(c => c.id).sort().join(),
      call: e.calls[ent],
      tricks: e.tricksWon[ent],
    };

    e.removePlayer(pid);
    assert.strictEqual(e.players[2].connected, false, label + ': marked offline');
    e.reconnectPlayer(pid, pid);

    assert.strictEqual(e.players[2].connected, true, label + ': marked back online');
    assert.strictEqual(e.hands[pid].map(c => c.id).sort().join(), before.hand, label + ': hand intact');
    assert.strictEqual(e.calls[e._entityId(2)], before.call, label + ': call intact');
    assert.strictEqual(e.tricksWon[e._entityId(2)], before.tricks, label + ': tricks intact');
    assert.ok(e.getStateForPlayer(pid).you.hand.length > 0, label + ': they can see their cards');
  }
});

test('ending the game needs every present player, not every seat', () => {
  const e = build('ffa', 5);
  e.players[4].connected = false;
  for (let i = 0; i < 3; i++) e.requestEndGame(e.players[i].id);
  assert.notStrictEqual(e.phase, 'game_over', '3 of 4 present is not enough');
  e.requestEndGame(e.players[3].id);
  assert.strictEqual(e.phase, 'game_over', 'all 4 present players can end it');
});
