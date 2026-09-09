import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, writeFile, cp, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gameDirectory } from '../scripts/game-directory.mjs';

const state = page => page.evaluate(() => window.deusExViewer.status());
const ready = page => page.waitForFunction(() => window.deusExViewer?.status().ready);
const errors = page => { const list = []; page.on('pageerror', e => list.push(e.message)); page.on('console', m => { if (m.type() === 'error') list.push(m.text()); }); return list; };

test('original training map renders with textures and interactive inspection controls', async ({ page }) => {
  const failures = errors(page);
  await page.goto('http://127.0.0.1:5173'); await ready(page);
  await page.getByRole('combobox', { name: 'Movement mode' }).selectOption('inspect');
  await page.getByRole('button', { name: 'Player start', exact: true }).click();
  const initial = await state(page);
  expect(initial).toMatchObject({ map: '00_Training', textures: 70, movers: 25, triangles: 24427, renderErrors: [], cameraMoved: false });
  expect(initial.calls).toBeGreaterThan(0);
  await mkdir('reports/browser', { recursive: true });
  await page.screenshot({ path: 'reports/browser/training-start.png' });
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await page.getByLabel('Inspect surface under crosshair').check();
  await expect(page.locator('#surface-info')).toContainText('UNATCO');
  await page.getByLabel('Wireframe', { exact: true }).check();
  await page.getByLabel('Actor positions', { exact: true }).check();
  expect(await state(page)).toMatchObject({ wireframe: true, actorMarkers: true });
  await page.screenshot({ path: 'reports/browser/training-diagnostics.png' });
  await page.getByLabel('Wireframe', { exact: true }).uncheck();
  await page.getByLabel('Actor positions', { exact: true }).uncheck();
  await page.getByLabel('Close diagnostics', { exact: true }).click();
  await page.locator('#scene').click({ position: { x: 450, y: 400 } });
  await page.keyboard.down('KeyW'); await page.waitForTimeout(1300); await page.keyboard.up('KeyW');
  const moved = await state(page);
  expect(moved.position[0]).toBeGreaterThan(initial.position[0] + 100);
  await page.mouse.move(450, 400); await page.mouse.down(); await page.mouse.move(580, 430, { steps: 8 }); await page.mouse.up();
  expect((await state(page)).rotation).not.toEqual(initial.rotation);
  await page.screenshot({ path: 'reports/browser/training-camera.png' });
  await page.getByRole('button', { name: 'Player start', exact: true }).click();
  expect((await state(page)).position).toEqual(initial.position);
  await page.getByRole('combobox', { name: 'Map', exact: true }).selectOption('00_TrainingCombat'); await ready(page);
  expect((await state(page)).map).toBe('00_TrainingCombat');
  await page.getByRole('combobox', { name: 'Map', exact: true }).selectOption('00_Training'); await ready(page);
  expect(await state(page)).toMatchObject({ revision: 3, renderErrors: [], textures: 70 });
  expect(failures).toEqual([]);
});

test('production opens local File objects, reports missing packages, and sends no game data', async ({ page }) => {
  const failures = errors(page), requests = [];
  page.on('request', r => requests.push({ method: r.method(), url: r.url() }));
  await page.goto('http://127.0.0.1:5174');
  await expect(page.getByRole('heading', { name: 'Open your Deus Ex installation' })).toBeVisible();
  await page.setViewportSize({ width: 820, height: 900 });
  await expect(page.getByRole('button', { name: 'Choose game folder', exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'reports/browser/local-folder-picker.png' });
  await page.setViewportSize({ width: 1440, height: 960 });
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'deus-ex-viewer-'));
  try {
    await writeFile(path.join(tmp, '00_Training.dx'), 'invalid package');
    await page.locator('#folder').setInputFiles(tmp);
    await expect(page.locator('#gate-message')).toContainText(/Not an Unreal package|Truncated/);
    await cp(path.join(gameDirectory(), 'Maps/00_Training.dx'), path.join(tmp, '00_Training.dx'));
    await page.locator('#folder').setInputFiles(tmp);
    await expect(page.locator('#gate-message')).toContainText('Missing package');
    const beforeFiles = requests.length;
    await page.locator('#folder').setInputFiles(gameDirectory()); await ready(page);
    expect(await state(page)).toMatchObject({ map: '00_Training', renderErrors: [], triangles: 24427 });
    await expect(page.locator('#toast')).toBeEmpty();
    expect(requests.slice(beforeFiles)).toEqual([]);
    expect(requests.every(r => r.method === 'GET' && new URL(r.url).origin === 'http://127.0.0.1:5174')).toBe(true);
    await page.screenshot({ path: 'reports/browser/production-training.png' });
    expect(failures).toEqual([]);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});


test('optional browser tool handlers validate inputs and reflect visible map state', async ({ page }) => {
  // Contract test of the actual registrations, with a mock capability; not evidence of native browser support.
  await page.addInitScript(() => {
    window.registeredTools = {};
    Object.defineProperty(document, 'modelContext', { configurable: true, value: { registerTool: tool => { window.registeredTools[tool.name] = tool; } } });
  });
  await page.goto('http://127.0.0.1:5173'); await ready(page);
  await page.waitForFunction(() => Object.keys(window.registeredTools).length === 4);
  expect(await page.evaluate(() => window.registeredTools.read_map_status.execute({}))).toMatchObject({ ready: true, map: '00_Training' });
  for (const [name, input] of [['read_map_status', { extra: 1 }], ['open_local_map', {}], ['open_local_map', { name: 'missing' }], ['reset_inspection_camera', []], ['set_inspection_camera', { position: [0, 0], rotation: [0, 0, 0] }]]) {
    const result = await page.evaluate(async ({ name, input }) => { try { await window.registeredTools[name].execute(input); return 'unexpected success'; } catch (e) { return e.message; } }, { name, input });
    expect(result).not.toBe('unexpected success');
  }
  const opened = await page.evaluate(() => window.registeredTools.open_local_map.execute({ name: '00_Training' }));
  expect(opened).toMatchObject({ ready: true, revision: 2, map: '00_Training' });
  expect(await page.evaluate(() => window.registeredTools.reset_inspection_camera.execute({}))).toMatchObject({ cameraMoved: false });
});

test('dev endpoint exposes only listed packages; production output contains code only', async ({ request }) => {
  for (const suffix of ['System%2FDeusEx.exe', '..%2Fpackage.json', 'Maps%2F..%2FSystem%2FDeusEx.ini']) {
    expect((await request.get(`http://127.0.0.1:5173/__game__/file/${suffix}`)).status()).toBe(404);
  }
  expect((await request.get('http://127.0.0.1:5173/__game__/manifest', { headers: { 'sec-fetch-site': 'cross-site' } })).status()).toBe(403);
  expect((await request.post('http://127.0.0.1:5173/__game__/manifest')).status()).toBe(403);
  expect((await request.get('http://127.0.0.1:5173/Deus%20Ex%20GOTY%20Edition/System/DeusEx.ini')).status()).toBe(403);
  const files = await readdir('dist', { recursive: true });
  expect(files.some(p => /\.(dx|utx|u|uax|umx|unr|exe|dll)$/i.test(p))).toBe(false);
  expect(files).toContain('index.html');
});
