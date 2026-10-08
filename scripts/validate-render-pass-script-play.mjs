// UnrealScript in the render pass, in Play (docs/render-pass-precision.md
// "UnrealScript in the render pass"): headless Chromium runs Training in the
// default mode (the simulation in the worker; `--query sim=inline` runs it on
// the page), picks up the crowbar through the public Use path and its belt
// slot, then turns the view over some frames. After each frame
// decal-probe.mjs renderPassProbe reads, on the simulation side, the weapon
// that DrawWorld's RenderOverlays placed and evaluates the original
// CalcDrawOffset again in the script VM inside the render pass (precision
// control 24) and on the game thread (64). Checked: every frame's weapon
// Location is the owner's Location plus the 24-bit offset (Weapon.RenderOverlays'
// SetLocation), its Rotation the ViewRotation's pitch and yaw, and the HUD
// scene frame the paint wrote carries ComputeRenderSize's 24-bit projection
// (validate-window-scene-frame checks that against Engine at 0x007f). Reported:
// how many frames the 64-bit offset would have placed differently.
//
//   node scripts/validate-render-pass-script-play.mjs [--url http://...] [--query sim=inline] [--frames 60]
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { gameDirectory } from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-render-pass-script-play: no installed game data'); process.exit(0); }
const frames = Number(option('frames', 60)), f = Math.fround;
let server = null, url = option('url', null);
if (!url) {
  const checkout = fileURLToPath(new URL('..', import.meta.url));
  const { default: base } = await import('../vite.config.mjs');
  // A checkout inside .work/ or .claude/worktrees/ serves itself.
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && checkout.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && checkout.includes('/.claude/worktrees/')));
  server = await createServer({ ...base, configFile: false, root: checkout, logLevel: 'error',
    server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const browser = await chromium.launch({ args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`] });
let report;
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const query = option('query', '');
  await page.goto(`${url}/${query ? `?${query}` : ''}`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, { timeout: 240000 });
  await page.locator('#map').selectOption('00_Training');
  await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === '00_Training'; }, {}, { timeout: 240000 });
  report = await page.evaluate(async frames => {
    const viewer = window.deusExViewer, frame = n => new Promise(resolve => {
      let k = 0; const step = () => (++k >= n ? resolve() : requestAnimationFrame(step)); requestAnimationFrame(step);
    });
    const at = await viewer.renderPassProbe({ locate: 'WeaponCrowbar1' });
    await viewer.placeProbe({ location: [at[0] - 48, at[1], at[2] + 20], lookAt: 'WeaponCrowbar1' });
    await frame(20);
    await viewer.placeProbe({ lookAt: 'WeaponCrowbar1' });
    await frame(10);
    const take = await viewer.renderPassProbe({ take: 'WeaponCrowbar1' });
    await frame(90);
    const records = [];
    for (let k = 0; k < frames; k++) {
      await viewer.placeProbe({ rotation: [(65536 - 1500 + 97 * k) % 65536, (4000 + 1237 * k) % 65536, 0] });
      await frame(2);
      records.push(await viewer.renderPassProbe({}));
    }
    return { take, records, runtimeError: viewer.status().runtimeError?.message ?? null };
  }, frames);
  report.pageErrors = errors;
} finally { await browser.close(); await server?.close(); }

assert.deepEqual(report.pageErrors, []);
assert.equal(report.runtimeError, null);
assert.ok(report.take.equipped, `the crowbar is picked up and selected (${JSON.stringify(report.take)})`);
const stats = { frames: 0, offsetDiffers: 0, placedDiffers64: 0, projection: null };
for (const [k, record] of report.records.entries()) {
  assert.equal(record.weapon, 'WeaponCrowbar1', `frame ${k}: the crowbar is the weapon`);
  stats.frames++;
  const placed24 = record.owner.map((v, i) => f(v + record.offset24[i])), placed64 = record.owner.map((v, i) => f(v + record.offset64[i]));
  assert.deepEqual(record.location, placed24, `frame ${k}: Location is Owner.Location + CalcDrawOffset at 24 bits`);
  if (record.offset24.some((v, i) => !Object.is(v, record.offset64[i]))) stats.offsetDiffers++;
  if (placed24.some((v, i) => !Object.is(v, placed64[i]))) stats.placedDiffers64++;
  assert.deepEqual(record.rotation.slice(0, 2), record.viewRotation.slice(0, 2), `frame ${k}: Rotation follows ViewRotation`);
  assert.ok(record.sceneFrame, `frame ${k}: the HUD paint wrote its scene frame`);
  assert.equal(record.sceneFrame.projectionZ, record.sceneFrame.projection24, `frame ${k}: the HUD frame's projection is ComputeRenderSize at 24 bits`);
  stats.projection = record.sceneFrame;
}
console.log(JSON.stringify(stats));
console.log(`validate-render-pass-script-play: PASS (${stats.frames} frames; the 64-bit CalcDrawOffset differs in ${stats.offsetDiffers} `
  + `and would have placed the crowbar differently in ${stats.placedDiffers64}; HUD projection ${stats.projection.projection24} at 24 bits, `
  + `${stats.projection.projection64} at 64)`);
