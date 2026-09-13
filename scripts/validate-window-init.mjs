/** Validate the bounded original XWindow::Init contract. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {
  WINDOW_INIT_NATIVE,
  WINDOW_INIT_NATIVE_ADDRESSES,
  WINDOW_INIT_OFFSETS,
  WINDOW_INIT_NATIVE_CONTRACT,
  initWindowNative,
} from '../src/runtime/script-window-init.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory();
const extensionPath = path.join(root, 'System', 'Extension.dll');
const extension = new Uint8Array(await readFile(extensionPath));
assert.equal(createHash('sha256').update(extension).digest('hex'), WINDOW_INIT_NATIVE.dllSha256);

// The installed image has RVA/file-offset coincidence for this .text range.
const bodyBytes = extension.subarray(0x4bb30, 0x4be8c);
assert.equal(createHash('sha256').update(bodyBytes).digest('hex'),
  '2241b9bed1da6d4c3dcc29f67f3c8d1e33f3af4b70c30c20902e83aefd6eea8c');
assert.deepEqual([...extension.subarray(0x4bb30, 0x4bb40)], [
  0x55, 0x8b, 0xec, 0x6a, 0xff, 0x68, 0xf0, 0x88,
  0x05, 0x10, 0x64, 0xa1, 0, 0, 0, 0,
]);
assert.deepEqual([...extension.subarray(0x4be79, 0x4be8c)], [
  0x8b, 0x4d, 0xf4, 0x5f, 0x5e, 0x64, 0x89, 0x0d,
  0, 0, 0, 0, 0x5b, 0x8b, 0xe5, 0x5d, 0xc2, 4, 0,
]);

assert.equal(WINDOW_INIT_NATIVE.body, 0x1004bb30);
assert.equal(WINDOW_INIT_NATIVE.end, 0x1004be89);
assert.equal(WINDOW_INIT_NATIVE_ADDRESSES.fNameNoneIat, 0x10059124);
assert.equal(WINDOW_INIT_NATIVE_ADDRESSES.xgcOperatorNew, 0x10002c40);
assert.equal(WINDOW_INIT_NATIVE_ADDRESSES.xgcConstructor, 0x10026ad0);
assert.equal(WINDOW_INIT_NATIVE_ADDRESSES.addChild, 0x10050a80);
assert.equal(WINDOW_INIT_NATIVE_ADDRESSES.setFonts, 0x10027640);
assert.equal(WINDOW_INIT_NATIVE_CONTRACT.rawStorage.startsWith('read('), true);
assert.deepEqual(WINDOW_INIT_NATIVE_CONTRACT.packedColors.map(value => value.offset), [0x3d, 0x60, 0x100]);

const python = process.env.NATIVE_PROBE_PYTHON || path.resolve('.cache/native-probe-env/bin/python');
const native = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-window-init-oracle.py'), root,
], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024}));
assert.equal(native.hashes['Extension.dll'], WINDOW_INIT_NATIVE.dllSha256);
assert.equal(native.extensionBase, 0x12000000);
assert.equal(native.addresses.body, 0x1204bb30);
assert.equal(native.addresses.xgcOperatorNew, 0x12002c40);
assert.equal(native.addresses.addChild, 0x12050a80);
assert.equal(native.addresses.setFonts, 0x12027640);

const U8 = new Uint8Array(0x220);
const scalarBits = (value, type) => {
  if (type === 'f32') {
    const buffer = new ArrayBuffer(4), view = new DataView(buffer);
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
  }
  return value >>> 0;
};

function fixture(withParent) {
  const objects = new Map();
  const events = [], reads = [], writes = [];
  let nextGc = 0;
  const makeObject = (name, address) => {
    const object = {name, address, bytes: new Uint8Array(U8)};
    objects.set(address, object);
    return object;
  };
  const window = makeObject('window', 0x20001000);
  const parent = withParent ? makeObject('parent', 0x20002000) : null;
  const ancestor = withParent ? makeObject('ancestor', 0x20003000) : null;
  const put = (object, offset, value, type) => {
    const view = new DataView(object.bytes.buffer);
    if (type === 'u8') view.setUint8(offset, value);
    else if (type === 'f32') view.setFloat32(offset, value, true);
    else view.setUint32(offset, value >>> 0, true);
  };
  const get = (object, offset, type) => {
    const view = new DataView(object.bytes.buffer);
    if (type === 'u8') return view.getUint8(offset);
    if (type === 'f32') return view.getFloat32(offset, true);
    const value = view.getUint32(offset, true);
    return type === 'ptr' ? (objects.get(value) ?? value) : value;
  };
  const setPtrQuiet = (object, offset, value) => put(object, offset, value?.address ?? value ?? 0, 'u32');
  const writeEvent = (object, offset, type, value, details) => {
    const raw = type === 'ptr' ? (value?.address ?? value ?? 0) : scalarBits(value, type);
    writes.push({offset, size: type === 'u8' ? 1 : 4, value: raw >>> 0});
    put(object, offset, raw, 'u32');
    if (type === 'u8') put(object, offset, raw, 'u8');
    return value;
  };
  const read = (object, offset, type, details) => {
    reads.push({object: object.name, offset, size: type === 'u8' ? 1 : 4, type, phase: details.phase});
    return get(object, offset, type);
  };
  const write = (object, offset, type, value, details) => writeEvent(object, offset, type, value, details);
  const set = (object, offset, type, value) => put(object, offset, value, type);

  for (const [offset, value] of [[0x30, 0xa1b2c3d4], [0x38, 0x55667788],
    [0x74, 0x10203040], [0xb8, 0x55667704], [0xcc, 0xabcdef01]]) set(window, offset, 'u32', value);
  if (withParent) {
    setPtrQuiet(parent, 0x138, ancestor);
    setPtrQuiet(ancestor, 0x138, null);
    set(parent, 0x54, 'u32', 0x21212121);
    set(parent, 0x58, 'u32', 0x32323232);
    set(parent, 0xd4, 'f32', 3.25);
    set(parent, 0xd8, 'f32', -2.5);
    set(ancestor, 0x54, 'u32', 0x41414141);
    set(ancestor, 0x58, 'u32', 0x42424242);
  }
  const gc = [];
  const services = {
    read,
    write,
    fNameNone: details => { events.push({op: 'FName', enum: details.enum}); return 0; },
    xgcOperatorNew: details => {
      const object = makeObject(`gc${nextGc}`, 0x20010000 + nextGc++ * 0x1000);
      gc.push(object);
      events.push({op: 'XGCOperatorNew', size: details.size, outer: details.outer.name,
        name: details.name, flags: details.flags});
      return object;
    },
    xgcConstructor: details => { events.push({op: 'XGCConstructor', object: details.object.name}); },
    addChild: details => {
      events.push({op: 'AddChild', parent: details.parent.name, child: details.child.name, flag: details.flag});
      // AddChild's linked-list implementation is outside this boundary. Its
      // required postcondition for Init is the child's +0x138 parent link.
      setPtrQuiet(details.child, 0x138, details.parent);
    },
    childAdded: details => events.push({op: 'ChildAdded', parent: details.parent.name,
      child: details.child.name, slot: details.virtualSlot}),
    descendantAdded: details => events.push({op: 'DescendantAdded', parent: details.parent.name,
      child: details.child.name, slot: details.virtualSlot}),
    setFonts: details => events.push({op: 'SetFonts', graphicsContext: details.graphicsContext.name,
      normalFont: details.normalFont, boldFont: details.boldFont}),
  };
  initWindowNative({window, parent, parentPointerWord: parent?.address}, services);
  return {window, parent, ancestor, events, reads, writes, gc, get};
}

function normalizeNativeValue(value, fixtureValue) {
  if (value === 'window') return fixtureValue.window.address;
  if (value === 'parent') return fixtureValue.parent?.address ?? 0;
  if (value === 'ancestor') return fixtureValue.ancestor?.address ?? 0;
  if (value === 'gc0') return fixtureValue.gc[0]?.address ?? 0;
  if (value === 'gc1') return fixtureValue.gc[1]?.address ?? 0;
  return value;
}

function nativeWrites(caseValue, fixtureValue) {
  return caseValue.writes.map(write => ({...write,
    value: normalizeNativeValue(write.value, fixtureValue)}));
}

function nativeReads(caseValue) {
  return caseValue.reads.map(read => [read.object, read.offset]);
}

function translatedReads(fixtureValue) {
  return fixtureValue.reads.map(read => [read.object, read.offset]);
}

for (const [name, withParent] of [['parentNull', false], ['parentFonts', true]]) {
  const original = native.cases[name];
  const translated = fixture(withParent);
  assert.deepEqual(translated.events.map(event => event.op), original.events.map(event => event.op), `${name} call order`);
  assert.deepEqual(translated.writes, nativeWrites(original, translated), `${name} raw writes`);
  assert.deepEqual(translatedReads(translated), nativeReads(original), `${name} fresh raw reads`);
  assert.deepEqual(translated.window.bytes.slice(0x3d, 0x41),
    Uint8Array.from([original.state.packedColors[0] & 0xff,
      (original.state.packedColors[0] >>> 8) & 0xff,
      (original.state.packedColors[0] >>> 16) & 0xff,
      (original.state.packedColors[0] >>> 24) & 0xff]));
  assert.deepEqual(translated.window.bytes.slice(0x60, 0x64),
    Uint8Array.from([original.state.packedColors[1] & 0xff,
      (original.state.packedColors[1] >>> 8) & 0xff,
      (original.state.packedColors[1] >>> 16) & 0xff,
      (original.state.packedColors[1] >>> 24) & 0xff]));
  assert.deepEqual(translated.window.bytes.slice(0x100, 0x104),
    Uint8Array.from([original.state.packedColors[2] & 0xff,
      (original.state.packedColors[2] >>> 8) & 0xff,
      (original.state.packedColors[2] >>> 16) & 0xff,
      (original.state.packedColors[2] >>> 24) & 0xff]));
  assert.deepEqual(translated.window.bytes.slice(0xd4, 0xec),
    Uint8Array.from(new Uint8Array(new Float32Array(original.state.origin).buffer)));
  assert.equal(translated.events.at(-1).op, 'SetFonts');
  if (withParent) {
    assert.equal(translated.window.bytes[0x3d + 3], 0x20,
      'parent pointer high byte is retained in +0x3d packed storage');
    assert.equal(translated.window.bytes[0x60 + 3], 0x20,
      'parent pointer high byte is retained in +0x60 packed storage');
    assert.equal(translated.window.bytes[0x100 + 3], 0x20,
      'parent pointer high byte is retained in +0x100 packed storage');
    assert.equal(translated.events.filter(event => event.op === 'DescendantAdded').length, 2);
  } else {
    assert.equal(translated.window.bytes[0x3d + 3], 0,
      'null parent leaves +0x3d fourth byte at zero');
  }
}

assert.throws(() => initWindowNative({window: {}, parent: {}}, {
  read: () => 0, write: () => {}, fNameNone: () => 0,
  xgcOperatorNew: () => null,
}), /requires (?:pointerWord|parent pointer word)|addressOf/);

console.log('Window Init contract validated: hash-checked unchanged Extension.dll body, exact raw writes/read order, ' +
  'parent-null/non-null callback order, packed-color retained high byte, XGC leaves, and font inheritance.');
