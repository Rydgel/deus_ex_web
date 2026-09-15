/**
 * Recovered Extension.dll XWindow::ConfigureChild translation.
 *
 * The unchanged method body at 0x1004ec50 runs the three diagnostics, locks
 * the window (+0x34), raises the configure depth global 0x100aeb0c, sets
 * +0xb8 bit 2, and — only when the +0x30 visibility bit is set — compares the
 * stored width/height f32s against the arguments via x87 C3 (NaN counts as
 * equal), folds in the pending +0xb8 bit 0, then stores x/y/w/h at
 * +0x78..+0x84, reconfigures children through 0x10050f90 (translated), and —
 * when the depth is 1 or the +0x28 type is >= 1 — runs the bounds update leaf
 * 0x10051160 and the ancestor-list sort leaf 0x10045140.  It then drops the
 * depth and unlocks (+0x34 decrement, dispatching SafeDestroy when +0x30 bit
 * 0x10 is set).  The x87 rect accumulation in 0x10051160, the qsort in
 * 0x10045140, ResizeChild 0x1004eab0, the +0x90 configuration-changed
 * virtual, and XWindow::SafeDestroy 0x1004c0b0 remain explicit synchronous
 * leaves; this module does not invent their bodies.
 * See docs/script-window-configure-child.md.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * method body 0x1004ec50 through 0x1004eded and the callee bodies listed in
 * WINDOW_CONFIGURE_CHILD_NATIVE_ADDRESSES.
 */

const freeze = value => Object.freeze(value);
const f = Math.fround;

export const WINDOW_CONFIGURE_CHILD_NATIVE = freeze({
  package: 'Extension',
  function: 'Window.ConfigureChild / XWindow::ConfigureChild',
  packageExport: 1956,
  nativeIndex: 1461,
  functionFlags: 0x401,
  serialSize: 40,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x10052f60,
  execEnd: 0x10053025,
  execSha256: 'e69f4a6b0de22293e80a83fbf671dab6d2ea62b974a955ca64a8fbbfb3aa8d86',
  body: 0x1004ec50,
  end: 0x1004eded,
  stackBytes: 16,
  bodySha256: 'f794bac60557edd24cb0f99102cfb777ffa25a28d1f7218bd5cd6fbaaff73928',
  registrationCell: 0x10099030,
});

export const WINDOW_CONFIGURE_CHILD_NATIVE_ADDRESSES = freeze({
  body: WINDOW_CONFIGURE_CHILD_NATIVE.body,
  end: WINDOW_CONFIGURE_CHILD_NATIVE.end,
  registrationCell: WINDOW_CONFIGURE_CHILD_NATIVE.registrationCell,
  lock: 0x1004c140,
  lockEnd: 0x1004c144,
  lockSha256: 'c1e5f788c3f0cf149006e5294e111ddfebfd9654ed20b4bdd8e054164e7e56de',
  unlock: 0x1004c150,
  unlockEnd: 0x1004c1a0,
  unlockSha256: '79b2d929cc25c6c6fb2022b52dc635a2e6abe090bc3c6f924ce9e8cd00a63fbf',
  type1Ancestor: 0x1004c560,
  type1AncestorEnd: 0x1004c578,
  type1AncestorSha256: '385fc2275bcc6cd65b0ffc066833ce0a7f92fad9cc602d00f8c321937d33323a',
  reconfigureChildren: 0x10050f90,
  reconfigureChildrenEnd: 0x100510bf,
  reconfigureChildrenSha256: '1ed0738cf98b180b3d3b4665c3bedd772b6bea395de0cd7333e6e9d4209760be',
  safeDestroy: 0x1004c0b0,
  boundsUpdate: 0x10051160,
  sortWindowLists: 0x10045140,
  resizeChild: 0x1004eab0,
  configurationChangedSlot: 0x90,
  diagnosticFNameIat: 0x10059180,
  diagnosticLogIat: 0x100591a8,
  gErrorIat: 0x100590b4,
  diagnosticLine: 0x2ff,
  diagnosticContextFormat: 0x100993c0,
  diagnosticPreferredSizeFormat: 0x1009933c,
  diagnosticGranularityFormat: 0x100992c4,
});

