import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startServer } from '../server.js';

async function setup(t, options = {}) {
  const service = await startServer({ port: 0, host: '127.0.0.1', tickMs: 20, ...options });
  const sockets = [];
  t.after(() => service.close());
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${service.port}/ws`);
    sockets.push(ws);
    const pending = new Map();
    let sequence = 0;
    const client = { state: null, version: 0 };
    ws.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type === 'state') { client.state = message.state; client.version++; }
      if (message.type === 'result') pending.get(message.requestId)?.(message);
    });
    await once(ws, 'open');
    client.request = (type, payload = {}) => new Promise((resolve, reject) => {
      const requestId = String(++sequence);
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timeout: ${type}`)); }, 10000);
      pending.set(requestId, message => { clearTimeout(timer); pending.delete(requestId); resolve(message); });
      ws.send(JSON.stringify({ type, requestId, ...payload }));
    });
    client.waitState = async predicate => {
      for (let i = 0; i < 150; i++) {
        if (client.state && predicate(client.state)) return client.state;
        await new Promise(done => setTimeout(done, 20));
      }
      throw new Error('Practice state did not synchronize');
    };
    return client;
  };
  return { service, connect };
}

test('solo practice is private, starts with real bots and preserves private cards', async t => {
  const { service, connect } = await setup(t);
  const hero = await connect(), visitor = await connect();
  const identity = await hero.request('practice', { name: '学员', opponents: 1, style: 'tight' });
  assert.equal(identity.ok, true, identity.error);
  const state = await hero.waitState(s => s.phase === 'preflop');
  assert.equal(state.practice.style, 'tight');
  assert.equal(state.deadline, null);
  assert.equal(state.actorId, identity.playerId);
  assert.equal(state.players.filter(p => !p.bot).length, 1);
  assert.equal(state.players.filter(p => p.bot).length, 1);
  assert.equal(state.players.reduce((sum, p) => sum + p.chips + p.totalBet, 0), 4000);
  assert.ok(state.players.find(p => p.bot).cards.every(c => c.hidden));
  const info = await fetch(`http://127.0.0.1:${service.port}/api/info`).then(r => r.json());
  assert.equal(info.rooms.length, 0);
  const join = await visitor.request('join', { code: identity.code, name: '旁观者' });
  assert.equal(join.ok, false);
  assert.match(join.error, /个人练习/);
});

test('coaching is stable per decision and an actual action records learning feedback', async t => {
  const { connect } = await setup(t), hero = await connect();
  await hero.request('practice', { name: '学员', opponents: 1 });
  await hero.waitState(s => s.legalActions.canAct);
  const first = await hero.request('coach'), again = await hero.request('coach');
  assert.equal(first.ok, true, first.error);
  assert.ok(first.analysis.equity >= 0 && first.analysis.equity <= 1);
  assert.ok(first.analysis.potOdds >= 0 && first.analysis.potOdds <= 1);
  assert.deepEqual(first.analysis, again.analysis);
  assert.ok(first.analysis.reasons.length > 0);
  const action = await hero.request('action', { action: first.analysis.recommendation });
  assert.equal(action.ok, true, action.error);
  const state = await hero.waitState(s => s.training.decisions === 1);
  assert.equal(state.training.history.length, 1);
  assert.equal(state.training.lastFeedback.action.type, first.analysis.recommendation.type);
  assert.ok(state.training.lastFeedback.label);
});

test('practice pauses both actors and actions, and resumes unlimited human thinking time', async t => {
  const { connect } = await setup(t), hero = await connect();
  await hero.request('practice', { name: '学员', opponents: 1 });
  await hero.waitState(s => s.legalActions.canAct);
  assert.equal((await hero.request('pause', { paused: true })).ok, true);
  await hero.waitState(s => s.practice.paused);
  const failed = await hero.request('action', { action: { type: 'call' } });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /继续练习/);
  assert.equal((await hero.request('pause', { paused: false })).ok, true);
  const state = await hero.waitState(s => !s.practice.paused);
  assert.equal(state.deadline, null);
  assert.equal((await hero.request('action', { action: { type: 'call' } })).ok, true);
});

test('human multiplayer rooms cannot request coaching, solvers or pause', async t => {
  const { connect } = await setup(t), human = await connect();
  await human.request('create', { name: '朋友' });
  for (const type of ['coach', 'solve', 'pause']) {
    const result = await human.request(type, { paused: true });
    assert.equal(result.ok, false);
    assert.match(result.error, /个人练习/);
  }
});

