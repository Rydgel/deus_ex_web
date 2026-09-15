/**
 * Recovered Extension.dll XToggleWindow::SetToggle translation.
 *
 * The unchanged method body compares the stored toggle bit against the new
 * bool, stores `flags ^ ((flags ^ word) & 1)` when they differ, then runs two
 * internal bodies that are translated here: 0x10008380 refreshes the active
 * style triple from the six-entry table at +0x1a4 based on effective
 * sensitivity and root focus, and 0x10049910 walks the +0x138 ancestor chain
 * dispatching the +0xf0 virtual until a node returns nonzero.  The virtual is
 * an explicit synchronous leaf; this module does not invent its body.
 * See docs/script-window-toggle-set.md.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * method body 0x100499b0 through 0x10049a1c and its callee bodies.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_TOGGLE_SET_NATIVE = freeze({
  package: 'Extension',
  function: 'ToggleWindow.SetToggle / XToggleWindow::SetToggle',
  packageExport: 1043,
  nativeIndex: 1611,
  functionFlags: 0x401,
  serialSize: 31,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x10049d10,
  execEnd: 0x10049d56,
  execSha256: '94da21e078fc1099027117fd1a03616494958b4d022471f1d4a13d68b6537e36',
  body: 0x100499b0,
  end: 0x10049a1c,
  stackBytes: 4,
  bodySha256: 'f7c75a88d3b3da7a3f67c1cb71021c9b08c4b987c6ae73afb6c0216051a2e61c',
  registrationCell: 0x10098ea4,
});

export const WINDOW_TOGGLE_SET_NATIVE_ADDRESSES = freeze({
  body: WINDOW_TOGGLE_SET_NATIVE.body,
  end: WINDOW_TOGGLE_SET_NATIVE.end,
  registrationCell: WINDOW_TOGGLE_SET_NATIVE.registrationCell,
  updateToggleStyle: 0x10008380,
  updateToggleStyleEnd: 0x10008441,
  notifyToggleChanged: 0x10049910,
  notifyToggleChangedEnd: 0x100499a2,
  isFocusWindow: 0x1004ca20,
  isFocusWindowEnd: 0x1004ca86,
  getRootWindow: 0x1004c5a0,
  getRootWindowEnd: 0x1004c5bf,
  toggleChangedSlot: 0xf0,
});

/** Numeric byte offsets in the native XToggleWindow object. */
export const WINDOW_TOGGLE_SET_OFFSETS = freeze({
  vtable: 0x00,
  type: 0x28,
  flags: 0x30,
  parent: 0x138,
  toggleFlags: 0x174,
  activeStyle0: 0x184,
  activeStyle1: 0x188,
  activeStyle2: 0x18c,
  styleTable: 0x1a4,
  styleTableEntryStride: 12,
  styleTableEntries: 6,
  rootFocusWindow: 0x5c8,
});

export const WINDOW_TOGGLE_SET_FIELDS = WINDOW_TOGGLE_SET_OFFSETS;

/** Bits tested by the recovered bodies. */
export const WINDOW_TOGGLE_SET_BITS = freeze({
  visible: 0x01,
  sensitive: 0x02,
  toggled: 0x01,
});

