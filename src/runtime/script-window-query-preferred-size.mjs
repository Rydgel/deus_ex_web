/**
 * Recovered Extension.dll XWindow::QueryPreferredSize translation.
 *
 * The registered exec body evaluates two float out parameters (each routed
 * through GPropAddr; the method writes through the resolved pointers) and
 * tail-calls the wrapper at 0x1004e710, which invokes the shared helper at
 * 0x1004e790 as helper(this, 0, 0, wOut, 0, 0, hOut).
 *
 * The helper recovers the effective width/height from the +0x9c/+0xa0
 * geometry floats: a value >= 0.0 (ordered) is "provided" and used as-is,
 * otherwise the input is -1.0 and the dimension is "wanted".  When both
 * dimensions are provided the helper writes the outs and returns.  Otherwise
 * it consults the preferred-size cache in +0xb8 (dirty bit 1, provided-flags
 * at bits 3/4) and +0xbc/+0xc0 (cached inputs): on a miss it records the new
 * inputs, bumps the global recursion counter at 0x100aeb04, dispatches the
 * +0x7c virtual (preferredSize(flagW, &w, flagH, &h)) so the script side can
 * supply wanted dimensions, decrements the counter, and stores the results
 * in +0xc4/+0xc8.  Both paths then fall back for negative results: width
 * falls back to int32 at font(+0xec)+0x34 or the +0x80 field, height to
 * font+0x38 or +0x84, before writing the out parameters.
 *
 * Evidence: Extension.dll SHA-256
 * 93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c,
 * exec body 0x10053160 through 0x10053200,
 * wrapper body 0x1004e710 through 0x1004e760,
 * helper body 0x1004e790 through 0x1004e9bd.
 */

const freeze = value => Object.freeze(value);

export const WINDOW_QUERY_PREFERRED_SIZE_NATIVE = freeze({
  package: 'Extension',
  function: 'Window.QueryPreferredSize / XWindow::QueryPreferredSize',
  packageExport: 1144,
  nativeIndex: 1465,
  functionFlags: 0x401,
  serialSize: 34,
  dll: 'Extension.dll',
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
  imageBase: 0x10000000,
  execBody: 0x10053160,
  execEnd: 0x10053200,
  execSha256: '28375b897ea5b41c2d193e085940dc1ff396c97245a9118b2d57b28c8ac2ba88',
  methodBody: 0x1004e710,
  methodEnd: 0x1004e760,
  methodSha256: '978ef3540fbafb23040a71a288b9af580f2ee283b965c4c7dae52933a7e2d0a9',
  helperBody: 0x1004e790,
  helperEnd: 0x1004e9bd,
  helperSha256: '8e80537ecc5ecbd5ee9e15df2789ec9665a9ff811b416173f850960e719104ec',
});

export const WINDOW_QUERY_PREFERRED_SIZE_ADDRESSES = freeze({
  body: WINDOW_QUERY_PREFERRED_SIZE_NATIVE.methodBody,
  end: WINDOW_QUERY_PREFERRED_SIZE_NATIVE.methodEnd,
  helper: WINDOW_QUERY_PREFERRED_SIZE_NATIVE.helperBody,
  helperEnd: WINDOW_QUERY_PREFERRED_SIZE_NATIVE.helperEnd,
  preferredSizeDepth: 0x100aeb04,
});

/** Numeric byte offsets in the native XWindow object. */
export const WINDOW_QUERY_PREFERRED_SIZE_OFFSETS = freeze({
  vtable: 0x00,
  fallbackWidth: 0x80,
  fallbackHeight: 0x84,
  geometryWidth: 0x9c,
  geometryHeight: 0xa0,
  cacheFlags: 0xb8,
  cacheInWidth: 0xbc,
  cacheInHeight: 0xc0,
  cacheOutWidth: 0xc4,
  cacheOutHeight: 0xc8,
  font: 0xec,
});

