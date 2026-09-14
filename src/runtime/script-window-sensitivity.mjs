/**
 * Execute the recovered Extension.dll XWindow sensitivity and tree-walk bodies.
 *
 * The storage offsets, flag polarity, optional-argument defaults, delegation
 * order, and tail callee order below are taken from the unchanged Extension.dll
 * instructions.  CheckFocusWindow, CheckGrabbedWindow, MakeAcceleratorTableDirty
 * and the recursive SensitivityChanged notification remain synchronous host
 * leaves; this adapter does not replace any of those native bodies with guessed
 * browser behavior.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * XWindow::SetSensitivity at 0x1004c890, XWindow::GetLowerSibling at
 * 0x1004c650, XWindow::GetHigherSibling at 0x1004c680, XWindow::GetTopChild at
 * 0x1004c6b0, XWindow::GetBottomChild at 0x1004c740, and the exec bodies listed
 * in the mapping table.  The recovered contract is recorded in
 * docs/script-window-sensitivity.md.
 */

const freeze = value => Object.freeze(value);

const EXTENSION_HASH =
  '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c';

export const WINDOW_SENSITIVITY_NATIVE = freeze({
  package: 'Extension',
  function: 'XWindow::SetSensitivity / XWindow::IsSensitive / XWindow tree walk',
  dll: 'Extension.dll',
  dllSha256: EXTENSION_HASH,
  imageBase: 0x10000000,
  functions: freeze({
    setSensitivity: freeze({
      name: 'Window.SetSensitivity / XWindow::SetSensitivity',
      packageExport: 1416, nativeIndex: 1416,
      execBody: 0x10051ab0, execEnd: 0x10051af6,
      execSha256: '52d4f59a9aaddc20366653576e19ccf06c525095f179c7c83ea81e6b7e6b9dbd',
      optionalArgumentDefault: false,
      body: 0x1004c890, end: 0x1004c947, stackBytes: 4,
      bodySha256: '808e503c7a65765e4c28e9dd16af779a5855b2ebf400f04eda32bafd0057f506',
    }),
    enableWindow: freeze({
      name: 'Window.EnableWindow / XWindow::SetSensitivity',
      nativeIndex: 1417,
      execBody: 0x10051b20, execEnd: 0x10051b66,
      execSha256: 'de1b827bda3a5864bf8c4c833f02816483b44f87b90eca58879ad4fc8b3d44f4',
      optionalArgumentDefault: true,
      body: 0x1004c890, end: 0x1004c947, stackBytes: 4,
      bodySha256: '808e503c7a65765e4c28e9dd16af779a5855b2ebf400f04eda32bafd0057f506',
    }),
    disableWindow: freeze({
      name: 'Window.DisableWindow / XWindow::SetSensitivity',
      nativeIndex: 1418,
      execBody: 0x10051b90, execEnd: 0x10051ba1,
      execSha256: '05403e3f1818f3202b892783020ecbb2bd36f2373e122042ebe7ec1c43867a7d',
      optionalArgumentDefault: null,
      body: 0x1004c890, end: 0x1004c947, stackBytes: 4,
      bodySha256: '808e503c7a65765e4c28e9dd16af779a5855b2ebf400f04eda32bafd0057f506',
    }),
    isSensitive: freeze({
      name: 'Window.IsSensitive / XWindow::IsSensitive',
      nativeIndex: 1419,
      execBody: 0x10051bd0, execEnd: 0x10051c4c,
      execSha256: '1cbfd1ec386e73ec84c967450fe884febab2218bf782eb685cf189d2464caac3',
      optionalArgumentDefault: true,
      recursiveFlagFilters: 'bit 1 (SENSITIVE); effective true when the +0x138 walk runs off the chain',
    }),
    getTopChild: freeze({
      name: 'Window.GetTopChild / XWindow::GetTopChild',
      nativeIndex: 1455,
      execBody: 0x10052d40, execEnd: 0x10052d8c,
      execSha256: '8e2670a7bef50147bb95bc03782a081864f384d446b5223157c1e2f3e1db7bfb',
      optionalArgumentDefault: true,
      body: 0x1004c6b0, end: 0x1004c70a, stackBytes: 4,
      bodySha256: 'fcf8308961945b5a24fa95b2de95ecee8f862df6b7979b550617aa40b2cce76a',
      childLink: 0x140, delegation: 'GetLowerSibling(child,flag) at 0x1004c6f2',
    }),
    getBottomChild: freeze({
      name: 'Window.GetBottomChild / XWindow::GetBottomChild',
      nativeIndex: 1456,
      execBody: 0x10052db0, execEnd: 0x10052dfc,
      execSha256: '917a1d2bb57cab0165a432fa644bc13f0c239839e97f4b55bddaccffca9d3836',
      optionalArgumentDefault: true,
      body: 0x1004c740, end: 0x1004c79a, stackBytes: 4,
      bodySha256: 'd6932038936b41b66b678639fc6c5d391ce5a720a5c67a251a4e2b676e0922c3',
      childLink: 0x13c, delegation: 'GetHigherSibling(child,flag) at 0x1004c782',
    }),
    getHigherSibling: freeze({
      name: 'Window.GetHigherSibling / XWindow::GetHigherSibling',
      nativeIndex: 1457,
      execBody: 0x10052e20, execEnd: 0x10052e6c,
      execSha256: '86accde319ceedff9802f463b27e1e68967b52ff74f7581949fa6e7c51d95918',
      optionalArgumentDefault: true,
      body: 0x1004c680, end: 0x1004c6a6, stackBytes: 4,
      bodySha256: 'e7ffb2848ac6b9f622a85798f46fde2df2172b8f9cec86487d4a64b68863c7dd',
      link: 0x148, filters: 'bit 0 (VISIBLE)',
    }),
    getLowerSibling: freeze({
      name: 'Window.GetLowerSibling / XWindow::GetLowerSibling',
      nativeIndex: 1458,
      execBody: 0x10052e90, execEnd: 0x10052edc,
      execSha256: 'd65f2ae3d3e367f3c641dbf9b2b44fa7782d5cc3803c8c1d62e8faa77682e627',
      optionalArgumentDefault: true,
      body: 0x1004c650, end: 0x1004c676, stackBytes: 4,
      bodySha256: '506a2fa0b9b47ea365d9636fe128fdca3f4f13c329eff2693f948c5f8091ce2e',
      link: 0x144, filters: 'bit 0 (VISIBLE)',
    }),
    getClientObject: freeze({
      name: 'Window.GetClientObject / XWindow::GetClientObject',
      nativeIndex: 1488,
      execBody: 0x10052650, execEnd: 0x1005266a,
      execSha256: 'a853decf7b955c318b4f9338bba9ba75179df8234135c6d409fcc293c56eb040',
      optionalArgumentDefault: null,
      body: 0x10052650, end: 0x1005266a,
      bodySha256: 'a853decf7b955c318b4f9338bba9ba75179df8234135c6d409fcc293c56eb040',
      clientObject: 0x118,
    }),
  }),
});