export const WINDOW_TOGGLE_SET_NATIVE_CONTRACT = freeze({
  name: 'XToggleWindow::SetToggle',
  address: WINDOW_TOGGLE_SET_NATIVE.body,
  arguments: freeze(['bNewToggle: bool']),
  returns: 'void',
  rawStorage: 'read(object, offset, kind, details) / write(object, offset, kind, value, details)',
  fields: freeze({
    type: WINDOW_TOGGLE_SET_OFFSETS.type,
    flags: WINDOW_TOGGLE_SET_OFFSETS.flags,
    parent: WINDOW_TOGGLE_SET_OFFSETS.parent,
    toggleFlags: WINDOW_TOGGLE_SET_OFFSETS.toggleFlags,
    activeStyle0: WINDOW_TOGGLE_SET_OFFSETS.activeStyle0,
    activeStyle1: WINDOW_TOGGLE_SET_OFFSETS.activeStyle1,
    activeStyle2: WINDOW_TOGGLE_SET_OFFSETS.activeStyle2,
    styleTable: WINDOW_TOGGLE_SET_OFFSETS.styleTable,
    rootFocusWindow: WINDOW_TOGGLE_SET_OFFSETS.rootFocusWindow,
  }),
  callbacks: freeze([
    'toggleChanged(ancestor, source, toggle) through vtable +0xf0',
  ]),
  callees: freeze({
    updateToggleStyle: WINDOW_TOGGLE_SET_NATIVE_ADDRESSES.updateToggleStyle,
    notifyToggleChanged: WINDOW_TOGGLE_SET_NATIVE_ADDRESSES.notifyToggleChanged,
    isFocusWindow: WINDOW_TOGGLE_SET_NATIVE_ADDRESSES.isFocusWindow,
    getRootWindow: WINDOW_TOGGLE_SET_NATIVE_ADDRESSES.getRootWindow,
  }),
});

