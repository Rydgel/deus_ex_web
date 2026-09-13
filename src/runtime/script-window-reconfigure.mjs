/**
 * Execute the recovered Extension XWindow::AskParentForReconfigure body.
 *
 * Raw window storage and the four native globals are deliberately exposed as
 * synchronous host services.  Child/parent callbacks, root configuration and
 * ResizeChild remain explicit leaves; this module does not invent their UI
 * graph or callback bodies.
 *
 * Evidence: Extension.dll (installed SHA-256 below), body 0x1004e060 through
 * 0x1004e1f2, and docs/script-window-reconfigure.md.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_RECONFIGURE_NATIVE = freeze({
  package: 'Extension',
  function: 'XWindow::AskParentForReconfigure',
  packageExport: 1958,
  nativeIndex: 1460,
  functionFlags: 0x401,
  serialSize: 27,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  body: 0x1004e060,
  end: 0x1004e1f3,
  bodySha256: '7791f4adbeeea7faba7bc42c8e13755d249a21b12edcec30d47f66f85d379191',
});

export const WINDOW_RECONFIGURE_NATIVE_ADDRESSES = freeze({
  body: WINDOW_RECONFIGURE_NATIVE.body,
  end: WINDOW_RECONFIGURE_NATIVE.end,
  registrationCell: 0x1009902c,
  resizeChild: 0x1004eab0,
  parentRequestedReconfigurationSlot: 0x88,
  configurationChangedSlot: 0x90,
  diagnosticFNameIat: 0x10059180,
  diagnosticLogIat: 0x100591a8,
  gErrorIat: 0x100590b4,
  diagnosticLine: 0x2ff,
  diagnosticReconfigurationFormat: 0x10099230,
  diagnosticPreferredSizeFormat: 0x10099198,
  diagnosticGranularityFormat: 0x1009910c,
});

/** Numeric byte offsets in the native XWindow object. */
export const WINDOW_RECONFIGURE_OFFSETS = freeze({
  visibility: 0x30,
  reconfigureFlags: 0xb8,
  parent: 0x138,
});

export const WINDOW_RECONFIGURE_FIELDS = WINDOW_RECONFIGURE_OFFSETS;

/** The low bit is tested in +0x30 and +0xb8 by the original body. */
export const WINDOW_RECONFIGURE_BITS = freeze({
  visibilityChain: 0x01,
  reconfigure: 0x01,
  initialize: 0x03,
});

/** Global names are stable host keys; their original preferred addresses are
 * retained separately so adapters can bind real image storage explicitly. */
export const WINDOW_RECONFIGURE_GLOBALS = freeze({
  reconfigurationDepth: 'global100aeb00',
  preferredSizeDepth: 'global100aeb04',
  granularityDepth: 'global100aeb08',
  context: 'global100aeafc',
});

export const WINDOW_RECONFIGURE_GLOBAL_ADDRESSES = freeze({
  [WINDOW_RECONFIGURE_GLOBALS.reconfigurationDepth]: 0x100aeb00,
  [WINDOW_RECONFIGURE_GLOBALS.preferredSizeDepth]: 0x100aeb04,
  [WINDOW_RECONFIGURE_GLOBALS.granularityDepth]: 0x100aeb08,
  [WINDOW_RECONFIGURE_GLOBALS.context]: 0x100aeafc,
});

export const WINDOW_RECONFIGURE_NATIVE_CONTRACT = freeze({
  name: 'XWindow::AskParentForReconfigure',
  address: WINDOW_RECONFIGURE_NATIVE.body,
  arguments: freeze([]),
  returns: 'void',
  rawStorage: 'read(object, offset, kind, details) / write(object, offset, kind, value, details)',
  globals: 'readGlobal(name, kind, details) / writeGlobal(name, kind, value, details)',
  fields: freeze({
    visibility: WINDOW_RECONFIGURE_OFFSETS.visibility,
    reconfigureFlags: WINDOW_RECONFIGURE_OFFSETS.reconfigureFlags,
    parent: WINDOW_RECONFIGURE_OFFSETS.parent,
  }),
  callbacks: freeze([
    'parentRequestedReconfiguration(parent, child) through vtable +0x88',
    'configurationChanged(object) through vtable +0x90',
    'ResizeChild(object) at 0x1004eab0',
  ]),
  diagnostics: freeze([
    WINDOW_RECONFIGURE_GLOBALS.reconfigurationDepth,
    WINDOW_RECONFIGURE_GLOBALS.preferredSizeDepth,
    WINDOW_RECONFIGURE_GLOBALS.granularityDepth,
  ]),
});