export const WINDOW_SENSITIVITY_NATIVE_ADDRESSES = freeze({
  setSensitivity: 0x1004c890,
  setSensitivityEnd: 0x1004c947,
  getLowerSibling: 0x1004c650,
  getLowerSiblingEnd: 0x1004c676,
  getHigherSibling: 0x1004c680,
  getHigherSiblingEnd: 0x1004c6a6,
  getTopChild: 0x1004c6b0,
  getTopChildEnd: 0x1004c70a,
  getBottomChild: 0x1004c740,
  getBottomChildEnd: 0x1004c79a,
  checkFocusWindow: 0x10050b80,
  checkGrabbedWindow: 0x10050c90,
  makeAcceleratorTableDirty: 0x1004c1d0,
  notifySensitivityChanged: 0x10050ef0,
  sensitivityChangedSlot: 0x98,
  sensitivityChangedEvent: 0x1009b3c4,
  sensitivityChangedLiteral: 0x10098184,
});

/** Numeric byte offsets in the native XWindow object. */
export const WINDOW_SENSITIVITY_OFFSETS = freeze({
  vtable: 0x00,
  flags: 0x30,
  windowFlags: 0x30,
  clientObject: 0x118,
  parent: 0x138,
  bottomChild: 0x13c,
  topChild: 0x140,
  lowerSibling: 0x144,
  higherSibling: 0x148,
});

