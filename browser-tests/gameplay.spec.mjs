import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { BASE } from './browsers.mjs';
test.use({ viewport: { width: 960, height: 640 } });

const status = page => page.evaluate(() => window.deusExViewer.status());
const player = async page => (await status(page)).gameplay.player;
// Worker mode: the first grounded status can be the spawn a tick before the walk lifts the player onto the floor (z -82.50, then
// -80.20), and status() carries the game status of every 15th post. Settled is the simulation's own location (viewProbe), unchanged
// over a poll, and status() showing it.
const settled = async page => {
  await page.waitForFunction(() => window.deusExViewer?.status().ready && window.deusExViewer.status().gameplay?.player.grounded);
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-4);
  let last = null;
  await expect.poll(async () => {
    const [location, shown] = await page.evaluate(async () => [(await window.deusExViewer.viewProbe({})).location, window.deusExViewer.status().gameplay.player.position]);
    const still = last !== null && same(location, last); last = location;
    return still && same(shown, location);
  }, { timeout: 20000 }).toBe(true);
};

test('training plays with gravity, stances, blocked doors, linked use, stairs and a reproducible reload', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${BASE}/?debug=1`); await settled(page);
  await mkdir('reports/movement/browser', { recursive: true });
  const initial = await player(page);
  expect(await status(page)).toMatchObject({ mode: 'play', renderErrors: [],
    npcPreview:{poseBackend:'rust-wasm',kernelError:null},gameplay: { hulls: 3183, blockingActors: 55 } });
  expect(initial).toMatchObject({ radius: 20, height: 43, grounded: true });
  await page.locator('#scene').click({ position: { x: 500, y: 350 } });
  await page.keyboard.down('KeyX');   // DefUser.ini: X=Duck (Ctrl is unbound)
  await expect.poll(async () => (await player(page)).height).toBe(16);
  const crouched = await player(page);
  expect(crouched.position[2] - crouched.height).toBeCloseTo(initial.position[2] - initial.height, 2);
  await page.keyboard.up('KeyX'); await expect.poll(async () => (await player(page)).height).toBe(43);
  await expect.poll(async () => (await player(page)).crouched).toBe(false);
  // Jump is a press (exec Jump sets bPressedJump once) and the original drops one pressed while the player still crouches: let the stand end
  await page.waitForTimeout(300);
  await page.keyboard.down('Space');
  await expect.poll(async () => (await player(page)).position[2]).toBeGreaterThan(initial.position[2] + 20);
  await page.keyboard.up('Space'); await settled(page);
  // the rise above is the jump: the original's DoJump runs in script (the status `jumps` counter belonged to the retired JavaScript movement)
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await player(page)).position[0], { timeout: 20000 }).toBeGreaterThan(-242.5);
  await page.waitForTimeout(350); await page.keyboard.up('KeyW');
  const stopped = await player(page); expect(stopped.position[0]).toBeLessThan(-242);
  // (the page's old 'Open door' hint is gone: the original HUD names the frob target in the picture; the door opening below is the check)
  await page.screenshot({ path: 'reports/movement/browser/door-closed.png' });
  // DefUser.ini: RightMouse=ParseRightClick, the use (F is CenterView)
  await page.locator('#scene').click({ position: { x: 500, y: 350 }, button: 'right' });
  await expect.poll(async () => (await status(page)).gameplay.doors.movers.find(m => m.name === 'DeusExMover16').alpha, { timeout: 5000 }).toBe(1);
  const panels = (await status(page)).gameplay.doors.movers.filter(m => m.tag === 'UN_maindoor');
  expect(panels.map(m => m.offset[1])).toEqual([-56, 56]);
  await page.screenshot({ path: 'reports/movement/browser/door-open.png' });
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await player(page)).position[0]).toBeGreaterThan(100);
  await page.keyboard.up('KeyW'); await page.waitForTimeout(450);
  expect((await player(page)).position[2]).toBeLessThan(initial.position[2] - 40);
  await page.keyboard.down('KeyS');
  const returnWalk = [];
  try {
    // Slow rendered frames can hit the original 0.4-second time ceiling.
    // Keep the position/floor requirements and allow the browser time to reach them.
    await expect.poll(async () => {
      const state = await status(page);
      returnWalk.push({ time: Date.now(), frame: state.frame, player: state.gameplay.player });
      return state.gameplay.player.position[0];
    }, { timeout: 20000 }).toBeLessThan(-320);
  } finally {
    await writeFile('reports/movement/browser/return-walk.json', JSON.stringify(returnWalk, null, 2));
  }
  await page.keyboard.up('KeyS'); await page.waitForTimeout(450);
  const returned = await player(page);
  expect(returned.position[2]).toBeGreaterThanOrEqual(-80.4);
  expect(returned.position[2]).toBeLessThanOrEqual(-79.9);
  await page.reload(); await settled(page);
  expect((await player(page)).position).toEqual(initial.position);
  expect((await status(page)).gameplay.doors.uses).toBe(0);
  expect((await status(page)).gameplay.doors.movers.every(m => m.alpha === 0)).toBe(true);
  expect(errors).toEqual([]);
});

test('Liberty Island has a valid playable spawn and the inspection camera leaves player state intact', async ({ page }) => {
  await page.goto(`${BASE}/?debug=1`); await settled(page);
  await page.getByRole('combobox', { name: 'Map', exact: true }).selectOption('01_NYC_UNATCOIsland'); await settled(page);
  expect(await status(page)).toMatchObject({ mode: 'play', map: '01_NYC_UNATCOIsland' });
  const initial = await player(page);
  await page.locator('#scene').click({ position: { x: 500, y: 350 } });
  await page.keyboard.down('KeyW'); await page.waitForTimeout(500); await page.keyboard.up('KeyW'); await page.waitForTimeout(500);
  const walked = await player(page); expect(walked.position).not.toEqual(initial.position);
  expect(walked.grounded).toBe(true);
  await page.getByRole('combobox', { name: 'Movement mode' }).selectOption('inspect');
  const frozen = await player(page);
  await page.locator('#scene').click({ position: { x: 500, y: 350 } });
  await page.keyboard.down('KeyE'); await page.waitForTimeout(300); await page.keyboard.up('KeyE');
  expect((await player(page)).position).toEqual(frozen.position);
  await page.getByRole('combobox', { name: 'Movement mode' }).selectOption('play');
  // The player may resume its remaining deceleration on the next animation frame.
  const resumed = await status(page);
  for (let i = 0; i < 3; i++) expect(resumed.position[i]).toBeCloseTo(resumed.gameplay.player.eye[i], 5);
  await page.screenshot({ path: 'reports/movement/browser/liberty-island.png' });
});
