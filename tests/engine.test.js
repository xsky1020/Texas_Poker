import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfig, PokerRoom, evaluateHand, compareHands } from '../poker-engine.js';

const now = Date.now();
const card = value => ({ rank: value[0], suit: value[1], value: '23456789TJQKA'.indexOf(value[0]) + 2 });
const cards = value => value.split(' ').map(card);
const roomWith = (count = 3, config = {}) => {
  const room = new PokerRoom('TEST01', {
    smallBlind: 5, bigBlind: 10, minBuyIn: 1, maxBuyIn: 10000, initialChips: 1000, ...config,
  });
  for (let i = 0; i < count; i++) room.addPlayer(String(i), `玩家${i}`);
  return room;
};
const putBoardInDeck = (room, board) => {
  const values = cards(board);
  room.deck = [card('4H'), ...values.slice(0, 3), card('5H'), values[3], card('6H'), values[4]].reverse();
};
const totalChips = room => room.players.reduce((sum, player) => sum + player.chips, 0);
const conservedTotal = room => totalChips(room) + (room.phase === 'showdown' ? 0 : room.players.reduce((sum, player) => sum + player.totalBet, 0));

test('all nine hand categories, royal flush, wheel and best five of seven', () => {
  const examples = [
    'AS KD JH 9C 7S', 'AS AH KD JC 7S', 'AS AH KD KC 7S',
    'AS AH AD KC 7S', '9S 8H 7D 6C 5S', 'AS JS 9S 7S 2S',
    'AS AH AD KC KS', 'AS AH AD AC KS', 'AS KS QS JS TS',
  ];
  examples.forEach((value, category) => assert.equal(evaluateHand(cards(value)).category, category));
  assert.equal(evaluateHand(cards(examples[8])).kickers[0], 14);
  const wheel = evaluateHand(cards('AS 2H 3D 4C 5S'));
  assert.deepEqual(wheel.kickers, [5]);
  assert.equal(compareHands(evaluateHand(cards('2S 3H 4D 5C 6S')), wheel), 1);
  const doubleTrips = evaluateHand(cards('AS AH AD KS KH KD 2C'));
  assert.equal(doubleTrips.category, 6);
  assert.deepEqual(doubleTrips.kickers, [14, 13]);
  const best = evaluateHand(cards('AS KS QS JS TS 2D 3C'));
  assert.equal(best.category, 8);
  assert.equal(best.cards.length, 5);
});

test('hand comparisons use all kickers and board-only ties', () => {
  assert.equal(compareHands(evaluateHand(cards('AS AH KC QD JS')), evaluateHand(cards('AD AC KH QS TC'))), 1);
  assert.equal(compareHands(evaluateHand(cards('AS AH KS KH 2D')), evaluateHand(cards('AD AC QS QH KC'))), 1);
  assert.equal(compareHands(evaluateHand(cards('AS AH KS KH 3D')), evaluateHand(cards('AD AC KC KD 2S'))), 1);
  assert.equal(compareHands(evaluateHand(cards('AS KS QS JS TS 2C 3C')), evaluateHand(cards('AS KS QS JS TS 4D 5D'))), 0);
  assert.throws(() => evaluateHand(cards('AS AS QS JS TS')), /重复/);
  assert.throws(() => evaluateHand(cards('AS KS')), /5–7/);
});

test('configuration rejects malformed, unsafe and inconsistent values', () => {
  assert.deepEqual(validateConfig(), DEFAULT_CONFIG);
  assert.equal(validateConfig({ roomName: '  周六牌局  ' }).roomName, '周六牌局');
  for (const input of [
    { smallBlind: 101, bigBlind: 100 }, { minBuyIn: 20001 }, { initialChips: 100 },
    { maxPlayers: 10 }, { turnSeconds: 0 }, { blindMultiplier: 1.5 },
    { bigBlind: Number.MAX_SAFE_INTEGER + 1 }, { autoDeal: 'true' },
    { roomName: '' }, { unknown: 4 }, { constructor: 'invalid' }, null,
  ]) assert.throws(() => validateConfig(input));
  assert.equal(validateConfig({ turnSeconds: 1 }, { ...DEFAULT_CONFIG, maxPlayers: 9 }).maxPlayers, 9);
});