export const WINDOW_SENSITIVITY_FIELDS = WINDOW_SENSITIVITY_OFFSETS;

export const WINDOW_SENSITIVITY_BITS = freeze({visible: 0x01, sensitive: 0x02});

export const WINDOW_SENSITIVITY_NATIVE_CONTRACT = freeze({
  name: 'XWindow::SetSensitivity / XWindow::IsSensitive / XWindow tree walk',
  addresses: freeze({
    setSensitivity: WINDOW_SENSITIVITY_NATIVE_ADDRESSES.setSensitivity,
    getLowerSibling: WINDOW_SENSITIVITY_NATIVE_ADDRESSES.getLowerSibling,
    getHigherSibling: WINDOW_SENSITIVITY_NATIVE_ADDRESSES.getHigherSibling,
    getTopChild: WINDOW_SENSITIVITY_NATIVE_ADDRESSES.getTopChild,
    getBottomChild: WINDOW_SENSITIVITY_NATIVE_ADDRESSES.getBottomChild,
  }),
  arguments: freeze(['XWindow* this', 'int flag/argument']),
  returns: 'pointer for the tree accessors, int for IsSensitive, void for the setters',
  rawStorage: 'read(object, offset, kind, details) / write(object, offset, kind, value, details)',
  flags: 'bit 0 VISIBLE, bit 1 SENSITIVE; upper bits retained by the setter write',
  effectiveWalk: 'read byte +0x30 then pointer +0x138 while bit 1 remains set; true when the walk runs off the chain',
  setterCallbacks: freeze([
    'CheckFocusWindow(this)',
    'CheckGrabbedWindow(this)',
    'MakeAcceleratorTableDirty(this)',
    'notifySensitivityChanged(this,effectiveSensitivity) through SensitivityChanged slot +0x98',
  ]),
  treeAccessors: freeze({
    getTopChild: 'read +0x140; delegate to GetLowerSibling when the flag is set, the child exists, and the child bit 0 is clear',
    getBottomChild: 'read +0x13c; delegate to GetHigherSibling when the flag is set, the child exists, and the child bit 0 is clear',
    getLowerSibling: 'read +0x144; with the flag set skip links whose bit 0 is clear',
    getHigherSibling: 'read +0x148; with the flag set skip links whose bit 0 is clear',
  }),
});

export class WindowSensitivityNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowSensitivityNativeBoundaryError';
    this.code = `WINDOW_SENSITIVITY_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowSensitivityNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XWindow sensitivity ${label} service suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function required(value, name) {
  if (typeof value !== 'function') {
    fail(`XWindow sensitivity requires ${name} service`, {kind: 'SERVICE', operation: name});
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined || value === 0 ||
      (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'number')) {
    fail(`XWindow sensitivity requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  if (typeof value === 'number' &&
      (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
    fail(`XWindow sensitivity requires uint32 ${name} pointer`, {
      kind: 'VALUE', value, operation: name,
    });
  }
  return value;
}

function present(value) {
  return value !== null && value !== undefined && value !== 0;
}

