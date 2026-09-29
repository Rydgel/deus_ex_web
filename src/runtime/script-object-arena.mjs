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
const PAGE = 65536, ALIGN = 16;
export const RESERVED = 0x200000;

export class ObjectArena {
  constructor(pages = 64) {
    this.memory = new WebAssembly.Memory({initial: pages});
    // Nothing below RESERVED is handed out, so a zero base still means "no
    // image".
    this.top = RESERVED;
    this.free = new Map();
    this.released = [];
    this.refresh();
  }
  /** Re-derive the views after the memory buffer was replaced. */
  refresh() {
    const buffer = this.memory.buffer;
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
  }
  /** A zeroed range of `size` bytes; returns its base. */
  alloc(size) {
    const aligned = Math.max(ALIGN, (size + ALIGN - 1) & ~(ALIGN - 1));
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
  reclaim() {
    const released = this.released;
    for (let i = 0; i < released.length; i += 2) {
      let list = this.free.get(released[i + 1]);
      if (!list) this.free.set(released[i + 1], list = []);
      list.push(released[i]);
    }
    released.length = 0;
  }
}
