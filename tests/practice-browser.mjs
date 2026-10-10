import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../server.js';

const output = new URL('../output/practice/', import.meta.url);
await mkdir(output, { recursive: true });
const service = await startServer({ port: 0, host: '127.0.0.1' });
let browser;
const errors = [];
const view = page => page.evaluate(() => JSON.parse(window.render_game_to_text()));
const state = async page => (await view(page)).state;
const waitState = async (page, predicate, label) => {
  for (let i = 0; i < 200; i++) {
    const snapshot = await state(page);
    if (snapshot && predicate(snapshot)) return snapshot;
    await page.waitForTimeout(50);
  }
  throw new Error(`Timed out: ${label}`);
};
const shot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)), fullPage: true, animations: 'disabled', timeout: 60000 });
const observe = page => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
};
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  const page = await desktop.newPage();
  observe(page);
  await page.goto(`http://127.0.0.1:${service.port}`);
  await page.click('#quick-btn');
  await page.waitForSelector('#practice-dialog[open]');
  await page.fill('#practice-name', '练习学员');
  await page.selectOption('#practice-opponents', '1');
  await page.selectOption('#practice-style', 'balanced');
  await page.selectOption('#practice-coach-mode', 'auto');
  await shot(page, '01-practice-settings');
  await page.click('#practice-start-btn');
  const initial = await waitState(page, s => s.practice?.enabled && s.legalActions.canAct, 'practice first decision');
  assert.equal(initial.deadline, null);
  await page.waitForFunction(() => document.querySelector('#coach-equity').textContent.includes('%'));
  assert.ok((await page.locator('#coach-reasons').innerText()).length > 20);
  await shot(page, '02-desktop-coach');
  await page.click('#practice-pause-btn');
  await waitState(page, s => s.practice.paused, 'pause');
  assert.equal(await page.locator('#call-btn').isDisabled(), true);
  assert.equal(await page.locator('#fold-btn').isDisabled(), true);
  await page.click('#practice-pause-btn');
  await waitState(page, s => !s.practice.paused, 'resume');
  await page.click('#fold-btn');
  await waitState(page, s => s.training.decisions === 1 && s.phase === 'showdown', 'feedback after fold');
  assert.ok((await page.locator('#practice-feedback').innerText()).length > 10);
  await page.reload();
  await waitState(page, s => s.practice?.enabled && s.training.decisions === 1, 'practice reconnect');
  await page.click('#learning-guide-btn');
  await page.waitForSelector('#learning-dialog[open]');
  assert.match(await page.locator('#learning-dialog').innerText(), /底池|位置/);
  await shot(page, '03-learning-guide');
  await page.keyboard.press('Escape');
  await page.click('#start-btn');
  await waitState(page, s => s.handNumber === 2, 'next practice hand');

  // A controlled, explicitly test-only river fixture makes real solver coverage deterministic.
  const entry = service.rooms.get(initial.code);
  const room = entry.room, hero = room.players.find(p => !p.bot), villain = room.players.find(p => p.bot);
  const card = code => ({ rank: code[0], suit: code[1].toUpperCase(), value: '23456789TJQKA'.indexOf(code[0]) + 2 });
  room.phase = 'river'; room.board = ['Ad', '7c', '2h', '9c', 'Kd'].map(card);
  hero.cards = ['As', 'Ah'].map(card); villain.cards = ['Qs', 'Jh'].map(card);
  for (const player of room.players) {
    player.chips = 1900; player.bet = 0; player.totalBet = 100;
    player.inHand = true; player.folded = false; player.allIn = false;
    player.actedAtBet = null; player.reopenSize = 20; player.lastAction = '';
  }
  room.currentBet = 0; room.minRaise = 20; room.dealerSeat = villain.seat;
  room.actorId = hero.id; room.deadline = Date.now() + 30000; room.result = null;
  entry.practice.untimed = false; room.config.turnSeconds = 30;
  await page.click('#practice-pause-btn');
  await waitState(page, s => s.practice.paused && s.phase === 'river', 'river fixture');
  await page.click('#practice-pause-btn');
  const river = await waitState(page, s => !s.practice.paused && s.phase === 'river', 'river coaching');
  await page.click('#coach-btn');
  await page.waitForFunction(() => document.querySelector('#coach-equity').textContent.includes('%'));
  if (river.practice.solver.available) {
    await page.click('#solver-btn');
    await waitState(page, s => s.practice.solving && s.deadline === null, 'solver clock freeze');
    assert.match(await page.locator('#turn-timer').innerText(), /求解中.*计时暂停/);
    await page.waitForFunction(() => {
      const view = JSON.parse(window.render_game_to_text());
      return view.solver?.strategy?.length || view.solverResult?.strategy?.length || document.querySelector('#solver-status').textContent.includes('求解完成');
    }, null, { timeout: 90000 });
    const solved = await view(page);
    assert.equal(solved.solverResult.supported, true);
    assert.ok(Number.isFinite(solved.solverResult.exploitabilityPercent));
    assert.match(await page.locator('#solver-strategy').innerText(), /exploitability.*收敛.*耗时/);
    await shot(page, '04-real-solver');
  } else {
    assert.match(await page.locator('#solver-status').innerText(), /未安装|不可用|安装/);
  }

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await mobileContext.newPage(); observe(mobile);
  await mobile.goto(`http://127.0.0.1:${service.port}`);
  await mobile.click('#quick-btn');
  await mobile.fill('#practice-name', '移动练习');
  await mobile.selectOption('#practice-opponents', '1');
  await mobile.selectOption('#practice-style', 'aggressive');
  await mobile.selectOption('#practice-coach-mode', 'manual');
  await mobile.click('#practice-start-btn');
  await waitState(mobile, s => s.legalActions.canAct, 'mobile practice');
  assert.equal((await view(mobile)).analysis, null, 'Manual practice waits for the learner to request a hint');
  await mobile.click('#coach-btn');
  await mobile.waitForFunction(() => document.querySelector('#coach-equity').textContent.includes('%'));
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await shot(mobile, '05-mobile-coach');
  await writeFile(new URL('state.json', output), JSON.stringify(await view(page), null, 2));
  assert.deepEqual(errors, []);
  console.log('Practice browser QA passed: settings, coaching, pause/resume, feedback, reconnect, guide, next hand, solver availability/real river solve and mobile layout.');
} finally {
  await browser?.close();
  await service.close();
}
