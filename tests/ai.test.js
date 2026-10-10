import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import phe from 'phe';
import { PokerRoom, evaluateHand } from '../poker-engine.js';
import { analyzeDecision, chooseBotAction, gradeDecision, AI_LINKS } from '../poker-ai.js';

const card = value => ({ rank: value[0], suit: value[1], value: '23456789TJQKA'.indexOf(value[0]) + 2 });
const cards = value => value ? value.split(' ').map(card) : [];
function snapshot({ hole = 'AS AH', board = '', phase = 'preflop', count = 2, toCall = 100,
  currentBet = 100, pot = 150, chips = 10000, canRaise = true, lastAction = '', dealer = 0 } = {}) {
  const players = Array.from({ length: count }, (_, index) => ({
    id: `p${index}`, name: `玩家${index}`, seat: index, chips: index === 0 ? chips : 10000,
    bet: index === 0 ? Math.max(0, currentBet - toCall) : currentBet,
    totalBet: index === 0 ? Math.max(0, currentBet - toCall) : currentBet,
    inHand: true, folded: false, allIn: false, connected: true,
    cards: index === 0 ? cards(hole) : [{ hidden: true }, { hidden: true }],
    lastAction: index === 0 ? '' : lastAction,
  }));
  const maxRaise = players[0].bet + chips;
  const minRaise = Math.max(100, currentBet + 100);
  return {
    code: 'AITEST', phase, actorId: 'p0', players, board: cards(board), pot,
    currentBet, minRaise: 100, dealerSeat: dealer, smallBlindSeat: count === 2 ? dealer : (dealer + 1) % count,
    bigBlindSeat: count === 2 ? 1 - dealer : (dealer + 2) % count,
    bigBlind: 100, smallBlind: 50, config: { bigBlind: 100, maxPlayers: count },
    legalActions: { canAct: true, toCall, canCheck: toCall === 0, canRaise, canAllIn: maxRaise <= currentBet || canRaise, minRaise, maxRaise },
  };
}
const opts = { seed: 'deterministic-ai-test', iterations: 1400 };

test('GitHub phe evaluator agrees with the existing engine for true best-seven rankings', () => {
  const examples = ['AS KS QS JS TS 2D 3C', 'AS AH AD KS KH KD 2C',
    'AS 2H 3D 4C 5S 8H 9D', 'AS AH KS KH 3D 4C 5S', 'AS JC 8D 7H 4S 3H 2C'];
  for (const example of examples) {
    const engine = evaluateHand(cards(example));
    const fast = phe.evaluateCards(example.split(' ').map(value => value[0] + value[1].toLowerCase()));
    assert.equal(8 - phe.handRank(fast), engine.category);
  }
  assert.equal(AI_LINKS[0].url, 'https://github.com/thlorenz/phe');
  assert.equal(AI_LINKS[0].license, 'MIT');
});

test('AA has high preflop equity and opens for value, while 72o folds facing expensive aggression', () => {
  const strong = analyzeDecision(snapshot(), opts);
  assert.ok(strong.equity > 0.78 && strong.equity < 0.9, JSON.stringify(strong));
  assert.equal(strong.recommendation.type, 'raise');
  assert.equal(strong.handLabel, 'AA · 口袋对子');
  assert.ok(strong.reasons.length >= 4);
  const weak = analyzeDecision(snapshot({ hole: '7S 2H', currentBet: 1200, toCall: 1100,
    pot: 1300, lastAction: '加注到 1200' }), opts);
  assert.equal(weak.recommendation.type, 'fold');
  assert.ok(weak.equity < strong.equity - 0.35);
  assert.equal(weak.isGTO, false);
  assert.equal(typeof weak.source, 'string');
  assert.ok(weak.limitations.some(text => /精确 EV/.test(text)));
});

test('river nuts have full equity and value-bet; unpaired low cards fold large river bets', () => {
  const nuts = analyzeDecision(snapshot({ phase: 'river', hole: 'AS KS', board: 'QS JS TS 2D 3C',
    currentBet: 0, toCall: 0, pot: 1000 }), opts);
  assert.equal(nuts.equity, 1);
  assert.equal(nuts.handLabel, '同花顺');
  assert.equal(nuts.recommendation.type, 'raise');
  assert.ok(nuts.recommendation.amount >= 100);
  const weak = analyzeDecision(snapshot({ phase: 'river', hole: '3S 2H', board: 'AD KC QH 9C 7D',
    currentBet: 1000, toCall: 1000, pot: 1400, lastAction: '下注 1000' }), opts);
  assert.ok(weak.equity < 0.08);
  assert.equal(weak.recommendation.type, 'fold');
});

test('board-only royal flush is a shared pot, never reported as 100% equity', () => {
  const analysis = analyzeDecision(snapshot({ phase: 'river', hole: '2C 3D', board: 'AS KS QS JS TS',
    count: 4, currentBet: 0, toCall: 0, pot: 1000 }), opts);
  assert.equal(analysis.equity, 0.25);
  assert.equal(analysis.winRate, 0);
  assert.equal(analysis.tieRate, 1);
  assert.equal(analysis.recommendation.type, 'check');
});

test('seeded simulation is reproducible and opponent hidden or visible cards never affect analysis', () => {
  const input = snapshot({ hole: 'JS TH', phase: 'flop', board: '9S 8D 2C', currentBet: 0, toCall: 0 });
  const first = analyzeDecision(input, opts);
  const second = analyzeDecision(input, opts);
  assert.deepEqual(first, second);
  const visible = structuredClone(input);
  visible.players[1].cards = cards('AS AH');
  assert.deepEqual(analyzeDecision(visible, opts), first);
  Object.defineProperty(input.players[1], 'cards', { get() { throw new Error('PRIVATE CARDS READ'); } });
  assert.deepEqual(analyzeDecision(input, opts), first);
  assert.ok(first.draws.includes('两端顺子听牌'));
  const flush = analyzeDecision(snapshot({ hole: 'AS 5S', phase: 'flop', board: 'QS 8S 2D', currentBet: 0, toCall: 0 }), opts);
  assert.ok(flush.draws.includes('坚果同花听牌'));
});