test('heads-up dealer posts small blind, acts first preflop and last postflop', () => {
  const room = roomWith(2);
  room.startHand(now);
  assert.equal(room.dealerSeat, 0);
  assert.equal(room.smallBlindSeat, 0);
  assert.equal(room.bigBlindSeat, 1);
  assert.equal(room.actorId, '0');
  room.act('0', { type: 'call' }, now);
  assert.equal(room.actorId, '1');
  assert.equal(room.legalActions('1').canCheck, true);
  room.act('1', { type: 'check' }, now);
  assert.equal(room.phase, 'flop');
  assert.equal(room.actorId, '1');
  while (room.phase !== 'showdown') room.act(room.actorId, { type: 'check' }, now);
  assert.equal(totalChips(room), 2000);
  room.startHand(now + 100);
  assert.equal(room.dealerSeat, 1);
  assert.equal(room.smallBlindSeat, 1);
  assert.equal(room.actorId, '1');
});

test('multiway preflop follows big blind and postflop follows button', () => {
  const room = roomWith(4);
  room.startHand(now);
  assert.equal(room.actorId, '3');
  for (const id of ['3', '0', '1']) room.act(id, { type: 'call' }, now);
  assert.equal(room.actorId, '2');
  room.act('2', { type: 'check' }, now);
  assert.equal(room.phase, 'flop');
  assert.equal(room.actorId, '1');
  assert.equal(room.board.length, 3);
  assert.equal(room.players.every(player => player.bet === 0), true);
});

test('betting is authoritative; raises are raise-to totals and use full raise size', () => {
  const room = roomWith(4);
  room.startHand(now);
  const before = JSON.stringify(room.snapshot('3'));
  assert.throws(() => room.act('0', { type: 'call' }, now), /不是你的/);
  assert.throws(() => room.act('3', { type: 'check' }, now), /不能过牌/);
  assert.throws(() => room.act('3', { type: 'raise', amount: 15 }, now), /至少/);
  assert.equal(JSON.stringify(room.snapshot('3')), before);
  room.act('3', { type: 'raise', amount: 100 }, now);
  assert.equal(room.players[3].bet, 100);
  assert.equal(room.players[3].chips, 900);
  assert.equal(room.currentBet, 100);
  assert.equal(room.minRaise, 90);
  assert.equal(room.legalActions('0').minRaise, 190);
  assert.throws(() => room.act('0', { type: 'raise', amount: 189 }, now), /至少/);
  assert.throws(() => room.act('0', { type: 'raise', amount: 1001 }, now), /超过/);
  assert.throws(() => room.act('0', { type: 'raise', amount: NaN }, now), /金额无效/);
  assert.equal(conservedTotal(room), 4000);
});

test('short all-in does not reopen prior actions or permit a raising all-in', () => {
  const room = roomWith(4);
  room.players[1].chips = 150;
  room.startHand(now);
  room.act('3', { type: 'raise', amount: 100 }, now);
  room.act('0', { type: 'call' }, now);
  room.act('1', { type: 'allin' }, now);
  assert.equal(room.currentBet, 150);
  assert.equal(room.minRaise, 90);
  room.act('2', { type: 'call' }, now);
  const legal = room.legalActions('3');
  assert.equal(legal.toCall, 50);
  assert.equal(legal.canRaise, false);
  assert.equal(legal.canAllIn, false);
  assert.throws(() => room.act('3', { type: 'raise', amount: 240 }, now), /不能再次加注/);
  assert.throws(() => room.act('3', { type: 'allin' }, now), /尚未重新开放/);
  room.act('3', { type: 'call' }, now);
  assert.equal(room.legalActions('0').canRaise, false);
  room.act('0', { type: 'call' }, now);
  assert.equal(room.phase, 'flop');
  assert.equal(room.legalActions('2').canRaise, true);
});

