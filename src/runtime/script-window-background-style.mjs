/**
 * Recovered Extension.dll Window.SetBackgroundStyle/XGC::SetStyle
 * translation.
 *
 * SetBackgroundStyle stores the low byte at Window+0x3c, reads the XGC
 * pointer at Window+0x130, and calls XGC::SetStyle when that pointer is
 * non-null.  SetStyle first reads XGC+0x48, stores the byte at XGC+0x44,
 * then performs the original low-byte flag mutations.  GeneratePolyFlags is
 * retained as an explicit synchronous host leaf for every nonzero style.
 * See docs/script-window-background-style.md.
 */

const freeze = value => Object.freeze(value);

const EXTENSION_HASH =
  '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c';

export const WINDOW_BACKGROUND_STYLE_NATIVE = freeze({
  package: 'Extension',
  function: 'Window.SetBackgroundStyle',
  packageExport: 2107,
  nativeIndex: 1422,
  functionFlags: 0x401,
  serialSize: 31,
  scriptSize: 5,
  dll: 'Extension.dll',
  dllSha256: EXTENSION_HASH,
  imageBase: 0x10000000,
  execBody: 0x10051d50,
  execEnd: 0x10051d93,
  execSha256: 'f14b3bef26df5eb1eeb0599a7d56218a3a98800ab5a1930740ae0091e58c3bee',
  setBackgroundStyleBody: 0x1004d670,
  setBackgroundStyleEnd: 0x1004d6c1,
  setBackgroundStyleSha256: 'dc0d596232cb8806176aa9f9bb90d4ede0b5c91bb8937e9b6e1aedd981a0d1ed',
  setStyleBody: 0x10027170,
  setStyleEnd: 0x1002724b,
  setStyleSha256: '2a8943910efa1a2bdd39f38f4bd791cbc37b168fbd72068c7057578d47be89c2',
});

export const WINDOW_BACKGROUND_STYLE_NATIVE_ADDRESSES = freeze({
  exec: WINDOW_BACKGROUND_STYLE_NATIVE.execBody,
  execEnd: WINDOW_BACKGROUND_STYLE_NATIVE.execEnd,
  setBackgroundStyle: WINDOW_BACKGROUND_STYLE_NATIVE.setBackgroundStyleBody,
  setBackgroundStyleEnd: WINDOW_BACKGROUND_STYLE_NATIVE.setBackgroundStyleEnd,
  setStyle: WINDOW_BACKGROUND_STYLE_NATIVE.setStyleBody,
  setStyleEnd: WINDOW_BACKGROUND_STYLE_NATIVE.setStyleEnd,
  generatePolyFlags: 0x1002af00,
});

export const WINDOW_BACKGROUND_STYLE_OFFSETS = freeze({
  backgroundStyle: 0x3c,
  gc: 0x130,
});

export const GC_STYLE_OFFSETS = freeze({
  style: 0x44,
  flags: 0x48,
});

export const WINDOW_BACKGROUND_STYLE_FIELDS = WINDOW_BACKGROUND_STYLE_OFFSETS;

export const WINDOW_BACKGROUND_STYLE_BITS = freeze({
  styleEnable: 0x02,
  style2: 0x04,
  style3: 0x08,
  style4: 0x10,
  styleMask: 0x1c,
});

export const WINDOW_BACKGROUND_STYLE_NATIVE_CONTRACT = freeze({
  name: 'Window.SetBackgroundStyle -> XGC::SetStyle',
  address: WINDOW_BACKGROUND_STYLE_NATIVE.setBackgroundStyleBody,
  arguments: freeze(['Window* this', 'byte NewStyle']),
  returns: 'void',
  windowFields: freeze({
    backgroundStyle: WINDOW_BACKGROUND_STYLE_OFFSETS.backgroundStyle,
    gc: WINDOW_BACKGROUND_STYLE_OFFSETS.gc,
  }),
  gcFields: freeze({
    style: GC_STYLE_OFFSETS.style,
    flags: GC_STYLE_OFFSETS.flags,
  }),
  order: freeze([
    'write Window+0x3c low byte NewStyle',
    'read Window+0x130 XGC pointer',
    'if non-null read XGC+0x48 flags',
    'write XGC+0x44 low byte NewStyle',
    'style 0: write XGC+0x48 with flags & ~0x02 and return',
    'nonzero: write XGC+0x48 with flags | 0x02',
    'style 2: write (flags & ~0x18) | 0x04',
    'style 3: write (flags & ~0x14) | 0x08',
    'style 4: write (flags & ~0x0c) | 0x10',
    'other nonzero: write flags & ~0x1c',
    'nonzero: GeneratePolyFlags()',
  ]),
});

export class WindowBackgroundStyleNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowBackgroundStyleNativeBoundaryError';
    this.code = `WINDOW_BACKGROUND_STYLE_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowBackgroundStyleNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`Window.SetBackgroundStyle ${label} service suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function required(value, name) {
  if (typeof value !== 'function') {
    fail(`Window.SetBackgroundStyle requires ${name} service`, {
      kind: 'SERVICE', operation: name,
    });
  }
  return value;
}

