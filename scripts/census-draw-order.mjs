// Where DrawFrame's draw order changes Play's pixels (docs/bsp-occlusion.md
// "DrawFrame's draw order"): at each view the page draws the same frozen
// frame (the level held as the acceptance captures hold it: ?hold=1,
// bPlayersOnly, then TimeDilation 0, so animated textures stand still) three
// times, with the fog-map pass where DrawComplexSurface draws it (after its
// surface, before the decals and every translucent or modulated item), with
// it in its old place (after every other world item), and in the original's
// place again. The last against the first is the noise floor; the middle
// against the first is what the order changes. Default worker mode,
// Brightness 0.4 (the identity display ramp: raw frames, as the acceptance
// captures).
//
//   node scripts/census-draw-order.mjs [--maps A,B] [--views n] [--size 1280x720] [--out dir]
//       [--view map:x,y,z:pitch,yaw ...]   (explicit views; the seeded ones stand near each map's volumetric lights)
//   node scripts/census-draw-order.mjs --data [--maps A,B]
//       no page: what in the shipped data can meet in an order-sensitive way. Per map (single player): drawn BSP nodes
//       that are translucent, modulated (with their textures) or masked (surface | texture PolyFlags, OccludeBsp's), the fog
//       zones, the lit masked nodes and the translucent or modulated nodes in a fog zone, the ParticleGenerators with
//       bModulated or without bTranslucent (SetProxyData: STY_Modulated, STY_Masked); then every actor class whose default
//       Style is STY_Translucent or STY_Modulated, with its DrawType.
//
// With --out, each view's frames are written as <map>-<n>-{surface,last,again,nofog}.png.
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {readdir, readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {readTexture} from '../src/unreal/textures.mjs';
import {ClassDefaults} from '../src/unreal/classes.mjs';
import {texturePolyFlags} from '../src/runtime/bsp-occlusion.mjs';
import {debugUrl} from './page-url.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const explicit = process.argv.flatMap((arg, i) => arg === '--view' ? [process.argv[i + 1]] : []).map(spec => {
  const [map, at, angles] = spec.split(':');
  const [pitch, yaw] = angles.split(',').map(Number);
  return {map, location: at.split(',').map(Number), rotation: [pitch & 0xffff, yaw & 0xffff, 0]};
});
const views = Number(option('views', 6));
const [WIDTH, HEIGHT] = option('size', '1280x720').split('x').map(Number);
const out = option('out', null);
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory))) files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
const assets = new AssetStore(files);
if (process.argv.includes('--data')) { await dataCensus(); process.exit(0); }
const maps = option('maps', null)?.split(',') ?? [...new Set(explicit.map(view => view.map))];
if (!maps.length) throw new Error('--maps or --view');

