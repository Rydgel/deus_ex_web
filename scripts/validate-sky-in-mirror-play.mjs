// A sky frame inside a mirror frame draws its own Frame->Sprite actors in Play
// (docs/bsp-occlusion.md "Child frames"). The shipped maps hold no actor in a
// sky zone (the census in the doc), so the fixture stands one there: on
// 00_Training, facing the entrance floor mirror, whose reflection shows the
// sky through the ceiling opening (OccludeBsp makes a sky child frame inside
// the mirror frame), a plant is moved to the sky frame's own view
// (SetupDynamics' candidates reach it through that frame's raster).
//
// The simulation runs in the worker (the default): placeProbe and moverProbe
// act there, and the page's renderer reports, per render call, which actor
// bindings are shown. Checks:
// - the sky frame's Frame->Sprite holds the plant and no other frame's does;
// - the plant is stamped (LastRenderTime) as DrawActorSprite would;
// - the page draws it in the sky frame's pass, with that frame's own camera
//   (the SkyZone's Location), and not in the mirror's or the main pass;
// - the mirror frame's actors are shown again for the mirror's own pass.
//
//   node scripts/validate-sky-in-mirror-play.mjs [--url http://...] [--shots DIR]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-sky-in-mirror-play: no installed game data'); process.exit(0); }
const shots = option('shots', null), query = option('query', '');
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
const map = '00_Training';
// The entrance floor mirror seen at a slant: a sky frame is made inside the mirror frame.
const VIEW = {location: [-1149, 1200, -85], rotation: [65536 - 9000, 57344, 0]};
const CANDIDATES = ['Plant7', 'Plant8', 'Plant9', 'Plant11', 'Plant12', 'Plant14', 'Plant15', 'Plant0', 'Plant1'];
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
let report;
try {
  const page = await browser.newPage({viewport: {width: 1024, height: 640}});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    await route.fulfill({response, body: (await response.text()) +
      '\nwindow.__deusSky={get visible(){return lastVisibility;},get npc(){return npcPreview;},renderer,scene};\n'});
  });
  await page.goto(`${url.replace(/\/$/, '')}/${query ? `?${query}` : ''}`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 240000});
  await page.waitForTimeout(3000);
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  // The last frame's child frames (plain data) and the master frame's size.
  const frameInfo = () => page.evaluate(() => {
    const v = window.__deusSky.visible;
    return v && {master: {render: v.master.render, fov: v.master.fov},
      frames: (v.frames ?? []).map(f => ({index: f.index, parent: f.parent, kind: f.kind, coords: f.coords, bounds: f.bounds, main: f.main ? [...f.main] : []}))};
  });
  const probe = args => page.evaluate(args => window.deusExViewer.moverProbe(args), args);
  // The spot is outside the world (zone 0, no leaf): physWalking's zone-0
  // branch would have the player fall out of it and die, and the Dying
  // state's PlayerCalcView would move the camera. PHYS_None keeps the view.
  await page.evaluate(view => window.deusExViewer.placeProbe(view), {...VIEW, set: {actor: '$player', fields: {Physics: 0}}});
  await frames(40);
  let info = await frameInfo();
  const mirror = info.frames.find(f => f.kind === 'mirror' && f.parent === 0);
  const sky = info.frames.find(f => f.kind === 'sky' && f.parent === mirror?.index);
  assert.ok(mirror && sky, `a sky frame inside a mirror frame: ${JSON.stringify(info.frames.map(f => [f.index, f.parent, f.kind]))}`);
  assert.equal(sky.main.length, 0, 'no actor stands in the sky zone of the shipped map');
  // The sky frame's own view: a point `depth` units along the ray through a pixel of its span.
  const [width, height] = info.master.render, fx2 = width / 2, fy2 = height / 2;
  const projZ = fx2 / Math.tan(info.master.fov * Math.PI / 360);
  const [minX, startY, maxX, endY] = sky.bounds, c = sky.coords;
  const world = (px, py, depth) => {
    const x = (px - fx2) * depth / projZ, y = (py - fy2) * depth / projZ;
    return [0, 1, 2].map(k => c[k] + c[3 + k] * x + c[6 + k] * y + c[9 + k] * depth);
  };
  // A plant no pass drew in the last seconds, so that a stamp now is the sky frame's.
  const before = (await probe({renderTimes: true})).renderTimes, time0 = (await page.evaluate(() => window.deusExViewer.laserProbe())).time;
  const name = CANDIDATES.find(n => before[n] !== undefined && time0 - before[n] > 1);
  assert.ok(name, `a plant not drawn recently: ${JSON.stringify(CANDIDATES.map(n => [n, before[n]]))}`);
  let placed = null, member = null;
  search: for (const depth of [300, 200, 120, 80, 40]) for (const [i, j] of [[3, 3], [2, 2], [4, 4], [2, 4], [4, 2], [1, 1], [5, 5], [1, 5], [5, 1]]) {
    const at = world(minX + (maxX - minX) * i / 6, startY + (endY - startY) * j / 6, depth);
    await probe({set: [{name, location: at}]});
    await frames(6);
    info = await frameInfo();
    const frame = info.frames.find(f => f.index === sky.index);
    if (frame?.main.length) { placed = at; member = frame.main; break search; }
  }
  assert.ok(placed, `the plant ${name} reached the sky frame's Frame->Sprite`);
  assert.equal(member.length, 1, 'the sky frame draws only the plant');
  // Which frames' Frame->Sprite hold it, and the stamp.
  const holders = info.frames.filter(f => f.main.includes(member[0])).map(f => f.index);
  const time1 = (await page.evaluate(() => window.deusExViewer.laserProbe())).time;
  const stamped = (await probe({renderTimes: true})).renderTimes[name];
  // The renderer's calls over the next frames: each one's camera and which binding roots are shown.
  await page.evaluate(() => {
    const d = window.__deusSky, original = d.renderer.render.bind(d.renderer);
    d.calls = [];
    d.renderer.render = (scene, camera) => {
      const shown = [...(d.npc?.draw.bindings ?? [])].filter(([, draw]) => draw.root.visible).map(([id]) => id);
      d.calls.push({position: camera.position.toArray(), shown});
      return original(scene, camera);
    };
    d.restore = () => { d.renderer.render = original; };
  });
  if (option('debug', null)) await page.evaluate(id => {
    const d = window.__deusSky, pass = d.npc.draw.pass.bind(d.npc.draw);
    d.passes = [];
    d.npc.draw.pass = (decisions, position, light) => { const x = decisions.get(id);
      d.passes.push({position, plant: x && {root: x.root, groups: x.groups, frame: x.frame, lit: Boolean(x.lighting || x.colors)}, count: decisions.size, light: light && light.origin });
      return pass(decisions, position, light); };
  }, member[0]);
  await frames(4);
  if (option('debug', null)) console.log(JSON.stringify(await page.evaluate(() => window.__deusSky.passes.slice(0, 8))));
  const calls = await page.evaluate(() => { const d = window.__deusSky; d.restore(); return d.calls; });
  // The pixels the plant changes: the frame with it in the sky against the same
  // frame with it moved out of the world (and, as the noise of the moving
  // scene, that frame against a later one). The plant's pixels lie inside the
  // sky frame's span, seen in the floor mirror (its raster is mirrored on the
  // screen), which is a large part of the view here.
  const withPlant = await page.screenshot();
  if (shots) await page.screenshot({path: `${shots}/sky-in-mirror-with-plant.png`});
  await probe({set: [{name, location: placed.map((v, k) => v + (k === 2 ? -30000 : 0))}]});
  await frames(8);
  const without = await page.screenshot();
  if (shots) await page.screenshot({path: `${shots}/sky-in-mirror-without-plant.png`});
  await frames(8);
  const later = await page.screenshot();
  const canvas = await page.evaluate(() => { const r = (document.querySelector('#scene canvas') ?? document.querySelector('canvas')).getBoundingClientRect();
    return {left: r.left, top: r.top, width: r.width, height: r.height}; });
  // The 3D view fills the canvas here (the render rectangle is the viewport's).
  assert.deepEqual([Math.round(canvas.width), Math.round(canvas.height)], [width, height], 'the render rectangle is the canvas');
  const expected = [canvas.left + width - maxX, canvas.top + startY, canvas.left + width - minX, canvas.top + endY];
  const checker = await browser.newPage();
  const compare = (a, b) => checker.evaluate(async ([a, b, box]) => {
    const load = async data => { const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height); };
    const [x, y] = await Promise.all([load(a), load(b)]);
    let inside = 0, outside = 0;
    for (let i = 0; i < x.data.length; i += 4) {
      if (Math.max(Math.abs(x.data[i] - y.data[i]), Math.abs(x.data[i + 1] - y.data[i + 1]), Math.abs(x.data[i + 2] - y.data[i + 2])) <= 3) continue;
      const px = (i / 4) % x.width, py = Math.floor(i / 4 / x.width);
      if (px >= box[0] - 6 && px <= box[2] + 6 && py >= box[1] - 6 && py <= box[3] + 6) inside++; else outside++;
    }
    return {inside, outside};
  }, [a.toString('base64'), b.toString('base64'), expected]);
  const difference = await compare(withPlant, without), noise = await compare(without, later);
  // The sky camera sits at the SkyZone's Location (the frame's own origin).
  const skyPosition = [c[1], c[2], -c[0]];
  const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-2);
  const skyCalls = calls.filter(call => near(call.position, skyPosition));
  const others = calls.filter(call => !near(call.position, skyPosition));
  report = {name, placed, holders, stamped, time0, time1, baseline: before[name], calls: calls.length, skyCalls: skyCalls.length,
    shownInSky: skyCalls.map(call => call.shown.includes(member[0])), shownElsewhere: others.map(call => call.shown.includes(member[0])),
    skyShown: skyCalls.map(call => call.shown.length), difference, noise, expected, errors};
} finally { await browser.close(); await server?.close(); }
console.log(JSON.stringify(report, null, 1));
assert.deepEqual(report.errors, []);
assert.deepEqual(report.holders.length, 1, 'only the sky frame holds the plant');
assert.ok(report.time1 - report.stamped < 0.5, 'DrawActorSprite stamps the sky frame\'s actor');
assert.ok(report.skyCalls >= 1, 'the page drew the sky frame with its own camera');
assert.ok(report.shownInSky.every(Boolean), 'the plant is shown in the sky frame\'s pass');
assert.ok(report.shownElsewhere.length >= 1 && report.shownElsewhere.every(shown => !shown),
  'the plant is shown in no other pass: the mirror and main passes put their own actors back');
assert.ok(report.difference.inside > 500 && report.difference.inside > 3 * report.noise.inside,
  `the plant changes the reflection in the sky frame's span (${report.difference.inside} pixels differ, ${report.noise.inside} by the moving scene)`);
console.log(`validate-sky-in-mirror-play: PASS (${report.name} drawn in the sky frame ${report.holders[0]}, ${report.skyCalls} sky passes, ${report.difference.inside} pixels changed in its span)`);
