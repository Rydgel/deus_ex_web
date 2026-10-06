// Shadow decals in the browser (docs/decals.md "Play").
//
// On 00_Training the player stands a few metres from a ScriptedPawn and
// looks at its feet. Drawing the pawn stamps its LastRenderTime, so
// Shadow.Tick traces down and attaches through the Rust AttachDecal; the
// simulation's decal block (decal-draw.mjs) clips the shadow against the
// floor's saved polygons, stamps the Shadow's LastRenderedTime and hands its
// fragments to the page, which draws them modulated (decal-scene.mjs). The
// frame with the decal pass must be darker under the pawn than without it.
//
//   node scripts/validate-decals-play.mjs [--url http://...] [--query sim=inline] [--shot frame.png]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-decals-play: no installed game data'); process.exit(0); }
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
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
let report;
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    const text = (await response.text()).replace('antialias: true })', 'antialias: true, preserveDrawingBuffer: true })');
    await route.fulfill({response, body: text +
      '\nwindow.__deusDecals={get decals(){return decalScene;},get renderer(){return renderer;},' +
      'get scene(){return scene;},get camera(){return camera;}};\n'});
  });
  // The default mode: the simulation runs in the worker; the probe
  // (decal-probe.mjs) places the player and reads the Shadow there.
  await page.goto(`${url}/${option('query', '') ? `?${option('query', '')}` : ''}`);
  await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === '00_Training'; }, {}, {timeout: 240000});
  const pawn = await page.evaluate(() => window.deusExViewer.decalProbe({ place: true }));
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const sample = () => page.evaluate(async name => ({ ...await window.deusExViewer.decalProbe({ pawn: name }),
    decals: window.deusExViewer.decals(), runtimeError: window.deusExViewer.status().runtimeError?.message ?? null }), pawn.name);
  await frames(90);
  const state = await sample();
  if (option('shot', null)) {
    await page.screenshot({path: option('shot', null)});
    // The same view without the decal pass, a few frames later.
    await page.evaluate(() => { window.__deusDecals.decals.root.visible = false; });
    await frames(2);
    await page.screenshot({path: option('shot', null).replace(/\.png$/, '-off.png')});
    await page.evaluate(() => { window.__deusDecals.decals.root.visible = true; });
  }
  // The same frame rendered twice, with and without the decal layer, read
  // from the drawing buffer: only the decal pass differs.
  const [withDecals, without] = await page.evaluate(() => {
    const { renderer, scene, camera, decals } = window.__deusDecals, gl = renderer.getContext();
    const read = () => {
      const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight, data = new Uint8Array(width * height * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return Array.from(data);
    };
    renderer.setRenderTarget(null);
    renderer.render(scene, camera); const on = read();
    decals.root.visible = false; renderer.render(scene, camera); const off = read(); decals.root.visible = true;
    return [on, off];
  });
  let changed = 0, darker = 0, brighter = 0;
  for (let i = 0; i < withDecals.length; i += 4) {
    const a = withDecals[i] + withDecals[i + 1] + withDecals[i + 2], b = without[i] + without[i + 1] + without[i + 2];
    if (a !== b) { changed++; if (a < b) darker++; else brighter++; }
  }
  report = { pawn, state, changed, darker, brighter, pageErrors: errors };
} finally { await browser.close(); await server?.close(); }
console.log(JSON.stringify(report, null, 1));
assert.deepEqual(report.pageErrors, []);
assert.equal(report.state.runtimeError, null);
assert.ok(report.state.surfList.length > 0, 'the drawn pawn\'s Shadow attaches through AttachDecal');
assert.ok(report.state.records > 0, 'the level holds FDecal records');
assert.ok(report.state.time - report.state.lastRendered < 0.1, 'the decal block stamps LastRenderedTime');
const shadowGroup = report.state.decals.groups.find(g => /flatfxtex40/.test(g.texture));
assert.ok(shadowGroup?.triangles > 0, 'the Shadow texture\'s fragments reach the page');
assert.ok(report.state.decals.drawnTriangles > 0, 'the page draws them');
assert.ok(report.darker > 200 && report.darker > 3 * report.brighter,
  `the modulated shadow darkens the floor (${report.darker} darker, ${report.brighter} brighter pixels)`);
console.log(`validate-decals-play: PASS (${report.pawn.name}'s Shadow on surfaces ${report.state.surfList.join(', ')}, ` +
  `${shadowGroup.triangles} triangles, ${report.darker} pixels darker)`);
