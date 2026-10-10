import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir } from 'node:fs/promises';
import { buildSolverInput, parseSolverResult, solveDecision, solverStatus } from '../solver-adapter.js';

const card = code => ({ rank: code[0], suit: code[1].toUpperCase() });
function river() {
  return {
    phase: 'river', pot: 100, currentBet: 0, bigBlind: 20, dealerSeat: 1, actorId: 'hero',
    players: [
      { id: 'hero', seat: 0, bot: false, inHand: true, folded: false, allIn: false, chips: 100, bet: 0, cards: ['As', 'Ah'].map(card) },
      { id: 'bot', seat: 1, bot: true, inHand: true, folded: false, allIn: false, chips: 100, bet: 0, cards: [{ hidden: true }, { hidden: true }] },
    ],
    board: ['Ks', 'Qh', 'Jd', '2c', '3s'].map(card),
    legalActions: { canAct: true, canCheck: true, canRaise: true, canAllIn: true, minRaise: 20, maxRaise: 100 },
  };
}

test('solver status reports availability and upstream without disclosing server paths', () => {
  const status = solverStatus();
  assert.equal(typeof status.available, 'boolean');
  assert.equal(status.engine, 'TexasSolver');
  assert.equal(status.repository, 'https://github.com/bupticybee/TexasSolver');
  assert.equal(Object.hasOwn(status, 'path'), false);
  assert.doesNotMatch(JSON.stringify(status), /[A-Za-z]:\\|\/Users\/|\/home\//);
});

test('solver input uses broad ranges, current public amounts and only hero cards', () => {
  const snapshot = river();
  Object.defineProperty(snapshot.players[1], 'cards', { get() { throw new Error('Opponent hole cards must never be read'); } });
  const input = buildSolverInput(snapshot);
  assert.match(input.text, /set_pot 100\nset_effective_stack 100/);
  assert.match(input.text, /set_board Ks,Qh,Jd,2c,3s/);
  assert.equal(input.text.split('\n').find(line => line.startsWith('set_range_oop')).split(' ')[1].split(',').length, 169);
  assert.equal(input.heroPosition, 'oop');
  assert.deepEqual(input.path, []);
  assert.deepEqual(input.holes, ['As', 'Ah']);
});

test('an IP first-bet response reconstructs the street pot and follows the OOP bet node', () => {
  const snapshot = river();
  snapshot.dealerSeat = 0;
  snapshot.pot = 150;
  snapshot.currentBet = 50;
  snapshot.players[0].chips = 500;
  snapshot.players[1].chips = 450;
  snapshot.players[1].bet = 50;
  snapshot.legalActions = { canAct: true, canCheck: false, canRaise: true, canAllIn: true, minRaise: 100, maxRaise: 500 };
  const input = buildSolverInput(snapshot);
  assert.equal(input.streetPot, 100);
  assert.equal(input.effectiveStack, 500);
  assert.deepEqual(input.path, [{ kind: 'BET', amount: 50 }]);
  const node = { player: 0, actions: ['FOLD', 'CALL', 'RAISE 250'], strategy: { strategy: { AsAh: [0.1, 0.7, 0.2] } } };
  const parsed = parseSolverResult({ childrens: { 'BET 50.000000': node } }, input, snapshot);
  assert.equal(parsed.recommendation.type, 'call');
  assert.deepEqual(parsed.strategy[2], { type: 'raise', amount: 250, frequency: 0.2 });
});

test('real JSON action frequencies map to legal raise-to and all-in actions', () => {
  const snapshot = river();
  const input = buildSolverInput(snapshot);
  const output = { player: 1, actions: ['CHECK', 'BET 50', 'BET 100'], strategy: { strategy: { AhAs: [0.25, 0.5, 0.25] } } };
  const result = parseSolverResult(output, input, snapshot);
  assert.deepEqual(result.strategy, [
    { type: 'check', frequency: 0.25 }, { type: 'raise', amount: 50, frequency: 0.5 },
    { type: 'allin', amount: 100, frequency: 0.25 },
  ]);
  assert.equal(result.recommendation.amount, 50);
  output.strategy.strategy.AhAs = [1, 1, 1];
  assert.throws(() => parseSolverResult(output, input, snapshot), /频率之和/);
});

test('malformed or illegal positive-frequency solver output cannot become advice', () => {
  const snapshot = river();
  const input = buildSolverInput(snapshot);
  const node = { player: 1, actions: ['CHECK', 'BET 5'], strategy: { strategy: { AsAh: [0.5, 0.5] } } };
  assert.throws(() => parseSolverResult(node, input, snapshot), /不合法/);
  node.player = 0;
  assert.throws(() => parseSolverResult(node, input, snapshot), /位置/);
});

test('unsupported preflop, multiplayer and raised nodes never fabricate GTO frequencies', async () => {
  for (const change of [
    snapshot => { snapshot.phase = 'preflop'; },
    snapshot => { snapshot.players.push({ id: 'extra', bot: true }); },
    snapshot => { snapshot.players[0].bet = 10; snapshot.currentBet = 10; },
    snapshot => { snapshot.players[1].bot = false; },
  ]) {
    const snapshot = river(); change(snapshot);
    const result = await solveDecision(snapshot);
    assert.equal(result.supported, false);
    assert.deepEqual(result.strategy, []);
    assert.equal(result.recommendation, null);
    assert.ok(result.reason);
  }
  assert.throws(() => buildSolverInput(river(), { rangeOop: 'AA\nstart_solve' }), /范围/);
});

test('missing or invalid host executable produces an explicit unavailable result', async () => {
  const previous = process.env.TEXAS_SOLVER_PATH;
  try {
    process.env.TEXAS_SOLVER_PATH = 'relative/untrusted.exe';
    assert.equal(solverStatus().available, false);
    const result = await solveDecision(river());
    assert.equal(result.available, false);
    assert.equal(result.supported, false);
    assert.match(result.reason, /solver:setup/);
  } finally {
    if (previous === undefined) delete process.env.TEXAS_SOLVER_PATH;
    else process.env.TEXAS_SOLVER_PATH = previous;
  }
});

test('official installed CLI really solves a river, serializes work and cleans timeout files', {
  skip: process.env.RUN_SOLVER_INTEGRATION !== '1' || !solverStatus().available,
  timeout: 65000,
}, async () => {
  const options = { rangeOop: 'AA,KK,QQ,JJ,AK,AQ,KQ', rangeIp: 'AA,KK,QQ,JJ,AK,AQ,KQ', timeoutMs: 45000, maxIterations: 100 };
  const pending = solveDecision(river(), options);
  const busy = await solveDecision(river(), options);
  assert.equal(busy.supported, false);
  assert.match(busy.reason, /正在处理/);
  const result = await pending;
  assert.equal(result.available, true);
  assert.equal(result.supported, true, result.reason);
  assert.ok(result.strategy.length >= 2);
  assert.ok(Math.abs(result.strategy.reduce((sum, action) => sum + action.frequency, 0) - 1) < 1e-6);
  assert.equal(result.source, 'TexasSolver CLI');
  assert.equal(typeof result.exploitabilityPercent, 'number');
  assert.ok(result.elapsedMs > 0);
  const timeout = await solveDecision(river(), { ...options, timeoutMs: 1 });
  assert.equal(timeout.supported, false);
  assert.match(timeout.reason, /超时/);
  assert.deepEqual(await readdir(new URL('../.solver/jobs/', import.meta.url)), []);
  console.log(`真实 TexasSolver 河牌已验证：${result.elapsedMs} ms，exploitability ${result.exploitabilityPercent}%。`);
});