export class WindowReconfigureNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, global = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowReconfigureNativeBoundaryError';
    this.code = `WINDOW_RECONFIGURE_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.global = global;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowReconfigureNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XWindow::AskParentForReconfigure ${label} service suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function required(value, name) {
  if (typeof value !== 'function') {
    fail(`XWindow::AskParentForReconfigure requires ${name} service`, {
      kind: 'SERVICE', operation: name,
    });
  }
  return value;
}

function objectReference(value, name, {allowNull = false} = {}) {
  if (allowNull && (value === null || value === 0)) return value;
  if (value === null || value === undefined || value === 0 ||
      (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'number')) {
    fail(`XWindow::AskParentForReconfigure requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  if (typeof value === 'number' &&
      (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
    fail(`XWindow::AskParentForReconfigure requires uint32 ${name} pointer`, {
      kind: 'VALUE', value, operation: name,
    });
  }
  return value;
}

function present(value) {
  return value !== null && value !== undefined && value !== 0;
}

function validatePointer(value, label, details = {}) {
  if (!present(value)) return value;
  if (typeof value === 'number' &&
      (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
    fail(`XWindow::AskParentForReconfigure requires canonical ${label} pointer`, {
      kind: 'VALUE', value, ...details,
    });
  }
  if (typeof value !== 'number' && typeof value !== 'object' && typeof value !== 'function') {
    fail(`XWindow::AskParentForReconfigure requires canonical ${label} pointer`, {
      kind: 'REFERENCE', value, ...details,
    });
  }
  return value;
}

function validateInteger(value, kind, label, details = {}) {
  if (!Number.isInteger(value)) {
    fail(`XWindow::AskParentForReconfigure requires integer ${label}`, {
      kind: 'VALUE', value, ...details,
    });
  }
  if (kind === 'u8' && (value < 0 || value > 0xff)) {
    fail(`XWindow::AskParentForReconfigure requires uint8 ${label}`, {
      kind: 'VALUE', value, ...details,
    });
  }
  if (kind === 'u32' && (value < 0 || value > 0xffffffff)) {
    fail(`XWindow::AskParentForReconfigure requires uint32 ${label}`, {
      kind: 'VALUE', value, ...details,
    });
  }
  if (kind === 'i32' && (value < -0x80000000 || value > 0x7fffffff)) {
    fail(`XWindow::AskParentForReconfigure requires int32 ${label}`, {
      kind: 'VALUE', value, ...details,
    });
  }
  return value;
}

function readRaw(object, offset, kind, services, phase) {
  const reader = required(services.read, 'read');
  const value = sync(reader(object, offset, kind, {
    native: WINDOW_RECONFIGURE_NATIVE.body,
    phase,
    object,
    offset,
    kind,
    width: kind === 'u8' ? 1 : 4,
  }), `read +0x${offset.toString(16)}`);
  if (value === undefined) {
    fail(`XWindow::AskParentForReconfigure reached unresolved +0x${offset.toString(16)} field`, {
      kind: 'FIELD', value, object, offset, operation: phase,
    });
  }
  if (kind === 'ptr') return validatePointer(value, `+0x${offset.toString(16)}`, {
    object, offset, operation: phase,
  });
  if (kind !== 'u8' && kind !== 'u32') {
    fail(`XWindow::AskParentForReconfigure does not support raw read kind ${kind}`, {
      kind: 'VALUE', value: kind, object, offset, operation: phase,
    });
  }
  return validateInteger(value, kind, `+0x${offset.toString(16)}`, {
    object, offset, operation: phase,
  }) >>> 0;
}

function writeRaw(object, offset, kind, value, services, phase) {
  const writer = required(services.write, 'write');
  let normalized = value;
  if (kind === 'ptr') {
    normalized = validatePointer(value, `+0x${offset.toString(16)}`, {
      object, offset, operation: phase,
    });
  } else if (kind === 'u8' || kind === 'u32') {
    normalized = validateInteger(value, kind, `+0x${offset.toString(16)}`, {
      object, offset, operation: phase,
    });
    if (kind === 'u32') normalized >>>= 0;
  } else {
    fail(`XWindow::AskParentForReconfigure does not support raw write kind ${kind}`, {
      kind: 'VALUE', value: kind, object, offset, operation: phase,
    });
  }
  return sync(writer(object, offset, kind, normalized, {
    native: WINDOW_RECONFIGURE_NATIVE.body,
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
    native: WINDOW_RECONFIGURE_NATIVE.body,
    phase,
    global: name,
    kind,
    address: WINDOW_RECONFIGURE_GLOBAL_ADDRESSES[name],
    width: 4,
  }), `read ${name}`);
  if (value === undefined) {
    fail(`XWindow::AskParentForReconfigure reached unresolved ${name}`, {
      kind: 'GLOBAL', value, global: name, operation: phase,
    });
  }
  if (kind === 'ptr') return validatePointer(value, name, {global: name, operation: phase});
  if (kind !== 'i32' && kind !== 'u32') {
    fail(`XWindow::AskParentForReconfigure does not support global read kind ${kind}`, {
      kind: 'VALUE', value: kind, global: name, operation: phase,
    });
  }
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
    fail(`XWindow::AskParentForReconfigure does not support global write kind ${kind}`, {
      kind: 'VALUE', value: kind, global: name, operation: phase,
    });
  }
  return sync(writer(name, kind, normalized, {
    native: WINDOW_RECONFIGURE_NATIVE.body,
    phase,
    global: name,
    kind,
    address: WINDOW_RECONFIGURE_GLOBAL_ADDRESSES[name],
    width: 4,
  }), `write ${name}`);
}

