// movingLightLeafList / lazyLeafLists (dynamic-lighting.mjs) against the full
// Filter walk movingLightLeafLists, which scripts/validate-leaf-lights.mjs
// verifies against Render.dll: for random light sets on the real BSP models,
// every leaf's list (head first) is the same, including the leaves no light
// reaches. The single-leaf walk is a host restructuring: it follows the path
// from the root to the node the leaf hangs off instead of building every
// leaf's list. Synthetic BSPs cover the cases it hands to the full walk (a
// leaf with two owners, a node with two parents, a node unreachable from the
// root).
//
//   node scripts/validate-leaf-list-lazy.mjs [--cases 40]
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { movingLightLeafLists, movingLightLeafList, lazyLeafLists } from '../src/runtime/dynamic-lighting.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : Number(process.argv[i + 1]); };
const cases = option('cases', 40), f = Math.fround;
let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-leaf-list-lazy: no installed game data'); process.exit(0); }
let seed = 12345;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const int = n => Math.floor(random() * n);

function compare(model, lights, where) {
  const full = movingLightLeafLists(model, lights), lazy = lazyLeafLists(model, lights);
  const leaves = new Set(full.keys());
  for (const node of model.nodes) for (const leaf of node.leaves) if (leaf >= 0) leaves.add(leaf);
  leaves.add(-5); leaves.add(1 << 20);
  let checked = 0;
  for (const leaf of leaves) {
    assert.deepEqual(lazy.get(leaf), full.get(leaf), `${where}: leaf ${leaf}`);
    assert.deepEqual(movingLightLeafList(model, lights, leaf), full.get(leaf), `${where}: leaf ${leaf} (direct)`);
    checked++;
  }
  assert.equal(lazy.size, full.size, `${where}: size`);
  assert.deepEqual([...lazy.keys()].sort((a, b) => a - b), [...full.keys()].sort((a, b) => a - b), `${where}: keys`);
  return { checked, lists: full.size, entries: [...full.values()].reduce((n, list) => n + list.length, 0) };
}

const files = [];
const assets = new AssetStore(['00_Training', '01_NYC_UNATCOIsland', '10_Paris_Club', '11_Paris_Everett', '06_HongKong_WanChai_Underworld', '03_NYC_Airfield',
  '02_NYC_Bar', '15_Area51_Bunker'].map(name => ({ path: `Maps/${name}.dx`, read: () => readFile(path.join(root, 'Maps', `${name}.dx`)) })));
const totals = { leaves: 0, lists: 0, entries: 0, nonEmpty: 0 };
for (const mapName of ['00_Training', '01_NYC_UNATCOIsland', '10_Paris_Club', '11_Paris_Everett', '06_HongKong_WanChai_Underworld', '03_NYC_Airfield', '02_NYC_Bar', '15_Area51_Bunker']) {
  const asset = await assets.get(mapName), model = decodeMap(asset.bytes).model, bounds = model.bounds;
  let leaves = 0, lists = 0, entries = 0;
  for (let c = 0; c < cases; c++) {
    const count = c % 9 === 0 ? 0 : 1 + int(c % 3 === 0 ? 60 : 12), center = [0, 1, 2].map(k => bounds.min[k] + random() * (bounds.max[k] - bounds.min[k]));
    const lights = Array.from({ length: count }, () => {
      const spread = random() < 0.7 ? 1500 : 8000;
      return { location: center.map(v => f(v + (random() - 0.5) * spread)), radius: random() < 0.05 ? 0 : 1 + int(random() < 0.2 ? 2400 : 900) };
    });
    const result = compare(model, lights, `${mapName} case ${c}`);
    leaves += result.checked; lists += result.lists; entries += result.entries;
  }
  console.log(`${mapName}: ${model.nodes.length} nodes, ${cases} cases, ${leaves} leaf lists compared, ${lists} non-empty, ${entries} entries`);
  Object.assign(totals, { leaves: totals.leaves + leaves, lists: totals.lists + lists, entries: totals.entries + entries, nonEmpty: totals.nonEmpty + (lists ? 1 : 0) });
}
assert.ok(totals.entries > 0 && totals.nonEmpty === 8, 'the cases reach lights on every map');

// Synthetic BSPs: fragment-like leaf sharing, shared children, unreachable nodes.
const node = (plane, front, back, leaves) => ({ plane, front, back, leaves });
const synthetic = {
  tree: [node([1, 0, 0, 0], 1, 2, [-1, -1]), node([0, 1, 0, 0], -1, -1, [0, 1]), node([0, 0, 1, 0], -1, 3, [2, 3]), node([1, 0, 0, 100], -1, -1, [4, 5])],
  twoOwners: [node([1, 0, 0, 0], 1, -1, [6, 7]), node([0, 1, 0, 0], -1, -1, [7, 8])],        // leaf 7 hangs off two nodes
  sharedChild: [node([1, 0, 0, 0], 1, 1, [-1, -1]), node([0, 1, 0, 0], -1, -1, [9, 10])],       // node 1 has two parents
  unreachable: [node([1, 0, 0, 0], -1, -1, [11, 12]), node([0, 1, 0, 0], -1, -1, [13, 14])],     // node 1 is nobody's child
  fragmentLeaf: [node([1, 0, 0, 0], 1, -1, [15, 16]), node([0, 1, 0, 0], -1, -1, [16, 17])],      // a child that repeats its parent's side leaf
};
for (const [name, nodes] of Object.entries(synthetic)) {
  const model = { nodes };
  for (let c = 0; c < 200; c++) {
    const lights = Array.from({ length: 1 + int(8) }, () => ({ location: [0, 1, 2].map(() => f((random() - 0.5) * 400)), radius: 1 + int(300) }));
    compare(model, lights, `${name} case ${c}`);
  }
  console.log(`synthetic ${name}: 200 cases match`);
}
console.log(`validate-leaf-list-lazy: PASS (${totals.leaves} leaf lists on 8 maps, ${totals.entries} entries)`);
