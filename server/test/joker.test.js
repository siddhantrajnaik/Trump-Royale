// Joker classification rules.
//
// The Joker is a suitless special card. It is NOT a Trump/Color card. It beats
// Trump on middle tricks because it carries its own priority, never because it
// belongs to the Trump suit. These tests pin that distinction down so it cannot
// quietly regress.
const assert = require('node:assert');
const { test } = require('./harness');
const { GameEngine } = require('../game/engine');

const JOKER = { suit: null, rank: 'JOKER', id: 'JOKER' };
const card = (suit, rank) => ({ suit, rank, id: rank + suit[0].toUpperCase() });

// Build a game sitting in the playing phase with a known trump suit.
function table(playerCount, trumpSuit, mode) {
  const e = new GameEngine(mode || 'ffa', playerCount);
  for (let i = 0; i < playerCount; i++) e.addPlayer('p' + i, 'P' + i);
  e.startGame();
  for (let g = 0; g < 30; g++) {
    const c = e.players.find(p => e._canSubmitCall(p.id));
    if (!c) break;
    e.submitCall(c.id, 1);
  }
  e.trumpSuit = trumpSuit;
  return e;
}

// Resolve one trick from a list of [seat, card] and return the winning seat.
function winnerOf(e, trickNumber, leadSuit, plays) {
  e.trickNumber = trickNumber;
  e.leadSuit = leadSuit;
  e.currentTrick = plays.map(([seat, c]) => ({ playerId: 'p' + seat, seat, card: c }));
  e.pendingTrickWinner = null;
  e._resolveTrick();
  return e.pendingTrickWinner.seat;
}

// 1. The Joker is never classified as Trump.
test('1. Joker is never classified as Trump', () => {
  const e = table(5, 'hearts');
  const seat = 0;
  e.hands['p0'] = [JOKER, card('hearts', 'A'), card('spades', 'K')];
  const view = e.getStateForPlayer('p0');
  const joker = view.you.hand.find(c => c.rank === 'JOKER');

  assert.strictEqual(joker.suit, null, 'Joker suit must be null');
  assert.strictEqual(joker.isJoker, true, 'Joker must be flagged isJoker');
  assert.strictEqual(joker.isTrump, false, 'Joker must never be flagged isTrump');

  const trumpCard = view.you.hand.find(c => c.id === 'AH');
  assert.strictEqual(trumpCard.isTrump, true, 'a real hearts card is Trump this round');
  assert.strictEqual(trumpCard.isJoker, false, 'a real card is not the Joker');

  // The hazard: when the color card IS the Joker there is no Trump suit, and a
  // naive `card.suit === trumpSuit` makes null match null.
  e.trumpSuit = null;
  const noTrump = e.getStateForPlayer('p0');
  const j2 = noTrump.you.hand.find(c => c.rank === 'JOKER');
  assert.strictEqual(j2.isTrump, false, 'Joker is not Trump even when trumpSuit is null');
  assert.ok(noTrump.you.hand.every(c => c.isTrump === false), 'no card is Trump when there is no Trump suit');
});

// 2. The Joker beats Trump by special priority, not by being Trump.
test('2. Joker beats the highest Trump on a middle trick', () => {
  const e = table(5, 'hearts');
  const winner = winnerOf(e, 5, 'spades', [
    [0, card('spades', 'A')],   // highest lead suit
    [1, card('hearts', 'A')],   // highest trump
    [2, JOKER],                 // should take it
    [3, card('spades', '3')],
    [4, card('hearts', 'K')],
  ]);
  assert.strictEqual(winner, 2, 'Joker takes the middle trick over the highest Trump');

  // Same trick without the Joker: the highest Trump wins, proving the Trump
  // ladder itself is untouched.
  const e2 = table(5, 'hearts');
  const w2 = winnerOf(e2, 5, 'spades', [
    [0, card('spades', 'A')],
    [1, card('hearts', 'A')],
    [2, card('clubs', '9')],
    [3, card('spades', '3')],
    [4, card('hearts', 'K')],
  ]);
  assert.strictEqual(w2, 1, 'without the Joker the highest Trump wins');

  // And with no Trump suit at all the Joker still wins on its own priority.
  const e3 = table(5, null);
  const w3 = winnerOf(e3, 5, 'spades', [
    [0, card('spades', 'A')],
    [1, JOKER],
    [2, card('spades', 'K')],
    [3, card('spades', '3')],
    [4, card('spades', '4')],
  ]);
  assert.strictEqual(w3, 1, 'Joker wins on priority even with no Trump suit in play');
});

// 3. The Joker is not counted as a Trump card.
test('3. Joker is excluded from Trump counts', () => {
  const e = table(5, 'hearts');
  e.hands['p0'] = [JOKER, card('hearts', 'A'), card('hearts', '7'), card('spades', 'K')];
  const hand = e.getStateForPlayer('p0').you.hand;

  const trumps = hand.filter(c => c.isTrump);
  assert.strictEqual(trumps.length, 2, 'exactly the two hearts count as Trump');
  assert.ok(!trumps.some(c => c.rank === 'JOKER'), 'the Joker is not among them');
  assert.strictEqual(hand.filter(c => c.isJoker).length, 1, 'exactly one Joker');

  // Counting by suit must not sweep the Joker in either.
  assert.strictEqual(hand.filter(c => c.suit === e.trumpSuit).length, 2, 'suit-based count also excludes it');
});

