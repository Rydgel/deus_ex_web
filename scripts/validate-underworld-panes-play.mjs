// The three one-way panes of 06_HongKong_WanChai_Underworld's dance floor (BreakableGlass0, 5 and 17: Mirrored|Unlit|Semisolid,
// one coplanar polygon each, side by side) reflect together in the original; Play showed one of them and left the others as their
// own flat cloudy texture, which one depending on the view.
//
// The original's OccludeBsp passes iSurf 0 in every mirror request (Render.dll 0x10b18b4a, `push 0x0` before the call through the
// vtable slot 0x68), and CreateChildFrame (0x10b15a40) merges a request into a child of the same parent whose iSurf, zone and
// NearClip all equal the request's. The three panes' polygons are different surfaces but one plane in one zone, so their three
// requests make ONE child frame: its span is the union of the three polygons' spans and the frame looks through all three
// (validate-child-frames.mjs compares each request's frame with what the original's CreateChildFrame returns). Play planned
// one pass per frame, through the group of the request that made the frame, so only that pane (the first in the BSP's
// front-to-back order, which changes with the view) was drawn with the reflected child.
//
// Per view (worker mode, ghost, level frozen as in the live acceptance):
// - every pane OccludeBsp asked for (the main frame's mirror requests) is among the requests of one depth-1 mirror frame, and that
//   frame is the only one at depth 1 (one plane, one zone);
// - every one of those panes' groups draws its reflected child (`active`), and no other pane does;
// - the same after a visit to the office behind the panes and back (nothing persists in a pane's reflection from one frame to the
//   next: the OccludeBsp state, the zone render times and the brush tracker came back unchanged).
//
//   node scripts/validate-underworld-panes-play.mjs [--url http://...] [--shots DIR]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {mkdirSync} from 'node:fs';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-underworld-panes-play: no installed game data'); process.exit(0); }
let server = null, url = option('url', null);
const shots = option('shots', null);
if (shots) mkdirSync(shots, {recursive: true});
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
const map = '06_HongKong_WanChai_Underworld', PANES = ['BreakableGlass0', 'BreakableGlass5', 'BreakableGlass17'];
const paneKey = name => `${name}:1`;
// Eyes (Location, ghost: the eye is Location + 40) on the dance floor and yaws toward the panes. `first` is the pane OccludeBsp
// requests first (front to back), the one the old plan reflected.
const VIEWS = [
  {at: [-1024, -1650, -336], yaw: 49152, first: 'BreakableGlass5'},   // the middle pane reflects, the sides grey (the user's report)
  {at: [-1300, -1650, -336], yaw: 52000, first: 'BreakableGlass0'},
  {at: [-760, -1400, -336], yaw: 46000, first: 'BreakableGlass17'},
  {at: [-1120, -1900, -336], yaw: 55000, first: 'BreakableGlass5'},    // two of the three in view
  {at: [-1300, -1650, -336], yaw: 49152, first: 'BreakableGlass0'},    // two of the three in view
  {at: [-1300, -1900, -336], yaw: 58000, first: 'BreakableGlass0'},
  {at: [-900, -1500, -336], yaw: 43000, first: 'BreakableGlass5'},
  {at: [-1300, -1400, -336], yaw: 46000, first: 'BreakableGlass0'},
  {at: [-760, -1400, -336], yaw: 55000, first: 'BreakableGlass17'},    // one pane in view: no merging
];
const OFFICE = [[-700, -2400, -336, 16384], [-700, -2400, -336, 49152], [-1024, -2200, -336, 16384]];
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
const rows = [];
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url}/?hold=1&seed=1`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, map, {timeout: 300000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  await page.evaluate(() => window.deusExViewer.viewProbe({playersOnly: true, timeDilation: 1}));
  await page.evaluate(() => window.deusExViewer.release());
  await frames(10);
  await page.evaluate(() => window.deusExViewer.viewProbe({ghost: true}));
  await frames(20);
  const look = async (at, yaw, settle = 8) => {
    await page.evaluate(a => window.deusExViewer.viewProbe(a), {location: at, rotation: [0, yaw, 0]});
    await frames(settle);
    return page.evaluate(() => window.deusExViewer.visibility());
  };
  const inspect = (view, seen, tag) => {
    // In OccludeBsp's request order (front to back): the first made the frame.
    const requested = seen.mirrors.filter(key => PANES.some(name => key === paneKey(name))).map(key => key.slice(0, -2));
    const depthOne = seen.frames.filter(f => f.parent === 0 && f.kind === 'mirror');
    const active = new Map(seen.groups.map(g => [g.key, g.active]));
    return {tag, at: view.at, yaw: view.yaw, requested, frames: depthOne.map(f => f.requests.map(r => r.group ?? r.iNode)),
      active: PANES.filter(name => active.get(paneKey(name))), depthOne};
  };
  const check = row => {
    const where = `${row.tag} view ${JSON.stringify(row.at)} yaw ${row.yaw}`;
    if (!row.requested.length) { assert.deepEqual(row.active, [], `${where}: no pane is requested, none reflects`); return; }
    // One plane in one zone: one depth-1 frame, whose requests are the panes OccludeBsp asked for (a request merges into the
    // frame of equal iSurf 0, zone and NearClip).
    assert.equal(row.depthOne.length, 1, `${where}: the requested panes share one child frame (${JSON.stringify(row.frames)})`);
    const keys = row.depthOne[0].requests.map(r => r.group).filter(Boolean);
    assert.deepEqual(keys, row.requested.map(paneKey), `${where}: the frame holds every requested pane's request`);
    // Each of them draws its reflected child, not its own surface.
    assert.deepEqual([...row.active].sort(), [...row.requested].sort(), `${where}: every requested pane draws the reflection (${JSON.stringify(row.active)} of ${JSON.stringify(row.requested)})`);
  };
  let shot = 0;
  const run = async tag => {
    for (const view of VIEWS) {
      const row = inspect(view, await look(view.at, view.yaw), tag);
      if (shots && tag === 'before' && shot < 3) await page.screenshot({path: `${shots}/underworld-panes-${shot++}.png`});
      check(row); rows.push(row);
    }
  };
  await run('before');
  const merged = rows.filter(r => r.requested.length >= 2);
  assert.ok(merged.length >= 6, `${merged.length} of the views ask for two or more panes (the merged case is exercised)`);
  assert.ok(rows.some(r => r.requested.length === 3) && rows.some(r => r.requested.length === 2) && rows.some(r => r.requested.length === 1),
    'views with one, two and three requested panes');
  assert.deepEqual(new Set(merged.map(r => r.requested[0])), new Set(PANES), 'each pane is the first request somewhere (the pane the old plan reflected)');
  for (const [i, view] of VIEWS.entries()) assert.equal(rows[i].requested[0], view.first, `view ${i}: OccludeBsp requests ${view.first} first`);
  for (const [x, y, z, yaw] of OFFICE) await look([x, y, z], yaw, 12);
  const before = rows.length;
  await run('after the office');
  for (let i = 0; i < VIEWS.length; i++) {
    const a = rows[i], b = rows[before + i];
    assert.deepEqual([b.requested, b.frames, b.active], [a.requested, a.frames, a.active], `view ${i}: the same requests, frame and reflections after the visit`);
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`validate-underworld-panes-play: ${VIEWS.length} views, ${merged.length} with two or three panes requested: each shares one child frame with every requested pane's request and all of them draw the reflection, before and after a visit to the office`);
} finally { await browser.close(); await server?.close(); }
