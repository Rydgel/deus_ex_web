/** URender::OccludeBsp in the Rust core (src/runtime/bsp-occlusion.mjs,
 * native/script-vm/src/occlude.rs) against the unchanged original under
 * Unicorn (scripts/native-occlusion-oracle.py): docs/bsp-occlusion.md.
 *
 * Each map runs one seeded camera sequence through both in order, so the
 * NodeFlags the original keeps between frames (NF_BoxOccluded,
 * NF_PolyOccluded) and the frame counter's bound-test schedule carry over.
 * Cameras stand at actors and anywhere in the model's bounds (solid space,
 * outside the level, zone 0) at random rotations, frame sizes and FOVs 75
 * and 90. Every draw list entry, every saved polygon's clipped points
 * (X, Y, Z, ScreenX, ScreenY, IntY, RZ bits), the NodeFlags, the zones'
 * LastRenderTime, the counters and the child-frame requests with their
 * spans must match bit for bit, and so must the master frame the port
 * builds from the camera (CreateMasterFrame: ComputeRenderCoords,
 * ComputeRenderSize, PointRegion). */
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
import { buildWindowSceneFrame } from '../src/runtime/script-window-scene-frame.mjs';
import { createBspOcclusion, texturePolyFlags, OCCLUSION_POINTS,
  OCCLUSION_SHOW_PLAYER_CTRL, OCCLUSION_SHINY_SURFACES } from '../src/runtime/bsp-occlusion.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
if (!existsSync(python)) {
  console.log('SKIP validate-bsp-occlusion: no native probe environment');
  process.exit(0);
}
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const bits = value => (f32[0] = value, u32[0]);
// Core appTan's measured qword results for FOV 75 and 90 (the table in
// script-window-scene-frame.mjs), keyed by the double argument the frame
// producer passes, for the oracle's Engine ComputeRenderSize.
const TANGENTS = {};
const io = new DataView(new ArrayBuffer(8));
for (const [fov, result] of [[75, '3fe88df153d6a676'], [90, '3fefffffffffffff']])
  buildWindowSceneFrame({ location: [0, 0, 0], rotation: [0, 0, 0], width: 64, height: 64, fov, appTan: argument => {
    io.setFloat64(0, argument, true);
    TANGENTS[io.getBigUint64(0, true).toString(16).padStart(16, '0')] = result;
    io.setBigUint64(0, BigInt(`0x${result}`), true);
    return io.getFloat64(0, true);
  } });
const kernel = (await loadScriptVmKernel()).occlusion;