test('practice validates opponent count and style before creating a room', async t => {
  const { service, connect } = await setup(t), hero = await connect();
  assert.equal((await hero.request('practice', { name: '学员', opponents: 6 })).ok, false);
  assert.equal((await hero.request('practice', { name: '学员', opponents: 1, style: 'unknown' })).ok, false);
  assert.equal(service.rooms.size, 0);
  assert.equal((await hero.request('practice', { name: '学员', opponents: 5, style: 'aggressive' })).ok, true);
  assert.equal((await hero.waitState(s => s.players.length === 6)).practice.style, 'aggressive');
});

test('completed practice hands count once and busted bots are refilled before next hand', async t => {
  const { service, connect } = await setup(t), hero = await connect();
  const identity = await hero.request('practice', { name: '学员', opponents: 1 });
  await hero.waitState(s => s.legalActions.canAct);
  assert.equal((await hero.request('action', { action: { type: 'fold' } })).ok, true);
  await hero.waitState(s => s.phase === 'showdown' && s.training.hands === 1);
  const entry = service.rooms.get(identity.code), bot = entry.room.players.find(p => p.bot);
  bot.chips = 0;
  assert.equal((await hero.request('start')).ok, true);
  const state = await hero.waitState(s => s.handNumber === 2);
  assert.equal(state.training.hands, 1);
  assert.ok(bot.chips + bot.totalBet >= entry.room.config.initialChips);
});

test('timed practice freezes the clock while solving and preserves remaining time through pause', async t => {
  const { service, connect } = await setup(t, { solveProvider: async () => {
    await new Promise(done => setTimeout(done, 200));
    return { supported: false, strategy: [], reason: 'Test solver response' };
  } });
  const hero = await connect();
  const identity = await hero.request('practice', { name: '计时学员', opponents: 1, untimed: false, config: { turnSeconds: 1 } });
  await hero.waitState(s => s.legalActions.canAct);
  const entry = service.rooms.get(identity.code);
  entry.room.deadline = Date.now() + 100;
  const pending = hero.request('solve');
  const frozen = await hero.waitState(s => s.practice.solving);
  assert.equal(frozen.deadline, null, 'Frozen clock is immediately synchronized to the player');
  await new Promise(done => setTimeout(done, 140));
  assert.equal(entry.room.phase, 'preflop');
  assert.equal(entry.room.actorId, identity.playerId);
  assert.equal(entry.room.deadline, null);
  assert.equal((await hero.request('pause', { paused: true })).ok, true);
  assert.equal((await pending).ok, true);
  await hero.waitState(s => s.practice.paused && !s.practice.solving);
  assert.equal(entry.practice.paused, true);
  assert.equal(entry.room.deadline, null);
  assert.equal((await hero.request('pause', { paused: false })).ok, true);
  assert.ok(entry.room.deadline - Date.now() <= 100, 'Resume keeps the remaining thinking time');
  await hero.waitState(s => s.phase === 'showdown');
});

test('solver all-in strategy also credits an equivalent raise to the entire stack', async t => {
  const { connect } = await setup(t, { solveProvider: async () => ({
    available: true, supported: true, source: 'Test solver', assumptions: [],
    strategy: [{ type: 'allin', frequency: 1 }], recommendation: { type: 'allin' },
  }) });
  const hero = await connect();
  await hero.request('practice', { name: '学员', opponents: 1 });
  const state = await hero.waitState(s => s.legalActions.canAct);
  assert.equal((await hero.request('solve')).ok, true);
  assert.equal((await hero.request('action', { action: { type: 'raise', amount: state.legalActions.maxRaise } })).ok, true);
  const feedback = await hero.waitState(s => s.training.decisions === 1);
  assert.equal(feedback.training.goodDecisions, 1);
  assert.equal(feedback.training.lastFeedback.source, 'Test solver');
  assert.equal(feedback.training.lastFeedback.grade, 'good');
});

test('solver results are discarded after the player moves to a different decision', async t => {
  const { connect } = await setup(t, { solveProvider: async () => {
    await new Promise(done => setTimeout(done, 100));
    return { supported: true, source: 'Old solver', strategy: [{ type: 'check', frequency: 1 }], assumptions: [] };
  } });
  const hero = await connect();
  await hero.request('practice', { name: '学员', opponents: 1 });
  await hero.waitState(s => s.legalActions.canAct);
  const pending = hero.request('solve');
  await new Promise(done => setTimeout(done, 20));
  assert.equal((await hero.request('action', { action: { type: 'fold' } })).ok, true);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /局面已变化/);
  const state = await hero.waitState(s => s.training.decisions === 1);
  assert.notEqual(state.training.lastFeedback.source, 'Old solver');
});