test('cumulative short all-ins reopen after a full raise amount', () => {
  const room = roomWith(5);
  room.players[0].chips = 150;
  room.players[1].chips = 190;
  room.startHand(now);
  room.act('3', { type: 'raise', amount: 100 }, now);
  room.act('4', { type: 'call' }, now);
  room.act('0', { type: 'allin' }, now);
  room.act('1', { type: 'allin' }, now);
  room.act('2', { type: 'call' }, now);
  assert.equal(room.currentBet, 190);
  assert.equal(room.minRaise, 90);
  assert.equal(room.legalActions('3').canRaise, true);
  assert.equal(room.legalActions('3').minRaise, 280);
  room.act('3', { type: 'call' }, now);
  assert.equal(room.legalActions('4').canRaise, true);
});

test('a closed raise right still permits an all-in call below the current wager', () => {
  const room = roomWith(4);
  room.players[3].chips = 130;
  room.players[1].chips = 150;
  room.startHand(now);
  room.act('3', { type: 'raise', amount: 100 }, now);
  room.act('0', { type: 'call' }, now);
  room.act('1', { type: 'allin' }, now);
  room.act('2', { type: 'call' }, now);
  assert.equal(room.legalActions('3').canRaise, false);
  assert.equal(room.legalActions('3').canAllIn, true);
  room.act('3', { type: 'allin' }, now);
  assert.equal(room.players[3].bet, 130);
  assert.equal(room.players[3].chips, 0);
  assert.equal(room.currentBet, 150);
  assert.equal(room.actorId, '0');
});

test('a player who checked can complete a short opening all-in to a full bet', () => {
  const room = roomWith(3);
  room.players[2].chips = 15;
  room.startHand(now);
  room.act('0', { type: 'call' }, now);
  room.act('1', { type: 'call' }, now);
  room.act('2', { type: 'check' }, now);
  assert.equal(room.phase, 'flop');
  room.act('1', { type: 'check' }, now);
  room.act('2', { type: 'allin' }, now);
  assert.equal(room.currentBet, 5);
  assert.equal(room.legalActions('0').minRaise, 10);
  room.act('0', { type: 'call' }, now);
  assert.equal(room.legalActions('1').canRaise, true);
  room.act('1', { type: 'raise', amount: 10 }, now);
  assert.equal(room.minRaise, 10);
  assert.equal(room.legalActions('0').canRaise, true);
  assert.equal(room.legalActions('0').minRaise, 20);
});

test('side pots pay distinct eligible winners and refund unmatched excess', () => {
  const room = roomWith(3);
  [100, 200, 300].forEach((amount, index) => room.players[index].chips = amount);
  room.startHand(now);
  room.players[0].cards = cards('AS AH');
  room.players[1].cards = cards('KS KH');
  room.players[2].cards = cards('QS QH');
  putBoardInDeck(room, '2S 3D 7C 9H JD');
  room.act('0', { type: 'allin' }, now);
  room.act('1', { type: 'call' }, now);
  room.act('2', { type: 'allin' }, now);
  room.act('1', { type: 'allin' }, now);
  assert.equal(room.phase, 'showdown');
  assert.deepEqual(room.players.map(player => player.chips), [300, 200, 100]);
  assert.deepEqual(room.result.pots.map(pot => pot.amount), [300, 200]);
  assert.equal(room.result.pot, 500);
  assert.equal(totalChips(room), 600);
  assert.equal(room.result.winners.find(winner => winner.id === '0').handName, '一对');
});

test('folded money stays in pots; tied winners receive odd chip left of dealer', () => {
  const room = roomWith(3, { smallBlind: 1, bigBlind: 2 });
  room.startHand(now);
  room.players[0].cards = cards('2C 3C');
  room.players[1].cards = cards('4D 5D');
  room.players[2].cards = cards('6H 7H');
  putBoardInDeck(room, 'AS KS QS JS TS');
  room.act('0', { type: 'call' }, now);
  room.act('1', { type: 'fold' }, now);
  room.act('2', { type: 'check' }, now);
  while (room.phase !== 'showdown') room.act(room.actorId, { type: 'check' }, now);
  assert.equal(room.result.pot, 5);
  assert.equal(room.result.winners.find(winner => winner.id === '2').amount, 3);
  assert.equal(room.result.winners.find(winner => winner.id === '0').amount, 2);
  assert.deepEqual(room.players.map(player => player.chips), [1000, 999, 1001]);
  assert.equal(totalChips(room), 3000);
});

