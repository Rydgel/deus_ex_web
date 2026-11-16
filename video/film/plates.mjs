// Plates: frames of the game drawn by this project's own engine, from chosen cameras, for the film's game shots.
// It drives the viewer the way the project's acceptance harness does (scripts/visual-acceptance.mjs): Vite served
// in-process, headless Chromium, the debug page's map list, and the viewer's probes for console commands and the camera.
//   node video/film/plates.mjs <set> --map 01_NYC_UNATCOIsland --view name:x,y,z:pitch,yaw,roll [--view ...]
//        [--at x,y,z:pitch,yaw,roll]  the player placed there first, for:  [--cmd 'console line' ...]  [--summon DeusEx.JCDouble ...]
//        [--put x,y,z:pitch,yaw,roll]  the first summoned actor moved there after the wait   [--anim Sequence:frame] its pose, held
//        [--read Location,Orders,...]  properties of the summoned actors, printed after the summon and before the shots
//        [--size 1920x1080] [--wait 2] seconds the level runs before the shots   [--freeze] hold the level for the shots
//        [--scout]  four views from the player's start, a quarter turn apart (a0 a1 a2 a3), to look for a place
// Positions are the player's Location in Unreal units, rotations in 65536ths of a turn. Writes video/out/film/plates/<set>/
// <name>.png and <name>.json (the camera the engine reports, for Blender). The page's sound is muted.
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createServer} from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../..');
const argv = process.argv.slice(2), set = argv[0];
const all = name => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));
const one = (name, fallback) => all(name)[0] ?? fallback;
if (!set || set.startsWith('--') || !one('map') || (!all('view').length && !argv.includes('--scout'))) { console.error('usage: node video/film/plates.mjs <set> --map <Map> --view name:x,y,z:pitch,yaw,roll ...'); process.exit(1); }
const [W, H] = one('size', '1920x1080').split('x').map(Number), map = one('map');
const pose = text => { const [loc, rot = '0,0,0'] = text.split(':'); return {location: loc.split(',').map(Number), rotation: rot.split(',').map(Number)}; };
const views = all('view').map(v => { const [name, ...rest] = v.split(':'); return {name, ...pose(rest.join(':'))}; });
const out = path.resolve(here, '../out/film/plates', set);
mkdirSync(out, {recursive: true});

const {default: base} = await import(path.join(repo, 'vite.config.mjs'));
const server = await createServer({...base, configFile: false, root: repo, logLevel: 'error', server: {...base.server, port: 0, strictPort: false, watch: null}});
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({args: ['--use-angle=gl', '--mute-audio']});
try {
  const page = await browser.newPage({viewport: {width: W, height: H}, deviceScaleFactor: 1});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url}/?debug=1&seed=1&music=0`);
  const ready = m => page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && (!m || s.map === m); }, m, {timeout: 300000});
  await ready(null);
  if (await page.evaluate(() => window.deusExViewer.status().map) !== map) { await page.locator('#map').selectOption(map); await ready(map); }
  // only the game's picture, at the film's size
  await page.addStyleTag({content: `.toolbar, footer, #toast, #play-hint, #npc-preview-label, #panel, #crosshair, #gate { display: none !important; }
#app { height: 100vh !important; } #viewport { position: fixed !important; inset: 0 !important; width: ${W}px; height: ${H}px; }
#scene { position: fixed !important; left: 0 !important; top: 0 !important; margin: 0 !important; border: 0 !important; transform: none !important; width: ${W}px !important; height: ${H}px !important; }`});
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
  const probe = args => page.evaluate(a => window.deusExViewer.viewProbe(a), args);
  await frames(30);
  const start = await probe({ghost: true});                         // fly, no collision, no HUD: the player is only a camera
  if (argv.includes('--scout')) for (let k = 0; k < 4; k++) views.push({name: `a${k}`, location: start.location, rotation: [0, (start.viewRotation[1] + 16384 * k) & 65535, 0]});
  console.log(`${map}: player start ${start.location.map(v => v.toFixed(0)).join(',')} rotation ${start.viewRotation.join(',')} eye ${start.eyeHeight}`);
  const call = (name, args) => page.evaluate(([n, a]) => window.deusExViewer[n](a), [name, args]);
  const summoned = [];
  const report = async label => {
    if (!summoned.length || !one('read')) return;
    const got = await call('liveProbe', {read: {names: summoned, props: one('read').split(',')}});
    console.log(label, JSON.stringify(got.read));
  };
  if (one('at')) {
    await probe(pose(one('at')));
    await frames(12);
    if (all('cmd').length) console.log('console:', JSON.stringify((await probe({exec: all('cmd')})).output));
    for (const cls of all('summon')) summoned.push(...(await call('inputProbe', {op: 'summon', cls})).actors);
    if (summoned.length) console.log('summoned:', summoned.join(', '));
    await frames(4);
    await report('just summoned:');
  }
  await frames(Math.round(Number(one('wait', '2')) * 60));
  if (argv.includes('--freeze')) await probe({playersOnly: true});
  if (one('put') && summoned.length) {
    const to = pose(one('put'));
    await call('liveProbe', {write: {[summoned[0]]: {Location: to.location, Rotation: to.rotation}}});
  }
  if (one('anim') && summoned.length) {
    const [sequence, frame = '0'] = one('anim').split(':');
    await call('placeProbe', {set: {actor: summoned[0], fields: {AnimSequence: sequence, AnimFrame: Number(frame), AnimRate: 0}}});
  }
  await frames(6);
  await report('before the shots:');
  const buffer = await page.evaluate(() => { const c = document.getElementById('scene'); return [c.width, c.height]; });
  if (buffer[0] !== W || buffer[1] !== H) throw new Error(`the scene canvas is ${buffer.join('x')}, not ${W}x${H}`);
  for (const view of views) {
    await probe({location: view.location, rotation: view.rotation});
    await frames(20);
    const state = await probe({}), status = await page.evaluate(() => { const s = window.deusExViewer.status(); return {position: s.position, rotation: s.rotation, fov: s.fov}; });
    await page.screenshot({path: path.join(out, `${view.name}.png`), clip: {x: 0, y: 0, width: W, height: H}});
    writeFileSync(path.join(out, `${view.name}.json`), JSON.stringify({map, size: [W, H], player: {location: state.location, viewRotation: state.viewRotation, eyeHeight: state.eyeHeight},
      camera: status, horizontalFov: 75, timeSeconds: state.timeSeconds}, null, 1));
    console.log(`${view.name}: camera ${status.position.map(v => v.toFixed(1)).join(',')} -> ${path.relative(repo, path.join(out, view.name + '.png'))}`);
  }
  if (errors.length) console.log('page errors:', errors.slice(0, 3));
} finally {
  await browser.close();
  await server.close();
}
