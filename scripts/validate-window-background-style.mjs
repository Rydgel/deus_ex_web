/** Validate Window.SetBackgroundStyle against the unchanged Extension.dll path. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import {
  GC_STYLE_OFFSETS,
  WINDOW_BACKGROUND_STYLE_NATIVE,
  WINDOW_BACKGROUND_STYLE_NATIVE_ADDRESSES,
  WINDOW_BACKGROUND_STYLE_OFFSETS,
  setBackgroundStyleNative,
} from '../src/runtime/script-window-background-style.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const system = path.join(root, 'System');
const assets = new AssetStore((await readdir(system)).map(name => ({
  path: `System/${name}`,
  read: () => readFile(path.join(system, name)),
})));
const extension = await assets.get('Extension');
const functionIndex = extension.exportsByPath.get('window.setbackgroundstyle');
assert.equal(functionIndex, WINDOW_BACKGROUND_STYLE_NATIVE.packageExport);
const metadata = readFunctionMetadata(extension, functionIndex);
assert.equal(metadata.nativeIndex, WINDOW_BACKGROUND_STYLE_NATIVE.nativeIndex);
assert.equal(metadata.functionFlags, WINDOW_BACKGROUND_STYLE_NATIVE.functionFlags);
assert.equal(metadata.entry.serialSize, WINDOW_BACKGROUND_STYLE_NATIVE.serialSize);
assert.equal(metadata.scriptSize, WINDOW_BACKGROUND_STYLE_NATIVE.scriptSize);
assert.deepEqual(metadata.parameters.map(parameter => ({
  name: parameter.name,
  className: parameter.className,
  flags: parameter.flags,
  type: parameter.type,
})), [{name: 'NewStyle', className: 'ByteProperty', flags: 0x80, type: 'byte'}]);

const extensionBytes = new Uint8Array(await readFile(path.join(system, 'Extension.dll')));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(extensionBytes), WINDOW_BACKGROUND_STYLE_NATIVE.dllSha256);

function rvaToFileOffset(bytes, rva) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pe = view.getUint32(0x3c, true);
  const sections = view.getUint16(pe + 6, true);
  const optionalSize = view.getUint16(pe + 20, true);
  const table = pe + 24 + optionalSize;
  for (let index = 0; index < sections; index += 1) {
    const section = table + index * 40;
    const virtualSize = view.getUint32(section + 8, true);
    const virtualAddress = view.getUint32(section + 12, true);
    const rawSize = view.getUint32(section + 16, true);
    const rawAddress = view.getUint32(section + 20, true);
    if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
      return rawAddress + rva - virtualAddress;
    }
  }
  throw new Error(`RVA 0x${rva.toString(16)} is outside Extension.dll sections`);
}

function bodyHash(start, end) {
  const imageBase = WINDOW_BACKGROUND_STYLE_NATIVE.imageBase;
  const begin = rvaToFileOffset(extensionBytes, start - imageBase);
  const finish = rvaToFileOffset(extensionBytes, end - imageBase);
  return sha256(extensionBytes.slice(begin, finish));
}

assert.equal(bodyHash(WINDOW_BACKGROUND_STYLE_NATIVE.execBody,
  WINDOW_BACKGROUND_STYLE_NATIVE.execEnd), WINDOW_BACKGROUND_STYLE_NATIVE.execSha256);
assert.equal(bodyHash(WINDOW_BACKGROUND_STYLE_NATIVE.setBackgroundStyleBody,
  WINDOW_BACKGROUND_STYLE_NATIVE.setBackgroundStyleEnd),
WINDOW_BACKGROUND_STYLE_NATIVE.setBackgroundStyleSha256);
assert.equal(bodyHash(WINDOW_BACKGROUND_STYLE_NATIVE.setStyleBody,
  WINDOW_BACKGROUND_STYLE_NATIVE.setStyleEnd), WINDOW_BACKGROUND_STYLE_NATIVE.setStyleSha256);

const python = process.env.NATIVE_PROBE_PYTHON ||
  path.resolve('.cache/native-probe-env/bin/python');
const native = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-window-background-style-oracle.py'), root,
], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024}));
assert.equal(native.hashes['Extension.dll'], WINDOW_BACKGROUND_STYLE_NATIVE.dllSha256);
assert.equal(native.extensionBase, 0x12000000);
assert.deepEqual(native.addresses, {
  exec: 0x12051d50,
  execEnd: 0x12051d93,
  setBackgroundStyle: 0x1204d670,
  setBackgroundStyleEnd: 0x1204d6c1,
  setStyle: 0x12027170,
  setStyleEnd: 0x1202724b,
  generatePolyFlags: 0x1202af00,
});
assert.deepEqual(native.bodySha256, {
  exec: WINDOW_BACKGROUND_STYLE_NATIVE.execSha256,
  setBackgroundStyle: WINDOW_BACKGROUND_STYLE_NATIVE.setBackgroundStyleSha256,
  setStyle: WINDOW_BACKGROUND_STYLE_NATIVE.setStyleSha256,
});

function makeObject(name) {
  return {name, fields: new Map()};
}

function translatedCase(name, style, initialFlags, withGc) {
  const window = makeObject('window');
  const gc = withGc ? makeObject('gc') : null;
  window.fields.set(WINDOW_BACKGROUND_STYLE_OFFSETS.backgroundStyle, 0x55);
  window.fields.set(WINDOW_BACKGROUND_STYLE_OFFSETS.gc, gc);
  if (gc) {
    gc.fields.set(GC_STYLE_OFFSETS.style, 0x77);
    gc.fields.set(GC_STYLE_OFFSETS.flags, initialFlags);
  }
  const accesses = [];
  const events = [];
  const read = (object, offset, kind, details) => {
    const value = object.fields.has(offset)
      ? object.fields.get(offset)
      : kind === 'ptr' ? null : 0;
    accesses.push({op: 'read', object, offset, kind,
      size: kind === 'u8' ? 1 : 4, value, phase: details.phase});
    return value;
  };
  const write = (object, offset, kind, value, details) => {
    object.fields.set(offset, value);
    accesses.push({op: 'write', object, offset, kind,
      size: kind === 'u8' ? 1 : 4, value, phase: details.phase});
  };
  const services = {
    read,
    write,
    generatePolyFlags: details => events.push({op: 'GeneratePolyFlags', ...details}),
  };
  const result = setBackgroundStyleNative({window, newStyle: style}, services);
  return {name, style, initialFlags, withGc, window, gc, accesses, events, result};
}

function comparableAccesses(accesses) {
  return accesses.map(({object, value, phase, kind, ...entry}) => ({
    op: entry.op,
    object: object.name,
    offset: entry.offset,
    size: entry.size,
    // Native pointer reads contain an emulated address; the translation
    // carries the canonical object, while byte/dword values remain compared.
    ...(entry.op === 'read' && entry.offset === WINDOW_BACKGROUND_STYLE_OFFSETS.gc
      ? {} : {value}),
  }));
}

function comparableNativeAccesses(accesses) {
  return accesses.map(({region, value, ...entry}) => ({
    op: entry.op,
    object: region,
    offset: entry.offset,
    size: entry.size,
    ...(entry.op === 'read' && region === 'window' &&
      entry.offset === WINDOW_BACKGROUND_STYLE_OFFSETS.gc ? {} : {value}),
  }));
}

const cases = {
  nullGc: {style: 3, initialFlags: 0xa5a5a5a5, withGc: false},
  style0: {style: 0, initialFlags: 0xffffffff, withGc: true},
  style1: {style: 1, initialFlags: 0xa5a5a5a5, withGc: true},
  style2: {style: 2, initialFlags: 0x12345678, withGc: true},
  style3: {style: 3, initialFlags: 0x89abcdef, withGc: true},
  style4: {style: 4, initialFlags: 0x13579bdf, withGc: true},
};

for (const [name, spec] of Object.entries(cases)) {
  const translated = translatedCase(name, spec.style, spec.initialFlags, spec.withGc);
  const original = native.cases[name];
  assert.deepEqual(comparableAccesses(translated.accesses),
    comparableNativeAccesses(original.accesses), `${name} raw access order/values`);
  assert.deepEqual(translated.events.map(event => event.op),
    original.events.map(event => event.op), `${name} leaf order`);
  assert.equal(translated.window.fields.get(WINDOW_BACKGROUND_STYLE_OFFSETS.backgroundStyle),
    original.final.windowStyle, `${name} Window+0x3c`);
  if (spec.withGc) {
    assert.equal(translated.gc.fields.get(GC_STYLE_OFFSETS.style),
      original.final.gcStyle, `${name} XGC+0x44`);
    assert.equal(translated.gc.fields.get(GC_STYLE_OFFSETS.flags),
      original.final.gcFlags, `${name} XGC+0x48`);
  }
  if (spec.style !== 0 && spec.withGc) {
    assert.equal(translated.events[0].native,
      WINDOW_BACKGROUND_STYLE_NATIVE_ADDRESSES.generatePolyFlags,
      `${name} GeneratePolyFlags address`);
  }
}

assert.equal(native.cases.nullGc.events.length, 0);
assert.equal(native.cases.style0.events.length, 0);
assert.equal(native.cases.style1.events.length, 1);
assert.equal(native.cases.style2.events.length, 1);
assert.equal(native.cases.style3.events.length, 1);
assert.equal(native.cases.style4.events.length, 1);

console.log('Window.SetBackgroundStyle/XGC::SetStyle matches the unchanged Extension.dll bodies: ' +
  'nullable GC branch, low-byte stores, exact style flag writes, and synchronous GeneratePolyFlags order.');
