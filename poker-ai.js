import phe from 'phe';

// phe is the MIT-licensed table evaluator by Thorsten Lorenz. Our range model,
// Monte Carlo sampler and teaching policy are original, deliberately heuristic.
export const AI_SOURCE = '范围蒙特卡洛估算 · phe';
export const AI_LINKS = Object.freeze([
  { title: 'phe · 快速 5–7 张牌评估', url: 'https://github.com/thlorenz/phe', license: 'MIT' },
  { title: 'phe MIT 许可证', url: 'https://github.com/thlorenz/phe/blob/master/LICENSE', license: 'MIT' },
]);
const RANKS = '23456789TJQKA';
const SUITS = 'SHDC';
const HAND_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];
const STYLES = {
  balanced: { open: 0, margin: 0.045, bluff: 0.08, size: 0.62 },
  tight: { open: 0.055, margin: 0.075, bluff: 0.02, size: 0.55 },
  aggressive: { open: -0.04, margin: 0.025, bluff: 0.16, size: 0.75 },
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = value => Number(value.toFixed(4));
const percent = value => `${Math.round(value * 100)}%`;

function randomSource(seed) {
  let state = 2166136261;
  for (const char of String(seed ?? `${Date.now()}:${Math.random()}`)) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function cardCode(card) {
  if (!card || card.hidden) throw new Error('分析需要你自己的可见底牌');
  const rank = RANKS.indexOf(card.rank);
  const suit = SUITS.indexOf(card.suit);
  if (rank < 0 || suit < 0) throw new Error('牌面格式无效');
  return rank * 4 + suit;
}
const rankOf = code => Math.floor(code / 4) + 2;
const suitOf = code => code % 4;

function startingStrength(a, b) {
  const hi = Math.max(rankOf(a), rankOf(b));
  const lo = Math.min(rankOf(a), rankOf(b));
  if (hi === lo) return clamp(0.48 + hi * 0.032, 0, 1);
  const gap = hi - lo;
  return clamp((hi - 2) * 0.033 + (lo - 2) * 0.022 +
    (hi >= 10 && lo >= 10 ? 0.09 : 0) + (hi === 14 ? 0.045 : 0) +
    (suitOf(a) === suitOf(b) ? 0.06 : 0) +
    (gap === 1 ? 0.035 : gap === 2 ? 0.015 : gap >= 5 ? -0.08 : 0), 0.01, 1);
}

function holeLabel(hole) {
  const sorted = [...hole].sort((a, b) => rankOf(b) - rankOf(a));
  const names = sorted.map(code => RANKS[rankOf(code) - 2]);
  return `${names.join('')}${names[0] === names[1] ? ' · 口袋对子' : suitOf(sorted[0]) === suitOf(sorted[1]) ? 's · 同花' : 'o · 非同花'}`;
}

function positionOf(snapshot, hero) {
  const seats = snapshot.players.filter(player => player.inHand).map(player => player.seat).sort((a, b) => a - b);
  if (seats.length === 2) return hero.seat === snapshot.dealerSeat
    ? { label: '按钮 / 小盲（单挑）', late: true, early: false, threshold: 0.37 }
    : { label: '大盲（单挑）', late: false, early: false, threshold: 0.4 };
  if (hero.seat === snapshot.dealerSeat) return { label: '按钮位 BTN', late: true, early: false, threshold: 0.4 };
  if (hero.seat === snapshot.smallBlindSeat) return { label: '小盲位 SB', late: false, early: false, threshold: 0.46 };
  if (hero.seat === snapshot.bigBlindSeat) return { label: '大盲位 BB', late: false, early: false, threshold: 0.44 };
  const clockwise = [...seats.filter(seat => seat > snapshot.bigBlindSeat), ...seats.filter(seat => seat <= snapshot.bigBlindSeat)];
  const nonBlinds = clockwise.filter(seat => seat !== snapshot.smallBlindSeat && seat !== snapshot.bigBlindSeat);
  const index = nonBlinds.indexOf(hero.seat);
  if (index === nonBlinds.length - 2 && nonBlinds.length >= 2) return { label: '关煞位 CO', late: true, early: false, threshold: 0.46 };
  if (index === 0 && seats.length >= 5) return { label: '前位 UTG', late: false, early: true, threshold: 0.6 };
  return { label: '中间位置 MP', late: false, early: seats.length >= 7 && index < 2, threshold: 0.53 };
}

function drawsFor(hole, board) {
  if (board.length < 3 || board.length === 5) return [];
  const all = [...hole, ...board];
  const labels = [];
  for (let suit = 0; suit < 4; suit++) {
    if (all.filter(code => suitOf(code) === suit).length === 4 && hole.some(code => suitOf(code) === suit)) {
      labels.push(hole.some(code => suitOf(code) === suit && rankOf(code) === 14) ? '坚果同花听牌' : '同花听牌');
    }
  }
  const values = new Set(all.map(rankOf));
  if (values.has(14)) values.add(1);
  const missing = new Set();
  let madeStraight = false;
  for (let bottom = 1; bottom <= 10; bottom++) {
    const window = Array.from({ length: 5 }, (_, index) => bottom + index);
    const have = window.filter(value => values.has(value));
    if (have.length === 5) madeStraight = true;
    if (have.length === 4 && hole.some(code => window.includes(rankOf(code)) || (rankOf(code) === 14 && bottom === 1))) {
      const rank = window.find(value => !values.has(value));
      missing.add(rank === 1 ? 14 : rank);
    }
  }
  if (!madeStraight && missing.size) labels.push(missing.size >= 2 ? '两端顺子听牌' : '卡顺听牌');
  return labels;
}

function comboPool(hole, board) {
  const blocked = new Set([...hole, ...board]);
  if (blocked.size !== hole.length + board.length) throw new Error('可见牌不能重复');
  const available = Array.from({ length: 52 }, (_, index) => index).filter(code => !blocked.has(code));
  const combos = [];
  for (let i = 0; i < available.length; i++) {
    for (let j = i + 1; j < available.length; j++) {
      const a = available[i];
      const b = available[j];
      const category = board.length >= 3 ? 8 - phe.handRank(phe.evaluateCardCodes([a, b, ...board])) : -1;
      combos.push({ a, b, strength: startingStrength(a, b), category,
        draw: board.length === 3 || board.length === 4 ? drawsFor([a, b], board).length > 0 : false });
    }
  }
  return { available, combos };
}

function rangeFor(snapshot, opponent, combos, rangeModel) {
  const blind = snapshot.bigBlind || snapshot.config?.bigBlind || 1;
  const action = opponent.lastAction || '';
  const aggressive = /加注|下注|全下/.test(action);
  const calling = /跟注/.test(action);
  const position = positionOf(snapshot, opponent);
  let threshold = position.threshold;
  if (aggressive) threshold += snapshot.phase === 'preflop' && snapshot.currentBet >= blind * 6 ? 0.13 : 0.05;
  if (calling) threshold += snapshot.currentBet >= blind * 4 ? 0.07 : -0.08;
  const informed = aggressive || calling || (snapshot.phase !== 'preflop' && opponent.totalBet > blind * 1.5);
  let total = 0;
  const cumulative = [];
  const weights = [];
  for (const combo of combos) {
    let weight = 1;
    if (rangeModel !== 'uniform' && informed) {
      // A soft range keeps every physical combo possible and makes the assumed
      // range uncertainty explicit. Public actions update a prior, never cards.
      weight = 0.1 + 2.8 / (1 + Math.exp(-(combo.strength - threshold) * 15));
      if (snapshot.phase !== 'preflop') {
        const made = combo.category >= 3 ? 3 : combo.category === 2 ? 2 : combo.category === 1 ? 1.25 : 0.55;
        weight *= aggressive ? made * (combo.draw ? 1.8 : 1) : (combo.draw ? 1.4 : 0.7 + made * 0.3);
      }
    }
    total += weight;
    cumulative.push(total);
    weights.push(weight);
  }
  return { cumulative, weights, total, label: rangeModel === 'uniform' ? '所有合法组合等权' :
    aggressive ? '公开下注偏向强牌，也保留听牌和诈唬' : calling ? '公开跟注收窄起手牌范围' : informed ? '按继续入池估计宽范围' : '尚未行动，采用宽范围' };
}

function sampleCombo(pool, range, used, random) {
  for (let attempt = 0; attempt < 64; attempt++) {
    const target = random() * range.total;
    let low = 0;
    let high = range.cumulative.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (range.cumulative[middle] > target) high = middle; else low = middle + 1;
    }
    const combo = pool.combos[low];
    if (!used[combo.a] && !used[combo.b]) return combo;
  }
  // Weighted reservoir is an exact conditional fallback when card collisions
  // make rejection unusually expensive, rather than silently sampling uniformly.
  let chosen;
  let total = 0;
  pool.combos.forEach((combo, index) => {
    if (used[combo.a] || used[combo.b]) return;
    total += range.weights[index];
    if (random() * total < range.weights[index]) chosen = combo;
  });
  if (!chosen) throw new Error('可用扑克牌不足');
  return chosen;
}

function monteCarlo(snapshot, hole, board, opponents, iterations, random, rangeModel) {
  if (!opponents.length) return { equity: 1, winRate: 1, tieRate: 0, sampleCount: 0, standardError: 0, ranges: [] };
  const pool = comboPool(hole, board);
  const ranges = opponents.map(opponent => rangeFor(snapshot, opponent, pool.combos, rangeModel));
  let shares = 0;
  let squares = 0;
  let wins = 0;
  let ties = 0;
  for (let sample = 0; sample < iterations; sample++) {
    const used = new Uint8Array(52);
    const order = opponents.map((_, index) => index);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const opponentHoles = new Array(opponents.length);
    for (const index of order) {
      const combo = sampleCombo(pool, ranges[index], used, random);
      used[combo.a] = used[combo.b] = 1;
      opponentHoles[index] = [combo.a, combo.b];
    }
    const runout = [...board];
    const remaining = pool.available.filter(code => !used[code]);
    while (runout.length < 5) {
      const index = Math.floor(random() * remaining.length);
      runout.push(remaining[index]);
      remaining[index] = remaining[remaining.length - 1];
      remaining.pop();
    }
    const heroRank = phe.evaluateCardCodes([...hole, ...runout]);
    let tied = 1;
    let beaten = false;
    for (const unknownHole of opponentHoles) {
      const rank = phe.evaluateCardCodes([...unknownHole, ...runout]);
      if (rank < heroRank) { beaten = true; break; }
      if (rank === heroRank) tied++;
    }
    const share = beaten ? 0 : 1 / tied;
    shares += share;
    squares += share * share;
    if (!beaten && tied === 1) wins++;
    if (!beaten && tied > 1) ties++;
  }
  const equity = shares / iterations;
  return { equity, winRate: wins / iterations, tieRate: ties / iterations, sampleCount: iterations,
    standardError: Math.sqrt(Math.max(0, squares / iterations - equity * equity) / iterations),
    ranges: opponents.map((opponent, index) => ({ id: opponent.id, label: ranges[index].label })) };
}

function legalAction(desired, snapshot) {
  const legal = snapshot.legalActions;
  if (desired.type === 'raise' && legal.canRaise) {
    const amount = Math.round(clamp(desired.amount, Math.min(legal.minRaise, legal.maxRaise), legal.maxRaise));
    if (amount === legal.maxRaise && legal.canAllIn) return { type: 'allin' };
    return { type: 'raise', amount };
  }
  if (desired.type === 'allin' && legal.canAllIn) return { type: 'allin' };
  if (desired.type === 'fold') return legal.canCheck ? { type: 'check' } : { type: 'fold' };
  if (desired.type === 'check' && legal.canCheck) return { type: 'check' };
  return { type: legal.canCheck ? 'check' : 'call' };
}

function recommendationFor(snapshot, info, style, random) {
  const legal = snapshot.legalActions;
  const { hero, equity, potOdds, position, opponents, effectiveStackBB, strength, hole, draws, callCost } = info;
  const blind = snapshot.bigBlind || snapshot.config?.bigBlind || 1;
  const callFraction = callCost / Math.max(1, hero.chips);
  const preflop = snapshot.phase === 'preflop';
  const pair = rankOf(hole[0]) === rankOf(hole[1]);
  const premium = pair && rankOf(hole[0]) >= 12 || strength >= 0.77;
  const free = legal.canCheck;
  const pot = Math.max(blind, snapshot.pot || 0);
  const unraised = (snapshot.currentBet || 0) <= blind;
  const realization = preflop ? clamp((position.late ? 0.88 : 0.72) + (strength > 0.7 ? 0.12 : 0) +
    (suitOf(hole[0]) === suitOf(hole[1]) ? 0.06 : 0) - (opponents.length > 2 ? 0.06 : 0), 0.55, 1)
    : snapshot.phase === 'river' ? 1 : position.late ? 0.96 : 0.88;
  const realizedEquity = equity * realization;
  let desired;
  let rationale;
  if (preflop) {
    if (legal.canRaise && unraised && strength >= position.threshold + style.open) {
      const limpers = opponents.filter(opponent => opponent.bet >= blind && opponent.seat !== snapshot.bigBlindSeat).length;
      const amount = Math.max(legal.minRaise, Math.round(blind * (2.5 + limpers)));
      desired = effectiveStackBB <= 10 && premium && legal.canAllIn ? { type: 'allin' } : { type: 'raise', amount };
      rationale = '起手牌达到当前位置的开池范围，主动加注建立价值并减少对手人数。';
    } else if (legal.canRaise && !unraised && (premium || equity >= (opponents.length <= 1 ? 0.66 : 0.53))) {
      desired = effectiveStackBB <= 22 && premium && legal.canAllIn ? { type: 'allin' }
        : { type: 'raise', amount: Math.max(legal.minRaise, Math.round(snapshot.currentBet * (position.late ? 3 : 3.5))) };
      rationale = '面对已有加注，强起手牌适合价值再加注；短筹码减少后续街的决策空间。';
    } else if (free) {
      desired = { type: 'check' };
      rationale = '无需支付筹码，可以免费进入下一街；边缘起手牌不必扩大底池。';
    } else if (premium || (strength >= 0.34 && realizedEquity >= potOdds + style.margin && callFraction < 0.45) ||
      (strength >= 0.58 && realizedEquity >= potOdds + style.margin)) {
      desired = { type: 'call' };
      rationale = '跟注成本与估算权益相符，但翻前权益需要结合位置和后续实现率。';
    } else {
      desired = { type: 'fold' };
      rationale = '当前范围、跟注成本或筹码压力不利于继续投入，保留筹码等待更好机会。';
    }
  } else {
    const valueThreshold = legal.toCall > 0 ? 0.68 : Math.min(0.72, 0.53 + opponents.length * 0.04);
    const wet = draws.length > 0 || new Set(snapshot.board.map(card => card.suit)).size <= 2;
    if (legal.canRaise && equity >= valueThreshold) {
      const amount = legal.toCall > 0
        ? Math.max(legal.minRaise, snapshot.currentBet + Math.round((pot + callCost) * (wet ? 0.85 : style.size)))
        : Math.max(legal.minRaise, Math.round(pot * (wet ? 0.78 : style.size)));
      desired = effectiveStackBB <= 10 && equity > 0.78 && legal.canAllIn ? { type: 'allin' } : { type: 'raise', amount };
      rationale = '在估计对手范围中占有明显权益优势，价值下注让较弱的成牌或听牌付费。';
    } else if (legal.canRaise && draws.length && opponents.length <= 2 && snapshot.phase !== 'river' &&
      equity >= 0.3 && random() < style.bluff * (draws.includes('坚果同花听牌') ? 2.4 : 1.4)) {
      desired = { type: 'raise', amount: Math.max(legal.minRaise, snapshot.currentBet + Math.round(pot * 0.6)) };
      rationale = '有改进机会的听牌可少量半诈唬，同时保留被跟注后的摊牌权益。';
    } else if (free) {
      if (legal.canRaise && opponents.length === 1 && position.late && random() < style.bluff && equity < 0.42) {
        desired = { type: 'raise', amount: Math.max(legal.minRaise, Math.round(pot * 0.4)) };
        rationale = '单挑且有位置时，少量小尺寸诈唬避免策略只在强牌时下注；这依赖对手弃牌。';
      } else {
        desired = { type: 'check' };
        rationale = '可以免费实现权益，当前优势不足以稳定进行价值下注。';
      }
    } else if (realizedEquity >= potOdds + style.margin || (snapshot.phase === 'river' && equity >= 0.999)) {
      desired = { type: 'call' };
      rationale = '估算权益高于当前跟注所需权益，保留对手诈唬范围并控制底池。';
    } else {
      desired = { type: 'fold' };
      rationale = '估算权益不足以覆盖跟注成本；多人底池或未完成听牌需要更谨慎。';
    }
  }
  return { action: legalAction(desired, snapshot), rationale, realizedEquity };
}

function actionLabel(action, legal) {
  return ({ fold: '弃牌', check: '过牌', call: `跟注 ${legal.toCall}`, raise: `加注到 ${action.amount}`, allin: '全下' })[action.type];
}

/** Analyze only a player's private snapshot. Opponents' cards are never read. */
export function analyzeDecision(snapshot, options = {}) {
  if (!snapshot || !Array.isArray(snapshot.players)) throw new Error('分析需要有效的牌局快照');
  const heroId = options.heroId ?? snapshot.actorId;
  const hero = snapshot.players.find(player => player.id === heroId);
  const source = { source: AI_SOURCE, links: AI_LINKS.map(link => ({ ...link })), method: 'monte-carlo-range-heuristic', isGTO: false };
  if (!hero || !hero.inHand || hero.folded || !Array.isArray(hero.cards) || hero.cards.length !== 2 || hero.cards.some(card => card.hidden)) {
    return { ...source, available: false, heroId: heroId ?? null, recommendation: null, equity: null, potOdds: null,
      position: '等待发牌', handLabel: '底牌尚不可用', draws: [], reasons: ['仅在拥有自己的两张可见底牌时提供分析。'], concepts: [],
      sampleCount: 0, confidence: { level: 'none', label: '暂无分析', interval: null } };
  }
  const hole = hero.cards.map(cardCode);
  const board = (snapshot.board || []).map(cardCode);
  if (![0, 3, 4, 5].includes(board.length)) throw new Error('公共牌数量无效');
  if (new Set([...hole, ...board]).size !== hole.length + board.length) throw new Error('可见牌不能重复');
  // Explicit projection is a privacy boundary: do not spread or inspect a
  // non-hero player object, since a caller might pass an unsanitized snapshot.
  const opponents = snapshot.players.filter(player => player.id !== hero.id && player.inHand && !player.folded).map(player => ({
    id: player.id, seat: player.seat, chips: player.chips, bet: player.bet, totalBet: player.totalBet,
    lastAction: player.lastAction, allIn: player.allIn, inHand: true,
  }));
  if (opponents.length > 8) throw new Error('分析最多支持 9 人牌桌');
  const iterations = clamp(Number.isFinite(options.iterations) ? Math.floor(options.iterations) : 700, 100, 2400);
  const styleName = Object.hasOwn(STYLES, options.style || '') ? options.style : 'balanced';
  const style = STYLES[styleName];
  const rangeModel = options.rangeModel === 'uniform' ? 'uniform' : 'inferred';
  const random = randomSource(options.seed);
  const simulation = monteCarlo(snapshot, hole, board, opponents, iterations, random, rangeModel);
  const legal = snapshot.legalActions || { canAct: false, toCall: 0 };
  const callCost = Math.min(hero.chips, Math.max(0, legal.toCall || 0));
  const contributionCap = hero.totalBet + callCost;
  const eligiblePot = callCost > 0 ? snapshot.players.reduce((sum, player) => sum + Math.min(player.totalBet || 0, contributionCap), 0)
    : snapshot.pot || 0;
  const potOdds = callCost > 0 ? callCost / Math.max(1, eligiblePot + callCost) : 0;
  const position = positionOf(snapshot, hero);
  const blind = snapshot.bigBlind || snapshot.config?.bigBlind || 1;
  const heroStack = hero.chips + hero.bet;
  const opponentStack = opponents.length ? Math.max(...opponents.map(player => player.chips + player.bet)) : heroStack;
  const effectiveStackBB = Math.min(heroStack, opponentStack) / blind;
  const draws = drawsFor(hole, board);
  const strength = startingStrength(...hole);
  const info = { hero, hole, equity: simulation.equity, potOdds, position, opponents, effectiveStackBB, strength, draws, callCost };
  const choice = legal.canAct && snapshot.actorId === heroId ? recommendationFor(snapshot, info, style, random) : null;
  const handLabel = board.length >= 3 ? HAND_NAMES[8 - phe.handRank(phe.evaluateCardCodes([...hole, ...board]))] : holeLabel(hole);
  const error = simulation.standardError * 1.96;
  const interval = [round(clamp(simulation.equity - error, 0, 1)), round(clamp(simulation.equity + error, 0, 1))];
  const reasons = [
    `对 ${opponents.length} 位仍在手的对手，按假设范围和随机发完公共牌，预计摊牌底池份额约 ${percent(simulation.equity)}（平分按份额计算）。`,
    callCost ? `需投入 ${callCost} 筹码，可争夺底池约 ${eligiblePot}；跟注盈亏平衡所需权益为 ${percent(potOdds)}。` : '当前无需跟注，底池赔率门槛为 0，可免费过牌。',
    `${position.label}，有效筹码约 ${Math.round(effectiveStackBB * 10) / 10} 个大盲；位置和筹码深度会改变继续入池及下注尺寸。`,
  ];
  if (choice) reasons.push(choice.rationale);
  else reasons.push('尚未轮到你行动，建议会在你的回合重新计算。');
  if (draws.length) reasons.push(`目前有${draws.join('、')}；潜在补牌可能被更强牌压制，不能把所有补牌都当作干净 outs。`);
  if (opponents.length >= 3) reasons.push('多人底池要求更强的价值范围，诈唬频率降低。');
  if (eligiblePot < (snapshot.pot || 0)) reasons.push('你无法赢取超过自己筹码贡献的边池，跟注门槛已扣除不可争夺部分。');
  if (legal.canAct && !legal.canRaise && legal.toCall > 0) reasons.push('本轮未开放加注权或对手已全部全下，只能跟注或弃牌。');
  return {
    ...source, available: true, heroId, recommendation: choice ? { ...choice.action, label: actionLabel(choice.action, { ...legal, toCall: callCost }) } : null,
    equity: round(simulation.equity), winRate: round(simulation.winRate), tieRate: round(simulation.tieRate),
    potOdds: round(potOdds), pot: snapshot.pot || 0, eligiblePot, callCost, callIsAllIn: callCost > 0 && callCost === hero.chips,
    position: position.label, handLabel, holeLabel: holeLabel(hole), draws,
    effectiveStackBB: round(effectiveStackBB), opponentCount: opponents.length,
    reasons, concepts: ['底池赔率', '范围与权益', '位置优势', '有效筹码', ...(draws.length ? ['听牌与半诈唬'] : []), ...(opponents.length > 1 ? ['多人底池'] : [])],
    sampleCount: simulation.sampleCount, rangeModel, ranges: simulation.ranges,
    confidence: { level: iterations >= 1000 ? 'medium' : 'low', label: `样本误差约 ±${Math.round(error * 1000) / 10} 个百分点；范围假设另有误差`, interval },
    limitations: ['权益来自假设范围，不代表读取了对手底牌。', '不计算后续下注树、真实弃牌率、抽水或赛事 ICM；属于教学启发式，并非 GTO 或精确 EV。'],
    legalActions: { ...legal }, style: styleName,
  };
}

export function chooseBotAction(snapshot, options = {}) {
  const analysis = analyzeDecision(snapshot, options);
  if (!analysis.available || !analysis.recommendation) throw new Error('当前没有可执行的 AI 行动');
  const { type, amount } = analysis.recommendation;
  return type === 'raise' ? { type, amount } : { type };
}

/** Coaching agreement with a heuristic, intentionally not an EV/GTO score. */
export function gradeDecision(analysis, action) {
  if (!analysis?.available || !analysis.recommendation || !action) return {
    grade: 'discuss', label: '等待分析', score: null, message: '当前没有完整建议，暂不评价这个行动。',
  };
  const suggested = analysis.recommendation;
  const legal = analysis.legalActions || {};
  const callAllIn = suggested.type === 'call' && action.type === 'allin' && analysis.callIsAllIn;
  const raisesEquivalent = (suggested.type === 'allin' && action.type === 'raise' && action.amount === legal.maxRaise) ||
    (suggested.type === 'raise' && action.type === 'allin' && suggested.amount === legal.maxRaise);
  if ((action.type === suggested.type && (action.type !== 'raise' || Math.abs(action.amount - suggested.amount) <= Math.max(1, suggested.amount * 0.35))) || callAllIn || raisesEquivalent) {
    return { grade: 'good', label: '思路一致', score: 90, message: '你的行动接近本次范围估算建议。结合位置、赔率和对手行动继续判断；这不是精确 EV 评分。' };
  }
  if (action.type === 'fold' && legal.canCheck) return { grade: 'improve', label: '可改进', score: 25, message: '当前可以免费过牌，弃牌会放弃无需付费的摊牌机会。' };
  if (suggested.type === 'fold' && ['call', 'raise', 'allin'].includes(action.type)) return {
    grade: 'improve', label: '注意投入成本', score: 35, message: `按当前假设，权益 ${percent(analysis.equity)} 与跟注门槛 ${percent(analysis.potOdds)} 不支持继续投入；检查范围假设是否符合对手。`,
  };
  if (action.type === 'fold' && analysis.equity > 0.75) return { grade: 'improve', label: '检查是否过度弃牌', score: 35, message: '当前假设范围下权益较高，考虑跟注或价值加注；也可以记录你认为对手更强的具体依据。' };
  return { grade: 'discuss', label: '值得讨论', score: 65, message: `建议为${suggested.label}。你的不同选择可能依赖对手倾向或下注尺寸，复盘时先解释范围与赔率依据。` };
}