function leaf(services, names, label, details) {
  const candidates = Array.isArray(names) ? names : [names];
  const callback = candidates.map(name => services[name]).find(value => typeof value === 'function');
  if (!callback) {
    fail(`XWindow::AskParentForReconfigure requires ${candidates[0]} service`, {
      kind: 'SERVICE', operation: label,
    });
  }
  return sync(callback(details), label);
}

function parentResult(value) {
  if (value === false || value === null || value === 0) return false;
  if (value === true) return true;
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail('XWindow::AskParentForReconfigure parent callback returned an unresolved native result', {
      kind: 'BOUNDARY', value, operation: 'ChildRequestedReconfiguration',
    });
  }
  return value !== 0;
}

function checkDiagnostics(services) {
  const counters = [
    [WINDOW_RECONFIGURE_GLOBALS.reconfigurationDepth,
      WINDOW_RECONFIGURE_NATIVE_ADDRESSES.diagnosticReconfigurationFormat],
    [WINDOW_RECONFIGURE_GLOBALS.preferredSizeDepth,
      WINDOW_RECONFIGURE_NATIVE_ADDRESSES.diagnosticPreferredSizeFormat],
    [WINDOW_RECONFIGURE_GLOBALS.granularityDepth,
      WINDOW_RECONFIGURE_NATIVE_ADDRESSES.diagnosticGranularityFormat],
  ];
  for (const [name, formatAddress] of counters) {
    const value = readGlobal(name, 'i32', services, 'diagnostic-check');
    // Native `jle` treats these globals as signed counters.
    if (value <= 0) continue;
    const diagnostic = services.diagnostic ?? services.onDiagnostic;
    if (typeof diagnostic !== 'function') {
      fail(`XWindow::AskParentForReconfigure reached positive ${name} without a diagnostic service`, {
        kind: 'DIAGNOSTIC', value, global: name, operation: 'diagnostic-check',
      });
    }
    sync(diagnostic({
      global: name,
      value,
      native: WINDOW_RECONFIGURE_NATIVE.body,
      formatAddress,
      line: WINDOW_RECONFIGURE_NATIVE_ADDRESSES.diagnosticLine,
    }), `diagnostic ${name}`);
  }
}

