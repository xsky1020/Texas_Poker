import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PokerRoom } from '../poker-engine.js';
import { chooseBotAction } from '../poker-ai.js';

test('range-based AI completes heads-up and six-player hands with legal actions and conserved chips', () => {
  const active = new Set(['preflop', 'flop', 'turn', 'river']);
  const styles = ['balanced', 'tight', 'aggressive'];
  for (const count of [2, 6]) {
    for (let hand = 0; hand < 10; hand++) {
      const room = new PokerRoom('TRAIN', { smallBlind: 10, bigBlind: 20, initialChips: 1000,
        minBuyIn: 1, maxBuyIn: 10000, maxPlayers: count, turnSeconds: 120 });
      for (let i = 0; i < count; i++) room.addPlayer(`p${i}`, `AI ${i}`, { bot: true });
      room.startHand();
      let actions = 0;
      while (active.has(room.phase)) {
        assert.ok(room.actorId, 'Active hand must have an actor');
        const snapshot = room.snapshot(room.actorId);
        assert.ok(snapshot.players.filter(p => p.id !== room.actorId).every(p => p.cards.every(c => c.hidden)));
        const action = chooseBotAction(snapshot, { heroId: room.actorId, iterations: 120,
          style: styles[actions % 3], seed: `${count}:${hand}:${actions}` });
        assert.doesNotThrow(() => room.act(room.actorId, action), JSON.stringify(action));
        const conserved = room.phase === 'showdown'
          ? room.players.reduce((sum, p) => sum + p.chips, 0)
          : room.players.reduce((sum, p) => sum + p.chips + p.totalBet, 0);
        assert.equal(conserved, count * 1000);
        assert.ok(++actions < 500, 'AI hand must finish');
      }
      assert.equal(room.phase, 'showdown');
    }
  }
});
