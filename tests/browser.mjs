import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';

const out = new URL('../output/browser/', import.meta.url);
await mkdir(out, { recursive: true });
const service = await startServer({ port: 0, host: '127.0.0.1' });
const url = `http://127.0.0.1:${service.port}`;
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
const errors = [];
const contexts = [];
const clients = new Map();
const getState = async page => {
  const payload = await page.evaluate(() => JSON.parse(window.render_game_to_text()));
  return payload.room || payload.state || payload;
};
const waitFor = async (page, predicate, label) => {
  for (let i = 0; i < 80; i++) {
    const state = await getState(page);
    if (predicate(state)) return state;
    await page.waitForTimeout(75);
  }
  throw new Error(`Timed out: ${label}`);
};
async function open(name, mobile = false, suffix = '') {
  const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : { viewport: { width: 1440, height: 1000 } });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('dialog', dialog => dialog.accept());
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url + suffix);
  await page.waitForFunction(() => typeof window.render_game_to_text === 'function');
  clients.set(name, page);
  return page;
}
const shot = async (page, name) => page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, out)), fullPage: true, animations: 'disabled', timeout: 60000 });
try {
  const host = await open('林间');
  await host.waitForTimeout(200);
  await shot(host, '01-lobby');
  await host.click('#create-btn');
  await host.fill('#player-name', '林间');
  await host.fill('#room-name', '周末朋友局');
  const settings = { smallBlind: 25, bigBlind: 50, ante: 5, initialChips: 2000, minBuyIn: 500, maxBuyIn: 5000, turnSeconds: 90, handDelaySeconds: 5, blindIntervalMinutes: 10, blindMultiplier: 2, sessionMinutes: 60 };
  for (const [key, value] of Object.entries(settings)) await host.fill(`[name="${key}"]`, String(value));
  await host.selectOption('[name="maxPlayers"]', '9');
  await host.uncheck('[name="autoDeal"]');
  await shot(host, '02-settings');
  await host.click('#submit-room-btn');
  let state = await waitFor(host, s => s.code && s.players?.length === 1, 'create room');
  const code = state.code;
  assert.equal(state.config.bigBlind, 50);
  assert.equal(state.config.initialChips, 2000);
  assert.equal(state.config.maxPlayers, 9);
  const join = async (name, mobile = false) => {
    const page = await open(name, mobile, `/?room=${code}`);
    if (!(await page.locator('#room-dialog').isVisible())) await page.click('#join-btn');
    await page.fill('#player-name', name);
    await page.fill('#join-code', code);
    await page.click('#submit-room-btn');
    await waitFor(page, s => s.code === code && s.players?.some(p => p.name === name), 'join room');
    return page;
  };
  const guest = await join('晚风');
  const mobile = await join('小满', true);
  await waitFor(host, s => s.players?.length === 3, 'all three seats synchronize');
  await guest.click('#buyin-btn');
  await guest.fill('#buyin-amount', '500');
  await guest.locator('#buyin-form button[type="submit"]').click();
  await waitFor(host, s => s.players?.find(p => p.name === '晚风')?.chips === 2500, 'buy-in synchronization');
  await host.click('#settings-btn');
  await host.fill('[name="turnSeconds"]', '100');
  await host.click('#submit-room-btn');
  await waitFor(guest, s => s.config?.turnSeconds === 100, 'updated settings synchronization');
  await shot(host, '03-room');
  await host.click('#start-btn');
  state = await waitFor(host, s => s.phase === 'preflop', 'first hand');
  for (const [name, page] of clients) {
    const view = await waitFor(page, s => s.phase === 'preflop', 'dealt cards reach every player');
    for (const player of view.players) {
      assert.equal(player.cards.length, 2);
      assert.ok(player.name === name ? player.cards.every(c => c.rank && c.suit) : player.cards.every(c => c.hidden && !c.rank && !c.suit));
    }
  }
  await shot(host, '04-preflop');
  await shot(mobile, '05-mobile');
  const actor = state.players.find(p => p.id === state.actorId);
  const actorPage = clients.get(actor.name);
  await actorPage.fill('#raise-amount', '150');
  await actorPage.click('#raise-btn');
  state = await waitFor(host, s => s.currentBet === 150 && s.actorId !== actor.id, 'raise');
  let moves = 0;
  while (state.phase !== 'showdown') {
    const current = state.players.find(p => p.id === state.actorId);
    const page = clients.get(current.name);
    const previous = `${state.phase}:${state.actorId}:${state.currentBet}`;
    await page.click('#call-btn');
    state = await waitFor(host, s => `${s.phase}:${s.actorId}:${s.currentBet}` !== previous, 'call/check transition');
    if (state.phase === 'flop' && state.board.length === 3 && moves < 3) await shot(host, '06-flop');
    assert.ok(++moves < 30);
  }
  assert.equal(state.board.length, 5);
  assert.equal(state.players.reduce((sum, p) => sum + p.chips, 0), 6500);
  assert.ok(state.result.winners.length);
  await shot(host, '07-showdown');
  await host.reload();
  state = await waitFor(host, s => s.code === code && s.handNumber === 1, 'reload resumes seat');
  assert.equal(state.players.filter(p => p.name === '林间').length, 1);
  const currentHost = clients.get(state.players.find(p => p.id === state.hostId).name);
  await currentHost.click('#start-btn');
  state = await waitFor(host, s => s.handNumber === 2 && s.phase === 'preflop', 'next hand after host migration');
  while (state.phase !== 'showdown') {
    const current = state.players.find(p => p.id === state.actorId);
    const previous = `${state.phase}:${state.actorId}`;
    await clients.get(current.name).click('#fold-btn');
    state = await waitFor(host, s => `${s.phase}:${s.actorId}` !== previous, 'fold transition');
  }
  assert.equal(state.result.showCards, false);
  await mobile.click('#leave-btn');
  if (await mobile.locator('dialog[open]').count()) {
    const confirm = mobile.getByRole('button', { name: /确认离开|离开牌桌|确定/ });
    if (await confirm.count()) await confirm.last().click();
  }
  await waitFor(host, s => s.players.length === 2, 'leave room');
  const practice = await open('练习');
  await practice.click('#quick-btn');
  const practiceState = await waitFor(practice, s => s.phase === 'preflop' && s.players?.filter(p => p.bot).length === 2, 'practice room with two bots');
  if (practiceState.legalActions.canAllIn) {
    await practice.click('#allin-btn');
    await waitFor(practice, s => s.phase === 'showdown', 'all-in resolves with practice bots');
  }
  await shot(practice, '08-practice');
  // A raise below the full minimum is legal when it is the player's entire stack.
  const short = await open('短筹码');
  await short.click('#create-btn');
  await short.fill('#player-name', '短筹码');
  for (const [key, value] of Object.entries({ smallBlind: 25, bigBlind: 50, initialChips: 60, minBuyIn: 1, maxBuyIn: 1000 })) {
    await short.fill(`[name="${key}"]`, String(value));
  }
  await short.selectOption('[name="maxPlayers"]', '2');
  await short.click('#submit-room-btn');
  const shortRoom = await waitFor(short, s => s.code && s.players.length === 1, 'short-stack room');
  const opponent = await open('短筹码对手', false, `/?room=${shortRoom.code}`);
  await opponent.fill('#player-name', '短筹码对手');
  await opponent.click('#submit-room-btn');
  await waitFor(short, s => s.players.length === 2, 'heads-up short-stack opponent');
  await short.click('#start-btn');
  await waitFor(short, s => s.legalActions?.canAct, 'small blind acts first');
  assert.equal(await short.locator('#raise-amount').inputValue(), '60');
  await short.click('#raise-btn');
  await waitFor(opponent, s => s.currentBet === 60 && s.legalActions.canAct, 'short all-in raise is accepted');
  await opponent.click('#call-btn');
  const shortResult = await waitFor(short, s => s.phase === 'showdown', 'heads-up all-in runout');
  assert.equal(shortResult.players.reduce((sum, p) => sum + p.chips, 0), 120);
  assert.equal(errors.length, 0, errors.join('\n'));
  await writeFile(new URL('final-state.json', out), JSON.stringify(state, null, 2));
  console.log('Browser QA passed: create/settings/invite/three isolated clients/mobile/buy-in/raise/all streets/showdown/reload/fold/leave/bots/short all-in raise; no console errors.');
} finally {
  await Promise.all(contexts.map(context => context.close()));
  await browser.close();
  await service.close();
}
