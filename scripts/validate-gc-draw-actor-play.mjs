// GC.DrawActor and GC.ClearZ in the browser (docs/gc-draw-actor.md "Play"), in Play's default mode: the simulation in the worker.
//
// On 00_Training the player gets the vision augmentation (the original console chain: AugAdd, the augmentation's level, ActivateAllAugs;
// DrawVisionAugmentation draws heat sources from CurrentLevel 1 on) and stands in front of an NPC. The retail HUD calls
// GC.DrawActor(A, false, false, true, 1, 2, None) for each heat source in range, between the red tint tiles and the LightAmp box: the
// worker's HUD paint queues an 'actor' command per call (script-window-host.mjs), sim-session.mjs planHudActor updates the actor's mesh
// binding in the master frame, and the page draws it between the tile batches (hud.mjs, weapon-overlay-draw.mjs hudActor). The check:
// every frame draws the actors with no runtime error; the same frame with the draws switched off differs in a region of the picture;
// ShowClass/ShowMesh (ActorDisplayWindow, GC.ClearZ) queues clearZ commands without an error (ShowClass Rat: a class the original holds in
// Training with no actor placed; a class it does not hold, such as Greasel, is a NULL parameter and ShowClass is not called).
//
//   node scripts/validate-gc-draw-actor-play.mjs [--url http://...] [--shot frame.png] [--near mib1]
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {debugUrl} from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-gc-draw-actor-play: no installed game data'); process.exit(0); }
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
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/src\/viewer\/main\.mjs(?:\?|$)/, async route => {
    const response = await route.fetch();
    const text = (await response.text()).replace('antialias: true })', 'antialias: true, preserveDrawingBuffer: true })');
    // The page's draw counters: GC.DrawActor mesh draws and the HUD command kinds of every frame.
    await route.fulfill({response, body: text + `
window.__deusHud={draws:0,off:false,kinds:{},get renderer(){return renderer;}};
setInterval(()=>{
  if(weaponDraw&&!weaponDraw.__counted){const original=weaponDraw.hudActor.bind(weaponDraw);weaponDraw.__counted=true;
    weaponDraw.hudActor=(...args)=>window.__deusHud.off?0:(window.__deusHud.draws+=original(...args));}
  if(hudRenderer&&!hudRenderer.__counted){const render=hudRenderer.render;hudRenderer.__counted=true;
    hudRenderer.render=(r,w,h,commands,...rest)=>{const list=Array.isArray(commands)?commands:Array.from({length:commands.count},(_,i)=>commands.words[i*12]===0?{}:commands.others[commands.words[i*12+1]]);for(const c of list){const k=c.kind??'tile';window.__deusHud.kinds[k]=(window.__deusHud.kinds[k]??0)+1;}return render(r,w,h,commands,...rest);};}
},50);
`});
  });
  await page.goto(debugUrl(`${url}/`));
  await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === '00_Training'; }, {}, {timeout: 300000});
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const status = () => page.evaluate(() => window.deusExViewer.status().runtimeError?.message ?? null);
  await frames(60);
  const near = option('near', 'mib1');
  const at = await page.evaluate(name => window.deusExViewer.renderPassProbe({locate: name}), near);
  await page.evaluate(() => window.deusExViewer.viewProbe({exec: ['AugAdd AugVision']}));
  const {augs} = await page.evaluate(() => window.deusExViewer.inputProbe({op: 'state'}));
  const vision = augs.find(aug => aug.cls === 'deusex.augvision').name;
  await page.evaluate(name => window.deusExViewer.placeProbe({set: {actor: name, fields: {CurrentLevel: 3}}}), vision);
  await page.evaluate(() => window.deusExViewer.viewProbe({exec: ['ActivateAllAugs']}));
  await page.evaluate(([x, y, z]) => window.deusExViewer.placeProbe({location: [x - 220, y, z + 20]}), at);
  await page.evaluate(name => window.deusExViewer.placeProbe({lookAt: name}), near);
  await frames(90);
  assert.equal(await status(), null, 'no runtime error with the vision augmentation active');
  const drawsBefore = await page.evaluate(() => window.__deusHud.draws);
  await frames(30);
  const drawn = await page.evaluate(() => window.__deusHud.draws) - drawsBefore;
  assert.ok(drawn >= 30, `the page draws the heat sources every frame (${drawn} draws in 30 frames)`);
  // The same view with the actor draws off differs, and only the actors' draws were turned off.
  const read = () => page.evaluate(() => {
    const canvas = window.__deusHud.renderer.domElement, copy = document.createElement('canvas');
    copy.width = canvas.width; copy.height = canvas.height;
    const context = copy.getContext('2d'); context.drawImage(canvas, 0, 0);
    return Array.from(context.getImageData(0, 0, copy.width, copy.height).data);
  });
  const withDraws = await read();
  if (option('shot', null)) await page.screenshot({path: option('shot', null)});
  await page.evaluate(() => { window.__deusHud.off = true; });
  await frames(3);
  const withoutDraws = await read();
  await page.evaluate(() => { window.__deusHud.off = false; });
  let changed = 0;
  for (let i = 0; i < withDraws.length; i += 4)
    if (Math.abs(withDraws[i] - withoutDraws[i]) + Math.abs(withDraws[i + 1] - withoutDraws[i + 1]) + Math.abs(withDraws[i + 2] - withoutDraws[i + 2]) > 24) changed++;
  assert.ok(changed > 2000, `the actors' draws change the picture (${changed} pixels)`);
  // ActorDisplayWindow with ShowMesh: GC.ClearZ at the start of its paint (no Greasel in the level, so no DrawActor).
  await page.evaluate(() => window.deusExViewer.viewProbe({exec: ['ShowClass Rat', 'ShowMesh True']}));
  await page.evaluate(() => { window.__deusHud.kinds = {}; });
  await frames(30);
  const kinds = await page.evaluate(() => window.__deusHud.kinds);
  assert.ok(kinds.clearZ >= 20, `GC.ClearZ commands reach the page (${kinds.clearZ})`);
  assert.equal(await status(), null, 'no runtime error after ShowMesh');
  assert.deepEqual(errors, [], 'no page errors');
  report = {drawnIn30Frames: drawn, changedPixels: changed, kinds};
} finally {
  await browser.close();
  await server?.close();
}
console.log(`GC.DrawActor/ClearZ Play passed: ${JSON.stringify(report)}`);
