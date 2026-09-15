/** Focused original-evidence validator for ToggleWindow.SetToggle. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import {
  WINDOW_TOGGLE_SET_BITS,
  WINDOW_TOGGLE_SET_FIELDS,
  WINDOW_TOGGLE_SET_NATIVE,
  WINDOW_TOGGLE_SET_NATIVE_ADDRESSES,
  WindowToggleSetNativeBoundaryError,
  setToggleNative,
} from '../src/runtime/script-window-toggle-set.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const system = path.join(root, 'System');
const extensionBytes = new Uint8Array(await readFile(path.join(system, 'Extension.u')));
const assets = new AssetStore((await readdir(system)).map(name => ({
  path: `System/${name}`,
  read: () => name === 'Extension.u'
    ? extensionBytes
    : readFile(path.join(system, name)),
})));
const extension = await assets.get('Extension');
const functionIndex = extension.exportsByPath.get('togglewindow.settoggle');
assert.equal(functionIndex, WINDOW_TOGGLE_SET_NATIVE.packageExport);
const metadata = readFunctionMetadata(extension, functionIndex);
assert.equal(metadata.nativeIndex, WINDOW_TOGGLE_SET_NATIVE.nativeIndex);
assert.equal(metadata.functionFlags, WINDOW_TOGGLE_SET_NATIVE.functionFlags);
assert.equal(metadata.entry.serialSize, WINDOW_TOGGLE_SET_NATIVE.serialSize);
assert.deepEqual(metadata.parameters.map(parameter => parameter.name), ['bNewToggle']);

const extensionDll = new Uint8Array(await readFile(path.join(system, 'Extension.dll')));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(extensionDll), WINDOW_TOGGLE_SET_NATIVE.dllSha256);
const view = new DataView(extensionDll.buffer, extensionDll.byteOffset, extensionDll.byteLength);
const pe = view.getUint32(0x3c, true);
const sectionCount = view.getUint16(pe + 6, true);
const optionalSize = view.getUint16(pe + 20, true);
const sectionTable = pe + 24 + optionalSize;
function rvaToFileOffset(rva) {
  for (let index = 0; index < sectionCount; index += 1) {
    const section = sectionTable + index * 40;
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
  const begin = rvaToFileOffset(start - WINDOW_TOGGLE_SET_NATIVE.imageBase);
  const finish = rvaToFileOffset(end - WINDOW_TOGGLE_SET_NATIVE.imageBase);
  return sha256(extensionDll.slice(begin, finish));
}
assert.equal(bodyHash(WINDOW_TOGGLE_SET_NATIVE.execBody, WINDOW_TOGGLE_SET_NATIVE.execEnd),
  WINDOW_TOGGLE_SET_NATIVE.execSha256, 'exec bytes');
assert.equal(bodyHash(WINDOW_TOGGLE_SET_NATIVE.body, WINDOW_TOGGLE_SET_NATIVE.end),
  WINDOW_TOGGLE_SET_NATIVE.bodySha256, 'method bytes');

const python = process.env.NATIVE_PROBE_PYTHON ||
  path.resolve('.cache/native-probe-env/bin/python');
const native = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-window-toggle-set-oracle.py'), root,
], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
assert.equal(native.hashes['Extension.dll'], WINDOW_TOGGLE_SET_NATIVE.dllSha256);
assert.equal(native.extensionBase, 0x12000000);
assert.equal(native.addresses.body, 0x120499b0);
assert.equal(native.addresses.end, 0x12049a1c);
assert.equal(native.addresses.execBody, 0x12049d10);
assert.equal(native.addresses.execEnd, 0x12049d56);
assert.equal(native.addresses.updateToggleStyle, 0x12008380);
assert.equal(native.addresses.notifyToggleChanged, 0x12049910);
assert.equal(native.addresses.isFocusWindow, 0x1204ca20);
assert.equal(native.addresses.getRootWindow, 0x1204c5a0);
assert.equal(native.addresses.toggleChangedSlot, 0xf0);

const F = WINDOW_TOGGLE_SET_FIELDS;
const SENSITIVE = WINDOW_TOGGLE_SET_BITS.sensitive;

// Mirror of the oracle case fixtures: (label, flags, type, parent, toggle).
const caseSpecs = {
  noChange: {
    word: 1,
    nodes: [
      ['toggle', SENSITIVE, 0, 'mid', 1],
      ['mid', SENSITIVE, 0, 'root', 0],
      ['root', SENSITIVE, 3, null, 0],
    ],
    table: 'full',
  },
  setOnFocused: {
    word: 1,
    nodes: [
      ['toggle', SENSITIVE, 0, 'mid', 0],
      ['mid', SENSITIVE, 0, 'root', 0],
      ['root', SENSITIVE, 3, null, 0],
    ],
    focus: 'toggle',
    table: 'full',
    virtualResults: [],
  },
  setOnUnfocused: {
    word: 1,
    nodes: [
      ['toggle', SENSITIVE, 0, 'mid', 0],
      ['mid', SENSITIVE, 0, 'root', 0],
      ['root', SENSITIVE, 3, null, 0],
    ],
    focus: 'mid',
    table: 'full',
    virtualResults: [],
  },
  setOnInsensitiveAncestor: {
    word: 1,
    nodes: [
      ['toggle', SENSITIVE, 0, 'mid', 0],
      ['mid', 0, 0, 'root', 0],
      ['root', SENSITIVE, 3, null, 0],
    ],
    focus: 'toggle',
    table: 'full',
    virtualResults: [],
  },
  setOffInsensitiveSelf: {
    word: 0,
    nodes: [
      ['toggle', 0, 0, 'root', 1],
      ['root', SENSITIVE, 3, null, 0],
    ],
    table: 'full',
    virtualResults: [],
  },
  fallbackOnNullField: {
    word: 1,
    nodes: [
      ['toggle', SENSITIVE, 0, 'mid', 0],
      ['mid', SENSITIVE, 0, 'root', 0],
      ['root', SENSITIVE, 3, null, 0],
    ],
    focus: 'mid',
    table: 'fallbackOn',
    virtualResults: [],
  },
  fallbackOffNullField: {
    word: 0,
    nodes: [
      ['toggle', SENSITIVE, 0, 'mid', 1],
      ['mid', SENSITIVE, 0, 'root', 0],
      ['root', SENSITIVE, 3, null, 0],
    ],
    focus: 'mid',
    table: 'fallbackOff',
    virtualResults: [],
  },
  notifyStopAtRoot: {
    word: 1,
    nodes: [
      ['toggle', SENSITIVE, 0, 'mid', 0],
      ['mid', SENSITIVE, 0, 'root', 0],
      ['root', SENSITIVE, 3, null, 0],
    ],
    focus: 'toggle',
    table: 'full',
    virtualResults: [0, 0, 1],
  },
  notifyWalkOff: {
    word: 1,
    nodes: [
      ['toggle', SENSITIVE, 0, 'mid', 0],
      ['mid', SENSITIVE, 0, 'root', 0],
      ['root', SENSITIVE, 3, null, 0],
    ],
    focus: 'mid',
    table: 'full',
    virtualResults: [0, 0, 0],
  },
  notifySelfOnly: {
    word: 1,
    nodes: [
      ['toggle', 0, 3, null, 0],
    ],
    table: 'full',
    virtualResults: [1],
  },
};

function tableEntries(kind) {
  const full = Array.from({ length: 6 }, (_, i) => [`e${i}f0`, `e${i}f1`, `e${i}f2`]);
  if (kind === 'full') return full;
  if (kind === 'fallbackOn') {
    full[1][0] = null;
    return full;
  }
  if (kind === 'fallbackOff') {
    full[0][0] = null;
    return full;
  }
  throw new Error(`unknown table ${kind}`);
}

function world(spec) {
  const objects = {};
  const trace = [];
  const events = [];
  const names = new Map();
  for (const [label, flags, type, parentLabel, toggle] of spec.nodes) {
    const object = { name: label };
    object[F.type] = type;
    object[F.flags] = flags >>> 0;
    object[F.parent] = null;
    object[F.toggleFlags] = toggle >>> 0;
    object[F.activeStyle0] = null;
    object[F.activeStyle1] = null;
    object[F.activeStyle2] = null;
    object[F.rootFocusWindow] = null;
    objects[label] = object;
    names.set(object, label);
  }
  for (const [label, , , parentLabel] of spec.nodes) {
    objects[label][F.parent] = parentLabel ? objects[parentLabel] : null;
  }
  // Style resources are opaque pointers represented as plain objects.
  const resource = label => {
    if (!objects[label]) {
      const resourceObject = { name: label };
      objects[label] = resourceObject;
      names.set(resourceObject, label);
    }
    return objects[label];
  };
  if (spec.table) {
    const receiver = objects[spec.nodes[0][0]];
    tableEntries(spec.table).forEach((triple, index) => {
      triple.forEach((resourceName, field) => {
        receiver[F.styleTable + index * F.styleTableEntryStride + field * 4] =
          resourceName === null ? null : resource(resourceName);
      });
    });
  }
  if (spec.focus) {
    const rootLabel = spec.nodes[spec.nodes.length - 1][0];
    objects[rootLabel][F.rootFocusWindow] = objects[spec.focus];
  }
  const nameOf = value => (names.get(value) ?? (value === null ? null : value));
  const record = (op, object, offset, kind, value) => trace.push({
    op, object: object.name, offset, kind,
    size: kind === 'u8' ? 1 : 4,
    bits: kind === 'ptr' ? null : value,
    label: kind === 'ptr' ? nameOf(value) : null,
  });
  const read = (object, offset, kind, details) => {
    let value = object[offset];
    if (value === undefined) value = kind === 'ptr' ? null : 0;
    if (kind === 'u8' && typeof value === 'number') value &= 0xff;
    if (kind === 'u32' && typeof value === 'number') value >>>= 0;
    record('read', object, offset, kind, value);
    return value;
  };
  const write = (object, offset, kind, value, details) => {
    object[offset] = value;
    record('write', object, offset, kind, value);
  };
  const virtualResults = [...(spec.virtualResults ?? [])];
  const services = {
    read,
    write,
    toggleChanged: details => {
      const result = virtualResults.length ? virtualResults.shift() : 0;
      events.push({ op: 'ToggleChanged', object: nameOf(details.object),
        source: nameOf(details.source), toggle: details.toggle,
        virtualSlot: details.virtualSlot, result });
      return result;
    },
  };
  return { objects, trace, events, services, nameOf };
}

function originalAccesses(caseValue) {
  return caseValue.accesses
    .filter(entry => entry.offset !== F.vtable)
    .map(entry => entry.kind === 'ptr' ? { ...entry, bits: null } : entry);
}

function translatedAccesses(trace) {
  return trace.filter(entry => entry.offset !== F.vtable);
}

function originalEvents(caseValue) {
  return caseValue.events.map(event => {
    assert.equal(event.via, event.object,
      'the +0xf0 dispatch must use the receiver object\'s own vtable');
    return { op: event.op, object: event.object, source: event.source,
      toggle: event.toggle, virtualSlot: event.virtualSlot, result: event.result };
  });
}

for (const name of Object.keys(native.cases)) {
  const original = native.cases[name];
  const spec = caseSpecs[name];
  assert.ok(spec, `No translated fixture for oracle case ${name}`);
  const value = world(spec);
  setToggleNative(value.objects[spec.nodes[0][0]], spec.word, value.services);
  assert.deepEqual(translatedAccesses(value.trace), originalAccesses(original),
    `${name} raw access trace`);
  assert.deepEqual(value.events, originalEvents(original), `${name} callback order`);
  for (const [node] of spec.nodes) {
    const expected = original.state[node];
    const actual = value.objects[node];
    assert.equal(actual[F.toggleFlags] >>> 0, expected.toggleFlags,
      `${name} final ${node} +0x174`);
    assert.equal(value.nameOf(actual[F.activeStyle0]), expected.style0,
      `${name} final ${node} +0x184`);
    assert.equal(value.nameOf(actual[F.activeStyle1]), expected.style1,
      `${name} final ${node} +0x188`);
    assert.equal(value.nameOf(actual[F.activeStyle2]), expected.style2,
      `${name} final ${node} +0x18c`);
  }
}

// Local boundary checks the oracle cases do not distinguish.
{
  const spec = caseSpecs.setOnFocused;
  const value = world(spec);
  assert.throws(() => setToggleNative(value.objects.toggle, 3, value.services),
    error => error instanceof WindowToggleSetNativeBoundaryError &&
      error.code === 'WINDOW_TOGGLE_SET_VALUE',
    'an out-of-domain toggle word must stay an explicit boundary');
  const cyclic = world({
    nodes: [['toggle', SENSITIVE, 0, 'toggle', 0]],
    word: 1, table: 'full', virtualResults: [0],
  });
  assert.throws(() => setToggleNative(cyclic.objects.toggle, 1, cyclic.services),
    error => error instanceof WindowToggleSetNativeBoundaryError &&
      error.code === 'WINDOW_TOGGLE_SET_REFERENCE',
    'a cyclic sensitivity chain must stay an explicit boundary');
  const suspended = world(spec);
  suspended.services.read = () => Promise.resolve(0);
  assert.throws(() => setToggleNative(suspended.objects.toggle, 1, suspended.services),
    error => error instanceof WindowToggleSetNativeBoundaryError &&
      error.code === 'WINDOW_TOGGLE_SET_ASYNC',
    'a suspended raw read must stay an explicit boundary');
}

console.log('Window.SetToggle matches the hash-checked unchanged body: toggle bit ' +
  'compare/store, the +0x1a4 style-table refresh with sensitivity/focus selection and ' +
  'field-0 fallback, and the +0xf0 ancestor notify walk in order.');
