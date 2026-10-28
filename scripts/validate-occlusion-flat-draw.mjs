/** Play's flat draw lists (bsp-occlusion.mjs `flatDraw`, read by sim-session.mjs drawnOf) against the object decode of the same
 * OccludeBsp output: a host representation change only (docs/live-heap.md "Allocation and the long frame").
 *
 * Each map is set up as Play sets it up for its visibility pass (the moving brush tracker at the movers' placement, the zones'
 * skies, child frames), and a seeded sequence of views is run from its PathNode and PlayerStart locations. Each run's output is
 * decoded twice, as objects and with `flatDraw` (decodeLast: the same words; a second run of a view can differ, since OccludeBsp
 * keeps state between runs). Each draw list's entries (iSurf, iZone, polygon count) and polygons' nodes, in order, must equal the
 * object decode's, for the root frame and every child frame, and so must everything else the result carries: the child requests
 * (without their span lines), the sprites, their screens, the counters, the streams and the child frames' fields.
 *
 *   node scripts/validate-occlusion-flat-draw.mjs [map ...] */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readTexture } from '../src/unreal/textures.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createBspOcclusion, texturePolyFlags } from '../src/runtime/bsp-occlusion.mjs';
import { collectTrackerMovers, trackerMoverSpec, trackerTextureFlags } from '../src/runtime/brush-tracker.mjs';
import { surfaceTextureFlags } from './occlusion-request.mjs';

const maps = process.argv.slice(2).length ? process.argv.slice(2)
  : ['01_NYC_UNATCOIsland', '00_Training', '06_HongKong_WanChai_Underworld', '10_Paris_Club'];
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const kernel = (await loadScriptVmKernel()).occlusion;
const f32 = Math.fround, WIDTH = 1440, HEIGHT = 856, FOV = 90;

/** The first path where two plain values differ, or null. */
function differ(a, b, at = '') {
  if (Object.is(a, b)) return null;
  if (ArrayBuffer.isView(a)) a = [...a];
  if (ArrayBuffer.isView(b)) b = [...b];
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return `${at}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) { const d = differ(a[key], b[key], `${at}.${key}`); if (d) return d; }
  return null;
}
// The object decode's draw lists in the flat form.
const flatten = draw => ({ entries: draw.map(list => list.flatMap(entry => [entry.iSurf, entry.iZone, entry.polys.length])),
  nodes: draw.map(list => list.flatMap(entry => entry.polys.map(poly => poly.iNode))) });
// What both decodes carry besides the draw lists (child requests without their lines).
const rest = body => ({ children: body.children.map(({ span: { lines, ...span }, ...child }) => ({ ...child, span })),
  sprites: body.sprites, spriteScreens: body.spriteScreens });
const others = r => ({ ...rest(r), nodesDraw: r.nodesDraw, polysDraw: r.polysDraw, stream: r.stream,
  frames: r.frames.map(({ draw, drawn, children, sprites, spriteScreens, ...frame }) => ({ ...frame, ...rest({ children, sprites, spriteScreens }) })) });

let views = 0, entries = 0, polygons = 0, children = 0, frames = 0, failures = 0;
for (const name of maps) {
  const asset = await assets.get(name), map = decodeMap(asset.bytes), model = map.model;
  const textureFlags = await surfaceTextureFlags(assets, asset, model);
  const movers = await collectTrackerMovers(assets, asset, map);
  await trackerTextureFlags(assets, asset, movers, object => texturePolyFlags(readTexture(object.asset, object.index).values));
  const specs = movers.map((m, i) => trackerMoverSpec(m, i, { hidden: m.values.bHidden, location: m.values.Location ?? [0, 0, 0],
    rotation: m.values.Rotation ?? [0, 0, 0], prePivot: m.values.PrePivot ?? [0, 0, 0] }));
  const occlusion = createBspOcclusion(kernel, model, { surfaceTextureFlags: textureFlags,
    zoneActors: model.zones.map(z => (z.actor > 0 ? z.actor : 0)), tracker: specs.length ? { movers: specs } : null });
  try {
    if (occlusion.tracker && occlusion.tracker.construct({ pc64: true }) !== 0) throw new Error(`${name}: tracker construction failed`);
    // Every zone's sky: the map's SkyZoneInfo (bHighDetail preferred), as LinkToSkybox gives it.
    const skies = map.actors.filter(a => /SkyZoneInfo/i.test(a.className));
    const sky = skies.filter(a => a.values?.bHighDetail).at(-1) ?? skies.at(-1);
    occlusion.setZoneSkies(model.zones.map(() => sky ? { location: (sky.values.Location ?? [0, 0, 0]).map(f32),
      rotation: (sky.values.Rotation ?? [0, 0, 0]).map(v => v | 0), zone: sky.values.Region?.zoneNumber ?? 0 } : null));
    const eyes = map.actors.filter(a => /^(PathNode|PlayerStart)$/.test(a.className) && a.values?.Location).map(a => a.values.Location);
    let seed = 0x5eed ^ name.length, counter = 0, mapFailures = 0;
    const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    for (let v = 0; v < 48 && eyes.length; v++) {
      const eye = eyes[Math.floor(random() * eyes.length)].map(f32);
      const rotation = [Math.floor((random() - 0.5) * 8192), Math.floor(random() * 65536), 0];
      const built = occlusion.master({ location: eye, rotation, width: WIDTH, height: HEIGHT, fov: FOV, render: { width: WIDTH, height: HEIGHT } });
      const words = [...built.frame];
      words[44] = ++counter; words[45] = 0; words[46] = 3; words[47] = 0;
      const a = occlusion.run(words, [], { skipPoints: true, skipSpritePixels: true, children: { fov: FOV, orthoZoom: 0 } });
      const b = occlusion.decodeLast({ skipPoints: true, skipSpritePixels: true, flatDraw: true });
      const flat = differ({ draw: flatten(a.draw), frames: a.frames.map(f => flatten(f.draw)), ...others(a) },
        { draw: b.drawn, frames: b.frames.map(f => f.drawn), ...others(b) }, 'flat');
      const nulls = b.draw === null && b.frames.every(f => f.draw === null) ? null : 'flat decode kept object draw lists';
      const problem = flat ?? nulls;
      if (problem) { if (mapFailures++ < 3) console.log(`FAIL ${name} view ${v}: ${problem}`); continue; }
      views++; frames += a.frames.length; children += a.children.length;
      for (const body of [a, ...a.frames]) for (const list of body.draw) { entries += list.length; for (const entry of list) polygons += entry.polys.length; }
    }
    failures += mapFailures;
  } finally { occlusion.dispose?.(); }
}
const summary = `${views} views on ${maps.length} maps: ${entries} draw entries, ${polygons} polygons, ${children} child requests, ${frames} child frames`;
if (failures) { console.log(`FAIL validate-occlusion-flat-draw: ${failures} views differ; ${summary}`); process.exit(1); }
if (!views || !polygons) { console.log(`FAIL validate-occlusion-flat-draw: nothing compared (${summary})`); process.exit(1); }
console.log(`PASS validate-occlusion-flat-draw: ${summary} decode the same with flat draw lists`);