export const WINDOW_QUERY_PREFERRED_SIZE_FIELDS =
  WINDOW_QUERY_PREFERRED_SIZE_OFFSETS;

export const WINDOW_QUERY_PREFERRED_SIZE_BITS = freeze({
  dirty: 0x02,
  providedMask: 0x18,
});

/** Offsets inside the font object (+0xec) the fallback reads as int32. */
export const WINDOW_QUERY_PREFERRED_SIZE_FONT = freeze({
  width: 0x34,
  height: 0x38,
});

/** The helper dispatches the +0x7c virtual to fill wanted dimensions. */
export const WINDOW_QUERY_PREFERRED_SIZE_VIRTUAL = freeze({
  preferredSize: 0x7c,
});

export const WINDOW_QUERY_PREFERRED_SIZE_NATIVE_CONTRACT = freeze({
  name: 'XWindow::QueryPreferredSize',
  address: WINDOW_QUERY_PREFERRED_SIZE_NATIVE.methodBody,
  arguments: freeze(['Width:out float', 'Height:out float']),
  returns: 'void',
  rawStorage: 'read/write(object, offset, kind, ..., details)',
  fields: freeze({...WINDOW_QUERY_PREFERRED_SIZE_OFFSETS}),
  callbacks: freeze(['preferredSize(flagW, &w, flagH, &h) through vtable +0x7c']),
});

export class WindowQueryPreferredSizeNativeBoundaryError extends Error {
  constructor(message, {
    kind = 'BOUNDARY', value = undefined, object = undefined,
    offset = null, operation = null,
  } = {}) {
    super(message);
    this.name = 'WindowQueryPreferredSizeNativeBoundaryError';
    this.code = `WINDOW_QUERY_PREFERRED_SIZE_${kind}`;
    this.value = value;
    this.object = object;
    this.offset = offset;
    this.operation = operation;
  }
}

const fail = (message, details = {}) => {
  throw new WindowQueryPreferredSizeNativeBoundaryError(message, details);
};

function sync(value, label) {
  if (value && typeof value.then === 'function') {
    fail(`XWindow::QueryPreferredSize ${label} suspended; native path is synchronous`, {
      kind: 'ASYNC', value, operation: label,
    });
  }
  return value;
}

function objectReference(value, name) {
  if (value === null || value === undefined ||
      (typeof value !== 'object' && typeof value !== 'function')) {
    fail(`XWindow::QueryPreferredSize requires canonical ${name}`, {
      kind: 'REFERENCE', value, operation: name,
    });
  }
  return value;
}

const present = value => value !== null && value !== undefined && value !== 0;

const F = WINDOW_QUERY_PREFERRED_SIZE_OFFSETS;
const FONT = WINDOW_QUERY_PREFERRED_SIZE_FONT;
const NATIVE = WINDOW_QUERY_PREFERRED_SIZE_NATIVE;
const FILL = -1.0;

function readRaw(object, offset, kind, services, phase) {
  const reader = services.read;
  if (typeof reader !== 'function') {
    fail('XWindow::QueryPreferredSize requires read service', {
      kind: 'SERVICE', offset, operation: phase,
    });
  }
  return sync(reader(object, offset, kind, {
    native: NATIVE.helperBody, phase, object, offset, kind,
    width: kind === 'u8' ? 1 : 4,
  }), `read +0x${offset.toString(16)}`);
}

function writeRaw(object, offset, kind, value, services, phase) {
  const writer = services.write;
  if (typeof writer !== 'function') {
    fail('XWindow::QueryPreferredSize requires write service', {
      kind: 'SERVICE', offset, operation: phase,
    });
  }
  sync(writer(object, offset, kind, value, {
    native: NATIVE.helperBody, phase, object, offset, kind,
    width: kind === 'u8' ? 1 : 4,
  }), `write +0x${offset.toString(16)}`);
}

function readFloat(object, offset, services, phase) {
  const value = readRaw(object, offset, 'f32', services, phase);
  if (typeof value !== 'number') {
    fail(`XWindow::QueryPreferredSize requires float32 +0x${offset.toString(16)} field`, {
      kind: 'VALUE', value, object, offset, operation: phase,
    });
  }
  return Math.fround(value);
}