async function dataCensus() {
  const all = (await readdir(path.join(root, 'Maps'))).filter(name => /\.dx$/i.test(name) && !/^DXMP/i.test(name)).map(name => name.replace(/\.dx$/i, ''));
  for (const name of option('maps', null)?.split(',') ?? all) {
    const asset = await assets.get(name), map = decodeMap(asset.bytes), model = map.model, textureFlags = new Map(), modulatedTextures = new Set();
    const fogActors = new Set(map.actors.filter(actor => actor.values.bFogZone).map(actor => actor.index));
    const fogZones = new Set(model.zones.flatMap((zone, i) => fogActors.has(zone.actor) ? [i] : []));
    const row = {translucent: 0, modulated: 0, masked: 0, fogZones: fogZones.size, maskedLitInFog: 0, blendedInFog: 0};
    for (const node of model.nodes) {
      const surface = model.surfaces.at(node.surface);
      let flags = surface.flags >>> 0, texture = null;
      if (surface.texture) {
        if (!textureFlags.has(surface.texture)) {
          const object = await assets.resolve(asset, surface.texture);
          textureFlags.set(surface.texture, {flags: texturePolyFlags(readTexture(object.asset, object.index).values), name: object.entry.name});
        }
        ({flags: texture} = textureFlags.get(surface.texture));
        flags |= texture;
      }
      if (flags & 1) continue;
      const inFog = fogZones.has(node.zones[0]) || fogZones.has(node.zones[1]);
      if (flags & 4) row.translucent++;
      else if (flags & 0x40) { row.modulated++; modulatedTextures.add(textureFlags.get(surface.texture)?.name ?? 'none'); }
      else if (flags & 2) { row.masked++; if (inFog && !(flags & 0x400000) && surface.lightMap >= 0) row.maskedLitInFog++; }
      if (inFog && flags & 0x44) row.blendedInFog++;
    }
    const generators = map.actors.filter(actor => actor.className === 'ParticleGenerator');
    row.generators = generators.length;
    row.modulatedOrMaskedGenerators = generators.filter(actor => actor.values.bModulated || actor.values.bTranslucent === false).length;
    if (modulatedTextures.size) row.modulatedTextures = [...modulatedTextures];
    console.log(name, JSON.stringify(row));
  }
  const defaults = new ClassDefaults(assets), styles = [];
  for (const file of files.filter(f => /^System\/.*\.u$/i.test(f.path) && !/DXMP|IpDrv|UWeb|IpServer|UBrowser/i.test(f.path))) {
    const asset = await assets.get(path.basename(file.path, '.u'));
    for (const [i, entry] of asset.pkg.exports.entries()) {
      if (entry.className !== 'Class') continue;
      let lineage; try { lineage = await defaults.lineage(asset, i + 1); } catch { continue; }
      if (!lineage.includes('engine.actor')) continue;
      const values = await defaults.get(asset, i + 1);
      if (values.Style === 3 || values.Style === 4) styles.push(`${values.Style === 3 ? 'Translucent' : 'Modulated'} DrawType ${values.DrawType ?? 0} ${lineage[0]}`);
    }
  }
  console.log(`actor classes by default Style (${styles.length}):\n  ${styles.sort().join('\n  ')}`);
}
const dir = fileURLToPath(new URL('..', import.meta.url));
const {default: base} = await import('../vite.config.mjs');
const deny = base.server.fs.deny.filter(pattern => !(pattern.includes('.work') && dir.includes('/.work/'))
  && !(pattern.includes('.claude/worktrees') && dir.includes('/.claude/worktrees/')));
const server = await createServer({...base, configFile: false, root: dir, logLevel: 'error',
  server: {...base.server, port: 0, strictPort: false, fs: {...base.server.fs, deny}, watch: null}});
