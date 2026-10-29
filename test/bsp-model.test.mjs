import test from 'node:test';
import assert from 'node:assert/strict';
import { readModel, triangulateModel } from '../src/unreal/model.mjs';
import { modelFromObjects, modelObjects, BspNodes, MemoryNodes, NodeAccess } from '../src/unreal/bsp-model.mjs';
import { BspCollider, readCollisionHulls } from '../src/runtime/collision.mjs';
import { readModel as referenceReadModel, triangulateModel as referenceTriangulate } from './helpers/model-reference.mjs';
import { BspCollider as ReferenceCollider } from './helpers/collision-reference.mjs';

// A deterministic generator, so a failure replays.
const rng = seed => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;

/** UE1 signed compact index. */
function compact(n) {
  const bytes = [];
  let v = Math.abs(n), first = (n < 0 ? 0x80 : 0) | (v % 64);
  v = Math.floor(v / 64);
  if (v > 0) first |= 0x40;
  bytes.push(first);
  while (v > 0) { let b = v % 128; v = Math.floor(v / 128); if (v > 0) b |= 0x80; bytes.push(b); }
  return bytes;
}

/** The serialized Model of `count`-sized random tables, valid by construction (every index in range). */
function randomModelBytes(random, { zone = null, nodes = 12, surfaces = 6, vertices = 40, points = 20, vectors = 8, zones = 3, lightMaps = 4, bounds = 3, hulls = 30, leaves = 5, lights = 7 } = {}) {
  const out = [], u8 = n => out.push(n & 255), index = n => out.push(...compact(n));
  const i32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n | 0, true); out.push(...b); };
  const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); out.push(...b); };
  const specials = [0, -0, 1, -1, 1.5, 1e-40, 3.4028234e38, -3.4028234e38];
  const f32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, n, true); out.push(...b); };
  const real = () => random() < .2 ? specials[Math.floor(random() * specials.length)] : (random() * 2 - 1) * 4000;
  const int = n => Math.floor(random() * n), mask = () => (random() < .3 ? [0, 0xffffffff, 0x80000000, 1][int(4)] : Math.floor(random() * 4294967296));
  const link = n => random() < .3 ? -1 : int(n);
  const vector = () => { f32(real()); f32(real()); f32(real()); };
  index(0);                                            // the empty property list (None)
  vector(); vector(); u8(1);                           // bounds box
  vector(); f32(real());                               // sphere
  index(vectors); for (let i = 0; i < vectors; i++) vector();
  index(points); for (let i = 0; i < points; i++) vector();
  index(nodes);
  for (let i = 0; i < nodes; i++) {
    vector(); f32(real()); u32(mask()); u32(mask()); u8(int(256));
    const count = int(5);
    index(count ? int(vertices - count + 1) : int(vertices));             // vertexPool
    index(int(surfaces)); index(link(nodes)); index(link(nodes)); index(link(nodes));   // surface, back, front, coplanar
    index(link(hulls)); index(link(bounds));                                              // collisionBound, renderBound
    index(zone ?? int(256)); index(int(256)); u8(count); i32(link(leaves)); i32(link(leaves));   // zones, vertexCount, leaves
  }
  index(surfaces);
  for (let i = 0; i < surfaces; i++) {
    index(0); u32(mask()); index(int(points)); index(int(vectors)); index(int(vectors)); index(int(vectors));
    index(link(lightMaps)); index(int(100) - 50);
    const pan = () => { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, int(65536) - 32768, true); out.push(...b); };
    pan(); pan(); index(0);
  }
  index(vertices); for (let i = 0; i < vertices; i++) { index(int(points)); index(int(3) - 1); }
  i32(int(100));                                       // shared sides
  i32(zones); for (let i = 0; i < zones; i++) { index(0); u32(mask()); u32(mask()); u32(mask()); u32(mask()); }
  index(0);                                            // polygons
  index(lightMaps);
  for (let i = 0; i < lightMaps; i++) { i32(int(5000)); vector(); index(int(60)); index(int(60)); f32(real()); f32(real()); i32(int(lights)); }
  const bits = int(20); index(bits); for (let i = 0; i < bits; i++) u8(int(256));
  index(bounds); for (let i = 0; i < bounds; i++) { vector(); vector(); u8(int(2)); }
  index(hulls); for (let i = 0; i < hulls; i++) i32(random() < .5 ? -1 : int(nodes) | (random() < .3 ? 0x40000000 : 0));
  index(leaves); for (let i = 0; i < leaves; i++) { index(int(zones)); index(link(lights)); index(link(lights)); u32(mask()); u32(mask()); }
  index(lights); for (let i = 0; i < lights; i++) index(0);
  i32(int(2)); i32(int(2));                            // root outside, linked
  return Uint8Array.from(out);
}
const packageFor = bytes => ({ version: 68, names: [{ name: 'None' }], imports: [], exports: [{ serialOffset: 0, serialSize: bytes.length, flags: 0, name: 'Test', className: 'Model' }] });

