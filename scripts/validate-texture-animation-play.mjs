// Animated BSP textures in the browser (docs/texture-animation.md): Training's
// animated surface textures (UTexture AnimNext chains) advance through
// texture-animation.mjs (validate-native-texture-animation) once per drawn
// frame. In headless Chromium this samples every animated head over a few
// seconds and checks that each advances, only along its own AnimNext chain,
// and that every material using it draws the shown frame's texture. The
// auto-panned surfaces' offsets must be surfacePan's for the pan inputs the
// simulation sent with the frame (sim-session.mjs frame.pan: TimeSeconds and
// the zones' live speeds). The simulation runs in the worker by default
// (`--query sim=inline` runs it on the page).
//
//   node scripts/validate-texture-animation-play.mjs [--url http://...] [--map MAP] [--query sim=inline]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-texture-animation-play: no installed game data'); process.exit(0); }
let server = null, url = option('url', null);
if (!url) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const {default: base} = await import('../vite.config.mjs');
  // The tree may itself sit in .work/ or .claude/worktrees/, which the config denies.
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
  server = await createServer({...base, configFile: false, root, logLevel: 'error',
    server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const hook = `\nwindow.__deusTextureAnimation={get world(){return world;},get camera(){return camera;}};\n`;
// The frame's pan inputs as the page receives them (main.mjs drawFrame).
const PAN_INPUTS = 'panInputs = { timeSeconds: pan.timeSeconds, zoneSpeeds: name => pan.speeds[name] };';
const map = option('map', '00_Training'), query = option('query', '');
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
let report;
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    const body = await response.text();
    if (!body.includes(PAN_INPUTS)) throw new Error('main.mjs no longer builds the frame pan inputs as expected');
    await route.fulfill({response, body: body.replace(PAN_INPUTS, `${PAN_INPUTS} window.__deusPan = pan;`) + hook});
  });
  await page.goto(debugUrl(`${url.replace(/\/$/, '')}/${query ? `?${query}` : ''}`));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  if (map !== '00_Training') {
    await page.locator('#map').selectOption(map);
    await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 240000});
  }
  report = await page.evaluate(async () => {
    const world = window.__deusTextureAnimation.world;
    const materials = [...world.materials.values()].filter(m => m.userData.animated).length;
    const samples = new Map();
    let undrawn = 0;
    const start = performance.now();
    while (performance.now() - start < 4000) {
      for (const entry of world.animatedTextures()) {
        const record = samples.get(entry.key) ?? {chain: entry.chain, wrap: entry.wrap, frames: []};
        samples.set(entry.key, record);
        if (record.frames.at(-1) !== entry.frame) record.frames.push(entry.frame);
        if (entry.frame && !entry.drawn) undrawn++;
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return {materials, undrawn, heads: [...samples].map(([key, record]) => ({key, ...record})),
      notes: world.notes.filter(note => /animat/i.test(note))};
  });
  // Auto-pan: each panned group's offset is Render.dll's surfacePan for the
  // frame's TimeSeconds and the viewer-side zone's speeds, over the drawn UVs.
  report.pan = await page.evaluate(async () => {
    const {surfacePan} = await import('/src/runtime/texture-animation.mjs');
    const {fromView} = await import('/src/unreal/geometry.mjs');
    const v = window.__deusTextureAnimation, out = [];
    for (let k = 0; k < 3; k++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const inputs = window.__deusPan, viewpoint = fromView(v.camera.position.toArray());
      for (const entry of v.world.pannedSurfaces()) {
        const side = entry.plane[0] * viewpoint[0] + entry.plane[1] * viewpoint[1] + entry.plane[2] * viewpoint[2] - entry.plane[3] > 0 ? 1 : 0;
        const name = entry.zones[side], speeds = (name && inputs.speeds[name]) ?? entry.speeds[side];
        const pan = surfacePan({panU: entry.pan[0], panV: entry.pan[1], flags: entry.flags, speedU: Math.fround(speeds[0]),
          speedV: Math.fround(speeds[1]), timeSeconds: Math.fround(inputs.timeSeconds)});
        out.push({time: inputs.timeSeconds, zone: name, offset: entry.offset,
          expected: [(pan.u - entry.pan[0]) / entry.width, (pan.v - entry.pan[1]) / entry.height]});
      }
    }
    return out;
  });
  report.pageErrors = errors;
  report.status = await page.evaluate(() => window.deusExViewer.status().runtimeError ?? null);
} finally { await browser.close(); await server?.close(); }
console.log(JSON.stringify({...report, heads: report.heads.map(head => ({key: head.key, frames: head.frames.length}))}, null, 1));
assert.deepEqual(report.pageErrors, []);
assert.ok(report.materials > 0, `${map} has animated surface materials`);
// Each sample reads the world after a frame's update and the level time the
// same frame used (the level ticks only inside that frame's update).
for (const sample of report.pan) assert.deepEqual(sample.offset, sample.expected, `pan at ${sample.time} in ${sample.zone}`);
assert.ok(report.pan.every(sample => sample.time > 0), 'the frames carry a running TimeSeconds');
assert.equal(report.undrawn, 0, 'every material draws its head\'s shown frame');
for (const head of report.heads) {
  const frames = head.frames.filter(Boolean);
  assert.ok(frames.length > 2, `${head.key} advances (${frames.join(' > ')})`);
  // One ConstantTimeTick per Update outside priming: each change is the next
  // AnimNext link (ending on the head when AnimNext is None).
  const next = key => { const i = head.chain.indexOf(key); return head.chain[i + 1] ?? head.wrap; };
  for (let i = 1; i < frames.length; i++)
    assert.equal(frames[i], next(frames[i - 1]), `${head.key}: ${frames[i - 1]} -> ${frames[i]} follows AnimNext`);
}
console.log(`validate-texture-animation-play: PASS (${map}: ${report.heads.length} animated heads, ${report.materials} materials, ${report.pan.length} pan samples)`);