function pointer(value, label, details = {}) {
  if (!present(value)) return value;
  if (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'number') {
    fail(`XWindow sensitivity requires canonical ${label}`, {
      kind: 'REFERENCE', value, ...details,
    });
  }
  if (typeof value === 'number' &&
      (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
    fail(`XWindow sensitivity requires uint32 ${label}`, {
      kind: 'VALUE', value, ...details,
    });
  }
  return value;
}

function uint(value, label, offset, details = {}) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail(`XWindow sensitivity requires uint32 ${label} at +0x${offset.toString(16)}`, {
      kind: 'VALUE', value, offset, operation: label, ...details,
    });
  }
  return value >>> 0;
}

function nativeForPhase(phase) {
  if (phase.startsWith('SetSensitivity/')) return WINDOW_SENSITIVITY_NATIVE_ADDRESSES.setSensitivity;
  if (phase.startsWith('IsSensitive/')) return 0x10051bd0;
  if (phase.startsWith('GetTopChild/')) return WINDOW_SENSITIVITY_NATIVE_ADDRESSES.getTopChild;
  if (phase.startsWith('GetBottomChild/')) return WINDOW_SENSITIVITY_NATIVE_ADDRESSES.getBottomChild;
  if (phase.startsWith('GetHigherSibling/')) return WINDOW_SENSITIVITY_NATIVE_ADDRESSES.getHigherSibling;
  if (phase.startsWith('GetLowerSibling/')) return WINDOW_SENSITIVITY_NATIVE_ADDRESSES.getLowerSibling;
  if (phase.startsWith('GetClientObject/')) return 0x10052650;
  return 0;
}

function rawDetails(phase, object, offset, kind) {
  return {
    native: nativeForPhase(phase),
    phase,
    object,
    offset,
    kind,
    width: kind === 'u8' ? 1 : 4,
  };
}

function readRaw(object, offset, kind, services, phase) {
  const reader = required(services.read, 'read');
  const value = sync(reader(object, offset, kind, rawDetails(phase, object, offset, kind)),
    `read +0x${offset.toString(16)}`);
  if (value === undefined) {
    fail(`XWindow sensitivity reached unresolved raw field +0x${offset.toString(16)}`, {
      kind: 'FIELD', value, object, offset, operation: phase,
    });
  }
  if (kind === 'ptr') return pointer(value, `+0x${offset.toString(16)} pointer`, {
    object, offset, operation: phase,
  });
  if (kind === 'u8') {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      fail(`XWindow sensitivity raw byte +0x${offset.toString(16)} is outside uint8`, {
        kind: 'VALUE', value, object, offset, operation: phase,
      });
    }
    return value;
  }
  if (kind === 'u32') return uint(value, 'native dword', offset, {object, operation: phase});
  fail(`XWindow sensitivity does not support raw read kind ${kind}`, {
    kind: 'VALUE', value: kind, object, offset, operation: phase,
  });
}

function writeRaw(object, offset, kind, value, services, phase, source = undefined) {
  const writer = required(services.write, 'write');
  let normalized = value;
  if (kind === 'ptr') {
    normalized = pointer(value, `+0x${offset.toString(16)} pointer`, {
      object, offset, operation: phase,
    });
  } else if (kind === 'u8') {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      fail(`XWindow sensitivity raw byte +0x${offset.toString(16)} is outside uint8`, {
        kind: 'VALUE', value, object, offset, operation: phase,
      });
    }
  } else if (kind === 'u32') {
    normalized = uint(value, 'native dword', offset, {object, operation: phase});
  } else {
    fail(`XWindow sensitivity does not support raw write kind ${kind}`, {
      kind: 'VALUE', value: kind, object, offset, operation: phase,
    });
  }
  return sync(writer(object, offset, kind, normalized, {
    ...rawDetails(phase, object, offset, kind),
    source,
  }), `write +0x${offset.toString(16)}`);
}

