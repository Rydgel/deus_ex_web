/**
 * Handle slots of the Rust interpreter's handle tables (interp.rs header,
 * HANDLES; docs/map-memory.md "The handle tables"): the class table
 * (interp.rs CLASSES), the receiver table (RECEIVERS) and the state table
 * (script-vm-states.mjs) hold an entry per slot. Host bookkeeping, not an
 * original structure.
 *
 * Handles are never reused (script-object-handles.mjs: a stale one resolves
 * to no object), so tables indexed by handle covered every handle the
 * process had allocated, each level's again, and a level's object arena grew
 * with every map change before it. A level's tables cover instead:
 *
 * - its window: the handles from `first`, the handle limit when the
 *   interpreter attached (the level's own handles), slot `oldCapacity +
 *   handle - first` while `handle - first` is below the table's capacity;
 *   a table grows its window to twice the handle it must cover;
 * - the old part: the handles below `first` live when the interpreter
 *   attached (the script process's, and in inline mode the previous level's
 *   until its host is disposed), the keys of an open-addressed table of
 *   `oldCapacity` u32 (a power of two at least twice their count, 0 empty,
 *   linear probing from `Math.imul(handle, 0x9e3779b1) >>> shift`), the slot
 *   a key's position. It never grows: no handle below `first` becomes live.
 *
 * Every other handle below `first` had been released when the level started
 * and has no slot: Rust reads its class entry as RELEASED, as the tables
 * indexed by handle had it, so a pointer holding it reads None; its
 * receiver and state lookups ask JavaScript, which describes no released
 * handle. Each table is `oldCapacity` slots, then its window. The mesh-light
 * selection's tables (script-vm-meshlight.mjs, caches of the level's lights
 * and actors) use the same slots.
 */
import {handleLimit, liveHandles} from './script-object-handles.mjs';

const HASH = 0x9e3779b1, MIN_OLD = 64;
/** The smallest window a table has. */
const MIN_WINDOW = 4096;

export class HandleSlots {
  constructor(arena) {
    this.arena = arena;
    this.first = 0;
    this.oldCapacity = 0;
    this.shift = 0;
    this.keys = 0;
    // Old handle -> its slot.
    this.old = new Map();
  }
  /** The interpreter attaches (RustScriptVm.attach), `at` its HANDLES words:
   * the window starts at the handle limit now, and the handles live below it
   * are the old part's keys. (`first` and `live` for validators.) */
  attach(at, first = handleLimit(), live = liveHandles()) {
    this.first = first;
    const keys = [];
    for (const handle of live) if (handle > 0 && handle < first) keys.push(handle);
    if (keys.length) {
      let capacity = MIN_OLD;
      while (capacity < 2 * keys.length) capacity *= 2;
      const mask = capacity - 1, base = this.arena.alloc(4 * capacity), view = this.arena.view;
      this.shift = 32 - Math.log2(capacity);
      keys.sort((a, b) => a - b);
      for (const handle of keys) {
        let slot = Math.imul(handle, HASH) >>> this.shift;
        while (view.getUint32(base + 4 * slot, true) !== 0) slot = slot + 1 & mask;
        view.setUint32(base + 4 * slot, handle, true);
        this.old.set(handle, slot);
      }
      this.keys = base;
      this.oldCapacity = capacity;
    }
    const view = this.arena.view;
    view.setUint32(at, this.first, true);
    view.setUint32(at + 4, this.keys, true);
    view.setUint32(at + 8, this.oldCapacity, true);
    view.setUint32(at + 12, this.shift, true);
  }
  /** `handle`'s slot in a table whose window is `capacity` handles, or -1:
   * None, at or beyond the window, or released before the level started. */
  slot(handle, capacity) {
    const i = handle - this.first;
    if (i >= 0) return i < capacity ? this.oldCapacity + i : -1;
    return handle > 0 ? this.old.get(handle) ?? -1 : -1;
  }
  /** Whether a table whose window is `capacity` handles must grow to give
   * `handle` a slot (a handle of the level beyond its window). */
  outside(handle, capacity) {
    return handle - this.first >= capacity;
  }
  /** The window a table grows to so that it covers `handle`. */
  windowFor(handle) {
    return Math.max(MIN_WINDOW, (Math.max(handle - this.first, 0) + 1) * 2);
  }
  /** The slots of a table whose window is `capacity` handles. */
  slotCount(capacity) {
    return this.oldCapacity + capacity;
  }
  /** A table of `size` bytes a slot (at `table`, window `capacity`, 0 for
   * none yet) grown to cover `handle`, or created: `[table, capacity]`, the
   * entries kept and the new ones zero. The old range is released. */
  grow(table, capacity, size, handle) {
    const arena = this.arena, next = this.windowFor(handle);
    const base = arena.alloc((this.oldCapacity + next) * size);
    if (table) {
      arena.bytes.copyWithin(base, table, table + (this.oldCapacity + capacity) * size);
      arena.release(table, (this.oldCapacity + capacity) * size);
    }
    return [base, next];
  }
}