/** Numeric byte offsets in the native XWindow object. */
export const WINDOW_CONFIGURE_CHILD_OFFSETS = freeze({
  vtable: 0x00,
  type: 0x28,
  flags: 0x30,
  lockCount: 0x34,
  x: 0x78,
  y: 0x7c,
  width: 0x80,
  height: 0x84,
  alignX: 0x88,
  alignY: 0x89,
  reconfigureFlags: 0xb8,
  parent: 0x138,
  firstChild: 0x13c,
  nextSibling: 0x148,
});

export const WINDOW_CONFIGURE_CHILD_FIELDS = WINDOW_CONFIGURE_CHILD_OFFSETS;

/** Bits tested by the recovered bodies. */
export const WINDOW_CONFIGURE_CHILD_BITS = freeze({
  visible: 0x01,
  beingDestroyed: 0x10,
  pendingReconfigure: 0x01,
  reconfiguring: 0x04,
});

/** Global names are stable host keys; their original preferred addresses are
 * retained separately so adapters can bind real image storage explicitly. */
export const WINDOW_CONFIGURE_CHILD_GLOBALS = freeze({
  context: 'global100aeafc',
  reconfigurationDepth: 'global100aeb00',
  preferredSizeDepth: 'global100aeb04',
  granularityDepth: 'global100aeb08',
  configureDepth: 'global100aeb0c',
});

export const WINDOW_CONFIGURE_CHILD_GLOBAL_ADDRESSES = freeze({
  [WINDOW_CONFIGURE_CHILD_GLOBALS.context]: 0x100aeafc,
  [WINDOW_CONFIGURE_CHILD_GLOBALS.reconfigurationDepth]: 0x100aeb00,
  [WINDOW_CONFIGURE_CHILD_GLOBALS.preferredSizeDepth]: 0x100aeb04,
  [WINDOW_CONFIGURE_CHILD_GLOBALS.granularityDepth]: 0x100aeb08,
  [WINDOW_CONFIGURE_CHILD_GLOBALS.configureDepth]: 0x100aeb0c,
});

export const WINDOW_CONFIGURE_CHILD_NATIVE_CONTRACT = freeze({
  name: 'XWindow::ConfigureChild',
  address: WINDOW_CONFIGURE_CHILD_NATIVE.body,
  arguments: freeze(['newX: float', 'newY: float', 'newWidth: float', 'NewHeight: float']),
  returns: 'void',
  rawStorage: 'read(object, offset, kind, details) / write(object, offset, kind, value, details)',
  globals: 'readGlobal(name, kind, details) / writeGlobal(name, kind, value, details)',
  fields: freeze({
    type: WINDOW_CONFIGURE_CHILD_OFFSETS.type,
    flags: WINDOW_CONFIGURE_CHILD_OFFSETS.flags,
    lockCount: WINDOW_CONFIGURE_CHILD_OFFSETS.lockCount,
    x: WINDOW_CONFIGURE_CHILD_OFFSETS.x,
    y: WINDOW_CONFIGURE_CHILD_OFFSETS.y,
    width: WINDOW_CONFIGURE_CHILD_OFFSETS.width,
    height: WINDOW_CONFIGURE_CHILD_OFFSETS.height,
    alignX: WINDOW_CONFIGURE_CHILD_OFFSETS.alignX,
    alignY: WINDOW_CONFIGURE_CHILD_OFFSETS.alignY,
    reconfigureFlags: WINDOW_CONFIGURE_CHILD_OFFSETS.reconfigureFlags,
    parent: WINDOW_CONFIGURE_CHILD_OFFSETS.parent,
    firstChild: WINDOW_CONFIGURE_CHILD_OFFSETS.firstChild,
    nextSibling: WINDOW_CONFIGURE_CHILD_OFFSETS.nextSibling,
  }),
  callees: freeze({
    lock: WINDOW_CONFIGURE_CHILD_NATIVE_ADDRESSES.lock,
    unlock: WINDOW_CONFIGURE_CHILD_NATIVE_ADDRESSES.unlock,
    type1Ancestor: WINDOW_CONFIGURE_CHILD_NATIVE_ADDRESSES.type1Ancestor,
    reconfigureChildren: WINDOW_CONFIGURE_CHILD_NATIVE_ADDRESSES.reconfigureChildren,
  }),
  callbacks: freeze([
    'configurationChanged(object) through vtable +0x90',
    'resizeChild(child) at 0x1004eab0',
    'boundsUpdate(object) at 0x10051160 — x87 rect accumulate, leaf',
    'sortWindowLists(ancestor) at 0x10045140 — qsort, leaf',
    'safeDestroy(object) at 0x1004c0b0 — deferred destruction, leaf',
    'diagnostic(object, format) — fname/log pair, gated on globals',
  ]),
});

