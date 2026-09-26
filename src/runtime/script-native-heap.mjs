/**
 * Byte-addressed native storage shared by the recovered Extension window and
 * GC translations.
 *
 * The window natives address a native object as `read(object, offset, kind)`
 * while the XGC/UFont natives address the same process memory as
 * `mem.read(address, kind)`. The original binaries use one address space, so
 * mixed-width accesses (a `test byte ptr [+0xb8]` on a dword that was written
 * as a whole) and pointer chasing (GC+0x28 canvas, GC+0x7c font) must see
 * the same bytes. This heap is that single address space: every native
 * object is a byte range with an address; `ptr` slots hold the target's
 * address; an object that has no native byte image (a VM actor, a Class, a
 * Sound) is given an opaque handle address so the same JS identity reads
 * back. FString / FName slots keep the script value in a side table keyed by
 * the slot address (their raw Data/Num/Max words are not modelled).
 *
 * This is storage, not behavior: allocation policy and handle numbering are
 * host choices with no original counterpart, and no native body depends on
 * the numeric addresses except through identity. The original frees through
 * GMalloc (a window's deleting destructor, FArray::Realloc); `free`/`freeRaw`
 * return a range to a first-fit list, zeroed, so later allocations reuse it.
 * A stale pointer into a freed range then fails at the boundary, or resolves
 * to whatever the range holds now, as a dangling native pointer would.
 * See docs/script-window-host.md.
 */

const HEAP_BASE = 0x21000000;
const HANDLE_BASE = 0x38000000;
const KINDS = Object.freeze({
  u8: [1, 'getUint8', 'setUint8'],
  i8: [1, 'getInt8', 'setInt8'],
  u16: [2, 'getUint16', 'setUint16'],
  i16: [2, 'getInt16', 'setInt16'],
  u32: [4, 'getUint32', 'setUint32'],
  i32: [4, 'getInt32', 'setInt32'],
  f32: [4, 'getFloat32', 'setFloat32'],
});

export class NativeHeapError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'NativeHeapError';
    this.code = 'NATIVE_HEAP_BOUNDARY';
    Object.assign(this, details);
  }
}

const fail = (message, details) => { throw new NativeHeapError(message, details); };

