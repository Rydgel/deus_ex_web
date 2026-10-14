/** URender::ClipDecal in the Rust core (native/script-vm/src/decal.rs
 * `clip_decal`) against the unchanged original under Unicorn
 * (scripts/native-decal-render-oracle.py): docs/decals.md "Drawing".
 *
 * The oracle builds each frame with the original CreateMasterFrame and
 * OccludeBsp (and CreateChildFrame for mirror children), places synthetic
 * decals on drawn surfaces (quads straddling polygon edges, partly behind the
 * eye, with and without Nodes) and runs ClipDecal on every saved polygon of
 * each decal's surface at the render pass's 24-bit precision. The port gets
 * the same frame, surface, FDecal and polygon: its fragment's point count,
 * each point's camera-space position (its world point through Frame->Coords)
 * and U and V (its dot products over DrawScale) must be bit-equal. On a
 * Mover's surface the vertices first turn by Actor.Rotation - MoverRotation
 * (decal.rs clip_decal), with the moving brush tracker's surfaces a reachable
 * case.
 *
 *   node scripts/validate-decal-render.mjs
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
import { buildWindowSceneFrame } from '../src/runtime/script-window-scene-frame.mjs';
import { TEXTURE_POLYFLAG_BOOLS } from '../src/runtime/bsp-occlusion.mjs';
import { x87TanCandidates } from '../src/runtime/x87-tan.mjs';
import { depthConstants, floatWord, frameOfFields, projectView, d3dVertex, viewPoint, wordFloat } from '../src/runtime/frame-projection.mjs';
import { runGpuUnits } from './frame-projection-gpu-run.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
if (!existsSync(python)) {
  console.log('SKIP validate-decal-render: no native probe environment');
  process.exit(0);
}
const kernel = (await loadScriptVmKernel()).decals;
if (!kernel?.clipTest) throw new Error('The script VM core predates decal.rs ClipDecal (npm run build:wasm)');
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const bits = value => (f32[0] = value, u32[0]);
const num = b => (u32[0] = b, f32[0]);
const f = Math.fround;

// Core appTan's qword results: the game thread's FOV 75 and 90 (as
// validate-bsp-occlusion), and child frames' FOV rounded to 24 bits inside
// the render pass, whose correctly rounded tangent is the FPTAN result
// (docs/x87-tan.md).
const tangents = {}, io = new DataView(new ArrayBuffer(8));
const key64 = value => (io.setFloat64(0, value, true), io.getBigUint64(0, true).toString(16).padStart(16, '0'));
for (const [fov, result] of [[75, '3fe88df153d6a676'], [90, '3fefffffffffffff']]) {
  buildWindowSceneFrame({ location: [0, 0, 0], rotation: [0, 0, 0], width: 64, height: 64, fov, appTan: argument => {
    tangents[key64(argument)] = result;
    io.setBigUint64(0, BigInt(`0x${result}`), true);
    return io.getFloat64(0, true);
  } });
  const x = f(f(fov) * 0.008726646259971648), candidates = x87TanCandidates(x);
  assert.equal(candidates.length, 1, `child appTan for FOV ${fov}`);
  tangents[key64(x)] = key64(candidates[0]);
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

function cameras(map, seed, count) {
  let state = seed >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const starts = map.actors.filter(a => /PlayerStart/.test(a.className) && a.values.Location).map(a => a.values.Location);
  const nodes = map.actors.filter(a => /PathNode|PatrolPoint/.test(a.className) && a.values.Location).map(a => a.values.Location);
  return Array.from({ length: count }, (_, i) => {
    const p = i === 0 && starts.length ? starts[0] : nodes[Math.floor(random() * nodes.length)];
    const location = [p[0] + (random() - 0.5) * 30, p[1] + (random() - 0.5) * 30, p[2] + 20 + random() * 30];
    const pitch = i % 3 === 2 ? 0 : -Math.floor(1200 + random() * 5000);
    return { location, locationBits: location.map(bits), rotation: [pitch, Math.floor(random() * 65536), 0],
      width: [1024, 1280, 640][i % 3], height: [768, 720, 480][i % 3], fov: i % 2 ? 75 : 90,
      frameCounter: i, timeBits: bits(2 + i / 7) };
  });
}
const fixed = (location, views, width, height, fov, first) => views.map(([pitch, yaw], i) => ({ location,
  locationBits: location.map(bits), rotation: [pitch, yaw, 0], width, height, fov, frameCounter: first + i, timeBits: bits(3 + i / 5) }));
// The Training entrance looking at its mirror floor and the Paris club
// tunnel's mirrors make child frames.
const RUNS = [
  ['00_Training', map => [...cameras(map, 5, 5), ...fixed([-1149.24353, 825.84393, -40.2], [[-2600, 0], [-3600, 8000]], 926, 603, 75, 10)]],
  ['01_NYC_UNATCOIsland', map => cameras(map, 9, 3)],
  ['10_Paris_Club', () => fixed([2063, 273, 30], [[0, 32768], [0, 40960]], 1920, 1080, 90, 0)],
];
const TEXTURES = [{ usize: 64, vsize: 64, scaleBits: bits(1) }, { usize: 128, vsize: 128, scaleBits: bits(1) },
  { usize: 32, vsize: 64, scaleBits: bits(1) }, { usize: 256, vsize: 128, scaleBits: bits(0.5) }];

// Render's TransformPointBy, binary32 (the render pass's precision).
const transformPoint = (p, c) => {
  const dx = f(p[0] - c[0]), dy = f(p[1] - c[1]), dz = f(p[2] - c[2]);
  return [3, 6, 9].map(k => f(f(f(dx * c[k]) + f(dy * c[k + 1])) + f(dz * c[k + 2])));
};

const input = kernel.alloc(4 * 119), output = kernel.alloc(4 * 5 * 24);
const totals = { frames: 0, children: 0, cases: 0, nonempty: 0, points: 0, mover: 0, moverTurned: 0, maps: [],
  vertices: 0, flagged: 0, clamped: 0, maxClamp: 0, unclampedWrong: 0, units: [] };
// ClipDecal's tail (Render 0x10b1c5fd..0x10b1c825): each clipped world point goes through Frame->Coords, RZ = Proj.Z / Z
// and ScreenX/ScreenY, and a point whose outcode flags (the signs of Z*PrjXM + X, Z*PrjYM + Y, Z*PrjXP - X, Z*PrjYP - Y)
// are set has them clamped to [0, X - 1] and [0, Y - 1] (0x10b1c7ad..0x10b1c825); D3DDrv's DrawGouraudPolygon then builds
// the vertex (X = XB + ScreenX - 0.5, RHW = RZ * RProj.Z, depth). The reference chain (src/runtime/frame-projection.mjs)
// and the oracle's vertex buffer must agree bit for bit.
const depth32 = depthConstants(32);
const clampScreen = (value, limit) => (value < 0 ? 0 : value < limit ? value : limit);
for (const [mapName, cams] of RUNS) {
  const { map, model } = await oracleModel(mapName);
  const request = { gameRoot: root, tangents, model, textures: TEXTURES, d3d: { colorBits: 32, fog: 0, draw: true },
    frames: cams(map).map((camera, i) => ({ camera, seed: 100 + i, generate: { surfaces: 12, perSurface: 3 }, children: true })) };
  const started = performance.now();
  const result = JSON.parse(execFileSync(python, ['scripts/native-decal-render-oracle.py'],
    { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 1 << 30 }));
  let cases = 0;
  for (const view of result.views) for (const frame of view.frames) {
    totals.frames++; if (frame.depth) totals.children++;
    const coords = frame.frame.coordsBits, uncoords = frame.frame.uncoordsBits, coordsF = coords.map(num);
    for (const c of frame.cases) {
      const spec = frame.decals[c.decal];
      const item = frame.items.find(it => it.list === c.item[0] && it.index === c.item[1]);
      const poly = item.polys[c.poly];
      const words = [...coords, ...uncoords, ...spec.surfBaseBits, ...spec.surfNormalBits, ...spec.vertexBits.flat(),
        poly.points.length, ...poly.points.flatMap(p => p.slice(0, 3))];
      // A Mover's surface: Actor.Rotation - MoverRotation (int32 each).
      const mover = spec.surfActor?.mover ?? null;
      while (words.length < 115) words.push(0);
      words.push(mover ? 1 : 0, ...(mover ? mover.map((r, k) => (r - (spec.moverRotation?.[k] ?? 0)) | 0) : [0, 0, 0]));
      if (mover) totals.mover++;
      new Uint32Array(kernel.memory.buffer, input, words.length).set(words.map(v => v >>> 0));
      const n = kernel.clipTest(input, output);
      const where = `${mapName} frame depth ${frame.depth} decal ${c.decal} item ${c.item} poly ${c.poly}`;
      assert.notEqual(n, 0xffffffff, `${where}: fault`);
      const want = c.numPts === 0xcdcdcdcd ? 0 : c.numPts;
      assert.equal(n, want, `${where}: point count`);
      const out = new Uint32Array(kernel.memory.buffer, output, 5 * n), ds = num(spec.drawScaleBits);
      for (let k = 0; k < n; k++) {
        const camera = transformPoint([num(out[5 * k]), num(out[5 * k + 1]), num(out[5 * k + 2])], coordsF);
        const p = c.points[k];
        for (let a = 0; a < 3; a++) assert.equal(bits(camera[a]), p[a] >>> 0, `${where}: point ${k} ${'XYZ'[a]}`);
        assert.equal(bits(f(num(out[5 * k + 3]) / ds)), p[20] >>> 0, `${where}: point ${k} U`);
        assert.equal(bits(f(num(out[5 * k + 4]) / ds)), p[21] >>> 0, `${where}: point ${k} V`);
        totals.points++;
      }
      // The vertices DrawGouraudPolygon built from the fragment (D3DDrv 0x100056b0): the reference chain from the world points.
      const drawn = (c.d3d ?? []).find(event => event[0] === 'DrawPrimitiveVB');
      if (n && drawn) {
        const sp = frame.frame.sizeAndProj, fields = new Array(25).fill(0);
        coords.forEach((w, i) => { fields[i] = w; });
        Object.assign(fields, { 14: sp[6], 15: sp[7], 21: sp[13], 24: sp[16] });
        const view = frameOfFields(fields, { width: sp[0], height: sp[1], x: sp[2], y: sp[3] });
        assert.equal(drawn[3], n, `${where}: DrawGouraudPolygon's vertex count`);
        // The same points through the GLSL chain on the GPU (fpVertexDecal), below.
        const unit = { label: where, origin: coords.slice(0, 3).map(num), axes: [3, 6, 9].map(b => coords.slice(b, b + 3).map(num)),
          proj: [num(sp[13]), num(sp[16]), num(sp[6]), num(sp[7])], rect: [sp[0], sp[1], sp[2], sp[3]],
          depth: [depth32.zBias, depth32.zScale, 1], prj: sp.slice(17, 21).map(num), points: [], expected: [] };
        for (let k = 0; k < n; k++) {
          unit.points.push({ world: [num(out[5 * k]), num(out[5 * k + 1]), num(out[5 * k + 2])], view: [0, 0, 0], mode: 2 });
          unit.expected.push(drawn[5][k].slice(0, 4).map(w => w >>> 0));
        }
        totals.units.push(unit);
        for (let k = 0; k < n; k++) {
          const p = c.points[k], world = [num(out[5 * k]), num(out[5 * k + 1]), num(out[5 * k + 2])];
          const v = viewPoint(view, world), projected = projectView(view, v), flagged = (p[3] & 0xff) !== 0;
          let { screenX, screenY } = projected;
          if (flagged) {
            totals.flagged++;
            const clamped = [clampScreen(screenX, f(view.width - 1)), clampScreen(screenY, f(view.height - 1))];
            totals.maxClamp = Math.max(totals.maxClamp, Math.abs(clamped[0] - screenX), Math.abs(clamped[1] - screenY));
            if (clamped[0] !== screenX || clamped[1] !== screenY) totals.clamped++;
            [screenX, screenY] = clamped;
          }
          const own = d3dVertex(view, depth32, { rz: projected.rz, screenX, screenY }), want = drawn[5][k].slice(0, 4);
          assert.deepEqual([own.sx, own.sy, own.sz, own.rhw].map(x => floatWord(x) >>> 0), want.map(w => w >>> 0),
            `${where}: vertex ${k}${flagged ? ' (flagged)' : ''} of the fragment ${JSON.stringify([own.sx, own.sy, own.sz, own.rhw])} vs ${JSON.stringify(want.map(wordFloat))}`);
          totals.vertices++;
        }
      }
      cases++; totals.cases++; if (n) totals.nonempty++;
      if (mover && n && mover.some((r, k) => r !== (spec.moverRotation?.[k] ?? 0))) totals.moverTurned++;
    }
  }
  totals.maps.push(`${mapName} ${cases} cases (${((performance.now() - started) / 1000).toFixed(1)} s)`);
}
kernel.free(input); kernel.free(output);
// The GLSL chain (fpVertexDecal and its clip form) on the GPU, headless Chromium, for the same fragments.
{
  const angle = process.argv.includes('--angle') ? process.argv[process.argv.indexOf('--angle') + 1] : process.platform === 'darwin' ? 'metal' : 'gl';
  const runtime = await runGpuUnits(totals.units, { angle });
  let checked = 0, maxPixel = 0, maxDepth = 0, flaggedGpu = 0;
  for (const [i, u] of totals.units.entries()) {
    const r = runtime.results[i];
    for (const [k, expected] of u.expected.entries()) {
      assert.deepEqual(r.vertex.slice(4 * k, 4 * k + 4).map(w => w >>> 0), expected, `${u.label}: GPU decal vertex ${k}`);
      checked++;
      const [cx, cy, cz, cw] = r.clip.slice(4 * k, 4 * k + 4);
      if (cw >= 1) {
        const rect = u.rect, nx = cx / cw, ny = cy / cw, nz = cz / cw;
        const sx = (nx + 1) / 2 * rect[0] + rect[2] - 0.5, sy = (1 - ny) / 2 * rect[1] + rect[3] - 0.5, sz = (nz + 1) / 2;
        const dx = Math.abs(sx - wordFloat(expected[0])), dy = Math.abs(sy - wordFloat(expected[1])), dz = Math.abs(sz - wordFloat(expected[2]));
        maxPixel = Math.max(maxPixel, dx, dy); maxDepth = Math.max(maxDepth, dz);
        assert.ok(dx < 2e-3 && dy < 2e-3 && dz < 3e-7, `${u.label}: GPU decal clip form of point ${k}: ${dx} ${dy} ${dz}`);
      }
    }
  }
  totals.gpu = `${checked} GPU vertices (fpVertexDecal) equal the original's bit for bit; clip form within ${maxPixel.toExponential(1)} px and ${maxDepth.toExponential(1)} depth (${runtime.renderer})`;
}
assert.ok(totals.nonempty > 100 && totals.children > 0, 'the cases reach nonempty fragments and child frames');
console.log(`validate-decal-render: ${totals.maps.join(', ')}; ${totals.frames} frames (${totals.children} children), ` +
  `${totals.cases} ClipDecal cases, ${totals.nonempty} nonempty, ${totals.points} points bit-equal (position, U, V); ` +
  `${totals.mover} of them on Mover surfaces (${totals.moverTurned} nonempty and turned by Actor.Rotation - MoverRotation); ` +
  `${totals.vertices} D3D vertices equal the reference chain bit for bit (${totals.flagged} points flagged outside the view, ${totals.clamped} of them moved by the screen clamp, largest ${totals.maxClamp.toExponential(2)} pixel); ${totals.gpu}; PASS`);
