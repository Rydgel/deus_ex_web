import test from 'node:test';
import assert from 'node:assert/strict';
import { movingLightLeafList, movingLightLeafLists, movingLightInView, viewPlanesOf } from '../src/runtime/dynamic-lighting.mjs';

// A deterministic generator, so a failure replays.
const rng = seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

/** A random BSP tree of `count` nodes: node i > 0 hangs off a random earlier node's free side, each side holds a child node, a
 * leaf of its own (unique ids) or nothing, as FBspNode.iLeaf does. */
function randomModel(random, count) {
  const f = Math.fround, nodes = [];
  let leaves = 0;
  for (let i = 0; i < count; i++) {
    const normal = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1];
    nodes.push({ plane: [f(normal[0]), f(normal[1]), f(normal[2]), f(random() * 400 - 200)], front: -1, back: -1, leaves: [-1, -1] });
  }
  const free = [];
  for (let i = 0; i < count; i++) { free.push([i, 'front']); free.push([i, 'back']); }
  const taken = new Set();
  for (let i = 1; i < count; i++) {
    let pick;
    do { pick = free[Math.floor(random() * free.length)]; } while (taken.has(pick) || pick[0] >= i);
    taken.add(pick);
    nodes[pick[0]][pick[1]] = i;
  }
  for (const [i, side] of free) {
    if (nodes[i][side] === -1 && random() < .8) nodes[i].leaves[side === 'back' ? 0 : 1] = leaves++;
    else if (nodes[i][side] !== -1 && random() < .2) nodes[i].leaves[side === 'back' ? 0 : 1] = leaves++;
  }
  return { model: { nodes }, leaves };
}

test('movingLightLeafList equals the full Filter walk, leaf by leaf', () => {
  const random = rng(7), f = Math.fround;
  let nonEmpty = 0, checked = 0;
  for (let round = 0; round < 120; round++) {
    const { model, leaves } = randomModel(random, 1 + Math.floor(random() * 40));
    const lights = Array.from({ length: Math.floor(random() * 9) }, () => ({
      location: [random() * 500 - 250, random() * 500 - 250, random() * 500 - 250], radius: 25 * (1 + Math.floor(random() * 40)) }));
    const full = movingLightLeafLists(model, lights);
    for (let leaf = -1; leaf <= leaves; leaf++) {
      const expected = full.get(leaf), actual = movingLightLeafList(model, lights, leaf);
      assert.deepEqual(actual, expected, `round ${round} leaf ${leaf}`);
      // Given the locations the caller keeps, too.
      assert.deepEqual(movingLightLeafList(model, lights, leaf, lights.map(light => light.location.map(f))), expected);
      checked++;
      if (expected) nonEmpty++;
    }
  }
  assert.ok(nonEmpty > 100, `${nonEmpty} non-empty lists of ${checked}`);
});

test('movingLightInView tests the sphere against the four ViewPlanes as before', () => {
  const words = new Uint32Array(16), floats = new Float32Array(words.buffer);
  const random = rng(11);
  let inside = 0, outside = 0;
  for (let round = 0; round < 400; round++) {
    for (let k = 0; k < 16; k++) floats[k] = k % 4 === 3 ? random() * 4000 - 2000 : random() * 2 - 1;
    const planes = viewPlanesOf(words);
    assert.equal(planes.length, 4);
    const values = { LightRadius: Math.floor(random() * random() * 256), VolumeRadius: Math.floor(random() * 4) };
    const location = [random() * 600 - 300, random() * 600 - 300, random() * 600 - 300];
    // The earlier body, with its destructuring.
    const f = Math.fround, volume = f(((values.VolumeRadius & 255) + 1) * 25), light = f(25 * ((values.LightRadius & 255) + 1));
    const radius = light < volume ? volume : light;
    const [lx, ly, lz] = location.map(f);
    let expected = true;
    for (const [px, py, pz, pw] of planes)
      if (-radius > f(f(f(f(lz * pz) + f(ly * py)) + f(px * lx)) - pw)) { expected = false; break; }
    assert.equal(movingLightInView(location, values, planes), expected);
    if (expected) inside++; else outside++;
  }
  assert.ok(inside > 20 && outside > 20, `${inside} in view, ${outside} out`);
});