test('the typed model reads every table as the object reader did, on random compiled models', () => {
  const random = rng(20261030);
  let read = 0;
  for (let round = 0; round < 80; round++) {
    const sizes = { nodes: 1 + (round % 30), surfaces: 1 + (round % 9), vertices: 8 + (round % 50), points: 4 + (round % 25), vectors: 3 + (round % 8),
      zones: round % 4, lightMaps: round % 6, bounds: round % 5, hulls: round % 40, leaves: round % 7, lights: 1 + (round % 9) };
    const bytes = randomModelBytes(random, sizes), pkg = packageFor(bytes);
    let expected, expectedError = null, actual, actualError = null;
    try { expected = referenceReadModel(pkg, bytes, 1); } catch (error) { expectedError = error; }
    try { actual = readModel(pkg, bytes, 1); } catch (error) { actualError = error; }
    if (expectedError || actualError) {
      assert.equal(actualError?.message, expectedError?.message, `round ${round}`);
      continue;
    }
    read++;
    assert.deepStrictEqual({ ...modelObjects(actual), leafHulls: Array.from(actual.leafHulls), lights: Array.from(actual.lights) },
      { ...expected, leafHulls: Array.from(expected.leafHulls), lights: Array.from(expected.lights) }, `round ${round}`);
    for (const includeInvisible of [false, true]) assert.deepStrictEqual(triangulateModel(actual, { includeInvisible }), referenceTriangulate(expected, { includeInvisible }));
  }
  assert.ok(read >= 60, `${read} of 80 random models read`);
});

test('a node zone that is not a byte is refused, as the original FBspNode could not hold it', () => {
  const random = rng(7), bytes = randomModelBytes(random, { nodes: 1, surfaces: 1, vertices: 4, points: 4, zone: 300 });
  assert.equal(referenceReadModel(packageFor(bytes), bytes, 1).nodes[0].zones[0], 300);
  assert.throws(() => readModel(packageFor(bytes), bytes, 1), /Node zone 300 is not a byte/);
});

test('the node table is the original 64-byte FBspNode block: the same views serve a kernel memory', () => {
  const nodes = modelFromObjects({ nodes: [{ plane: [1, 2, 3, 4], zoneMask: [5, 0xffffffff], flags: 0x21, vertexPool: 9, surface: 3, back: 1, front: -1, coplanar: 2,
    collisionBound: 7, renderBound: 8, zones: [4, 5], vertexCount: 6, leaves: [10, -1] }] }).nodes;
  assert.ok(nodes instanceof NodeAccess && nodes instanceof BspNodes);
  assert.equal(nodes.u8.length, 64);
  assert.deepEqual(nodes.at(0), { plane: [1, 2, 3, 4], zoneMask: [5, 0xffffffff], flags: 0x21, vertexPool: 9, surface: 3, back: 1, front: -1, coplanar: 2,
    collisionBound: 7, renderBound: 8, zones: [4, 5], vertexCount: 6, leaves: [10, -1] });
  // FPlane +0, iBack +0x20, iFront +0x24, iZone +0x34, NumVertices +0x36, NodeFlags +0x37, iLeaf +0x38 (fast-line-check.mjs, bsp-occlusion.mjs).
  assert.equal(nodes.i32[8], 1); assert.equal(nodes.i32[9], -1); assert.deepEqual([...nodes.u8.subarray(52, 56)], [4, 5, 6, 0x21]); assert.equal(nodes.i32[14], 10);
  // The same block in a memory at an offset reads the same through MemoryNodes.
  const memory = { buffer: new ArrayBuffer(4096) };
  new Uint8Array(memory.buffer).set(nodes.u8, 256);
  const view = new MemoryNodes(memory, 256, 1);
  assert.deepEqual(view.at(0), nodes.at(0));
  assert.equal(view.has(1), false);
  memory.buffer = new ArrayBuffer(8192);                      // memory grew: the views are made again over the new buffer
  new Uint8Array(memory.buffer).set(nodes.u8, 256);
  assert.deepEqual(view.at(0), nodes.at(0));
});