function callLeaf(services, names, label, details) {
  const candidates = Array.isArray(names) ? names : [names];
  const callback = candidates.map(name => services[name])
    .find(value => typeof value === 'function');
  if (!callback) fail(`XWindow sensitivity requires ${candidates[0]} service`, {
    kind: 'SERVICE', operation: label,
  });
  return sync(callback(details), label);
}

/** The native int argument and the tree-accessor flag accept a bool word. */
function booleanWord(value, label) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === 0 || value === 1) return value;
  fail(`XWindow sensitivity requires boolean or native 0/1 ${label}`, {
    kind: 'VALUE', value, operation: label,
  });
}

function sensitivityDetails(object, effective, native) {
  return {
    object,
    window: object,
    sensitive: effective,
    effectiveSensitivity: effective,
    rawSensitivity: effective ? 1 : 0,
    native,
  };
}

/**
 * Effective sensitivity: climb +0x138 while the local bit 1 remains set.  The
 * walk ran off the chain (null parent) when the result is true.
 */
function effectiveSensitive(window, services, phase) {
  const seen = new Set();
  let object = window;
  while (present(object)) {
    if (seen.has(object)) {
      fail('XWindow::SetSensitivity received a cyclic +0x138 parent chain', {
        kind: 'REFERENCE', object, offset: WINDOW_SENSITIVITY_OFFSETS.parent,
        operation: phase,
      });
    }
    seen.add(object);
    const flags = readRaw(object, WINDOW_SENSITIVITY_OFFSETS.flags, 'u8', services, phase);
    if ((flags & WINDOW_SENSITIVITY_BITS.sensitive) === 0) return false;
    object = readRaw(object, WINDOW_SENSITIVITY_OFFSETS.parent, 'ptr', services, phase);
  }
  return true;
}

function setSensitivityBody(window, word, services) {
  const O = WINDOW_SENSITIVITY_OFFSETS;
  const B = WINDOW_SENSITIVITY_BITS;
  const oldFlags = readRaw(window, O.flags, 'u32', services, 'SetSensitivity/guard');
  // 0x1004c8c0..0x1004c8c7 compares the raw argument with the existing bit;
  // an equal value returns before any other field or callback is touched.
  if (((oldFlags >>> 1) & 1) === word) return;

  const before = effectiveSensitive(window, services, 'SetSensitivity/before');
  const flagsForWrite = readRaw(window, O.flags, 'u32', services, 'SetSensitivity/write');
  writeRaw(window, O.flags, 'u32',
    ((flagsForWrite & ~B.sensitive) | ((word & 1) << 1)) >>> 0,
    services, 'SetSensitivity/write', 'replace sensitive bit');
  const after = effectiveSensitive(window, services, 'SetSensitivity/after');
  if (before === after) return;

  callLeaf(services, ['checkFocusWindow', 'checkFocus'], 'CheckFocusWindow',
    sensitivityDetails(window, after, WINDOW_SENSITIVITY_NATIVE_ADDRESSES.checkFocusWindow));
  callLeaf(services, ['checkGrabbedWindow', 'checkGrabbed'], 'CheckGrabbedWindow',
    sensitivityDetails(window, after, WINDOW_SENSITIVITY_NATIVE_ADDRESSES.checkGrabbedWindow));
  callLeaf(services, ['makeAcceleratorTableDirty', 'invalidateAccelerators',
    'acceleratorTableDirty'], 'MakeAcceleratorTableDirty',
  sensitivityDetails(window, after, WINDOW_SENSITIVITY_NATIVE_ADDRESSES.makeAcceleratorTableDirty));
  callLeaf(services, ['notifySensitivityChanged', 'sensitivityChanged',
    'sensitivityChange', 'notifySensitivityChange'], 'NotifySensitivityChanged', {
    ...sensitivityDetails(window, after, WINDOW_SENSITIVITY_NATIVE_ADDRESSES.notifySensitivityChanged),
    virtualSlot: WINDOW_SENSITIVITY_NATIVE_ADDRESSES.sensitivityChangedSlot,
    event: 'SensitivityChanged',
  });
}