export class WindowConfigureChildNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, global = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowConfigureChildNativeBoundaryError';
    this.code = `WINDOW_CONFIGURE_CHILD_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.global = global;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowConfigureChildNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XWindow::ConfigureChild ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function required(value, name) {
  if (typeof value !== 'function') {
    fail(`XWindow::ConfigureChild requires ${name} service`, {
      kind: 'SERVICE', operation: name,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XWindow::ConfigureChild requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

function present(value) {
  return value !== null && value !== undefined && value !== 0;
}

function float32(value, name) {
  if (typeof value !== 'number') {
    fail(`XWindow::ConfigureChild requires numeric ${name}`, {
      kind: 'VALUE', value, operation: 'argument',
    });
  }
  return f(value);
}

function validatePointer(value, label, details = {}) {
  if (!present(value)) return value;
  if (typeof value === 'number' &&
      (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
    fail(`XWindow::ConfigureChild requires canonical ${label} pointer`, {
      kind: 'VALUE', value, ...details,
    });
  }
  if (typeof value !== 'number' && typeof value !== 'object' && typeof value !== 'function') {
    fail(`XWindow::ConfigureChild requires canonical ${label} pointer`, {
      kind: 'REFERENCE', value, ...details,
    });
  }
  return value;
}

function validateInteger(value, kind, label, details = {}) {
  if (!Number.isInteger(value)) {
    fail(`XWindow::ConfigureChild requires integer ${label}`, {
      kind: 'VALUE', value, ...details,
    });
  }
  if (kind === 'u8' && (value < 0 || value > 0xff)) {
    fail(`XWindow::ConfigureChild requires uint8 ${label}`, {
      kind: 'VALUE', value, ...details,
    });
  }
  if (kind === 'u32' && (value < 0 || value > 0xffffffff)) {
    fail(`XWindow::ConfigureChild requires uint32 ${label}`, {
      kind: 'VALUE', value, ...details,
    });
  }
  if (kind === 'i32' && (value < -0x80000000 || value > 0x7fffffff)) {
    fail(`XWindow::ConfigureChild requires int32 ${label}`, {
      kind: 'VALUE', value, ...details,
    });
  }
  return value;
}

function readRaw(object, offset, kind, services, phase) {
  const reader = required(services.read, 'read');
  const value = sync(reader(object, offset, kind, {
    native: WINDOW_CONFIGURE_CHILD_NATIVE.body,
    phase,
    object,
    offset,
    kind,
    width: kind === 'u8' ? 1 : 4,
  }), `read +0x${offset.toString(16)}`);
  if (value === undefined) {
    fail(`XWindow::ConfigureChild reached unresolved +0x${offset.toString(16)} field`, {
      kind: 'FIELD', value, object, offset, operation: phase,
    });
  }
  if (kind === 'ptr') return validatePointer(value, `+0x${offset.toString(16)}`, {
    object, offset, operation: phase,
  });
  if (kind === 'f32') {
    if (typeof value !== 'number') {
      fail(`XWindow::ConfigureChild requires float +0x${offset.toString(16)} field`, {
        kind: 'VALUE', value, object, offset, operation: phase,
      });
    }
    return f(value);
  }
  if (kind !== 'u8' && kind !== 'u32' && kind !== 'i32') {
    fail(`XWindow::ConfigureChild does not support raw read kind ${kind}`, {
      kind: 'VALUE', value: kind, object, offset, operation: phase,
    });
  }
  return kind === 'i32'
    ? validateInteger(value, kind, `+0x${offset.toString(16)}`, {object, offset, operation: phase})
    : validateInteger(value, kind, `+0x${offset.toString(16)}`, {object, offset, operation: phase}) >>> 0;
}

function writeRaw(object, offset, kind, value, services, phase) {
  const writer = required(services.write, 'write');
  let normalized = value;
  if (kind === 'ptr') {
    normalized = validatePointer(value, `+0x${offset.toString(16)}`, {
      object, offset, operation: phase,
    });
  } else if (kind === 'f32') {
    if (typeof value !== 'number') {
      fail(`XWindow::ConfigureChild requires float +0x${offset.toString(16)} value`, {
        kind: 'VALUE', value, object, offset, operation: phase,
      });
    }
    normalized = f(value);
  } else if (kind === 'u8' || kind === 'u32') {
    normalized = validateInteger(value, kind, `+0x${offset.toString(16)} value`, {
      object, offset, operation: phase,
    });
    if (kind === 'u32') normalized >>>= 0;
  } else {
    fail(`XWindow::ConfigureChild does not support raw write kind ${kind}`, {
      kind: 'VALUE', value: kind, object, offset, operation: phase,
    });
  }
  return sync(writer(object, offset, kind, normalized, {
    native: WINDOW_CONFIGURE_CHILD_NATIVE.body,
    phase,
    object,
    offset,
    kind,
    width: kind === 'u8' ? 1 : 4,
  }), `write +0x${offset.toString(16)}`);
}

function readGlobal(name, kind, services, phase) {
  const reader = required(services.readGlobal, 'readGlobal');
  const value = sync(reader(name, kind, {
    native: WINDOW_CONFIGURE_CHILD_NATIVE.body,
    phase,
    global: name,
    kind,
    address: WINDOW_CONFIGURE_CHILD_GLOBAL_ADDRESSES[name],
    width: 4,
  }), `read ${name}`);
  if (value === undefined) {
    fail(`XWindow::ConfigureChild reached unresolved ${name}`, {
      kind: 'GLOBAL', value, global: name, operation: phase,
    });
  }
  if (kind === 'ptr') return validatePointer(value, name, {global: name, operation: phase});
  return validateInteger(value, kind, name, {global: name, operation: phase});
}

function writeGlobal(name, kind, value, services, phase) {
  const writer = required(services.writeGlobal, 'writeGlobal');
  let normalized = value;
  if (kind === 'ptr') {
    normalized = validatePointer(value, name, {global: name, operation: phase});
  } else if (kind === 'i32' || kind === 'u32') {
    normalized = validateInteger(value, kind, name, {global: name, operation: phase});
    if (kind === 'u32') normalized >>>= 0;
  } else {
    fail(`XWindow::ConfigureChild does not support global write kind ${kind}`, {
      kind: 'VALUE', value: kind, global: name, operation: phase,
    });
  }
  return sync(writer(name, kind, normalized, {
    native: WINDOW_CONFIGURE_CHILD_NATIVE.body,
    phase,
    global: name,
    kind,
    address: WINDOW_CONFIGURE_CHILD_GLOBAL_ADDRESSES[name],
    width: 4,
  }), `write ${name}`);
}

function leaf(services, names, label, details) {
  const candidates = Array.isArray(names) ? names : [names];
  const callback = candidates.map(name => services[name]).find(value => typeof value === 'function');
  if (!callback) {
    fail(`XWindow::ConfigureChild requires ${candidates[0]} service`, {
      kind: 'SERVICE', operation: label,
    });
  }
  return sync(callback(details), label);
}

function x87C3Equal(left, right) {
  // fcom's C3 is also set for unordered values. Signed zero compares equal.
  return Number.isNaN(left) || Number.isNaN(right) || left === right;
}

/** The diagnostic prologue: a context/parent mismatch check followed by the
 * two signed counter gates, each emitting the fname+appMsgf pair as one
 * synchronous diagnostic leaf. */
function checkDiagnostics(object, parent, context, services) {
  const A = WINDOW_CONFIGURE_CHILD_NATIVE_ADDRESSES;
  const G = WINDOW_CONFIGURE_CHILD_GLOBALS;
  const emit = (global, value, formatAddress) => {
    const diagnostic = services.diagnostic ?? services.onDiagnostic;
    if (typeof diagnostic !== 'function') {
      fail('XWindow::ConfigureChild reached a diagnostic without a diagnostic service', {
        kind: 'DIAGNOSTIC', value, global, operation: 'diagnostic-check',
      });
    }
    sync(diagnostic({
      object,
      global,
      value,
      native: WINDOW_CONFIGURE_CHILD_NATIVE.body,
      formatAddress,
      line: A.diagnosticLine,
      nameIat: A.diagnosticFNameIat,
      logIat: A.diagnosticLogIat,
      errorIat: A.gErrorIat,
    }), `diagnostic ${global}`);
  };
  if (present(context) && context !== parent) {
    emit(G.context, context, A.diagnosticContextFormat);
  }
  for (const [name, formatAddress] of [
    [G.preferredSizeDepth, A.diagnosticPreferredSizeFormat],
    [G.granularityDepth, A.diagnosticGranularityFormat],
  ]) {
    const value = readGlobal(name, 'i32', services, 'diagnostic-check');
    if (value > 0) emit(name, value, formatAddress);
  }
}

/** XWindow lock at 0x1004c140: a plain +0x34 increment. */
function lockWindow(object, services) {
  const count = readRaw(object, WINDOW_CONFIGURE_CHILD_OFFSETS.lockCount, 'u32',
    services, 'lock');
  writeRaw(object, WINDOW_CONFIGURE_CHILD_OFFSETS.lockCount, 'u32',
    (count + 1) >>> 0, services, 'lock');
}

/** XWindow unlock at 0x1004c150: when +0x34 is positive, decrement it and
 * dispatch SafeDestroy (0x1004c0b0 leaf) when +0x30 bit 0x10 is set. */
function unlockWindow(object, services) {
  const O = WINDOW_CONFIGURE_CHILD_OFFSETS;
  const count = readRaw(object, O.lockCount, 'u32', services, 'unlock');
  // The native `jle` is a signed early return: a nonpositive count is left
  // untouched and the flags byte is not re-read.
  if ((count | 0) <= 0) return;
  writeRaw(object, O.lockCount, 'u32', (count - 1) >>> 0, services, 'unlock');
  const flags = readRaw(object, O.flags, 'u8', services, 'unlock');
  if ((flags & WINDOW_CONFIGURE_CHILD_BITS.beingDestroyed) !== 0) {
    leaf(services, 'safeDestroy', 'SafeDestroy', {
      object,
      native: WINDOW_CONFIGURE_CHILD_NATIVE_ADDRESSES.safeDestroy,
    });
  }
}

/** First ancestor-or-self at 0x1004c560 whose +0x28 type byte is >= 1. */
function type1Ancestor(object, services) {
  const O = WINDOW_CONFIGURE_CHILD_OFFSETS;
  const seen = new Set();
  let node = object;
  while (present(node)) {
    if (seen.has(node)) {
      fail('XWindow::ConfigureChild received a cyclic native parent chain', {
        kind: 'REFERENCE', value: node, object, operation: 'type1-ancestor',
      });
    }
    seen.add(node);
    const type = readRaw(node, O.type, 'u8', services, 'type1-ancestor');
    if (type >= 1) return node;
    node = readRaw(node, O.parent, 'ptr', services, 'type1-ancestor');
  }
  return null;
}

/** The 0x10050f90 body: mark every child's +0xb8 with the reconfiguring bit,
 * clear it again on visible children that carry an alignment byte, dispatch
 * the +0x90 configuration-changed virtual under the depth/context globals,
 * then ResizeChild each visible aligned child whose bit stayed clear. */
function reconfigureChildren(object, services) {
  const O = WINDOW_CONFIGURE_CHILD_OFFSETS;
  const B = WINDOW_CONFIGURE_CHILD_BITS;
  const G = WINDOW_CONFIGURE_CHILD_GLOBALS;
  const A = WINDOW_CONFIGURE_CHILD_NATIVE_ADDRESSES;
  const phase = 'reconfigure-children';
  const seen = new Set();
  // First pass: +0xb8 |= 4 for every child, then &= ~4 when the child is
  // visible and carries +0x88 or +0x89.
  let child = readRaw(object, O.firstChild, 'ptr', services, phase);
  while (present(child)) {
    if (seen.has(child)) {
      fail('XWindow::ConfigureChild received a cyclic native child chain', {
        kind: 'REFERENCE', value: child, object, operation: phase,
      });
    }
    seen.add(child);
    const flags = readRaw(child, O.reconfigureFlags, 'u32', services, phase);
    const visibility = readRaw(child, O.flags, 'u8', services, phase);
    writeRaw(child, O.reconfigureFlags, 'u32',
      (flags | B.reconfiguring) >>> 0, services, phase);
    if ((visibility & B.visible) !== 0) {
      let align = readRaw(child, O.alignX, 'u8', services, phase);
      if (align === 0) align = readRaw(child, O.alignY, 'u8', services, phase);
      if (align !== 0) {
        const reread = readRaw(child, O.reconfigureFlags, 'u32', services, phase);
        writeRaw(child, O.reconfigureFlags, 'u32',
          (reread & ~B.reconfiguring) >>> 0, services, phase);
      }
    }
    child = readRaw(child, O.nextSibling, 'ptr', services, phase);
  }
  // The +0x90 virtual runs with the context pointing at this window and the
  // shared reconfiguration depth incremented.
  const depth = readGlobal(G.reconfigurationDepth, 'i32', services, phase);
  const savedContext = readGlobal(G.context, 'ptr', services, phase);
  writeGlobal(G.context, 'ptr', object, services, phase);
  writeGlobal(G.reconfigurationDepth, 'i32', (depth + 1) | 0, services, phase);
  leaf(services, ['configurationChanged', 'rootConfigurationChanged'],
    'ConfigurationChanged', {
      object,
      virtualSlot: A.configurationChangedSlot,
      native: A.reconfigureChildren,
    });
  const depthAfter = readGlobal(G.reconfigurationDepth, 'i32', services, phase);
  writeGlobal(G.context, 'ptr', savedContext, services, phase);
  writeGlobal(G.reconfigurationDepth, 'i32', (depthAfter - 1) | 0, services, phase);
  // Second pass: visible, aligned children whose reconfiguring bit is clear
  // get ResizeChild under the same context swap.
  seen.clear();
  child = readRaw(object, O.firstChild, 'ptr', services, phase);
  while (present(child)) {
    if (seen.has(child)) {
      fail('XWindow::ConfigureChild received a cyclic native child chain', {
        kind: 'REFERENCE', value: child, object, operation: phase,
      });
    }
    seen.add(child);
    const visibility = readRaw(child, O.flags, 'u8', services, phase);
    if ((visibility & B.visible) !== 0) {
      let align = readRaw(child, O.alignX, 'u8', services, phase);
      if (align === 0) align = readRaw(child, O.alignY, 'u8', services, phase);
      if (align !== 0) {
        const flags = readRaw(child, O.reconfigureFlags, 'u8', services, phase);
        if ((flags & B.reconfiguring) === 0) {
          writeGlobal(G.context, 'ptr', object, services, phase);
          leaf(services, 'resizeChild', 'ResizeChild', {
            object: child,
            parent: object,
            native: A.resizeChild,
          });
          writeGlobal(G.context, 'ptr', savedContext, services, phase);
        }
      }
    }
    child = readRaw(child, O.nextSibling, 'ptr', services, phase);
  }
}

/**
 * Execute the original void XWindow::ConfigureChild body.
 *
 * `object` is the canonical XWindow receiver; the four arguments are the
 * marshalled floats.  `services.read`/`services.write` expose raw window
 * storage and `services.readGlobal`/`services.writeGlobal` the native
 * globals; the leaf services are listed in WINDOW_CONFIGURE_CHILD_NATIVE_CONTRACT.
 */
export function configureChildNative(object, newX, newY, newWidth, newHeight, services = {}) {
  objectReference(object, 'window');
  const x = float32(newX, 'newX');
  const y = float32(newY, 'newY');
  const width = float32(newWidth, 'newWidth');
  const height = float32(newHeight, 'NewHeight');
  const O = WINDOW_CONFIGURE_CHILD_OFFSETS;
  const B = WINDOW_CONFIGURE_CHILD_BITS;
  const G = WINDOW_CONFIGURE_CHILD_GLOBALS;
  const A = WINDOW_CONFIGURE_CHILD_NATIVE_ADDRESSES;

  const context = readGlobal(G.context, 'ptr', services, 'diagnostic-check');
  const parent = readRaw(object, O.parent, 'ptr', services, 'diagnostic-check');
  checkDiagnostics(object, parent, context, services);

  lockWindow(object, services);
  const depth = readGlobal(G.configureDepth, 'i32', services, 'configure-enter');
  const enteredDepth = (depth + 1) | 0;
  writeGlobal(G.configureDepth, 'i32', enteredDepth, services, 'configure-enter');
  const flagsDword = readRaw(object, O.reconfigureFlags, 'u32', services, 'flags-or');
  const visibility = readRaw(object, O.flags, 'u8', services, 'flags-or');
  const marked = (flagsDword | B.reconfiguring) >>> 0;
  writeRaw(object, O.reconfigureFlags, 'u32', marked, services, 'flags-or');

  if ((visibility & B.visible) !== 0) {
    let changed = false;
    const oldWidth = readRaw(object, O.width, 'f32', services, 'size-compare');
    if (!x87C3Equal(oldWidth, width)) {
      changed = true;
    } else {
      const oldHeight = readRaw(object, O.height, 'f32', services, 'size-compare');
      if (!x87C3Equal(oldHeight, height)) {
        changed = true;
      } else if ((marked & B.pendingReconfigure) !== 0) {
        changed = true;
      }
    }
    writeRaw(object, O.reconfigureFlags, 'u32', (marked & ~1) >>> 0,
      services, 'flags-clear');
    writeRaw(object, O.x, 'f32', x, services, 'geometry-store');
    writeRaw(object, O.y, 'f32', y, services, 'geometry-store');
    writeRaw(object, O.width, 'f32', width, services, 'geometry-store');
    writeRaw(object, O.height, 'f32', height, services, 'geometry-store');
    if (changed) {
      reconfigureChildren(object, services);
    }
    // The native re-reads the depth global after reconfigureChildren and only
    // touches +0x28 when the depth is no longer 1.
    if (readGlobal(G.configureDepth, 'i32', services, 'bounds-gate') === 1 ||
        readRaw(object, O.type, 'u8', services, 'bounds-gate') >= 1) {
      leaf(services, 'boundsUpdate', 'BoundsUpdate', {
        object,
        native: A.boundsUpdate,
      });
      const ancestor = type1Ancestor(object, services);
      if (present(ancestor)) {
        leaf(services, 'sortWindowLists', 'SortWindowLists', {
          object: ancestor,
          child: object,
          native: A.sortWindowLists,
        });
      }
    }
  }

  const depthLeave = readGlobal(G.configureDepth, 'i32', services, 'configure-leave');
  writeGlobal(G.configureDepth, 'i32', (depthLeave - 1) | 0, services, 'configure-leave');
  unlockWindow(object, services);
}

export const windowConfigureChildNative = configureChildNative;
export const configureChildWindowNative = configureChildNative;
