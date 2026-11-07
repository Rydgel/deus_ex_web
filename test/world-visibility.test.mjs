import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createWorldVisibility, REGIONS } from '../src/viewer/world-visibility.mjs';

const NODES = 40;
/** A world root of non-indexed meshes whose triangles carry a BSP node each, as world.mjs builds them. */
function world(seed = 1) {
  let state = seed;
  const random = () => (state = (state * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const root = new THREE.Group();
  for (const triangles of [30, 5, 64, 1]) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9 * triangles), 3));
    const mesh = new THREE.Mesh(geometry);
    mesh.userData = { nodes: Int32Array.from({ length: triangles }, () => Math.floor(random() * NODES)) };
    root.add(mesh);
  }
  return root;
}

/** The triangles (as vertex-index triples) a pass over `nodes` draws from `mesh`, by the plain rule. */
function expected(mesh, nodes) {
  const set = new Set(nodes), out = [];
  mesh.userData.nodes.forEach((node, t) => { if (set.has(node)) out.push(3 * t, 3 * t + 1, 3 * t + 2); });
  return out;
}

function drawn(mesh) {
  const { index, drawRange } = mesh.geometry;
  assert.ok(index, 'a selected mesh draws through its index');
  return Array.from(index.array.subarray(drawRange.start, drawRange.start + drawRange.count));
}

function withMode(mode, body) {
  const before = process.env.INDEX_REGIONS;
  process.env.INDEX_REGIONS = mode;
  try { return body(); } finally { if (before === undefined) delete process.env.INDEX_REGIONS; else process.env.INDEX_REGIONS = before; }
}

const sets = {
  main: Uint32Array.from([1, 2, 3, 5, 8, 13, 21, 34]),
  sky: Uint32Array.from([0, 4, 5, 6]),
  mirror: Uint32Array.from([7, 9, 11, 30, 31]),
  other: Uint32Array.from([2, 3, 20]),
  empty: new Uint32Array(0),
};

test('every mode draws the triangles of the node set, in mesh order, in each of a run of passes', () => {
  const order = ['main', 'sky', 'main', 'sky', 'mirror', 'main', 'sky', 'other', 'empty', 'main', 'sky', 'mirror', 'other', 'main'];
  for (const mode of ['single', 'regions', 'verify']) withMode(mode, () => {
    const root = world(), visibility = createWorldVisibility(root, NODES), meshes = root.children;
    for (const key of order) {
      visibility.select(sets[key]);
      for (const mesh of meshes) {
        assert.deepEqual(drawn(mesh), expected(mesh, sets[key]), `${mode} ${key}`);
        assert.equal(mesh.visible, expected(mesh, sets[key]).length > 0);
      }
      visibility.all();
      for (const mesh of meshes) { assert.equal(mesh.geometry.index, null); assert.equal(mesh.visible, true); }
    }
    if (mode === 'verify') assert.equal(visibility.stats.verified, order.length * meshes.length);
  });
});

test('regions keep the main and sky passes from rebuilding while their sets are unchanged', () => {
  const run = mode => withMode(mode, () => {
    const root = world(2), visibility = createWorldVisibility(root, NODES);
    for (let frame = 0; frame < 10; frame++) for (const key of ['sky', 'main']) { visibility.select(sets[key]); visibility.all(); }
    return { ...visibility.stats };
  });
  const single = run('single'), regions = run('regions');
  assert.equal(single.regions, 1);
  assert.equal(single.rebuilds, 20, 'one region: both passes rebuild every time');
  assert.equal(regions.regions, REGIONS);
  assert.equal(regions.rebuilds, 2, 'two sets, two rebuilds');
  assert.equal(regions.regionHits, 18);
  assert.ok(regions.uploads <= single.uploads / 5);
});

test('more sets than regions replace the one drawn longest ago and stay right', () => {
  withMode('verify', () => {
    const root = world(3), visibility = createWorldVisibility(root, NODES);
    const keys = ['main', 'sky', 'mirror', 'other', 'main', 'sky', 'other', 'mirror', 'main'];
    for (const key of keys) { visibility.select(sets[key]); visibility.all(); }
    // main, sky, mirror fill the three regions; other replaces main (oldest), then main replaces sky, sky replaces mirror ...
    assert.equal(visibility.stats.rebuilds, keys.length - visibility.stats.regionHits);
    assert.ok(visibility.stats.rebuilds >= 4);
  });
});

test('the GPU copy the pending update ranges build equals the index of every region a pass draws, with meshes culled in some passes', () => {
  withMode('regions', () => {
    const root = world(4), visibility = createWorldVisibility(root, NODES), meshes = root.children;
    // What three.js keeps: a buffer created whole at a mesh's first draw, then only the pending ranges at a version change.
    const gpu = meshes.map(() => null), seen = meshes.map(() => 0);
    const render = (culled) => meshes.forEach((mesh, m) => {
      if (!mesh.visible || culled.has(m)) return;
      const index = mesh.geometry.index;
      if (!gpu[m]) { gpu[m] = Uint32Array.from(index.array); seen[m] = index.version; index.clearUpdateRanges(); return; }
      if (seen[m] < index.version) {
        assert.ok(index.updateRanges.length <= REGIONS, 'pending ranges stay bounded');
        for (const { start, count } of index.updateRanges) gpu[m].set(index.array.subarray(start, start + count), start);
        index.clearUpdateRanges(); seen[m] = index.version;
      }
      const { start, count } = mesh.geometry.drawRange;
      assert.deepEqual(Array.from(gpu[m].subarray(start, start + count)), Array.from(index.array.subarray(start, start + count)), `mesh ${m} on the GPU`);
    });
    // (the first two passes create every mesh's buffer; then a set is rebuilt while a mesh is culled, and another set's rebuild must not
    // drop the range still pending for it)
    const passes = [['main', []], ['sky', []], ['mirror', [0, 2]], ['other', [0, 2]], ['mirror', []], ['main', []], ['sky', []],
      ['sky', [1]], ['main', []], ['sky', [0, 2]], ['main', [2, 3]], ['mirror', []], ['main', []], ['sky', [1, 2, 3]], ['main', [0]],
      ['other', []], ['main', []], ['sky', []], ['mirror', [2]], ['main', []], ['sky', []]];
    for (const [key, culled] of passes) { visibility.select(sets[key]); render(new Set(culled)); visibility.all(); }
  });
});
