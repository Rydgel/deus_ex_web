/** The GLSL chain (src/viewer/frame-projection-glsl.mjs) on the GPU against the
 * unchanged original (docs/frame-projection.md). The oracle data of
 * validate-frame-projection.mjs is replayed through headless Chromium (ANGLE
 * on the GPU, --angle): for every frame (main and child) the model points of
 * its draw lists go through fpView and fpVertex in a float32 render target,
 * and the mesh cases' view-space points through fpVertex. Every output word
 * equals the vertices of D3DDrv's vertex buffer and the view point of
 * ClipBspSurf's FTransform, bit for bit; the clip-space form's perspective
 * division reproduces the window position and depth within the host
 * rasterizer's rounding.
 *
 *   node scripts/validate-frame-projection-gpu.mjs [--angle gl|metal|vulkan] [map ...] */
import assert from 'node:assert/strict';
import { available, bspOracle, meshOracle, rectOf } from './frame-projection-cases.mjs';
import { depthConstants, floatWord, wordFloat } from '../src/runtime/frame-projection.mjs';
import { runGpuUnits } from './frame-projection-gpu-run.mjs';

if (!available) {
  console.log('SKIP validate-frame-projection-gpu: no native probe environment');
  process.exit(0);
}
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const angle = option('angle', process.platform === 'darwin' ? 'metal' : 'gl');
const only = new Set(process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--angle'));
const word = v => v >>> 0;
const f = v => wordFloat(v);

/** One GPU unit: a frame's uniforms and the points it projects. */
function unit(fields, rect, flip, depth, label) {
  return { label, origin: [0, 1, 2].map(k => f(fields[k])), axes: [3, 6, 9].map(b => [0, 1, 2].map(k => f(fields[b + k]))),
    proj: [f(fields[21]), f(fields[24]), f(fields[14]), f(fields[15])], rect: [rect.width, rect.height, rect.x, rect.y],
    depth: [depth.zBias, depth.zScale, flip], points: [], expected: [] };
}
const depth = depthConstants(32);
const units = [];
for (const [mapName, options] of [['01_NYC_UNATCOIsland', { seed: 13, count: 12, aimed: false }],
  ['10_Paris_Club', { seed: 7, count: 14, aimed: true, views: [32768, 40960, 0, 16384, 49152].map(yaw => ({ location: [2063, 273, 30], rotation: [0, yaw, 0] })) }]]) {
  if (only.size && !only.has(mapName)) continue;
  const { model, cases, results } = await bspOracle(mapName, options);
  for (const [i, c] of cases.entries()) {
    const o = results[i], rect = rectOf(c);
    const frames = [{ fields: o.frameBits, draw: o.draw, label: 'main', flip: 1 }, ...(o.frames ?? []).map(ch =>
      ({ fields: ch.frameBits, draw: ch.draw, label: `child ${ch.index}`, flip: ch.mirrorBits >>> 0 === 0xbf800000 ? -1 : 1 }))];
    for (const frame of frames) {
      const u = unit(frame.fields, rect, frame.flip, depth, `${mapName} case ${i} ${frame.label}`);
      const seen = new Set();
      for (const list of frame.draw) for (const entry of list) for (const poly of entry.polys) for (const [k, t] of poly.points.entries()) {
        const pv = poly.pv[k];
        if (pv < 0 || seen.has(pv)) continue;
        seen.add(pv);
        // Unreal world coordinates in; the FTransform's view point and the vertex out.
        u.points.push({ world: model.points.at(pv), view: [t[0], t[1], t[2]], mode: 0 });
        u.expected.push(poly.d3d[k]);
      }
      units.push(u);
    }
  }
}
for (const [mapName, options] of [['01_NYC_UNATCOIsland', { seed: 5, count: 8 }], ['10_Paris_Club', { seed: 9, count: 8 }]]) {
  if (only.size && !only.has(mapName)) continue;
  const { cases, results } = await meshOracle(mapName, options);
  for (const [i, c] of cases.entries()) {
    const o = results[i], u = unit(o.frameBits, rectOf(c), 1, depth, `${mapName} mesh case ${i}`);
    for (const p of o.points) if (p.flags === 0) { u.points.push({ world: p.point.map(f), view: p.point.map(word), mode: 1 }); u.expected.push(p.d3d); }
    // Points around the near plane (view depth 1, where the depth is 0): the exact form at and above it,
    // the linear form below it; only the clip-space mapping is checked for these.
    u.near = [1.0, 1.5, 3, 40, 0.99, 0.5, 0.1, 0.001, -3].map(z => ({ view: [z * 0.3, z * -0.2, z].map(Math.fround), mode: 1 }));
    for (const n of u.near) u.points.push({ world: n.view, view: n.view.map(floatWord), mode: 1 });
    units.push(u);
  }
}

const noBarrier = process.argv.includes('--no-barrier');
let nearChecked = 0, checked = 0, mismatched = 0, clipChecked = 0, maxClipPixel = 0, maxClipDepth = 0;
{
  const runtime = await runGpuUnits(units, { angle, noBarrier });
  assert.ok(!runtime.error, runtime.error);
  console.log(`GPU: ${runtime.renderer} (--angle ${angle})`);
  for (const [i, u] of units.entries()) {
    const r = runtime.results[i];
    // The near-plane points: the clip form against the analytic projection of the view point.
    for (const [j, n] of (u.near ?? []).entries()) {
      const k = u.expected.length + j, [cx, cy, cz, cw] = r.clip.slice(4 * k, 4 * k + 4), rect = u.rect, [x, y, z] = n.view;
      const frame = { fx15: u.proj[2], fy15: u.proj[3], projZ: u.proj[0], zBias: u.depth[0] };
      assert.ok(Math.abs(cw - z) < 1e-6 * Math.max(1, Math.abs(z)), `${u.label}: clip w of z ${z}`);
      // ndc x, y from ScreenX = X * Proj.Z / Z + FX15 (relative to the frame's rectangle, the view being it).
      const nx = (2 * (x * frame.projZ / z + frame.fx15) / rect[0] - 1), ny = (1 - 2 * (y * frame.projZ / z + frame.fy15) / rect[1]);
      const nz = 2 * frame.zBias * (1 - u.proj[1] * frame.projZ / z) - 1;
      const tolerance = (a, b, scale) => Math.abs(a - b) < 2e-5 * scale;
      assert.ok(tolerance(cx, nx * z, Math.max(1, Math.abs(nx * z))) && tolerance(cy, ny * z, Math.max(1, Math.abs(ny * z))) && tolerance(cz, nz * z, Math.max(1, Math.abs(nz * z))),
        `${u.label}: clip form at view depth ${z}: ${[cx, cy, cz]} vs ${[nx * z, ny * z, nz * z]}`);
      nearChecked++;
    }
    for (const [k, expected] of u.expected.entries()) {
      const got = r.vertex.slice(4 * k, 4 * k + 4).map(word);
      if (noBarrier) { checked++; mismatched += got.join() !== expected.map(word).join(); continue; }
      assert.deepEqual(got, expected.map(word), `${u.label}: GPU vertex of point ${k} (${JSON.stringify(u.points[k].view)}) ${got.map(f)} vs ${expected.map(f)}`);
      assert.deepEqual(r.view.slice(4 * k, 4 * k + 3).map(word), u.points[k].view.map(word), `${u.label}: GPU view point ${k}`);
      checked++;
      // The clip-space form: perspective division back to the window.
      const [cx, cy, cz, cw] = r.clip.slice(4 * k, 4 * k + 4);
      if (cw >= 1) {
        const flip = u.depth[2], rect = u.rect;
        const nx = cx / cw * flip, ny = cy / cw, nz = cz / cw;
        const sx = (nx + 1) / 2 * rect[0] + rect[2] - 0.5, sy = (1 - ny) / 2 * rect[1] + rect[3] - 0.5, sz = (nz + 1) / 2;
        const dx = Math.abs(sx - f(expected[0])), dy = Math.abs(sy - f(expected[1])), dz = Math.abs(sz - f(expected[2]));
        maxClipPixel = Math.max(maxClipPixel, dx, dy); maxClipDepth = Math.max(maxClipDepth, dz); clipChecked++;
        assert.ok(dx < 2e-3 && dy < 2e-3 && dz < 3e-7, `${u.label}: clip form of point ${k}: ${dx} ${dy} ${dz}`);
      }
    }
  }
}
if (noBarrier) { console.log(`without the barrier: ${mismatched} of ${checked} vertices differ`); process.exit(0); }
console.log(`${units.length} units, ${checked} GPU vertices equal the original's bit for bit; clip form: ${clipChecked} points (+${nearChecked} around the near plane), `
  + `largest window error ${maxClipPixel.toExponential(2)} px, depth ${maxClipDepth.toExponential(2)}`);
console.log('validate-frame-projection-gpu: ok');
