import test from 'node:test';
import assert from 'node:assert/strict';
import { Reader, parsePackage } from '../src/unreal/package.mjs';
import { ByteWriter } from '../src/runtime/byte-writer.mjs';
import { PackageTables, buildPackage } from '../src/runtime/package-write.mjs';
import { parseAiWords, encodeAiEvents } from '../src/runtime/ai-events-payload.mjs';

test('ByteWriter is the inverse of the package Reader: integers, floats, compact indices and strings', () => {
  const w = new ByteWriter(4);   // grows
  const compacts = [0, 1, -1, 63, 64, -64, 127, 128, 8191, 8192, 1048575, 1048576, -1048576, 134217727, 134217728, 2147483647, -2147483647];
  w.u8(0xab); w.u16(0xbeef); w.u32(0xdeadbeef); w.i32(-123456); w.f32(1.5);
  for (const value of compacts) w.compact(value);
  w.string(''); w.string('Candybar3'); w.string('café'); w.string('日本');
  const r = new Reader(w.finish());
  assert.equal(r.u8(), 0xab); assert.equal(r.u16(), 0xbeef); assert.equal(r.u32(), 0xdeadbeef); assert.equal(r.i32(), -123456);
  assert.equal(r.f32(), 1.5);
  for (const value of compacts) assert.equal(r.compact(), value, `compact ${value}`);
  assert.equal(r.string(68), ''); assert.equal(r.string(68), 'Candybar3'); assert.equal(r.string(68), 'café'); assert.equal(r.string(68), '日本');
  assert.equal(r.offset, r.bytes.length);
});

test('a written compact index uses the shortest form of the original (6 + 7 + 7 + 7 + 5 bits)', () => {
  const size = value => new ByteWriter().compact(value).finish().length;
  assert.deepEqual([0, 63, 64, 8191, 8192, 1048575, 1048576, 134217727, 134217728].map(size), [1, 1, 2, 2, 3, 3, 4, 4, 5]);
  assert.equal(size(-1), 1);
});

test('buildPackage writes a version-68 package that parsePackage reads back: names, imports, exports and the header', () => {
  const tables = new PackageTables();
  const classKey = tables.importEntry({ classPackage: 'Core', className: 'Class', outerKey: tables.importEntry({ classPackage: 'Core', className: 'Package', outerKey: '', name: 'Engine' }), name: 'LevelInfo' });
  tables.name('None'); tables.name('LevelInfo0'); tables.name('Mine');
  tables.finalize();
  const exports = [
    { classKey, superRef: 0, outerExport: 0, name: 'LevelInfo0', flags: 0x70004, write: w => { w.compact(tables.name('None')); } },
    { classKey, superRef: 0, outerExport: 1, name: 'Mine', flags: 0x70001, write: w => { w.compact(tables.name('None')); w.u32(0xcafe); } },
  ];
  const guid = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const bytes = buildPackage(tables, exports, { guid });
  const pkg = parsePackage(bytes);
  assert.equal(pkg.version, 68);
  assert.deepEqual(pkg.names.map(entry => entry.name).sort(), [...new Set(['Core', 'Class', 'Package', 'Engine', 'LevelInfo', 'None', 'LevelInfo0', 'Mine'])].sort());
  assert.equal(pkg.imports.length, 2);
  assert.deepEqual(pkg.exports.map(entry => entry.name), ['LevelInfo0', 'Mine']);
  assert.deepEqual(pkg.exports.map(entry => entry.flags), [0x70004, 0x70001]);
  assert.equal(pkg.exports[1].outer, 1);
  assert.equal(pkg.exports[0].className, 'LevelInfo');
  const data = entry => bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize);
  assert.equal(data(pkg.exports[1]).length, 5);
  assert.deepEqual([...bytes.subarray(36, 52)], [...guid], 'the GUID follows the three table offsets');
});

test('the AI event words keep a receiver\'s best sender as the sender\'s actor handle (AIProcess stores the Actor), not an event ordinal', () => {
  // one type with a sender and a receiver whose best sender is the actor handle 5000 (far above the pool sizes)
  const settings = Array(68).fill(0);
  const words = [7, 0, 0, 1, 1,
    3, 0x1234, 0xabcd, 1, 1,
    5000, 0, ...settings,
    4000, 0, 11, 12, 1, 3, 1, 0, 1, 1, 1, 0x3f800000, 5000, 2, 0, 0];
  const parsed = parseAiWords(Uint32Array.from(words));
  assert.equal(parsed.receivers.length, 1);
  assert.equal(parsed.receivers[0].bestSender, 5000);
  const exportOfHandle = new Map([[5000, 9], [4000, 8]]);
  const positions = { types: [2], senders: [3], receivers: [4] };
  const writers = encodeAiEvents(parsed, positions, 1, { nameIndex: text => text.length, spelling: id => String(id), actorRef: handle => exportOfHandle.get(handle) ?? 0 });
  const w = new ByteWriter();
  writers.receivers[0](w);
  const r = new Reader(w.finish());
  r.compact();                                 // the empty property list's None
  assert.equal(r.compact(), 2);                // eventType
  assert.equal(r.compact(), 8);                // eventActor: the receiver's actor (handle 4000 -> export 8)
  r.i32(); r.compact();                        // bBeingDestroyed, nextEvent
  r.compact(); r.compact(); r.i32(); r.u8(); r.i32(); r.i32(); r.i32(); r.i32(); r.i32(); r.u32();   // callback .. bestScore
  assert.equal(r.compact(), 9, 'bestSender is the actor\'s export');
});

test('every written name carries the load flags: the original maps a name without the context to None (an editor-only .dx name such as bHidden, 0x40010, ended a tag list)', () => {
  const source = { names: [{ name: 'bHidden', flags: 0x40010 }, { name: 'Physics', flags: 0x70010 }, { name: 'Native', flags: 0x4070410 }], imports: [] };
  const tables = new PackageTables({ sourcePkg: source });
  for (const text of ['bHidden', 'Physics', 'Native', 'NewName']) tables.name(text);
  tables.finalize();
  const flags = Object.fromEntries(tables.nameList.map(entry => [entry.text, entry.flags]));
  assert.equal(flags.bHidden, 0x70010);
  assert.equal(flags.Physics, 0x70010);
  assert.equal(flags.Native, 0x4070410, 'the other bits are kept');
  assert.equal(flags.NewName, 0x70010);
  for (const value of Object.values(flags)) assert.equal(value & 0x70000, 0x70000);
});