async function validate(mapName, count, seed, extra = []) {
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes), model = map.model;
  const textureFlags = new Map(), surfaceTextureFlags = [];
  for (const surface of model.surfaces) {
    if (!surface.texture) { surfaceTextureFlags.push(0); continue; }
    if (!textureFlags.has(surface.texture)) {
      const object = await assets.resolve(asset, surface.texture);
      textureFlags.set(surface.texture, texturePolyFlags(readTexture(object.asset, object.index).values));
    }
    surfaceTextureFlags.push(textureFlags.get(surface.texture));
  }
  let state = seed >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const spots = map.actors.filter(a => a.values.Location && /PathNode|PlayerStart|PatrolPoint|Inventory|Decoration|ScriptedPawn|Light|Trigger/.test(a.className)).map(a => a.values.Location);
  const sizes = [[640, 480], [1024, 768], [1440, 839], [1920, 1080], [801, 601], [1280, 720]];
  const cases = [...extra];
  while (cases.length < count) {
    const anywhere = random() < 0.4 || !spots.length;
    const p = anywhere ? [0, 1, 2].map(k => model.bounds.min[k] + random() * (model.bounds.max[k] - model.bounds.min[k]))
      : spots[Math.floor(random() * spots.length)].map((v, k) => v + (k < 2 ? (random() - 0.5) * 40 : random() * 40));
    const [width, height] = sizes[Math.floor(random() * sizes.length)];
    cases.push({ location: p, rotation: [Math.floor((random() - 0.5) * 28000), Math.floor(random() * 65536),
      random() < 0.2 ? Math.floor((random() - 0.5) * 8000) : 0], width, height, fov: random() < 0.5 ? 90 : 75 });
  }
  cases.forEach((c, i) => Object.assign(c, { locationBits: c.location.map(bits), frameCounter: i, timeBits: bits(1 + i / 30) }));
  const zoneActors = [...new Set(model.zones.map(z => z.actor).filter(a => a > 0))].map(index => ({ index }));
  const request = { gameRoot: root, tangents: TANGENTS, cases, model: {
    nodes: model.nodes.map(n => ({ planeBits: n.plane.map(bits), zoneMask: n.zoneMask, vertexPool: n.vertexPool,
      surface: n.surface, back: n.back, front: n.front, coplanar: n.coplanar, collisionBound: n.collisionBound,
      renderBound: n.renderBound, zones: n.zones, vertexCount: n.vertexCount, flags: n.flags, leaves: n.leaves })),
    verts: model.vertices.map(v => [v.point, v.side]), pointBits: model.points.map(p => p.map(bits)),
    surfs: model.surfaces.map((s, i) => ({ texture: i, flags: s.flags >>> 0 })),
    textures: surfaceTextureFlags.map(polyFlags => ({ polyFlags })),
    boundBits: model.renderBounds.map(b => [...b.min.map(bits), ...b.max.map(bits), b.valid ? 1 : 0]),
    zones: model.zones.map(z => ({ actor: z.actor })), zoneActors, rootOutside: model.rootOutside, numZones: model.zones.length,
  } };
  const oracle = JSON.parse(execFileSync(python, ['scripts/native-occlusion-oracle.py'],
    { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 1 << 30 })).results;
  const occlusion = createBspOcclusion(kernel, model, { surfaceTextureFlags,
    zoneActors: model.zones.map(z => (z.actor > 0 ? z.actor : 0)) });
  const flags = model.nodes.map(n => n.flags), times = new Array(model.zones.length).fill(0);
  const stats = { surfaces: 0, children: 0, zone0: 0 };
  try {
    for (const [i, c] of cases.entries()) {
      const o = oracle[i];
      const where = `${mapName} case ${i} ${JSON.stringify(c.location.map(v => +v.toFixed(1)))} ${c.rotation} ${c.width}x${c.height}`;
      // The master frame from the camera: every field CreateMasterFrame made.
      const master = occlusion.master({ location: c.location.map(Math.fround), rotation: c.rotation, width: c.width,
        height: c.height, fov: c.fov });
      assert.deepEqual([...master.fields].map(v => v >>> 0), [...o.frameBits, o.zoneNumber].map(v => v >>> 0), `${where}: master frame`);
      const words = [...master.frame];
      words[44] = c.frameCounter; words[45] = c.timeBits;
      words[46] = OCCLUSION_SHOW_PLAYER_CTRL | OCCLUSION_SHINY_SURFACES | OCCLUSION_POINTS; words[47] = 0;
      const r = occlusion.run(words);
      for (let list = 0; list < 3; list++) {
        const want = o.draw[list].map(d => ({ iNode: d.iNode, iSurf: d.iSurf, iZone: d.iZone, polyFlags: d.polyFlags >>> 0,
          polys: d.polys.map(p => ({ iNode: p.iNode, points: p.points.map(t => [t[0], t[1], t[2], t[4], t[5], t[6], t[7]].map(v => v >>> 0)) })) }));
        const got = r.draw[list].map(d => ({ iNode: d.iNode, iSurf: d.iSurf, iZone: d.iZone, polyFlags: d.polyFlags,
          polys: d.polys.map(p => ({ iNode: p.iNode, points: p.points.map(t => [...t].map(v => v >>> 0)) })) }));
        assert.deepEqual(got, want, `${where}: draw list ${list}`);
      }
      assert.deepEqual(r.children.map(ch => ({ iSurf: ch.iSurf, zone: ch.zone, span: ch.span })),
        o.children.map(ch => ({ iSurf: ch.iSurf, zone: ch.iZone, span: ch.span })), `${where}: child frames`);
      assert.deepEqual([r.nodesDraw, r.polysDraw], o.counters, `${where}: NodesDraw/PolysDraw`);
      for (const [k, v] of Object.entries(o.nodeFlags)) flags[k] = v;
      for (const [k, v] of Object.entries(o.zoneTimes)) if (k < times.length) times[k] = v;
      let mismatch = -1;
      for (let k = 0; k < flags.length && mismatch < 0; k++) if (occlusion.nodeFlags(k) !== flags[k]) mismatch = k;
      assert.equal(mismatch, -1, `${where}: node ${mismatch} flags`);
      assert.deepEqual(times.map((_, k) => occlusion.zoneTime(k) >>> 0), times.map(t => t >>> 0), `${where}: zone times`);
      stats.surfaces += r.draw.reduce((n, l) => n + l.length, 0);
      stats.children += r.children.length;
      stats.zone0 += o.zoneNumber === 0;
    }
  } finally {
    occlusion.dispose();
  }
  console.log(`${mapName}: ${cases.length} frames match (${stats.surfaces} draw lists, ${stats.children} child requests, ${stats.zone0} zone-0 views)`);
}

// The Paris club entrance tunnel at spawn (the slow view that motivated the
// recovery: the frustum alone admits the club's mirrors and fog surfaces).
const tunnel = [32768, 40960, 0, 16384, 49152].map(yaw => ({ location: [2063, 273, 30], rotation: [0, yaw, 0], width: 1920, height: 1080, fov: 90 }));
await validate('10_Paris_Club', 40, 7, tunnel);
await validate('00_Training', 40, 11);
await validate('01_NYC_UNATCOIsland', 40, 13);
await validate('12_Vandenberg_Cmd', 24, 23);
console.log('validate-bsp-occlusion: ok');