export function createNativeHeap({capacity = 16 * 1024 * 1024, external = null} = {}) {
  const bytes = new Uint8Array(capacity), view = new DataView(bytes.buffer);
  let next = 16;
  const objects = new Map();          // object -> {address, size}
  const handles = new Map();          // opaque value -> address
  const byAddress = new Map();        // address -> object (objects and handles)
  const side = new Map();             // absolute slot address -> string/name value
  const blocks = new Map();           // live allocation address -> byte count
  const freeRanges = [];              // address-sorted [offset, size], zero-filled
  const released = new WeakSet();     // freed object images
  let nextHandle = HANDLE_BASE;

  function allocRaw(size, alignTo = 16) {
    if (!Number.isInteger(size) || size < 0) fail('Native heap allocation requires a byte size', {size});
    const length = Math.max(size, 1);
    for (let i = 0; i < freeRanges.length; i++) {
      const [start, available] = freeRanges[i];
      const offset = (start + alignTo - 1) & ~(alignTo - 1);
      if (offset + length > start + available) continue;
      const tail = start + available - (offset + length);
      const pieces = [];
      if (offset > start) pieces.push([start, offset - start]);
      if (tail > 0) pieces.push([offset + length, tail]);
      freeRanges.splice(i, 1, ...pieces);
      blocks.set(HEAP_BASE + offset, length);
      return HEAP_BASE + offset;
    }
    next = (next + alignTo - 1) & ~(alignTo - 1);
    const offset = next;
    next += length;
    if (next > capacity) fail('Native heap exhausted', {size, capacity});
    blocks.set(HEAP_BASE + offset, length);
    return HEAP_BASE + offset;
  }

  /** Release an allocRaw block: zero it, drop its string slots and merge the
   * range into the free list. */
  function freeRaw(address) {
    const length = blocks.get(address >>> 0);
    if (length === undefined) fail(`Native heap has no allocation at 0x${(address >>> 0).toString(16)}`, {address});
    blocks.delete(address >>> 0);
    const offset = (address >>> 0) - HEAP_BASE;
    bytes.fill(0, offset, offset + length);
    for (const at of side.keys()) if (at >= address && at < address + length) side.delete(at);
    let lo = 0, hi = freeRanges.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (freeRanges[mid][0] < offset) lo = mid + 1; else hi = mid; }
    const range = [offset, length];
    freeRanges.splice(lo, 0, range);
    const after = freeRanges[lo + 1];
    if (after && range[0] + range[1] === after[0]) { range[1] += after[1]; freeRanges.splice(lo + 1, 1); }
    const before = freeRanges[lo - 1];
    if (before && before[0] + before[1] === range[0]) { before[1] += range[1]; freeRanges.splice(lo, 1); }
  }

  /** Register `object` as a native byte image of `size` bytes (zero-filled). */
  function allocate(object, size = 0x1000) {
    if (!object || (typeof object !== 'object' && typeof object !== 'function'))
      fail('Native heap object allocation requires a canonical object', {value: object});
    const existing = objects.get(object);
    if (existing) {
      if (existing.size < size) fail('Native heap object was already allocated smaller', {object, size});
      return object;
    }
    if (handles.has(object)) fail('Native heap object already has an opaque handle', {object});
    const address = allocRaw(size);
    objects.set(object, {address, size});
    byAddress.set(address, object);
    return object;
  }

  /** Release a native object image; its address no longer resolves, and the
   * identity cannot come back as an opaque handle. */
  function free(object) {
    const record = objects.get(object);
    if (!record) fail('Native heap free requires an allocated object', {object});
    objects.delete(object);
    byAddress.delete(record.address);
    released.add(object);
    freeRaw(record.address);
  }

  /** Drop the opaque handle of an identity that no longer exists (a purged
   * UObject), so the heap stops retaining it. A slot that still holds the
   * handle address then fails at the boundary instead of reviving it. */
  function forget(value) {
    const address = handles.get(value);
    if (address === undefined) return;
    handles.delete(value);
    byAddress.delete(address);
  }

  function isAllocated(object) { return objects.has(object); }

  function handleFor(value) {
    let address = handles.get(value);
    if (address === undefined) {
      if (released.has(value)) fail('Native heap object was freed', {object: value});
      if (typeof external === 'function') {
        const supplied = external(value, api);
        if (supplied !== undefined) {
          if (!Number.isInteger(supplied) || supplied <= 0) fail('Native heap external address must be a positive integer', {value, supplied});
          handles.set(value, supplied);
          byAddress.set(supplied, value);
          return supplied;
        }
      }
      address = nextHandle;
      nextHandle += 16;
      handles.set(value, address);
      byAddress.set(address, value);
    }
    return address;
  }

  /** Address of a native object, or an opaque handle for any other identity. */
  function addressOf(value) {
    if (value === null || value === undefined || value === 0) return 0;
    if (typeof value === 'number') return value >>> 0;
    const record = objects.get(value);
    if (record) return record.address;
    if (typeof value !== 'object' && typeof value !== 'function')
      fail('Native heap pointer requires an object identity', {value});
    return handleFor(value);
  }

  function objectAt(address) {
    if (!address) return null;
    const value = byAddress.get(address >>> 0);
    if (value === undefined) fail(`Native heap has no object at 0x${(address >>> 0).toString(16)}`, {address});
    return value;
  }

  function absolute(target, offset) {
    if (typeof target === 'number') return (target + (offset ?? 0)) >>> 0;
    const record = objects.get(target);
    // Resource images are lazily supplied by external(), and retain their
    // canonical package identity instead of being allocated UObject hosts.
    if (!record) return (addressOf(target) + (offset ?? 0)) >>> 0;
    if (offset < 0 || offset >= record.size)
      fail(`Native heap offset 0x${offset.toString(16)} is outside the object image`, {object: target, offset});
    return (record.address + offset) >>> 0;
  }

  function byteIndex(address, width) {
    const index = address - HEAP_BASE;
    if (index < 0 || index + width > capacity)
      fail(`Native heap address 0x${address.toString(16)} is outside heap storage`, {address});
    return index;
  }

  function readAt(address, kind) {
    if (kind === 'ptr') return objectAt(view.getUint32(byteIndex(address, 4), true));
    if (kind === 'string' || kind === 'name') {
      if (side.has(address)) return side.get(address);
      return kind === 'string' ? '' : 'None';
    }
    const spec = KINDS[kind];
    if (!spec) fail(`Native heap does not support read kind ${kind}`, {kind});
    return view[spec[1]](byteIndex(address, spec[0]), true);
  }

  function writeAt(address, kind, value) {
    if (kind === 'ptr') {
      view.setUint32(byteIndex(address, 4), addressOf(value), true);
      return;
    }
    if (kind === 'string' || kind === 'name') {
      if (typeof value !== 'string') fail(`Native heap ${kind} slot requires a string value`, {value});
      side.set(address, value);
      return;
    }
    const spec = KINDS[kind];
    if (!spec) fail(`Native heap does not support write kind ${kind}`, {kind});
    if (typeof value === 'boolean') value = value ? 1 : 0;
    if (typeof value !== 'number') fail(`Native heap ${kind} write requires a number`, {value, kind});
    if (kind !== 'f32' && !Number.isInteger(value))
      fail(`Native heap ${kind} write requires an integer`, {value, kind});
    view[spec[2]](byteIndex(address, spec[0]), kind === 'f32' ? value : value, true);
    // A numeric store over a string slot invalidates the side value.
    if (side.size) for (let i = 0; i < spec[0]; i++) side.delete(address + i);
  }

  /** Object-relative access used by the window natives. */
  const read = (target, offset, kind) => readAt(absolute(target, offset), kind);
  const write = (target, offset, kind, value) => writeAt(absolute(target, offset), kind, value);
  function copyBytes(destination, source, count) {
    const values=[...side].filter(([at])=>at>=source&&at<source+count).map(([at,value])=>[destination+at-source,value]);
    bytes.copyWithin(destination-HEAP_BASE,source-HEAP_BASE,source-HEAP_BASE+count);
    for(const at of side.keys())if(at>=destination&&at<destination+count)side.delete(at);
    for(const [at,value] of values)side.set(at,value);
  }

  /** Address-based access used by the XGC/UFont natives (hud-text shape). */
  const mem = {
    bytes,
    allocRaw: size => allocRaw(size),
    read: (address, kind) => readAt(address >>> 0, kind),
    write: (address, kind, value) => writeAt(address >>> 0, kind, value),
  };

  const api = {
    bytes, allocRaw, freeRaw, allocate, free, forget, isAllocated, addressOf, objectAt, read, write, mem, copyBytes,
    objectAddress: object => {
      const record = objects.get(object);
      if (!record) fail('Native heap object has no address', {object});
      return record.address;
    },
    sizeOf: object => objects.get(object)?.size ?? 0,
    get used() { return next; },
  };
  return api;
}
