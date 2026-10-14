/** A mover's vertices through the original's vertex chain (docs/frame-projection.md
 * "Movers"). The unchanged Render.dll and D3DDrv.dll under Unicorn
 * (scripts/native-frame-projection-oracle.py) draw a level whose BSP holds the
 * moving brush tracker's fragments, at cameras aimed at the movers (Training's
 * doors, closed and raised, the Paris club's mirror movers turned, the Island's
 * doors); the Rust tracker's own model gives the oracle its nodes, verts and
 * points, so the points D3DDrv projects are the ones the tracker wrote.
 *
 * For every drawn mover fragment (a saved polygon of a tracker surface):
 *   - each point that is a model vertex projects, through the reference chain
 *     (viewPoint, projectView, d3dVertex), to the vertex D3DDrv built, bit
 *     for bit (the same check validate-frame-projection makes on level points);
 *   - a fragment that is the whole polygon (every vertex a model point, as many
 *     as the polygon has) has exactly the vertices FPoly::Transform left, in
 *     its order: `moverPoints` (brush-tracker.mjs), the host copy the page poses
 *     the mover's meshes with, which scripts/validate-brush-tracker.mjs checks
 *     against Transform's output under Unicorn;
 *   - a fragment the tracker split (or a polygon OccludeBsp's clipper cut) keeps
 *     the polygon's vertices where it has them: every one of them is a vertex of
 *     the exported polygon, bit for bit.
 * The page's earlier mover vertices (the group matrix times the rest positions,
 * binary32 without fused operations, in three's axes) go through the same chain
 * and are compared with the device's vertex.
 *
 *   node scripts/validate-frame-projection-movers.mjs [map ...] */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createBspOcclusion } from '../src/runtime/bsp-occlusion.mjs';
import { collectTrackerMovers, trackerMoverSpec, trackerTextureFlags } from '../src/runtime/brush-tracker.mjs';
import { texturePolyFlags } from '../src/runtime/bsp-occlusion.mjs';
import { readTexture } from '../src/unreal/textures.mjs';
import { bits, occlusionModelRequest, occlusionTangents, renderPassTangent, renderRectangle,
  surfaceTextureFlags as textureFlagsOf, trackedModelRequest } from './occlusion-request.mjs';
import { available, run, rectOf } from './frame-projection-cases.mjs';
import { depthConstants, floatWord, frameOfFields, projectView, d3dVertex, viewPoint, wordFloat } from '../src/runtime/frame-projection.mjs';
import { brushMatrix } from '../src/viewer/transforms.mjs';
import { toView } from '../src/unreal/geometry.mjs';

if (!available) {
  console.log('SKIP validate-frame-projection-movers: no native probe environment');
  process.exit(0);
}
const only = new Set(process.argv.slice(2).filter(a => !a.startsWith('--')));
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const kernel = (await loadScriptVmKernel()).occlusion;
const units = r => Math.round(r * 32768 / Math.PI);
const word = v => v >>> 0;
const f = Math.fround;
const key = v => v.map(word).join(',');

/** The page's earlier vertex of a rest position: the float32 product of the group matrix
 * (`modelMatrix * vec4(position, 1)`, left to right, no fused operations) in three's axes,
 * back to Unreal's. */
function matrixVertex(m, rest) {
  const [x, y, z] = toView(rest).map(f), e = Float32Array.from(m.elements);
  const row = r => f(f(f(f(e[r] * x) + f(e[4 + r] * y)) + f(e[8 + r] * z)) + e[12 + r]);
  const [wx, wy, wz] = [row(0), row(1), row(2)];
  return [-wz, wx, wy];
}

/** 'same' or 'reversed' when `a` is `b` rotated or reversed (a polygon's cycle), else null. */
function sameCycle(a, b) {
  const n = b.length;
  if (a.length !== n) return null;
  for (let r = 0; r < n; r++) {
    if (a.every((x, k) => x === b[(k + r) % n])) return 'same';
    if (a.every((x, k) => x === b[(n - 1 - k + r) % n])) return 'reversed';
  }
  return null;
}
const stats = { same: 0, reversed: 0, fragments: 0, whole: 0, unsplit: 0, split: 0, unsplitPolygons: 0, splitPolygons: 0, shared: 0, cut: 0, clipped: 0, points: 0, exact: 0, clamped: 0, polygons: new Set(),
  before: { points: 0, sxDiffer: 0, szDiffer: 0, errors: [], maxDepth: 0 }, vertices: 0 };