function askParentForReconfigureBody(object, services) {
  const O = WINDOW_RECONFIGURE_OFFSETS;
  const B = WINDOW_RECONFIGURE_BITS;
  const seen = new Set();

  // Recursive native calls re-enter the same diagnostic prologue.
  checkDiagnostics(services);

  const flags = readRaw(object, O.reconfigureFlags, 'u32', services, 'flags-or');
  writeRaw(object, O.reconfigureFlags, 'u32', (flags | B.initialize) >>> 0,
    services, 'flags-or');

  let current = object;
  while (present(current)) {
    if (seen.has(current)) {
      fail('XWindow::AskParentForReconfigure received a cyclic native parent/visibility chain', {
        kind: 'REFERENCE', value: current, object, operation: 'visibility-walk',
      });
    }
    seen.add(current);
    const visibility = readRaw(current, O.visibility, 'u8', services, 'visibility-walk');
    if ((visibility & B.visibilityChain) === 0) break;
    current = readRaw(current, O.parent, 'ptr', services, 'visibility-walk');
  }

  // A non-null stop is the ordinary hidden-chain early return.
  if (present(current)) return;

  const parent = readRaw(object, O.parent, 'ptr', services, 'parent-selection');
  if (!present(parent)) {
    const rootFlags = readRaw(object, O.reconfigureFlags, 'u32', services, 'root-clear');
    writeRaw(object, O.reconfigureFlags, 'u32', (rootFlags & ~B.reconfigure) >>> 0,
      services, 'root-clear');

    // The original instruction order reads the counter before saving context.
    const depth = readGlobal(WINDOW_RECONFIGURE_GLOBALS.reconfigurationDepth,
      'i32', services, 'root-enter');
    const savedContext = readGlobal(WINDOW_RECONFIGURE_GLOBALS.context,
      'ptr', services, 'root-enter');
    writeGlobal(WINDOW_RECONFIGURE_GLOBALS.context, 'ptr', object,
      services, 'root-enter');
    writeGlobal(WINDOW_RECONFIGURE_GLOBALS.reconfigurationDepth, 'i32',
      (depth + 1) | 0, services, 'root-enter');
    leaf(services, ['configurationChanged', 'rootConfigurationChanged'],
      'ConfigurationChanged', {
        object,
        virtualSlot: WINDOW_RECONFIGURE_NATIVE_ADDRESSES.configurationChangedSlot,
        native: WINDOW_RECONFIGURE_NATIVE.body,
      });
    const depthAfter = readGlobal(WINDOW_RECONFIGURE_GLOBALS.reconfigurationDepth,
      'i32', services, 'root-leave');
    writeGlobal(WINDOW_RECONFIGURE_GLOBALS.reconfigurationDepth, 'i32',
      (depthAfter - 1) | 0, services, 'root-leave');
    writeGlobal(WINDOW_RECONFIGURE_GLOBALS.context, 'ptr', savedContext,
      services, 'root-leave');
    return;
  }

  const savedParentContext = readGlobal(WINDOW_RECONFIGURE_GLOBALS.context,
    'ptr', services, 'parent-callback-enter');
  writeGlobal(WINDOW_RECONFIGURE_GLOBALS.context, 'ptr', parent,
    services, 'parent-callback-enter');
  const callbackParent = readRaw(object, O.parent, 'ptr', services,
    'parent-callback-receiver');
  if (!present(callbackParent)) {
    fail('XWindow::AskParentForReconfigure parent link disappeared before virtual +0x88', {
      kind: 'REFERENCE', value: callbackParent, object, operation: 'parent-callback',
    });
  }
  const handled = parentResult(leaf(services,
    ['parentRequestedReconfiguration', 'childRequestedReconfiguration'],
    'ChildRequestedReconfiguration', {
      parent: callbackParent,
      child: object,
      object,
      virtualSlot: WINDOW_RECONFIGURE_NATIVE_ADDRESSES.parentRequestedReconfigurationSlot,
      native: WINDOW_RECONFIGURE_NATIVE.body,
    }));
  writeGlobal(WINDOW_RECONFIGURE_GLOBALS.context, 'ptr', savedParentContext,
    services, 'parent-callback-leave');

  if (!handled) {
    const recurseParent = readRaw(object, O.parent, 'ptr', services, 'recursive-parent');
    if (!present(recurseParent)) {
      fail('XWindow::AskParentForReconfigure recursive parent became null', {
        kind: 'REFERENCE', value: recurseParent, object, operation: 'recursive-parent',
      });
    }
    // The native recursive call starts a new visibility walk.  A parent
    // already visited by the child's walk is therefore a valid receiver.
    askParentForReconfigureBody(objectReference(recurseParent, 'parent'), services);
  }

  const resizeParent = readRaw(object, O.parent, 'ptr', services, 'resize-context-enter');
  const savedResizeContext = readGlobal(WINDOW_RECONFIGURE_GLOBALS.context,
    'ptr', services, 'resize-context-enter');
  writeGlobal(WINDOW_RECONFIGURE_GLOBALS.context, 'ptr', resizeParent,
    services, 'resize-context-enter');
  const resizeFlags = readRaw(object, O.reconfigureFlags, 'u8', services, 'resize-check');
  if ((resizeFlags & B.reconfigure) !== 0) {
    leaf(services, 'resizeChild', 'ResizeChild', {
      object,
      native: WINDOW_RECONFIGURE_NATIVE_ADDRESSES.resizeChild,
    });
  }
  writeGlobal(WINDOW_RECONFIGURE_GLOBALS.context, 'ptr', savedResizeContext,
    services, 'resize-context-leave');
}

/**
 * Execute the original void XWindow::AskParentForReconfigure body.
 *
 * `object` is the canonical XWindow receiver.  `services.read` and
 * `services.write` have the signatures `read(object, offset, kind, details)`
 * and `write(object, offset, kind, value, details)`.  Global storage is kept
 * explicit through `readGlobal(name, kind, details)` and
 * `writeGlobal(name, kind, value, details)`.  All leaves are synchronous.
 */
export function askParentForReconfigureNative(object, services = {}) {
  objectReference(object, 'window');
  askParentForReconfigureBody(object, services);
}

export const reconfigureWindowNative = askParentForReconfigureNative;
export const askParentReconfigureNative = askParentForReconfigureNative;