test('a model made from objects refuses values the tables could not hold exactly', () => {
  assert.throws(() => modelFromObjects({ nodes: [{ plane: [0.1, 0, 0, 0] }] }), /not a float32/);
  assert.throws(() => modelFromObjects({ nodes: [{ plane: [1, 0, 0, 0], zones: [256, 0] }] }), /not a byte/);
  assert.throws(() => modelFromObjects({ leafHulls: [1.5] }), /32-bit/);
});

test('the typed hulls equal the object hulls: planes, bevels, box tree, line-candidate walk, sweeps and overlaps', () => {
  const random = rng(4093), data = new DataView(new ArrayBuffer(4));
  for (let round = 0; round < 12; round++) {
    const boxes = Array.from({ length: 3 + round * 3 }, () => {
      const min = [0, 1, 2].map(() => Math.fround((random() - .5) * 600)), size = [0, 1, 2].map(() => Math.fround(8 + random() * 120));
      return [min, min.map((v, i) => Math.fround(v + size[i]))];
    });
    const nodes = [], leafHulls = [];
    for (const [min, max] of boxes) {
      const offset = nodes.length, start = leafHulls.length;
      const planes = [[1, 0, 0, max[0]], [-1, 0, 0, -min[0]], [0, 1, 0, max[1]], [0, -1, 0, -min[1]], [0, 0, 1, max[2]], [0, 0, -1, -min[2]]];
      for (const [i, plane] of planes.entries()) { nodes.push({ plane, collisionBound: i === 0 ? start : -1 }); leafHulls.push(offset + (random() < .1 ? i | 0 : i)); }
      leafHulls.push(-1, ...[...min, ...max].map(f => { data.setFloat32(0, f, true); return data.getInt32(0, true); }));
    }
    const fixture = { nodes, leafHulls };
    for (const brush of [false, true]) {
      const tp = brush ? (p => [p[1] * 1.25 + 30, -p[0] * 1.25, p[2] + 5]) : undefined, tn = brush ? (n => [n[1], -n[0], n[2]]) : undefined;
      const model = modelFromObjects(fixture), reference = new ReferenceCollider(modelObjects(model), tp, tn), collider = new BspCollider(model, tp, tn);
      const hulls = readCollisionHulls(model, tp, tn);
      assert.equal(collider.hullCount, hulls.length);
      assert.deepStrictEqual(hulls.objects(), reference.hulls);
      assert.deepStrictEqual(Array.from(collider.prepare().partition), reference.partitionPlanes.flat());
      for (let q = 0; q < 60; q++) {
        const start = [0, 1, 2].map(() => (random() - .5) * 800), delta = [0, 1, 2].map(() => (random() - .5) * 600), extent = [[0, 0, 0], [3, 3, 3], [20, 20, 43]][q % 3];
        assert.deepStrictEqual(collider.candidates(start, delta, extent).map(h => collider.hulls.node[h]), reference.candidates(start, delta, extent).map(h => h.node));
        assert.deepStrictEqual(collider.sweep(start, delta, extent), reference.sweep(start, delta, extent));
        assert.equal(collider.overlaps(start, extent), reference.overlaps(start, extent));
      }
    }
  }
  // The errors of a damaged hull list are the object reader's.
  const planes = [[1, 0, 0, 10], [-1, 0, 0, 0]], bits = [0, 0, 0, 10, 10, 10].map(f => { data.setFloat32(0, f, true); return data.getInt32(0, true); });
  const base = { nodes: planes.map((plane, i) => ({ plane, collisionBound: i === 0 ? 0 : -1 })), leafHulls: [0, 1, -1, ...bits] };
  assert.throws(() => readCollisionHulls(modelFromObjects({ ...base, leafHulls: base.leafHulls.slice(0, -1) })), /Truncated/);
  assert.throws(() => readCollisionHulls(modelFromObjects({ ...base, leafHulls: [9999, ...base.leafHulls.slice(1)] })), /plane/);
});
