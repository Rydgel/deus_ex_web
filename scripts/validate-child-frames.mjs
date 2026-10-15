/** OccludeFrame's child frames in the Rust core (native/script-vm/src/
 * occlude.rs create_child_frame and occlude_children,
 * src/runtime/bsp-occlusion.mjs `children`) against the unchanged original
 * under Unicorn (scripts/native-occlusion-oracle.py with `children`):
 * docs/bsp-occlusion.md "Child frames".
 *
 * Each map runs one seeded camera sequence through both, cameras aimed at
 * mirrored and fake-backdrop polygons (and at movers, with the moving brush
 * tracker) plus random ones, with sprite actors around the view (one of them
 * at the eye, which only child frames construct: OccludeFrame's excluded
 * actor and SetupDynamics' ViewTarget rule are the root frame's). The
 * original runs CreateChildFrame (merging, ComputeRenderSize at 24 bits,
 * Engine's own) inside each OccludeBsp, then OccludeFrame's recursion: every
 * child frame, newest first and depth first, with its sprites (the
 * constructor and Setup) and OccludeBsp. Every child's FSceneNode fields
 * (Coords, Uncoords, FX..PrjYP, ViewSides, ViewPlanes, NearClip, Mirror,
 * ZoneNumber, Recursion), its span as OccludeBsp receives it, its draw lists
 * with every saved polygon's points, its Frame->Sprite with span buffers and
 * its own requests must match bit for bit, and so must the root frame, the
 * NodeFlags, the zones' LastRenderTime and the counters over the whole
 * recursion.
 *
 *   node scripts/validate-child-frames.mjs [map ...] */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readTexture } from '../src/unreal/textures.mjs';
import { pointZone } from '../src/unreal/lighting.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createBspOcclusion, childFrameTangent, packSetupCandidate, texturePolyFlags, SETUP, SETUP_MESH_NONE,
  OCCLUSION_POINTS, OCCLUSION_SHOW_PLAYER_CTRL, OCCLUSION_SHINY_SURFACES } from '../src/runtime/bsp-occlusion.mjs';
import { collectTrackerMovers, trackerMoverSpec, trackerTextureFlags } from '../src/runtime/brush-tracker.mjs';
import { bits, occlusionModelRequest, occlusionTangents, renderPassTangent, renderRectangle,
  surfaceTextureFlags as textureFlagsOf, trackedModelRequest } from './occlusion-request.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
if (!existsSync(python)) {
  console.log('SKIP validate-child-frames: no native probe environment');
  process.exit(0);
}
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const kernel = (await loadScriptVmKernel()).occlusion;
const MIRRORED = 0x08000000, FAKE_BACKDROP = 0x80;
const units = r => Math.round(r * 32768 / Math.PI);
const hex64 = value => {
  const io = new DataView(new ArrayBuffer(8));
  io.setFloat64(0, value, true);
  return io.getBigUint64(0, true).toString(16).padStart(16, '0');
};
const TEXTURES = [[8, 8], [16, 16], [32, 64], [64, 64], [128, 32], [256, 256], [512, 128]];

/** The first path where two plain values differ (a short message). */
function difference(a, b, at = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = difference(a[k], b[k], `${at}.${k}`);
      if (d) return d;
    }
  }
  return `${at}: Rust ${JSON.stringify(a)?.slice(0, 200)} | original ${JSON.stringify(b)?.slice(0, 200)}`;
}
const screens = list => list.map(entry => ({ key: entry.key ?? entry.sprite, zBits: entry.zBits >>> 0, screenBits: entry.screenBits.map(v => v >>> 0) }));
function same(got, want, label) {
  const d = difference(got, want);
  if (d) throw new Error(`${label}${d}`);
}

/** A polygon's centre (the mean of its vertices). */
function nodeCenter(model, i) {
  const n = model.nodes[i], c = [0, 0, 0];
  for (let k = 0; k < n.vertexCount; k++) {
    const p = model.points[model.vertices[n.vertexPool + k].point];
    for (let j = 0; j < 3; j++) c[j] += p[j] / n.vertexCount;
  }
  return c;
}
/** A camera at `eye` looking at `at`. */
function aim(eye, at, roll = 0) {
  const d = at.map((v, k) => v - eye[k]);
  return { location: eye.map(Math.fround), rotation: [units(Math.atan2(d[2], Math.hypot(d[0], d[1]))),
    (units(Math.atan2(d[1], d[0])) + 65536) % 65536, roll] };
}