const mutate = process.argv.includes('--mutate');
async function validate(mapName, { count, seed, moves = [], aimed = true, children = false }) {
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes), model = map.model;
  const surfaceTextureFlags = await textureFlagsOf(assets, asset, model);
  const movers = await collectTrackerMovers(assets, asset, map);
  await trackerTextureFlags(assets, asset, movers, object => texturePolyFlags(readTexture(object.asset, object.index).values));
  const specs = movers.map((m, i) => trackerMoverSpec(m, i, { hidden: m.values.bHidden, location: m.values.Location ?? [0, 0, 0],
    rotation: m.values.Rotation ?? [0, 0, 0], prePivot: m.values.PrePivot ?? [0, 0, 0] }));
  const occlusion = createBspOcclusion(kernel, model, { surfaceTextureFlags,
    zoneActors: model.zones.map(z => (z.actor > 0 ? z.actor : 0)), tracker: { movers: specs } });
  try {
    assert.equal(occlusion.tracker.construct({ pc64: true }), 0, `${mapName}: tracker construction`);
    // Where each mover is now: its Location and Rotation (the page's group matrix is made of these).
    const pose = movers.map(m => ({ location: (m.values.Location ?? [0, 0, 0]).map(f), rotation: (m.values.Rotation ?? [0, 0, 0]).map(r => r | 0) }));
    for (const move of moves) {
      const i = movers.findIndex(m => m.name === move.name);
      pose[i] = { location: pose[i].location.map((x, k) => f(x + (move.offset?.[k] ?? 0))),
        rotation: pose[i].rotation.map((r, k) => (r + (move.addRotation?.[k] ?? 0)) | 0) };
      occlusion.tracker.setMover(i, { locationBits: pose[i].location.map(bits), rotation: pose[i].rotation });
      occlusion.tracker.update(i);
    }
    let state = seed >>> 0;
    const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const spots = map.actors.filter(a => a.values.Location && /PathNode|PlayerStart|PatrolPoint|Inventory|Decoration|ScriptedPawn|Light|Trigger/.test(a.className)).map(a => a.values.Location);
    const cases = [];
    // A camera near each mover (a spot 120 to 700 units away), aimed at it; then a second at another spot.
    for (const [i, m] of movers.entries()) {
      const at = pose[i].location;
      const near = spots.map(p => ({ p, d: Math.hypot(...p.map((x, k) => x - at[k])) })).filter(e => e.d > 120 && e.d < 700).sort((x, y) => x.d - y.d);
      for (const spot of near.slice(0, 2)) {
        const eye = spot.p.map((x, k) => f(x + (k === 2 ? 30 : 0))), d = at.map((x, k) => x - eye[k]);
        cases.push({ location: eye, rotation: [units(Math.atan2(d[2], Math.hypot(d[0], d[1]))), (units(Math.atan2(d[1], d[0])) + 65536) % 65536, random() < 0.2 ? Math.floor((random() - 0.5) * 3000) : 0],
          width: 1280, height: 720, fov: 90, mover: i });
      }
      if (cases.length >= count) break;
    }
    assert.ok(cases.length, `${mapName}: a camera near a mover`);
    cases.forEach((c, i) => Object.assign(c, { locationBits: c.location.map(bits), frameCounter: i, timeBits: bits(1 + i / 30), children, d3d: true, sprites: [],
      ...(i % 3 ? { render: renderRectangle(c.width, c.height, random, i % 3 === 1 ? 1 : 0.5) } : {}) }));
    const tangents = occlusionTangents();
    for (const c of cases) if (c.render) Object.assign(tangents, renderPassTangent(c.fov, c.render.width, 'validate-frame-projection-movers'));
    const request = trackedModelRequest(occlusion, occlusionModelRequest(model, surfaceTextureFlags), kernel.memory);
    const results = run({ tangents, cases, model: request }).results;
    const depth = depthConstants(32);
    // The exported polygons: per mover and ordinal, the vertex words in Transform's order, and the rest vertices.
    const exported = movers.map((m, i) => {
      const { points, counts, reversed } = occlusion.tracker.moverPoints(i, { raw: true }), words = new Uint32Array(points.buffer, points.byteOffset, points.length);
      let at = 0;
      return { reversed, matrix: brushMatrix({ ...m.values, Location: pose[i].location, Rotation: pose[i].rotation }),
        polygons: counts.map((n, k) => { const out = { words: Array.from({ length: n }, (_, j) => Array.from(words.subarray(3 * (at + j), 3 * (at + j) + 3))) }; at += n; return out; }) };
    });
    // --mutate: the lowest bit of every exported polygon's first vertex flipped; the validator must fail.
    if (mutate) for (const m of exported) for (const polygon of m.polygons) polygon.words[0][0] ^= 1;
    // Each polygon's fragment nodes (the chain of each mover's nodes, by surface) and their vertices' words.
    // A polygon with one fragment of its own vertices in order was not cut by the BSP: unsplit.
    const fragments = new Map();
    movers.forEach((_, i) => { for (const n of occlusion.tracker.chain(i)) {
      const node = request.nodes[n], owner = occlusion.tracker.surfOwner(node.surface), k = `${i}:${owner.ordinal}`;
      const keys = Array.from({ length: node.vertexCount }, (_, v) => key(request.pointBits[request.verts[node.vertexPool + v][0]]));
      if (!fragments.has(k)) fragments.set(k, []);
      fragments.get(k).push(keys);
    } });
    const unsplit = new Set();
    for (const [k, nodes] of fragments) {
      const [i, ordinal] = k.split(':').map(Number), words = exported[i].polygons[ordinal].words.map(key), known = new Set(words);
      if (nodes.length === 1 && nodes[0].length === words.length && nodes[0].every(x => known.has(x))) {
        assert.deepEqual(nodes[0], words, `${mapName}: ${movers[i].name} polygon ${ordinal}: its fragment is not Transform's vertices in order`);
        unsplit.add(k); stats.unsplitPolygons++;
      } else {
        stats.splitPolygons++;
        const floats = words.map(x => x.split(',').map(v => wordFloat(Number(v))));
        for (const keys of nodes) for (const x of keys) {
          if (known.has(x)) { stats.shared++; continue; }
          // A vertex the tracker made (SplitWithPlaneFast's intersection), never a hair from one of Transform's.
          const at = x.split(',').map(v => wordFloat(Number(v))), nearest = Math.min(...floats.map(w => Math.hypot(...w.map((c, a) => c - at[a]))));
          assert.ok(nearest > 1e-3, `${mapName}: ${movers[i].name} polygon ${ordinal}: a fragment vertex ${nearest} from one of Transform's but not equal to it`);
          stats.cut++;
        }
      }
    }
    let frames = 0, drawn = 0;
    for (const [ci, c] of cases.entries()) {
      const o = results[ci], rect = rectOf(c);
      const list = [{ fields: o.frameBits, draw: o.draw, label: 'main' }, ...(o.frames ?? []).map(ch => ({ fields: ch.frameBits, draw: ch.draw, label: `child ${ch.index}` }))];
      for (const frame of list) {
        const view = frameOfFields(frame.fields, rect);
        frames++;
        for (const entries of frame.draw) for (const entry of entries) {
          const owner = occlusion.tracker.surfOwner(entry.iSurf);
          if (!owner) continue;
          const i = owner.tag - 0x40000000, polygon = exported[i].polygons[owner.ordinal], where = `${mapName} case ${ci} ${frame.label} ${movers[i].name} polygon ${owner.ordinal}`;
          stats.polygons.add(`${mapName}:${movers[i].name}:${owner.ordinal}`);
          for (const poly of entry.polys) {
            stats.fragments++; drawn++;
            const have = poly.pv.map(pv => pv >= 0 ? request.pointBits[pv] : null);
            const known = new Set(polygon.words.map(key));
            // (1) the chain on every model point of the fragment.
            for (const [k, t] of poly.points.entries()) {
              const pv = poly.pv[k], d = poly.d3d[k];
              stats.points++;
              if (pv < 0) { stats.clipped++; continue; }
              const point = have[k].map(wordFloat), v = viewPoint(view, point), projected = projectView(view, v), own = d3dVertex(view, depth, projected);
              if (word(t[5]) === word(floatWord(projected.screenY))) {
                assert.deepEqual([own.sx, own.sy, own.sz, own.rhw].map(x => word(floatWord(x))), d.map(word), `${where}: vertex of model point ${pv}`);
                stats.exact++;
              } else stats.clamped++;
            }
            // (2) a drawn fragment of an unsplit polygon: all its vertices are Transform's, in order unless the frustum cut it.
            const n = polygon.words.length;
            if (unsplit.has(`${i}:${owner.ordinal}`)) {
              stats.unsplit++;
              if (have.length === n && have.every(h => h)) {
                // OccludeBsp saves a polygon's points in the order it clipped them: the node's, or the reverse
                // (a polygon seen from its back), from any starting vertex.
                const order = sameCycle(have.map(key), polygon.words.map(key));
                assert.ok(order, `${where}: a drawn unsplit fragment is not Transform's vertices (${have.map(key)} vs ${polygon.words.map(key)})`);
                stats.whole++; stats.vertices += n; stats[order]++;
              }
              else for (const h of have) if (h) assert.ok(known.has(key(h)), `${where}: a vertex of a frustum-clipped fragment is not one of Transform's`);
            } else stats.split++;
            // (3) the page's earlier vertices of the polygon's vertices the fragment keeps.
            polygon.words.forEach((w, j) => {
              const at = have.findIndex(h => h && key(h) === key(w));
              if (at < 0) return;
              const rest = movers[i].polys[owner.ordinal].vertices[exported[i].reversed ? n - 1 - j : j];
              const point = matrixVertex(exported[i].matrix, rest), v = viewPoint(view, point), p = projectView(view, v), own = d3dVertex(view, depth, p), d = poly.d3d[at];
              const b = stats.before; b.points++;
              b.sxDiffer += word(floatWord(own.sx)) !== word(d[0]); b.szDiffer += word(floatWord(own.sz)) !== word(d[2]);
              b.errors.push(Math.max(Math.abs(own.sx - wordFloat(d[0])), Math.abs(own.sy - wordFloat(d[1]))));
              b.maxDepth = Math.max(b.maxDepth, Math.abs(own.sz - wordFloat(d[2])));
            });
          }
        }
      }
    }
    console.log(`${mapName}: ${movers.length} movers${moves.length ? ` (${moves.length} moved)` : ''}, ${cases.length} cameras, ${frames} frames, ${drawn} mover fragments drawn`);
  } finally {
    occlusion.dispose();
  }
}

