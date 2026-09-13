/** Focused original-evidence validator for XWindow::AskParentForReconfigure. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import {
  WINDOW_RECONFIGURE_BITS,
  WINDOW_RECONFIGURE_FIELDS,
  WINDOW_RECONFIGURE_GLOBALS,
  WINDOW_RECONFIGURE_NATIVE,
  WINDOW_RECONFIGURE_NATIVE_ADDRESSES,
  WindowReconfigureNativeBoundaryError,
  askParentForReconfigureNative,
} from '../src/runtime/script-window-reconfigure.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const system = path.join(root, 'System');
const extensionPath = path.join(system, 'Extension.u');
const extensionBytes = new Uint8Array(await readFile(extensionPath));
const assets = new AssetStore((await readdir(system)).map(name => ({
  path: `System/${name}`,
  read: () => name === 'Extension.u'
    ? extensionBytes
    : readFile(path.join(system, name)),
})));
const extension = await assets.get('Extension');
const functionIndex = extension.exportsByPath.get('window.askparentforreconfigure');
assert.equal(functionIndex, WINDOW_RECONFIGURE_NATIVE.packageExport);
const metadata = readFunctionMetadata(extension, functionIndex);
assert.equal(metadata.nativeIndex, WINDOW_RECONFIGURE_NATIVE.nativeIndex);
assert.equal(metadata.functionFlags, WINDOW_RECONFIGURE_NATIVE.functionFlags);
assert.equal(metadata.entry.serialSize, WINDOW_RECONFIGURE_NATIVE.serialSize);
assert.deepEqual(metadata.parameters, []);

const extensionDll = new Uint8Array(await readFile(path.join(system, 'Extension.dll')));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(extensionDll), WINDOW_RECONFIGURE_NATIVE.dllSha256);
assert.equal(sha256(extensionDll.subarray(0x4e060, 0x4e1f3)),
  WINDOW_RECONFIGURE_NATIVE.bodySha256);

const python = process.env.NATIVE_PROBE_PYTHON ||
  path.resolve('.cache/native-probe-env/bin/python');
const native = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-window-reconfigure-oracle.py'), root,
], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
assert.equal(native.hashes['Extension.dll'], WINDOW_RECONFIGURE_NATIVE.dllSha256);
assert.equal(native.extensionBase, 0x12000000);
assert.equal(native.addresses.body, 0x1204e060);
assert.equal(native.addresses.resizeChild, 0x1204eab0);
assert.equal(native.addresses.parentRequestedReconfigurationSlot, 0x88);
assert.equal(native.addresses.configurationChangedSlot, 0x90);
assert.equal(native.addresses.reconfigurationDepth, 0x120aeb00);
assert.equal(native.addresses.preferredSizeDepth, 0x120aeb04);
assert.equal(native.addresses.granularityDepth, 0x120aeb08);
assert.equal(native.addresses.context, 0x120aeafc);

function makeObject(name) {
  const bytes = new Uint8Array(0x200);
  bytes.fill(0xaa);
  return { name, bytes, fields: new Map() };
}

function writeBytes(object, offset, kind, value) {
  if (kind === 'ptr') return;
  const view = new DataView(object.bytes.buffer);
  if (kind === 'u8') view.setUint8(offset, value);
  else if (kind === 'u32') view.setUint32(offset, value >>> 0, true);
  else throw new Error(`unsupported fixture write kind ${kind}`);
}

function readBytes(object, offset, kind) {
  const view = new DataView(object.bytes.buffer);
  if (kind === 'u8') return view.getUint8(offset);
  if (kind === 'u32') return view.getUint32(offset, true);
  throw new Error(`unsupported fixture read kind ${kind}`);
}

function label(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'object' && value.name ? value.name : value;
}

function fixture(name) {
  const parent = name === 'parentcallback' ? makeObject('parent') : null;
  const window = makeObject('window');
  const objects = parent ? [parent, window] : [window];
  const events = [];
  const accesses = [];
  const globals = new Map([
    [WINDOW_RECONFIGURE_GLOBALS.reconfigurationDepth, 0],
    [WINDOW_RECONFIGURE_GLOBALS.preferredSizeDepth, 0],
    [WINDOW_RECONFIGURE_GLOBALS.granularityDepth, 0],
    [WINDOW_RECONFIGURE_GLOBALS.context, makeObject('contextSeed')],
  ]);

  const visible = name === 'normalhidden' ? 0 : WINDOW_RECONFIGURE_BITS.visibilityChain;
  const set = (object, offset, kind, value) => {
    object.fields.set(offset, value);
    writeBytes(object, offset, kind, typeof value === 'object' ? 0 : value);
  };
  set(window, WINDOW_RECONFIGURE_FIELDS.visibility, 'u8', visible);
  set(window, WINDOW_RECONFIGURE_FIELDS.reconfigureFlags, 'u32', 0x55667704);
  set(window, WINDOW_RECONFIGURE_FIELDS.parent, 'ptr', parent);
  if (parent) {
    set(parent, WINDOW_RECONFIGURE_FIELDS.visibility, 'u8', WINDOW_RECONFIGURE_BITS.visibilityChain);
    set(parent, WINDOW_RECONFIGURE_FIELDS.reconfigureFlags, 'u32', 0x55667704);
    set(parent, WINDOW_RECONFIGURE_FIELDS.parent, 'ptr', null);
  }

  const read = (object, offset, kind, details) => {
    const stored = object.fields.has(offset) ? object.fields.get(offset) : readBytes(object, offset, kind);
    const value = kind === 'u8' && typeof stored === 'number' ? stored & 0xff : stored;
    accesses.push({ op: 'read', object: object.name, offset, kind,
      size: kind === 'u8' ? 1 : 4, value: label(value), phase: details.phase });
    return value;
  };
  const write = (object, offset, kind, value, details) => {
    object.fields.set(offset, value);
    writeBytes(object, offset, kind, typeof value === 'object' ? 0 : value);
    accesses.push({ op: 'write', object: object.name, offset, kind,
      size: kind === 'u8' ? 1 : 4, value: label(value), phase: details.phase });
  };
  const readGlobal = (global, kind, details) => {
    const value = globals.get(global);
    accesses.push({ op: 'read', global, kind, size: 4, value: label(value), phase: details.phase });
    return value;
  };
  const writeGlobal = (global, kind, value, details) => {
    globals.set(global, value);
    accesses.push({ op: 'write', global, kind, size: 4, value: label(value), phase: details.phase });
  };
  const services = {
    read,
    write,
    readGlobal,
    writeGlobal,
    parentRequestedReconfiguration: ({ parent: callbackParent, child }) => {
      events.push({ op: 'ChildRequestedReconfiguration',
        parent: label(callbackParent), child: label(child), virtualSlot: 0x88, result: 0 });
      return 0;
    },
    configurationChanged: ({ object }) => {
      events.push({ op: 'ConfigurationChanged', object: label(object), virtualSlot: 0x90 });
    },
    resizeChild: ({ object }) => {
      events.push({ op: 'ResizeChild', object: label(object) });
    },
  };
  return { name, parent, window, objects, events, accesses, globals, services };
}

function translatedCase(name) {
  const value = fixture(name);
  askParentForReconfigureNative(value.window, value.services);
  return value;
}

function comparableAccesses(accesses) {
  return accesses.map(({ phase, ...access }) => access);
}

for (const name of ['normalhidden', 'rootvisible', 'parentcallback']) {
  const original = native.cases[name];
  const translated = translatedCase(name);
  assert.deepEqual(translated.events, original.events, `${name} callback order`);
  assert.deepEqual(comparableAccesses(translated.accesses),
    comparableAccesses(original.accesses), `${name} fresh reads and exact writes`);
  assert.deepEqual(comparableAccesses(translated.accesses.filter(access => access.op === 'read')),
    original.reads,
    `${name} fresh read order`);
  assert.deepEqual(comparableAccesses(translated.accesses.filter(access => access.op === 'write')),
    original.writes,
    `${name} exact write order`);
  for (const object of translated.objects) {
    const expected = original.state.flags[object.name];
    assert.equal(object.fields.get(WINDOW_RECONFIGURE_FIELDS.reconfigureFlags), expected,
      `${name} final ${object.name} +0xb8`);
  }
  assert.equal(translated.globals.get(WINDOW_RECONFIGURE_GLOBALS.reconfigurationDepth), 0,
    `${name} reconfiguration depth restored`);
  assert.equal(label(translated.globals.get(WINDOW_RECONFIGURE_GLOBALS.context)), 'contextSeed',
    `${name} context restored`);
}

const diagnostics = fixture('normalhidden');
diagnostics.globals.set(WINDOW_RECONFIGURE_GLOBALS.reconfigurationDepth, 1);
assert.throws(() => askParentForReconfigureNative(diagnostics.window, diagnostics.services),
  error => error instanceof WindowReconfigureNativeBoundaryError &&
    error.code === 'WINDOW_RECONFIGURE_DIAGNOSTIC' &&
    error.global === WINDOW_RECONFIGURE_GLOBALS.reconfigurationDepth,
  'positive global100aeb00 must remain an explicit diagnostic boundary');

assert.equal(WINDOW_RECONFIGURE_NATIVE_ADDRESSES.body, WINDOW_RECONFIGURE_NATIVE.body);
console.log('Window reconfiguration matches the hash-checked unchanged body: hidden early return, root ' +
  'ConfigurationChanged/counter-context sequence, parent callback result and recursive parent path, ' +
  'ResizeChild leaf, fresh parent reads, exact writes, and explicit positive-counter diagnostics.');