async function validate(mapName, { seed, count, tracker = null, views = [] }) {
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes), model = map.model;
  const textureFlags = await textureFlagsOf(assets, asset, model);
  let state = seed >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const pick = list => list[Math.floor(random() * list.length)];
  // The SkyZone every zone gets (ZoneInfo's start-up: the last SkyZoneInfo,
  // a bHighDetail one first; world.mjs), with its Region's zone.
  const skies = map.actors.filter(a => a.className === 'SkyZoneInfo' && a.values.Location);
  const skyActor = skies.filter(a => a.values.bHighDetail).at(-1) ?? skies.at(-1) ?? null;
  const sky = skyActor ? { location: skyActor.values.Location.map(Math.fround),
    rotation: (skyActor.values.Rotation ?? [0, 0, 0]).map(v => v | 0), zone: pointZone(model, skyActor.values.Location) } : null;
  let movers = [];
  const occlusionOptions = { surfaceTextureFlags: textureFlags, zoneActors: model.zones.map(z => (z.actor > 0 ? z.actor : 0)) };
  if (tracker) {
    movers = await collectTrackerMovers(assets, asset, map);
    await trackerTextureFlags(assets, asset, movers, object => texturePolyFlags(readTexture(object.asset, object.index).values));
    occlusionOptions.tracker = { movers: movers.map((m, i) => trackerMoverSpec(m, i, { hidden: m.values.bHidden,
      location: m.values.Location ?? [0, 0, 0], rotation: m.values.Rotation ?? [0, 0, 0], prePivot: m.values.PrePivot ?? [0, 0, 0] })) };
  }
  const occlusion = createBspOcclusion(kernel, model, occlusionOptions);
  if (tracker) same(occlusion.tracker.construct({ pc64: true }), 0, `${mapName}: tracker construction`);
  occlusion.setZoneSkies(model.zones.map(() => sky));
  // Targets: mirrored and fake-backdrop polygons, and the movers.
  const targets = [];
  model.nodes.forEach((n, i) => {
    const flags = (model.surfaces[n.surface].flags | textureFlags[n.surface]) >>> 0;
    if (n.vertexCount >= 3 && flags & (MIRRORED | FAKE_BACKDROP))
      targets.push({ center: nodeCenter(model, i), normal: n.plane.slice(0, 3), kind: flags & MIRRORED ? 'mirror' : 'sky' });
  });
  for (const m of movers) targets.push({ center: m.values.Location ?? [0, 0, 0], normal: null, kind: 'mover' });
  const spots = map.actors.filter(a => a.values.Location && /PathNode|PlayerStart|PatrolPoint/.test(a.className)).map(a => a.values.Location);
  const sizes = [[640, 480], [1024, 768], [1440, 839], [1920, 1080], [1280, 720]];
  // Known views (validate-mirrors-play's and the club tunnel's), each also
  // nudged around.
  const cases = [];
  for (const v of views) for (const nudge of [0, 1, 2]) {
    const [width, height] = nudge ? pick(sizes) : [1280, 720];
    const shift = [0, 1, 2].map(k => (nudge ? (random() - 0.5) * 60 : 0) * (k === 2 ? 0.3 : 1));
    cases.push({ location: v.location.map((x, k) => Math.fround(x + shift[k])),
      rotation: [v.rotation[0] + (nudge ? Math.floor((random() - 0.5) * 2000) : 0), (v.rotation[1] + (nudge ? Math.floor((random() - 0.5) * 3000) : 0) + 65536) % 65536, 0],
      width, height, fov: nudge === 2 ? 75 : 90 });
  }
  count += cases.length;
  while (cases.length < count) {
    const [width, height] = pick(sizes), fov = random() < 0.5 ? 90 : 75;
    let camera;
    if (targets.length && random() < 0.85) {
      const t = pick(targets), distance = 60 + random() * 700;
      let eye;
      if (t.normal) {
        const side = [random() - 0.5, random() - 0.5, (random() - 0.5) * 0.5];
        eye = t.center.map((v, k) => v + t.normal[k] * distance + side[k] * distance);
      } else {
        const spot = spots.length ? spots.map(p => ({ p, d: Math.hypot(...p.map((v, k) => v - t.center[k])) }))
          .filter(e => e.d > 100 && e.d < 900).sort((a, b) => a.d - b.d)[0] : null;
        eye = spot ? spot.p.map((v, k) => v + (k === 2 ? 30 : 0)) : t.center.map((v, k) => v + (k === 0 ? distance : 0));
      }
      camera = aim(eye, t.center, random() < 0.15 ? Math.floor((random() - 0.5) * 6000) : 0);
    } else {
      const p = spots.length ? pick(spots).map((v, k) => v + (k < 2 ? (random() - 0.5) * 40 : 30)) :
        [0, 1, 2].map(k => model.bounds.min[k] + random() * (model.bounds.max[k] - model.bounds.min[k]));
      camera = { location: p.map(Math.fround), rotation: [Math.floor((random() - 0.5) * 20000), Math.floor(random() * 65536), 0] };
    }
    cases.push({ ...camera, width, height, fov });
  }
  // Sprite actors (DT_Sprite, sized textures) around each view; the first
  // stands at the eye and is constructed only in child frames.
  const randomActor = (c, forward) => {
    const depth = 30 + random() * 900, spread = depth * 0.8;
    return { location: [0, 1, 2].map(j => Math.fround(c.location[j] + forward[j] * depth + (random() - 0.5) * spread)),
      texture: Math.floor(random() * TEXTURES.length), drawScale: Math.fround(0.25 + random() * 3), rootExcluded: random() < 0.1 };
  };
  const forwardOf = c => {
    const yaw = c.rotation[1] * Math.PI / 32768, pitch = c.rotation[0] * Math.PI / 32768;
    return [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];
  };
  for (const c of cases) {
    const forward = forwardOf(c);
    c.actors = [{ location: c.location.map((v, k) => Math.fround(v - (k === 2 ? 20 : 0))), texture: 3, drawScale: 1, rootExcluded: true }];
    const n = 4 + Math.floor(random() * 12);
    for (let k = 0; k < n; k++) c.actors.push(randomActor(c, forward));
  }
  const spriteSpec = a => ({ rootExcluded: a.rootExcluded, actor: { sequence: 0, animFrameBits: 0,
    locationBits: a.location.map(bits), rotation: [0, 0, 0], drawType: 1, texture: a.texture, mesh: null,
    drawScaleBits: bits(a.drawScale), prePivotBits: [0, 0, 0], particles: false } });
  // Each child frame's own SetupDynamics (iterators run again, so its items
  // differ): on half the cases, every visit index up to 12 gets its own
  // candidates, the root's moved, dropped, resized and added to.
  for (const c of cases) {
    c.frameActors = {};
    if (random() < 0.5) continue;
    const forward = forwardOf(c);
    for (let index = 1; index <= 12; index++) {
      if (random() < 0.25) continue;
      const list = c.actors.filter(() => random() > 0.2).map(a => ({ ...a,
        location: a.location.map(v => Math.fround(v + (random() - 0.5) * 80)), drawScale: Math.fround(Math.max(0.1, a.drawScale * (0.5 + random()))) }));
      for (let k = Math.floor(random() * 4); k > 0; k--) list.push(randomActor(c, forward));
      if (random() < 0.15) list.length = 0;
      c.frameActors[index] = list;
    }
  }
  cases.forEach((c, i) => Object.assign(c, { locationBits: c.location.map(bits), frameCounter: i, timeBits: bits(1 + i / 30),
    children: true, sprites: c.actors.map(spriteSpec),
    frameSprites: Object.fromEntries(Object.entries(c.frameActors).map(([index, list]) => [index, list.map(spriteSpec)])) }));
  // The render pass's ComputeRenderSize on the root frame (XRootWindow::
  // PreRender) on two cases in three: a clipped rectangle, the children
  // inheriting its X and Y; one in three keeps the viewport.
  cases.forEach((c, i) => {
    if (i % 3 === 0) return;
    c.render = renderRectangle(c.width, c.height, random, i % 3 === 1 ? 1 : 0.5);
  });
  const tangents = occlusionTangents();
  for (const c of cases) {
    const { argument, tangent } = childFrameTangent(c.fov, c.render?.width ?? c.width);
    tangents[hex64(argument)] = hex64(tangent);
    if (c.render) Object.assign(tangents, renderPassTangent(c.fov, c.render.width, 'validate-child-frames'));
  }
  const base = occlusionModelRequest(model, textureFlags);
  if (sky) {
    const record = { locationBits: sky.location.map(bits), rotation: sky.rotation, zone: sky.zone };
    base.levelSky = record;
    for (const z of base.zoneActors) z.sky = record;
  }
  const request = { gameRoot: root, tangents, cases, spriteTextures: TEXTURES.map(([uSize, vSize]) => ({ uSize, vSize })),
    model: tracker ? trackedModelRequest(occlusion, base, kernel.memory) : base };
  const oracle = JSON.parse(execFileSync(python, ['scripts/native-occlusion-oracle.py'],
    { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 1 << 30 })).results;
  const flags = request.model.nodes.map(n => n.flags), times = new Array(model.zones.length).fill(0);
  const stats = { frames: 0, requests: 0, sky: 0, mirror: 0, deepest: 0, merged: 0, sprites: 0, childSprites: 0, polys: 0, ownFrames: 0 };
  // Which child frame each request made or merged into: the page needs every
  // request's node (a frame stands for all the coplanar mirrors of a zone that
  // were requested, since OccludeBsp passes iSurf 0, 0x10b18b4a). The original's
  // CreateChildFrame returns the frame (the oracle records eax at its return);
  // the frame's `requests` are the owner's requests that returned it, in order.
  const merges = (ownerIndex, ownerRequests, oracleRequests, frames, oracleFrames, where) => {
    for (const [k, f] of frames.entries()) {
      if (f.parent !== ownerIndex) continue;
      const want = ownerRequests.filter((_, j) => oracleRequests[j].frameIndex === oracleFrames[k].index).map(ch => ch.iNode);
      same(f.requests, want, `${where}: requests merged into child frame ${f.index}`);
      stats.requests += f.requests.length;
    }
    same(ownerRequests.every((_, j) => oracleRequests[j].frameIndex > 0), true, `${where}: every request returns a frame`);
  };
  const drawLists = (got, want, where) => {
    for (let list = 0; list < 3; list++) {
      const w = want[list].map(d => ({ iNode: d.iNode, iSurf: d.iSurf, iZone: d.iZone, polyFlags: d.polyFlags >>> 0,
        polys: d.polys.map(p => ({ iNode: p.iNode, points: p.points.map(t => [t[0], t[1], t[2], t[4], t[5], t[6], t[7]].map(v => v >>> 0)) })) }));
      const g = got[list].map(d => ({ iNode: d.iNode, iSurf: d.iSurf, iZone: d.iZone, polyFlags: d.polyFlags,
        polys: d.polys.map(p => ({ iNode: p.iNode, points: p.points.map(t => [...t].map(v => v >>> 0)) })) }));
      same(g, w, `${where}: draw list ${list}`);
    }
  };
  const requests = (got, want, where) => same(got.map(ch => ({ iSurf: ch.iSurf, zone: ch.zone, span: ch.span })),
    want.map(ch => ({ iSurf: ch.iSurf, zone: ch.iZone, span: ch.span })), `${where}: child requests`);
  try {
    for (const [i, c] of cases.entries()) {
      const o = oracle[i];
      const where = `${mapName} case ${i} ${JSON.stringify(c.location.map(v => +v.toFixed(1)))} ${c.rotation} ${c.width}x${c.height}${c.render ? ` render ${c.render.width}x${c.render.height}` : ''} FOV ${c.fov}`;
      const master = occlusion.master({ location: c.location, rotation: c.rotation, width: c.width, height: c.height, fov: c.fov,
        render: c.render ? { width: c.render.width, height: c.render.height } : null });
      same([...master.fields].map(v => v >>> 0), [...o.frameBits, o.zoneNumber, ...o.uncoordsBits].map(v => v >>> 0), `${where}: master frame`);
      const words = [...master.frame];
      words[44] = c.frameCounter; words[45] = c.timeBits;
      words[46] = OCCLUSION_SHOW_PLAYER_CTRL | OCCLUSION_SHINY_SURFACES | OCCLUSION_POINTS; words[47] = 0;
      const pack = list => {
        const views = occlusion.setupCandidates(list.length);
        list.forEach((a, key) => packSetupCandidate(views, views.at + SETUP.WORDS * key, { key, drawType: 1, mesh: SETUP_MESH_NONE,
          texture: { uSize: TEXTURES[a.texture][0], vSize: TEXTURES[a.texture][1] }, location: a.location, rotation: [0, 0, 0],
          drawScale: a.drawScale, prePivot: [0, 0, 0], particles: false, sequence: null, animFrame: 0, rootExcluded: a.rootExcluded }));
      };
      pack(c.actors);
      // Each child frame takes its own candidates, from the host, when the case has them.
      const r = occlusion.run(words, [], { setupCount: c.actors.length, children: { fov: c.fov, orthoZoom: 0,
        frameDynamics: ({ index }) => {
          const list = c.frameActors[index] ?? c.actors;
          pack(list); occlusion.useFrameCandidates(list.length);
          stats.ownFrames += c.frameActors[index] ? 1 : 0;
        } } });
      same(r.sprites, o.sprites.map(entry => ({ key: entry.sprite, span: entry.span })), `${where}: Frame->Sprite`);
      same(screens(r.spriteScreens), screens(o.sprites), `${where}: Frame->Sprite centre and scale`);
      drawLists(r.draw, o.draw, where);
      requests(r.children, o.children, where);
      same(r.frames.length, o.frames.length, `${where}: child frame count`);
      merges(0, r.children, o.children, r.frames, o.frames, where);
      for (const [k, f] of r.frames.entries()) {
        const of = o.frames[k], at = `${where} frame ${f.index} (${f.kind}, recursion ${f.recursion})`;
        same([f.index, f.parent, f.zone, f.recursion, f.mirror >>> 0], [of.index, of.parent, of.zoneNumber, of.recursion,
          of.mirrorBits >>> 0], `${at}: links, zone, recursion, mirror`);
        same(f.nearClip.map(v => v >>> 0), of.nearClipBits.map(v => v >>> 0), `${at}: NearClip`);
        same(f.fields.map(v => v >>> 0), of.frameBits.map(v => v >>> 0), `${at}: fields`);
        same(f.uncoords.map(v => v >>> 0), of.uncoordsBits.map(v => v >>> 0), `${at}: Uncoords`);
        same(f.span, of.span, `${at}: span`);
        same(f.sprites, of.sprites.map(entry => ({ key: entry.sprite, span: entry.span })), `${at}: Frame->Sprite`);
        same(screens(f.spriteScreens), screens(of.sprites), `${at}: Frame->Sprite centre and scale`);
        drawLists(f.draw, of.draw, at);
        requests(f.children, of.children, at);
        merges(f.index, f.children, of.children, r.frames, o.frames, at);
        stats.frames++; stats[f.kind]++; stats.deepest = Math.max(stats.deepest, f.recursion);
        stats.childSprites += f.sprites.length;
        stats.polys += f.draw.reduce((n, l) => n + l.length, 0);
      }
      stats.merged += r.children.length + r.frames.reduce((n, f) => n + f.children.length, 0) - r.frames.length;
      stats.sprites += r.sprites.length;
      same([r.nodesDraw, r.polysDraw], o.counters, `${where}: NodesDraw/PolysDraw`);
      for (const [k, v] of Object.entries(o.nodeFlags)) flags[k] = v;
      for (const [k, v] of Object.entries(o.zoneTimes)) if (k < times.length) times[k] = v;
      let mismatch = -1;
      for (let k = 0; k < flags.length && mismatch < 0; k++) if (occlusion.nodeFlags(k) !== flags[k]) mismatch = k;
      same(mismatch, -1, `${where}: node ${mismatch} flags`);
      same(times.map((_, k) => occlusion.zoneTime(k) >>> 0), times.map(t => t >>> 0), `${where}: zone times`);
    }
  } finally {
    occlusion.dispose();
  }
  console.log(`${mapName}${tracker ? ` (${movers.length} tracked movers)` : ''}: ${cases.length} cases, ${stats.frames} child frames match ` +
    `(${stats.mirror} mirror, ${stats.sky} sky, recursion up to ${stats.deepest}, ${stats.merged} merged requests, ${stats.requests} requests placed in their frames, ` +
    `${stats.polys} child draw lists, ${stats.childSprites} child-frame sprites, ${stats.sprites} root sprites, ${stats.ownFrames} frames with their own candidates)`);
}

const only = new Set(process.argv.slice(2));
const maps = [
  ['00_Training', { seed: 3, count: 24 }],
  ['01_NYC_UNATCOIsland', { seed: 5, count: 20 }],
  ['10_Paris_Club', { seed: 7, count: 20 }],
  ['10_Paris_Club', { seed: 29, count: 12, tracker: true,
    views: [32768, 40960].map(yaw => ({ location: [2063, 273, 30], rotation: [0, yaw, 0] })) }],
  ['02_NYC_Bar', { seed: 11, count: 16, views: [{ location: [-768, -600, 95], rotation: [0, 49152, 0] }] }],
  ['02_NYC_Hotel', { seed: 13, count: 16, views: [{ location: [1880, -1158, 148], rotation: [0, 32768, 0] }] }],
  ['02_NYC_Smug', { seed: 17, count: 16, tracker: true, views: [{ location: [-576, 1530, 250], rotation: [0, 16384, 0] }] }],
  ['11_Paris_Everett', { seed: 19, count: 16, tracker: true, views: [{ location: [1024, 1640, 430], rotation: [0, 53000, 0] }] }],
];
for (const [map, options] of maps) if (!only.size || only.has(map)) await validate(map, options);
console.log('validate-child-frames: ok');
