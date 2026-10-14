/** The vertices the render device receives, from the original (D3DDrv.dll
 * DrawComplexSurface and DrawGouraudPolygon over Render.dll's ClipBspSurf and
 * DrawLodMesh, unchanged under Unicorn: scripts/native-frame-projection-
 * oracle.py) against src/runtime/frame-projection.mjs and the host paths
 * (docs/frame-projection.md).
 *
 * BSP: seeded cameras on Island and the Paris club (cameras aimed at its
 * mirrors, so child frames occur), the render pass's rectangle on two cases
 * in three. For every frame (the main one and each child) and every saved
 * polygon of its draw lists, the oracle returns the polygon's FTransform
 * points as OccludeBsp left them and the vertex buffer DrawComplexSurface
 * built from them (X, Y, depth, RHW). A point that is a model vertex
 * (the point cache entry the transform came from) must match the reference
 * transform of that model point bit for bit; a polygon the rasterizer's Y
 * clamp rewrote (Rasterize 0x10b19cc0, "Y clamp") or a point the clipper
 * made (Sutherland-Hodgman) is counted apart.
 *
 * Meshes: camera-space points projected by DrawLodMesh (outcode block and
 * vertex projection) and converted by DrawGouraudPolygon.
 *
 * Host paths: the three.js camera's float32 evaluation (what Play drew with
 * before) must differ from the original on this data, and the GLSL chain
 * (--gpu) must equal the reference on the GPU.
 *
 *   node scripts/validate-frame-projection.mjs [map ...] */
import assert from 'node:assert/strict';
import { depthConstants, floatWord, frameOfFields, modelVertex, projectView, d3dVertex, wordFloat } from '../src/runtime/frame-projection.mjs';
import { available, bspOracle, meshOracle, rectOf } from './frame-projection-cases.mjs';
import * as THREE from 'three';
import { createPlayCamera, pointCamera, setFrameProjection } from '../src/viewer/play-camera.mjs';
import { toView } from '../src/unreal/geometry.mjs';

if (!available) {
  console.log('SKIP validate-frame-projection: no native probe environment');
  process.exit(0);
}
const only = new Set(process.argv.slice(2).filter(a => !a.startsWith('--')));

const stats = { frames: 0, children: 0, lists: 0, polys: 0, points: 0, modelPoints: 0, exact: 0, clamped: 0, clipped: 0,
  meshPoints: 0, meshInside: 0, meshExact: 0, depthCases: new Set(),
  coordsCamera: { errors: [], points: 0, sxDiffer: 0, maxDepth: 0, szDiffer: 0 },
  three: { errors: [], points: 0, sxDiffer: 0, syDiffer: 0, szDiffer: 0, maxPixel: 0, maxDepth: 0, pairs: 0, pairsDiffer: 0 } };
const word = v => v >>> 0;

/** What Play drew with before: the page's three.js camera (the frame's
 * projection as a symmetric projection plus a view offset, play-camera.mjs)
 * evaluated in binary32 as the vertex shader does (`projectionMatrix *
 * (modelViewMatrix * position)`, no fused operations), mapped back to the
 * Direct3D convention: X = XB + window X - 0.5, depth = window depth. */
function threeCamera(c, fields, rect, { now = false } = {}) {
  const camera = createPlayCamera();
  camera.aspect = rect.width / rect.height;
  // Before: the rotator's exact angles and far 65536. Now: the frame's Coords
  // (play-camera.mjs setCameraCoords) and the original's far 32767.
  if (!now) { camera.far = 65536; camera.updateProjectionMatrix(); }
  pointCamera(camera, { location: c.location, rotation: c.rotation, fov: c.fov });
  setFrameProjection(camera, { width: rect.width, height: rect.height, fx15: wordFloat(fields[14]), fy15: wordFloat(fields[15]),
    projZ: wordFloat(fields[21]), ...(now ? { coords: Array.from({ length: 12 }, (_, i) => wordFloat(fields[i])) } : {}) });
  camera.updateMatrixWorld();
  return camera;
}
function threeVertex(camera, rect, point) {
  const f = Math.fround, P = Float32Array.from(camera.projectionMatrix.elements), V = Float32Array.from(camera.matrixWorldInverse.elements);
  const [x, y, z] = toView(point).map(f);
  const mul = (M, v) => [0, 1, 2, 3].map(r => f(f(f(f(M[r] * v[0]) + f(M[4 + r] * v[1])) + f(M[8 + r] * v[2])) + f(M[12 + r] * v[3])));
  const clip = mul(P, mul(V, [x, y, z, 1]));
  const ndc = [0, 1, 2].map(k => f(clip[k] / clip[3]));
  const window = [f(f(f(ndc[0] * 0.5) + 0.5) * rect.width), f(f(f(1 - f(f(ndc[1] * 0.5) + 0.5)) * rect.height)), f(f(f(ndc[2] * 0.5) + 0.5))];
  return { sx: f(f(rect.x + window[0]) - 0.5), sy: f(f(rect.y + window[1]) - 0.5), sz: window[2], w: clip[3] };
}
const depth24 = z => Math.round(Math.min(Math.max(z, 0), 1) * 16777215);

