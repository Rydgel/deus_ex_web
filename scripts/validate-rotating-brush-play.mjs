/** The spinning AC fans of 09_NYC_ShipFan in Play's default worker mode (docs/rotating-brushes.md "Rendering").
 *
 * DeusExMover1, 2 and 3 carry a RotationRate and bFixedRotationDir in the map, so AActor::performPhysics' tail turns them every tick
 * through ULevel::MoveActor. The page draws a mover with the vertices the moving brush tracker wrote (docs/frame-projection.md
 * "Movers"); the tracker is updated each frame from the actor's Location and Rotation. Checks:
 *   1  the tracker rebuilds each fan between two frame sets (its revision grows) and its transformed vertices change;
 *   2  every vertex of the page's mover meshes holds, as float bits, the tracker's transformed vertex (moverVertexProbe), before and after;
 *   3  the turn is a rotation about the vertical axis for the yaw fan (DeusExMover1): the polygon centroid keeps its distance to the axis and
 *      its height while the angle changes, in the direction of the RotationRate sign (negative yaw rate: clockwise seen from above).
 *
 *   node scripts/validate-rotating-brush-play.mjs [--map 09_NYC_ShipFan] */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { gameDirectory } from './game-directory.mjs';
import { debugUrl } from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-rotating-brush-play: no installed game data'); process.exit(0); }
const map = option('map', '09_NYC_ShipFan');
const dir = fileURLToPath(new URL('..', import.meta.url));
const { default: base } = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && dir.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && dir.includes('/.claude/worktrees/')));
const server = await createServer({ ...base, configFile: false, root: dir, logLevel: 'error',
  server: { ...base.server, port: 0, strictPort: false, fs: { ...base.server.fs, deny }, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ channel: 'chromium', args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`] });
const FANS = ['DeusExMover1', 'DeusExMover2', 'DeusExMover3'], AXIS = [32, 48];   // DeusExMover1's authored Location X, Y (census)
const centroid = points => { const c = [0, 0, 0]; const n = points.length / 3; for (let i = 0; i < points.length; i += 3) for (let k = 0; k < 3; k++) c[k] += points[i + k] / n; return c; };
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 640 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // The new headless Chromium asks for /favicon.ico (a 404 console line); no other 404 is expected.
  page.on('console', message => { if (message.type() === 'error' && !/status of 404/.test(message.text())) errors.push(message.text()); });
  await page.goto(debugUrl(url));
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, { timeout: 240000 });
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, map, { timeout: 300000 });
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const probe = args => page.evaluate(a => window.deusExViewer.moverProbe(a), args);
  const vertices = movers => page.evaluate(m => window.deusExViewer.moverVertexProbe(m), movers);
  await frames(30);
  const first = await probe({ points: true });
  assert.ok(first.tracker, 'the moving brush tracker runs');
  await frames(45);
  const second = await probe({ points: true });
  const report = [];
  for (const name of FANS) {
    const a = first.movers.find(m => m.name === name), b = second.movers.find(m => m.name === name);
    assert.ok(a && b, `${name} is a tracked mover`);
    assert.ok(b.revision > a.revision, `${name} was rebuilt by the tracker (revision ${a.revision} -> ${b.revision})`);
    const pa = Array.from(a.points), pb = Array.from(b.points);
    assert.equal(pa.length, pb.length);
    assert.ok(pa.some((v, i) => v !== pb[i]), `${name}'s transformed vertices changed`);
    report.push(`${name} revision ${a.revision}->${b.revision}`);
    if (name === 'DeusExMover1') {
      // The yaw fan (RotationRate yaw -20000, 20000/65536 turns per second): the centroid turns about the fan's own Location axis.
      const ca = centroid(pa), cb = centroid(pb);
      // 2: a frozen frame (deusExViewer.freeze(): the simulation halts and the page keeps the last frame), the tracker's points read in the same instant.
      await page.evaluate(() => (window.dispatchEvent(new Event('blur')), window.deusExViewer.freeze()));
      await frames(10);
      const frozen = await probe({ points: true });
      const rows = await vertices(frozen.movers.filter(m => FANS.includes(m.name)).map(m => ({ name: m.name, points: m.points })));
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      for (const row of rows) { assert.ok(row.vertices > 0, `${row.name}: mesh vertices`); assert.equal(row.equal, row.vertices, `${row.name}: the page holds the tracker's vertices (${row.equal} of ${row.vertices})`); }
      report.push(`page vertices equal the tracker's on ${rows.length} fans (${rows.reduce((s, r) => s + r.vertices, 0)} vertices)`);
      // 3: a turn about the vertical axis through the actor's Location (32, 48): the centroid keeps its distance and height, and its angle atan2(y, x) falls (a negative yaw rate).
      const polar = c => [Math.hypot(c[0] - AXIS[0], c[1] - AXIS[1]), Math.atan2(c[1] - AXIS[1], c[0] - AXIS[0]), c[2]];
      const [ra, ta, za] = polar(ca), [rb, tb, zb] = polar(cb);
      assert.ok(Math.abs(ra - rb) < 0.5 && Math.abs(za - zb) < 0.5, `the yaw fan's centroid stays on its circle (${ra.toFixed(2)} -> ${rb.toFixed(2)}, z ${za.toFixed(2)} -> ${zb.toFixed(2)})`);
      let turn = (tb - ta) % (2 * Math.PI); if (turn > Math.PI) turn -= 2 * Math.PI; if (turn < -Math.PI) turn += 2 * Math.PI;
      assert.ok(turn < 0, `the centroid's angle atan2(y, x) falls with a negative yaw rate (${turn})`);
      report.push(`yaw fan: centroid radius ${ra.toFixed(2)}, turned ${(turn * 180 / Math.PI).toFixed(1)} degrees of atan2(y, x) between the probes`);
    }
  }
  assert.deepEqual(errors, [], 'page errors');
  console.log(`PASS validate-rotating-brush-play ${map}: ${report.join('; ')}`);
  await page.close();
} finally {
  await browser.close();
  await server.close();
}