test('an uncontested raise returns uncalled chips and does not expose hole cards', () => {
  const room = roomWith(2);
  room.startHand(now);
  room.act('0', { type: 'raise', amount: 500 }, now);
  room.act('1', { type: 'fold' }, now);
  assert.equal(room.phase, 'showdown');
  assert.equal(room.result.pot, 20);
  assert.deepEqual(room.players.map(player => player.chips), [1010, 990]);
  assert.deepEqual(room.snapshot('1').players[0].cards, [{ hidden: true }, { hidden: true }]);
  assert.equal(room.result.showCards, false);
});

test('short big blind and ante-only all-in run out without artificial calls', () => {
  const room = roomWith(2, { smallBlind: 50, bigBlind: 100 });
  room.players[0].chips = 200;
  room.players[1].chips = 20;
  room.startHand(now);
  assert.equal(room.phase, 'showdown');
  assert.equal(room.result.pot, 40);
  assert.equal(room.players[0].totalBet, 20);
  assert.equal(totalChips(room), 220);
  assert.equal(room.actorId, null);
  const antes = roomWith(2, { ante: 10 });
  antes.players[0].chips = 10;
  antes.startHand(now);
  assert.equal(antes.phase, 'showdown');
  assert.equal(antes.result.pot, 20);
  assert.equal(totalChips(antes), 1010);
});

test('a sole actionable player must call an actual outstanding all-in', () => {
  const room = roomWith(2);
  room.players[0].chips = 7;
  room.startHand(now);
  assert.equal(room.actorId, '0');
  assert.equal(room.legalActions('0').toCall, 5);
  room.act('0', { type: 'allin' }, now);
  assert.equal(room.phase, 'showdown');
  assert.equal(room.result.pot, 14);
  assert.equal(totalChips(room), 1007);
});

test('privacy hides opponents until showdown and snapshots never share mutable objects', () => {
  const room = roomWith(3);
  room.startHand(now);
  const snapshot = room.snapshot('0');
  assert.equal(snapshot.players[0].cards.length, 2);
  assert.equal(snapshot.players[0].cards[0].rank.length, 1);
  assert.deepEqual(snapshot.players[1].cards, [{ hidden: true }, { hidden: true }]);
  assert.equal('deck' in snapshot, false);
  assert.equal('actedAtBet' in snapshot.players[0], false);
  snapshot.players[0].cards[0].rank = '2';
  snapshot.config.bigBlind = 999;
  assert.equal(room.config.bigBlind, 10);
  assert.notEqual(snapshot.players[0].cards, room.players[0].cards);
  room.act('0', { type: 'allin' }, now);
  room.act('1', { type: 'allin' }, now);
  room.act('2', { type: 'allin' }, now);
  const final = room.snapshot(null);
  assert.equal(final.players.every(player => player.cards.every(card => !card.hidden)), true);
  const dealt = [...room.players.flatMap(player => player.cards), ...room.board];
  assert.equal(new Set(dealt.map(card => `${card.rank}${card.suit}`)).size, dealt.length);
  final.result.winners[0].amount = -1;
  assert.notEqual(room.result.winners[0].amount, -1);
});

test('timeout automatically folds a required call, checks for free, and works when disconnected', () => {
  const room = roomWith(3, { turnSeconds: 1 });
  room.startHand(now);
  room.players[0].connected = false;
  assert.equal(room.tick(now + 999), false);
  assert.equal(room.tick(now + 1000), true);
  assert.equal(room.players[0].folded, true);
  assert.equal(room.players[0].lastAction, '超时弃牌');
  room.act('1', { type: 'call' }, now + 1000);
  assert.equal(room.actorId, '2');
  assert.equal(room.tick(now + 2000), true);
  assert.equal(room.phase, 'flop');
  assert.equal(room.players[2].folded, false);
  assert.equal(room.players[2].lastAction, '超时过牌');
});

test('new players sit out current hand; removing participants preserves contributions', () => {
  const room = roomWith(3);
  room.startHand(now);
  const extra = room.addPlayer('extra', '旁观玩家');
  assert.equal(extra.inHand, false);
  assert.equal(extra.cards.length, 0);
  assert.throws(() => room.removePlayer('0'), /结算后/);
  room.act('0', { type: 'fold' }, now);
  assert.throws(() => room.removePlayer('0'), /结算后/);
  room.removePlayer('extra');
  assert.equal(room.players.length, 3);
});

