import { test, expect } from '@playwright/test';
import { chromiumChannel } from './browsers.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readBindingRows, runBoundaryCases, runInputBindings, runWindowCases } from '../scripts/input-binding-cases.mjs';

// Every [Engine.Input] binding of User.ini, pressed through the page (docs/input-bindings.md "The table"): real keyboard, mouse-button,
// pointer-motion and wheel events in Chromium's new headless mode (no window on the desktop), the simulation in its worker. The cases
// are scripts/input-binding-cases.mjs, which scripts/validate-input-bindings.mjs runs on a headless game without the page; this
// run's rows are the table of the doc. The page is the worktree's own vite server:
//   DX_BASE_URL=http://127.0.0.1:5191 npx playwright test -c .work/playwright.dev.config.mjs browser-tests/input-bindings-table.spec.mjs
// The rows go to DX_TABLE_OUT (default test-results/input-bindings-table.json).
test.use({ ...chromiumChannel, headless: true, viewport: { width: 1280, height: 800 } });
const BASE = process.env.DX_BASE_URL ?? 'http://127.0.0.1:5173';

test('every User.ini binding runs in Play when its key, button or wheel is pressed in the page', async ({ page }) => {
  test.setTimeout(1_500_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${BASE}/?debug=1`);
  await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === '00_Training' && !s.runtimeError; }, null, { timeout: 240_000 });
  const box = await page.locator('#scene').boundingBox();
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const pointer = { x: center.x, y: center.y };
  await page.mouse.move(center.x, center.y);
  // The pointer lock a player takes (a double click): relative motion, and the wheel and buttons go to the locked canvas.
  await page.mouse.dblclick(center.x, center.y);
  await expect.poll(() => page.evaluate(() => document.pointerLockElement?.id ?? null)).toBe('scene');
  await page.evaluate(() => window.deusExViewer.inputProbe({ op: 'state' }));   // empties the command log

  const MOUSE = { LeftMouse: 'left', MiddleMouse: 'middle', RightMouse: 'right' };
  const wait = ms => page.waitForTimeout(ms);
  const env = {
    // (Playwright's keyboard has no F13 to F24: those rows say so)
    key: async (code, { hold = 60 } = {}) => {
      try { await page.keyboard.down(code); } catch (error) { return { error: error.message.split('\n')[0] }; }
      await wait(hold); await page.keyboard.up(code); await wait(40); return { error: null };
    },
    down: code => page.keyboard.down(code),
    up: code => page.keyboard.up(code),
    button: async (name, { hold = 60 } = {}) => { await page.mouse.down({ button: MOUSE[name] }); await wait(hold); await page.mouse.up({ button: MOUSE[name] }); await wait(40); },
    buttonDown: name => page.mouse.down({ button: MOUSE[name] }),
    buttonUp: name => page.mouse.up({ button: MOUSE[name] }),
    wheel: async notches => { await page.mouse.wheel(0, -notches * 100); await wait(60); },
    look: async (dx, dy) => {
      // Chromium drops the first motion under a new lock; the page drops it too (main.mjs lockMoveDropped)
      await page.mouse.move(pointer.x + 1, pointer.y + 1); pointer.x += 1; pointer.y += 1;
      await page.mouse.move(pointer.x + dx, pointer.y + dy, { steps: 6 }); pointer.x += dx; pointer.y += dy;
    },
    pointerTo: async ({ x, y }) => {
      // a window's cursor follows the absolute pointer once the lock is released (a window under the lock gets relative motion)
      if (await page.evaluate(() => Boolean(document.pointerLockElement))) { await page.evaluate(() => window.deusExViewer.releasePointer()); await wait(300); }
      const buffer = await page.evaluate(() => { const canvas = document.querySelector('#scene'); return { w: canvas.width, h: canvas.height }; });
      const rect = await page.locator('#scene').boundingBox();
      const px = rect.x + x * rect.width / buffer.w, py = rect.y + y * rect.height / buffer.h;
      await page.mouse.move(px - 8, py - 4); await wait(100);
      await page.mouse.move(px, py); await wait(200);
      pointer.x = px; pointer.y = py;
    },
    wait,
    now: () => Date.now(),
    probe: args => page.evaluate(args => window.deusExViewer.inputProbe(args), args),
    state: () => page.evaluate(() => window.deusExViewer.inputProbe({ op: 'state', clear: true })),
    exec: lines => page.evaluate(lines => window.deusExViewer.viewProbe({ exec: lines }), lines),
    place: args => page.evaluate(args => window.deusExViewer.placeProbe(args), args),
    settings: step => page.evaluate(step => window.deusExViewer.settingsProbe(step), step),
    error: () => page.evaluate(() => [window.deusExViewer.status().runtimeError?.message, document.getElementById('toast').textContent].filter(Boolean).join(' | ') || null),
  };

  const table = await readBindingRows();
  const results = await runInputBindings(env, table);
  await runWindowCases(env, table, results);
  await runBoundaryCases(env, table, results);

  const rows = table.rows.map(row => ({ key: row.key, binding: row.binding, ini: row.ini, scriptBound: row.scriptBound, joy: row.joy, codes: row.codes, ...results.get(row.key) }));
  for (const row of rows) {
    if (row.joy || !row.binding) continue;
    expect(row.status, `${row.key}=${row.binding} has a case`).toBeTruthy();
    expect(row.reached, `${row.key}=${row.binding} ran its binding`).not.toBe(false);
  }
  const out = process.env.DX_TABLE_OUT ?? 'test-results/input-bindings-table.json';
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(rows, null, 1));
  const bound = rows.filter(row => row.binding && !row.joy);
  console.log(`${rows.length} keys in [Engine.Input]: ${bound.length} bound, ${bound.filter(row => row.status === 'ok').length} with an effect checked, ${bound.filter(row => row.status === 'boundary').length} stop at a later stage's system`);
  expect(errors).toEqual([]);
});
