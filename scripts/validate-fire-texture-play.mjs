// FireTexture skins in the browser (docs/fire-texture.md "Play"): Island's
// procedural mesh skins (laser spots and beams, the nano and biocell glows,
// barrel flames) are live textures, no mesh face group is skipped, and each
// fire advances its GlobalPhase and pixels between frames through the
// translated Fire.dll tick (validate-native-fire-texture). The BSP's
// WetTexture water (drtywater_a on Island and in Training) is live the same
// way.
//
//   node scripts/validate-fire-texture-play.mjs [--map 01_NYC_UNATCOIsland] [--url http://...]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-fire-texture-play: no installed game data'); process.exit(0); }
const map = option('map', '01_NYC_UNATCOIsland');
let server = null, url = option('url', null);
if (!url) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const {default: base} = await import('../vite.config.mjs');
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/')));
  server = await createServer({...base, configFile: false, root, logLevel: 'error',
    server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const hook = `\nwindow.__deusFire={get npc(){return npcPreview;},get world(){return world;}};\n`;
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
let report;
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: (await response.text()) + hook});
  });
  await page.goto(url);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  if (map !== '00_Training') {
    await page.locator('#map').selectOption(map);
    await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 240000});
  }
  report = await page.evaluate(async () => {
    const npc = window.__deusFire.npc;
    const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await frames();
    const before = npc.proceduralTextures();
    for (let k = 0; k < 10; k++) await frames();
    const after = npc.proceduralTextures();
    return {before, after, skipped: npc.summary.skipped.map(s => `${s.actor} ${s.texture}: ${s.message}`),
      worldErrors: window.__deusFire.world.errors.map(e => JSON.stringify(e)).filter(e => /Texture size|FireTexture|WetTexture/.test(e)),
      worldFires: [...window.__deusFire.world.materials.values()].filter(m => m.userData.animated && m.map?.isDataTexture && !m.map.mipmaps?.length).length,
      runtimeError: window.deusExViewer.status().runtimeError ?? null};
  });
  report.pageErrors = errors;
} finally { await browser.close(); await server?.close(); }
console.log(JSON.stringify(report, null, 1).slice(0, 3000));
assert.deepEqual(report.pageErrors, []);
assert.equal(report.runtimeError, null);
assert.deepEqual(report.skipped, [], 'no mesh face group is skipped');
assert.deepEqual(report.worldErrors, [], 'no BSP surface fails on a fire texture');
assert.ok(report.after.length > 0, `${map} has fire skins`);
if (['01_NYC_UNATCOIsland', '00_Training', '00_TrainingFinal'].includes(map))
  assert.ok(report.after.some(entry => entry.kind === 'WetTexture' && /drtywater_a/i.test(entry.key)), `${map}'s drtywater_a is live`);
for (const fire of report.after) {
  const earlier = report.before.find(entry => entry.key === fire.key);
  assert.ok(earlier, `${fire.key} was live before`);
  assert.ok(fire.phase > earlier.phase, `${fire.key} ticked (GlobalPhase ${earlier.phase} -> ${fire.phase})`);
  assert.notEqual(fire.checksum, earlier.checksum, `${fire.key} pixels changed`);
}
console.log(`validate-fire-texture-play: PASS (${map}: ${report.after.map(f => f.key.split('.').pop()).join(', ')})`);
