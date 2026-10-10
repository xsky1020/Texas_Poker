import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { PokerRoom, validateConfig } from './poker-engine.js';
import { analyzeDecision, chooseBotAction, gradeDecision } from './poker-ai.js';
import { solverStatus, solveDecision } from './solver-adapter.js';

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

export async function startServer({ port = Number(process.env.PORT || 3000), host = '0.0.0.0', tickMs = 200, solveProvider = solveDecision } = {}) {
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
          rooms: [...rooms.values()].filter(entry => !entry.practice).map(({ room }) => ({
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
  const decisionKey = (room, playerId) => JSON.stringify([room.handNumber, room.phase, room.actorId, playerId,
    room.currentBet, room.board, room.players.map(p => [p.id, p.chips, p.bet, p.totalBet, p.folded, p.allIn])]);
  const practiceClock = entry => {
    if (!entry.practice) return;
    const actor = entry.room.players.find(p => p.id === entry.room.actorId);
    const solvingThisTurn = actor && entry.solvePending && entry.solveClock?.key === decisionKey(entry.room, actor.id);
    if (entry.practice.paused || solvingThisTurn || (entry.practice.untimed && actor && !actor.bot)) entry.room.deadline = null;
  };
  const publicSnapshot = (entry, playerId) => {
    practiceClock(entry);
    const state = entry.room.snapshot(playerId);
    if (entry.practice) {
      state.practice = { ...entry.practice, solving: Boolean(entry.solvePending &&
        entry.solveClock?.key === decisionKey(entry.room, playerId)), solver: solverStatus() };
      state.training = structuredClone(entry.training);
    }
    return state;
  };
  const completePracticeHand = entry => {
    if (entry.practice && entry.room.phase === 'showdown' && entry.completedHand !== entry.room.handNumber) {
      entry.completedHand = entry.room.handNumber;
      entry.training.hands++;
    }
  };
  const coachFor = (entry, playerId) => {
    if (!entry.practice) throw new Error('教学提示仅用于个人练习');
    if (!entry.room.legalActions(playerId).canAct) throw new Error('轮到你行动时才能分析当前决策');
    const key = decisionKey(entry.room, playerId);
    if (entry.coachCache?.key === key) return entry.coachCache.analysis;
    const analysis = analyzeDecision(entry.room.snapshot(playerId), { heroId: playerId, iterations: 1000, seed: key, style: entry.practice.style });
    entry.coachCache = { key, analysis };
    return analysis;
  };
  const refillPracticeBots = entry => {
    if (!entry.practice || activePhases.has(entry.room.phase)) return;
    for (const player of entry.room.players) if (player.bot && player.chips === 0) {
      entry.room.buyIn(player.id, entry.room.config.initialChips);
    }
  };
  const solverFeedback = (solver, action, legal) => {
    const equivalent = item => {
      const type = action.type === 'call' && legal.canCheck ? 'check' : action.type;
      if (type === 'allin' && item.type === 'raise') return Math.abs(item.amount - legal.maxRaise) <= 1;
      if (type === 'raise' && action.amount === legal.maxRaise && legal.canAllIn && item.type === 'allin') return true;
      if (item.type !== type) return false;
      return type !== 'raise' || Math.abs(item.amount - action.amount) <= Math.max(1, item.amount * 0.05);
    };
    const frequency = solver.strategy.filter(equivalent).reduce((sum, item) => sum + item.frequency, 0);
    return { grade: frequency >= 0.02 ? 'good' : 'discuss',
      label: frequency >= 0.02 ? '符合 Solver 参考' : '这个选择值得复盘',
      message: frequency >= 0.02
        ? `这个选择属于当前范围与下注树下的混合策略，参考频率约 ${Math.round(frequency * 100)}%。`
        : '这个选择未包含在本次求解的主要策略中；范围与下注尺寸受到模型限制，不能据此计算你的实际 EV 损失。',
      score: frequency >= 0.02 ? 1 : null };
  };
  const broadcast = entry => {
    completePracticeHand(entry);
    for (const ws of clients) {
      if (ws.context?.code === entry.room.code) send(ws, { type: 'state', state: publicSnapshot(entry, ws.context.playerId) });
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
    ws.on('message', async raw => {
      let message;
      try {
        const now = Date.now();
        if (now - ws.rate.start > 10000) ws.rate = { start: now, count: 0 };
        if (++ws.rate.count > 60) throw new Error('操作太快，请稍后再试');
        message = JSON.parse(raw.toString());
        if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw new Error('无效请求');
        let entry;
        let result = {};
        if (message.type === 'create' || message.type === 'practice') {
          if (ws.context) throw new Error('请先离开当前房间');
          if (rooms.size >= 100) throw new Error('房间数量已达上限');
          const practice = message.type === 'practice';
          const opponents = Number(message.opponents ?? 1);
          const style = message.style || 'balanced';
          if (practice && (!Number.isInteger(opponents) || opponents < 1 || opponents > 5)) throw new Error('练习对手数量需为 1–5');
          if (practice && !['balanced', 'tight', 'aggressive'].includes(style)) throw new Error('请选择有效的对手风格');
          const config = validateConfig(practice ? {
            smallBlind: 10, bigBlind: 20, initialChips: 2000, minBuyIn: 400, maxBuyIn: 20000,
            turnSeconds: 300, autoDeal: false, ...(message.config || {}),
            roomName: '个人练习桌', maxPlayers: opponents + 1,
          } : message.config || {});
          const room = new PokerRoom(newCode(), config);
          const playerId = randomBytes(12).toString('hex');
          const token = randomBytes(24).toString('hex');
          room.addPlayer(playerId, nameOf(message.name));
          room.hostId = playerId;
          entry = { room, tokens: new Map([[playerId, token]]), touchedAt: now, botTurn: null, showdownAt: null };
          if (practice) {
            entry.practice = { enabled: true, style, paused: false, untimed: message.untimed !== false,
              coachMode: message.coachMode === 'manual' ? 'manual' : 'auto' };
            entry.training = { hands: 0, decisions: 0, goodDecisions: 0, history: [], lastFeedback: null };
            const names = ['青竹', '晚风', '山岚', '小满', '星河'];
            for (let i = 0; i < opponents; i++) room.addPlayer(`bot-${randomBytes(8).toString('hex')}`, names[i], { bot: true });
            room.startHand(now);
            practiceClock(entry);
          }
          rooms.set(room.code, entry);
          bind(ws, entry, playerId);
          result = { code: room.code, playerId, token };
        } else if (message.type === 'join') {
          if (ws.context) throw new Error('请先离开当前房间');
          entry = rooms.get(String(message.code || '').trim());
          if (!entry) throw new Error('房间不存在，请检查房间码');
          if (entry.practice) throw new Error('这是个人练习桌，请创建自己的练习');
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
            case 'action': {
              if (entry.practice?.paused) throw new Error('请先继续练习');
              const analysis = entry.practice ? coachFor(entry, ws.context.playerId) : null;
              const solver = entry.solverCache?.key === decisionKey(entry.room, ws.context.playerId) ? entry.solverCache.result : null;
              const legal = entry.room.legalActions(ws.context.playerId);
              const handNumber = entry.room.handNumber, phase = entry.room.phase;
              entry.room.act(ws.context.playerId, message.action || {}, now);
              if (analysis) {
                const feedback = { ...(solver ? solverFeedback(solver, message.action, legal) : gradeDecision(analysis, message.action)), handNumber, phase,
                  action: structuredClone(message.action), recommendation: solver?.recommendation || analysis.recommendation,
                  reasons: solver ? solver.assumptions : analysis.reasons,
                  source: solver?.source || analysis.source, at: now };
                entry.training.decisions++;
                if (feedback.grade === 'good' || feedback.grade === 'correct') entry.training.goodDecisions++;
                entry.training.lastFeedback = feedback;
                entry.training.history.unshift(feedback);
                entry.training.history = entry.training.history.slice(0, 50);
              }
              break;
            }
            case 'start': {
              requireHost(entry, ws);
              if (entry.practice?.paused) throw new Error('请先继续练习');
              refillPracticeBots(entry);
              entry.room.startHand(now);
              break;
            }
            case 'pause': {
              requireHost(entry, ws);
              if (!entry.practice) throw new Error('暂停仅用于个人练习');
              if (typeof message.paused !== 'boolean') throw new Error('暂停状态无效');
              const wasPaused = entry.practice.paused;
              if (message.paused && !entry.practice.paused) entry.pausedClock = {
                actorId: entry.room.actorId,
                remainingMs: entry.room.deadline === null ? entry.solveClock?.remainingMs ?? entry.room.config.turnSeconds * 1000
                  : Math.max(0, entry.room.deadline - now),
              };
              entry.practice.paused = message.paused;
              entry.botTurn = null;
              if (!message.paused && wasPaused && entry.room.actorId) entry.room.deadline = now +
                (entry.pausedClock?.actorId === entry.room.actorId ? entry.pausedClock.remainingMs : entry.room.config.turnSeconds * 1000);
              practiceClock(entry);
              break;
            }
            case 'coach': result = { analysis: coachFor(entry, ws.context.playerId), solver: solverStatus() }; break;
            case 'solve': {
              const analysis = coachFor(entry, ws.context.playerId);
              if (entry.solvePending) throw new Error('当前桌正在求解，请等待结果');
              const key = decisionKey(entry.room, ws.context.playerId);
              const originalContext = ws.context;
              entry.solveClock = { key, actorId: entry.room.actorId,
                remainingMs: entry.room.deadline === null ? entry.pausedClock?.remainingMs ?? entry.room.config.turnSeconds * 1000
                  : Math.max(0, entry.room.deadline - now) };
              entry.solvePending = true;
              practiceClock(entry);
              broadcast(entry);
              try {
                const solver = await solveProvider(entry.room.snapshot(ws.context.playerId), { timeoutMs: 60000 });
                if (ws.context !== originalContext || key !== decisionKey(entry.room, originalContext.playerId)) {
                  throw new Error('局面已变化，请在下次行动时重新求解');
                }
                if (solver.supported && solver.strategy?.length) entry.solverCache = { key, result: solver };
                result = { analysis, solver };
              } finally {
                entry.solvePending = false;
                if (key === decisionKey(entry.room, originalContext.playerId) && !entry.practice.untimed && !entry.practice.paused) {
                  entry.room.deadline = Date.now() + entry.solveClock.remainingMs;
                }
                entry.solveClock = null;
                practiceClock(entry);
                broadcast(entry);
              }
              break;
            }
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

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [code, entry] of rooms) {
      const { room } = entry;
      try {
        if (!room.players.some(p => !p.bot && p.connected) && now - entry.touchedAt > 2 * 3600000) {
          rooms.delete(code);
          continue;
        }
        if (entry.practice?.paused) continue;
        let changed = false;
        const before = JSON.stringify([room.phase, room.actorId, room.handNumber, room.deadline]);
        const actor = room.players.find(p => p.id === room.actorId);
        if (actor && activePhases.has(room.phase)) {
          if (!actor.connected && !actor.bot && room.deadline > now + 1500) room.deadline = now + 1500;
          if (actor.bot) {
            const key = `${room.handNumber}:${room.phase}:${actor.id}:${room.currentBet}:${actor.bet}`;
            if (entry.botTurn?.key !== key) entry.botTurn = { key, at: now + 850 };
            if (now >= entry.botTurn.at) {
              const action = chooseBotAction(room.snapshot(actor.id), { heroId: actor.id, style: entry.practice?.style || 'balanced', iterations: 400 });
              room.act(actor.id, action, now);
              entry.botTurn = null;
              changed = true;
            }
          } else entry.botTurn = null;
        }
        practiceClock(entry);
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
            completePracticeHand(entry);
            refillPracticeBots(entry);
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