// 4 & 5. Zero value on the first and final tricks.
test('4. Trick 1 Joker has zero winning value', () => {
  const e = table(5, 'hearts');
  const winner = winnerOf(e, 1, 'spades', [
    [0, card('spades', 'A')],
    [1, JOKER],
    [2, card('spades', 'K')],
    [3, card('spades', '3')],
    [4, card('spades', '4')],
  ]);
  assert.strictEqual(winner, 0, 'A of the lead suit wins trick 1, not the Joker');
});

test('5. Final trick Joker has zero winning value', () => {
  const e = table(5, 'hearts');
  assert.strictEqual(e.maxTricks, 10, '5-player rounds run to 10 tricks');
  const winner = winnerOf(e, 10, 'spades', [
    [0, card('spades', 'A')],
    [1, JOKER],
    [2, card('spades', 'K')],
    [3, card('spades', '3')],
    [4, card('spades', '4')],
  ]);
  assert.strictEqual(winner, 0, 'A of the lead suit wins the final trick, not the Joker');

  // A zero-value Joker must not beat Trump on the final trick either.
  const e2 = table(5, 'hearts');
  const w2 = winnerOf(e2, 10, 'spades', [
    [0, card('spades', 'A')],
    [1, JOKER],
    [2, card('hearts', '2')],
  ]);
  assert.strictEqual(w2, 2, 'the lowest Trump still beats a zero-value Joker');
});

// 6. The Joker is suitless and exempt from follow-suit.
test('6. Joker is suitless and exempt from follow-suit', () => {
  const e = table(5, 'hearts');
  e.hands['p1'] = [JOKER, card('spades', 'K'), card('clubs', '9')];
  e.currentPlayerSeat = 1;
  e.leadSuit = 'spades';
  e.currentTrick = [{ playerId: 'p0', seat: 0, card: card('spades', 'A') }];

  const legal = e.getLegalCards('p1').map(c => c.id);
  assert.ok(legal.includes('JOKER'), 'Joker is legal even while holding the lead suit');
  assert.ok(legal.includes('KS'), 'the lead-suit card is legal');
  assert.ok(!legal.includes('9C'), 'an off-suit non-Joker is still illegal');
  assert.strictEqual(legal.length, 2, 'exactly the lead suit plus the Joker');

  // Leading with the Joker leaves the trick suitless.
  const e2 = table(5, 'hearts');
  e2.hands['p0'] = [JOKER, card('spades', 'K')];
  e2.currentPlayerSeat = 0;
  e2.leaderSeat = 0;
  e2.currentTrick = [];
  e2.leadSuit = null;
  e2.playCard('p0', 'JOKER');
  assert.strictEqual(e2.leadSuit, null, 'a Joker lead sets no lead suit');
});

// 7. The last-card exception keeps the game finishable.
test('7. Joker as the last card may be led, without becoming Trump', () => {
  const e = table(5, 'hearts');
  e.hands['p0'] = [JOKER];
  e.currentPlayerSeat = 0;
  e.currentTrick = [];
  e.leadSuit = null;
  e.previousTrickWinnerSeat = 0; // won the previous trick: normally barred

  const legal = e.getLegalCards('p0');
  assert.strictEqual(legal.length, 1, 'the only card is playable rather than deadlocking');
  assert.strictEqual(legal[0].rank, 'JOKER');

  // The exception must not reclassify it.
  const view = e.getStateForPlayer('p0');
  assert.strictEqual(view.you.hand[0].isTrump, false, 'still not Trump');
  assert.strictEqual(view.you.hand[0].isJoker, true, 'still the Joker');

  // With another card available the restriction still applies.
  const e2 = table(5, 'hearts');
  e2.hands['p0'] = [JOKER, card('spades', 'K')];
  e2.currentPlayerSeat = 0;
  e2.currentTrick = [];
  e2.leadSuit = null;
  e2.previousTrickWinnerSeat = 0;
  const legal2 = e2.getLegalCards('p0').map(c => c.id);
  assert.deepStrictEqual(legal2, ['KS'], 'Joker still barred when a real card exists');
});

// 8. The same rules hold for the 4- and 6-player modes.
test('8. Joker rules hold identically in 4P and 6P', () => {
  for (const [count, mode, finalTrick] of [[4, '2v2', 13], [4, 'ffa', 13], [6, '3v3', 8], [5, 'ffa', 10]]) {
    const label = count + 'P ' + mode;
    const e = table(count, 'hearts', mode);
    assert.strictEqual(e.maxTricks, finalTrick, label + ': trick count unchanged');

    const plays = [[0, card('spades', 'A')], [1, card('hearts', 'A')], [2, JOKER]];
    assert.strictEqual(winnerOf(table(count, 'hearts', mode), 5, 'spades', plays), 2,
      label + ': Joker beats Trump mid-round');
    assert.strictEqual(winnerOf(table(count, 'hearts', mode), 1, 'spades', plays), 1,
      label + ': Joker is zero value on trick 1, Trump takes it');
    assert.strictEqual(winnerOf(table(count, 'hearts', mode), finalTrick, 'spades', plays), 1,
      label + ': Joker is zero value on the final trick, Trump takes it');

    const e2 = table(count, 'hearts', mode);
    e2.hands['p0'] = [JOKER, card('hearts', 'A'), card('spades', 'K')];
    const hand = e2.getStateForPlayer('p0').you.hand;
    const j = hand.find(c => c.rank === 'JOKER');
    assert.strictEqual(j.isTrump, false, label + ': Joker not Trump');
    assert.strictEqual(j.isJoker, true, label + ': Joker flagged');
    assert.strictEqual(hand.filter(c => c.isTrump).length, 1, label + ': only the real Trump counts');
  }
});
