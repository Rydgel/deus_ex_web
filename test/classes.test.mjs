import test from 'node:test';
import assert from 'node:assert/strict';
import { Reader } from '../src/unreal/package.mjs';
import { skipBytecode, readClass, ClassDefaults } from '../src/unreal/classes.mjs';

const pkg = { version: 68, names: [{ name: 'None' }, { name: 'Call' }], exports: [{}], imports: [] };
test('script traversal tracks expanded references, nested native arguments and exact end', () => {
  const r = new Reader(Uint8Array.of(0x1b, 1, 0x61, 5, 0x20, 1, 0x16, 0x16, 99));
  skipBytecode(pkg, r, 14); assert.equal(r.u8(), 99);
  for (const [bytes, size] of [[[0x20], 5], [[0x20, 2], 5], [[0x20, 1], 2], [[0x60, 1, 0x25], 3], [[0x5f], 1], [[], -1]]) {
    assert.throws(() => skipBytecode(pkg, new Reader(Uint8Array.from(bytes)), size));
  }
});

function fixture(base = 0, brightness = 64) {
  const bytes = [base, 0, 0, 0, 1, ...Array(12 + 16 + 2 + 4 + 4 + 16).fill(0), 0, 0, 0, 0, 2, 1, brightness, 0];
  const data = Uint8Array.from(bytes);
  return { bytes: data, pkg: { version: 68, names: ['None', 'Light', 'LightBrightness'].map(name => ({ name })), imports: [], exports: [{ className: 'Class', name: 'Light', superIndex: base, flags: 0, serialOffset: 0, serialSize: data.length }] } };
}
test('class headers locate tagged defaults without a UObject tag prefix', () => {
  const a = fixture(); assert.equal(readClass(a, 1).values.LightBrightness, 64);
  const b = fixture(); b.bytes = b.bytes.subarray(0, -1); assert.throws(() => readClass(b, 1));
  assert.throws(() => readClass({ ...a, pkg: { ...a.pkg, version: 61 } }, 1), /Unsupported class version/);
});
test('inherited defaults respect subclass and instance overrides and detect cycles', async () => {
  const parent = fixture(0, 64), child = fixture(1, 35);
  const assets = { resolve: async asset => ({ key: asset === child ? 'Parent' : 'Child', asset: asset === child ? parent : child, index: 1 }) };
  const defaults = new ClassDefaults(assets);
  assert.equal((await defaults.get(parent, 1)).LightBrightness, 35);
  assert.equal((await defaults.forActor(parent, { index: 1, values: { LightBrightness: 17 } })).LightBrightness, 17);
  const cyclic = new ClassDefaults({ resolve: async () => ({ key: 'Cycle', asset: child, index: 1 }) });
  await assert.rejects(cyclic.get(child, 1), /Cyclic/);
});
