// Play's frame of DX.dx at the end of the boot flight, as a 1280x720 raw framebuffer (docs/umesh.md "Frames"):
// the map is opened in the inspection page, released, and flown until the player stops at the IntroCam path's end
// (InterpolationPoint13, bEndOfPath: about (-12, 405, -123)); the frame is then taken at the Brightness (0.4) whose
// display ramp is the identity, without detail textures or canvas multisampling, as the stored original frames are
// (docs/visual-acceptance.md "Frames"). The original's is `scripts/live-original.sh DX --ticks 1700 --delta
// 0.0166666675 --original-brightness 0.666667 --shot dxend --tag dxend`, whose Shot lands in
// .work/acceptance/DX/dxend-original.png; `node scripts/visual-acceptance.mjs compare --maps DX --view dxend:0,0,0:0,0,0`
// compares the two.
//
// The original's capture holds the level frozen (LevelInfo.bPlayersOnly) while the player flies the path, then ticks it
// for 30 frames, in which DXLogo3 (PHYS_Rotating, 8192 units a second, 4,080 in its trace) turns from yaw 32768 to 36848: Play
// freezes the level the same way and sets that yaw (`--logo-yaw`, default 36848; `--logo-yaw none` leaves the live logo).
//
// `--hide A,B` sets bHidden on those actors before the frame: `--hide DXLogo3,DXText0,DXText1,EidosLogo0,IonStormLogo0` is the frame
// Play drew before classic meshes were bound (their meshes not drawn, the emitter's glow only).
//
//   node scripts/dx-end-shot.mjs [--name dxend] [--url http://127.0.0.1:5173] [--seed 1] [--query a=b&c=d] [--logo-yaw 36848] [--hide A,B]
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const {chromium} = await import('@playwright/test');
const {createServer} = await import('vite');
let server = null, url = option('url', null);
if (!url) {
  const {default: base} = await import('../vite.config.mjs');
  const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
    && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
  server = await createServer({...base, configFile: false, root, logLevel: 'error',
    server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
  await server.listen();
  url = server.resolvedUrls.local[0].replace(/\/$/, '');
}
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url}/?seed=${option('seed', 1)}&detailTextures=0&antialias=0${option('query', '') ? `&${option('query')}` : ''}`);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
  if (await page.evaluate(() => window.deusExViewer.status().map) !== 'DX') {
    await page.locator('#map').selectOption('DX');
    await page.waitForFunction(() => { const s = window.deusExViewer?.status(); return s?.ready && s.map === 'DX'; }, {}, {timeout: 300000});
  }
  await page.addStyleTag({content: `.toolbar, footer, #toast, #play-hint, #npc-preview-label, #panel, #crosshair, #gate { display: none !important; }
#app { height: 100vh !important; } #viewport { position: fixed !important; inset: 0 !important; width: 1280px; height: 720px; }
#scene { position: fixed !important; left: 0 !important; top: 0 !important; margin: 0 !important; border: 0 !important; transform: none !important; width: 1280px !important; height: 720px !important; }`});
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.evaluate(() => { const el = document.getElementById('brightness'); el.value = '0.4'; el.dispatchEvent(new Event('input')); });
  const yaw = option('logo-yaw', '36848');
  if (yaw !== 'none') await page.evaluate(() => window.deusExViewer.viewProbe({playersOnly: true, timeDilation: 1}));
  // The flight: wait until the camera has stopped near the path's end.
  let last = null, still = 0;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline && still < 6) {
    await page.waitForTimeout(2000);
    const position = await page.evaluate(() => window.deusExViewer.status().position);
    const near = position && Math.hypot(position[0] + 12, position[1] - 405, position[2] + 123) < 40;
    still = near && last && position.every((v, i) => v === last[i]) ? still + 1 : 0;
    last = position;
  }
  if (still < 6) throw new Error(`The flight did not end: camera at ${JSON.stringify(last)}`);
  if (yaw !== 'none') {
    await page.evaluate(value => window.deusExViewer.liveProbe({write: {DXLogo3: {Rotation: [0, value, 0]}}}), Number(yaw));
    await page.waitForTimeout(1500);
  }
  const hide = (option('hide', '') ?? '').split(',').filter(Boolean);
  if (hide.length) {
    await page.evaluate(names => window.deusExViewer.liveProbe({write: Object.fromEntries(names.map(name => [name, {bHidden: true}]))}), hide);
    await page.waitForTimeout(1500);
  }
  const dir = path.join(root, '.work/acceptance/DX');
  mkdirSync(dir, {recursive: true});
  const file = path.join(dir, `${option('name', 'dxend')}-play.png`);
  await page.screenshot({path: file, clip: {x: 0, y: 0, width: 1280, height: 720}});
  console.log(file, JSON.stringify(last), errors.length ? `page errors: ${errors.join('; ')}` : 'no page errors');
} finally { await browser.close(); await server?.close(); }
