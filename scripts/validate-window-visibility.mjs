/** Validate the recovered Extension XWindow visibility bodies. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  WINDOW_VISIBILITY_BITS,
  WINDOW_VISIBILITY_FIELDS,
  WINDOW_VISIBILITY_GLOBALS,
  WINDOW_VISIBILITY_NATIVE,
  WINDOW_VISIBILITY_NATIVE_ADDRESSES,
  isWindowVisibleNative,
  setChildVisibilityNative,
  setVisibilityNative,
  showWindowNative,
} from '../src/runtime/script-window-visibility.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const extensionPath = path.join(root, 'System', 'Extension.dll');
const extensionBytes = new Uint8Array(await readFile(extensionPath));
assert.equal(createHash('sha256').update(extensionBytes).digest('hex'),
  WINDOW_VISIBILITY_NATIVE.dllSha256);

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
    const span = Math.max(virtualSize, rawSize);
    if (rva >= virtualAddress && rva < virtualAddress + span) {
      return rawAddress + rva - virtualAddress;
    }
  }
  throw new Error(`RVA 0x${rva.toString(16)} is outside Extension.dll sections`);
}

function bodyHash(start, end) {
  const begin = rvaToFileOffset(extensionBytes, start - WINDOW_VISIBILITY_NATIVE.imageBase);
  const finish = rvaToFileOffset(extensionBytes, end - WINDOW_VISIBILITY_NATIVE.imageBase);
  return createHash('sha256').update(extensionBytes.slice(begin, finish)).digest('hex');
}

assert.equal(bodyHash(WINDOW_VISIBILITY_NATIVE.functions.setVisibility.body,
  WINDOW_VISIBILITY_NATIVE.functions.setVisibility.end),
  WINDOW_VISIBILITY_NATIVE.functions.setVisibility.bodySha256);
assert.equal(bodyHash(WINDOW_VISIBILITY_NATIVE.functions.setChildVisibility.body,
  WINDOW_VISIBILITY_NATIVE.functions.setChildVisibility.end),
  WINDOW_VISIBILITY_NATIVE.functions.setChildVisibility.bodySha256);
for (const name of ['show','isVisible']) {
  const fn=WINDOW_VISIBILITY_NATIVE.functions[name];
  assert.equal(bodyHash(fn.execBody,fn.execEnd),fn.execSha256);
  assert.equal(bodyHash(fn.body,fn.end),fn.bodySha256);
}

const python = process.env.NATIVE_PROBE_PYTHON ||
  path.resolve('.cache/native-probe-env/bin/python');
const native = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-window-visibility-oracle.py'), root,
], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024}));

assert.equal(native.hashes['Extension.dll'], WINDOW_VISIBILITY_NATIVE.dllSha256);
assert.equal(native.extensionBase, 0x12000000);
assert.equal(native.addresses.setVisibility, 0x1204c7d0);
assert.equal(native.addresses.setVisibilityEnd, 0x1204c85e);
assert.equal(native.addresses.setChildVisibility, 0x1204ee20);
assert.equal(native.addresses.setChildVisibilityEnd, 0x1204eef6);
assert.equal(native.addresses.currentWindowGlobal, 0x120aeafc);
assert.equal(native.addresses.childRequestedVisibilityChangeSlot, 0x84);
assert.deepEqual(native.bodySha256, {
  setVisibility: WINDOW_VISIBILITY_NATIVE.functions.setVisibility.bodySha256,
  setChildVisibility: WINDOW_VISIBILITY_NATIVE.functions.setChildVisibility.bodySha256,
});

const O = WINDOW_VISIBILITY_FIELDS;
const B = WINDOW_VISIBILITY_BITS;

function fixture({objects, globalValue, explicitGlobal = false, mutateGlobal = false}) {
  const trace = [];
  const events = [];
  const globals = {value: globalValue};
  const read = (object, offset, kind, details) => {
    trace.push({op: 'read', region: 'object', object, offset,
      size: kind === 'u8' ? 1 : 4, phase: details.phase});
    if (!(offset in object)) return kind === 'ptr' ? null : 0;
    const value = object[offset];
    return kind === 'u8' ? value & 0xff : value;
  };
  const write = (object, offset, kind, value, details) => {
    trace.push({op: 'write', region: 'object', object, offset,
      size: kind === 'u8' ? 1 : 4, value, phase: details.phase});
    object[offset] = value;
  };
  const services = {read, write};
  if (explicitGlobal) {
    services.readGlobal = (name, kind, details) => {
      assert.equal(name, WINDOW_VISIBILITY_GLOBALS.currentWindow);
      assert.equal(kind, 'ptr');
      trace.push({op: 'read', region: 'global', size: 4, phase: details.phase});
      return globals.value;
    };
    services.writeGlobal = (name, kind, value, details) => {
      assert.equal(name, WINDOW_VISIBILITY_GLOBALS.currentWindow);
      assert.equal(kind, 'ptr');
      trace.push({op: 'write', region: 'global', size: 4, value, phase: details.phase});
      globals.value = value;
    };
  } else {
    services.globalObject = globals;
    // The raw global adapter receives the fixed image address as its offset.
    const rawRead = services.read;
    const rawWrite = services.write;
    services.read = (object, offset, kind, details) => {
      if (object === globals) {
        trace.push({op: 'read', region: 'global', size: 4, phase: details.phase});
        return globals.value;
      }
      return rawRead(object, offset, kind, details);
    };
    services.write = (object, offset, kind, value, details) => {
      if (object === globals) {
        trace.push({op: 'write', region: 'global', size: 4, value, phase: details.phase});
        globals.value = value;
        return;
      }
      return rawWrite(object, offset, kind, value, details);
    };
  }
  const leaf = name => details => {
    events.push({op: name, ...details});
  };
  Object.assign(services, {
    checkFocusWindow: leaf('CheckFocusWindow'),
    checkGrabbedWindow: leaf('CheckGrabbedWindow'),
    recomputeInitTree: leaf('RecomputeInitTree'),
    invokeVisibilityChange: leaf('InvokeVisibilityChange'),
    reconfigureTree: leaf('ReconfigureTree'),
    makeAcceleratorTableDirty: leaf('MakeAcceleratorTableDirty'),
    childRequestedVisibilityChange: details => {
      events.push({op: 'ChildRequestedVisibilityChange', ...details});
      if (mutateGlobal) globals.value = {name: 'callbackMutation'};
    },
  });
  return {trace, events, globals, services};
}

function normalizeTrace(trace) {
  return trace.map(entry => entry.region === 'global'
    ? {op: entry.op, region: 'global', size: entry.size}
    : {op: entry.op, region: 'object', object: entry.object.name,
      offset: entry.offset, size: entry.size});
}

function nativeTrace(caseValue) {
  // The oracle records the implementation's vtable pointer and +0x84 load;
  // those are represented by the callback service in the JS boundary.  The
  // remaining object/global accesses are the raw storage contract compared.
  return caseValue.accesses.filter(entry => entry.region !== 'vtable' &&
    !(entry.region === 'object' && entry.offset === 0 && entry.size === 4)).map(entry => {
    if (entry.region === 'global') return {op: entry.op, region: 'global', size: entry.size};
    return {op: entry.op, region: 'object', object: entry.object,
      offset: entry.offset, size: entry.size};
  });
}

function eventOps(events) {
  return events.map(event => event.op);
}

function transitionFixture(kind) {
  if (kind === 'rootTransition') {
    const target = {name: 'target', [O.visibility]: 0xa5a5a5a0,
      [O.parent]: null, [O.reconfigureFlags]: 0x55667700};
    return {objects: {target}, target, argument: true, explicitGlobal: false};
  }
  if (kind === 'blockedAncestor') {
    const ancestor = {name: 'ancestor', [O.visibility]: 0x2468ace0,
      [O.parent]: null, [O.reconfigureFlags]: 0};
    const target = {name: 'target', [O.visibility]: 0x13579be1,
      [O.parent]: ancestor, [O.reconfigureFlags]: 0x11223340};
    return {objects: {ancestor, target}, target, argument: false,
      explicitGlobal: false};
  }
  const parent = {name: 'parent', [O.visibility]: 0x2468ace1,
    [O.parent]: null, [O.reconfigureFlags]: 0};
  const target = {name: 'target', [O.visibility]: 0x13579be0,
    [O.parent]: parent, [O.reconfigureFlags]: 0x77889900};
  return {objects: {parent, target}, target, argument: true,
    explicitGlobal: true, mutateGlobal: true};
}

function translatedTransition(kind) {
  const spec = transitionFixture(kind);
  const saved = {name: 'saved'};
  const value = fixture({...spec, globalValue: saved});
  if (kind === 'rootTransition') {
    setVisibilityNative({window: spec.target, newVisibility: spec.argument}, value.services);
  } else if (kind === 'blockedAncestor') {
    setChildVisibilityNative({window: spec.target, newVisibility: spec.argument}, value.services);
  } else {
    setVisibilityNative({window: spec.target, newVisibility: spec.argument}, value.services);
  }
  return {...value, ...spec, saved};
}

for (const kind of ['rootTransition', 'blockedAncestor', 'parentTransition']) {
  const translated = translatedTransition(kind);
  const original = native.cases[kind];
  assert.deepEqual(normalizeTrace(translated.trace), nativeTrace(original), `${kind} raw trace`);
  assert.deepEqual(eventOps(translated.events), original.events.map(event => event.op),
    `${kind} leaf order`);
  assert.equal(translated.globals.value, translated.saved, `${kind} global restore`);
  if (kind !== 'parentTransition') {
    assert.equal(translated.target[O.visibility] & B.visibility,
      translated.argument ? 1 : 0, `${kind} local visibility bit`);
  }
  if (kind === 'rootTransition') {
    assert.equal(translated.target[O.visibility], 0xa5a5a5a1);
    assert.equal(translated.target[O.reconfigureFlags], 0x55667701);
    assert.deepEqual(eventOps(translated.events), [
      'CheckFocusWindow', 'CheckGrabbedWindow', 'RecomputeInitTree',
      'InvokeVisibilityChange', 'ReconfigureTree', 'MakeAcceleratorTableDirty',
    ]);
  }
  if (kind === 'blockedAncestor') {
    assert.equal(translated.target[O.visibility], 0x13579be0);
    assert.equal(translated.target[O.reconfigureFlags], 0x11223340);
    assert.equal(translated.events.length, 0);
  }
  if (kind === 'parentTransition') {
    const callback = translated.events[0];
    assert.equal(callback.parent, translated.target[O.parent]);
    assert.equal(callback.child, translated.target);
    assert.equal(callback.virtualSlot, 0x84);
    assert.equal(callback.rawVisibility, 1);
  }
}

// The SetVisibility guard has its own native early return before it reads the
// parent link or touches any leaf/global.  Keep this one local focused check;
// the three oracle comparisons above cover the normal transitions.
{
  const target = {name: 'noOp', [O.visibility]: 0xdeadbeef,
    [O.parent]: null, [O.reconfigureFlags]: 0xfeed0000};
  const value = fixture({objects: {target}, target, argument: true, globalValue: null});
  setVisibilityNative({window: target, newVisibility: true}, value.services);
  assert.deepEqual(value.trace.map(entry => [entry.op, entry.offset]), [['read', O.visibility]]);
  assert.equal(value.events.length, 0);
}

// Show is the installed optional-bool wrapper around SetVisibility.  Reuse a
// root transition so the same translated SetVisibility body remains the only
// state-changing implementation.
{
  const target={name:'showTarget',[O.visibility]:0,[O.parent]:null,[O.reconfigureFlags]:0};
  const value=fixture({objects:{target},globalValue:null});
  showWindowNative(target,true,value.services);
  assert.equal(target[O.visibility]&B.visibility,1);
  assert.deepEqual(eventOps(value.events),[
    'CheckFocusWindow','CheckGrabbedWindow','RecomputeInitTree',
    'InvokeVisibilityChange','ReconfigureTree','MakeAcceleratorTableDirty',
  ]);
}

// IsVisible(false) reads only the receiver.  IsVisible(true) follows +0x138
// and fails on the first hidden ancestor, exactly as 0x100031c0..0x100031f1.
{
  const rootWindow={name:'visibleRoot',[O.visibility]:0xa1,[O.parent]:null};
  const child={name:'visibleChild',[O.visibility]:0x51,[O.parent]:rootWindow};
  const value=fixture({objects:{rootWindow,child},globalValue:null});
  assert.equal(isWindowVisibleNative(child,false,value.services),true);
  assert.equal(isWindowVisibleNative(child,true,value.services),true);
  rootWindow[O.visibility]=0xa0;
  assert.equal(isWindowVisibleNative(child,false,value.services),true);
  assert.equal(isWindowVisibleNative(child,true,value.services),false);
}

console.log('Window visibility contract validated: hash-checked unchanged ' +
  'Show/IsVisible/SetVisibility/SetChildVisibility bodies, raw flag preservation, effective ' +
  'parent walk, hidden-ancestor suppression, ordered synchronous leaves, fresh ' +
  'parent read, and global100aeafc save/restore.');
