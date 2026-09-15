/** Focused original-evidence validator for Window.ConfigureChild. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import {
  WINDOW_CONFIGURE_CHILD_BITS,
  WINDOW_CONFIGURE_CHILD_FIELDS,
  WINDOW_CONFIGURE_CHILD_GLOBALS,
  WINDOW_CONFIGURE_CHILD_NATIVE,
  WINDOW_CONFIGURE_CHILD_NATIVE_ADDRESSES,
  WindowConfigureChildNativeBoundaryError,
  configureChildNative,
} from '../src/runtime/script-window-configure-child.mjs';
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
const functionIndex = extension.exportsByPath.get('window.configurechild');
assert.equal(functionIndex, WINDOW_CONFIGURE_CHILD_NATIVE.packageExport);
const metadata = readFunctionMetadata(extension, functionIndex);
assert.equal(metadata.nativeIndex, WINDOW_CONFIGURE_CHILD_NATIVE.nativeIndex);
assert.equal(metadata.functionFlags, WINDOW_CONFIGURE_CHILD_NATIVE.functionFlags);
assert.equal(metadata.entry.serialSize, WINDOW_CONFIGURE_CHILD_NATIVE.serialSize);
assert.deepEqual(metadata.parameters.map(parameter => parameter.name),
  ['newX', 'newY', 'newWidth', 'NewHeight']);

const extensionDll = new Uint8Array(await readFile(path.join(system, 'Extension.dll')));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(extensionDll), WINDOW_CONFIGURE_CHILD_NATIVE.dllSha256);
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
  const begin = rvaToFileOffset(start - WINDOW_CONFIGURE_CHILD_NATIVE.imageBase);
  const finish = rvaToFileOffset(end - WINDOW_CONFIGURE_CHILD_NATIVE.imageBase);
  return sha256(extensionDll.slice(begin, finish));
}
const A = WINDOW_CONFIGURE_CHILD_NATIVE_ADDRESSES;
assert.equal(bodyHash(WINDOW_CONFIGURE_CHILD_NATIVE.execBody, WINDOW_CONFIGURE_CHILD_NATIVE.execEnd),
  WINDOW_CONFIGURE_CHILD_NATIVE.execSha256, 'exec bytes');
assert.equal(bodyHash(WINDOW_CONFIGURE_CHILD_NATIVE.body, WINDOW_CONFIGURE_CHILD_NATIVE.end),
  WINDOW_CONFIGURE_CHILD_NATIVE.bodySha256, 'method bytes');
assert.equal(bodyHash(A.lock, A.lockEnd), A.lockSha256, 'lock bytes');
assert.equal(bodyHash(A.unlock, A.unlockEnd), A.unlockSha256, 'unlock bytes');
assert.equal(bodyHash(A.type1Ancestor, A.type1AncestorEnd), A.type1AncestorSha256,
  'type1Ancestor bytes');
assert.equal(bodyHash(A.reconfigureChildren, A.reconfigureChildrenEnd),
  A.reconfigureChildrenSha256, 'reconfigureChildren bytes');

const python = process.env.NATIVE_PROBE_PYTHON ||
  path.resolve('.cache/native-probe-env/bin/python');
const native = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-window-configure-child-oracle.py'), root,
], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
assert.equal(native.hashes['Extension.dll'], WINDOW_CONFIGURE_CHILD_NATIVE.dllSha256);
assert.equal(native.extensionBase, 0x12000000);
assert.equal(native.addresses.body, 0x1204ec50);
assert.equal(native.addresses.end, 0x1204eded);
assert.equal(native.addresses.execBody, 0x12052f60);
assert.equal(native.addresses.execEnd, 0x12053025);
assert.equal(native.addresses.lock, 0x1204c140);
assert.equal(native.addresses.unlock, 0x1204c150);
assert.equal(native.addresses.type1Ancestor, 0x1204c560);
assert.equal(native.addresses.reconfigureChildren, 0x12050f90);
assert.equal(native.addresses.resizeChild, 0x1204eab0);
assert.equal(native.addresses.boundsUpdate, 0x12051160);
assert.equal(native.addresses.sortWindowLists, 0x12045140);
assert.equal(native.addresses.safeDestroy, 0x1204c0b0);
assert.equal(native.addresses.configurationChangedSlot, 0x90);
assert.equal(native.addresses.fnameIat, 0x12059180);
assert.equal(native.addresses.logIat, 0x120591a8);
assert.equal(native.addresses.gerrorIat, 0x120590b4);
assert.equal(native.addresses.diagnosticLine, 0x2ff);

const F = WINDOW_CONFIGURE_CHILD_FIELDS;
const G = WINDOW_CONFIGURE_CHILD_GLOBALS;
const VISIBLE = WINDOW_CONFIGURE_CHILD_BITS.visible;
const DESTROY = WINDOW_CONFIGURE_CHILD_BITS.beingDestroyed;
const f32 = value => {
  const buffer = new DataView(new ArrayBuffer(4));
  buffer.setFloat32(0, value);
  return buffer.getUint32(0);
};
const float = bits => {
  const buffer = new DataView(new ArrayBuffer(4));
  buffer.setUint32(0, bits);
  return buffer.getFloat32(0);
};

const baseFields = {
  type: 0, flags: VISIBLE, lock: 0, b8: 0,
  x: f32(1), y: f32(2), width: f32(3), height: f32(4),
};
const defaultArgs = [5, 6, 7, 8];

// Mirrors the oracle fixtures.
const caseSpecs = {
  hidden: {
    args: defaultArgs,
    windows: [['this', {...baseFields, flags: 0}]],
    globals: {},
  },
  changedWidth: {
    args: defaultArgs,
    windows: [
      ['this', {...baseFields, firstChild: 'c1'}],
      ['c1', {flags: VISIBLE, alignX: 1, nextSibling: 'c2'}],
      ['c2', {flags: 0, alignX: 1, nextSibling: 'c3'}],
      ['c3', {flags: VISIBLE, nextSibling: 'c4'}],
      ['c4', {flags: VISIBLE, alignY: 1}],
    ],
    globals: {},
  },
  pendingBit: {
    args: [1, 2, 3, 4],
    windows: [['this', {...baseFields, b8: 1}]],
    globals: {},
  },
  unchanged: {
    args: [1, 2, 3, 4],
    windows: [
      ['this', {...baseFields, firstChild: 'c1'}],
      ['c1', {flags: VISIBLE, alignX: 1}],
    ],
    globals: {},
  },
  nestedType0: {
    args: defaultArgs,
    windows: [['this', {...baseFields, type: 0}]],
    globals: {configureDepth: 1},
  },
  nestedType1: {
    args: defaultArgs,
    windows: [['this', {...baseFields, type: 1}]],
    globals: {configureDepth: 1},
  },
  ancestorSort: {
    args: defaultArgs,
    windows: [
      ['this', {...baseFields, type: 0, parent: 'p'}],
      ['p', {flags: VISIBLE, type: 2, parent: 'gp'}],
      ['gp', {flags: VISIBLE, type: 0}],
    ],
    globals: {},
  },
  noAncestor: {
    args: defaultArgs,
    windows: [
      ['this', {...baseFields, type: 0, parent: 'p'}],
      ['p', {flags: VISIBLE, type: 0}],
    ],
    globals: {configureDepth: 1},
  },
  contextDiag: {
    args: defaultArgs,
    windows: [
      ['this', {...baseFields, parent: 'p'}],
      ['p', {flags: VISIBLE, type: 3}],
      ['other', {flags: VISIBLE, type: 3}],
    ],
    globals: {context: 'other'},
  },
  contextIsParent: {
    args: defaultArgs,
    windows: [
      ['this', {...baseFields, parent: 'p'}],
      ['p', {flags: VISIBLE, type: 3}],
    ],
    globals: {context: 'p'},
  },
  counterDiags: {
    args: defaultArgs,
    windows: [['this', {...baseFields}]],
    globals: {preferredSizeDepth: 2, granularityDepth: 3},
  },
  unlockDestroys: {
    args: defaultArgs,
    windows: [['this', {...baseFields, flags: VISIBLE | DESTROY, lock: 0}]],
    globals: {},
  },
  unlockNestedDestroy: {
    args: defaultArgs,
    windows: [['this', {...baseFields, flags: VISIBLE | DESTROY, lock: 2}]],
    globals: {},
  },
  nanWidth: {
    args: [5, 6, 7, 4],
    windows: [['this', {...baseFields, width: 0x7fc00000, height: f32(4)}]],
    globals: {},
  },
  negZero: {
    args: [1, 2, 0, 4],
    windows: [['this', {...baseFields, width: 0x80000000, height: f32(4)}]],
    globals: {},
  },
};

const LINKS = {parent: F.parent, firstChild: F.firstChild, nextSibling: F.nextSibling};

function world(spec) {
  const objects = {};
  const names = new Map();
  const trace = [];
  const events = [];
  const globals = {
    [G.context]: null,
    [G.reconfigurationDepth]: 0,
    [G.preferredSizeDepth]: 0,
    [G.granularityDepth]: 0,
    [G.configureDepth]: 0,
  };
  for (const [label, fields] of spec.windows) {
    const object = {name: label};
    object[F.type] = fields.type ?? 0;
    object[F.flags] = fields.flags ?? 0;
    object[F.lockCount] = fields.lock ?? 0;
    object[F.x] = fields.x ?? 0;
    object[F.y] = fields.y ?? 0;
    object[F.width] = fields.width ?? 0;
    object[F.height] = fields.height ?? 0;
    object[F.alignX] = fields.alignX ?? 0;
    object[F.alignY] = fields.alignY ?? 0;
    object[F.reconfigureFlags] = fields.b8 ?? 0;
    object[F.parent] = null;
    object[F.firstChild] = null;
    object[F.nextSibling] = null;
    objects[label] = object;
    names.set(object, label);
  }
  for (const [label, fields] of spec.windows) {
    for (const [key, offset] of Object.entries(LINKS)) {
      objects[label][offset] = fields[key] ? objects[fields[key]] : null;
    }
  }
  for (const [key, value] of Object.entries(spec.globals ?? {})) {
    if (key === 'context') globals[G.context] = objects[value];
    else if (key === 'contextRaw') globals[G.context] = value;
    else globals[G[key]] = value;
  }
  const nameOf = value => (names.get(value) ?? (value === null ? null : value));
  const record = (entry) => trace.push(entry);
  const read = (object, offset, kind, details) => {
    let value = object[offset];
    let bits = null;
    let label = null;
    if (kind === 'ptr') {
      label = nameOf(value ?? null);
    } else if (kind === 'f32') {
      bits = value >>> 0;
      value = float(bits);
    } else {
      value = value ?? 0;
      bits = kind === 'u8' ? value & 0xff : value >>> 0;
      value = kind === 'u8' ? value & 0xff
        : kind === 'i32' ? value | 0 : value >>> 0;
    }
    record({op: 'read', object: object.name, offset, kind,
      size: kind === 'u8' ? 1 : 4, bits, label});
    return value;
  };
  const write = (object, offset, kind, value, details) => {
    let bits = null;
    let label = null;
    if (kind === 'ptr') {
      label = nameOf(value);
      object[offset] = value;
    } else if (kind === 'f32') {
      const buffer = new DataView(new ArrayBuffer(4));
      buffer.setFloat32(0, value);
      bits = buffer.getUint32(0);
      object[offset] = bits;
    } else {
      bits = kind === 'u8' ? value & 0xff : value >>> 0;
      object[offset] = kind === 'i32' ? value | 0 : bits;
    }
    record({op: 'write', object: object.name, offset, kind,
      size: kind === 'u8' ? 1 : 4, bits, label});
  };
  const readGlobal = (name, kind, details) => {
    let value = globals[name];
    let bits = null;
    let label = null;
    if (kind === 'ptr') {
      label = nameOf(value ?? null);
    } else {
      value = value ?? 0;
      bits = value >>> 0;
      value = kind === 'i32' ? value | 0 : value >>> 0;
    }
    record({op: 'read', global: name, kind, size: 4, bits, label});
    return value;
  };
  const writeGlobal = (name, kind, value, details) => {
    let bits = null;
    let label = null;
    if (kind === 'ptr') {
      label = nameOf(value);
      globals[name] = value;
    } else {
      globals[name] = kind === 'i32' ? value | 0 : value >>> 0;
      bits = value >>> 0;
    }
    record({op: 'write', global: name, kind, size: 4, bits, label});
  };
  const event = (op, extra) => events.push({op, ...extra});
  const services = {
    read,
    write,
    readGlobal,
    writeGlobal,
    diagnostic: details => event('diagnostic', {
      object: nameOf(details.object), format: details.formatAddress,
      line: details.line, global: details.global, value: nameOf(details.value),
    }),
    configurationChanged: details => event('ConfigurationChanged', {
      object: nameOf(details.object), virtualSlot: details.virtualSlot,
    }),
    resizeChild: details => event('ResizeChild', {object: nameOf(details.object)}),
    boundsUpdate: details => event('BoundsUpdate', {object: nameOf(details.object)}),
    sortWindowLists: details => event('SortWindowLists', {object: nameOf(details.object)}),
    safeDestroy: details => event('SafeDestroy', {object: nameOf(details.object)}),
  };
  return {objects, globals, trace, events, services, nameOf};
}

function originalAccesses(caseValue) {
  return caseValue.accesses
    .filter(entry => entry.offset !== F.vtable)
    .map(entry => entry.kind === 'ptr' ? {...entry, bits: null} : entry);
}

function translatedAccesses(trace) {
  return trace.filter(entry => entry.offset !== F.vtable);
}

const REBASE_DELTA = 0x12000000 - 0x10000000;
function originalEvents(caseValue) {
  return caseValue.events.map(event => event.op === 'diagnostic'
    ? {op: event.op, object: event.object, format: event.format - REBASE_DELTA,
       line: event.line}
    : {op: event.op, object: event.object,
       ...(event.virtualSlot === undefined ? {} : {virtualSlot: event.virtualSlot})});
}

function translatedEvents(events) {
  return events.map(({global, value, ...event}) => event);
}

for (const name of Object.keys(native.cases)) {
  const original = native.cases[name];
  const spec = caseSpecs[name];
  assert.ok(spec, `No translated fixture for oracle case ${name}`);
  const value = world(spec);
  const [x, y, w, h] = spec.args;
  configureChildNative(value.objects[spec.windows[0][0]], x, y, w, h, value.services);
  assert.deepEqual(translatedAccesses(value.trace), originalAccesses(original),
    `${name} raw access trace`);
  assert.deepEqual(translatedEvents(value.events), originalEvents(original),
    `${name} leaf event order`);
  for (const [label] of spec.windows) {
    const expected = original.state[label];
    const actual = value.objects[label];
    assert.equal(actual[F.lockCount] >>> 0, expected.lock, `${name} final ${label} +0x34`);
    assert.equal(actual[F.reconfigureFlags] >>> 0, expected.b8, `${name} final ${label} +0xb8`);
    assert.equal(actual[F.x] >>> 0, expected.x, `${name} final ${label} +0x78`);
    assert.equal(actual[F.y] >>> 0, expected.y, `${name} final ${label} +0x7c`);
    assert.equal(actual[F.width] >>> 0, expected.width, `${name} final ${label} +0x80`);
    assert.equal(actual[F.height] >>> 0, expected.height, `${name} final ${label} +0x84`);
  }
  assert.equal(value.nameOf(value.globals[G.context]), original.globals.context,
    `${name} final context`);
  for (const [key, global] of [
    ['reconfigurationDepth', G.reconfigurationDepth],
    ['preferredSizeDepth', G.preferredSizeDepth],
    ['granularityDepth', G.granularityDepth],
    ['configureDepth', G.configureDepth],
  ]) {
    assert.equal(value.globals[global] | 0, original.globals[key] | 0,
      `${name} final ${key}`);
  }
}

// Local boundary checks the oracle cases do not distinguish.
{
  const spec = caseSpecs.changedWidth;
  const value = world(spec);
  assert.throws(() => configureChildNative(value.objects.this, 'x', 6, 7, 8, value.services),
    error => error instanceof WindowConfigureChildNativeBoundaryError &&
      error.code === 'WINDOW_CONFIGURE_CHILD_VALUE',
    'a nonnumeric argument must stay an explicit boundary');
  const cyclic = world({
    windows: [['this', {...baseFields, parent: 'this'}]],
    globals: {},
  });
  assert.throws(() => configureChildNative(cyclic.objects.this, 5, 6, 7, 8, cyclic.services),
    error => error instanceof WindowConfigureChildNativeBoundaryError &&
      error.code === 'WINDOW_CONFIGURE_CHILD_REFERENCE',
    'a cyclic type-1 ancestor chain must stay an explicit boundary');
  const suspended = world(spec);
  suspended.services.read = () => Promise.resolve(0);
  assert.throws(() => configureChildNative(suspended.objects.this, 5, 6, 7, 8, suspended.services),
    error => error instanceof WindowConfigureChildNativeBoundaryError &&
      error.code === 'WINDOW_CONFIGURE_CHILD_ASYNC',
    'a suspended raw read must stay an explicit boundary');
  const missingLeaf = world(spec);
  delete missingLeaf.services.boundsUpdate;
  assert.throws(() => configureChildNative(missingLeaf.objects.this, 5, 6, 7, 8, missingLeaf.services),
    error => error instanceof WindowConfigureChildNativeBoundaryError &&
      error.code === 'WINDOW_CONFIGURE_CHILD_SERVICE',
    'a missing bounds leaf must stay an explicit boundary');
}

console.log('Window.ConfigureChild matches the hash-checked unchanged body: ' +
  'diagnostics, lock/depth/+0xb8 sequencing, x87-C3 size compares, +0x78..+0x84 ' +
  'stores, the reconfigure-children passes, the depth/type bounds gate with the ' +
  'type-1 ancestor sort, and the unlock/SafeDestroy tail in order.');
