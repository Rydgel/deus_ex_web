// Mesh lighting's LightType functions in Play (docs/mesh-lighting.md
// "LightType functions"): headless Chromium runs Play in the default mode
// (the simulation and its mesh lighting in the worker; `--query sim=inline`
// runs them on the page), stands the player beside a mesh actor that a
// Flicker light reaches (Training's ScientistFemale0 and Light536 by
// default), and keeps that actor's SetupForActor results for some frames
// (decal-probe.mjs meshLightProbe). Checked per frame: each added light's
// type-function brightness equals lightTypeBrightness at 24 bits with the
// frame's Level.TimeSeconds, the simulation's light noise table A, the
// light's Flicker key (its map export index, low byte) and the shared Strobe
// state as it stood before the call; the light's colour is the moving-light
// constants at that brightness times the fade; and the Flicker light's
// colour changes from frame to frame. `--map 06_HongKong_WanChai_Underworld
// --actor Female5 --light TriggerLight1` checks a Strobe light. The type functions
// themselves are checked against Render.dll by validate-mesh-light-types.
//
//   node scripts/validate-mesh-light-types-play.mjs [--url http://...] [--query sim=inline] [--frames 90]
//        [--map NAME --actor NAME --light NAME]
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { lightTypeBrightness } from '../src/runtime/static-lighting.mjs';
import { fgetHsv, movingLightConstants } from '../src/runtime/dynamic-lighting.mjs';
import { r24prod } from '../src/runtime/x87-pc24.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-mesh-light-types-play: no installed game data'); process.exit(0); }
const map = option('map', '00_Training'), actorName = option('actor', 'ScientistFemale0'), lightName = option('light', 'Light536');
const frames = Number(option('frames', 90)), f = Math.fround;
const bits = new DataView(new ArrayBuffer(4));
const u32 = value => { bits.setFloat32(0, value, true); return bits.getUint32(0, true); };

// The light's map export index: the Flicker key Play gives a map light.
const files = [];
for (const name of await readdir(path.join(root, 'Maps'))) files.push({ path: `Maps/${name}`, read: () => readFile(path.join(root, 'Maps', name)) });
const asset = await new AssetStore(files).get(map);
const exportIndex = asset.pkg.exports.findIndex(entry => entry.name === lightName) + 1;
assert.ok(exportIndex > 0, `${lightName} is a ${map} export`);

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
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, { timeout: 240000 });
  report = await page.evaluate(async ({ actorName, frames }) => {
    const viewer = window.deusExViewer, frame = n => new Promise(resolve => {
      let k = 0; const step = () => (++k >= n ? resolve() : requestAnimationFrame(step)); requestAnimationFrame(step);
    });
    await viewer.meshLightProbe({ watch: actorName });
    await frame(5);
    const { location } = await viewer.meshLightProbe({ take: true });
    // Stands around the actor, looking at it, until its setups carry lights.
    let stand = null, records = [];
    for (const [dx, dy] of [[160, 0], [0, 160], [-160, 0], [0, -160], [110, 110], [-110, 110], [110, -110], [-110, -110]]) {
      const at = [location[0] + dx, location[1] + dy, location[2] + 10];
      await viewer.placeProbe({ location: at, lookAt: actorName });
      await frame(20);
      await viewer.placeProbe({ lookAt: actorName });
      await viewer.meshLightProbe({ take: true });
      await frame(frames);
      records = (await viewer.meshLightProbe({ take: true })).records;
      if (records.length > frames / 2 && records.some(record => record.lights.length)) { stand = at; break; }
    }
    return { stand, records, runtimeError: viewer.status().runtimeError?.message ?? null };
  }, { actorName, frames });
  report.pageErrors = errors;
} finally { await browser.close(); await server?.close(); }

assert.deepEqual(report.pageErrors, []);
assert.equal(report.runtimeError, null);
assert.ok(report.stand, `a stand beside ${actorName} draws it with lights`);
const stats = { records: report.records.length, infos: 0, byType: {}, colours: new Set(), lightTypes: new Set(), noiseTables: new Set(), times: new Set() };
for (const record of report.records) {
  assert.ok(record.noiseA, 'mesh lighting reads the simulation\'s light noise');
  stats.noiseTables.add(record.noiseA.slice(0, 16).join());
  stats.times.add(record.timeSeconds);
  const strobe = { time: record.strobeBefore[0], flag: record.strobeBefore[1] }, A = Float32Array.from(record.noiseA);
  for (const light of record.lights) {
    const type = light.values.LightType & 255;
    stats.infos++; stats.byType[type] = (stats.byType[type] ?? 0) + 1;
    const brightness = f(lightTypeBrightness(light.values, { timeSeconds: record.timeSeconds, noise: { A }, strobe, flickerKey: light.flickerKey }));
    assert.equal(u32(light.brightness), u32(brightness), `${light.name} (type ${type}) at ${record.timeSeconds}: brightness`);
    const hsv = fgetHsv(light.values.LightHue & 255, light.values.LightSaturation & 255, 255);
    const color = movingLightConstants(light.values, f(record.levelBrightness), hsv, brightness).color;
    const fade = r24prod(light.fade, 1 / 255);
    assert.deepEqual(light.color.map(u32), color.map(channel => u32(f(fade * channel))), `${light.name} at ${record.timeSeconds}: colour`);
    if (light.name === lightName) {
      stats.lightTypes.add(type);
      if (type === 4) assert.equal(light.flickerKey, exportIndex & 0xff, `${lightName}'s Flicker key is its export index's low byte`);
      if (light.fade === 255) stats.colours.add(light.color.join());
    }
  }
  assert.deepEqual([...record.strobe], [strobe.time, strobe.flag], `Strobe state after ${actorName}'s setup at ${record.timeSeconds}`);
}
const summary = { stand: report.stand, records: stats.records, infos: stats.infos, byType: stats.byType,
  lightTypes: [...stats.lightTypes], colours: stats.colours.size, noiseTables: stats.noiseTables.size, times: stats.times.size };
console.log(JSON.stringify(summary));
assert.ok(stats.lightTypes.size === 1 && ![0, 1].includes([...stats.lightTypes][0]), `${lightName}, a non-steady light, reaches ${actorName}`);
assert.ok(stats.noiseTables.size > stats.records / 2, 'the light noise table changes from frame to frame');
assert.ok(stats.colours.size > 1, `${lightName}'s colour changes from frame to frame`);
console.log(`validate-mesh-light-types-play: PASS (${map} ${actorName}: ${stats.records} frames, ${stats.infos} light infos, ` +
  `${stats.colours.size} distinct ${lightName} colours, type ${[...stats.lightTypes]})`);
