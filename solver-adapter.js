import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, basename, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const source = 'TexasSolver CLI';
const repository = 'https://github.com/bupticybee/TexasSolver';

function installation() {
  try {
    let manifest = {};
    try { manifest = JSON.parse(readFileSync(join(root, '.solver', 'engine.json'), 'utf8')); } catch {}
    const executable = process.env.TEXAS_SOLVER_PATH || manifest.executable;
    if (typeof executable !== 'string' || !isAbsolute(executable) || !statSync(executable).isFile()) return null;
    if (!/^(console_solver|TexasSolverConsole)(\.exe)?$/i.test(basename(executable))) return null;
    if (process.platform === 'win32' && !executable.toLowerCase().endsWith('.exe')) return null;
    const resources = join(dirname(executable), 'resources');
    if (!statSync(join(resources, 'compairer', 'card5_dic_sorted.txt')).isFile()) return null;
    return { executable, resources, version: process.env.TEXAS_SOLVER_PATH ? 'external' : manifest.version || 'external' };
  } catch { return null; }
}

export function solverStatus() {
  const engine = installation();
  return {
    available: Boolean(engine), engine: 'TexasSolver', source, repository,
    version: engine?.version || null, installing: existsSync(join(root, '.solver', 'installing')),
    reason: engine ? null : '未安装外部 TexasSolver CLI，请运行 npm run solver:setup。',
    supportedStreets: ['turn', 'river'], license: 'AGPL-3.0',
  };
}

const ranks = 'AKQJT98765432';
const fullRange = [...ranks].flatMap((rank, index) => [rank + rank,
  ...[...ranks.slice(index + 1)].flatMap(second => [rank + second + 's', rank + second + 'o'])]).join(',');
const cardCode = card => {
  if (!card || !ranks.includes(card.rank) || card.rank.length !== 1 || !['S', 'H', 'D', 'C'].includes(card.suit)) return null;
  return card.rank + card.suit.toLowerCase();
};
const failure = (reason, extra = {}) => ({
  available: solverStatus().available, supported: false, source,
  reason, strategy: [], recommendation: null, assumptions: [], ...extra,
});

