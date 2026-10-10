import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startServer } from '../server.js';
const service = await startServer({ port: 0, host: '127.0.0.1' });
let browser;
const errors = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : {}) });
  const context = await browser.newContext();
  const first = await context.newPage();
  const observe = page => page.on('pageerror', error => errors.push(error.message));
  observe(first);
  const url = `http://127.0.0.1:${service.port}`;
  await first.goto(url);
  await first.click('#quick-btn');
  await first.waitForFunction(() => JSON.parse(window.render_game_to_text()).state?.phase === 'preflop');
  const second = await context.newPage();
  observe(second);
  await second.goto(url);
  await second.waitForFunction(() => {
    const view = JSON.parse(window.render_game_to_text());
    return view.connected && view.me && view.state?.phase === 'preflop';
  });
  await first.waitForFunction(() => !JSON.parse(window.render_game_to_text()).connected);
  await second.waitForTimeout(3000); // A superseded tab must not fight to resume again.
  assert.equal(await second.evaluate(() => JSON.parse(window.render_game_to_text()).connected), true);
  assert.equal(await first.evaluate(() => JSON.parse(window.render_game_to_text()).connected), false);
  await first.setViewportSize({ width: 100, height: 500 });
  await first.waitForTimeout(200);
  assert.deepEqual(errors, []);
  console.log('Duplicate-tab reconnect stays stable; tiny viewport has no canvas errors.');
} finally {
  await browser?.close();
  await service.close();
}
