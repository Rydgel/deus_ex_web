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
 * back. An FString slot holds its raw Data/Num/Max words: a 'string' write is
 * FString::operator=(const TCHAR*) (Num = Max = len ? len + 1 : 0, Realloc of
 * the current Data, UTF-16 plus NUL) and a read decodes Data up to the NUL,
 * so the raw FString bodies (list/edit/text models, through `realloc`/
 * `freeRaw`) and the typed accessors see the same bytes. Freeing an image
 * releases the Data of every slot written as a string in it (the members'
 * ~FString). FName slots keep the script value in a side table keyed by the
 * slot address (their name index is not modelled).
 *
 * This is storage, not behavior: allocation policy and handle numbering are
 * host choices with no original counterpart, and no native body depends on
 * the numeric addresses except through identity. The original frees through
 * GMalloc (a window's deleting destructor, FArray::Realloc); `free`/`freeRaw`
 * return a range to a first-fit list, zeroed, so later allocations reuse it.
 * A stale pointer into a freed range then fails at the boundary, or resolves
 * to whatever the range holds now, as a dangling native pointer would.
 * See docs/script-window-host.md.
 *
 * With an `arena` (script-object-arena.mjs), the storage is a range of the
 * arena's WebAssembly memory, so the Rust core can address the same bytes
 * (docs/play-cpu-plan.md, Phase 5): native address A is arena offset
 * `region + (A - HEAP_BASE)`. The views follow the arena's buffer when it
 * grows. Addresses and contents are the same as without an arena.
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

export function createNativeHeap({capacity = 16 * 1024 * 1024, external = null, arena = null, onRelease = null} = {}) {
  const region = arena ? arena.alloc(capacity) : 0;
  let bytes, view;
  const attach = buffer => { bytes = new Uint8Array(buffer, region, capacity); view = new DataView(buffer, region, capacity); };
  if (arena) { attach(arena.memory.buffer); arena.listeners.push(attach); }
  else { bytes = new Uint8Array(capacity); view = new DataView(bytes.buffer); }
  let next = 16;
  const objects = new Map();          // object -> {address, size}
  const handles = new Map();          // opaque value -> address
  const byAddress = new Map();        // address -> object (objects and handles)
  const side = new Map();             // absolute slot address -> FName value
  const stringSlots = new Set();      // absolute FString slot addresses written as 'string'
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
    // ~FString of the string members in the released range.
    const owned = [];
    for (const at of stringSlots) if (at >= address && at < address + length) { owned.push(view.getUint32(at - HEAP_BASE, true)); stringSlots.delete(at); }
    const offset = (address >>> 0) - HEAP_BASE;
    bytes.fill(0, offset, offset + length);
    for (const at of side.keys()) if (at >= address && at < address + length) side.delete(at);
    for (const data of owned) if (data && blocks.has(data)) freeRaw(data);
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
    onRelease?.();
  }

  /** Drop the opaque handle of an identity that no longer exists (a purged
   * UObject), so the heap stops retaining it. A slot that still holds the
   * handle address then fails at the boundary instead of reviving it. */
  function forget(value) {
    const address = handles.get(value);
    if (address === undefined) return;
    handles.delete(value);
    byAddress.delete(address);
    onRelease?.();
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

  /** GMalloc->Realloc: a zero size frees, a null block allocates, anything
   * else moves the leading bytes into a new block and frees the old one. */
  function realloc(address, size) {
    address >>>= 0;
    if (!size) { if (address) freeRaw(address); return 0; }
    const block = allocRaw(size);
    if (address) {
      const length = blocks.get(address);
      if (length === undefined) fail(`Native heap Realloc of a block it did not allocate: 0x${address.toString(16)}`, {address});
      bytes.copyWithin(block - HEAP_BASE, address - HEAP_BASE, address - HEAP_BASE + Math.min(length, size));
      freeRaw(address);
    }
    return block;
  }

  function readString(address) {
    const data = view.getUint32(byteIndex(address, 12), true), num = view.getInt32(address - HEAP_BASE + 4, true);
    if (!data || num <= 0) return '';
    let text = '';
    for (let at = data; at < data + 2 * num; at += 2) {
      const unit = view.getUint16(byteIndex(at, 2), true);
      if (!unit) break;
      text += String.fromCharCode(unit);
    }
    return text;
  }

  function writeString(address, value) {
    byteIndex(address, 12);
    const index = address - HEAP_BASE, num = value.length ? value.length + 1 : 0;
    view.setInt32(index + 4, num, true); view.setInt32(index + 8, num, true);
    const data = realloc(view.getUint32(index, true), num * 2);
    view.setUint32(index, data, true);
    for (let i = 0; i < value.length; i++) view.setUint16(data - HEAP_BASE + 2 * i, value.charCodeAt(i), true);
    if (num) view.setUint16(data - HEAP_BASE + 2 * value.length, 0, true);
    stringSlots.add(address);
  }

  function readAt(address, kind) {
    // Direct DataView calls per kind (KINDS' widths and getters).
    switch (kind) {
      case 'u32': return view.getUint32(byteIndex(address, 4), true);
      case 'i32': return view.getInt32(byteIndex(address, 4), true);
      case 'f32': return view.getFloat32(byteIndex(address, 4), true);
      case 'u8': return view.getUint8(byteIndex(address, 1));
      case 'i8': return view.getInt8(byteIndex(address, 1));
      case 'u16': return view.getUint16(byteIndex(address, 2), true);
      case 'i16': return view.getInt16(byteIndex(address, 2), true);
      case 'ptr': return objectAt(view.getUint32(byteIndex(address, 4), true));
      case 'string': return readString(address);
      case 'name': return side.has(address) ? side.get(address) : 'None';
    }
    return fail(`Native heap does not support read kind ${kind}`, {kind});
  }

  function writeAt(address, kind, value) {
    if (kind === 'ptr') {
      view.setUint32(byteIndex(address, 4), addressOf(value), true);
      return;
    }
    if (kind === 'string' || kind === 'name') {
      if (typeof value !== 'string') fail(`Native heap ${kind} slot requires a string value`, {value});
      if (kind === 'string') writeString(address, value);
      else side.set(address, value);
      return;
    }
    const spec = KINDS[kind];
    if (!spec) fail(`Native heap does not support write kind ${kind}`, {kind});
    if (typeof value === 'boolean') value = value ? 1 : 0;
    if (typeof value !== 'number') fail(`Native heap ${kind} write requires a number`, {value, kind});
    if (kind !== 'f32' && !Number.isInteger(value))
      fail(`Native heap ${kind} write requires an integer`, {value, kind});
    const index = byteIndex(address, spec[0]);
    switch (kind) {
      case 'u32': view.setUint32(index, value, true); break;
      case 'i32': view.setInt32(index, value, true); break;
      case 'f32': view.setFloat32(index, value, true); break;
      case 'u8': view.setUint8(index, value); break;
      case 'i8': view.setInt8(index, value); break;
      case 'u16': view.setUint16(index, value, true); break;
      case 'i16': view.setInt16(index, value, true); break;
    }
    // A numeric store over a name slot invalidates the side value.
    if (side.size) for (let i = 0; i < spec[0]; i++) side.delete(address + i);
  }

  /** Object-relative access used by the window natives. */
  const read = (target, offset, kind) => readAt(absolute(target, offset), kind);
  const write = (target, offset, kind, value) => writeAt(absolute(target, offset), kind, value);
  function copyBytes(destination, source, count) {
    const values=[...side].filter(([at])=>at>=source&&at<source+count).map(([at,value])=>[destination+at-source,value]);
    // A moved FString keeps its Data; the slot that now holds it owns it.
    const moved=[...stringSlots].filter(at=>at>=source&&at<source+count);
    bytes.copyWithin(destination-HEAP_BASE,source-HEAP_BASE,source-HEAP_BASE+count);
    for(const at of side.keys())if(at>=destination&&at<destination+count)side.delete(at);
    for(const [at,value] of values)side.set(at,value);
    for(const at of moved)stringSlots.delete(at);
    for(const at of [...stringSlots])if(at>=destination&&at<destination+count)stringSlots.delete(at);
    for(const at of moved)stringSlots.add(destination+at-source);
  }

  /** Address-based access used by the XGC/UFont natives (hud-text shape). */
  const mem = {
    get bytes() { return bytes; },
    allocRaw: size => allocRaw(size),
    realloc: (address, size) => realloc(address, size),
    free: address => freeRaw(address >>> 0),
    read: (address, kind) => readAt(address >>> 0, kind),
    write: (address, kind, value) => writeAt(address >>> 0, kind, value),
  };

  const api = {
    get bytes() { return bytes; }, allocRaw, freeRaw, realloc, allocate, free, forget, isAllocated, addressOf, objectAt, read, write, mem, copyBytes,
    // End of the bump region (tools serialise [HEAP_BASE, usedEnd()) as a memory image).
    usedEnd: () => HEAP_BASE + next,
    objectAddress: object => {
      const record = objects.get(object);
      if (!record) fail('Native heap object has no address', {object});
      return record.address;
    },
    sizeOf: object => objects.get(object)?.size ?? 0,
    /** Byte length of the live allocRaw/realloc block at `address`, or undefined. */
    blockSize: address => blocks.get(address >>> 0),
    /** Every live block as [address, length] (validators hand them to oracles). */
    blockEntries: () => [...blocks],
    get used() { return next; },
    /** The arena offset of HEAP_BASE, or 0 without an arena. */
    region, capacity, base: HEAP_BASE,
  };
  return api;
}