export class WindowToggleSetNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowToggleSetNativeBoundaryError';
    this.code = `WINDOW_TOGGLE_SET_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowToggleSetNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XToggleWindow::SetToggle ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function required(value, name) {
  if (typeof value !== 'function') {
    fail(`XToggleWindow::SetToggle requires ${name} service`, {
      kind: 'SERVICE', operation: name,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XToggleWindow::SetToggle requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

function present(value) {
  return value !== null && value !== undefined && value !== 0;
}

function toggleWord(value) {
  if (value === true || value === false) return value ? 1 : 0;
  if (Number.isInteger(value) && (value === 0 || value === 1)) return value;
  fail('XToggleWindow::SetToggle requires boolean or native 0/1 bNewToggle', {
    kind: 'VALUE', value, operation: 'argument',
  });
}

function validatePointer(value, label, details = {}) {
  if (!present(value)) return value;
  if (typeof value === 'number' &&
      (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
    fail(`XToggleWindow::SetToggle requires canonical ${label} pointer`, {
      kind: 'VALUE', value, ...details,
    });
  }
  if (typeof value !== 'number' && typeof value !== 'object' && typeof value !== 'function') {
    fail(`XToggleWindow::SetToggle requires canonical ${label} pointer`, {
      kind: 'REFERENCE', value, ...details,
    });
  }
  return value;
}

function readRaw(object, offset, kind, services, phase) {
  const reader = required(services.read, 'read');
  const value = sync(reader(object, offset, kind, {
    native: WINDOW_TOGGLE_SET_NATIVE.body,
    phase,
    object,
    offset,
    kind,
    width: kind === 'u8' ? 1 : 4,
  }), `read +0x${offset.toString(16)}`);
  if (value === undefined) {
    fail(`XToggleWindow::SetToggle reached unresolved +0x${offset.toString(16)} field`, {
      kind: 'FIELD', value, object, offset, operation: phase,
    });
  }
  if (kind === 'ptr') return validatePointer(value, `+0x${offset.toString(16)}`, {
    object, offset, operation: phase,
  });
  if (kind !== 'u8' && kind !== 'u32') {
    fail(`XToggleWindow::SetToggle does not support raw read kind ${kind}`, {
      kind: 'VALUE', value: kind, object, offset, operation: phase,
    });
  }
  if (!Number.isInteger(value) || value < 0 ||
      (kind === 'u8' ? value > 0xff : value > 0xffffffff)) {
    fail(`XToggleWindow::SetToggle requires ${kind === 'u8' ? 'uint8' : 'uint32'} +0x${offset.toString(16)} field`, {
      kind: 'VALUE', value, object, offset, operation: phase,
    });
  }
  return value >>> 0;
}

function writeRaw(object, offset, kind, value, services, phase) {
  const writer = required(services.write, 'write');
  let normalized = value;
  if (kind === 'ptr') {
    normalized = validatePointer(value, `+0x${offset.toString(16)}`, {
      object, offset, operation: phase,
    });
  } else if (kind === 'u8' || kind === 'u32') {
    if (!Number.isInteger(value) || value < 0 ||
        (kind === 'u8' ? value > 0xff : value > 0xffffffff)) {
      fail(`XToggleWindow::SetToggle requires ${kind === 'u8' ? 'uint8' : 'uint32'} +0x${offset.toString(16)} value`, {
        kind: 'VALUE', value, object, offset, operation: phase,
      });
    }
    if (kind === 'u32') normalized >>>= 0;
  } else {
    fail(`XToggleWindow::SetToggle does not support raw write kind ${kind}`, {
      kind: 'VALUE', value: kind, object, offset, operation: phase,
    });
  }
  return sync(writer(object, offset, kind, normalized, {
    native: WINDOW_TOGGLE_SET_NATIVE.body,
    phase,
    object,
    offset,
    kind,
    width: kind === 'u8' ? 1 : 4,
  }), `write +0x${offset.toString(16)}`);
}

function leaf(services, name, label, details) {
  const callback = services[name];
  if (typeof callback !== 'function') {
    fail(`XToggleWindow::SetToggle requires ${name} service`, {
      kind: 'SERVICE', operation: label,
    });
  }
  return sync(callback(details), label);
}

function leafHandled(value, label) {
  if (value === false || value === null || value === 0) return false;
  if (value === true) return true;
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail(`XToggleWindow::SetToggle ${label} returned an unresolved native result`, {
      kind: 'BOUNDARY', value, operation: label,
    });
  }
  return value !== 0;
}

/** XWindow root walk at 0x1004c5a0: climb +0x138 to the topmost window and keep
 * it only when its +0x28 type byte is at least 3. */
function getRootWindow(start, services, phase) {
  const O = WINDOW_TOGGLE_SET_OFFSETS;
  const seen = new Set([start]);
  let node = start;
  for (;;) {
    const parent = readRaw(node, O.parent, 'ptr', services, phase);
    if (!present(parent)) break;
    if (seen.has(parent)) {
      fail('XToggleWindow::SetToggle received a cyclic native parent chain', {
        kind: 'REFERENCE', value: parent, object: start, operation: phase,
      });
    }
    seen.add(parent);
    node = parent;
  }
  const type = readRaw(node, O.type, 'u8', services, phase);
  return type >= 3 ? node : null;
}

/** ToggleWindow focused check at 0x1004ca20: the root's +0x5c8 focus window is
 * compared with the receiver by pointer. */
function isFocusWindow(object, services, phase) {
  const root = getRootWindow(object, services, phase);
  if (!present(root)) return 0;
  const focus = readRaw(root, WINDOW_TOGGLE_SET_OFFSETS.rootFocusWindow, 'ptr',
    services, phase);
  return focus === object ? 1 : 0;
}

/** Style refresh at 0x10008380: pick one of six +0x1a4 triples by
 * (insensitive | focused | plain) x toggle, fall back for a null field 0, then
 * store +0x18c, +0x184, +0x188 in that order. */
function updateToggleStyle(object, services) {
  const O = WINDOW_TOGGLE_SET_OFFSETS;
  const B = WINDOW_TOGGLE_SET_BITS;
  const phase = 'update-toggle-style';
  const seen = new Set();
  let current = object;
  while (present(current)) {
    if (seen.has(current)) {
      fail('XToggleWindow::SetToggle received a cyclic native sensitivity chain', {
        kind: 'REFERENCE', value: current, object, operation: phase,
      });
    }
    seen.add(current);
    const flags = readRaw(current, O.flags, 'u8', services, phase);
    if ((flags & B.sensitive) === 0) break;
    current = readRaw(current, O.parent, 'ptr', services, phase);
  }
  // sete after the walk: a null chain end means every ancestor was sensitive.
  let state;
  if (present(current)) {
    state = 2;
  } else {
    state = isFocusWindow(object, services, phase) !== 0 ? 1 : 0;
  }
  const toggleFlags = readRaw(object, O.toggleFlags, 'u32', services, phase);
  const toggle = toggleFlags & B.toggled;
  const index = state * 2 + toggle;
  const entry = O.styleTable + index * O.styleTableEntryStride;
  // Field 0 is read first; fields 1 and 2 are read unconditionally after it.
  const field0 = readRaw(object, entry, 'ptr', services, phase);
  const field1 = readRaw(object, entry + 4, 'ptr', services, phase);
  const field2 = readRaw(object, entry + 8, 'ptr', services, phase);
  let selected0 = field0;
  if (!present(selected0)) {
    if (toggle !== 0) {
      selected0 = readRaw(object, O.styleTable + O.styleTableEntryStride, 'ptr',
        services, phase);
      if (!present(selected0)) {
        selected0 = readRaw(object, O.styleTable, 'ptr', services, phase);
      }
    } else {
      selected0 = readRaw(object, O.styleTable, 'ptr', services, phase);
    }
  }
  writeRaw(object, O.activeStyle2, 'ptr', field2, services, phase);
  writeRaw(object, O.activeStyle0, 'ptr', selected0, services, phase);
  writeRaw(object, O.activeStyle1, 'ptr', field1, services, phase);
}

/** Notify walk at 0x10049910: dispatch the +0xf0 virtual on each ancestor
 * (starting with the receiver) with (source, toggle bit) until one returns
 * nonzero or the +0x138 chain ends.  The receiver's +0x174 is re-read before
 * every dispatch. */
function notifyToggleChanged(object, services) {
  const O = WINDOW_TOGGLE_SET_OFFSETS;
  const A = WINDOW_TOGGLE_SET_NATIVE_ADDRESSES;
  const seen = new Set();
  let current = object;
  while (present(current)) {
    if (seen.has(current)) {
      fail('XToggleWindow::SetToggle received a cyclic native notify chain', {
        kind: 'REFERENCE', value: current, object, operation: 'notify-toggle',
      });
    }
    seen.add(current);
    const toggleFlags = readRaw(object, O.toggleFlags, 'u32', services, 'notify-toggle');
    const handled = leafHandled(leaf(services, 'toggleChanged', 'ToggleChanged', {
      object: current,
      source: object,
      toggle: toggleFlags & WINDOW_TOGGLE_SET_BITS.toggled,
      virtualSlot: A.toggleChangedSlot,
      native: A.notifyToggleChanged,
    }), 'ToggleChanged');
    if (handled) break;
    current = readRaw(current, O.parent, 'ptr', services, 'notify-toggle');
  }
}

/**
 * Execute the original void XToggleWindow::SetToggle body.
 *
 * `object` is the canonical ToggleWindow receiver and `newToggle` the
 * marshalled bool argument.  `services.read`/`services.write` expose raw
 * window storage; `services.toggleChanged` is the +0xf0 virtual leaf.
 */
export function setToggleNative(object, newToggle, services = {}) {
  objectReference(object, 'window');
  const word = toggleWord(newToggle);
  const O = WINDOW_TOGGLE_SET_OFFSETS;
  const flags = readRaw(object, O.toggleFlags, 'u32', services, 'toggle-read');
  if ((flags & WINDOW_TOGGLE_SET_BITS.toggled) === word) return;
  const next = (flags ^ ((flags ^ word) & WINDOW_TOGGLE_SET_BITS.toggled)) >>> 0;
  writeRaw(object, O.toggleFlags, 'u32', next, services, 'toggle-store');
  updateToggleStyle(object, services);
  notifyToggleChanged(object, services);
}

export const windowSetToggleNative = setToggleNative;
export const toggleWindowSetToggleNative = setToggleNative;
