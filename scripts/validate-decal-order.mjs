/** The order Play draws a surface's decals in, against URender::DrawFrame's
 * decal block (Render.dll 0x10b1b0ca..0x10b1b34d) executed unchanged under
 * Unicorn (scripts/native-decal-render-oracle.py, block mode):
 * docs/decals.md "Draw order".
 *
 * The oracle builds frames with the original CreateMasterFrame and
 * OccludeBsp, gives one drawn surface 2 to 5 FDecals (quads inside, across
 * and over its polygons, runs of one texture, Nodes lists that admit one
 * polygon or none) and runs the block: for each FDecal in TArray order, each
 * saved polygon of the draw item in list order, ClipDecal and, for a
 * nonempty fragment, DrawGouraudPolygon. The port gets the same frame, the
 * item's saved polygons as an occlusion stream and the FDecals as a store
 * (decal.rs decal_clip_frame); its fragments must come in the order of the
 * original's DrawGouraudPolygon calls, with the same point counts. The page
 * draws them in that order (decal-draw.mjs runs, decal-scene.mjs).
 *
 *   node scripts/validate-decal-order.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readTexture } from '../src/unreal/textures.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { uploadDecalModel } from '../src/runtime/decal-kernel.mjs';
import { buildWindowSceneFrame } from '../src/runtime/script-window-scene-frame.mjs';
import { TEXTURE_POLYFLAG_BOOLS } from '../src/runtime/bsp-occlusion.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
if (!existsSync(python)) {
  console.log('SKIP validate-decal-order: no native probe environment');
  process.exit(0);
}
const kernel = (await loadScriptVmKernel()).decals;
if (!kernel?.clipFrame) throw new Error('The script VM core predates decal.rs ClipDecal (npm run build:wasm)');
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const bits = value => (f32[0] = value, u32[0]);

// Core appTan's qword results for the game thread's FOV 75 and 90 (as validate-decal-render).
const tangents = {}, io = new DataView(new ArrayBuffer(8));
const key64 = value => (io.setFloat64(0, value, true), io.getBigUint64(0, true).toString(16).padStart(16, '0'));
for (const [fov, result] of [[75, '3fe88df153d6a676'], [90, '3fefffffffffffff']]) {
  buildWindowSceneFrame({ location: [0, 0, 0], rotation: [0, 0, 0], width: 64, height: 64, fov, appTan: argument => {
    tangents[key64(argument)] = result;
    io.setBigUint64(0, BigInt(`0x${result}`), true);
    return io.getFloat64(0, true);
  } });
}

async function oracleModel(mapName) {
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes), m = map.model;
  const textureIndex = new Map(), textures = [], surfs = [];
  for (const s of m.surfaces) {
    let t = null;
    if (s.texture) {
      if (!textureIndex.has(s.texture)) {
        const object = await assets.resolve(asset, s.texture), values = readTexture(object.asset, object.index).values;
        let polyFlags = 0;
        TEXTURE_POLYFLAG_BOOLS.forEach((name, i) => { if (values[name]) polyFlags |= 1 << i; });
        textureIndex.set(s.texture, textures.length);
        textures.push({ key: object.key, polyFlags: polyFlags >>> 0 });
      }
      t = textureIndex.get(s.texture);
    }
    surfs.push({ texture: t, flags: s.flags >>> 0, base: s.base, normal: s.normal, textureU: s.textureU, textureV: s.textureV });
  }
  return { map, model: {
    nodes: m.nodes.map(n => ({ planeBits: n.plane.map(bits), zoneMask: n.zoneMask, vertexPool: n.vertexPool,
      surface: n.surface, back: n.back, front: n.front, coplanar: n.coplanar, collisionBound: n.collisionBound,
      renderBound: n.renderBound, zones: n.zones, vertexCount: n.vertexCount, flags: n.flags, leaves: n.leaves })),
    verts: m.vertices.map(v => [v.point, v.side]), pointBits: m.points.map(p => p.map(bits)),
    vectorBits: m.vectors.map(p => p.map(bits)),
    surfs, textures, boundBits: m.renderBounds.map(b => [...b.min.map(bits), ...b.max.map(bits), b.valid ? 1 : 0]),
    zones: m.zones.map(z => ({ actor: z.actor })),
    zoneActors: [...new Set(m.zones.map(z => z.actor).filter(a => a > 0))].map(index => ({ index })),
    rootOutside: m.rootOutside, numZones: m.zones.length,
  } };
}

// Cameras at the player start and path nodes, looking down a little (many saved polygons per surface).
function cameras(map, seed, count) {
  let state = seed >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const starts = map.actors.filter(a => /PlayerStart/.test(a.className) && a.values.Location).map(a => a.values.Location);
  const nodes = map.actors.filter(a => /PathNode|PatrolPoint/.test(a.className) && a.values.Location).map(a => a.values.Location);
  return Array.from({ length: count }, (_, i) => {
    const p = i === 0 && starts.length ? starts[0] : nodes[Math.floor(random() * nodes.length)];
    const location = [p[0] + (random() - 0.5) * 30, p[1] + (random() - 0.5) * 30, p[2] + 20 + random() * 30];
    return { location, locationBits: location.map(bits), rotation: [-Math.floor(1200 + random() * 5000), Math.floor(random() * 65536), 0],
      width: [1024, 1280, 640][i % 3], height: [768, 720, 480][i % 3], fov: i % 2 ? 75 : 90, frameCounter: i, timeBits: bits(2 + i / 7) };
  });
}
const TEXTURES = [{ usize: 64, vsize: 64, scaleBits: bits(1) }, { usize: 128, vsize: 128, scaleBits: bits(1) },
  { usize: 32, vsize: 64, scaleBits: bits(1) }, { usize: 256, vsize: 128, scaleBits: bits(0.5) }];
const RUNS = [['00_Training', 5, 8], ['01_NYC_UNATCOIsland', 9, 6]];

const recordWords = kernel.recordWords(), STORE_HEADER = 16;
const totals = { blocks: 0, draws: 0, decals: 0, multiPolygon: 0, polygonMajorDiffers: 0, maps: [] };
for (const [mapName, seed, count] of RUNS) {
  const { map, model } = await oracleModel(mapName);
  const request = { gameRoot: root, tangents, model, textures: TEXTURES, d3d: { colorBits: 32, fog: 0, draw: true },
    frames: cameras(map, seed, count).map((camera, i) => ({ camera, seed: 300 + i, generateBlocks: { count: 8, variants: ['plain'] } })) };
  const started = performance.now();
  const result = JSON.parse(execFileSync(python, ['scripts/native-decal-render-oracle.py'],
    { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 1 << 30 }));
  const decalModel = uploadDecalModel(kernel, map.model);
  const surfaces = map.model.surfaces.length, capacity = 8;
  const store = kernel.alloc(kernel.storeSize(surfaces, capacity)), frameAt = kernel.alloc(4 * 64);
  let blocks = 0;
  for (const view of result.views) for (const frame of view.frames) {
    const frameWords = new Uint32Array(64);
    frameWords.set(frame.frame.coordsBits.map(v => v >>> 0), 0);
    frameWords.set(frame.frame.uncoordsBits.map(v => v >>> 0), 48);
    new Uint32Array(kernel.memory.buffer, frameAt, 64).set(frameWords);
    for (const block of frame.blocks) {
      const item = frame.items.find(it => it.list === block.item[0] && it.index === block.item[1]);
      const specs = block.spec.decals, where = `${mapName} block ${blocks} (surface ${item.iSurf}, ${specs.length} decals, ${item.polys.length} polygons)`;
      // The original's draws: each DrawGouraudPolygon after the ClipDecal that made its fragment.
      const expected = [];
      let clip = null;
      for (const event of block.events) {
        if (event[0] === 'ClipDecal') clip = { decal: event[1], poly: event[2] };
        else if (event[0] === 'DrawGouraudPolygon') expected.push({ ...clip, count: event[1] });
      }
      // The store: the surface's FDecals in TArray order, actor ids 1.. (decal.rs Store: prev, next, surface, actor,
      // Vertices, MoverRotation, Nodes count and Nodes).
      kernel.storeInit(store, surfaces, capacity);
      const words = new Uint32Array(kernel.memory.buffer, store, kernel.storeSize(surfaces, capacity) / 4);
      const recAt = r => STORE_HEADER + 2 * surfaces + recordWords * r;
      specs.forEach((spec, k) => {
        const o = recAt(k), nodes = spec.nodes ?? [];
        assert.ok(20 + nodes.length <= recordWords, `${where}: Nodes fit a record`);
        words[o] = k ? k - 1 : 0xffffffff; words[o + 1] = k + 1 < specs.length ? k + 1 : 0xffffffff;
        words[o + 2] = item.iSurf; words[o + 3] = k + 1;
        words.set(spec.vertexBits.flat().map(v => v >>> 0), o + 4);
        words.set([0, 0, 0], o + 16);
        words[o + 19] = nodes.length; words.set(nodes.map(v => v >>> 0), o + 20);
      });
      words[STORE_HEADER + 2 * item.iSurf] = 0; words[STORE_HEADER + 2 * item.iSurf + 1] = specs.length - 1;
      words[1] = specs.length < capacity ? specs.length : 0xffffffff; words[3] = specs.length;
      // The occlusion stream: this one draw item (surface word 2, polygon count word 6), each saved polygon as its node,
      // its point count and 7 words per point (the camera-space point first).
      const stream = [0, 0, item.iSurf, 0, 0, 0, item.polys.length];
      for (const poly of item.polys) {
        stream.push(poly.iNode, poly.points.length);
        for (const p of poly.points) stream.push(p[0], p[1], p[2], 0, 0, 0, 0);
      }
      const streamAt = kernel.alloc(4 * stream.length), cap = 1 << 14, out = kernel.alloc(4 * cap);
      new Uint32Array(kernel.memory.buffer, streamAt, stream.length).set(stream.map(v => v >>> 0));
      const written = kernel.clipFrame(decalModel.base, store, frameAt, streamAt, stream.length, out, cap);
      assert.ok(written < 0xfffffffe, `${where}: clipFrame fault`);
      const data = new Uint32Array(kernel.memory.buffer, out, written), got = [];
      for (let i = 0; i < written; i += 3 + 5 * data[i + 2]) got.push({ decal: data[i] - 1, count: data[i + 2] });
      kernel.free(streamAt); kernel.free(out);
      assert.deepEqual(got, expected.map(({ decal, count }) => ({ decal, count })),
        `${where}: Play's fragments ${JSON.stringify(got)} vs the original's draws ${JSON.stringify(expected)}`);
      // Whether the block tells the orders apart: the same draws, polygon by polygon (the port's order before 2026-10-28).
      const byPolygon = [...expected].sort((a, b) => a.poly - b.poly || a.decal - b.decal);
      if (byPolygon.some((d, k) => d.decal !== expected[k].decal)) totals.polygonMajorDiffers++;
      if (new Set(expected.map(d => d.poly)).size > 1) totals.multiPolygon++;
      totals.draws += expected.length; totals.decals += specs.length; totals.blocks++; blocks++;
    }
  }
  kernel.free(store); kernel.free(frameAt); decalModel.dispose();
  totals.maps.push(`${mapName} ${blocks} blocks (${((performance.now() - started) / 1000).toFixed(1)} s)`);
}
assert.ok(totals.polygonMajorDiffers > 0, 'some block tells the decal-major order from the polygon-major one');
console.log(`validate-decal-order: ${totals.maps.join(', ')}; ${totals.blocks} decal blocks, ${totals.decals} FDecals, ` +
  `${totals.draws} DrawGouraudPolygon calls in the original's order with their point counts (${totals.multiPolygon} blocks draw on more than ` +
  `one polygon, ${totals.polygonMajorDiffers} of them in an order a polygon-by-polygon walk would change); PASS`);
