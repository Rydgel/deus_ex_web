/** D3DDrv's detail-texture pass, from the original run under Unicorn (scripts/native-frame-projection-oracle.py: the unchanged
 * DrawComplexSurface with Surface.DetailTexture set, over each draw list's saved polygons, its facet's view-space MapCoords from
 * Render.dll's own block and Core's TransformVectorBy, its stage values from SetTexture's instructions) against the CPU
 * reference src/runtime/detail-pass.mjs (docs/frame-projection.md "Detail textures").
 *
 * Cameras close to walls and floors with a DetailTexture on Training and Island (distances from 8 to 400 units, so each of
 * the three layers meets polygons wholly inside D, straddling it and outside, and the alpha ramp is sampled). For every draw
 * list entry with a detail texture: the pass' calls are the expected sequence (SetBlending's SetRenderState calls for
 * PF_Modulated, COLOROP 12, ZBIAS 15, SetTexture of the detail texture, the fans, the restore), and every fan the original
 * drew (layer, polygon, X, Y, depth, RHW, colour, U, V) equals the reference's bit for bit.
 *
 *   node scripts/validate-detail-pass.mjs [map ...] */
import assert from 'node:assert/strict';
import { frameOfFields, depthConstants, wordFloat, floatWord } from '../src/runtime/frame-projection.mjs';
import { detailFans, detailStage, facetOf } from '../src/runtime/detail-pass.mjs';
import { available, bspOracle, rectOf } from './frame-projection-cases.mjs';
import { detailJobs } from './detail-pass-cases.mjs';

if (!available) {
  console.log('SKIP validate-detail-pass: no native probe environment');
  process.exit(0);
}
const only = new Set(process.argv.slice(2).filter(a => !a.startsWith('--')));
const stats = { cases: 0, facets: 0, entries: 0, polys: 0, fans: 0, vertices: 0, clipVertices: 0, alphaMin: 255, alphaMax: 0, layers: [0, 1, 2].map(() => ({ inside: 0, straddle: 0, outside: 0 })) };

const f = wordFloat, word = v => v >>> 0;

function checkEntry(entry, frame, depth, where, model, details) {
  const d = entry.detail;
  assert.ok(d.calls.length > 0, `${where}: no calls recorded`);
  const facet = { origin: d.facet[0].map(f), u: d.facet[1].map(f), v: d.facet[2].map(f) };
  const stage = { uIndex: d.stage[0], vIndex: d.stage[1], uScale: f(d.stage[2]), vScale: f(d.stage[3]) };
  // The facet and the stage as the port computes them (Render.dll's block + TransformVectorBy; SetTexture's bin and stage code).
  const surface = model.surfaces.at(entry.iSurf), info = details[entry.iSurf];
  const own = facetOf(frame, model.points.at(surface.base), model.vectors.at(surface.textureU), model.vectors.at(surface.textureV));
  for (const key of ['origin', 'u', 'v']) assert.deepEqual(own[key].map(v => word(floatWord(v))), d.facet[{ origin: 0, u: 1, v: 2 }[key]].map(word), `${where}: facet ${key}`);
  const ownStage = detailStage(info.uSize, info.vSize, wordFloat(info.scaleBits[0]));
  assert.deepEqual([ownStage.uIndex, ownStage.vIndex, word(floatWord(ownStage.uScale)), word(floatWord(ownStage.vScale))], d.stage.map(word), `${where}: stage values`);
  stats.facets++;
  const polys = entry.polys.map(poly => poly.points.map(t => ({ x: f(t[0]), y: f(t[1]), z: f(t[2]), screenX: f(t[4]), screenY: f(t[5]), rz: f(t[7]) })));
  const expected = detailFans(frame, depth, facet, stage, [0, 0], polys);
  // The original's calls: the base pass, then (when a fan was drawn) the pass' state, its fans, the restore.
  const firstState = d.calls.findIndex(c => c.op === 'rs' && c.args[0] === 27);
  const fans = d.calls.slice(firstState < 0 ? d.calls.length : firstState).filter(c => c.op === 'draw');
  assert.equal(fans.length, expected.length, `${where}: number of detail fans`);
  if (fans.length) {
    const states = d.calls.slice(firstState).filter(c => c.op !== 'draw').map(c => c.op === 'texture' ? `texture ${c.stage} ${c.info}` : `${c.op} ${c.args.join(' ')}`);
    assert.deepEqual(states, ['rs 27 1', 'rs 19 9', 'rs 20 3', 'rs 14 0', 'tss 0 1 12', 'rs 47 15', 'texture 0 detail', 'tss 0 1 4', 'rs 47 0'],
      `${where}: state calls`);
  } else {
    assert.equal(firstState, -1, `${where}: states set without a fan`);
  }
  for (const [i, fan] of fans.entries()) {
    const want = expected[i];
    assert.deepEqual([fan.layer, fan.first, fan.count], [want.layer, want.first, want.vertices.length], `${where}: fan ${i} layer, first vertex, count`);
    for (const [k, vertex] of fan.vertices.entries())
      assert.deepEqual(vertex.slice(0, 7).map(word), want.vertices[k].map(word), `${where}: fan ${i} (layer ${want.layer}, polygon ${want.poly}) vertex ${k}`);
    stats.fans++;
    stats.vertices += fan.count;
    stats.clipVertices += fan.vertices.filter(v => word(v[4]) >>> 24 === 0).length;
    for (const v of fan.vertices) { const a = word(v[4]) >>> 24; if (a) { stats.alphaMin = Math.min(stats.alphaMin, a); stats.alphaMax = Math.max(stats.alphaMax, a); } }
  }
  // Coverage per layer: polygons wholly inside the layer's D, straddling it, wholly outside.
  let distance = Math.fround(380);
  for (let layer = 0; layer < 3; layer++) {
    for (const poly of polys) {
      const n = poly.filter(p => p.z < distance).length;
      stats.layers[layer][n === poly.length ? 'inside' : n ? 'straddle' : 'outside']++;
    }
    distance = Math.fround(distance * f(0x3e727b4d));
  }
  stats.polys += polys.length;
  stats.entries++;
}

for (const [map, views] of detailJobs) {
  if (only.size && !only.has(map)) continue;
  const { model, details, cases, results } = await bspOracle(map, { seed: 1, count: 0, aimed: false, views, detail: true });
  for (const [i, c] of cases.entries()) {
    const o = results[i], rect = rectOf(c);
    const frame = frameOfFields(o.frameBits, rect), depth = depthConstants(32);
    for (const list of o.draw) for (const entry of list) if (entry.detail) checkEntry(entry, frame, depth, `${map} case ${i} (${c.location} ${c.rotation})`, model, details);
    stats.cases++;
  }
  console.log(`${map}: ${cases.length} cameras`);
}
console.log(JSON.stringify(stats));
if (!only.size) {
  for (const [layer, c] of stats.layers.entries())
    assert.ok(c.inside > 0 && c.straddle > 0 && c.outside > 0, `layer ${layer}: polygons inside, straddling and outside the fade distance all occur`);
  assert.ok(stats.clipVertices > 0 && stats.alphaMin < 255 && stats.alphaMax === 255, 'clip vertices and the alpha ramp occur');
}
console.log('validate-detail-pass: ok');
