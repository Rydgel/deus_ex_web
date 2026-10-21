/**
 * Stage 4: the pawns' third-person weapons on the GPU mesh path against the CPU path, in Play's default worker mode (docs/weapon-attachment.md
 * "GPU path"). The weapon bindings take the GPU path unless `?weapons=cpu` (the CPU path, the reference). Each scene loads the map under a
 * paused Playwright clock (?hold=1&seed=1&antialias=0), steps 16 ms frames and types the scene's console commands at fixed frames, so two runs
 * of a configuration simulate the same frames; the last frame's drawing buffer (a preserved buffer, read back) is compared pixel for pixel:
 *   - a control: the CPU configuration twice (what the scene's own run-to-run difference is, e.g. texture decoding finishing in another frame);
 *   - the GPU configuration against the CPU one. Only the weapons differ between the two, so every pixel they differ in lies in a weapon's
 *     region and the size of the differences is the paths' (the camera-space poses agree to a few ulps and the corner colours to a byte,
 *     validate-gpu-mesh.mjs).
 * Scenes: the Island view of validate-weapon-play (the armed Terrorist22 and ThugMale3 at the right side of the camera) and the MJ12 lab's `jcb`
 * scene (JC in BehindView holding the pistol: his back in the main frame and his reflection in the pane, both drawing it; the pane's child
 * frame lights the weapon with the Mirror its slot forces to 1.0). Each scene also checks that the weapons took the path asked for.
 *
 *   node scripts/validate-weapon-gpu-play.mjs [--url http://127.0.0.1:5173] [--angle gl] [--shots DIR]
 */
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-weapon-gpu-play: no installed game data'); process.exit(0); }
const angle = option('angle', process.platform === 'darwin' ? 'metal' : 'gl');
let server = null, base = option('url', null);
if (!base) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const {default: config} = await import('../vite.config.mjs');
  const deny = config.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
  server = await createServer({...config, configFile: false, root, logLevel: 'error',
    server: {...config.server, port: 0, strictPort: false, fs: {...config.server.fs, deny}, watch: null}});
  await server.listen();
  base = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const INSTALL = new Date('2001-06-23T12:00:00Z').getTime(), START = INSTALL + 3600 * 1000;
const cheat = Array.from({length: 12}, () => 'CheatView DeusEx.Terrorist');
const SCENES = [
  {name: 'Island pistol and crossbow', map: '01_NYC_UNATCOIsland', frames: 240, pawns: ['Terrorist22', 'ThugMale3'], script: new Map([
    [3, [{exec: [...cheat, 'set DeusEx.JCDentonMale ViewRotation (Pitch=-500,Yaw=46936,Roll=0)']}, {playersOnly: false}]]])},
  {name: 'lab mirror (JC in BehindView)', map: '05_NYC_UNATCOMJ12lab', frames: 300, pawns: [/^JCDentonMale/], script: new Map([
    [3, [{location: [-3086.76978, 1400.20129, -155.809525], region: {zone: 'LevelInfo0', iLeaf: 3650, zoneNumber: 7}}, {playersOnly: false}]],
    [20, [{exec: ['summon DeusEx.WeaponPistol']}]], [50, [{rotation: [-10130, 16432, 0]}]], [90, [{exec: ['ParseRightClick']}]],
    [130, [{exec: ['ActivateBelt 1']}]], [170, [{exec: ['BehindView 1']}, {rotation: [-400, 62536, 0]}]]])},
];

async function run(browser, scene, query) {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // the renderer keeps its drawing buffer, so the last frame can be read back (validate-sim-split.mjs)
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch(), text = await response.text(), from = 'antialias: true })';
    if (!text.includes(from)) throw new Error('validate-weapon-gpu-play: the page\'s renderer construction changed');
    await route.fulfill({response, body: text.replace(from, 'antialias: true, preserveDrawingBuffer: true })')});
  });
  await page.addInitScript(() => { try { localStorage.setItem('deusex.uiHidden', '1'); } catch { /* storage unavailable */ } });
  try {
    await page.clock.install({time: INSTALL});
    const target = new URL(base);
    for (const [key, value] of Object.entries({hold: '1', seed: '1', antialias: '0', ...query})) target.searchParams.set(key, value);
    await page.goto(debugUrl(target.href));
    await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
    await page.evaluate(map => { const menu = document.getElementById('map'); menu.value = map; menu.dispatchEvent(new Event('change')); }, scene.map);
    await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map && s.mode === 'play'; }, scene.map, {timeout: 240000});
    await page.clock.pauseAt(START);
    await page.evaluate(() => window.deusExViewer.release());
    for (let frame = 1; frame <= scene.frames; frame++) {
      await page.clock.runFor(16);
      await page.evaluate(() => window.deusExViewer.settled?.());
      for (const call of scene.script.get(frame) ?? []) await page.evaluate(args => window.deusExViewer.viewProbe(args), call);
      const error = await page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null);
      if (error) throw new Error(`runtime error at frame ${frame}: ${error}`);
    }
    const states = await page.evaluate(() => window.deusExViewer.lodProbe({list: 'weapons'}));
    const bindings = await page.evaluate(() => window.deusExViewer.lodProbe({list: true}));
    const frame = await page.evaluate(async () => {
      const canvas = document.getElementById('scene'), gl = canvas.getContext('webgl2');
      const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight, pixels = new Uint8Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let binary = '';
      for (let i = 0; i < pixels.length; i += 0x8000) binary += String.fromCharCode(...pixels.subarray(i, i + 0x8000));
      return {width, height, preserved: gl.getContextAttributes().preserveDrawingBuffer, data: btoa(binary)};
    });
    assert.equal(frame.preserved, true, 'the renderer patch keeps the drawing buffer');
    const weapons = states.filter(s => s.binding !== null && s.why === null && scene.pawns.some(p => p instanceof RegExp ? p.test(s.pawn) : p === s.pawn))
      .map(s => ({pawn: s.pawn, weapon: s.weapon, frames: s.frames, path: bindings.find(b => b.id === s.binding)?.path ?? null}));
    return {pixels: Buffer.from(frame.data, 'base64'), width: frame.width, height: frame.height, weapons, errors};
  } finally { await page.close(); }
}