await server.listen();
const url = server.resolvedUrls.local[0].replace(/\/$/, '');
if (out) await mkdir(out, {recursive: true});
const browser = await chromium.launch({args: [`--use-angle=${process.platform === 'darwin' ? 'metal' : 'gl'}`]});
try {
  const compare = await browser.newPage();
  const different = (a, b) => compare.evaluate(async ([x, y]) => {
    const load = async base64 => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    };
    const [p, q] = [await load(x), await load(y)];
    let count = 0, max = 0, sum = 0;
    for (let i = 0; i < p.data.length; i += 4) {
      const d = Math.max(Math.abs(p.data[i] - q.data[i]), Math.abs(p.data[i + 1] - q.data[i + 1]), Math.abs(p.data[i + 2] - q.data[i + 2]));
      if (d) { count++; max = Math.max(max, d); sum += d; }
    }
    return {count, max, mean: count ? +(sum / count).toFixed(2) : 0};
  }, [a.toString('base64'), b.toString('base64')]);
  for (const map of maps) {
    const model = decodeMap((await assets.get(map)).bytes);
    let state = 0x2545f491 ^ map.length;
    const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    // Seeded views: a navigation point near a volumetric light (VolumeRadius > 0), looking at the light.
    const lights = model.actors.filter(a => a.values.VolumeRadius > 0 && a.values.Location).map(a => a.values.Location);
    const spots = model.actors.filter(a => a.values.Location && /PathNode|PlayerStart|PatrolPoint/.test(a.className)).map(a => a.values.Location);
    const near = lights.flatMap(light => spots.filter(s => Math.hypot(s[0] - light[0], s[1] - light[1], s[2] - light[2]) < 600).map(s => [s, light]));
    const list = explicit.filter(view => view.map === map);
    for (let v = 0; v < views && near.length; v++) {
      const [spot, light] = near[Math.floor(random() * near.length)];
      const d = light.map((c, k) => c - spot[k] - (k === 2 ? 40 : 0));
      const yaw = Math.round(Math.atan2(d[1], d[0]) * 32768 / Math.PI) & 0xffff;
      const pitch = Math.round(Math.atan2(d[2], Math.hypot(d[0], d[1])) * 32768 / Math.PI) & 0xffff;
      list.push({map, location: [spot[0], spot[1], spot[2] + 40].map(Math.round), rotation: [pitch, yaw, 0]});
    }
    const page = await browser.newPage({viewport: {width: WIDTH, height: HEIGHT}, deviceScaleFactor: 1});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(debugUrl(`${url}/?hold=1`));
    await page.waitForFunction(() => window.deusExViewer?.status().ready, {}, {timeout: 240000});
    await page.locator('#map').selectOption(map);
    await page.waitForFunction(map => { const s = window.deusExViewer?.status(); return s?.ready && s.map === map; }, map, {timeout: 300000});
    await page.addStyleTag({content: `.toolbar, footer, #toast, #play-hint, #npc-preview-label, #panel, #crosshair, #gate { display: none !important; }
#app { height: 100vh !important; } #viewport { position: fixed !important; inset: 0 !important; width: ${WIDTH}px; height: ${HEIGHT}px; }
#scene { position: fixed !important; left: 0 !important; top: 0 !important; margin: 0 !important; border: 0 !important; transform: none !important; width: ${WIDTH}px !important; height: ${HEIGHT}px !important; }`});
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.evaluate(() => { const el = document.getElementById('brightness'); el.value = '0.4'; el.dispatchEvent(new Event('input')); });
    const frames = n => page.evaluate(async n => { for (let k = 0; k < n; k++) await new Promise(r => requestAnimationFrame(r)); }, n);
    const shot = () => page.screenshot({clip: {x: 0, y: 0, width: WIDTH, height: HEIGHT}});
    const order = async name => { await page.evaluate(name => window.deusExViewer.fogOrder(name), name); await frames(3); };
    await page.evaluate(() => window.deusExViewer.viewProbe({playersOnly: true}));
    await page.evaluate(() => window.deusExViewer.release());
    await frames(30);
    await page.evaluate(() => window.deusExViewer.viewProbe({ghost: true}));
    await frames(10);
    await page.evaluate(() => window.deusExViewer.viewProbe({timeDilation: 0}));
    let changedViews = 0, settled = 0;
    const per = [];
    for (const [n, view] of list.entries()) {
      await page.evaluate(view => window.deusExViewer.viewProbe({location: view.location, rotation: view.rotation}), view);
      await frames(40);
      // The surface textures' clock is held too (deusExViewer.holdTextureClock): a waterfall's animation chain runs on the page's clock.
      await page.evaluate(() => window.deusExViewer.holdTextureClock(true));
      await order('surface');
      let a = await shot(), steady = false;
      for (let attempt = 0; attempt < 10 && !steady; attempt++) {
        await frames(8);
        const again = await shot();
        steady = (await different(a, again)).count === 0;
        a = again;
      }
      const fog = await page.evaluate(() => window.deusExViewer.fog());
      // An unsettled view (a texture that animates without the level's clock) is still drawn in both orders: read its change against its noise.
      {
        if (steady) settled++;
        await order('last');
        const b = await shot();
        await order('surface');
        const c = await shot();
        // The fog the view holds: the frame without the fog pass.
        await page.evaluate(() => window.deusExViewer.showFog(false)); await frames(3);
        const bare = await shot();
        await page.evaluate(() => window.deusExViewer.showFog(true)); await frames(3);
        const [change, noise, fogged] = [await different(a, b), await different(a, c), await different(a, bare)];
        if (change.count && steady) changedViews++;
        per.push(`${n}${steady ? '' : ' (unsettled)'} ${view.location.join(',')}:${view.rotation.slice(0, 2).join(',')} fog meshes ${fog?.visibleMeshes ?? 0}, fog in ${fogged.count} pixels (max ${fogged.max}): ` +
          `${change.count} pixels differ (max ${change.max}, mean ${change.mean}), noise ${noise.count}`);
        if (out) {
          await writeFile(path.join(out, `${map}-${n}-surface.png`), a);
          await writeFile(path.join(out, `${map}-${n}-last.png`), b);
          await writeFile(path.join(out, `${map}-${n}-again.png`), c);
          await writeFile(path.join(out, `${map}-${n}-nofog.png`), bare);
        }
      }
      await page.evaluate(() => window.deusExViewer.holdTextureClock(false));
    }
    console.log(`${map}: ${settled} settled views of ${list.length}, ${changedViews} where the fog pass' place changes pixels` +
      `${errors.length ? `; page errors ${errors.slice(0, 3)}` : ''}\n  ${per.join('\n  ')}`);
    await page.close();
  }
} finally { await browser.close(); await server.close(); }
