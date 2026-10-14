/** Decals on the original's vertex chain in Play's default worker mode
 * (docs/frame-projection.md "Decals"). ClipDecal's fragments (decal-draw.mjs)
 * project through fpView and fpClipDecal like the surfaces they lie on
 * (Render.dll 0x10b1c5fd..0x10b1c825: Frame->Coords, RZ, ScreenX/ScreenY, the
 * clamp of a flagged point; D3DDrv DrawGouraudPolygon's vertex), instead of the
 * page camera's matrices.
 *
 * On 00_Training the player looks at JaimeReyes0's feet (the pawn's Shadow
 * decal) and, in a second view, at a tracked mover's fragment with a BulletHole
 * spawned on it. The frame is frozen (window blurred) and drawn four ways:
 *   A  vertex stage on, decals drawn      B  stage off (camera matrices), decals
 *   D  stage on, decal layer hidden       E  stage off, decal layer hidden
 * A against D is the decal's coverage with the chain, B against E with the
 * camera; the two coverages differ only at the fragments' edges. The frame the
 * page drew with is read back: the uniforms hold the master frame's PrjXM..PrjYP.
 *
 *   node scripts/validate-decal-vertices-play.mjs */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { gameDirectory } from './game-directory.mjs';

try { gameDirectory(); } catch { console.log('SKIP validate-decal-vertices-play: no installed game data'); process.exit(0); }
const dir = fileURLToPath(new URL('..', import.meta.url));
const { default: base } = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && dir.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && dir.includes('/.claude/worktrees/')));
const server = await createServer({ ...base, configFile: false, root: dir, logLevel: 'error',
  server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`] });
const wordFloat = word => { const u = new Uint32Array([word >>> 0]); return new Float32Array(u.buffer)[0]; };
const summary = [];
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  // The decal scene, appended to the module the page runs (nothing in it is replaced).
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.__deusDecals={get decals(){return decalScene;}};\n` });
  });
  await page.goto(url);
  await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === '00_Training'; }, {}, { timeout: 300000 });
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const shot = () => page.locator('#scene').screenshot();
  const compare = await browser.newPage();
  let size = { width: 0, height: 0 };
  const masks = (a, b, c, d) => compare.evaluate(async images => {
    const load = async base64 => {
      const bytes = Uint8Array.from(atob(base64), ch => ch.charCodeAt(0)), bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const [A, B, D, E] = await Promise.all(images.shots.map(load));
    const out = { pixels: A.length / 4, decalOn: 0, decalOff: 0, differ: 0, stage: 0, darker: 0, brighter: 0, edgeOn: 0, edgeOff: 0, edgeDiffer: 0 };
    const width = images.width;
    const different = (p, q, i) => p[i] !== q[i] || p[i + 1] !== q[i + 1] || p[i + 2] !== q[i + 2];
    for (let i = 0; i < A.length; i += 4) {
      const on = different(A, D, i), off = different(B, E, i);
      out.decalOn += on; out.decalOff += off; out.differ += on !== off; out.stage += different(A, B, i);
      // The frame's right edge columns and bottom rows (ClipDecal's clamp acts there).
      const x = (i / 4) % width, y = Math.floor(i / 4 / width);
      if (x >= width - 3 || y >= images.height - 3) { out.edgeOn += on; out.edgeOff += off; out.edgeDiffer += on !== off; }
      if (on) { const a = A[i] + A[i + 1] + A[i + 2], d = D[i] + D[i + 1] + D[i + 2]; if (a < d) out.darker++; else if (a > d) out.brighter++; }
    }
    return out;
  }, { shots: [a, b, c, d].map(image => image.toString('base64')), width: size.width, height: size.height });
  const view = async (label, minimum) => {
    await frames(40);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await frames(6);
    const state = await page.evaluate(() => ({ drawn: window.deusExViewer.decals()?.drawnTriangles ?? 0, fp: window.deusExViewer.vertexProjection(),
      master: window.deusExViewer.visibility()?.master ?? null }));
    assert.ok(state.drawn > 0, `${label}: the page draws decal triangles`);
    // The uniforms hold the master frame's Prj terms (the main pass was the last to project).
    assert.ok(state.master?.prj, `${label}: the master frame carries PrjXM..PrjYP`);
    const prj = state.master.prj.map(wordFloat);
    assert.deepEqual(state.fp.prj, prj, `${label}: the shader's PrjXM..PrjYP are the master frame's`);
    const set = async (stage, decals) => {
      await page.evaluate(([stage, decals]) => { window.deusExViewer.vertexProjection(stage); window.__deusDecals.decals.root.visible = decals; }, [stage, decals]);
      await frames(4);
      return shot();
    };
    let settled = false, a = await set(true, true);
    for (let attempt = 0; attempt < 8 && !settled; attempt++) {
      await frames(6);
      const again = await shot();
      settled = Buffer.compare(a, again) === 0;
      a = again;
    }
    assert.ok(settled, `${label}: the frozen frame settles`);
    const b = await set(false, true), d = await set(true, false), e = await set(false, false);
    const again = await set(true, true);
    assert.equal(Buffer.compare(a, again), 0, `${label}: drawn twice with the chain`);
    await page.evaluate(() => { window.deusExViewer.vertexProjection(true); window.__deusDecals.decals.root.visible = true; window.dispatchEvent(new Event('focus')); });
    const box = await page.locator('#scene').boundingBox();
    size = { width: Math.round(box.width), height: Math.round(box.height) };
    const m = await masks(a, b, d, e);
    assert.ok(m.decalOn > minimum && m.darker > 3 * m.brighter, `${label}: the decal darkens the frame (${m.decalOn} pixels, ${m.darker} darker)`);
    // The chain and the camera cover the same fragments: they differ at edges, by a small share of the decal's pixels.
    assert.ok(m.differ <= 0.2 * m.decalOn, `${label}: chain and camera coverage differ in ${m.differ} of ${m.decalOn} decal pixels`);
    summary.push(`${label}: ${state.drawn} decal triangles, decal pixels ${m.decalOn} with the chain and ${m.decalOff} with the camera, coverage differs in ${m.differ}`
      + ` (frame edge: ${m.edgeOn} with the chain, ${m.edgeOff} with the camera, differing in ${m.edgeDiffer}); `
      + `whole frame chain vs camera ${m.stage} pixels (${m.darker} of the decal's darker, ${m.brighter} brighter)`);
  };
  // 1: the pawn's Shadow.
  await page.evaluate(() => window.deusExViewer.decalProbe({ place: true }));
  await frames(60);
  await view('JaimeReyes0 shadow', 100);
  // 1b: the same shadow at the frame's right edge (a flagged point's screen position is clamped).
  const aimed = await page.evaluate(() => window.deusExViewer.placeProbe({ lookAt: 'JaimeReyes0' }));
  let edge = null;
  const box = await page.locator('#scene').boundingBox();
  size = { width: Math.round(box.width), height: Math.round(box.height) };
  for (const sign of [1, -1]) for (let offset = 4000; offset <= 8300 && edge === null; offset += 100) {
    await page.evaluate(rotation => window.deusExViewer.placeProbe({ rotation }), [aimed.rotation[0], (aimed.rotation[1] + sign * offset + 65536) & 0xffff, 0]);
    await frames(25);
    await page.evaluate(() => { window.__deusDecals.decals.root.visible = true; });
    await frames(2);
    const withDecals = await shot();
    await page.evaluate(() => { window.__deusDecals.decals.root.visible = false; });
    await frames(2);
    const without = await shot();
    await page.evaluate(() => { window.__deusDecals.decals.root.visible = true; });
    const m = await masks(withDecals, withDecals, without, without);
    if (m.edgeOn >= 3) edge = sign * offset;
  }
  if (edge === null) summary.push('no yaw put the shadow at the frame\'s edge in this run (the pawn walks)');
  else await view(`JaimeReyes0 shadow at the edge (yaw ${edge})`, 10);
  // 2: a BulletHole on a tracked mover's fragment.
  const placed = await page.evaluate(() => window.deusExViewer.moverDecalProbe({ place: true }));
  await frames(20);
  const spawned = await page.evaluate(() => window.deusExViewer.moverDecalProbe({ spawn: true }));
  assert.ok(spawned.decal, 'the BulletHole spawns');
  await frames(10);
  await view(`BulletHole on ${placed.mover}`, 10);
  assert.deepEqual(errors, [], 'page errors');
} finally { await browser.close(); await server.close(); }
console.log(summary.join('\n'));
console.log('validate-decal-vertices-play: ok');
