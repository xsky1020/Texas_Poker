import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { PokerRoom, validateConfig } from './poker-engine.js';

const root = dirname(fileURLToPath(import.meta.url));
const activePhases = new Set(['preflop', 'flop', 'turn', 'river']);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/game.js', ['game.js', 'text/javascript; charset=utf-8']],
]);

export function lanAddresses(port) {
  const addresses = [];
  const interfaces = Object.entries(networkInterfaces()).sort(([a], [b]) => {
    const virtual = name => /virtual|vmware|vethernet|wsl|docker|tailscale|zerotier|radmin|vpn|loopback/i.test(name) ? 1 : 0;
    return virtual(a) - virtual(b);
  });
  for (const [, entries] of interfaces) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) {
        addresses.push(`http://${entry.address}:${port}`);
      }
    }
  }
  return [...new Set(addresses)];
}

export async function startServer({ port = Number(process.env.PORT || 3000), host = '0.0.0.0', tickMs = 200 } = {}) {
  const rooms = new Map();
  const clients = new Set();
  let boundPort = port;
  const json = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: '仅支持 GET 请求' });
      if (pathname === '/api/info') {
        return json(response, 200, {
          port: boundPort, addresses: lanAddresses(boundPort),
          rooms: [...rooms.values()].map(({ room }) => ({
            code: room.code, name: room.config.roomName, players: room.players.filter(p => !p.bot).length,
            maxPlayers: room.config.maxPlayers, phase: room.phase,
          })),
        });
      }
      if (pathname === '/health') return json(response, 200, { ok: true, rooms: rooms.size });
      if (pathname === '/favicon.ico') { response.writeHead(204); return response.end(); }
      const asset = assets.get(pathname);
      if (!asset) return json(response, 404, { error: '页面不存在' });
      const content = await readFile(join(root, asset[0]));
      response.writeHead(200, {
        'Content-Type': asset[1], 'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'",
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      json(response, 500, { error: '读取页面失败' });
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  server.on('upgrade', (request, socket, head) => {
    let valid = request.url === '/ws';
    if (request.headers.origin) {
      try { valid &&= new URL(request.headers.origin).host === request.headers.host; }
      catch { valid = false; }
    }
    if (!valid) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  const send = (ws, value) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  const broadcast = entry => {
    for (const ws of clients) {
      if (ws.context?.code === entry.room.code) send(ws, { type: 'state', state: entry.room.snapshot(ws.context.playerId) });
    }
  };
  const newCode = () => {
    let code;
    do { code = String(randomInt(100000, 1000000)); } while (rooms.has(code));
    return code;
  };
  const nameOf = value => {
    if (typeof value !== 'string') throw new Error('请输入昵称');
    const name = value.trim().replace(/[\u0000-\u001f\u007f]/g, '');
    if (!name || name.length > 18) throw new Error('昵称需要 1–18 个字符');
    return name;
  };
  const auth = ws => {
    const entry = rooms.get(ws.context?.code);
    if (!entry || !entry.room.players.some(p => p.id === ws.context.playerId && !p.bot)) throw new Error('请先加入房间');
    return entry;
  };
  const requireHost = (entry, ws) => {
    if (entry.room.hostId !== ws.context.playerId) throw new Error('只有房主可以进行此操作');
  };
  const chooseHost = room => {
    const current = room.players.find(p => p.id === room.hostId);
    if (current?.connected && !current.bot && !current.removeAfterHand) return;
    const next = room.players.find(p => !p.bot && p.connected && !p.removeAfterHand);
    if (next) room.hostId = next.id;
  };
  const detach = (ws, explicit = false) => {
    if (!ws.context) return;
    const { code, playerId } = ws.context;
    ws.context = null;
    const entry = rooms.get(code);
    if (!entry) return;
    // A superseded socket must not disconnect its newly resumed replacement.
    if ([...clients].some(c => c !== ws && c.context?.code === code && c.context.playerId === playerId)) return;
    const player = entry.room.players.find(p => p.id === playerId);
    if (!player) return;
    player.connected = false;
    if (explicit) {
      entry.tokens.delete(playerId);
      if (!activePhases.has(entry.room.phase)) entry.room.removePlayer(playerId);
      else {
        player.removeAfterHand = true;
        if (entry.room.actorId === playerId) entry.room.act(playerId, { type: 'fold' });
      }
    }
    chooseHost(entry.room);
    entry.touchedAt = Date.now();
    broadcast(entry);
  };
  const bind = (ws, entry, playerId) => {
    const existing = [...clients].find(c => c !== ws && c.context?.code === entry.room.code && c.context.playerId === playerId);
    if (existing) { existing.context = null; existing.close(4001, '已在另一个页面重新连接'); }
    ws.context = { code: entry.room.code, playerId };
    entry.room.players.find(p => p.id === playerId).connected = true;
    entry.touchedAt = Date.now();
    chooseHost(entry.room);
  };
  wss.on('connection', ws => {
    clients.add(ws);
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.rate = { start: Date.now(), count: 0 };
    ws.on('message', raw => {
      let message;
      try {
        const now = Date.now();
        if (now - ws.rate.start > 10000) ws.rate = { start: now, count: 0 };
        if (++ws.rate.count > 60) throw new Error('操作太快，请稍后再试');
        message = JSON.parse(raw.toString());
        if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw new Error('无效请求');
        let entry;
        let result = {};
        if (message.type === 'create') {
          if (ws.context) throw new Error('请先离开当前房间');
          if (rooms.size >= 100) throw new Error('房间数量已达上限');
          const config = validateConfig(message.config || {});
          const room = new PokerRoom(newCode(), config);
          const playerId = randomBytes(12).toString('hex');
          const token = randomBytes(24).toString('hex');
          room.addPlayer(playerId, nameOf(message.name));
          room.hostId = playerId;
          entry = { room, tokens: new Map([[playerId, token]]), touchedAt: now, botTurn: null, showdownAt: null };
          rooms.set(room.code, entry);
          bind(ws, entry, playerId);
          result = { code: room.code, playerId, token };
        } else if (message.type === 'join') {
          if (ws.context) throw new Error('请先离开当前房间');
          entry = rooms.get(String(message.code || '').trim());
          if (!entry) throw new Error('房间不存在，请检查房间码');
          const playerId = randomBytes(12).toString('hex');
          const token = randomBytes(24).toString('hex');
          entry.room.addPlayer(playerId, nameOf(message.name));
          entry.tokens.set(playerId, token);
          bind(ws, entry, playerId);
          result = { code: entry.room.code, playerId, token };
        } else if (message.type === 'resume') {
          if (ws.context) throw new Error('当前连接已经加入房间');
          entry = rooms.get(String(message.code || ''));
          const expected = entry?.tokens.get(message.playerId);
          const received = typeof message.token === 'string' ? message.token : '';
          if (!expected || !/^[a-f0-9]{48}$/.test(received) || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
            throw new Error('房间已关闭或重连凭证失效，请重新加入');
          }
          bind(ws, entry, message.playerId);
          result = { code: entry.room.code, playerId: message.playerId, token: expected };
        } else if (message.type === 'ping') {
          result = { now };
        } else {
          entry = auth(ws);
          switch (message.type) {
            case 'action': entry.room.act(ws.context.playerId, message.action || {}, now); break;
            case 'start': requireHost(entry, ws); entry.room.startHand(now); break;
            case 'settings': requireHost(entry, ws); entry.room.updateConfig(message.config || {}); break;
            case 'addBot': {
              requireHost(entry, ws);
              if (activePhases.has(entry.room.phase)) throw new Error('请在本手结束后添加练习对手');
              const botNames = ['青竹', '小满', '山岚', '晚风', '星河', '松子', '听雨', '白露'];
              const usedNames = new Set(entry.room.players.map(p => p.name));
              const name = botNames.find(n => !usedNames.has(n)) || `练习对手 ${entry.room.players.length}`;
              entry.room.addPlayer(`bot-${randomBytes(8).toString('hex')}`, name, { bot: true });
              break;
            }
            case 'removeBot': {
              requireHost(entry, ws);
              if (!entry.room.players.some(p => p.id === message.playerId && p.bot)) throw new Error('只能移除练习对手');
              if (activePhases.has(entry.room.phase)) throw new Error('请在本手结束后移除练习对手');
              entry.room.removePlayer(message.playerId);
              break;
            }
            case 'buyIn': entry.room.buyIn(ws.context.playerId, message.amount); break;
            case 'leave': detach(ws, true); break;
            default: throw new Error('未知操作');
          }
          entry.touchedAt = now;
        }
        send(ws, { type: 'result', requestId: message.requestId, ok: true, ...result });
        if (entry) broadcast(entry);
      } catch (error) {
        send(ws, { type: 'result', requestId: message?.requestId, ok: false, error: error.message || '操作失败' });
      }
    });
    ws.on('close', () => { detach(ws); clients.delete(ws); });
    ws.on('error', () => {});
  });

  const botAction = (room, actor) => {
    const legal = room.legalActions(actor.id);
    const strength = actor.cards?.length === 2 ? Math.max(...actor.cards.map(c => c.value)) : 10;
    const roll = Math.random();
    if (legal.canRaise && strength >= 11 && roll < 0.16) {
      const target = Math.min(legal.maxRaise, Math.max(legal.minRaise, room.currentBet + room.config.bigBlind * 2));
      return { type: 'raise', amount: target };
    }
    if (legal.canCheck) return { type: 'check' };
    if (legal.toCall > actor.chips * 0.5 && strength < 11 && roll < 0.5) return { type: 'fold' };
    return { type: 'call' };
  };
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [code, entry] of rooms) {
      const { room } = entry;
      try {
        let changed = false;
        const before = JSON.stringify([room.phase, room.actorId, room.handNumber, room.deadline]);
        const actor = room.players.find(p => p.id === room.actorId);
        if (actor && activePhases.has(room.phase)) {
          if (!actor.connected && !actor.bot && room.deadline > now + 1500) room.deadline = now + 1500;
          if (actor.bot) {
            const key = `${room.handNumber}:${room.phase}:${actor.id}:${room.currentBet}:${actor.bet}`;
            if (entry.botTurn?.key !== key) entry.botTurn = { key, at: now + 850 };
            if (now >= entry.botTurn.at) {
              room.act(actor.id, botAction(room, actor), now);
              entry.botTurn = null;
              changed = true;
            }
          } else entry.botTurn = null;
        }
        room.tick(now);
        changed ||= before !== JSON.stringify([room.phase, room.actorId, room.handNumber, room.deadline]);
        if (!activePhases.has(room.phase)) {
          for (const player of [...room.players]) {
            if (player.removeAfterHand) { room.removePlayer(player.id); changed = true; }
          }
        }
        if (room.phase === 'showdown') {
          entry.showdownAt ??= now;
          if (room.config.autoDeal && now - entry.showdownAt >= room.config.handDelaySeconds * 1000 && room.players.some(p => !p.bot && p.connected)) {
            const eligible = room.players.filter(p => p.chips > 0 && p.connected);
            if (eligible.length >= 2 && (!room.config.sessionMinutes || now < room.startedAt + room.config.sessionMinutes * 60000)) {
              room.startHand(now); changed = true;
            }
          }
        } else entry.showdownAt = null;
        chooseHost(room);
        const sessionExpired = room.sessionExpired;
        if (entry.sessionExpired !== sessionExpired) { entry.sessionExpired = sessionExpired; changed = true; }
        if (changed) broadcast(entry);
        if (!room.players.some(p => !p.bot && p.connected) && now - entry.touchedAt > 2 * 3600000) rooms.delete(code);
      } catch (error) {
        // Preserve the running service, but make unexpected failures diagnosable.
        console.error(`房间 ${code}: ${error.message}`);
      }
    }
  }, tickMs);
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 20000);
  try {
    await new Promise((success, fail) => { server.once('error', fail); server.listen(port, host, success); });
  } catch (error) {
    clearInterval(timer); clearInterval(heartbeat); wss.close();
    throw error;
  }
  boundPort = server.address().port;
  return {
    server, wss, rooms, port: boundPort,
    async close() {
      clearInterval(timer); clearInterval(heartbeat);
      for (const ws of clients) ws.terminate();
      await Promise.all([
        new Promise(done => wss.close(done)),
        new Promise(done => server.close(done)),
      ]);
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().then(service => {
    console.log('\n  RIVER · 河畔牌局\n');
    console.log(`  本机打开：http://localhost:${service.port}`);
    for (const url of lanAddresses(service.port)) console.log(`  局域网加入：${url}`);
    console.log('\n  同一 Wi-Fi / 局域网的朋友打开上面的地址，再输入房间码。');
    console.log('  按 Ctrl+C 关闭服务。\n');
    if (process.env.RIVER_OPEN_BROWSER === '1') {
      const url = `http://localhost:${service.port}`;
      const command = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', url]] :
        process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      const opener = spawn(command[0], command[1], { windowsHide: true, stdio: 'ignore' });
      opener.on('error', () => console.log(`  请在浏览器打开：${url}`));
    }
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close().then(() => process.exit(0)));
  }).catch(error => {
    console.error(error.code === 'EADDRINUSE' ? '端口已占用。请关闭原服务，或使用 $env:PORT=3001; npm start。' : error.message);
    process.exitCode = 1;
  });
}
