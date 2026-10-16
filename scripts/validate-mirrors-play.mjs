// Wall mirrors in Play (docs/mirror-surfaces.md "All maps"): the player faces
// the translucent bar mirror in 02_NYC_Bar, an opaque unlit bathroom mirror
// in 02_NYC_Hotel and the translucent mirror on 02_NYC_Smug's DeusExMover7. Each plane's reflected child renders, the mirror region
// differs from the same frame drawn without the reflection, and the opaque
// mirror shows the child alone. The page renders at device pixel ratio 2.
// 11_Paris_Everett's standing mirror (DeusExMover2) is seen at the left of
// the screen after every child target is filled with magenta at near depth:
// no mirror pixel may still show it, so each column the composite samples is
// cleared and drawn this frame (the child's scissor and the right-to-left
// sampling agree at this pixel ratio).
// In the Hotel bathroom the player appears in the mirror's child frame but
// not in the main frame (Render.dll excludes the view actor only when
// Frame->Parent is null): hiding him changes the reflected frame, and with
// reflections off it changes nothing.
//
//   node scripts/validate-mirrors-play.mjs [--url http://...] [--shots DIR]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-mirrors-play: no installed game data'); process.exit(0); }
let server = null, url = option('url', null);
const shots = option('shots', null);
if (!url) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const {default: base} = await import('../vite.config.mjs');
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
  server = await createServer({...base, configFile: false, root, logLevel: 'error',
    server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
// Camera in front of each mirror (Unreal units, yaw toward the plane).
const CASES = [
  {map: '02_NYC_Bar', name: 'translucent wall', location: [-768, -600, 95], yaw: 49152, opaque: false},
  {map: '02_NYC_Hotel', name: 'opaque unlit wall', location: [1880, -1158, 148], yaw: 32768, opaque: true, player: true},
  {map: '02_NYC_Smug', name: 'translucent mover', location: [-576, 1530, 250], yaw: 16384, opaque: false},
  {map: '11_Paris_Everett', name: 'off-axis standing mover', location: [1024, 1640, 430], yaw: 53000, opaque: false,
    stale: {actor: 'DeusExMover2'}},
];
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
const results = [];
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}, deviceScaleFactor: 2});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: (await response.text()) +
      '\nwindow.__deusMirrors={get world(){return world;},get camera(){return camera;},get renderer(){return renderer;}};\n'});
  });
  // --query a=1&b=2: viewer switches, e.g. simVerify=1 (docs/sim-worker.md).
  // Play's default mode: the simulation in the worker. The player is moved and hidden through deusExViewer.placeProbe
  // (decal-probe.mjs); the renderer, the world and the camera are the page's own.
  await page.goto(`${url.replace(/\/$/, '')}/${option('query', null) ? `?${option('query', null)}` : ''}`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  // The mirror's CSS-pixel screen rectangle, from its mesh bounds.
  const mirrorRect = actor => page.evaluate(actor => {
    const {world, camera} = window.__deusMirrors;
    let box = null;
    world.root.traverse(o => {
      if (o.isMesh && o.userData.actor === actor && /:(opaque|composite):/.test(o.material.customProgramCacheKey?.() ?? '')) {
        o.geometry.computeBoundingBox(); box = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      }
    });
    if (!box) return null;
    camera.updateMatrixWorld();
    const canvas = document.querySelector('#scene canvas') ?? document.querySelector('canvas'), r = canvas.getBoundingClientRect();
    const xs = [], ys = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const p = box.min.clone().set(x, y, z).project(camera);
      xs.push(r.left + (p.x + 1) / 2 * r.width); ys.push(r.top + (1 - p.y) / 2 * r.height);
    }
    const left = Math.max(r.left, Math.min(...xs)) + 2, top = Math.max(r.top, Math.min(...ys)) + 2;
    const right = Math.min(r.right, Math.max(...xs)) - 2, bottom = Math.min(r.bottom, Math.max(...ys)) - 2;
    return {x: left, y: top, width: right - left, height: bottom - top};
  }, actor);
  // Share of pixels whose channels differ by more than 12/255 (base64 PNGs).
  const changedShare = (a, b) => page.evaluate(async ([a, b]) => {
    const pixels = async data => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const canvas = new OffscreenCanvas(image.width, image.height), g = canvas.getContext('2d');
      g.drawImage(image, 0, 0); return g.getImageData(0, 0, image.width, image.height).data;
    };
    const [p, q] = await Promise.all([pixels(a), pixels(b)]);
    let differing = 0;
    for (let i = 0; i < p.length; i += 4)
      if (Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2])) > 12) differing++;
    return differing / (p.length / 4);
  }, [a, b]);
  const hidePlayer = hidden => page.evaluate(hidden =>
    window.deusExViewer.placeProbe({set: {actor: '$player', fields: {bHidden: hidden}}}), hidden);
  // The player shown and hidden, with reflections on and off.
  async function playerCheck(c) {
    const share = {};
    for (const enabled of [true, false]) {
      await page.evaluate(enabled => { window.__deusMirrors.world.mirrors.enabled = enabled; }, enabled);
      await frames(4);
      const shown = (await page.screenshot()).toString('base64');
      // The worker's next snapshot carries the flag to the page: a few frames more than inline.
      await hidePlayer(true); await frames(12);
      const hidden = (await page.screenshot()).toString('base64');
      if (shots && enabled) writeFileSync(`${shots}/mirror-${c.map}-player-hidden.png`, Buffer.from(hidden, 'base64'));
      await hidePlayer(false); await frames(12);
      share[enabled ? 'reflected' : 'mainOnly'] = await changedShare(shown, hidden);
    }
    await page.evaluate(() => { window.__deusMirrors.world.mirrors.enabled = true; });
    return share;
  }
  // Fill every child target with magenta, draw a few frames, and count the
  // mirror's pixels that still show it.
  async function staleCheck(c) {
    const clip = await mirrorRect(c.stale.actor);
    if (!clip || clip.width < 8 || clip.height < 8) return {clip, error: 'mirror not on screen'};
    await page.evaluate(() => {
      const {world, renderer} = window.__deusMirrors, target = renderer.getRenderTarget();
      let sample = null; world.root.traverse(o => { sample ??= o.material?.color ?? null; });
      const color = renderer.getClearColor(sample.clone()), alpha = renderer.getClearAlpha();
      for (const t of world.mirrors.targets()) {
        const test = t.scissorTest; t.scissorTest = false;
        // Near depth too: a pixel the frame never clears never draws either.
        renderer.setRenderTarget(t); renderer.setClearColor(0xff00ff, 1);
        renderer.state.buffers.depth.setClear(0); renderer.clear(); renderer.state.buffers.depth.setClear(1);
        t.scissorTest = test;
      }
      renderer.setRenderTarget(target); renderer.setClearColor(color, alpha);
    });
    await frames(3);
    const shot = await page.screenshot({clip});
    if (shots) writeFileSync(`${shots}/mirror-${c.map}-stale.png`, shot);
    const magenta = await page.evaluate(async data => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const canvas = new OffscreenCanvas(image.width, image.height), g = canvas.getContext('2d');
      g.drawImage(image, 0, 0); const p = g.getImageData(0, 0, image.width, image.height).data;
      let count = 0;
      for (let i = 0; i < p.length; i += 4) if (p[i] > 200 && p[i + 2] > 200 && p[i] - p[i + 1] > 100) count++;
      return count / (p.length / 4);
    }, shot.toString('base64'));
    return {clip, magenta};
  }
  for (const c of CASES) {
    await page.locator('#map').selectOption(c.map);
    await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, c.map, {timeout: 240000});
    await page.evaluate(({location, yaw}) => window.deusExViewer.placeProbe({location, rotation: [0, yaw, 0]}), c);
    await frames(90);
    // The player's view can still be moving after the move (it took about
    // 1.3 s in 02_NYC_Bar): wait until the eye has stayed put for 30 frames,
    // since the mirror passes now follow OccludeBsp's requests for the actual
    // view (docs/bsp-occlusion.md "Play").
    await page.waitForFunction(() => {
      const eye = window.deusExViewer.status().position?.join(), w = window.__mirrorEye ??= {eye: null, frames: 0};
      w.frames = eye === w.eye ? w.frames + 1 : 0; w.eye = eye;
      return w.frames >= 30;
    }, null, {polling: 'raf', timeout: 60000});
    await page.evaluate(() => { delete window.__mirrorEye; });
    const stale = c.stale ? await staleCheck(c) : null;
    const read = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => setTimeout(() => {
      const world = window.__deusMirrors.world, s = window.deusExViewer.status();
      resolve({mirrors: s.mirrors, runtimeError: s.runtimeError?.message ?? null,
        notes: [...world.notes].filter(n => /mirror/i.test(n))});
    }, 0))));
    const state = await read();
    if (shots) await page.screenshot({path: `${shots}/mirror-${c.map}.png`});
    const withReflection = await page.screenshot();
    // The same view with every mirror's reflection disabled (render() skipped).
    await page.evaluate(() => { window.__deusMirrors.world.mirrors.enabled = false; });
    await frames(3);
    const without = await page.screenshot();
    if (shots) await page.screenshot({path: `${shots}/mirror-${c.map}-off.png`});
    await page.evaluate(() => { window.__deusMirrors.world.mirrors.enabled = true; });
    const differing = withReflection.length && without.length ? Buffer.compare(withReflection, without) !== 0 : false;
    const player = c.player ? await playerCheck(c) : null;
    results.push({...c, ...state, differing, stale, player});
  }
  results.pageErrors = errors;
} finally { await browser.close(); await server?.close(); }
console.log(JSON.stringify(results, null, 1));
assert.deepEqual(results.pageErrors, []);
for (const r of results) {
  assert.equal(r.runtimeError, null, r.map);
  assert.ok(r.mirrors.renderedPlanes >= 1, `${r.map}: the ${r.name} mirror renders a reflected child`);
  assert.ok(r.mirrors.surfaces >= 1 && (!r.opaque || r.mirrors.opaqueSurfaces >= 1), `${r.map}: mirror surfaces admitted`);
  assert.ok(!r.notes.some(n => /outside static upward-facing/.test(n)), `${r.map}: no static-floor-only note`);
  assert.ok(r.differing, `${r.map}: the reflection changes the frame`);
  if (r.player) {
    assert.ok(r.player.reflected > 0.001, `${r.map}: the player is drawn in the mirror's child frame (${JSON.stringify(r.player)})`);
    assert.ok(r.player.mainOnly < 0.0005, `${r.map}: the main frame does not draw the first-person player (${JSON.stringify(r.player)})`);
  }
  if (r.stale) assert.ok(r.stale.magenta === 0, `${r.map}: every pixel of the ${r.name} mirror is drawn this frame (${JSON.stringify(r.stale)})`);
}
console.log(`validate-mirrors-play: PASS (${results.map(r => `${r.map} ${r.name}: ${r.mirrors.renderedPlanes} plane(s)`).join('; ')})`);
