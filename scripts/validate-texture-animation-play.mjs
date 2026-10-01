// Animated BSP textures in the browser (docs/texture-animation.md): Training's
// animated surface textures (UTexture AnimNext chains) advance through
// texture-animation.mjs (validate-native-texture-animation) once per drawn
// frame. In headless Chromium this samples every animated head over a few
// seconds and checks that each advances, only along its own AnimNext chain,
// and that every material using it draws the shown frame's texture.
//
//   node scripts/validate-texture-animation-play.mjs [--url http://...]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-texture-animation-play: no installed game data'); process.exit(0); }
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
const hook = `\nwindow.__deusTextureAnimation={get world(){return world;}};\n`;
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
  report.pageErrors = errors;
  report.status = await page.evaluate(() => window.deusExViewer.status().runtimeError ?? null);
} finally { await browser.close(); await server?.close(); }
console.log(JSON.stringify(report, null, 1).slice(0, 4000));
assert.deepEqual(report.pageErrors, []);
assert.ok(report.materials > 0, 'Training has animated surface materials');
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
console.log(`validate-texture-animation-play: PASS (${report.heads.length} animated heads, ${report.materials} materials)`);