test('buy-ins enforce amounts and stack cap and are disallowed for active live players', () => {
  const room = roomWith(3, { minBuyIn: 500, maxBuyIn: 2000 });
  assert.throws(() => room.buyIn('0', 499), /买入金额/);
  assert.throws(() => room.buyIn('0', 1001), /不能超过/);
  room.buyIn('0', 500);
  assert.equal(room.players[0].chips, 1500);
  assert.equal(room.players[0].totalBuyIn, 1500);
  room.startHand(now);
  assert.throws(() => room.buyIn('0', 500), /正在参与/);
  room.act('0', { type: 'fold' }, now);
  room.buyIn('0', 500);
  assert.equal(room.players[0].chips, 2000);
});

test('settings only change between hands; disconnected players sit out next deal', () => {
  const room = roomWith(3);
  room.players[2].connected = false;
  room.startHand(now);
  assert.equal(room.players[2].inHand, false);
  assert.equal(room.smallBlindSeat, 0);
  assert.equal(room.bigBlindSeat, 1);
  assert.throws(() => room.updateConfig({ smallBlind: 1 }), /等待本手/);
  room.act('0', { type: 'fold' }, now);
  room.updateConfig({ smallBlind: 1, bigBlind: 2 });
  assert.equal(room.config.bigBlind, 2);
  assert.throws(() => room.updateConfig({ maxPlayers: 2 }), /少于已加入/);
  room.removePlayer('0');
  assert.equal(room.hostId, '1');
});

test('blind intervals take effect on the next hand and session end lets current hand finish', () => {
  const room = roomWith(2, { blindIntervalMinutes: 1, sessionMinutes: 2 });
  room.startHand(now);
  assert.equal(room.bigBlind, 10);
  room.tick(now + 60000);
  assert.equal(room.bigBlind, 10);
  assert.equal(room.phase, 'showdown');
  room.startHand(now + 60000);
  assert.equal(room.smallBlind, 10);
  assert.equal(room.bigBlind, 20);
  assert.equal(room.config.bigBlind, 10);
  room.act(room.actorId, { type: 'call' }, now + 120000);
  room.act(room.actorId, { type: 'check' }, now + 120000);
  assert.equal(room.phase, 'flop');
  while (room.phase !== 'showdown') room.act(room.actorId, { type: 'check' }, now + 120000);
  assert.throws(() => room.startHand(now + 120000), /时间已结束/);
});

test('100 varied legal hands preserve integer chips, eventually settle and never leak deck', () => {
  let state = 715;
  const random = max => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
  for (let iteration = 0; iteration < 100; iteration++) {
    const count = 2 + random(8);
    const room = roomWith(count, { maxPlayers: 9, ante: random(5), smallBlind: 3, bigBlind: 7 });
    for (const player of room.players) player.chips = 1 + random(1000);
    const total = totalChips(room);
    room.startHand(now);
    let actions = 0;
    while (room.phase !== 'showdown') {
      assert.equal(conservedTotal(room), total);
      assert.equal(room.players.every(player => Number.isSafeInteger(player.chips) && player.chips >= 0), true);
      const legal = room.legalActions(room.actorId);
      assert.equal(legal.canAct, true);
      const chance = random(10);
      let action;
      if (chance < 2) action = { type: 'fold' };
      else if (chance === 2 && legal.canAllIn) action = { type: 'allin' };
      else if (chance < 5 && legal.canRaise && legal.maxRaise >= legal.minRaise) {
        action = { type: 'raise', amount: legal.minRaise + random(legal.maxRaise - legal.minRaise + 1) };
      } else action = { type: legal.canCheck ? 'check' : 'call' };
      room.act(room.actorId, action, now);
      assert.ok(++actions < 1000);
    }
    assert.equal(totalChips(room), total);
    assert.equal(room.actorId, null);
    assert.equal(room.deadline, null);
    assert.equal('deck' in room.snapshot('0'), false);
  }
});
