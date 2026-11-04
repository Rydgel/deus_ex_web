/** One linear memory for script-object property images (docs/rust-core.md,
 * step R0). An object's image is the byte range [base, base + size) at the
 * stage 1d layout (docs/object-memory.md); its reference array stays a
 * per-object JavaScript array until step R1.
 *
 * The memory is a WebAssembly.Memory so the Rust core can import it. Growing
 * it replaces the ArrayBuffer, so callers read `view`/`bytes` from the arena
 * at each access and never keep them across an allocation.
 *
 * A released range is not reused at once: a reference the VM built before the
 * release (a CellStorage) keeps reading the old bytes, as it read the old
 * per-object buffer. `reclaim()` makes released ranges reusable; the level
 * tick calls it before any actor runs, when no such reference is live.
 *
 * The low 2 MiB are reserved for the Rust script VM (native/script-vm), which
 * imports this memory: its 1 MiB shadow stack and its statics (build.rs,
 * --stack-first) end below RESERVED, so images start there. */
const PAGE = 65536, ALIGN = 16, MIN_SPLIT = 256;
export const RESERVED = 0x200000;

export class ObjectArena {
  /** `coalesce`: a reclaimed range joins an address-ordered free list, merged
   * with its free neighbours (and given back to the top when it ends there),
   * and a request takes the smallest free range it fits, split when the rest
   * is worth keeping (script-vm-kernel.mjs's block allocator). For an arena
   * that outlives the levels whose ranges it holds (the trace kernel's, one a
   * realm): with exact-size reuse, each map's BSP models, sized by its own
   * level, took fresh space at the top, so the memory grew with every
   * distinct map a process visited (docs/map-memory.md). A level's own arena
   * keeps exact-size reuse. */
  constructor(pages = 64, {coalesce = false} = {}) {
    this.memory = new WebAssembly.Memory({initial: pages});
    // Nothing below RESERVED is handed out, so a zero base still means "no
    // image".
    this.top = RESERVED;
    this.free = new Map();
    this.released = [];
    this.blocks = coalesce ? [] : null;  // {at, bytes}, by address
    // (`coalesce`: the bytes each range was given, which a whole free range's spare tail makes larger than its request)
    this.sizes = coalesce ? new Map() : null;
    // Callbacks that keep views over a range current (the window host's
    // native heap, script-native-heap.mjs).
    this.listeners = [];
    // What an object's release token reaches this arena through (script-runtime.mjs
    // imageFinalizer, whose records outlive the level): detach clears it.
    this.owner = {arena: this};
    this.refresh();
  }
  /** The level that owned this arena is gone (sim-host.mjs dispose): the
   * process-wide finalizer's records of its objects, which live until each
   * object is collected and its cleanup has run, no longer hold the memory,
   * and the views' callbacks (closures over the runtime) go. Without this a
   * left level's memory waited for every one of its objects' cleanups and
   * then another collection, several map changes in Firefox
   * (docs/map-memory.md). */
  detach() {
    this.owner.arena = null;
    this.listeners.length = 0;
  }
  /** Re-derive the views after the memory buffer was replaced. */
  refresh() {
    const buffer = this.memory.buffer;
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    for (const listener of this.listeners) listener(buffer);
  }
  /** A zeroed range of `size` bytes; returns its base. */
  alloc(size) {
    const aligned = Math.max(ALIGN, (size + ALIGN - 1) & ~(ALIGN - 1));
    if (this.blocks) return this.allocBlock(aligned);
    const list = this.free.get(aligned);
    if (list?.length) {
      const base = list.pop();
      this.bytes.fill(0, base, base + aligned);
      return base;
    }
    const base = this.top, end = base + aligned, capacity = this.memory.buffer.byteLength;
    if (end > capacity) {
      // Fresh pages are zero. Grow by at least half the current size so a
      // level's objects cause few buffer replacements.
      const needed = Math.ceil((end - capacity) / PAGE);
      this.memory.grow(Math.max(needed, Math.ceil(capacity / PAGE / 2)));
      this.refresh();
    }
    this.top = end;
    return base;
  }
  /** A view of one range, for callers that address an image from zero. */
  window(base, size) {
    return new DataView(this.memory.buffer, base, size);
  }
  /** A copy of a range's bytes as a standalone ArrayBuffer. */
  snapshot(base, size) {
    return this.bytes.slice(base, base + size).buffer;
  }
  release(base, size) {
    if (base) this.released.push(base, Math.max(ALIGN, (size + ALIGN - 1) & ~(ALIGN - 1)));
  }
  /** `coalesce`'s alloc: the smallest free range that fits, else the top
   * (zeroed below the memory's size, which a range given back may have left
   * dirty). */
  allocBlock(aligned) {
    const blocks = this.blocks;
    let best = -1;
    for (let i = 0; i < blocks.length; i++) {
      const bytes = blocks[i].bytes;
      if (bytes >= aligned && (best < 0 || bytes < blocks[best].bytes)) { best = i; if (bytes === aligned) break; }
    }
    if (best >= 0) {
      const block = blocks[best], base = block.at;
      if (block.bytes - aligned >= MIN_SPLIT) { block.at += aligned; block.bytes -= aligned; }
      else { blocks.splice(best, 1); aligned = block.bytes; }
      this.bytes.fill(0, base, base + aligned);
      this.sizes.set(base, aligned);
      return base;
    }
    const base = this.top, end = base + aligned, capacity = this.memory.buffer.byteLength;
    if (end > capacity) {
      const needed = Math.ceil((end - capacity) / PAGE);
      this.memory.grow(Math.max(needed, Math.ceil(capacity / PAGE / 2)));
      this.refresh();
    }
    if (base < capacity) this.bytes.fill(0, base, Math.min(end, capacity));
    this.top = end;
    this.sizes.set(base, aligned);
    return base;
  }
  /** `coalesce`'s reclaim of one range. */
  freeBlock(at, bytes) {
    const blocks = this.blocks;
    let lo = 0, hi = blocks.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (blocks[mid].at < at) lo = mid + 1; else hi = mid; }
    let index = lo, block;
    const before = blocks[lo - 1];
    if (before && before.at + before.bytes === at) { before.bytes += bytes; block = before; index = lo - 1; }
    else { block = {at, bytes}; blocks.splice(lo, 0, block); }
    const after = blocks[index + 1];
    if (after && block.at + block.bytes === after.at) { block.bytes += after.bytes; blocks.splice(index + 1, 1); }
    if (block.at + block.bytes === this.top) { this.top = block.at; blocks.splice(index, 1); }
  }
  reclaim() {
    const released = this.released;
    if (this.blocks) {
      for (let i = 0; i < released.length; i += 2) {
        const at = released[i], bytes = this.sizes.get(at) ?? released[i + 1];
        this.sizes.delete(at);
        this.freeBlock(at, bytes);
      }
      released.length = 0;
      return;
    }
    for (let i = 0; i < released.length; i += 2) {
      let list = this.free.get(released[i + 1]);
      if (!list) this.free.set(released[i + 1], list = []);
      list.push(released[i]);
    }
    released.length = 0;
  }
}