test('uniform equities are plausible and decrease against more live opponents', () => {
  const single = analyzeDecision(snapshot({ hole: 'AS AH' }), { ...opts, rangeModel: 'uniform' });
  const multi = analyzeDecision(snapshot({ hole: 'AS AH', count: 6 }), { ...opts, rangeModel: 'uniform' });
  assert.ok(single.equity >= 0.79 && single.equity <= 0.89);
  assert.ok(multi.equity < single.equity - 0.25);
  assert.ok(multi.equity > 0.35 && multi.equity < 0.58);
});

test('pot odds use actual call cost and exclude side pots the short stack cannot win', () => {
  const input = snapshot({ chips: 100, currentBet: 1000, toCall: 1000, pot: 2000, count: 3, canRaise: false });
  input.players[1].totalBet = 1000;
  input.players[2].totalBet = 1000;
  const analysis = analyzeDecision(input, opts);
  assert.equal(analysis.callCost, 100);
  assert.equal(analysis.eligiblePot, 200);
  assert.equal(analysis.potOdds, 0.3333);
  assert.equal(analysis.callIsAllIn, true);
  assert.ok(analysis.reasons.some(reason => /边池/.test(reason)));
});

test('missing own cards returns unavailable, and visible own cards do not permit acting out of turn', () => {
  const hidden = snapshot();
  hidden.players[0].cards = [{ hidden: true }, { hidden: true }];
  assert.equal(analyzeDecision(hidden, opts).available, false);
  assert.throws(() => chooseBotAction(hidden, opts), /没有可执行/);
  const waiting = snapshot();
  waiting.actorId = 'p1';
  waiting.legalActions.canAct = false;
  const result = analyzeDecision(waiting, { ...opts, heroId: 'p0' });
  assert.equal(result.available, true);
  assert.equal(result.recommendation, null);
  assert.throws(() => analyzeDecision(snapshot({ hole: 'AS AS' }), opts), /重复/);
});

test('closed raise rights never produce a raising all-in, and a short legal full-stack raise stays legal', () => {
  const closed = snapshot({ hole: 'AS AH', currentBet: 150, toCall: 50, canRaise: false });
  assert.equal(chooseBotAction(closed, opts).type, 'call');
  const short = snapshot({ hole: 'AS AH', chips: 130, currentBet: 100, toCall: 100 });
  assert.equal(chooseBotAction(short, opts).type, 'allin');
  const free = snapshot({ hole: '7S 2H', currentBet: 100, toCall: 0, canRaise: false });
  assert.equal(chooseBotAction(free, opts).type, 'check');
});

test('coaching grades agreement without disguising heuristic scores as exact EV', () => {
  const analysis = analyzeDecision(snapshot(), opts);
  assert.equal(gradeDecision(analysis, analysis.recommendation).grade, 'good');
  const expensive = analyzeDecision(snapshot({ hole: '7S 2H', currentBet: 1200, toCall: 1100,
    pot: 1300, lastAction: '加注到 1200' }), opts);
  assert.equal(gradeDecision(expensive, { type: 'call' }).grade, 'improve');
  const call = analyzeDecision(snapshot({ hole: 'AS AH', currentBet: 150, toCall: 50, canRaise: false }), opts);
  assert.equal(call.recommendation.type, 'call');
  assert.notEqual(gradeDecision(call, { type: 'allin' }).grade, 'good');
  const free = analyzeDecision(snapshot({ hole: '7S 2H', currentBet: 100, toCall: 0, canRaise: false }), opts);
  assert.equal(gradeDecision(free, { type: 'fold' }).grade, 'improve');
  assert.equal(gradeDecision(null, { type: 'call' }).grade, 'discuss');
});

test('bot respects legal engine actions throughout six-player hands and does not mutate snapshots', () => {
  const room = new PokerRoom('AIROOM', { initialChips: 1000, minBuyIn: 100, maxBuyIn: 2000,
    smallBlind: 20, bigBlind: 40, ante: 5, maxPlayers: 6 });
  for (let i = 0; i < 6; i++) room.addPlayer(`p${i}`, `AI${i}`, { bot: true });
  for (let hand = 0; hand < 3 && room.players.filter(player => player.chips > 0).length >= 2; hand++) {
    room.startHand();
    let count = 0;
    while (room.phase !== 'showdown') {
      const input = room.snapshot(room.actorId);
      const before = JSON.stringify(input);
      const action = chooseBotAction(input, { iterations: 120, seed: `${hand}:${count}`, style: ['tight', 'aggressive', 'balanced'][count % 3] });
      assert.equal(JSON.stringify(input), before);
      room.act(room.actorId, action);
      assert.ok(++count < 200);
    }
    assert.equal(room.players.reduce((sum, player) => sum + player.chips, 0), 6000);
  }
});

test('sample limits bound computation and result is JSON-safe', () => {
  const input = snapshot({ phase: 'turn', hole: 'AS KH', board: 'QS JD 9C 2H', count: 6,
    currentBet: 100, toCall: 100, pot: 1000 });
  const started = performance.now();
  const result = analyzeDecision(input, { ...opts, iterations: 100000 });
  assert.equal(result.sampleCount, 2400);
  assert.ok(performance.now() - started < 2000);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal(analyzeDecision(input, { ...opts, iterations: 0 }).sampleCount, 100);
});
