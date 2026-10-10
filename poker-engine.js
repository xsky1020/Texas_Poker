import { randomInt } from 'node:crypto';

export const DEFAULT_CONFIG = Object.freeze({
  roomName: '周末牌局', smallBlind: 50, bigBlind: 100, ante: 0,
  initialChips: 10000, minBuyIn: 2000, maxBuyIn: 20000,
  turnSeconds: 30, maxPlayers: 6, blindIntervalMinutes: 0,
  blindMultiplier: 2, sessionMinutes: 0, handDelaySeconds: 5, autoDeal: false,
});

const LIMITS = {
  smallBlind: [1, 100000000], bigBlind: [1, 100000000], ante: [0, 100000000],
  initialChips: [1, 1000000000], minBuyIn: [1, 1000000000], maxBuyIn: [1, 1000000000],
  turnSeconds: [1, 300], maxPlayers: [2, 9], blindIntervalMinutes: [0, 1440],
  blindMultiplier: [2, 10], sessionMinutes: [0, 1440], handDelaySeconds: [0, 300],
};
const LABELS = {
  smallBlind: '小盲注', bigBlind: '大盲注', ante: '前注', initialChips: '初始筹码',
  minBuyIn: '最小买入', maxBuyIn: '最大买入', turnSeconds: '行动时间', maxPlayers: '人数上限',
  blindIntervalMinutes: '加盲间隔', blindMultiplier: '加盲倍数', sessionMinutes: '牌局时长',
  handDelaySeconds: '手牌间隔',
};
const ACTIVE_PHASES = new Set(['preflop', 'flop', 'turn', 'river']);
const HAND_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];
const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

export function validateConfig(input = {}, base = DEFAULT_CONFIG) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('牌局设置格式无效');
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`未知设置：${key}`);
  }
  const config = { ...DEFAULT_CONFIG, ...base, ...input };
  if (typeof config.roomName !== 'string' || !config.roomName.trim() || config.roomName.trim().length > 40) {
    throw new Error('房间名称需为 1–40 个字符');
  }
  config.roomName = config.roomName.trim();
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) {
      throw new Error(`${LABELS[key]}需为 ${min}–${max} 的整数`);
    }
  }
  if (typeof config.autoDeal !== 'boolean') throw new Error('自动发牌设置需为开或关');
  if (config.smallBlind > config.bigBlind) throw new Error('小盲注不能大于大盲注');
  if (config.minBuyIn > config.maxBuyIn) throw new Error('最小买入不能大于最大买入');
  if (config.initialChips < config.minBuyIn || config.initialChips > config.maxBuyIn) {
    throw new Error('初始筹码需在最小买入和最大买入之间');
  }
  if (config.bigBlind > config.maxBuyIn) throw new Error('大盲注不能超过最大买入');
  return config;
}

function rankOf(card) {
  if (Number.isInteger(card?.value) && card.value >= 2 && card.value <= 14) return card.value;
  const index = RANKS.indexOf(card?.rank);
  if (index < 0) throw new Error('扑克牌点数无效');
  return index + 2;
}

function fiveCardHand(cards) {
  const values = cards.map(rankOf).sort((a, b) => b - a);
  const counts = new Map();
  values.forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every(card => card.suit === cards[0].suit);
  let straight = 0;
  if (counts.size === 5) {
    if (values[0] - values[4] === 4) straight = values[0];
    else if (values.join(',') === '14,5,4,3,2') straight = 5;
  }
  let category;
  let kickers;
  if (flush && straight) { category = 8; kickers = [straight]; }
  else if (groups[0][1] === 4) { category = 7; kickers = [groups[0][0], groups[1][0]]; }
  else if (groups[0][1] === 3 && groups[1][1] === 2) { category = 6; kickers = [groups[0][0], groups[1][0]]; }
  else if (flush) { category = 5; kickers = values; }
  else if (straight) { category = 4; kickers = [straight]; }
  else if (groups[0][1] === 3) { category = 3; kickers = [groups[0][0], ...groups.slice(1).map(group => group[0])]; }
  else if (groups[0][1] === 2 && groups[1][1] === 2) {
    category = 2; kickers = [Math.max(groups[0][0], groups[1][0]), Math.min(groups[0][0], groups[1][0]), groups[2][0]];
  }
  else if (groups[0][1] === 2) { category = 1; kickers = [groups[0][0], ...groups.slice(1).map(group => group[0])]; }
  else { category = 0; kickers = values; }
  return { category, kickers, name: HAND_NAMES[category], cards: cards.map(card => ({ ...card })) };
}

