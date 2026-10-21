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
// Movers (docs/decals.md "Movers", skipped with --mover off): the player
// faces a tracked mover's largest fragment and a BulletHole is spawned on
// it as TraceHitSpawner does (Owner the mover). AttachDecal's trace meets
// the fragment in the tracked level model, the Mover branch bases the decal
// on the mover, and the decal block draws it 0.75 units off the fragment's
// plane; moving the mover 16 units up, then turning it, carries the drawn
// fragments with the tracked surface (the synced model, then ClipDecal's
// Rotation - MoverRotation).
//
//   node scripts/validate-decals-play.mjs [--url http://...] [--query sim=inline] [--shot frame.png] [--mover off]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import { debugUrl } from './page-url.mjs';

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
  await page.goto(debugUrl(`${url}/${option('query', '') ? `?${option('query', '')}` : ''}`));
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
  let mover = null;
  if (option('mover', 'on') !== 'off') {
    const probe = args => page.evaluate(args => window.deusExViewer.moverDecalProbe(args), args);
    const placed = await probe({ place: true });
    await frames(20);
    const spawned = await probe({ spawn: true });
    await frames(8);
    const before = await probe({});
    await page.evaluate(name => window.deusExViewer.moverProbe({ set: [{ name, offset: [0, 0, 16] }] }), placed.mover);
    await frames(8);
    const moved = await probe({});
    const turn = [moved.moverRotation[0], (moved.moverRotation[1] + 2048) | 0, moved.moverRotation[2]];
    await page.evaluate(([name, rotation]) => window.deusExViewer.moverProbe({ set: [{ name, rotation }] }), [placed.mover, turn]);
    await frames(8);
    const turned = await probe({});
    mover = { placed, spawned, before, moved, turned, runtimeError: await page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null) };
  }
  report = { pawn, state, changed, darker, brighter, mover, pageErrors: errors };
} finally { await browser.close(); await server?.close(); }
const brief = m => m && { ...m, fragments: m.fragments.map(g => ({ texture: g.texture, points: g.points.length })) };
console.log(JSON.stringify({ ...report, mover: report.mover && Object.fromEntries(Object.entries(report.mover)
  .map(([k, v]) => [k, typeof v === 'object' ? brief(v) : v])) }, null, 1));
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
let moverNote = '';
if (report.mover) {
  const { spawned, before, moved, turned } = report.mover;
  assert.equal(report.mover.runtimeError, null);
  assert.ok(spawned.decal, 'the BulletHole spawns');
  assert.ok(spawned.decal.surfList.includes(spawned.surface), `AttachDecal meets the mover fragment's surface ${spawned.surface} (SurfList ${spawned.decal.surfList})`);
  assert.equal(spawned.decal.base, spawned.mover, 'the Mover branch bases the decal on its Owner (SetBase(Owner, 1))');
  assert.ok(spawned.held.includes(spawned.surface), 'the tracker surface holds the FDecal');
  // The BulletHole's fragments: the group of its texture, every point 0.75
  // units off the tracked surface's plane (ClipDecal's lift).
  const sub = (a, b) => a.map((v, i) => v - b[i]), dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const group = state => {
    const n = state.plane.normal, len = Math.hypot(...n), unit = n.map(v => v / len);
    const groups = state.fragments.filter(g => g.points.length && g.points.every(p => Math.abs(dot(sub(p, state.plane.base), unit) - 0.75) < 0.05));
    assert.equal(groups.length, 1, `one decal group on the mover's plane at ${state.time.toFixed(2)} s`);
    const points = groups[0].points, centre = [0, 1, 2].map(c => points.reduce((s, p) => s + p[c], 0) / points.length);
    return { points: points.length, centre };
  };
  const a = group(before), b = group(moved), c = group(turned);
  assert.ok(before.time - before.decal.lastRendered < 0.1, 'the decal block stamps the BulletHole\'s LastRenderedTime');
  const shift = sub(b.centre, a.centre);
  assert.ok(Math.abs(shift[0]) < 0.05 && Math.abs(shift[1]) < 0.05 && Math.abs(shift[2] - 16) < 0.05,
    `the fragments follow the mover up 16 units (moved by ${shift.map(v => v.toFixed(3))})`);
  // A turn about the mover's pivot carries the drawn fragments with its
  // plane: the plane's normal turns and every point stays 0.75 off it.
  const turnedBy = Math.acos(Math.min(1, dot(moved.plane.normal, turned.plane.normal) /
    (Math.hypot(...moved.plane.normal) * Math.hypot(...turned.plane.normal))));
  assert.ok(Math.abs(turnedBy - 2048 * Math.PI / 32768) < 1e-3,
    `the tracked surface turns with the mover (${turnedBy.toFixed(4)} rad; fragments' centre moved ${Math.hypot(...sub(c.centre, b.centre)).toFixed(3)})`);
  moverNote = `; BulletHole on ${spawned.mover} surface ${spawned.surface}: ${a.points} points, ` +
    `followed 16 units up and a 2048 turn`;
}
console.log(`validate-decals-play: PASS (${report.pawn.name}'s Shadow on surfaces ${report.state.surfList.join(', ')}, ` +
  `${shadowGroup.triangles} triangles, ${report.darker} pixels darker${moverNote})`);
