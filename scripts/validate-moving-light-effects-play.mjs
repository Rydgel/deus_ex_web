/** Time-varying moving lights in Play (docs/dynamic-lighting.md
 * "Time-varying moving lights"), in the browser's default worker mode:
 * on 01_NYC_UNATCOIsland the player looks at BarrelFire3 (Steady FireWaver,
 * a map-placed class 2 light). Each captured frame takes the page's light
 * frame (the noise the simulation advanced at PreRender from the game's
 * shared appFrand stream, and Level.TimeSeconds) and the light maps the
 * frame composed with a BarrelFire's contribution; native-dynamic-light-
 * oracle.py `movingFrames` recomputes them from the same inputs
 * (moving-light-chain.mjs), and every composed texel must match. The fire
 * light maps must change from one captured frame to the next, and no
 * runtime or page error may occur.
 *
 *   node scripts/validate-moving-light-effects-play.mjs [--url http://...] [--query sim=inline] [--captures N] [--at x,y,z]
 */
import { auditAssert } from './precision-audit.mjs';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { gameDirectory } from './game-directory.mjs';
import { frameData, runChain, checkFrame } from './moving-light-chain.mjs';
import { debugUrl } from './page-url.mjs';

const assert = auditAssert();
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-moving-light-effects-play: no installed game data'); process.exit(0); }
const map = '01_NYC_UNATCOIsland', query = option('query', ''), captures = Number(option('captures', 3));
let server = null, url = option('url', null);
if (!url) {
  const tree = fileURLToPath(new URL('..', import.meta.url));
  const { default: base } = await import('../vite.config.mjs');
  // The tree may itself sit in .work/ or .claude/worktrees/, which the config denies.
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && tree.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && tree.includes('/.claude/worktrees/')));
  server = await createServer({ ...base, configFile: false, root: tree, logLevel: 'error',
    server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const browser = await chromium.launch({ args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`] });
let report;
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) + '\nwindow.__deusMoving={get world(){return world;}};\n' });
  });
  await page.goto(debugUrl(`${url.replace(/\/$/, '')}/${query ? `?${query}` : ''}`));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, { timeout: 240000 });
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, { timeout: 240000 });
  const at = option('at', '2150,-1950,-40').split(',').map(Number);
  await page.evaluate(at => window.deusExViewer.placeProbe({ location: at, lookAt: 'BarrelFire3' }), at);
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  await frames(90);
  report = { captures: [], pageErrors: errors };
  for (let c = 0; c < captures; c++) {
    await frames(2);
    // One synchronous read between frames: the light frame and the light
    // maps it composed that a BarrelFire reaches.
    report.captures.push(await page.evaluate(() => {
      const world = window.__deusMoving.world, inputs = world.lightFrameInputs();
      const records = world.movingLightRecords().filter(r => r.movingFrame === inputs.frameIndex
        && r.moving?.some(entry => /^BarrelFire\d+$/.test(entry.item.name)));
      const lights = new Map();
      const plain = records.map(record => ({
        surfaceIndex: record.surfaceIndex, width: record.width, pixels: Array.from(record.pixels), staticPixels: Array.from(record.staticPixels),
        movingOffset: record.movingOffset, movingGeometry: { facet: record.movingGeometry.facet },
        moving: record.moving.map(entry => {
          const { item } = entry;
          if (!lights.has(item.name)) lights.set(item.name, { name: item.name, values: item.values, location: item.location,
            flickerKey: item.flickerKey, levelBrightness: item.levelBrightness });
          return { item: { name: item.name, constants: { radius: item.constants.radius, rradius: item.constants.rradius, rr2: item.constants.rr2 } },
            rect: entry.rect, grid: entry.grid, incidence: entry.incidence, spatial: entry.spatial ? Array.from(entry.spatial) : null };
        }),
      }));
      return { inputs, lights: [...lights.values()], records: plain, runtimeError: window.deusExViewer.status().runtimeError?.message ?? null };
    }));
  }
} finally { await browser.close(); await server?.close(); }

assert.deepEqual(report.pageErrors, [], 'no page error');
const datas = report.captures.map(capture => {
  assert.equal(capture.runtimeError, null, 'no runtime error');
  assert.equal(capture.inputs.simFed, true, 'the page takes the simulation\'s light noise');
  assert.ok(capture.records.length > 0, 'the frame composed light maps a BarrelFire reaches');
  const records = capture.records.map(record => ({ ...record, moving: record.moving.map(entry => ({ ...entry,
    spatial: entry.spatial && Uint8Array.from(entry.spatial) })) }));
  return frameData({ time: capture.inputs.timeSeconds, A: capture.inputs.A, W: capture.inputs.W, lights: capture.lights, records });
});
const stats = { captures: datas.length, lights: 0, contributions: 0, texels: 0, lit: 0, maps: 0, byPair: {} };
// Each capture is an independent frame: its own strobe state is not chained
// (Island's class 2 lights are steady).
datas.forEach((frame, i) => {
  const native = runChain(root, { levelBrightness: report.captures[i].lights[0].levelBrightness, frames: [frame] });
  checkFrame(frame, native.frames[0], assert, stats, `capture ${i} `);
});
const changed = datas.slice(1).filter((frame, i) => frame.records.some(record => {
  const previous = datas[i].records.find(p => p.surfaceIndex === record.surfaceIndex && p.width === record.width);
  return previous && !Buffer.from(previous.pixels.buffer).equals(Buffer.from(record.pixels.buffer));
})).length;
assert.equal(changed, datas.length - 1, 'the fire light maps change from one captured frame to the next');
assert.ok(datas.every((frame, i) => i === 0 || frame.time !== datas[i - 1].time), 'each capture is a new frame');
console.log(JSON.stringify({ ...stats, changed, times: report.captures.map(c => c.inputs.timeSeconds) }));
if (assert.enabled) assert.report('validate-moving-light-effects-play');
else console.log(`validate-moving-light-effects-play: PASS (${stats.maps} light maps over ${stats.captures} frames, ${stats.lit} lit texels)`);