/** Build only from hero's public-view snapshot. Opponent cards are never accessed. */
export function buildSolverInput(snapshot, options = {}) {
  if (!snapshot || !['turn', 'river'].includes(snapshot.phase)) throw new Error('仅支持转牌与河牌求解；翻牌前和翻牌仍使用练习建议。');
  const players = snapshot.players;
  if (!Array.isArray(players) || players.length !== 2 || players.filter(player => !player.bot).length !== 1 ||
      players.some(player => !player.inHand || player.folded || player.allIn)) {
    throw new Error('仅支持一名真人对一名机器人、双方仍在本手且未全下的 heads-up 个人练习。');
  }
  const hero = players.find(player => !player.bot);
  const opponent = players.find(player => player.bot);
  if (snapshot.actorId !== hero.id || !snapshot.legalActions?.canAct) throw new Error('请在轮到你行动时求解。');
  const board = snapshot.board?.map(cardCode);
  const holes = hero.cards?.map(cardCode);
  if (!board || board.length !== (snapshot.phase === 'turn' ? 4 : 5) || board.some(card => !card) ||
      !holes || holes.length !== 2 || holes.some(card => !card) || new Set([...board, ...holes]).size !== board.length + 2) {
    throw new Error('公共牌或自己的底牌无效。');
  }
  if (![hero.chips, opponent.chips, hero.bet, opponent.bet, snapshot.pot].every(Number.isSafeInteger) ||
      hero.chips <= 0 || opponent.chips <= 0 || hero.bet < 0 || opponent.bet < 0) throw new Error('筹码状态无效。');
  if (hero.bet !== 0 || snapshot.currentBet !== Math.max(hero.bet, opponent.bet)) {
    throw new Error('暂不支持本轮已投入筹码后再面对加注的节点；当前版本支持未下注或面对首次下注。');
  }
  const streetPot = snapshot.pot - hero.bet - opponent.bet;
  const effectiveStack = Math.min(hero.chips + hero.bet, opponent.chips + opponent.bet);
  if (streetPot < 2 || streetPot > 1000000 || effectiveStack > 1000000 || opponent.bet >= effectiveStack) {
    throw new Error('此底池、有效筹码或下注超过当前求解范围。');
  }
  const dealer = players.find(player => player.seat === snapshot.dealerSeat);
  if (!dealer) throw new Error('缺少庄家位置信息。');
  const heroPosition = dealer.id === hero.id ? 'ip' : 'oop';
  const facingBet = opponent.bet;
  const path = [];
  if (heroPosition === 'ip') path.push(facingBet ? { kind: 'BET', amount: facingBet } : { kind: 'CHECK' });
  else if (facingBet) path.push({ kind: 'CHECK' }, { kind: 'BET', amount: facingBet });
  const rangeOop = validateRange(options.rangeOop || fullRange);
  const rangeIp = validateRange(options.rangeIp || fullRange);
  const maxIterations = boundedInteger(options.maxIterations ?? 100, 1, 1000, '迭代次数');
  const accuracy = options.accuracy ?? 1;
  if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > 10) throw new Error('求解精度无效。');
  const minimumBet = snapshot.bigBlind || (facingBet ? 1 : snapshot.legalActions.minRaise);
  const sizes = [...new Set([50, 100, ...(facingBet ? [100 * facingBet / streetPot] : [])])]
    .filter(percent => Math.round(streetPot * percent / 100) >= minimumBet).join(',');
  const commands = [
    `set_pot ${streetPot}`, `set_effective_stack ${effectiveStack}`, `set_board ${board.join(',')}`,
    `set_range_oop ${rangeOop}`, `set_range_ip ${rangeIp}`,
  ];
  for (const street of snapshot.phase === 'turn' ? ['turn', 'river'] : ['river']) {
    for (const position of ['oop', 'ip']) commands.push(
      `set_bet_sizes ${position},${street},bet,${sizes}`,
      `set_bet_sizes ${position},${street},donk,${sizes}`,
      `set_bet_sizes ${position},${street},raise,100`,
      `set_bet_sizes ${position},${street},allin`,
    );
  }
  commands.push('set_allin_threshold 1', 'build_tree', 'set_thread_num 2', `set_accuracy ${accuracy}`,
    `set_max_iteration ${maxIterations}`, 'set_print_interval 10', 'set_use_isomorphism 0', 'start_solve',
    'set_dump_rounds 3', 'dump_result result.json');
  return {
    text: commands.join('\n') + '\n', path, holes, heroPosition,
    streetPot, effectiveStack, maxIterations, accuracy,
    assumptions: [
      options.rangeOop || options.rangeIp ? '使用显式给定的研究范围；未根据之前动作推断或收窄范围。'
        : '双方使用全部 169 类起手牌的均匀范围，已由公共牌阻断；未根据之前动作推断或收窄范围。',
      '求解仅使用公共牌与自己的底牌，未读取机器人的真实底牌。',
      `从本轮开始重建底池 ${streetPot}、有效筹码 ${effectiveStack}；当前节点沿已发生的过牌/首次下注定位。`,
      '离散下注树包含达到最小下注要求的半池、满池、当前首次下注、满池加注及全下；未覆盖所有可选下注金额。',
      `最多 ${maxIterations} 次 DCFR 迭代，目标 exploitability 为底池 ${accuracy}%；结果是给定范围与下注树下的近似策略。`,
    ],
  };
}

