/** Validate the recovered Extension XWindow sensitivity and tree bodies. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  WINDOW_SENSITIVITY_FIELDS,
  WINDOW_SENSITIVITY_NATIVE,
  WINDOW_SENSITIVITY_NATIVE_ADDRESSES,
  disableWindowNative,
  enableWindowNative,
  getBottomChildNative,
  getClientObjectNative,
  getHigherSiblingNative,
  getLowerSiblingNative,
  getTopChildNative,
  isWindowSensitiveNative,
  setSensitivityNative,
  windowSensitivityOptionalDefault,
} from '../src/runtime/script-window-sensitivity.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const extensionPath = path.join(root, 'System', 'Extension.dll');
const extensionBytes = new Uint8Array(await readFile(extensionPath));
assert.equal(createHash('sha256').update(extensionBytes).digest('hex'),
  WINDOW_SENSITIVITY_NATIVE.dllSha256);

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
  const begin = rvaToFileOffset(extensionBytes, start - WINDOW_SENSITIVITY_NATIVE.imageBase);
  const finish = rvaToFileOffset(extensionBytes, end - WINDOW_SENSITIVITY_NATIVE.imageBase);
  return createHash('sha256').update(extensionBytes.slice(begin, finish)).digest('hex');
}

for (const [name, fn] of Object.entries(WINDOW_SENSITIVITY_NATIVE.functions)) {
  assert.equal(bodyHash(fn.execBody, fn.execEnd), fn.execSha256, `${name} exec bytes`);
  if (fn.body !== undefined) {
    assert.equal(bodyHash(fn.body, fn.end), fn.bodySha256, `${name} body bytes`);
  }
}

const python = process.env.NATIVE_PROBE_PYTHON ||
  path.resolve('.cache/native-probe-env/bin/python');
const native = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-window-sensitivity-oracle.py'), root,
], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024}));

assert.equal(native.hashes['Extension.dll'], WINDOW_SENSITIVITY_NATIVE.dllSha256);
assert.equal(native.extensionBase, 0x12000000);
assert.equal(native.gnatives, 0x101f41b8);
assert.equal(native.addresses.setSensitivity, 0x1204c890);
assert.equal(native.addresses.setSensitivityEnd, 0x1204c947);
assert.equal(native.addresses.getLowerSibling, 0x1204c650);
assert.equal(native.addresses.getHigherSibling, 0x1204c680);
assert.equal(native.addresses.getTopChild, 0x1204c6b0);
assert.equal(native.addresses.getBottomChild, 0x1204c740);
assert.equal(native.addresses.checkFocusWindow, 0x12050b80);
assert.equal(native.addresses.checkGrabbedWindow, 0x12050c90);
assert.equal(native.addresses.makeAcceleratorTableDirty, 0x1204c1d0);
assert.equal(native.addresses.notifySensitivityChanged, 0x12050ef0);
assert.equal(native.addresses.sensitivityChangedSlot, 0x98);

for (const [name, hash] of Object.entries(native.bodySha256)) {
  assert.equal(hash, WINDOW_SENSITIVITY_NATIVE.functions[name].bodySha256,
    `${name} oracle body hash`);
}
for (const [name, hash] of Object.entries(native.execSha256)) {
  assert.equal(hash, WINDOW_SENSITIVITY_NATIVE.functions[name].execSha256,
    `${name} oracle exec hash`);
}

const P = WINDOW_SENSITIVITY_FIELDS;
const hidden = 0xa5a5a5a0;
const visible = 0xa5a5a5a1;
const sensitive = 0xa5a5a5a2;
const insensitive = 0x2468ace0;
const sensitiveParent = 0x2468ace2;

function world(spec) {
  const trace = [];
  const events = [];
  const objects = {};
  for (const item of spec.objects) {
    const object = {name: item.name};
    object[P.flags] = item.flags >>> 0;
    object[P.clientObject] = item.client ?? 0;
    object[P.parent] = null;
    object[P.bottomChild] = null;
    object[P.topChild] = null;
    object[P.lowerSibling] = null;
    object[P.higherSibling] = null;
    objects[item.name] = object;
  }
  for (const [target, offset, source] of spec.links ?? []) {
    objects[target][offset] = objects[source];
  }
  const read = (object, offset, kind, details) => {
    let value = object[offset];
    if (value === undefined) value = kind === 'ptr' ? null : 0;
    if (kind === 'u8') value &= 0xff;
    else if (kind === 'u32') value >>>= 0;
    trace.push({op: 'read', region: 'object', object, offset, size: kind === 'u8' ? 1 : 4,
      kind, value, phase: details.phase});
    return value;
  };
  const write = (object, offset, kind, value, details) => {
    trace.push({op: 'write', region: 'object', object, offset, size: kind === 'u8' ? 1 : 4,
      kind, value, phase: details.phase});
    object[offset] = value;
  };
  const leaf = name => details => {
    events.push({op: name, object: details.object,
      rawArgument: name === 'NotifySensitivityChanged' ? (details.rawSensitivity ?? null) : null});
  };
  const services = {
    read,
    write,
    checkFocusWindow: leaf('CheckFocusWindow'),
    checkGrabbedWindow: leaf('CheckGrabbedWindow'),
    makeAcceleratorTableDirty: leaf('MakeAcceleratorTableDirty'),
    notifySensitivityChanged: leaf('NotifySensitivityChanged'),
  };
  return {objects, trace, events, services};
}

function originalTrace(caseValue) {
  const addressToName = new Map(Object.entries(caseValue.state)
    .map(([name, state]) => [state.pointer, name]));
  return caseValue.accesses
    .filter(entry => entry.region === 'object' && entry.offset !== P.vtable)
    .map(entry => {
      let value = entry.value;
      if (entry.offset !== P.flags) {
        value = value === 0 ? null : (addressToName.get(value) ?? value);
      }
      return {op: entry.op, object: entry.object, offset: entry.offset, size: entry.size, value};
    });
}

function translatedTrace(trace) {
  return trace
    .filter(entry => entry.region === 'object' && entry.offset !== P.vtable)
    .map(entry => {
      let value = entry.value;
      if (value && typeof value === 'object') value = value.name;
      if (entry.kind === 'ptr' && value === 0) value = null;
      return {op: entry.op, object: entry.object.name, offset: entry.offset,
        size: entry.size, value};
    });
}

function originalState(caseValue) {
  return Object.fromEntries(Object.entries(caseValue.state).map(([name, state]) =>
    [name, {flags: state.flags, parent: state.parent}]));
}

function translatedState(objects) {
  return Object.fromEntries(Object.values(objects).map(object =>
    [object.name, {
      flags: object[P.flags] >>> 0,
      parent: object[P.parent] && typeof object[P.parent] === 'object'
        ? object[P.parent].name : null,
    }]));
}

function originalEvents(caseValue) {
  return caseValue.events.map(event =>
    ({op: event.op, object: event.object, rawArgument: event.rawArgument ?? null}));
}

function translatedEvents(events) {
  return events.map(event =>
    ({op: event.op, object: event.object.name, rawArgument: event.rawArgument ?? null}));
}

function translatedResult(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return value.name;
  return value;
}

const lowerChainObjects = [
  {name: 'receiver', flags: visible},
  {name: 'lower1', flags: hidden},
  {name: 'lower2', flags: hidden},
  {name: 'visible', flags: visible},
];
const lowerChainLinks = [
  ['receiver', P.lowerSibling, 'lower1'],
  ['lower1', P.lowerSibling, 'lower2'],
  ['lower2', P.lowerSibling, 'visible'],
];
const higherChainObjects = [
  {name: 'receiver', flags: visible},
  {name: 'higher1', flags: hidden},
  {name: 'higher2', flags: hidden},
  {name: 'visible', flags: visible},
];
const higherChainLinks = [
  ['receiver', P.higherSibling, 'higher1'],
  ['higher1', P.higherSibling, 'higher2'],
  ['higher2', P.higherSibling, 'visible'],
];
const topChainObjects = [
  {name: 'parent', flags: visible},
  {name: 'top1', flags: hidden},
  {name: 'lower1', flags: hidden},
  {name: 'visible', flags: visible},
];
const topChainLinks = [
  ['parent', P.topChild, 'top1'],
  ['top1', P.lowerSibling, 'lower1'],
  ['lower1', P.lowerSibling, 'visible'],
];
const bottomChainObjects = [
  {name: 'parent', flags: visible},
  {name: 'bottom1', flags: hidden},
  {name: 'higher1', flags: hidden},
  {name: 'visible', flags: visible},
];
const bottomChainLinks = [
  ['parent', P.bottomChild, 'bottom1'],
  ['bottom1', P.higherSibling, 'higher1'],
  ['higher1', P.higherSibling, 'visible'],
];
const childParentObjects = [
  {name: 'parent', flags: visible},
  {name: 'top1', flags: hidden},
];
const childParentLinks = [['parent', P.topChild, 'top1']];
const bottomParentObjects = [
  {name: 'parent', flags: visible},
  {name: 'bottom1', flags: hidden},
];
const bottomParentLinks = [['parent', P.bottomChild, 'bottom1']];

const specs = {
  setSensitivityNoArgument: {
    objects: [{name: 'target', flags: sensitive}],
    invoke: (objects, services) =>
      setSensitivityNative({object: objects.target, sensitivity: false}, services),
  },
  enableWindowNoArgument: {
    objects: [{name: 'target', flags: hidden}],
    invoke: (objects, services) => enableWindowNative(objects.target, services),
  },
  disableWindowNoArgument: {
    objects: [{name: 'target', flags: sensitive}],
    invoke: (objects, services) => disableWindowNative(objects.target, services),
  },
  setSensitivityNoOp: {
    objects: [{name: 'target', flags: hidden}],
    invoke: (objects, services) =>
      setSensitivityNative({object: objects.target, sensitivity: false}, services),
  },
  setSensitivityExplicitTrue: {
    objects: [{name: 'target', flags: hidden}],
    invoke: (objects, services) =>
      setSensitivityNative({object: objects.target, sensitivity: true}, services),
  },
  setSensitivityBlockedByInsensitiveParent: {
    objects: [{name: 'parent', flags: insensitive}, {name: 'target', flags: sensitive}],
    links: [['target', P.parent, 'parent']],
    invoke: (objects, services) =>
      setSensitivityNative({object: objects.target, sensitivity: false}, services),
  },
  setSensitivityEffectiveViaSensitiveParent: {
    objects: [{name: 'parent', flags: sensitiveParent}, {name: 'target', flags: hidden}],
    links: [['target', P.parent, 'parent']],
    invoke: (objects, services) =>
      setSensitivityNative({object: objects.target, sensitivity: true}, services),
  },
  lowerSiblingFilteredHiddenChain: {
    objects: lowerChainObjects, links: lowerChainLinks,
    invoke: (objects, services) => getLowerSiblingNative(objects.receiver, true, services),
  },
  lowerSiblingRawUnfiltered: {
    objects: lowerChainObjects, links: lowerChainLinks,
    invoke: (objects, services) => getLowerSiblingNative(objects.receiver, false, services),
  },
  lowerSiblingFirstVisible: {
    objects: [{name: 'receiver', flags: hidden}, {name: 'visible', flags: visible}],
    links: [['receiver', P.lowerSibling, 'visible']],
    invoke: (objects, services) => getLowerSiblingNative(objects.receiver, true, services),
  },
  lowerSiblingHiddenToNull: {
    objects: [{name: 'receiver', flags: hidden}, {name: 'hidden', flags: hidden}],
    links: [['receiver', P.lowerSibling, 'hidden']],
    invoke: (objects, services) => getLowerSiblingNative(objects.receiver, true, services),
  },
  higherSiblingFilteredHiddenChain: {
    objects: higherChainObjects, links: higherChainLinks,
    invoke: (objects, services) => getHigherSiblingNative(objects.receiver, true, services),
  },
  higherSiblingRawUnfiltered: {
    objects: higherChainObjects, links: higherChainLinks,
    invoke: (objects, services) => getHigherSiblingNative(objects.receiver, false, services),
  },
  higherSiblingHiddenToNull: {
    objects: [{name: 'receiver', flags: hidden}, {name: 'hidden', flags: hidden}],
    links: [['receiver', P.higherSibling, 'hidden']],
    invoke: (objects, services) => getHigherSiblingNative(objects.receiver, true, services),
  },
  topChildVisibleFirst: {
    objects: [{name: 'parent', flags: visible}, {name: 'top1', flags: visible}],
    links: [['parent', P.topChild, 'top1']],
    invoke: (objects, services) => getTopChildNative(objects.parent, true, services),
  },
  topChildHiddenDelegatesLower: {
    objects: topChainObjects, links: topChainLinks,
    invoke: (objects, services) => getTopChildNative(objects.parent, true, services),
  },
  topChildRawUnfiltered: {
    objects: topChainObjects, links: topChainLinks,
    invoke: (objects, services) => getTopChildNative(objects.parent, false, services),
  },
  topChildHiddenNoLower: {
    objects: childParentObjects, links: childParentLinks,
    invoke: (objects, services) => getTopChildNative(objects.parent, true, services),
  },
  topChildNull: {
    objects: [{name: 'parent', flags: visible}],
    invoke: (objects, services) => getTopChildNative(objects.parent, true, services),
  },
  bottomChildVisibleFirst: {
    objects: [{name: 'parent', flags: visible}, {name: 'bottom1', flags: visible}],
    links: [['parent', P.bottomChild, 'bottom1']],
    invoke: (objects, services) => getBottomChildNative(objects.parent, true, services),
  },
  bottomChildHiddenDelegatesHigher: {
    objects: bottomChainObjects, links: bottomChainLinks,
    invoke: (objects, services) => getBottomChildNative(objects.parent, true, services),
  },
  bottomChildRawUnfiltered: {
    objects: bottomChainObjects, links: bottomChainLinks,
    invoke: (objects, services) => getBottomChildNative(objects.parent, false, services),
  },
  bottomChildNull: {
    objects: [{name: 'parent', flags: visible}],
    invoke: (objects, services) => getBottomChildNative(objects.parent, true, services),
  },
  isSensitiveNoArgumentRecursiveRootSensitive: {
    objects: [{name: 'target', flags: sensitive}],
    invoke: (objects, services) => isWindowSensitiveNative(objects.target, true, services),
  },
  isSensitiveNoArgumentSelfInsensitive: {
    objects: [{name: 'target', flags: hidden}],
    invoke: (objects, services) => isWindowSensitiveNative(objects.target, true, services),
  },
  isSensitiveExplicitFalseLocal: {
    objects: [{name: 'parent', flags: insensitive}, {name: 'target', flags: sensitive}],
    links: [['target', P.parent, 'parent']],
    invoke: (objects, services) => isWindowSensitiveNative(objects.target, false, services),
  },
  isSensitiveRecursiveAncestorInsensitive: {
    objects: [{name: 'parent', flags: insensitive}, {name: 'target', flags: sensitive}],
    links: [['target', P.parent, 'parent']],
    invoke: (objects, services) => isWindowSensitiveNative(objects.target, true, services),
  },
  isSensitiveRecursiveAllSensitive: {
    objects: [{name: 'parent', flags: sensitiveParent}, {name: 'target', flags: sensitive}],
    links: [['target', P.parent, 'parent']],
    invoke: (objects, services) => isWindowSensitiveNative(objects.target, true, services),
  },
  getClientObject: {
    objects: [{name: 'target', flags: visible, client: 0x13579bdf}],
    invoke: (objects, services) => getClientObjectNative(objects.target, services),
  },
};

const caseNames = Object.keys(native.cases);
assert.equal(caseNames.length, 29, 'oracle case count');
for (const name of caseNames) {
  const original = native.cases[name];
  const spec = specs[name];
  assert.ok(spec, `No translated fixture for oracle case ${name}`);
  const value = world(spec);
  const result = spec.invoke(value.objects, value.services);
  assert.deepEqual(translatedTrace(value.trace), originalTrace(original),
    `${name} raw access trace`);
  assert.deepEqual(translatedEvents(value.events), originalEvents(original),
    `${name} leaf order`);
  assert.deepEqual(translatedState(value.objects), originalState(original),
    `${name} final state`);
  assert.equal(translatedResult(result), original.result, `${name} result`);
  // The argument-token bookkeeping is harness evidence, not part of the JS
  // boundary: DisableWindow and GetClientObject skip one token, every inline
  // optional-parse body skips the token plus the EndFunctionParms marker.
  const expectedAdvance = (name === 'disableWindowNoArgument' || name === 'getClientObject')
    ? 1 : 2;
  assert.equal(original.codeAdvance, expectedAdvance, `${name} token advance`);
}

// The optional-argument default is a pre-stored immediate in each exec body,
// and nothing above distinguishes it: SetSensitivity pre-stores 0 while the
// otherwise byte-identical EnableWindow pre-stores 1, so a dispatcher that
// defaulted both the same way would still pass every oracle case.  Decode the
// `mov dword ptr [esp+4], imm32` (C7 44 24 04 imm32) out of the shipped exec
// body and require the dispatch table to agree.
{
  const defaults = {1416: false, 1417: true, 1419: true,
    1455: true, 1456: true, 1457: true, 1458: true};
  for (const [index, expected] of Object.entries(defaults)) {
    const entry = Object.values(WINDOW_SENSITIVITY_NATIVE.functions)
      .find(f => f.nativeIndex === Number(index));
    assert.ok(entry, `native ${index} missing from the contract`);
    const start = rvaToFileOffset(extensionBytes, entry.execBody - WINDOW_SENSITIVITY_NATIVE.imageBase);
    const end = rvaToFileOffset(extensionBytes, entry.execEnd - WINDOW_SENSITIVITY_NATIVE.imageBase);
    const body = extensionBytes.slice(start, end);
    let found = null;
    for (let i = 0; i + 8 <= body.length; i++)
      if (body[i] === 0xc7 && body[i + 1] === 0x44 && body[i + 2] === 0x24 && body[i + 3] === 0x04) {
        found = body[i + 4] | (body[i + 5] << 8) | (body[i + 6] << 16) | (body[i + 7] << 24);
        break;
      }
    assert.notEqual(found, null,
      `native ${index}: no pre-stored optional default in ${entry.execBody.toString(16)}`);
    assert.equal(found, expected ? 1 : 0,
      `native ${index}: shipped default immediate ${found} != contract ${expected}`);
    assert.equal(windowSensitivityOptionalDefault(Number(index)), expected,
      `native ${index}: dispatch default disagrees with the shipped immediate`);
  }
  // DisableWindow pushes its 0 directly and declares no optional argument.
  assert.throws(() => windowSensitivityOptionalDefault(1418), /takes no optional argument/);
}

// Local boundary checks that the oracle cases above do not distinguish.
{
  // The raw argument is compared before masking: an out-of-domain integer is
  // rejected by the script boundary instead of being masked silently.
  const value = world({objects: [{name: 'target', flags: hidden}],
    links: [], invoke: () => {}});
  assert.throws(() => setSensitivityNative(
    {object: value.objects.target, sensitivity: 3}, value.services),
  /boolean or native 0\/1 sensitivity/);
  // IsSensitive's local branch reads the dword, not the byte, exactly as the
  // inline 0x51c38..0x51c49 path.
  const local = world({objects: [{name: 'target', flags: sensitive}], links: []});
  assert.equal(isWindowSensitiveNative(local.objects.target, false, local.services), true);
  assert.deepEqual(translatedTrace(local.trace).map(entry => [entry.offset, entry.size]),
    [[P.flags, 4]]);
}

console.log('Window sensitivity contract validated: hash-checked unchanged ' +
  'SetSensitivity/EnableWindow/DisableWindow/IsSensitive/GetClientObject exec bodies and ' +
  'GetTopChild/GetBottomChild/GetHigherSibling/GetLowerSibling bodies, optional-argument ' +
  'defaults, raw flag comparison, effective +0x138 polarity, ordered synchronous leaves, ' +
  'visible-bit tree filtering, child delegation, and bit-exact oracle case comparison.');