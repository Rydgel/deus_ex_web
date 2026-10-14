// A strobe-lit surface drawn only in a mirror's child frame still flips the Strobe flag (docs/mesh-lighting.md "One Strobe flag",
// docs/visual-acceptance.md Divergence 19 "Not reached").
//
// Render.dll's DrawFrame (0x10b1a2d0) draws a frame's child frames first (the loop at 0x10b1a339 calls it on Frame->Child and the
// siblings through 0x10b0102d) and then sets up the frame's own surfaces, SetupForSurf through the light manager at 0x10b1aa99. The
// Strobe light-type function runs inside that setup for every surface whose light list holds a live Strobe light, whichever frame
// draws the surface, so a mirror's reflection of a strobe-lit floor flips the flag although the main frame draws none. Play's
// lightMapStrobe first read only the main frame's drawn nodes.
//
// The scene is the Underworld club's own, from an aimed view: the camera (-1081, -2010, -336) at yaw 54769 stands 230 units from the map's
// Strobe light (TriggerLight1) and looks at the floor mirrors; the main frame draws no surface whose light list holds TriggerLight1
// (the mirror and the walls ahead have no static light of it), the mirror's child frame draws 24 surfaces that do. The club's dancers
// (ScriptedPawns, lit by the same light) are hidden (`set ScriptedPawn bHidden True`, as the original's console does the same) so that
// SetupForActor's own Strobe calls do not flip the flag first: every flip below is a light-map call.
//
// What this checks in Play (worker mode, ghost, level frozen as in the live acceptance):
// 1. The reach (strobeProbe): at the aimed camera the main frame lists TriggerLight1 in 0 drawn surfaces and a child frame in at least 1,
//    and the scan lightMapStrobe records (main frame 0, child frame > 0).
// 2. The flag flips at every new TimeSeconds there (24 frames), as it does at a direct view (d: strobe-lit surfaces in the main frame) and
//    not at a wall view that no frame lights (p2).
// 3. Failing baseline (strobeProbe mainOnly: the first version's scan): no flip at the aimed camera, so the scene discriminates the change;
//    d still flips.
//
//   node scripts/validate-strobe-child-frames-play.mjs [--url http://...]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-strobe-child-frames-play: no installed game data'); process.exit(0); }
let server = null, url = option('url', null);
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
const map = '06_HongKong_WanChai_Underworld', light = 'TriggerLight1';
// Eyes (Location, ghost: the eye is Location + 40).
const VIEWS = {m: [[-1081, -2010, -336], 54769], d: [[-1120, -1900, -336], 55000], p2: [[-700, -2000, -336], 49152]};
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // The page's frame loop keeps each frame's light state (time, flag) in window.__lights, so a sample sees every frame.
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    let body = await response.text();
    const hook = 'if (frame.light) world.beginLightFrame(frame.light);';
    if (!body.includes(hook)) throw new Error(`the frame-log patch no longer matches main.mjs: ${hook}`);
    body = body.replace(hook, `${hook} if (frame.light) (window.__lights ??= []).push([frame.light.timeSeconds, frame.light.strobe?.flag ?? null]);`);
    await route.fulfill({response, body});
  });
  await page.goto(`${url}/?hold=1&seed=1`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  await page.locator('#map').selectOption(map);
  await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, map, {timeout: 300000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const probe = args => page.evaluate(a => window.deusExViewer.viewProbe(a), args);
  const strobeProbe = args => page.evaluate(a => window.deusExViewer.strobeProbe(a), args);
  await probe({playersOnly: true, timeDilation: 1});
  await page.evaluate(() => window.deusExViewer.release());
  await frames(10);
  await probe({ghost: true, exec: ['set ScriptedPawn bHidden True']});
  await frames(30);
  await strobeProbe({always: true});

  // The flag's flips per new TimeSeconds over 24 frames at a camera, and the scan the last of those frames recorded.
  const look = async name => {
    const [at, yaw] = VIEWS[name];
    await probe({location: at, rotation: [0, yaw, 0]});
    await frames(12);
    await page.evaluate(() => { window.__lights = []; });
    await frames(24);
    const log = await page.evaluate(() => window.__lights);
    let steps = 0, flips = 0;
    for (let i = 1; i < log.length; i++) {
      if (log[i][0] === log[i - 1][0]) continue;
      steps++;
      if (log[i][1] !== log[i - 1][1]) flips++;
    }
    const reach = await strobeProbe({reach: true});
    return {steps, flips, scan: reach.scan, reach: reach.frames};
  };
  const seen = {};
  for (const mainOnly of [false, true]) {
    await strobeProbe({mainOnly});
    for (const name of Object.keys(VIEWS)) {
      const r = await look(name);
      (seen[mainOnly ? 'mainOnly' : 'frames'] ??= {})[name] = {steps: r.steps, flips: r.flips, scan: r.scan?.frames, reach: r.reach?.map(f => f[light] ?? 0)};
      assert.ok(r.steps >= 15, `${name}: the level advanced in ${r.steps} frames`);
      if (mainOnly) {
        // the first version: the main frame's surfaces alone
        if (name === 'm') assert.equal(r.flips, 0, `${name}: the main frame draws no strobe-lit surface: no flip without the child frames (${r.flips} of ${r.steps})`);
        if (name === 'd') assert.equal(r.flips, r.steps, `${name}: the main frame draws strobe-lit surfaces (${r.flips} of ${r.steps})`);
        continue;
      }
      assert.ok(r.reach, `${name}: no reach`);
      if (name === 'm') {
        assert.equal(r.reach[0][light] ?? 0, 0, `${name}: the main frame draws surfaces listing ${light}`);
        assert.ok(r.reach.length > 1 && r.reach.slice(1).some(frame => (frame[light] ?? 0) > 0), `${name}: no child frame draws a surface listing ${light}`);
        assert.equal(r.scan.frames[0], 0, `${name}: the scan found strobe-lit nodes in the main frame`);
        assert.ok(r.scan.frames.slice(1).some(n => n > 0), `${name}: the scan found no strobe-lit node in a child frame`);
        assert.equal(r.flips, r.steps, `${name}: the flag flips at every new TimeSeconds through the child frame (${r.flips} of ${r.steps})`);
      }
      if (name === 'd') assert.equal(r.flips, r.steps, `${name}: the flag flips at every new TimeSeconds (${r.flips} of ${r.steps})`);
      if (name === 'p2') assert.equal(r.flips, 0, `${name}: no frame draws a strobe-lit surface: no flip (${r.flips} of ${r.steps})`);
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(seen));
  console.log('PASS validate-strobe-child-frames-play');
} finally { await browser.close(); await server?.close(); }