function objectReference(value, name, {allowNull = false} = {}) {
  if (allowNull && (value === null || value === undefined || value === 0)) return value;
  if (value === null || value === undefined || value === 0 ||
      (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'number')) {
    fail(`Window.SetBackgroundStyle requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  if (typeof value === 'number' &&
      (!Number.isInteger(value) || value < 0 || value > 0xffffffff)) {
    fail(`Window.SetBackgroundStyle requires uint32 ${name} pointer`, {
      kind: 'VALUE', value, operation: name,
    });
  }
  return value;
}

function byte(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    fail(`Window.SetBackgroundStyle requires uint8 ${name}`, {
      kind: 'VALUE', value, operation: name,
    });
  }
  return value & 0xff;
}

function uint(value, name, offset, operation) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail(`Window.SetBackgroundStyle raw dword +0x${offset.toString(16)} is outside uint32`, {
      kind: 'VALUE', value, offset, operation,
    });
  }
  return value >>> 0;
}

function rawDetails(native, phase, object, offset, kind) {
  return {
    native,
    phase,
    object,
    offset,
    kind,
    width: kind === 'u8' ? 1 : 4,
  };
}

function readRaw(object, offset, kind, services, phase, native) {
  const reader = required(services.read, 'read');
  const value = sync(reader(object, offset, kind,
    rawDetails(native, phase, object, offset, kind)),
  `read +0x${offset.toString(16)}`);
  if (value === undefined) {
    fail(`Window.SetBackgroundStyle reached unresolved raw field +0x${offset.toString(16)}`, {
      kind: 'FIELD', value, object, offset, operation: phase,
    });
  }
  if (kind === 'ptr') return objectReference(value, `+0x${offset.toString(16)} pointer`, {allowNull: true});
  if (kind === 'u8') {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      fail(`Window.SetBackgroundStyle raw byte +0x${offset.toString(16)} is outside uint8`, {
        kind: 'VALUE', value, object, offset, operation: phase,
      });
    }
    return value & 0xff;
  }
  return uint(value, 'native dword', offset, phase);
}

function writeRaw(object, offset, kind, value, services, phase, native) {
  const writer = required(services.write, 'write');
  let normalized = value;
  if (kind === 'u8') normalized = byte(value, `+0x${offset.toString(16)} value`);
  else if (kind === 'u32') normalized = uint(value, 'native dword', offset, phase);
  else fail(`Window.SetBackgroundStyle does not support raw write kind ${kind}`, {
    kind: 'VALUE', value: kind, object, offset, operation: phase,
  });
  return sync(writer(object, offset, kind, normalized,
    rawDetails(native, phase, object, offset, kind)),
  `write +0x${offset.toString(16)}`);
}

/**
 * Execute XGC::SetStyle.  The flags read precedes the style-byte store, and
 * all nonzero styles retain the original two dword writes before the leaf.
 */
export function setGcStyleNative(gc, newStyle, services = {}) {
  const target = objectReference(gc, 'XGC');
  const style = byte(newStyle, 'NewStyle');
  const flags = readRaw(target, GC_STYLE_OFFSETS.flags, 'u32', services,
    'XGC::SetStyle/read-flags', WINDOW_BACKGROUND_STYLE_NATIVE.setStyleBody);
  writeRaw(target, GC_STYLE_OFFSETS.style, 'u8', style, services,
    'XGC::SetStyle/write-style', WINDOW_BACKGROUND_STYLE_NATIVE.setStyleBody);

  if (style === 0) {
    const finalFlags = (flags & ~WINDOW_BACKGROUND_STYLE_BITS.styleEnable) >>> 0;
    writeRaw(target, GC_STYLE_OFFSETS.flags, 'u32', finalFlags,
      services, 'XGC::SetStyle/write-flags-style0', WINDOW_BACKGROUND_STYLE_NATIVE.setStyleBody);
    return {style, flags: finalFlags,
      generatedPolyFlags: false};
  }

  const enabled = (flags | WINDOW_BACKGROUND_STYLE_BITS.styleEnable) >>> 0;
  writeRaw(target, GC_STYLE_OFFSETS.flags, 'u32', enabled, services,
    'XGC::SetStyle/write-flags-enable', WINDOW_BACKGROUND_STYLE_NATIVE.setStyleBody);

  let finalFlags;
  if (style === 2) {
    finalFlags = ((enabled & ~0x18) | 0x04) >>> 0;
  } else if (style === 3) {
    finalFlags = ((enabled & ~0x14) | 0x08) >>> 0;
  } else if (style === 4) {
    finalFlags = ((enabled & ~0x0c) | 0x10) >>> 0;
  } else {
    finalFlags = (enabled & ~WINDOW_BACKGROUND_STYLE_BITS.styleMask) >>> 0;
  }
  writeRaw(target, GC_STYLE_OFFSETS.flags, 'u32', finalFlags, services,
    `XGC::SetStyle/write-flags-style${style}`, WINDOW_BACKGROUND_STYLE_NATIVE.setStyleBody);
  const generate = required(services.generatePolyFlags, 'generatePolyFlags');
  sync(generate({gc: target, style, flags: finalFlags,
    native: WINDOW_BACKGROUND_STYLE_NATIVE_ADDRESSES.generatePolyFlags,
    source: WINDOW_BACKGROUND_STYLE_NATIVE.setStyleBody}), 'GeneratePolyFlags');
  return {style, flags: finalFlags, generatedPolyFlags: true};
}

/** Execute Window.SetBackgroundStyle, including its nullable XGC branch. */
export function setBackgroundStyleNative({window, newStyle}, services = {}) {
  const target = objectReference(window, 'Window');
  const style = byte(newStyle, 'NewStyle');
  writeRaw(target, WINDOW_BACKGROUND_STYLE_OFFSETS.backgroundStyle, 'u8', style,
    services, 'Window.SetBackgroundStyle/write-style', WINDOW_BACKGROUND_STYLE_NATIVE.setBackgroundStyleBody);
  const gc = readRaw(target, WINDOW_BACKGROUND_STYLE_OFFSETS.gc, 'ptr', services,
    'Window.SetBackgroundStyle/read-gc', WINDOW_BACKGROUND_STYLE_NATIVE.setBackgroundStyleBody);
  if (!gc) return {style, gc: null, generatedPolyFlags: false};
  const result = setGcStyleNative(gc, style, services);
  return {style, gc, ...result};
}

// ---------------------------------------------------------------------------
// Window.SetBackgroundSmoothing (native 1423): exec 0x10051dc0 reads one bool
// through GNatives and calls XWindow::SetBackgroundSmoothing 0x1004d700,
// which stores bit 2 of Window+0x38 from the low bit of the argument and, for
// a non-null XGC (+0x130), calls XGC::EnableSmoothing 0x100270e0: the
// xor-mask-xor fold of the argument's bit 0 into XGC+0x48 and then
// GeneratePolyFlags 0x1002af00 (the synchronous leaf, as for SetStyle).
// ---------------------------------------------------------------------------
export const WINDOW_BACKGROUND_SMOOTHING_NATIVE = freeze({
  package: 'Extension',
  function: 'Window.SetBackgroundSmoothing',
  nativeIndex: 1423,
  execBody: 0x10051dc0,
  execEnd: 0x10051e03,
  setBackgroundSmoothingBody: 0x1004d700,
  setBackgroundSmoothingEnd: 0x1004d75e,
  enableSmoothingBody: 0x100270e0,
  enableSmoothingEnd: 0x10027130,
  generatePolyFlags: 0x1002af00,
});

const SMOOTHING_FLAGS_OFFSET = 0x38;
const SMOOTHING_BIT = 0x04;

/** Execute Window.SetBackgroundSmoothing, including its nullable XGC branch. */
export function setBackgroundSmoothingNative({window, newValue}, services = {}) {
  const target = objectReference(window, 'Window');
  const value = typeof newValue === 'boolean' ? (newValue ? 1 : 0) : newValue;
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff) {
    fail('Window.SetBackgroundSmoothing requires an int argument', {kind: 'VALUE', value: newValue});
  }
  const native = WINDOW_BACKGROUND_SMOOTHING_NATIVE.setBackgroundSmoothingBody;
  const flags = readRaw(target, SMOOTHING_FLAGS_OFFSET, 'u32', services, 'Window.SetBackgroundSmoothing/read-flags', native);
  writeRaw(target, SMOOTHING_FLAGS_OFFSET, 'u32', (((value & 1) << 2) | (flags & ~SMOOTHING_BIT)) >>> 0, services,
    'Window.SetBackgroundSmoothing/write-flags', native);
  const gc = readRaw(target, WINDOW_BACKGROUND_STYLE_OFFSETS.gc, 'ptr', services, 'Window.SetBackgroundSmoothing/read-gc', native);
  if (!gc) return {gc: null, generatedPolyFlags: false};
  const enable = WINDOW_BACKGROUND_SMOOTHING_NATIVE.enableSmoothingBody;
  const gcFlags = readRaw(gc, GC_STYLE_OFFSETS.flags, 'u32', services, 'XGC::EnableSmoothing/read-flags', enable);
  const next = ((((gcFlags ^ value) & 1) ^ gcFlags) >>> 0);
  writeRaw(gc, GC_STYLE_OFFSETS.flags, 'u32', next, services, 'XGC::EnableSmoothing/write-flags', enable);
  const generate = required(services.generatePolyFlags, 'generatePolyFlags');
  sync(generate({gc, flags: next, native: WINDOW_BACKGROUND_SMOOTHING_NATIVE.generatePolyFlags, source: enable}), 'GeneratePolyFlags');
  return {gc, flags: next, generatedPolyFlags: true};
}
