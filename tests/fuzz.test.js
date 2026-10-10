import test from 'node:test';
import assert from 'node:assert/strict';
import { PokerRoom } from '../poker-engine.js';

test('240 mixed-stack hands preserve every chip across raises, folds and all-in side pots', () => {
  let seed = 20261010;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let scenario = 0; scenario < 240; scenario++) {
    const count = 2 + Math.floor(random() * 8);
    const room = new PokerRoom(String(scenario), {
      maxPlayers: 9, smallBlind: 10, bigBlind: 20, ante: scenario % 7,
      initialChips: 1000, minBuyIn: 1, maxBuyIn: 20000,
    });
    for (let i = 0; i < count; i++) {
      const player = room.addPlayer(`p${i}`, `玩家${i}`);
      player.chips = 1 + Math.floor(random() * 1600);
    }
    const bank = room.players.reduce((sum, player) => sum + player.chips, 0);
    room.startHand(1000);
    let actions = 0;
    while (room.phase !== 'showdown') {
      const actor = room.players.find(player => player.id === room.actorId);
      assert.ok(actor, `scenario ${scenario}: actor exists`);
      const legal = room.legalActions(actor.id);
      assert.ok(legal.canAct);
      const choice = random();
      let action;
      if (choice < 0.14) action = { type: 'fold' };
      else if (choice < 0.35 && legal.canAllIn) action = { type: 'allin' };
      else if (choice < 0.55 && legal.canRaise) {
        const amount = legal.maxRaise < legal.minRaise ? legal.maxRaise :
          legal.minRaise + Math.floor(random() * (legal.maxRaise - legal.minRaise + 1));
        action = { type: 'raise', amount };
      } else action = { type: legal.canCheck ? 'check' : 'call' };
      room.act(actor.id, action, 1000 + ++actions * 10);
      assert.ok(actions < 500, `scenario ${scenario}: hand terminates`);
      for (const player of room.players) {
        assert.ok(Number.isSafeInteger(player.chips) && player.chips >= 0);
        assert.ok(Number.isSafeInteger(player.totalBet) && player.totalBet >= 0);
      }
      const chips = room.players.reduce((sum, player) => sum + player.chips, 0);
      assert.equal(chips + (room.phase === 'showdown' ? 0 : room.pot), bank, `scenario ${scenario}: chip conservation`);
    }
    assert.equal(room.players.reduce((sum, player) => sum + player.chips, 0), bank);
    const dealt = [...room.board, ...room.players.flatMap(player => player.cards)].map(card => `${card.rank}${card.suit}`);
    assert.equal(new Set(dealt).size, dealt.length, 'no duplicate cards are dealt');
  }
});
