/**
 * Shared recovered model for the Extension.dll XGC graphics-context drawing
 * state (natives 1200-1272).  `this` is the UGC UObject; the group-A flag
 * natives only touch the flag word at +0x48, the style byte at +0x44, the
 * tile polyflags at +0x4c, the text polyflags at +0x50 and the text flag
 * word at +0x98.  The two shared helper bodies (style-from-flags
 * 0x1002aed0, polyflags-from-flags 0x1002af00) are translated once here.
 *
 * Evidence: Extension.dll bodies listed in each native module and
 * docs/script-gc-state.md.  Nothing here is approximated.
 */

const freeze = Object.freeze;

export const GC_DLL = freeze({
  dll: 'Extension.dll',
  imageBase: 0x10000000,
  oracleBase: 0x12000000,
  dllSha256: '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c',
});

/** UGC fields recovered from the native bodies (object size 0xb8). */
export const GC = freeze({
  vtable: 0x00,          // 0x100598dc for a constructed UGC
  canvas: 0x28,          // dereferenced only by ClearZ; copied by CopyGC
  originX: 0x2c,         // f32
  originY: 0x30,         // f32
  clipX: 0x34,           // f32, origin-relative
  clipY: 0x38,           // f32
  clipWidth: 0x3c,       // f32
  clipHeight: 0x40,      // f32
  style: 0x44,           // u8 DSTY_*: 0 none, 1 normal, 2 masked, 3 translucent, 4 modulated
  flags: 0x48,           // u32: bit0 smoothing, bit1 drawing, bit2 masked, bit3 translucent,
                         //      bit4 modulated, bit5 translucentText; bits 6+ untouched
  polyFlags: 0x4c,       // u32 tile polyflags, recomputed by 0x1002af00
  textPolyFlags: 0x50,   // u32 text polyflags 0x804 / 0x802
  tileColor: 0x54,       // u32 Color dword
  tileFloats: 0x58,      // 4xf32 byte0*K, byte1*K, byte2*K, 0
  textColor: 0x68,       // u32 Color dword
  textFloats: 0x6c,      // 4xf32 byte0*K, byte1*K, byte2*K, 0
  normalFont: 0x7c,      // ptr
  boldFont: 0x80,        // ptr
  unknown84: 0x84,       // copied by CopyGC only
  underlineHeight: 0x88, // f32, 2nd SetBaselineData arg
  baselineOffset: 0x8c,  // f32, 1st SetBaselineData arg
  textVSpacing: 0x90,    // f32
  hAlign: 0x94,          // u8
  vAlign: 0x95,          // u8
  textFlags: 0x98,       // u32: bit0 wordWrap, bit1 specialText; bits 2+ untouched
  unknown9c: 0x9c,       // copied by CopyGC only
  unknownA0: 0xa0,       // copied by CopyGC only
  nodeFlags: 0xa4,       // stack-node flags: bit0 = node sits on the free list
  depth: 0xa8,           // i32 stack depth
  stackTop: 0xac,        // ptr top saved node
  freeList: 0xb0,        // ptr free-list head
  owner: 0xb4,           // ptr owner GC (non-null only on saved/free nodes)
  size: 0xb8,
});

/** +0x48 flag bits. */
export const GC_FLAGS = freeze({
  smoothing: 0x1,
  drawing: 0x2,
  masked: 0x4,
  translucent: 0x8,
  modulated: 0x10,
  translucentText: 0x20,
});

/** +0x98 text flag bits. */
export const GC_TEXT_FLAGS = freeze({
  wordWrap: 0x1,
  specialText: 0x2,
});

/** Polyflag words the helpers/store paths produce. */
export const GC_POLY = freeze({
  base: 0x100,
  masked: 0x2,
  translucent: 0x4,
  modulated: 0x40,
  noSmooth: 0x800,
  textTranslucent: 0x804,
  textOpaque: 0x802,
});

/** Shared helper bodies (preferred-base addresses). */
export const GC_HELPERS = freeze({
  styleFromFlags: 0x1002aed0,
  polyFlagsFromFlags: 0x1002af00,
});

