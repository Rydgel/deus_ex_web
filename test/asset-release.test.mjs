import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetStore } from '../src/unreal/assets.mjs';
import { PackageTables, buildPackage } from '../src/runtime/package-write.mjs';

// A small package with one export, `pad` bytes of payload: its size is what the released budget counts.
function packageBytes(pad) {
  const tables = new PackageTables();
  const classKey = tables.importEntry({ classPackage: 'Core', className: 'Class', outerKey: tables.importEntry({ classPackage: 'Core', className: 'Package', outerKey: '', name: 'Engine' }), name: 'Texture' });
  tables.name('None'); tables.name('Thing');
  tables.finalize();
  return buildPackage(tables, [{ classKey, superRef: 0, outerExport: 0, name: 'Thing', flags: 0x70004, write: w => { w.compact(tables.name('None')); for (let i = 0; i < pad; i++) w.u8(i & 255); } }], { guid: new Uint8Array(16) });
}

function store(names, budget) {
  const reads = [];
  const files = names.map(name => {
    const bytes = packageBytes(1000);
    return { path: `Textures/${name}.utx`, read: async () => { reads.push(name); return bytes.slice(); } };
  });
  return { assets: new AssetStore(files, { releasedBudget: budget }), reads };
}

test('a released package waits in the released cache: a later get returns the same asset without reading the file again', async () => {
  const { assets, reads } = store(['A'], 1 << 20);
  const first = await assets.get('A');
  assert.equal(assets.release('A'), true);
  assert.equal(assets.loaded('A'), undefined);
  assert.equal(assets.releasedBytes, first.bytes.byteLength);
  const again = await assets.get('A');
  assert.equal(again, first);
  assert.deepEqual(reads, ['A']);
  assert.equal(assets.releasedBytes, 0);
  assert.equal(assets.loaded('A'), first);
});

test('the released cache keeps at most its budget, the package released first leaving first', async () => {
  const { assets, reads } = store(['A', 'B', 'C'], 1);
  const size = (await assets.get('A')).bytes.byteLength;
  await assets.get('B'); await assets.get('C');
  assets.releasedBudget = 2 * size;
  for (const name of ['A', 'B', 'C']) assets.release(name);
  assert.deepEqual([...assets.released.keys()], ['b', 'c']);
  assert.equal(assets.releasedBytes, 2 * size);
  await assets.get('C');
  assert.deepEqual(reads, ['A', 'B', 'C']);
  await assets.get('A');
  assert.deepEqual(reads, ['A', 'B', 'C', 'A']);
});

test('only a loaded package is released', async () => {
  const { assets } = store(['A'], 1 << 20);
  assert.equal(assets.release('A'), false);
  assert.equal(assets.release('Missing'), false);
});