/** x87 fcomp vs 0.0: C0 (ah&1) is set for below OR unordered. */
const belowOrUnordered = value => value < 0 || Number.isNaN(value);

/** x87 fcomp equality: C3 (ah&0x40) is set for ordered-equal OR unordered. */
const fcomEqual = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));

function outTarget(value, name) {
  if (value && typeof value === 'object' && 'out' in value) return value.out;
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' || typeof value === 'function') return value;
  fail(`XWindow::QueryPreferredSize requires an out reference for ${name}`, {
    kind: 'REFERENCE', value, operation: name,
  });
}

function writeOut(target, bits, services, phase) {
  const writer = services.write;
  if (typeof writer !== 'function') {
    fail('XWindow::QueryPreferredSize requires write service', {
      kind: 'SERVICE', offset: 0, operation: phase,
    });
  }
  sync(writer(target, 0, 'u32', bits >>> 0, {
    native: NATIVE.helperBody, phase, object: target, offset: 0,
    kind: 'u32', width: 4,
  }), 'write out');
}

/**
 * Execute the original helper body for the native wrapper call
 * helper(this, 0, 0, widthOut, 0, 0, heightOut).
 */
export function queryPreferredSizeNative(
  object, widthOut, heightOut, services = {}) {
  objectReference(object, 'window');
  const wTarget = outTarget(widthOut, 'Width');
  const hTarget = outTarget(heightOut, 'Height');
  const phase = 'preferred-size';

  // Inputs: +0x9c/+0xa0 >= 0.0 (ordered) means the dimension is provided.
  // The body loads the field once for the fcomp and reads it a second time
  // inside the provided branch.
  const geometryWidth = readFloat(object, F.geometryWidth, services, phase);
  const widthProvided = belowOrUnordered(geometryWidth) ? 0 : 1;
  const widthIn = widthProvided
    ? readFloat(object, F.geometryWidth, services, phase) : FILL;
  const geometryHeight = readFloat(object, F.geometryHeight, services, phase);
  const heightProvided = belowOrUnordered(geometryHeight) ? 0 : 1;
  const heightIn = heightProvided
    ? readFloat(object, F.geometryHeight, services, phase) : FILL;

  let width = widthIn;
  let height = heightIn;
  if (!(widthProvided && heightProvided)) {
    const flags = readRaw(object, F.cacheFlags, 'u32', services, phase);
    if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff) {
      fail('XWindow::QueryPreferredSize requires uint32 +0xb8 field', {
        kind: 'VALUE', value: flags, object,
        offset: F.cacheFlags, operation: phase,
      });
    }
    const B = WINDOW_QUERY_PREFERRED_SIZE_BITS;
    const hit = (flags & B.dirty) === 0
      && ((flags >>> 3) & 1) === widthProvided
      && ((flags >>> 4) & 1) === heightProvided
      && fcomEqual(widthIn, readFloat(object, F.cacheInWidth, services, phase))
      && fcomEqual(heightIn, readFloat(object, F.cacheInHeight, services, phase));
    if (hit) {
      width = readFloat(object, F.cacheOutWidth, services, phase);
      height = readFloat(object, F.cacheOutHeight, services, phase);
    } else {
      // Record the new inputs: clear the dirty bit, store provided-flags at
      // bits 3/4, then cache the wanted width/height.
      writeRaw(object, F.cacheInHeight, 'f32', heightIn, services, phase);
      const updated = ((((heightProvided & 1) << 1) | (widthProvided & 1)) << 3)
        | (flags & 0xffffffe5);
      writeRaw(object, F.cacheFlags, 'u32', updated, services, phase);
      writeRaw(object, F.cacheInWidth, 'f32', widthIn, services, phase);

      const readGlobal = services.readGlobal;
      const writeGlobal = services.writeGlobal;
      if (typeof readGlobal !== 'function' ||
          typeof writeGlobal !== 'function') {
        fail('XWindow::QueryPreferredSize requires global counter services', {
          kind: 'SERVICE', operation: phase,
        });
      }
      const depthName = 'preferredSizeDepth';
      const depth = sync(readGlobal(depthName, 'u32', {
        native: NATIVE.helperBody, phase, offset: 0, kind: 'u32', width: 4,
      }), 'read global');
      sync(writeGlobal(depthName, 'u32', (depth + 1) >>> 0, {
        native: NATIVE.helperBody, phase, offset: 0, kind: 'u32', width: 4,
      }), 'write global');

      readRaw(object, F.vtable, 'ptr', services, phase);
      const dispatch = services.preferredSize;
      if (typeof dispatch !== 'function') {
        fail('XWindow::QueryPreferredSize requires preferredSize service', {
          kind: 'SERVICE',
          offset: WINDOW_QUERY_PREFERRED_SIZE_VIRTUAL.preferredSize,
          operation: phase,
        });
      }
      const callback = sync(dispatch({
        native: NATIVE.helperBody, phase, object,
        flagW: widthProvided, flagH: heightProvided,
        virtualSlot: WINDOW_QUERY_PREFERRED_SIZE_VIRTUAL.preferredSize,
      }), 'PreferredSize');

      const depthAfter = sync(readGlobal(depthName, 'u32', {
        native: NATIVE.helperBody, phase, offset: 0, kind: 'u32', width: 4,
      }), 'read global');
      sync(writeGlobal(depthName, 'u32', (depthAfter - 1) >>> 0, {
        native: NATIVE.helperBody, phase, offset: 0, kind: 'u32', width: 4,
      }), 'write global');

      width = widthProvided ? widthIn : Math.fround(callback?.width ?? 0);
      height = heightProvided ? heightIn : Math.fround(callback?.height ?? 0);
      // Results cache: +0xc8 stores the height first, then +0xc4 the width.
      writeRaw(object, F.cacheOutHeight, 'f32', height, services, phase);
      writeRaw(object, F.cacheOutWidth, 'f32', width, services, phase);
    }
  }

  // Shared tail: negative (or unordered) results fall back to the font
  // metrics or the +0x80/+0x84 fields.
  if (belowOrUnordered(width)) {
    const font = readRaw(object, F.font, 'ptr', services, phase);
    if (present(font)) {
      const metric = readRaw(font, FONT.width, 'u32', services, phase);
      if (!Number.isInteger(metric) || metric < 0 || metric > 0xffffffff) {
        fail('XWindow::QueryPreferredSize requires uint32 font width metric', {
          kind: 'VALUE', value: metric, object: font,
          offset: FONT.width, operation: phase,
        });
      }
      width = Math.fround(metric | 0);
    } else {
      width = readFloat(object, F.fallbackWidth, services, phase);
    }
  }
  if (belowOrUnordered(height)) {
    const font = readRaw(object, F.font, 'ptr', services, phase);
    if (present(font)) {
      const metric = readRaw(font, FONT.height, 'u32', services, phase);
      if (!Number.isInteger(metric) || metric < 0 || metric > 0xffffffff) {
        fail('XWindow::QueryPreferredSize requires uint32 font height metric', {
          kind: 'VALUE', value: metric, object: font,
          offset: FONT.height, operation: phase,
        });
      }
      height = Math.fround(metric | 0);
    } else {
      height = readFloat(object, F.fallbackHeight, services, phase);
    }
  }

  const f32bits = value => {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, Math.fround(value), true);
    return view.getUint32(0, true);
  };
  if (wTarget) writeOut(wTarget, f32bits(width), services, phase);
  if (hTarget) writeOut(hTarget, f32bits(height), services, phase);
}

export const windowQueryPreferredSizeNative = queryPreferredSizeNative;
export const windowWindowQueryPreferredSizeNative = queryPreferredSizeNative;
