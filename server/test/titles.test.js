// Round titles: Raja Babu for the round's best score, Maichia for the worst.
const assert = require('node:assert');
const { test } = require('./harness');
const { GameEngine } = require('../game/engine');

function build(mode, count) {
  const e = new GameEngine(mode, count);
  for (let i = 0; i < count; i++) e.addPlayer('p' + i, 'P' + i);
  e.startGame();
  return e;
}

// End the round with a chosen [call, tricks] per entity, in _entityIds order.
function finish(e, results) {
  const ids = e._entityIds();
  results.forEach(([call, tricks], i) => {
    e.calls[ids[i]] = call;
    e.tricksWon[ids[i]] = tricks;
  });
  e._endRound();
  return e.getStateForPlayer('p0').titles;
}

test('titles: best round score is Raja Babu, worst is Maichia', () => {
  const e = build('ffa', 4);
  // scores: 3.0, -5.0, 2.1, 1.0
  const t = finish(e, [[3, 3], [5, 2], [2, 3], [1, 1]]);
  assert.deepStrictEqual(t, { rajaBabu: ['p0'], maichia: ['p1'] });
});

test('titles: in team modes every teammate wears the banner', () => {
  const e2 = build('2v2', 4);                       // teams: p0+p2, p1+p3
  assert.deepStrictEqual(finish(e2, [[4, 6], [4, 1]]),
    { rajaBabu: ['p0', 'p2'], maichia: ['p1', 'p3'] });

  const e3 = build('3v3', 6);                       // p0+p3, p1+p4, p2+p5
  assert.deepStrictEqual(finish(e3, [[2, 1], [3, 3], [2, 2]]),
    { rajaBabu: ['p1', 'p4'], maichia: ['p0', 'p3'] });
});

test('titles: ties share the title, and a level round awards none', () => {
  const e = build('ffa', 5);
  // scores: 2.0, 2.0, -3.0, 1.0, -3.0
  assert.deepStrictEqual(finish(e, [[2, 2], [2, 2], [3, 0], [1, 1], [3, 1]]),
    { rajaBabu: ['p0', 'p1'], maichia: ['p2', 'p4'] });

  const level = build('ffa', 4);
  assert.strictEqual(finish(level, [[2, 2], [2, 2], [2, 2], [2, 2]]), null,
    'nobody stood out, so nobody is named');
});

test('titles: they ride through the next round until it ends', () => {
  const e = build('ffa', 4);
  const first = finish(e, [[3, 3], [5, 2], [2, 3], [1, 1]]);
  assert.ok(first, 'awarded at round end');

  e.nextRound();
  assert.strictEqual(e.phase, 'calling');
  assert.deepStrictEqual(e.getStateForPlayer('p0').titles, first,
    'still worn all through the next round');

  const second = finish(e, [[1, 0], [1, 1], [1, 1], [4, 6]]);
  assert.deepStrictEqual(second, { rajaBabu: ['p3'], maichia: ['p0'] }, 'replaced at its end');
});

test('titles: none before the first round has finished', () => {
  const e = build('ffa', 4);
  assert.strictEqual(e.getStateForPlayer('p0').titles, null);
});