export function compareHands(a, b) {
  if (a.category !== b.category) return Math.sign(a.category - b.category);
  for (let i = 0; i < Math.max(a.kickers.length, b.kickers.length); i++) {
    const difference = (a.kickers[i] || 0) - (b.kickers[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function evaluateHand(cards) {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) throw new Error('牌型判断需要 5–7 张牌');
  const seen = new Set();
  for (const card of cards) {
    if (!SUITS.includes(card?.suit)) throw new Error('扑克牌花色无效');
    const key = `${rankOf(card)}${card.suit}`;
    if (seen.has(key)) throw new Error('扑克牌不能重复');
    seen.add(key);
  }
  let best = null;
  for (let a = 0; a < cards.length - 4; a++) {
    for (let b = a + 1; b < cards.length - 3; b++) {
      for (let c = b + 1; c < cards.length - 2; c++) {
        for (let d = c + 1; d < cards.length - 1; d++) {
          for (let e = d + 1; e < cards.length; e++) {
            const hand = fiveCardHand([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || compareHands(hand, best) > 0) best = hand;
          }
        }
      }
    }
  }
  return best;
}

function freshDeck() {
  const deck = SUITS.flatMap(suit => RANKS.map((rank, index) => ({ rank, suit, value: index + 2 })));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** Server-authoritative no-limit Hold'em. Raise amounts are the total street bet. */
export class PokerRoom {
  constructor(code, config = {}) {
    this.code = code;
    this.config = validateConfig(config);
    this.players = [];
    this.hostId = null;
    this.phase = 'lobby';
    this.actorId = null;
    this.handNumber = 0;
    this.startedAt = null;
    this.handStartedAt = null;
    this.deadline = null;
    this.lastActivity = Date.now();
    this.dealerSeat = null;
    this.smallBlindSeat = null;
    this.bigBlindSeat = null;
    this.smallBlind = this.config.smallBlind;
    this.bigBlind = this.config.bigBlind;
    this.blindLevel = 0;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.board = [];
    this.deck = [];
    this.logs = [];
    this.result = null;
    this.handEndedAt = null;
  }

  get pot() {
    if (this.phase === 'showdown' && this.result) return this.result.pot;
    return this.players.reduce((total, player) => total + player.totalBet, 0);
  }

  get sessionExpired() {
    return this._sessionExpired(Date.now());
  }

  _sessionExpired(now) {
    return this.startedAt !== null && this.config.sessionMinutes > 0 && now >= this.startedAt + this.config.sessionMinutes * 60000;
  }

  _log(text, at = Date.now()) {
    this.logs.push({ text, at });
    if (this.logs.length > 100) this.logs.splice(0, this.logs.length - 100);
  }

  _player(id) {
    const player = this.players.find(player => player.id === id);
    if (!player) throw new Error('玩家不存在');
    return player;
  }

  addPlayer(id, name, { bot = false } = {}) {
    if (typeof id !== 'string' || !id || this.players.some(player => player.id === id)) throw new Error('玩家身份无效或已加入');
    if (this.players.length >= this.config.maxPlayers) throw new Error('房间已满');
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 20) throw new Error('昵称需为 1–20 个字符');
    const usedSeats = new Set(this.players.map(player => player.seat));
    let seat = 0;
    while (usedSeats.has(seat)) seat++;
    const player = {
      id, name: name.trim(), seat, chips: this.config.initialChips, connected: true, bot: Boolean(bot),
      cards: [], bet: 0, totalBet: 0, folded: false, allIn: false, inHand: false,
      lastAction: '', totalBuyIn: this.config.initialChips, actedAtBet: null, reopenSize: this.bigBlind,
    };
    this.players.push(player);
    this.players.sort((a, b) => a.seat - b.seat);
    if (!this.hostId) this.hostId = id;
    this.lastActivity = Date.now();
    this._log(`${player.name} 加入牌桌`);
    return player;
  }

  removePlayer(id) {
    const player = this._player(id);
    if (ACTIVE_PHASES.has(this.phase) && player.inHand) throw new Error('本手结算后才能离开牌桌');
    this.players = this.players.filter(candidate => candidate.id !== id);
    if (this.hostId === id) this.hostId = this.players.find(candidate => candidate.connected)?.id || this.players[0]?.id || null;
    this.lastActivity = Date.now();
    this._log(`${player.name} 离开牌桌`);
    return player;
  }

  updateConfig(patch) {
    if (ACTIVE_PHASES.has(this.phase)) throw new Error('请等待本手结算后修改设置');
    const next = validateConfig(patch, this.config);
    if (next.maxPlayers < this.players.length) throw new Error('人数上限不能少于已加入人数');
    this.config = next;
    if (this.phase === 'lobby') {
      this.smallBlind = next.smallBlind;
      this.bigBlind = next.bigBlind;
      this.minRaise = next.bigBlind;
    }
    this.lastActivity = Date.now();
    this._log('房主更新了牌局设置');
    return { ...this.config };
  }

  buyIn(id, amount) {
    const player = this._player(id);
    if (ACTIVE_PHASES.has(this.phase) && player.inHand && !player.folded) throw new Error('正在参与本手，结算后才能补充筹码');
    if (!Number.isSafeInteger(amount) || amount < this.config.minBuyIn || amount > this.config.maxBuyIn) {
      throw new Error(`买入金额需为 ${this.config.minBuyIn}–${this.config.maxBuyIn} 的整数`);
    }
    if (player.chips + amount > this.config.maxBuyIn) throw new Error(`补充后筹码不能超过 ${this.config.maxBuyIn}`);
    player.chips += amount;
    player.totalBuyIn += amount;
    this.lastActivity = Date.now();
    this._log(`${player.name} 补充 ${amount} 筹码`);
    return player;
  }

  _nextPlayer(afterSeat, predicate) {
    const sorted = this.players.filter(predicate).sort((a, b) => a.seat - b.seat);
    return sorted.find(player => afterSeat === null || player.seat > afterSeat) || sorted[0] || null;
  }

  _livePlayers() { return this.players.filter(player => player.inHand && !player.folded); }
  _canAct(player) { return player.inHand && !player.folded && !player.allIn && player.chips > 0; }

  _setActor(player, now) {
    this.actorId = player?.id || null;
    this.deadline = player ? now + this.config.turnSeconds * 1000 : null;
  }

  _commit(player, amount) {
    const paid = Math.min(player.chips, amount);
    player.chips -= paid;
    player.bet += paid;
    player.totalBet += paid;
    if (player.chips === 0) player.allIn = true;
    return paid;
  }

  _postAnte(player) {
    const paid = Math.min(player.chips, this.config.ante);
    player.chips -= paid;
    player.totalBet += paid;
    if (player.chips === 0) player.allIn = true;
    return paid;
  }

  startHand(now = Date.now()) {
    if (ACTIVE_PHASES.has(this.phase)) throw new Error('本手仍在进行');
    if (this._sessionExpired(now)) throw new Error('设定的牌局时间已结束，请新建房间继续');
    const participants = this.players.filter(player => player.connected && player.chips > 0);
    if (participants.length < 2) throw new Error('至少需要两位在线且有筹码的玩家');
    if (this.startedAt === null) this.startedAt = now;
    const interval = this.config.blindIntervalMinutes * 60000;
    this.blindLevel = interval > 0 ? Math.floor(Math.max(0, now - this.startedAt) / interval) : 0;
    const multiplier = Math.min(1000000000, this.config.blindMultiplier ** this.blindLevel);
    this.smallBlind = Math.min(1000000000, this.config.smallBlind * multiplier);
    this.bigBlind = Math.min(1000000000, this.config.bigBlind * multiplier);
    this.minRaise = this.bigBlind;
    this.handNumber++;
    this.handStartedAt = now;
    this.handEndedAt = null;
    this.phase = 'preflop';
    this.board = [];
    this.deck = freshDeck();
    this.result = null;
    this.currentBet = this.bigBlind;
    for (const player of this.players) {
      player.cards = [];
      player.bet = 0;
      player.totalBet = 0;
      player.folded = false;
      player.allIn = false;
      player.inHand = participants.includes(player);
      player.lastAction = '';
      player.actedAtBet = null;
      player.reopenSize = this.bigBlind;
    }
    const dealer = this._nextPlayer(this.dealerSeat, player => player.inHand);
    this.dealerSeat = dealer.seat;
    const smallBlind = participants.length === 2 ? dealer : this._nextPlayer(dealer.seat, player => player.inHand);
    const bigBlind = this._nextPlayer(smallBlind.seat, player => player.inHand);
    this.smallBlindSeat = smallBlind.seat;
    this.bigBlindSeat = bigBlind.seat;
    let dealingSeat = dealer.seat;
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < participants.length; i++) {
        const player = this._nextPlayer(dealingSeat, candidate => candidate.inHand);
        player.cards.push(this.deck.pop());
        dealingSeat = player.seat;
      }
    }
    if (this.config.ante > 0) for (const player of participants) this._postAnte(player);
    const smallPaid = this._commit(smallBlind, this.smallBlind);
    const bigPaid = this._commit(bigBlind, this.bigBlind);
    smallBlind.lastAction = `小盲 ${smallPaid}`;
    bigBlind.lastAction = `大盲 ${bigPaid}`;
    this._log(`第 ${this.handNumber} 手开始 · 盲注 ${this.smallBlind}/${this.bigBlind}${this.config.ante ? ` · 前注 ${this.config.ante}` : ''}`, now);
    this.lastActivity = now;
    const first = participants.length === 2 ? dealer : this._nextPlayer(bigBlind.seat, player => this._canAct(player));
    this._continueAfterAction(first?.seat ?? bigBlind.seat, now, true);
    return this.snapshot(this.hostId);
  }

  legalActions(id) {
    const player = this.players.find(player => player.id === id);
    const result = { canAct: false, toCall: 0, canCheck: false, canRaise: false, canAllIn: false, minRaise: this.currentBet + this.minRaise, maxRaise: 0 };
    if (!player) return result;
    result.toCall = Math.max(0, this.currentBet - player.bet);
    result.maxRaise = player.bet + player.chips;
    if (!ACTIVE_PHASES.has(this.phase) || this.actorId !== id || !this._canAct(player)) return result;
    result.canAct = true;
    result.canCheck = result.toCall === 0;
    // A checked player can raise a first short all-in opening bet. Otherwise,
    // cumulative short raises reopen action only after a full raise's increase.
    const reopening = player.actedAtBet === null || player.actedAtBet === 0 ||
      this.currentBet - player.actedAtBet >= player.reopenSize;
    const anotherCanAct = this._livePlayers().some(candidate => candidate.id !== id && this._canAct(candidate));
    result.canRaise = reopening && result.maxRaise > this.currentBet && anotherCanAct;
    result.canAllIn = result.maxRaise <= this.currentBet || result.canRaise;
    // Completing a short opening bet needs a full minimum opening wager;
    // preflop remains governed by the nominal big blind.
    result.minRaise = this.currentBet < this.bigBlind && this.phase !== 'preflop'
      ? this.bigBlind : this.currentBet + this.minRaise;
    return result;
  }

  act(id, action, now = Date.now()) {
    const player = this._player(id);
    const legal = this.legalActions(id);
    if (!legal.canAct) throw new Error('现在不是你的行动回合');
    if (!action || typeof action !== 'object') throw new Error('行动格式无效');
    const type = action.type;
    if (!['fold', 'check', 'call', 'raise', 'allin'].includes(type)) throw new Error('行动类型无效');
    if (type === 'check' && !legal.canCheck) throw new Error('需要跟注，不能过牌');
    if (type === 'call' && legal.toCall === 0) throw new Error('无需跟注，请过牌');
    let raiseTo = null;
    if (type === 'raise') {
      raiseTo = action.amount;
      if (!Number.isSafeInteger(raiseTo) || raiseTo <= this.currentBet || raiseTo > legal.maxRaise) throw new Error('加注金额无效或超过可用筹码');
      if (!legal.canRaise) throw new Error('当前不能再次加注');
      if (raiseTo < legal.minRaise && raiseTo !== legal.maxRaise) throw new Error(`本轮至少加注到 ${legal.minRaise}`);
    }
    if (type === 'allin' && legal.maxRaise > this.currentBet) {
      if (!legal.canRaise) throw new Error('本轮加注权尚未重新开放，只能跟注或弃牌');
      raiseTo = legal.maxRaise;
    }
    if (type === 'fold') {
      player.folded = true;
      player.lastAction = '弃牌';
    } else if (type === 'check') {
      player.lastAction = '过牌';
    } else if (raiseTo !== null) {
      const previousBet = this.currentBet;
      this._commit(player, raiseTo - player.bet);
      this.currentBet = raiseTo;
      const increase = raiseTo - previousBet;
      const minimumBefore = previousBet < this.bigBlind && this.phase !== 'preflop' ? this.bigBlind : previousBet + this.minRaise;
      const fullRaise = raiseTo >= minimumBefore;
      if (fullRaise) {
        this.minRaise = previousBet < this.bigBlind && this.phase !== 'preflop' ? raiseTo : increase;
        for (const candidate of this.players) candidate.actedAtBet = null;
      }
      player.lastAction = player.allIn ? `全下 ${raiseTo}` : `${previousBet === 0 ? '下注' : '加注到'} ${raiseTo}`;
      this._log(`${player.name} ${player.lastAction}`, now);
    } else {
      const paid = this._commit(player, Math.min(player.chips, legal.toCall));
      player.lastAction = player.allIn ? `全下跟注 ${paid}` : `跟注 ${paid}`;
    }
    player.actedAtBet = this.currentBet;
    player.reopenSize = this.minRaise;
    if (raiseTo === null) this._log(`${player.name} ${player.lastAction}`, now);
    this.lastActivity = now;
    this._continueAfterAction(player.seat, now);
    return this.snapshot(id);
  }

  _roundComplete() {
    return this._livePlayers().filter(player => this._canAct(player)).every(player =>
      player.actedAtBet !== null && player.bet >= this.currentBet);
  }

  _continueAfterAction(afterSeat, now, includeSeat = false) {
    const live = this._livePlayers();
    if (live.length === 1) { this._awardUncontested(live[0], now); return; }
    const actionable = live.filter(player => this._canAct(player));
    // A nominal big blind above an all-in blind is only relevant while two
    // players can still wager. With one player left, require the actual call.
    if (actionable.length === 1) this.currentBet = Math.max(...live.map(player => player.bet));
    if (actionable.length === 0 || (actionable.length === 1 && actionable[0].bet >= this.currentBet)) {
      this._refundUncalled(now);
      this._runOut(now);
      return;
    }
    if (!includeSeat && this._roundComplete()) { this._nextStreet(now); return; }
    const needsAction = player => this._canAct(player) && (player.actedAtBet === null || player.bet < this.currentBet);
    const sameSeat = includeSeat ? this.players.find(player => player.seat === afterSeat && needsAction(player)) : null;
    const actor = sameSeat || this._nextPlayer(afterSeat, needsAction);
    if (!actor) { this._nextStreet(now); return; }
    this._setActor(actor, now);
  }

  _refundUncalled(now) {
    const ordered = this.players.filter(player => player.inHand).sort((a, b) => b.bet - a.bet);
    if (ordered.length < 2 || ordered[0].folded) return;
    const refund = ordered[0].bet - ordered[1].bet;
    if (refund <= 0) return;
    const player = ordered[0];
    player.chips += refund;
    player.bet -= refund;
    player.totalBet -= refund;
    player.allIn = player.chips === 0;
    this._log(`${player.name} 收回无人跟注的 ${refund} 筹码`, now);
  }

  _dealBoard(count) {
    this.deck.pop(); // Burn card before each community-card street.
    for (let i = 0; i < count; i++) this.board.push(this.deck.pop());
  }

  _nextStreet(now) {
    this._refundUncalled(now);
    if (this.phase === 'river') { this._showdown(now); return; }
    const nextPhase = { preflop: 'flop', flop: 'turn', turn: 'river' }[this.phase];
    this._dealBoard(nextPhase === 'flop' ? 3 : 1);
    this.phase = nextPhase;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    for (const player of this.players) {
      player.bet = 0;
      player.actedAtBet = null;
      player.reopenSize = this.bigBlind;
      if (player.inHand && !player.folded && !player.allIn) player.lastAction = '';
    }
    this._log({ flop: '发出翻牌', turn: '发出转牌', river: '发出河牌' }[nextPhase], now);
    this._continueAfterAction(this.dealerSeat, now);
  }

  _runOut(now) {
    while (this.board.length < 5) this._dealBoard(this.board.length === 0 ? 3 : 1);
    this._showdown(now);
  }

  _finishResult(winners, totalPot, summary, now, pots = [], showCards = true) {
    this.phase = 'showdown';
    this._setActor(null, now);
    this.handEndedAt = now;
    this.result = { winners, pot: totalPot, summary, pots, showCards };
    this._log(summary, now);
    this.lastActivity = now;
  }

  _awardUncontested(winner, now) {
    this._refundUncalled(now);
    const totalPot = this.players.reduce((total, player) => total + player.totalBet, 0);
    winner.chips += totalPot;
    winner.allIn = false;
    this._finishResult([{ id: winner.id, name: winner.name, amount: totalPot, handName: '对手弃牌' }], totalPot,
      `${winner.name} 赢得 ${totalPot} 筹码，其他玩家弃牌`, now, [], false);
  }

  _showdown(now) {
    const live = this._livePlayers();
    if (live.length === 1) { this._awardUncontested(live[0], now); return; }
    const hands = new Map(live.map(player => [player.id, evaluateHand([...player.cards, ...this.board])]));
    const contributions = this.players.filter(player => player.inHand && player.totalBet > 0);
    const levels = [...new Set(contributions.map(player => player.totalBet))].sort((a, b) => a - b);
    const awards = new Map();
    const pots = [];
    let previous = 0;
    for (const level of levels) {
      const contributors = contributions.filter(player => player.totalBet >= level);
      const amount = (level - previous) * contributors.length;
      previous = level;
      const eligible = contributors.filter(player => !player.folded);
      if (!eligible.length) throw new Error('底池状态无效：缺少可赢取底池的玩家');
      let best = hands.get(eligible[0].id);
      for (const player of eligible) if (compareHands(hands.get(player.id), best) > 0) best = hands.get(player.id);
      const tied = eligible.filter(player => compareHands(hands.get(player.id), best) === 0);
      tied.sort((a, b) => ((a.seat - this.dealerSeat + 8) % 9) -
        ((b.seat - this.dealerSeat + 8) % 9));
      const split = Math.floor(amount / tied.length);
      let odd = amount % tied.length;
      for (const player of tied) {
        const share = split + (odd-- > 0 ? 1 : 0);
        player.chips += share;
        awards.set(player.id, (awards.get(player.id) || 0) + share);
      }
      pots.push({ amount, eligibleIds: eligible.map(player => player.id), winnerIds: tied.map(player => player.id) });
    }
    const totalPot = contributions.reduce((sum, player) => sum + player.totalBet, 0);
    const winners = this.players.filter(player => awards.has(player.id)).map(player => ({
      id: player.id, name: player.name, amount: awards.get(player.id), handName: hands.get(player.id).name,
    }));
    for (const player of live) if (player.chips > 0) player.allIn = false;
    this._finishResult(winners, totalPot, winners.map(winner => `${winner.name} ${winner.handName}赢得 ${winner.amount} 筹码`).join('；'), now, pots);
  }

  tick(now = Date.now()) {
    if (!ACTIVE_PHASES.has(this.phase) || !this.actorId || this.deadline === null || now < this.deadline) return false;
    const player = this._player(this.actorId);
    const canCheck = this.legalActions(player.id).canCheck;
    this.act(player.id, { type: canCheck ? 'check' : 'fold' }, now);
    player.lastAction = `超时${canCheck ? '过牌' : '弃牌'}`;
    this._log(`${player.name} 行动超时，已自动${canCheck ? '过牌' : '弃牌'}`, now);
    return true;
  }

  snapshot(viewerId) {
    const now = Date.now();
    return {
      code: this.code, config: { ...this.config }, hostId: this.hostId, phase: this.phase,
      actorId: this.actorId, handNumber: this.handNumber, startedAt: this.startedAt,
      handStartedAt: this.handStartedAt, handEndedAt: this.handEndedAt, deadline: this.deadline,
      board: this.board.map(card => ({ ...card })), pot: this.pot,
      currentBet: this.currentBet, minRaise: this.minRaise,
      dealerSeat: this.dealerSeat, smallBlindSeat: this.smallBlindSeat, bigBlindSeat: this.bigBlindSeat,
      smallBlind: this.smallBlind, bigBlind: this.bigBlind, blindLevel: this.blindLevel,
      sessionEndsAt: this.startedAt !== null && this.config.sessionMinutes > 0 ? this.startedAt + this.config.sessionMinutes * 60000 : null,
      nextBlindAt: this.startedAt !== null && this.config.blindIntervalMinutes > 0
        ? this.startedAt + (this.blindLevel + 1) * this.config.blindIntervalMinutes * 60000 : null,
      sessionExpired: this._sessionExpired(now),
      players: this.players.map(player => ({
        id: player.id, name: player.name, seat: player.seat, chips: player.chips,
        connected: player.connected, bot: player.bot, bet: player.bet, totalBet: player.totalBet,
        folded: player.folded, allIn: player.allIn, inHand: player.inHand,
        lastAction: player.lastAction, totalBuyIn: player.totalBuyIn,
        cards: player.cards.map(card => player.id === viewerId || (this.phase === 'showdown' && this.result?.showCards && !player.folded)
          ? { ...card } : { hidden: true }),
      })),
      legalActions: this.legalActions(viewerId), logs: this.logs.slice(-40).map(log => ({ ...log })),
      result: this.result ? structuredClone(this.result) : null,
    };
  }
}