/** Checks one frame's draw lists against the reference. */
function checkFrame(model, fields, rect, lists, where, camera = null, coords = null) {
  const frame = frameOfFields(fields, rect), depth = depthConstants(32), depths = [];
  stats.frames++;
  for (const list of lists) for (const entry of list) {
    stats.lists++;
    for (const poly of entry.polys) {
      stats.polys++;
      for (const [k, t] of poly.points.entries()) {
        stats.points++;
        const pv = poly.pv[k], d = poly.d3d[k];
        // D3DDrv's conversion of the FTransform it was given (always).
        const own = d3dVertex(frame, depth, { rz: wordFloat(t[7]), screenX: wordFloat(t[4]), screenY: wordFloat(t[5]) });
        assert.deepEqual([word(floatWord(own.sx)), word(floatWord(own.sy)), word(floatWord(own.sz)), word(floatWord(own.rhw))],
          d.map(word), `${where}: D3D vertex of an FTransform (pv ${pv})`);
        if (pv < 0) { stats.clipped++; continue; }
        stats.modelPoints++;
        const full = modelVertex(frame, depth, model.points[pv]);
        // The transform's own results (X, Y, Z, ScreenX, ScreenY, RZ).
        const ref = [full.view[0], full.view[1], full.view[2]].map(floatWord);
        assert.deepEqual([t[0], t[1], t[2]].map(word), ref.map(word), `${where}: view point of model point ${pv}`);
        const projected = projectView(frame, full.view);
        assert.equal(word(t[7]), word(floatWord(projected.rz)), `${where}: RZ of model point ${pv}`);
        assert.equal(word(t[4]), word(floatWord(projected.screenX)), `${where}: ScreenX of model point ${pv}`);
        if (word(t[5]) === word(floatWord(projected.screenY))) {
          assert.deepEqual([word(floatWord(full.sx)), word(floatWord(full.sy)), word(floatWord(full.sz)), word(floatWord(full.rhw))],
            d.map(word), `${where}: vertex of model point ${pv}`);
          stats.exact++;
          if (camera) {
            // The same model point through the page's camera.
            const t3 = threeVertex(camera, rect, model.points[pv]), s3 = stats.three;
            const dx = Math.abs(t3.sx - wordFloat(d[0])), dy = Math.abs(t3.sy - wordFloat(d[1])), dz = Math.abs(t3.sz - wordFloat(d[2]));
            s3.points++; s3.sxDiffer += word(floatWord(t3.sx)) !== word(d[0]); s3.syDiffer += word(floatWord(t3.sy)) !== word(d[1]);
            s3.szDiffer += word(floatWord(t3.sz)) !== word(d[2]);
            s3.maxPixel = Math.max(s3.maxPixel, dx, dy); s3.errors.push(Math.max(dx, dy)); s3.maxDepth = Math.max(s3.maxDepth, dz);
            depths.push([wordFloat(d[2]), t3.sz]);
            if (coords) {
              const tc = threeVertex(coords, rect, model.points[pv]), sc = stats.coordsCamera;
              sc.points++; sc.sxDiffer += word(floatWord(tc.sx)) !== word(d[0]); sc.szDiffer += word(floatWord(tc.sz)) !== word(d[2]);
              sc.maxDepth = Math.max(sc.maxDepth, Math.abs(tc.sz - wordFloat(d[2])));
              sc.errors.push(Math.max(Math.abs(tc.sx - wordFloat(d[0])), Math.abs(tc.sy - wordFloat(d[1]))));
            }
          }
        } else {
          // Rewritten by the rasterizer's Y clamp (0x10b19dd1..0x10b19e10): the
          // integer row IntY, stored as a float, for every point of the polygon.
          assert.equal(wordFloat(t[5]), t[6] | 0, `${where}: ScreenY of model point ${pv} is neither exact nor the clamped row`);
          stats.clamped++;
        }
      }
    }
  }
  // Depth-test outcomes of vertex pairs: neighbours in the original's depth order
  // (24-bit quantized) against the page's depths.
  depths.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < depths.length; i++) {
    const a = depths[i - 1], b = depths[i];
    const original = Math.sign(depth24(b[0]) - depth24(a[0])), host = Math.sign(depth24(b[1]) - depth24(a[1]));
    stats.three.pairs++; stats.three.pairsDiffer += original !== host;
  }
}