function boundedInteger(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}无效。`);
  return value;
}
function validateRange(range) {
  if (typeof range !== 'string' || range.length > 3000 || !range.split(',').every(item => /^(?:[AKQJT98765432]{2}[so]?)(?::(?:0(?:\.\d+)?|1(?:\.0+)?))?$/.test(item))) {
    throw new Error('求解范围格式无效。');
  }
  return range;
}

function findChild(node, step) {
  const keys = Object.keys(node.childrens || {});
  const key = keys.find(action => {
    if (step.kind === 'CHECK') return action === 'CHECK';
    return /^BET\s/.test(action) && Math.abs(Number(action.split(/\s+/)[1]) - step.amount) < 0.01;
  });
  if (!key) throw new Error('求解树未包含当前已发生的动作。');
  return node.childrens[key];
}

export function parseSolverResult(output, input, snapshot) {
  let node = output;
  for (const step of input.path) node = findChild(node, step);
  if (node.player !== (input.heroPosition === 'oop' ? 1 : 0)) throw new Error('求解输出位置与当前行动玩家不符。');
  const comboMap = node.strategy?.strategy || node.strategy;
  const frequencies = comboMap?.[input.holes.join('')] || comboMap?.[[...input.holes].reverse().join('')];
  if (!Array.isArray(node.actions) || !Array.isArray(frequencies) || frequencies.length !== node.actions.length) {
    throw new Error('求解输出缺少自己底牌对应的策略。');
  }
  const hero = snapshot.players.find(player => !player.bot);
  const legal = snapshot.legalActions;
  const strategy = node.actions.map((action, index) => {
    const frequency = frequencies[index];
    if (!Number.isFinite(frequency) || frequency < 0 || frequency > 1.0001) throw new Error('求解输出频率无效。');
    if (action === 'CHECK' && legal.canCheck) return { type: 'check', frequency };
    if (action === 'CALL' && !legal.canCheck) return { type: 'call', frequency };
    if (action === 'FOLD') return { type: 'fold', frequency };
    if (/^(BET|RAISE)\s/.test(action)) {
      const amount = Math.round(Number(action.split(/\s+/)[1]));
      if (!Number.isSafeInteger(amount) || amount <= snapshot.currentBet) throw new Error('求解下注金额无效。');
      if (amount === hero.chips + hero.bet && legal.canAllIn) return { type: 'allin', amount, frequency };
      if (legal.canRaise && amount >= legal.minRaise && amount <= legal.maxRaise) return { type: 'raise', amount, frequency };
    }
    if (frequency < 0.000001) return null;
    throw new Error('求解树包含当前牌桌不合法的正频率动作，暂不提供策略。');
  }).filter(Boolean);
  const total = strategy.reduce((sum, action) => sum + action.frequency, 0);
  if (total < 0.99 || total > 1.01) throw new Error('求解输出频率之和无效。');
  strategy.forEach(action => { action.frequency /= total; });
  return { strategy, recommendation: [...strategy].sort((a, b) => b.frequency - a.frequency)[0] };
}

function execute(engine, work, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(engine.executable, ['-i', join(work, 'input.txt'), '-r', engine.resources], {
      cwd: work, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const append = data => { if (output.length < 262144) output += data.toString().slice(0, 262144 - output.length); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.once('error', () => { clearTimeout(timer); reject(new Error('外部求解器启动失败，请检查本机安装。')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('求解超时，已停止外部进程；请使用更小的范围或河牌局面。'));
      else if (code !== 0) reject(new Error('外部求解器未正常完成，本次没有真实策略结果。'));
      else resolve(output);
    });
  });
}

let solving = false;
export async function solveDecision(snapshot, options = {}) {
  let input;
  try { input = buildSolverInput(snapshot, options); } catch (error) { return failure(error.message); }
  const engine = installation();
  if (!engine) return failure(solverStatus().reason);
  if (solving) return failure('求解器正在处理另一局面，请稍后重试。');
  let work;
  solving = true;
  const started = Date.now();
  try {
    const timeoutMs = boundedInteger(options.timeoutMs ?? 45000, 1, 60000, '超时时间');
    const jobs = join(root, '.solver', 'jobs');
    await mkdir(jobs, { recursive: true });
    work = await mkdtemp(join(jobs, 'solve-'));
    await writeFile(join(work, 'input.txt'), input.text, 'utf8');
    const log = await execute(engine, work, timeoutMs);
    const resultPath = join(work, 'result.json');
    const outputBytes = (await stat(resultPath)).size;
    if (outputBytes > 20 * 1024 * 1024) throw new Error('求解输出过大，本次不读取。');
    const parsed = parseSolverResult(JSON.parse(await readFile(resultPath, 'utf8')), input, snapshot);
    const accuracies = [...log.matchAll(/Total exploitability\s+([\d.eE+-]+)\s+(?:precent|percent)/g)];
    const exploitabilityPercent = accuracies.length ? Number(accuracies.at(-1)[1]) : null;
    return {
      available: true, supported: true, source, engine: 'TexasSolver', version: engine.version,
      ...parsed, assumptions: input.assumptions, elapsedMs: Date.now() - started,
      exploitabilityPercent, converged: exploitabilityPercent !== null && exploitabilityPercent <= input.accuracy,
      maxIterations: input.maxIterations, approximate: true, outputBytes,
    };
  } catch (error) {
    const reason = error.code || error instanceof SyntaxError
      ? '外部求解器没有生成有效策略文件。' : error.message;
    return failure(reason, { assumptions: input.assumptions, elapsedMs: Date.now() - started });
  } finally {
    if (work) {
      const jobsRoot = resolve(root, '.solver', 'jobs');
      const target = resolve(work);
      // Verify the final absolute deletion target stays below the intended jobs directory.
      if (target !== jobsRoot && target.startsWith(jobsRoot + sep)) {
        await rm(target, { recursive: true, force: true }).catch(() => {});
      }
    }
    solving = false;
  }
}
