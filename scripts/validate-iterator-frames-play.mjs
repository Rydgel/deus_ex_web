// Each child frame builds the render iterators' items again (docs/bsp-occlusion.md
// "Child frames"). URender::OccludeFrame (0x10b19fc0) runs SetupDynamics before
// each child's OccludeBsp (0x10b1a188), and SetupDynamics (0x10b22fee..0x10b2307c)
// runs every iterating actor's protocol again: Init(Viewport->Actor), First, then
// CurrentItem until IsDone. LaserIterator.Init resets its state (nextItem,
// prevLoc, savedLoc) and CurrentItem draws from the shared random stream (the
// savedLoc rule: one appFrand per item until an item is saved), so a frame's
// last item can sit elsewhere than the root frame's.
//
// In Play with the worker (the default; iteratorProbe reads the simulation
// side), on 09_NYC_Dockyard facing the floor mirror its BeamTriggers' beams
// stand near (a mirror frame, 42 iterating actors) and a view of its sky frame,
// and on 01_NYC_UNATCOIsland facing the mirror by its doorway lasers:
// - every child frame visited ran the iterators again, once, and the stream was
//   drawn from for it as for the root frame (draws per run are close);
// - the items of a child frame are not always the root frame's: the last item
//   of an emitter (savedLoc) differs in some frame, and no list changes length;
// - a particle's items are the same in every frame (the child frame draws the
//   root's sprite records), checked on 02_NYC_Street's sky frame beside smoke;
// - each frame draws its items with its own fields (docs/bsp-occlusion.md "Each child
//   frame's own SetupDynamics", DrawActorSprite 0x10b2556a): an item equal to a root
//   frame's item shares that item's binding, and one that differs has a binding of its
//   own (an extra), updated with the frame's item (its Location, Rotation, DrawScale and
//   ScaleGlow bit for bit) and drawn only in the child pass of the frames that hold it;
// - the frame's candidates are the root's with the iterator-made ones packed
//   again, and ?iteratorFrames=verify (which packs each frame from scratch too and
//   compares every word) runs through;
// - ?iteratorFrames=off (the root's items in every frame) runs none again.
//
//   node scripts/validate-iterator-frames-play.mjs [--url http://...] [--query gpuMesh=0]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-iterator-frames-play: no installed game data'); process.exit(0); }
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
const CASES = [
  // The BeamTriggers' beams and the floor mirror (a mirror frame in view).
  {map: '09_NYC_Dockyard', view: {location: [1304, 3212, 72], rotation: [62981, 32768, 0]}, kind: 'mirror'},
  // Island's doorway lasers (LaserTrigger0-4) seen in a mirror.
  {map: '01_NYC_UNATCOIsland', view: {location: [1632, -1330, -84], rotation: [62981, 16384, 0]}, kind: 'mirror'},
  // The same Dockyard spot turned to a sky frame.
  {map: '09_NYC_Dockyard', view: {location: [1504, 3092, 72], rotation: [64852, 28545, 0]}, kind: 'sky'},
  // Smoke (ParticleGenerators): the sky frame of 02_NYC_Street beside ParticleGenerator3's vent.
  {map: '02_NYC_Street', view: {location: [2534, -4428, -531], rotation: [6000, 8192, 0]}, kind: 'sky', particles: true},
];
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
const reports = [];
try {
  for (const c of CASES) for (const mode of c === CASES[0] ? ['on', 'verify', 'off'] : ['on']) {
    const page = await browser.newPage({viewport: {width: 1024, height: 640}});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    try {
      await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
        const response = await route.fetch();
        await route.fulfill({response, body: (await response.text()) + '\nwindow.__deusIter={get visible(){return lastVisibility;}};\n'});
      });
      await page.goto(`${url.replace(/\/$/, '')}/?iteratorFrames=${mode}${option('query', '') ? `&${option('query', '')}` : ''}`);
      await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
      await page.locator('#map').selectOption(c.map);
      await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, c.map, {timeout: 240000});
      await page.waitForTimeout(3000);
      if (c.view) await page.evaluate(view => window.deusExViewer.placeProbe(view), c.view);
      const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
      await frames(30);
      await page.evaluate(() => window.deusExViewer.meshPassProbe(true));
      const total = {extraDrawnClaims: 0, extraClaims: 0, sharedClaims: 0, claimMismatch: [], extraChildDraws: 0, extraMainDraws: 0, scans: 0, rescans: 0, visited: 0, drawsScan: 0, drawsRescan: 0, iterators: 0, frames: 0, kinds: new Set(), differing: 0,
        lengthChanged: 0, itemFrames: 0, particles: c.particles ?? false, spriteRecords: 0, childOnly: 0, patched: 0, packed: 0};
      for (let sample = 0; sample < 24; sample++) {
        await page.evaluate(() => window.deusExViewer.iteratorProbe({reset: true}));
        await frames(2);
        const state = await page.evaluate(() => window.deusExViewer.iteratorProbe({}));
        for (const key of ['scans', 'rescans', 'visited', 'drawsScan', 'drawsRescan']) total[key] += state[key];
        total.iterators = Math.max(total.iterators, state.iterators);
        total.spriteRecords += state.sprites.iterating; total.childOnly += state.sprites.childOnly;
        total.patched += state.patched; total.packed += state.packed;
        const passes = (await page.evaluate(() => window.deusExViewer.meshPassProbe())) ?? [];
        const [root, ...children] = state.lastFrames;
        // Each frame's items are drawn with the frame's own fields: a shared binding is the root's, an extra
        // was updated with this item and is no root item's.
        const states = new Map((state.itemStates ?? []).map(entry => [entry.id, entry]));
        const sameItem = (a, b) => a && b && a.location.every((v, k) => Object.is(v, b.location[k])) && a.rotation.every((v, k) => v === b.rotation[k])
          && Object.is(a.drawScale, b.drawScale) && Object.is(a.scaleGlow, b.scaleGlow);
        for (const child of children) for (const claim of child.bindings ?? []) {
          const entry = states.get(claim.id), equalsRoot = root.bindings.some(rootClaim => rootClaim.actor === claim.actor && rootClaim.slot === claim.slot && sameItem(rootClaim, claim));
          if (!entry || !sameItem(entry.item, claim) || entry.extra === equalsRoot) { total.claimMismatch.push({id: claim.id, extra: entry?.extra, equalsRoot, last: entry?.item?.location, frame: claim.location}); continue; }
          if (entry.extra) { total.extraClaims++; if (claim.drawn) total.extraDrawnClaims++; } else total.sharedClaims++;
        }
        const extraIds = new Set([...states.values()].filter(entry => entry.extra).map(entry => entry.id));
        total.extraChildDraws += passes.filter(pass => extraIds.has(pass.id) && pass.child).length;
        total.extraMainDraws += passes.filter(pass => extraIds.has(pass.id) && !pass.child).length;
        for (const child of children) {
          total.kinds.add(child.kind); total.itemFrames++;
          if (child.items.length !== root.items.length) total.lengthChanged++;
          total.differing += root.items.filter((p, i) => p.some((v, k) => v !== child.items[i]?.[k])).length;
        }
      }
      const status = await page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null);
      reports.push({map: c.map, mode, ...total, kinds: [...total.kinds], runtimeError: status, errors});
    } finally { await page.close(); }
  }
} finally { await browser.close(); await server?.close(); }
console.log(JSON.stringify(reports, null, 1));
for (const r of reports) {
  assert.deepEqual(r.errors, [], `${r.map} ${r.mode}: page errors`);
  assert.equal(r.runtimeError, null, `${r.map} ${r.mode}: runtime error`);
  assert.ok(r.iterators >= 5 && r.scans > 0, `${r.map} ${r.mode}: the level's iterators are scanned (${r.iterators} iterating actors, ${r.scans} scans)`);
  assert.ok(r.visited > 0, `${r.map} ${r.mode}: child frames are visited`);
  if (r.mode === 'off') {
    assert.equal(r.rescans, 0, `${r.map}: ?iteratorFrames=off runs no iterator again`);
    continue;
  }
  assert.equal(r.rescans, r.visited, `${r.map} ${r.mode}: every child frame visited ran the iterators again, once`);
  // The frame's candidates are the root's with the iterator-made ones packed again, and the
  // 'verify' run compared every word with packing the frame from scratch.
  assert.ok(r.patched > 0 && r.packed === 0, `${r.map} ${r.mode}: the child frames' candidates are patched (${r.patched} patched, ${r.packed} packed)`);
  if (r.particles) {
    // A particle's item draws the same in every frame: the child frame's records are the root's.
    assert.ok(r.spriteRecords > 0, `${r.map}: live particles make sprite records`);
    assert.equal(r.childOnly, 0, `${r.map}: a child frame's particle items equal the root's, so no record of its own`);
    continue;
  }
  assert.ok(r.drawsRescan > 0 && Math.abs(r.drawsRescan - r.drawsScan * r.visited / r.scans) < 0.35 * r.drawsScan * r.visited / r.scans,
    `${r.map}: the stream is drawn from for each frame as for the root (${r.drawsRescan} draws in ${r.rescans} reruns, ${r.drawsScan} in ${r.scans} scans)`);
  assert.equal(r.lengthChanged, 0, `${r.map}: no frame's item list changes length`);
  assert.deepEqual(r.claimMismatch.slice(0, 3), [], `${r.map} ${r.mode}: every claimed item's binding carries the frame's own item (an extra exactly when it differs from the root's)`);
  assert.ok(r.extraClaims > 0 && r.sharedClaims > 0, `${r.map} ${r.mode}: frames share the root's bindings for equal items (${r.sharedClaims}) and have extras for the others (${r.extraClaims})`);
  assert.ok(r.extraDrawnClaims === 0 || r.extraChildDraws > 0, `${r.map} ${r.mode}: the page draws the extras that a child frame's Frame->Sprite holds in its pass (${r.extraDrawnClaims} held, ${r.extraChildDraws} drawn)`);
  assert.equal(r.extraMainDraws, 0, `${r.map} ${r.mode}: and never in the root frame's pass`);
  assert.ok(r.differing > 0, `${r.map}: some child frame's items differ from the root's (the savedLoc item): ${r.differing} of ${r.itemFrames} frames' items`);
}
console.log('validate-iterator-frames-play: PASS (' + reports.filter(r => r.mode === 'on').map(r =>
  `${r.map}: ${r.rescans} reruns for ${r.visited} child frames${r.particles ? `, ${r.spriteRecords} particle records, ${r.childOnly} of their own` : `, ${r.differing} items differ, ${r.extraClaims} drawn through bindings of their own (${r.extraDrawnClaims} in a frame's Frame->Sprite, ${r.extraChildDraws} page draws), ${r.sharedClaims} shared`}`).join('; ') + ')');