async function bsp(mapName, options) {
  const { model, cases, results } = await bspOracle(mapName, options);
  for (const [i, c] of cases.entries()) {
    const o = results[i], rect = rectOf(c);
    const where = `${mapName} case ${i} ${c.width}x${c.height}${c.render ? ` render ${c.render.width}x${c.render.height}+${c.render.x}+${c.render.y}` : ''} FOV ${c.fov}`;
    assert.deepEqual(o.depth, { zBias: floatWord(depthConstants(32).zBias), m34: 0x3f800000, zScale: floatWord(depthConstants(32).zScale) },
      `${where}: depth constants`);
    checkFrame(model, o.frameBits, rect, o.draw, where, threeCamera(c, o.frameBits, rect), threeCamera(c, o.frameBits, rect, { now: true }));
    for (const child of o.frames ?? []) {
      checkFrame(model, child.frameBits, rect, child.draw, `${where} child ${child.index}`);
      stats.children++;
    }
  }
  console.log(`${mapName}: ${cases.length} cases`);
}

/** Camera-space points of the mesh path. */
async function meshes(mapName, options) {
  const { cases, results } = await meshOracle(mapName, options);
  for (const [i, c] of cases.entries()) {
    const o = results[i], frame = frameOfFields(o.frameBits, rectOf(c)), depth = depthConstants(32);
    for (const p of o.points) {
      stats.meshPoints++;
      if (p.flags !== 0) continue;
      stats.meshInside++;
      const view = p.point.map(wordFloat), projected = projectView(frame, view), vertex = d3dVertex(frame, depth, projected);
      assert.deepEqual([projected.screenX, projected.screenY, projected.rz].map(floatWord).map(word), [p.transform[4], p.transform[5], p.transform[7]].map(word),
        `${mapName} mesh case ${i}: projection of ${view}`);
      assert.deepEqual([vertex.sx, vertex.sy, vertex.sz, vertex.rhw].map(floatWord).map(word), p.d3d.map(word),
        `${mapName} mesh case ${i}: vertex of ${view}`);
      stats.meshExact++;
    }
  }
  console.log(`${mapName}: ${cases.length} mesh frames`);
}

const jobs = [
  ['01_NYC_UNATCOIsland', { seed: 13, count: 12, aimed: false }],
  ['10_Paris_Club', { seed: 7, count: 14, aimed: true, views: [32768, 40960, 0, 16384, 49152].map(yaw => ({ location: [2063, 273, 30], rotation: [0, yaw, 0] })) }],
];
for (const [map, options] of jobs) if (!only.size || only.has(map)) await bsp(map, options);
for (const [map, options] of [['01_NYC_UNATCOIsland', { seed: 5, count: 8 }], ['10_Paris_Club', { seed: 9, count: 8 }]])
  if (!only.size || only.has(map)) await meshes(map, options);
const errors = stats.three.errors.sort((a, b) => a - b), quantile = q => errors[Math.min(errors.length - 1, Math.floor(q * errors.length))];
const coordErrors = stats.coordsCamera.errors.sort((a, b) => a - b), coordQuantile = q => coordErrors[Math.min(coordErrors.length - 1, Math.floor(q * coordErrors.length))];
console.log(JSON.stringify({ ...stats, depthCases: undefined, three: { ...stats.three, errors: undefined,
  pixelError: { p50: quantile(0.5), p90: quantile(0.9), p99: quantile(0.99), over0_01: errors.filter(e => e > 0.01).length } },
  coordsCamera: { ...stats.coordsCamera, errors: undefined, pixelError: { p50: coordQuantile(0.5), p90: coordQuantile(0.9), p99: coordQuantile(0.99), max: coordErrors.at(-1) } } }));
console.log('validate-frame-projection: ok');
