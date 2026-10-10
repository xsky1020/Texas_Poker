import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../server.js';

const output = new URL('../output/seating/', import.meta.url);
await mkdir(output, { recursive: true });
const service = await startServer({ port: 0, host: '127.0.0.1' });
let browser;
const errors = [];
const measurements = {};
try {
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${service.port}`);
  await page.waitForFunction(() => typeof window.render_game_to_text === 'function');
  await page.click('#create-btn');
  await page.fill('#player-name', '房主');
  await page.selectOption('[name="maxPlayers"]', '9');
  await page.click('#submit-room-btn');
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).state?.players.length === 1);
  for (let count = 2; count <= 9; count += 1) {
    await page.click('#add-bot-btn');
    await page.waitForFunction(expected => JSON.parse(window.render_game_to_text()).state?.players.length === expected, count);
  }
  await page.click('#start-btn');
  await page.waitForFunction(() => {
    const state = JSON.parse(window.render_game_to_text()).state;
    return state?.phase === 'preflop' && state.players.length === 9;
  });
  const inspect = () => ({
    viewport: { width: innerWidth, height: innerHeight },
    document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    overflowX: document.documentElement.scrollWidth > innerWidth,
    phase: JSON.parse(window.render_game_to_text()).state.phase,
    seats: [...document.querySelectorAll('#seats .seat')].map(seat => {
      const rect = seat.getBoundingClientRect();
      return {
        text: seat.innerText, left: rect.left, right: rect.right,
        top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
      };
    }),
  });
  await page.screenshot({ path: fileURLToPath(new URL('desktop-nine.png', output)), fullPage: true });
  measurements.desktop = await page.evaluate(inspect);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: fileURLToPath(new URL('mobile-nine.png', output)), fullPage: true });
  measurements.mobile = await page.evaluate(inspect);
  await writeFile(new URL('measurements.json', output), JSON.stringify({ measurements, errors }, null, 2));
  assert.equal(measurements.desktop.overflowX, false, 'Desktop horizontal overflow');
  assert.equal(measurements.mobile.overflowX, false, 'Mobile horizontal overflow');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({
    desktop: { viewport: measurements.desktop.viewport, document: measurements.desktop.document, overflowX: measurements.desktop.overflowX },
    mobile: { viewport: measurements.mobile.viewport, document: measurements.mobile.document, overflowX: measurements.mobile.overflowX },
    errors,
    screenshots: ['output/seating/desktop-nine.png', 'output/seating/mobile-nine.png'],
  }, null, 2));
} finally {
  await browser?.close();
  await service.close();
}
