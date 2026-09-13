/** Focused original-evidence validator for Extension default construction. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

import {AssetStore} from '../src/unreal/assets.mjs';
import {readClass} from '../src/unreal/classes.mjs';
import {readObject} from '../src/unreal/objects.mjs';
import {bindScriptClassConstructor} from '../src/runtime/script-class-bind.mjs';
import {
  WINDOW_CONSTRUCTION_NATIVE,
  WINDOW_CONSTRUCTION_NATIVE_ADDRESSES,
  constructExtensionObjectNative,
  constructWindowNative,
  constructWindowGcNative,
  setWindowGcFontsNative,
} from '../src/runtime/script-window-construction.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory();
const files = (await readdir(path.join(root, 'System'))).map(name => ({
  path: `System/${name}`,
  read: () => readFile(path.join(root, 'System', name)),
}));
const assets = new AssetStore(files);
const core = await assets.get('Core');
const extension = await assets.get('Extension');
const deusEx = await assets.get('DeusEx');

function classRecord(asset, classPath) {
  const index = asset.exportsByPath.get(classPath.toLowerCase());
  assert.ok(index, `missing original class ${asset.name}.${classPath}`);
  const metadata = readClass(asset, index);
  return {index, entry: metadata.entry, metadata};
}

function sourceFor(asset, classPath) {
  const record = classRecord(asset, classPath);
  assert.ok(record.metadata.scriptText, `${asset.name}.${classPath} has source TextBuffer`);
  const reader = readObject(asset.pkg, asset.bytes, record.metadata.scriptText).reader;
  reader.u32();
  reader.u32();
  return {...record, source: reader.string(asset.pkg.version)};
}

function expectBytes(bytes, offset, expected, label) {
  assert.deepEqual([...bytes.subarray(offset, offset + expected.length)], expected, label);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const extObjectClass = classRecord(extension, 'ExtensionObject');
const windowClass = classRecord(extension, 'Window');
const gcClass = classRecord(extension, 'GC');
const hudBaseClass = classRecord(deusEx, 'HUDBaseWindow');
const hudInfoClass = classRecord(deusEx, 'HUDInfoLinkDisplay');
const coreObjectClass = classRecord(core, 'Object');
for (const classPath of ['ExtensionObject', 'Window', 'GC']) {
  assert.match(sourceFor(extension, classPath).source,
    /class\s+[A-Za-z0-9_]+[\s\S]*?\bnative\b[\s\S]*?\bnoexport\b/i,
    `${classPath} is native noexport`);
}

assert.equal(extObjectClass.index, WINDOW_CONSTRUCTION_NATIVE.classes.extensionObject.packageExport);
assert.equal(extObjectClass.entry.flags, WINDOW_CONSTRUCTION_NATIVE.classes.extensionObject.exportFlags);
assert.equal(extObjectClass.entry.superIndex, -8);
assert.equal(extObjectClass.metadata.classFlags, 0x112);
assert.equal(windowClass.index, WINDOW_CONSTRUCTION_NATIVE.classes.window.packageExport);
assert.equal(windowClass.entry.flags, WINDOW_CONSTRUCTION_NATIVE.classes.window.exportFlags);
assert.equal(windowClass.entry.superIndex, extObjectClass.index);
assert.equal(windowClass.metadata.classFlags, 0x112);
assert.equal(gcClass.index, WINDOW_CONSTRUCTION_NATIVE.classes.gc.packageExport);
assert.equal(gcClass.entry.flags, WINDOW_CONSTRUCTION_NATIVE.classes.gc.exportFlags);
assert.equal(gcClass.entry.superIndex, extObjectClass.index);
assert.equal(gcClass.metadata.classFlags, 0x112);
assert.equal(hudBaseClass.index, 301);
assert.equal(hudBaseClass.entry.flags, 0x000f0004);
assert.equal(hudBaseClass.entry.superIndex, -12);
assert.equal(hudBaseClass.metadata.classFlags, 0x12);
assert.equal(hudInfoClass.index, 305);
assert.equal(hudInfoClass.entry.flags, 0x000f0004);
assert.equal(hudInfoClass.entry.superIndex, hudBaseClass.index);
assert.equal(hudInfoClass.metadata.classFlags, 0x3a);
assert.equal(coreObjectClass.index, 3);
assert.equal(coreObjectClass.metadata.classFlags, 0x112);

// Core UClass::Bind is reused as the inheritance boundary.  Native class
// registration supplies Window's constructor; the two HUD records begin with
// null ClassConstructor slots and acquire it through superclass dispatch.
const coreObject = {key: 'core.object', base: null, nativeConstructor: null, objectFlags: 0};
const extensionObject = {
  key: 'extension.extensionobject', base: coreObject,
  nativeConstructor: WINDOW_CONSTRUCTION_NATIVE_ADDRESSES.extensionObjectInternal,
  objectFlags: extObjectClass.entry.flags,
};
const window = {
  key: 'extension.window', base: extensionObject,
  nativeConstructor: WINDOW_CONSTRUCTION_NATIVE_ADDRESSES.windowInternal,
  objectFlags: windowClass.entry.flags,
};
const hudBase = {key: 'deusex.hudbasewindow', base: window, nativeConstructor: null,
  objectFlags: hudBaseClass.entry.flags};
const hudInfo = {key: 'deusex.hudinfolinkdisplay', base: hudBase, nativeConstructor: null,
  objectFlags: hudInfoClass.entry.flags};
const visits = [];
const binding = new Set();
function bind(record) {
  if (binding.has(record)) throw new Error('cyclic class inheritance');
  binding.add(record);
  visits.push(record.key);
  try {
    bindScriptClassConstructor(record, {
      coreObject,
      isEditor: () => false,
      bindSuper: bind,
    });
  } finally {
    binding.delete(record);
  }
}
bind(hudInfo);
assert.deepEqual(visits, [hudInfo.key, hudBase.key, window.key]);
assert.equal(hudBase.nativeConstructor, WINDOW_CONSTRUCTION_NATIVE_ADDRESSES.windowInternal);
assert.equal(hudInfo.nativeConstructor, WINDOW_CONSTRUCTION_NATIVE_ADDRESSES.windowInternal);

const extensionBytes = new Uint8Array(await readFile(path.join(root, 'System', 'Extension.dll')));
assert.equal(sha256(extensionBytes), WINDOW_CONSTRUCTION_NATIVE.dllSha256, 'Extension.dll hash');
for (const item of Object.values(WINDOW_CONSTRUCTION_NATIVE.classes)) {
  const offset = item.registrationSizeImmediate - 0x10000000;
  const opcode = extensionBytes[offset];
  assert.ok(opcode === 0x6a || opcode === 0x68, 'original registration pushes total size');
  const size = opcode === 0x6a ? extensionBytes[offset+1]
    : new DataView(extensionBytes.buffer, extensionBytes.byteOffset).getUint32(offset+1, true);
  assert.equal(size, item.nativeObjectSize, item.scriptClass+' native allocation size');
}

// The image is PE-rebased by the Python oracle, so these thunk immediates are
// checked as file bytes at the preferred RVA/file-offset coincidence.
expectBytes(extensionBytes, 0x2770,
  [0x8b, 0x4c, 0x24, 0x04, 0x85, 0xc9, 0x74, 0x05, 0xe9, 0x03, 0x00, 0x00, 0x00],
  'XExtensionObject InternalConstructor');
expectBytes(extensionBytes, 0x2780,
  [0x56, 0x8b, 0xf1, 0xff, 0x15, 0x7c, 0x90, 0x05, 0x10,
    0xc7, 0x06, 0x88, 0x98, 0x05, 0x10, 0x8b, 0xc6, 0x5e, 0xc3],
  'XExtensionObject constructor');
expectBytes(extensionBytes, 0x3120,
  [0x8b, 0x4c, 0x24, 0x04, 0x85, 0xc9, 0x74, 0x05, 0xe9, 0x03, 0x00, 0x00, 0x00],
  'XWindow InternalConstructor');
expectBytes(extensionBytes, 0x3130,
  [0x56, 0x8b, 0xf1, 0xff, 0x15, 0x7c, 0x90, 0x05, 0x10, 0x33, 0xc0,
    0x89, 0x86, 0xd4, 0x00, 0x00, 0x00, 0x89, 0x86, 0xd8, 0x00, 0x00, 0x00,
    0x89, 0x86, 0xdc, 0x00, 0x00, 0x00, 0x89, 0x86, 0xe0, 0x00, 0x00, 0x00,
    0x89, 0x86, 0xe4, 0x00, 0x00, 0x00, 0x89, 0x86, 0xe8, 0x00, 0x00, 0x00,
    0xc7, 0x06, 0x30, 0x99, 0x05, 0x10, 0x8b, 0xc6, 0x5e, 0xc3],
  'XWindow constructor');
expectBytes(extensionBytes, 0x2ce0,
  [0x8b, 0x4c, 0x24, 0x04, 0x85, 0xc9, 0x74, 0x05, 0xe9, 0xe3, 0x3d, 0x02, 0x00],
  'XGC InternalConstructor');

const bodyHashes = {
  extensionObject: [0x2780, 0x2793, 'f64cdbff238d77c877a0d5f99cfef4e1229e3de903583e4a95efe7ad48b7a4ef'],
  window: [0x3130, 0x3169, '209ac87e790e6547d5a7f18b688e5be963479aa1cddab5e3196fbb1ace034403'],
  gc: [0x26ad0, 0x26c3b, 'ef910f9227b882d6f4161f43325989ebaf23520552fdef2ceadcbcbaca77e168'],
};
for (const [name, [start, end, expected]] of Object.entries(bodyHashes)) {
  assert.equal(sha256(extensionBytes.subarray(start, end)), expected, `${name} body bytes`);
}
assert.equal(sha256(extensionBytes.subarray(0x27610, 0x2762c)),
  '0847e53de1485a6df43f3e29378f988e08aba84fc8db33449967bd9bed9e5a60',
  'XGC::EnableTranslucentText bytes');

const python = process.env.NATIVE_PROBE_PYTHON || path.resolve('.cache/native-probe-env/bin/python');
const native = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-window-construction-oracle.py'), root,
], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));
assert.equal(native.hashes['Extension.dll'], WINDOW_CONSTRUCTION_NATIVE.dllSha256);
assert.equal(native.extensionBase, 0x12000000);
assert.equal(native.imports.coreUObjectConstructor, WINDOW_CONSTRUCTION_NATIVE_ADDRESSES.coreObjectConstructorThunk);
assert.equal(native.vtableSlots.windowInit, 0x1204bb30);
assert.equal(native.addresses.windowInitVtableSlot, 0x54);
assert.equal(WINDOW_CONSTRUCTION_NATIVE_ADDRESSES.windowInitVtableSlotAddress, 0x10059984);
assert.equal(WINDOW_CONSTRUCTION_NATIVE_ADDRESSES.windowInit, 0x1004bb30);

const fontMemory = new Uint8Array(0xb8).fill(0xa5);
const fontWrites = [];
setWindowGcFontsNative({graphicsContext: {}, normalFont: native.setFonts.normalFont,
  boldFont: native.setFonts.boldFont}, {
  write: (_object, offset, kind, value) => {
    assert.equal(kind, 'ptr');
    new DataView(fontMemory.buffer).setUint32(offset, value, true);
    fontWrites.push({offset, size: 4, value, phase: 'SetFonts'});
  },
});
assert.deepEqual(fontWrites, native.setFonts.writes, 'original SetFonts ordered pointer stores');
assert.deepEqual([...fontMemory], native.setFonts.bytes, 'SetFonts preserves surrounding storage');

function makeFixture(size, seed, address) {
  const object = {nativeAddress: address};
  const bytes = new Uint8Array(size);
  bytes.fill(seed);
  const view = new DataView(bytes.buffer);
  const writes = [];
  const reads = [];
  const events = [];
  const read = (target, offset, type, details) => {
    assert.equal(target, object);
    assert.equal(type, 'u32');
    assert.equal(details.width, 4);
    reads.push({offset, phase: details.phase});
    return view.getUint32(offset, true);
  };
  const write = (target, offset, type, value, details) => {
    assert.equal(target, object);
    const sizeOf = type === 'u8' ? 1 : type === 'u32' ? 4 : 0;
    assert.ok(sizeOf, `unsupported fixture write ${type}`);
    assert.equal(details.width, sizeOf);
    writes.push({offset, size: sizeOf, value: value >>> 0});
    if (type === 'u8') view.setUint8(offset, value);
    else view.setUint32(offset, value >>> 0, true);
  };
  const onEvent = event => events.push({op: event.op});
  const coreObjectConstructor = details => {
    assert.equal(details.native, WINDOW_CONSTRUCTION_NATIVE_ADDRESSES.coreObjectConstructorIat);
    write(object, 0, 'u32', 0x10179dfc, {width: 4});
  };
  return {object, bytes, writes, reads, events, read, write, onEvent, coreObjectConstructor};
}

const constructors = {
  extensionObject: constructExtensionObjectNative,
  window: constructWindowNative,
  gc: constructWindowGcNative,
};
const preferredVtables = {
  extensionObject: WINDOW_CONSTRUCTION_NATIVE.classes.extensionObject.vtable,
  window: WINDOW_CONSTRUCTION_NATIVE.classes.window.vtable,
  gc: WINDOW_CONSTRUCTION_NATIVE.classes.gc.vtable,
};

function normalizedWrite(write) {
  const value = write.value >= 0x12000000 && write.value < 0x13000000
    ? write.value - 0x02000000 : write.value;
  return {offset: write.offset, size: write.size, value: value >>> 0};
}

for (const name of Object.keys(constructors)) {
  const original = native.cases[name];
  const fixture = makeFixture(original.size, original.seed, original.object);
  const services = {
    read: fixture.read,
    write: fixture.write,
    onEvent: fixture.onEvent,
    coreObjectConstructor: fixture.coreObjectConstructor,
  };
  if (name === 'gc') services.nativeAddress = original.object;
  const result = constructors[name](fixture.object, services);
  assert.equal(result, fixture.object, `${name} returns this`);

  const originalWrites = original.body.writes.map(normalizedWrite);
  assert.deepEqual(original.internal.writes.map(normalizedWrite), originalWrites,
    `${name} InternalConstructor reaches same body writes`);
  assert.deepEqual(fixture.writes, originalWrites, `${name} raw writes`);
  const expectedEvents = name === 'gc'
    ? ['CoreUObjectConstructor', 'EnableTranslucentText']
    : ['CoreUObjectConstructor'];
  assert.deepEqual(fixture.events.map(event => event.op), expectedEvents, `${name} boundary events`);
  assert.ok(original.body.events.some(event => event.op === 'CoreUObjectConstructorThunk'),
    `${name} enters Core UObject constructor thunk`);
  assert.ok(original.body.events.some(event => event.op === 'CoreUObjectConstructorBody'),
    `${name} enters Core UObject constructor body`);
  if (name === 'gc') assert.ok(original.body.events.some(event => event.op === 'EnableTranslucentText'));

  const originalBytes = Uint8Array.from(original.body.bytes);
  new DataView(originalBytes.buffer).setUint32(0, preferredVtables[name], true);
  assert.deepEqual(fixture.bytes, originalBytes, `${name} patterned final storage`);
  assert.equal(original.body.result, original.object, `${name} native body returns this`);
  assert.equal(original.internal.result, original.object, `${name} native thunk returns this`);
}

const gcWrites = native.cases.gc.body.writes.map(normalizedWrite);
assert.deepEqual(gcWrites.map(write => write.offset), [
  0, 0x2c, 0x30, 0x34, 0x38, 0x3c, 0x40, 0, 0x28, 0x44, 0x48, 0x4c,
  0x48, 0x50, 0x54, 0x58, 0x5c, 0x60, 0x6c, 0x64, 0x68, 0x70, 0x74,
  0x7c, 0x78, 0x88, 0x90, 0x80, 0x8c, 0x94, 0x95, 0x98, 0x9c, 0xa0,
  0xa4, 0xa8, 0xac, 0xb0, 0xb4,
], 'XGC native write order');
assert.equal(gcWrites[10].value, 0xa5a5a5a2);
assert.equal(gcWrites[12].value, 0xa5a5a582);
assert.equal(gcWrites[14].value, 0x20ffffff);
assert.equal(gcWrites[20].value, 0x2000ff00);
assert.equal(gcWrites[31].value, 0xa5a5a5a7);
assert.equal(gcWrites[34].value, 0xa5a5a5a4);

console.log('Extension window construction contract validated: hash-checked XExtensionObject, XWindow, and XGC ' +
  'thunks/bodies, patterned raw writes and preservation, Core constructor boundary, XWindow vtable +0x54 Init ' +
  'resolution, and HUDInfoLinkDisplay -> HUDBaseWindow -> Window inheritance through Core UClass.Bind.');
