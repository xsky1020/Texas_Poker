import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startServer } from '../server.js';

async function setup(t) {
  const service = await startServer({ port: 0, host: '127.0.0.1', tickMs: 20 });
  const sockets = new Set();
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${service.port}/ws`);
    sockets.add(ws);
    let sequence = 0;
    const pending = new Map();
    const waiters = new Set();
    const client = {
      ws, state: null, version: 0,
      request(type, payload = {}) {
        const requestId = String(++sequence);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error(`Request timed out: ${type}`));
          }, 3000);
          pending.set(requestId, { resolve, reject, timer });
          ws.send(JSON.stringify({ type, requestId, ...payload }));
        });
      },
      waitState(predicate = () => true, afterVersion = 0) {
        if (client.state && client.version > afterVersion && predicate(client.state)) {
          return Promise.resolve(client.state);
        }
        return new Promise((resolve, reject) => {
          const waiter = { predicate, afterVersion, resolve, timer: null };
          waiter.timer = setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error('Synchronized state timed out'));
          }, 3000);
          waiters.add(waiter);
        });
      },
      async disconnect() {
        const closed = once(ws, 'close');
        ws.close();
        await closed;
      },
    };
    ws.on('message', raw => {
      const packet = JSON.parse(raw.toString());
      if (packet.type === 'result') {
        const request = pending.get(packet.requestId);
        if (request) {
          clearTimeout(request.timer);
          pending.delete(packet.requestId);
          request.resolve(packet);
        }
      } else if (packet.type === 'state') {
        client.state = packet.state;
        client.version += 1;
        for (const waiter of waiters) {
          if (client.version > waiter.afterVersion && waiter.predicate(client.state)) {
            clearTimeout(waiter.timer);
            waiters.delete(waiter);
            waiter.resolve(client.state);
          }
        }
      }
    });
    ws.on('close', () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Connection closed'));
      }
      pending.clear();
    });
    await once(ws, 'open');
    return client;
  };
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await service.close();
  });
  return { service, connect, baseURL: `http://127.0.0.1:${service.port}` };
}

async function twoPlayers(context, config = {}) {
  const host = await context.connect();
  const guest = await context.connect();
  const identity = await host.request('create', {
    name: '房主', config: { autoDeal: false, turnSeconds: 120, ...config },
  });
  assert.equal(identity.ok, true, identity.error);
  const guestIdentity = await guest.request('join', { code: identity.code, name: '访客' });
  assert.equal(guestIdentity.ok, true, guestIdentity.error);
  await Promise.all([
    host.waitState(state => state.players.length === 2),
    guest.waitState(state => state.players.length === 2),
  ]);
  return { host, guest, identity, guestIdentity };
}

function publicState(state) {
  return {
    phase: state.phase, actorId: state.actorId, handNumber: state.handNumber,
    board: state.board, pot: state.pot, currentBet: state.currentBet,
    players: state.players.map(player => ({
      id: player.id, chips: player.chips, bet: player.bet,
      folded: player.folded, allIn: player.allIn,
    })),
  };
}

test('HTTP serves the game and advertises the actual port and current rooms', async t => {
  const context = await setup(t);
  const home = await fetch(context.baseURL);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(await home.text(), /<html/);
  assert.equal((await fetch(`${context.baseURL}/health`).then(response => response.json())).ok, true);
  const client = await context.connect();
  const result = await client.request('create', { name: '连通测试' });
  assert.equal(result.ok, true, result.error);
  const info = await fetch(`${context.baseURL}/api/info`).then(response => response.json());
  assert.equal(info.port, context.service.port);
  assert.ok(Array.isArray(info.addresses));
  assert.equal(info.rooms[0].code, result.code);
  assert.equal((await fetch(`${context.baseURL}/server.js`)).status, 404);
});

