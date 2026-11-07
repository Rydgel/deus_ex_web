// Fog kernel calls of a real Play session (headless Firefox or Chromium), for scripts/fog-replay.mjs: the page's fogMapKernel reports each
// call's inputs (packed lights and tables, the nine camera-space grid words, the incoming early-out flag, the map size) and the hash of the
// texels the Rust loop answered with, through globalThis.DEUS_EX_FOG_RECORD (scripts/fog-replay-lib.mjs). The harness drives the player
// over a deterministic list of views (placeProbe) around the map's fog spots, so the record holds the mover draw items, the mover lattices
// and the flag chain that Play itself produced. Identical calls are kept once with a count.
//
//   node scripts/fog-capture-play.mjs --map 02_NYC_Underground --out FILE.json [--views 240] [--browser firefox|chromium] [--wait 110]
//     [--spots JSON] (an array of {location:[x,y,z], rotation:[0,yaw,0]} the views are drawn around; default: the map's spots below)
//     [--query k=v&k=v] [--size 1440x960]
import {chromium, firefox} from '@playwright/test';
import {writeFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {recorderSource} from './fog-replay-lib.mjs';

const option = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? f : process.argv[i + 1]; };
const map = option('map', '02_NYC_Underground'), out = option('out', null), engine = option('browser', 'firefox');
if (!out) throw new Error('--out FILE.json');
const VIEWS = Number(option('views', 240)), WAIT = Number(option('wait', 110));
const [width, height] = option('size', '1440x960').split('x').map(Number);

// The fog table of docs/firefox-60fps-plan.md "Fog spots", and the census' light-pack maps.
const SPOTS = {
  '02_NYC_Underground': [[638, -191, -361, 32768], [-73, 636, -361, 49152], [234, 605, -361, 49152]],
  '08_NYC_Underground': [[-768, -402, -361, 0], [-75, 724, -361, 49152]],
  '04_NYC_Underground': [[-73, 636, -361, 49152], [-358, 588, -361, 49152]],
  '04_NYC_NSFHQ': [[-542, -894, 23, 49152], [-238, -1777, 48, 49152]],
  '02_NYC_BatteryPark': [[-3723, -3353, 265, 0]],
  '03_NYC_AirfieldHeliBase': [[-881, 2510, 23, 32768]],
  '02_NYC_Bar': [[-900, -330, 80, 25000]],
};
const spots = option('spots', null) ? JSON.parse(option('spots', null)) : SPOTS[map];
if (!spots) throw new Error(`no spots for ${map}; pass --spots`);

// A deterministic generator and the views: a spot, a position within 120 units of it, a yaw from the spot's by a multiple of 4096 or a
// random one, a pitch of a few degrees.
let seed = 0x5eed ^ [...map].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const views = [];
for (let i = 0; i < VIEWS; i++) {
  const [x, y, z, yaw] = spots[i % spots.length];
  const jitter = i < spots.length ? 0 : 120;
  views.push({
    location: [x + Math.round((random() - .5) * 2 * jitter), y + Math.round((random() - .5) * 2 * jitter), z],
    rotation: [Math.round((random() - .5) * 4000) & 65535, i < spots.length ? yaw : (yaw + Math.round(random() * 65536)) & 65535, 0],
  });
}

const root = fileURLToPath(new URL('..', import.meta.url));
const {createServer} = await import('vite');
const {default: base} = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && root.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && root.includes('/.claude/worktrees/')));
const server = await createServer({...base, configFile: false, root, logLevel: 'error',
  server: {...base.server, port: 0, host: '127.0.0.1', fs: {...base.server.fs, deny}, watch: null}});
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = engine === 'chromium'
  ? await chromium.launch({args: ['--use-angle=gl', '--mute-audio'], headless: true})
  : await firefox.launch({headless: true, firefoxUserPrefs: {'javascript.options.asyncstack': false}});
let status = 0;
try {
  const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor: 1});
  await context.addInitScript(() => { try { localStorage.setItem('deusex.uiHidden', '1'); } catch { /* unavailable */ } });
  await context.addInitScript({content: recorderSource});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const target = new URL(url);
  target.searchParams.set('debug', '1');
  for (const [k, v] of new URLSearchParams(option('query', ''))) target.searchParams.set(k, v);
  await page.goto(target.href);
  await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 300000});
  await page.evaluate(m => { const menu = document.getElementById('map'); menu.value = m; menu.dispatchEvent(new Event('change')); }, map);
  await page.waitForFunction(m => { const s = window.deusExViewer?.status(); return s?.ready && s.map === m; }, map, {timeout: 300000});
  await page.waitForFunction(() => window.deusExViewer.status().gameplay?.hud?.health?.head?.displayedHealth === 100, {}, {timeout: 240000}).catch(() => {});
  await page.locator('#scene').click({position: {x: Math.round(width * .4), y: Math.round(height * .36)}});
  await page.evaluate(exec => window.deusExViewer.viewProbe({exec}), ['set DeusEx.JCDentonMale bCheatsEnabled True', 'god']);
  await page.waitForTimeout(1500);
  const started = Date.now();
  for (const [i, view] of views.entries()) {
    await page.evaluate(({view, i}) => { globalThis.DEUS_EX_FOG_RECORD.state.place = i; return window.deusExViewer.placeProbe(view); }, {view, i});
    await page.waitForTimeout(WAIT);
  }
  const dump = await page.evaluate(() => globalThis.DEUS_EX_FOG_RECORD.dump());
  const verify = await page.evaluate(() => window.deusExViewer.fog()?.stats?.verify ?? null);
  if (verify && /fog(Kernel|Pass)=verify/.test(option('query', ''))) {
    console.log(`verify (kernel: block loop against reference; pass: tiles, kept item grids/geometries/textures against rebuilt): ${JSON.stringify(verify)}`);
    if (verify.differing || verify.tilesDiffering || verify.gridsDiffering || verify.geometriesDiffering || verify.texturesDiffering) status = 1;
  }
  await mkdir(dirname(out), {recursive: true});
  await writeFile(out, JSON.stringify({map, engine, views, ...dump}));
  const texels = dump.calls.reduce((n, c) => n + c.width * c.height * dump.packs[c.pack].count * c.n, 0);
  console.log(`${map}: ${engine}, ${views.length} views in ${((Date.now() - started) / 1000).toFixed(0)} s: ${dump.state.frames} fog updates, ${dump.state.calls} kernel calls `
    + `(${dump.calls.length} distinct), ${dump.packs.length} light packs, ${texels} texel-lights; nondeterministic calls ${dump.state.nondeterministic}; page errors ${errors.length}`);
  if (errors.length) console.log(errors.slice(0, 3).join('\n'));
} catch (error) {
  console.error(error);
  status = 1;
} finally {
  await browser.close();
  await server.close();
}
process.exit(status);
