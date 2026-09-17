/**
 * Recovered Extension.dll XButtonWindow::EnableAutoRepeat translation.
 *
 * The registered exec body evaluates three arguments — bool bEnable (script
 * default true), float initialDelay (default 0.5f from global 0x10059df8),
 * float repeatRate (default 0.1f from global 0x10059dfc) — and tail-calls the
 * method at 0x10007aa0, which:
 *   +0x174 = (+0x174 & ~0x04) | ((bEnable & 1) << 2)
 *   +0x17c = initialDelay   (f32)
 *   +0x180 = repeatRate     (f32)
 * No reconfigure call.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * exec body 0x10008ad0 through 0x10008b70,
 * method body 0x10007aa0 through 0x10007ad2.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_ENABLE_AUTO_REPEAT_NATIVE = freeze({
  package: 'Extension',
  function: 'ButtonWindow.EnableAutoRepeat / XButtonWindow::EnableAutoRepeat',
  packageExport: 1060,
  nativeIndex: 1595,
  functionFlags: 0x401,
  serialSize: 37,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x10008ad0,
  execEnd: 0x10008b70,
  execSha256: '446dd678fba64fbdf0ab5d12ddaf353364d890a343ceab06c5fb5da8a86bcf53',
  methodBody: 0x10007aa0,
  methodEnd: 0x10007ad2,
  methodSha256: 'b6cad920cbe9e6c26f9cf5981be982f47360a9d19cadcef2959a20203e25a542',
});

export const WINDOW_ENABLE_AUTO_REPEAT_ADDRESSES = freeze({
  body: WINDOW_ENABLE_AUTO_REPEAT_NATIVE.methodBody,
  end: WINDOW_ENABLE_AUTO_REPEAT_NATIVE.methodEnd,
});

/** Numeric byte offsets in the native XButtonWindow object. */
export const WINDOW_ENABLE_AUTO_REPEAT_OFFSETS = freeze({
  buttonFlags: 0x174,
  initialDelay: 0x17c,
  repeatRate: 0x180,
});

export const WINDOW_ENABLE_AUTO_REPEAT_FIELDS =
  WINDOW_ENABLE_AUTO_REPEAT_OFFSETS;

/** Bit 2 of +0x174 is the auto-repeat enable flag. */
export const WINDOW_ENABLE_AUTO_REPEAT_BITS = freeze({
  autoRepeat: 0x04,
});

export const WINDOW_ENABLE_AUTO_REPEAT_NATIVE_CONTRACT = freeze({
  name: 'XButtonWindow::EnableAutoRepeat',
  address: WINDOW_ENABLE_AUTO_REPEAT_NATIVE.methodBody,
  arguments: freeze(['bEnable:bool', 'initialDelay:float', 'repeatRate:float']),
  returns: 'void',
  rawStorage: 'read/write(object, offset, kind, ..., details)',
  fields: freeze({...WINDOW_ENABLE_AUTO_REPEAT_OFFSETS}),
  callbacks: freeze([]),
});

export class WindowEnableAutoRepeatNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowEnableAutoRepeatNativeBoundaryError';
    this.code = `WINDOW_ENABLE_AUTO_REPEAT_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowEnableAutoRepeatNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XButtonWindow::EnableAutoRepeat ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XButtonWindow::EnableAutoRepeat requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

/**
 * Execute the original method body:
 *   +0x174 = (+0x174 & ~0x04) | ((bEnable & 1) << 2)
 *   +0x17c = initialDelay, +0x180 = repeatRate  (f32 stores)
 */
export function enableAutoRepeatNative(
  object, bEnable, initialDelay, repeatRate, services = {}) {
  objectReference(object, 'window');
  const reader = services.read;
  const writer = services.write;
  if (typeof reader !== 'function' || typeof writer !== 'function') {
    fail('XButtonWindow::EnableAutoRepeat requires read/write services', {
      kind: 'SERVICE',
      offset: WINDOW_ENABLE_AUTO_REPEAT_OFFSETS.buttonFlags,
      operation: 'auto-repeat-update',
    });
  }
  const flagsOffset = WINDOW_ENABLE_AUTO_REPEAT_OFFSETS.buttonFlags;
  const flags = sync(reader(object, flagsOffset, 'u32', {
    native: WINDOW_ENABLE_AUTO_REPEAT_NATIVE.methodBody,
    phase: 'button-flags-read', object, offset: flagsOffset,
    kind: 'u32', width: 4,
  }), 'read +0x174');
  if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff) {
    fail('XButtonWindow::EnableAutoRepeat requires uint32 +0x174 field', {
      kind: 'VALUE', value: flags, object, offset: flagsOffset,
      operation: 'button-flags-read',
    });
  }
  const bit = WINDOW_ENABLE_AUTO_REPEAT_BITS.autoRepeat;
  const word = ((flags & ~bit) | ((Number(bEnable) & 1) * bit)) >>> 0;
  const F = WINDOW_ENABLE_AUTO_REPEAT_OFFSETS;
  sync(writer(object, flagsOffset, 'u32', word, {
    native: WINDOW_ENABLE_AUTO_REPEAT_NATIVE.methodBody,
    phase: 'button-flags-write', object, offset: flagsOffset,
    kind: 'u32', width: 4,
  }), 'write +0x174');
  sync(writer(object, F.initialDelay, 'f32', initialDelay, {
    native: WINDOW_ENABLE_AUTO_REPEAT_NATIVE.methodBody,
    phase: 'initial-delay-store', object, offset: F.initialDelay,
    kind: 'f32', width: 4,
  }), 'write +0x17c');
  sync(writer(object, F.repeatRate, 'f32', repeatRate, {
    native: WINDOW_ENABLE_AUTO_REPEAT_NATIVE.methodBody,
    phase: 'repeat-rate-store', object, offset: F.repeatRate,
    kind: 'f32', width: 4,
  }), 'write +0x180');
}

export const windowEnableAutoRepeatNative = enableAutoRepeatNative;
export const buttonWindowEnableAutoRepeatNative = enableAutoRepeatNative;