test('independent clients share host settings and enforce host-only controls', async t => {
  const context = await setup(t);
  const { host, guest } = await twoPlayers(context);
  for (const [type, payload] of [
    ['settings', { config: { smallBlind: 10, bigBlind: 20 } }],
    ['start', {}], ['addBot', {}],
  ]) {
    const result = await guest.request(type, payload);
    assert.equal(result.ok, false, `${type} must require the host`);
    assert.match(result.error, /房主/);
  }
  const config = {
    roomName: '自定义牌局', smallBlind: 25, bigBlind: 50, ante: 10,
    initialChips: 4000, minBuyIn: 1000, maxBuyIn: 30000, turnSeconds: 20,
    maxPlayers: 4, blindIntervalMinutes: 15, blindMultiplier: 3,
    sessionMinutes: 90, handDelaySeconds: 3, autoDeal: false,
  };
  const version = host.version;
  const guestVersion = guest.version;
  const result = await host.request('settings', { config });
  assert.equal(result.ok, true, result.error);
  const states = await Promise.all([
    host.waitState(state => state.config.bigBlind === 50, version),
    guest.waitState(state => state.config.bigBlind === 50, guestVersion),
  ]);
  for (const state of states) {
    for (const [key, value] of Object.entries(config)) assert.equal(state.config[key], value);
  }
});

test('a dealt hand sends only each viewer\'s own cards and rejects out-of-turn actions', async t => {
  const context = await setup(t);
  const { host, guest, identity, guestIdentity } = await twoPlayers(context);
  const start = await host.request('start');
  assert.equal(start.ok, true, start.error);
  await Promise.all([
    host.waitState(state => state.phase === 'preflop'),
    guest.waitState(state => state.phase === 'preflop'),
  ]);
  for (const [client, ownId] of [[host, identity.playerId], [guest, guestIdentity.playerId]]) {
    const own = client.state.players.find(player => player.id === ownId);
    const opponent = client.state.players.find(player => player.id !== ownId);
    assert.equal(own.cards.length, 2);
    assert.ok(own.cards.every(card => card && typeof card === 'object'));
    assert.deepEqual(opponent.cards, [{ hidden: true }, { hidden: true }]);
    assert.equal(Object.hasOwn(client.state, 'deck'), false);
  }
  assert.deepEqual(publicState(host.state), publicState(guest.state));
  const nonActor = host.state.actorId === identity.playerId ? guest : host;
  const before = publicState(host.state);
  const result = await nonActor.request('action', { action: { type: 'fold' } });
  assert.equal(result.ok, false);
  assert.deepEqual(publicState(host.state), before);
});

test('raising, calling, every board street and showdown synchronize with conserved chips', async t => {
  const context = await setup(t);
  const { host, guest, identity, guestIdentity } = await twoPlayers(context);
  assert.equal((await host.request('start')).ok, true);
  await Promise.all([
    host.waitState(state => state.phase === 'preflop'),
    guest.waitState(state => state.phase === 'preflop'),
  ]);
  const clientById = new Map([[identity.playerId, host], [guestIdentity.playerId, guest]]);
  const visited = new Set(['preflop']);
  let raised = false;
  for (let count = 0; count < 20 && host.state.phase !== 'showdown'; count += 1) {
    const state = host.state;
    const actor = clientById.get(state.actorId);
    assert.ok(actor, `Expected a human actor during ${state.phase}`);
    const player = state.players.find(player => player.id === state.actorId);
    const action = !raised
      ? { type: 'raise', amount: state.config.bigBlind * 3 }
      : { type: state.currentBet > player.bet ? 'call' : 'check' };
    raised = true;
    const versions = [host.version, guest.version];
    const result = await actor.request('action', { action });
    assert.equal(result.ok, true, result.error);
    await Promise.all([host.waitState(() => true, versions[0]), guest.waitState(() => true, versions[1])]);
    assert.deepEqual(publicState(host.state), publicState(guest.state));
    visited.add(host.state.phase);
  }
  assert.equal(host.state.phase, 'showdown');
  assert.deepEqual([...visited], ['preflop', 'flop', 'turn', 'river', 'showdown']);
  assert.equal(host.state.board.length, 5);
  assert.equal(host.state.players.reduce((total, player) => total + player.chips, 0), 20000);
  assert.ok(host.state.players.every(player => player.cards.every(Boolean)));
});