/** Per-pixel comparison: how many pixels differ, by how much, and where (the bounding box of those over `threshold`). */
function compare(a, b, width, height, threshold = 2) {
  let differing = 0, over = 0, max = 0, sum = 0;
  const box = {x0: width, y0: height, x1: -1, y1: -1};
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (!d) continue;
    differing++; sum += d; max = Math.max(max, d);
    if (d > threshold) {
      over++;
      const p = i / 4, x = p % width, y = Math.floor(p / width);
      box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y); box.x1 = Math.max(box.x1, x); box.y1 = Math.max(box.y1, y);
    }
  }
  return {differing, over, max, mean: differing ? +(sum / differing).toFixed(2) : 0, box: over ? box : null};
}

const browser = await chromium.launch({args: [`--use-angle=${angle}`]});
const report = [];
let failed = false;
try {
  for (const scene of SCENES) {
    const cpu = await run(browser, scene, {weapons: 'cpu'}), again = await run(browser, scene, {weapons: 'cpu'}), gpu = await run(browser, scene, {});
    // without the weapons: what they cover (so the comparison above is of drawn weapons, not of an empty frame)
    const none = await run(browser, scene, {weapons: 'off'});
    const control = compare(cpu.pixels, again.pixels, cpu.width, cpu.height), paths = compare(cpu.pixels, gpu.pixels, cpu.width, cpu.height);
    const covered = compare(cpu.pixels, none.pixels, cpu.width, cpu.height);
    const row = {scene: scene.name, weapons: {cpu: cpu.weapons, gpu: gpu.weapons}, control, gpuAgainstCpu: paths, weaponsAgainstNone: covered,
      errors: [...cpu.errors, ...again.errors, ...gpu.errors, ...none.errors]};
    report.push(row);
    const failures = [];
    if (!cpu.weapons.length) failures.push('no weapon drawn');
    if (!cpu.weapons.every(w => w.path === 'cpu')) failures.push('?weapons=cpu: a weapon is not on the CPU path');
    if (!gpu.weapons.length || !gpu.weapons.every(w => w.path === 'gpu')) failures.push('the weapons are not on the GPU path');
    if (row.errors.length) failures.push(`page errors ${row.errors[0]}`);
    if (covered.over < 30) failures.push(`the weapons cover only ${covered.over} pixels (a frame without them differs from the CPU one by that many): the comparison would not see them`);
    // The control sets the floor: what the same configuration differs by with itself. The paths may differ by a byte where the corner
    // colours round differently, and nowhere else by more than the control.
    if (paths.max > Math.max(control.max, 0) + 8) failures.push(`the paths differ by up to ${paths.max} levels (control ${control.max})`);
    if (paths.over > control.over + 40) failures.push(`${paths.over} pixels differ by more than 2 levels (control ${control.over})`);
    if (failures.length) { failed = true; console.log(`FAIL ${scene.name}: ${failures.join('; ')}`); }
    if (option('shots', null)) {
      const {writeFileSync} = await import('node:fs');
      for (const [tag, run] of [['cpu', cpu], ['gpu', gpu]]) writeFileSync(`${option('shots', null)}/${scene.map}-${tag}.rgba`, run.pixels);
    }
  }
} finally { await browser.close(); await server?.close(); }
console.log(JSON.stringify(report, null, 1));
console.log(failed ? 'validate-weapon-gpu-play: FAIL' : 'validate-weapon-gpu-play: PASS');
process.exit(failed ? 1 : 0);