/** Execute XWindow::SetSensitivity(this,argument) (natives 1416/1417/1418). */
export function setSensitivityNative({
  window, object, sensitivity, newSensitivity, sensitive,
} = {}, services = {}) {
  const receiver = window ?? object;
  objectReference(receiver, 'window');
  const word = booleanWord(sensitivity ?? newSensitivity ?? sensitive, 'sensitivity');
  setSensitivityBody(receiver, word, services);
}

/** EnableWindow's optional argument defaults to true (exec body 0x10051b20). */
export function enableWindowNative(window, services = {}) {
  objectReference(window, 'window');
  setSensitivityBody(window, 1, services);
}

/** DisableWindow pushes a literal 0 and does not parse an argument. */
export function disableWindowNative(window, services = {}) {
  objectReference(window, 'window');
  setSensitivityBody(window, 0, services);
}

/**
 * Execute the exec body's inline XWindow::IsSensitive(bRecurse) branch.  The
 * non-recursive path reads the receiver's dword; the recursive path climbs
 * +0x138 while bit 1 stays set and is true only when the walk runs off the
 * chain.
 */
export function isWindowSensitiveNative(window, recurse = true, services = {}) {
  objectReference(window, 'window');
  const flag = booleanWord(recurse, 'recurse');
  if (!flag) {
    const flags = readRaw(window, WINDOW_SENSITIVITY_OFFSETS.flags, 'u32', services,
      'IsSensitive/local');
    return ((flags >>> 1) & 1) === 1;
  }
  const seen = new Set();
  let object = window;
  while (present(object)) {
    if (seen.has(object)) {
      fail('XWindow::IsSensitive received a cyclic +0x138 parent chain', {
        kind: 'REFERENCE', object, offset: WINDOW_SENSITIVITY_OFFSETS.parent,
        operation: 'IsSensitive/recurse',
      });
    }
    seen.add(object);
    const flags = readRaw(object, WINDOW_SENSITIVITY_OFFSETS.flags, 'u8', services,
      'IsSensitive/recurse');
    if ((flags & WINDOW_SENSITIVITY_BITS.sensitive) === 0) return false;
    object = readRaw(object, WINDOW_SENSITIVITY_OFFSETS.parent, 'ptr', services,
      'IsSensitive/recurse');
  }
  return true;
}

function siblingChain(link, offset, services, phase) {
  const seen = new Set();
  while (present(link)) {
    if (seen.has(link)) {
      fail('XWindow sibling walk received a cyclic sibling chain', {
        kind: 'REFERENCE', object: link, offset, operation: phase,
      });
    }
    seen.add(link);
    const flags = readRaw(link, WINDOW_SENSITIVITY_OFFSETS.flags, 'u8', services, phase);
    if (flags & WINDOW_SENSITIVITY_BITS.visible) return link;
    link = readRaw(link, offset, 'ptr', services, phase);
  }
  return link;
}

function siblingNative(window, offset, filterVisible, services, phase) {
  objectReference(window, 'window');
  const flag = booleanWord(filterVisible, 'filterVisible');
  const link = readRaw(window, offset, 'ptr', services, `${phase}/link`);
  if (!flag) return link;
  if (!present(link)) return link;
  return siblingChain(link, offset, services, `${phase}/visible`);
}

/** XWindow::GetLowerSibling(this,flag) at 0x1004c650. */
export function getLowerSiblingNative(window, filterVisible = true, services = {}) {
  return siblingNative(window, WINDOW_SENSITIVITY_OFFSETS.lowerSibling, filterVisible,
    services, 'GetLowerSibling');
}

/** XWindow::GetHigherSibling(this,flag) at 0x1004c680. */
export function getHigherSiblingNative(window, filterVisible = true, services = {}) {
  return siblingNative(window, WINDOW_SENSITIVITY_OFFSETS.higherSibling, filterVisible,
    services, 'GetHigherSibling');
}