const raised = ['DeusExMover16', 'DeusExMover17'].map(name => ({ name, offset: [0, 0, 96] }));
const turned = ['DeusExMover8', 'DeusExMover11'].map(name => ({ name, addRotation: [0, 6000, 0] }));
const jobs = [['00_Training', { count: 16, seed: 31 }], ['00_Training', { count: 10, seed: 37, moves: raised }],
  ['10_Paris_Club', { count: 14, seed: 41, moves: turned, children: true }], ['01_NYC_UNATCOIsland', { count: 14, seed: 43 }]];
if (mutate) {
  await assert.rejects(validate(...jobs[0]), /not equal to it/, 'a flipped bit in an exported vertex went undetected');
  console.log('mutation check: one flipped bit in each exported polygon is detected');
  process.exit(0);
}
for (const [mapName, options] of jobs) if (!only.size || only.has(mapName)) await validate(mapName, options);
const b = stats.before, sorted = b.errors.sort((x, y) => x - y), q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
console.log(`${stats.fragments} mover fragments of ${stats.polygons.size} polygons: ${stats.points} points (${stats.exact} model vertices equal the device's vertex bit for bit, ${stats.clipped} made by the clipper, ${stats.clamped} on the rasterizer's Y clamp); `
  + `${stats.unsplit} drawn fragments are of polygons the BSP left whole (${stats.whole} not cut by the frustum: exactly Transform's vertices: ${stats.same} in its order, ${stats.reversed} reversed; ${stats.vertices} vertices), ${stats.split} of split ones; `
  + `over all ${stats.unsplitPolygons + stats.splitPolygons} fragmented polygons: ${stats.unsplitPolygons} unsplit (fragment = Transform's vertices in order), ${stats.splitPolygons} split or partly dropped (${stats.shared} fragment vertices are Transform's, ${stats.cut} the tracker's cuts)`);
console.log(`the page's earlier vertices (group matrix x rest position) of the parts' polygon vertices: ${b.points} points, X differs in ${b.sxDiffer}, depth in ${b.szDiffer}; `
  + `pixel error p50 ${q(0.5).toExponential(2)} p99 ${q(0.99).toExponential(2)} max ${(sorted.at(-1) ?? 0).toExponential(2)}, depth max ${b.maxDepth.toExponential(2)}`);
console.log('validate-frame-projection-movers: ok');