test('reconnect preserves identity, chips and private cards while forged credentials fail', async t => {
  const context = await setup(t);
  const { host, guest, identity, guestIdentity } = await twoPlayers(context);
  assert.equal((await host.request('start')).ok, true);
  await guest.waitState(state => state.phase === 'preflop');
  const original = structuredClone(guest.state.players.find(player => player.id === guestIdentity.playerId));
  const attacker = await context.connect();
  const forged = await attacker.request('resume', {
    code: identity.code, playerId: guestIdentity.playerId, token: '0'.repeat(48),
  });
  assert.equal(forged.ok, false);
  await guest.disconnect();
  const replacement = await context.connect();
  const result = await replacement.request('resume', {
    code: identity.code, playerId: guestIdentity.playerId, token: guestIdentity.token,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.playerId, guestIdentity.playerId);
  const state = await replacement.waitState();
  const restored = state.players.find(player => player.id === guestIdentity.playerId);
  assert.equal(state.players.length, 2);
  assert.equal(restored.chips, original.chips);
  assert.deepEqual(restored.cards, original.cards);
  assert.deepEqual(state.players.find(player => player.id === identity.playerId).cards, [{ hidden: true }, { hidden: true }]);
});

test('unknown rooms, invalid rules and full tables return usable failures', async t => {
  const context = await setup(t);
  const newcomer = await context.connect();
  assert.equal((await newcomer.request('join', { code: 'missing', name: '访客' })).ok, false);
  const invalid = await newcomer.request('create', { name: '错误设置', config: { smallBlind: 100, bigBlind: 50 } });
  assert.equal(invalid.ok, false);
  const { identity } = await twoPlayers(context, { maxPlayers: 2 });
  const full = await newcomer.request('join', { code: identity.code, name: '第三人' });
  assert.equal(full.ok, false);
  assert.ok(full.error);
});

test('leaving transfers host controls and invalidates the departed player\'s reconnect token', async t => {
  const context = await setup(t);
  const { host, guest, identity, guestIdentity } = await twoPlayers(context);
  const result = await host.request('leave');
  assert.equal(result.ok, true, result.error);
  await guest.waitState(state => state.players.length === 1 && state.hostId === guestIdentity.playerId);
  assert.equal((await guest.request('settings', { config: { smallBlind: 10, bigBlind: 20 } })).ok, true);
  const formerHost = await context.connect();
  assert.equal((await formerHost.request('resume', {
    code: identity.code, playerId: identity.playerId, token: identity.token,
  })).ok, false);
});

test('host migration skips an earlier-seated bot and retains usable human controls', async t => {
  const context = await setup(t);
  const host = await context.connect();
  const identity = await host.request('create', { name: '原房主', config: { autoDeal: false } });
  assert.equal(identity.ok, true, identity.error);
  assert.equal((await host.request('addBot')).ok, true);
  const guest = await context.connect();
  const guestIdentity = await guest.request('join', { code: identity.code, name: '新房主' });
  assert.equal(guestIdentity.ok, true, guestIdentity.error);
  await guest.waitState(state => state.players.length === 3);
  const bot = guest.state.players.find(player => player.bot);
  const human = guest.state.players.find(player => player.id === guestIdentity.playerId);
  assert.ok(bot.seat < human.seat);
  assert.equal((await host.request('leave')).ok, true);
  await guest.waitState(state => state.players.length === 2);
  assert.equal(guest.state.hostId, guestIdentity.playerId);
  assert.notEqual(guest.state.hostId, bot.id);
  const start = await guest.request('start');
  assert.equal(start.ok, true, start.error);
  await guest.waitState(state => state.phase === 'preflop' && state.handNumber === 1);
});

test('two rooms stay isolated and leaving an active hand lets survivors finish and deal again', async t => {
  const context = await setup(t);
  const first = await twoPlayers(context);
  const second = await twoPlayers(context);
  const third = await context.connect();
  const thirdIdentity = await third.request('join', { code: first.identity.code, name: '第三位' });
  assert.equal(thirdIdentity.ok, true, thirdIdentity.error);
  // Let the initial session-expiry state broadcast settle before measuring isolation.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await second.host.request('ping')).ok, true);
  const otherVersion = second.host.version;
  const otherState = structuredClone(second.host.state);
  assert.equal((await first.host.request('start')).ok, true);
  await first.guest.waitState(state => state.phase === 'preflop');
  // A request's room/player fields cannot override the server's socket identity.
  const spoof = await second.host.request('action', {
    code: first.identity.code, playerId: first.identity.playerId, action: { type: 'fold' },
  });
  assert.equal(spoof.ok, false);
  assert.equal((await second.host.request('ping')).ok, true);
  assert.equal(second.host.version, otherVersion);
  assert.deepEqual(second.host.state, otherState);
  assert.equal(second.guest.state.phase, 'lobby');
  assert.equal((await first.host.request('leave')).ok, true);
  await first.guest.waitState(state => state.hostId === first.guestIdentity.playerId);
  const actorClients = new Map([[first.guestIdentity.playerId, first.guest], [thirdIdentity.playerId, third]]);
  for (let count = 0; count < 20 && first.guest.state.phase !== 'showdown'; count += 1) {
    const state = first.guest.state;
    const version = first.guest.version;
    if (state.actorId === first.identity.playerId) {
      context.service.rooms.get(first.identity.code).room.deadline = Date.now() - 1;
    } else {
      const actor = actorClients.get(state.actorId);
      assert.ok(actor);
      const player = state.players.find(player => player.id === state.actorId);
      const result = await actor.request('action', {
        action: { type: state.currentBet > player.bet ? 'call' : 'check' },
      });
      assert.equal(result.ok, true, result.error);
    }
    await first.guest.waitState(() => true, version);
  }
  assert.equal(first.guest.state.phase, 'showdown');
  await first.guest.waitState(state => state.players.length === 2);
  assert.equal(first.guest.state.players.some(player => player.id === first.identity.playerId), false);
  assert.equal(first.guest.state.hostId, first.guestIdentity.playerId);
  const next = await first.guest.request('start');
  assert.equal(next.ok, true, next.error);
  await first.guest.waitState(state => state.handNumber === 2 && state.phase === 'preflop');
  assert.equal((await second.host.request('ping')).ok, true);
  assert.equal(second.host.version, otherVersion);
});

test('the live server tick expires an action and auto-deals after the configured hand interval', async t => {
  const context = await setup(t);
  const { host, guest, identity } = await twoPlayers(context, { autoDeal: true, handDelaySeconds: 5 });
  assert.equal((await host.request('start')).ok, true);
  await host.waitState(state => state.phase === 'preflop');
  const timedOutId = host.state.actorId;
  const entry = context.service.rooms.get(identity.code);
  // Set only the clock boundary; the running server interval must perform the action.
  entry.room.deadline = Date.now() - 1;
  await Promise.all([
    host.waitState(state => state.phase === 'showdown'),
    guest.waitState(state => state.phase === 'showdown'),
  ]);
  assert.equal(host.state.players.find(player => player.id === timedOutId).folded, true);
  assert.match(host.state.players.find(player => player.id === timedOutId).lastAction, /超时弃牌/);
  assert.deepEqual(publicState(host.state), publicState(guest.state));
  assert.equal(host.state.players.reduce((total, player) => total + player.chips, 0), 20000);
  assert.equal(host.state.handNumber, 1);
  entry.showdownAt = Date.now() - entry.room.config.handDelaySeconds * 1000 - 1;
  await Promise.all([
    host.waitState(state => state.handNumber === 2 && state.phase === 'preflop'),
    guest.waitState(state => state.handNumber === 2 && state.phase === 'preflop'),
  ]);
  assert.deepEqual(publicState(host.state), publicState(guest.state));
});

test('buy-ins synchronize and obey amount, stack cap and active-player restrictions', async t => {
  const context = await setup(t);
  const { host, guest, identity } = await twoPlayers(context);
  assert.equal((await host.request('buyIn', { amount: 100 })).ok, false);
  const bought = await host.request('buyIn', { amount: 2000 });
  assert.equal(bought.ok, true, bought.error);
  await Promise.all([
    host.waitState(state => state.players.find(player => player.id === identity.playerId).chips === 12000),
    guest.waitState(state => state.players.find(player => player.id === identity.playerId).chips === 12000),
  ]);
  assert.equal(host.state.players.find(player => player.id === identity.playerId).totalBuyIn, 12000);
  assert.equal((await host.request('buyIn', { amount: 10000 })).ok, false);
  assert.equal((await host.request('start')).ok, true);
  await host.waitState(state => state.phase === 'preflop');
  assert.equal((await guest.request('buyIn', { amount: 2000 })).ok, false);
});