function childNative(window, childOffset, siblingOffset, filterVisible, services, phase) {
  objectReference(window, 'window');
  const flag = booleanWord(filterVisible, 'filterVisible');
  const child = readRaw(window, childOffset, 'ptr', services, `${phase}/child`);
  if (!flag) return child;
  if (!present(child)) return child;
  const flags = readRaw(child, WINDOW_SENSITIVITY_OFFSETS.flags, 'u8', services,
    `${phase}/visible`);
  if (flags & WINDOW_SENSITIVITY_BITS.visible) return child;
  const link = readRaw(child, siblingOffset, 'ptr', services, `${phase}/link`);
  if (!present(link)) return link;
  return siblingChain(link, siblingOffset, services, `${phase}/visible`);
}

/**
 * XWindow::GetTopChild(this,flag) at 0x1004c6b0: read +0x140, and only when
 * the flag is set, the child exists, and the child's bit 0 is clear delegate to
 * GetLowerSibling(child,flag) at 0x1004c6f2.
 */
export function getTopChildNative(window, filterVisible = true, services = {}) {
  return childNative(window, WINDOW_SENSITIVITY_OFFSETS.topChild,
    WINDOW_SENSITIVITY_OFFSETS.lowerSibling, filterVisible, services, 'GetTopChild');
}

/**
 * XWindow::GetBottomChild(this,flag) at 0x1004c740: read +0x13c, and only when
 * the flag is set, the child exists, and the child's bit 0 is clear delegate to
 * GetHigherSibling(child,flag) at 0x1004c782.
 */
export function getBottomChildNative(window, filterVisible = true, services = {}) {
  return childNative(window, WINDOW_SENSITIVITY_OFFSETS.bottomChild,
    WINDOW_SENSITIVITY_OFFSETS.higherSibling, filterVisible, services, 'GetBottomChild');
}

/** The exec body at 0x10052650 is GetClientObject in its entirety. */
export function getClientObjectNative(window, services = {}) {
  objectReference(window, 'window');
  return readRaw(window, WINDOW_SENSITIVITY_OFFSETS.clientObject, 'ptr', services,
    'GetClientObject/client');
}

/**
 * The optional-argument default each exec body pre-stores before parsing, keyed
 * by native index.  Each value is the `mov dword ptr [esp+4], imm32` immediate
 * in the shipped exec body (0x10051ab8 stores 0 for SetSensitivity while
 * 0x10051b28 stores 1 for EnableWindow), so the dispatcher reads the recovered
 * constant instead of repeating a literal that nothing checks.
 * scripts/validate-window-sensitivity.mjs decodes those immediates straight out
 * of Extension.dll and compares them with this table.
 */
export function windowSensitivityOptionalDefault(nativeIndex) {
  for (const entry of Object.values(WINDOW_SENSITIVITY_NATIVE.functions))
    if (entry.nativeIndex === nativeIndex) {
      if (entry.optionalArgumentDefault === null)
        throw new Error(`Extension native ${nativeIndex} takes no optional argument`);
      return entry.optionalArgumentDefault;
    }
  throw new Error(`Extension native ${nativeIndex} is not a window sensitivity native`);
}

export const xWindowSetSensitivityNative = setSensitivityNative;
export const setWindowSensitivityNative = setSensitivityNative;
export const xWindowEnableWindowNative = enableWindowNative;
export const xWindowDisableWindowNative = disableWindowNative;
export const xWindowIsSensitiveNative = isWindowSensitiveNative;
export const xWindowGetTopChildNative = getTopChildNative;
export const xWindowGetBottomChildNative = getBottomChildNative;
export const xWindowGetHigherSiblingNative = getHigherSiblingNative;
export const xWindowGetLowerSiblingNative = getLowerSiblingNative;
export const xWindowGetClientObjectNative = getClientObjectNative;