export class GcStateModelBoundaryError extends Error {
  constructor(message, {kind = 'BOUNDARY', offset = null, value = undefined} = {}) {
    super(message);
    this.name = 'GcStateModelBoundaryError';
    this.code = `GC_MODEL_${kind}`;
    this.offset = offset;
    this.value = value;
  }
}

const modelFail = (message, details) => {
  throw new GcStateModelBoundaryError(message, details);
};

export function rejectAsync(value, label) {
  if (value && typeof value.then === 'function')
    modelFail(`GC ${label} suspended`, {kind: 'ASYNC'});
  return value;
}

function requireMem(services) {
  const mem = services.mem;
  if (!mem || typeof mem.read !== 'function' || typeof mem.write !== 'function')
    modelFail('GC requires a raw native heap service (mem)', {kind: 'SERVICE'});
  return mem;
}

/** Checked accessors over the injected byte-addressable heap service. */
export function gcMemory(object, services) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function'))
    modelFail('GC requires a canonical graphics-context object', {kind: 'REFERENCE', value: object});
  const mem = requireMem(services);
  const base = rejectAsync(services.objectAddress ? services.objectAddress(object) : object.base, 'objectAddress');
  if (typeof base !== 'number' || !Number.isInteger(base) || base <= 0)
    modelFail('GC requires the object heap address', {kind: 'SERVICE', value: base});
  const sync = (value, label) => rejectAsync(value, label);
  const int32 = value => {
    if (typeof value !== 'number' || !Number.isInteger(value))
      modelFail('GC heap read returned a non-integer', {kind: 'VALUE', value});
    return value | 0;
  };
  const uint32 = value => {
    if (typeof value !== 'number' || !Number.isInteger(value))
      modelFail('GC heap read returned a non-integer', {kind: 'VALUE', value});
    return value >>> 0;
  };
  const float32 = value => {
    if (typeof value !== 'number')
      modelFail('GC heap read returned a non-number', {kind: 'VALUE', value});
    return Math.fround(value);
  };
  const checked = kind => {
    if (kind === 'i32' || kind === 'i16' || kind === 'i8') return int32;
    if (kind === 'u32' || kind === 'u16' || kind === 'u8') return uint32;
    if (kind === 'f32') return float32;
    return modelFail(`GC unsupported heap kind ${kind}`, {kind: 'VALUE', value: kind});
  };
  const read = (address, kind) => checked(kind)(sync(mem.read(address, kind), `read 0x${address.toString(16)}`));
  const write = (address, kind, value) => sync(mem.write(address, kind, value), `write 0x${address.toString(16)}`);
  return {mem, object, services, base, read, write};
}

// ================= recovered shared helper bodies =================

/**
 * Extension helper 0x1002aed0: recompute the style byte +0x44 from +0x48.
 * !(flags&2) -> 0; flags&4 -> 2; flags&8 -> 3; flags&0x10 -> 4; else 1.
 */
export function updateStyleFromFlags(L, base) {
  const flags = L.read(base + GC.flags, 'u32');
  let style;
  if (!(flags & GC_FLAGS.drawing)) style = 0;
  else if (flags & GC_FLAGS.masked) style = 2;
  else if (flags & GC_FLAGS.translucent) style = 3;
  else if (flags & GC_FLAGS.modulated) style = 4;
  else style = 1;
  L.write(base + GC.style, 'u8', style);
}

/**
 * Extension helper 0x1002af00: recompute tile polyflags +0x4c from +0x48.
 * pf = 0x100; if flags&4 pf = 0x102; if flags&8 pf |= 4;
 * if flags&0x10 pf |= 0x40; if !(flags&1) pf |= 0x800 (the body's `or ah,8`).
 */
export function updatePolyFlagsFromFlags(L, base) {
  const flags = L.read(base + GC.flags, 'u32');
  let pf = GC_POLY.base;
  if (flags & GC_FLAGS.masked) pf = GC_POLY.base | GC_POLY.masked;
  if (flags & GC_FLAGS.translucent) pf |= GC_POLY.translucent;
  if (flags & GC_FLAGS.modulated) pf |= GC_POLY.modulated;
  if (!(flags & GC_FLAGS.smoothing)) pf |= GC_POLY.noSmooth;
  L.write(base + GC.polyFlags, 'u32', pf >>> 0);
}
