/** A load-graph record's native slots: byte offset -> value and the slot's byte width, in the order the offsets were first written.
 *
 * Host representation only (docs/live-heap.md, step 7 and "Load records and functions"). The slots used to be a Map of one {value, width}
 * cell per slot, about a million objects for the simulation worker's major GC to mark on the Island. Step 7 made them one array of
 * (key, value) pairs; the keys were the same few dozen numbers in every record, and the array, its wrapper and the record were three
 * objects. Here the slots are shaped like V8 shapes objects: a `SlotShape` is the ordered list of the keys (offset * 256 + width + 1, or
 * offset * 256 when the writer gave no width) a store has, shared by every store that took the same writes in the same order, and the
 * values are the store's indexed elements, one per key, in the same order. A record is its own slot store (LoadRecord extends NativeSlots,
 * script-load-graph.mjs), so a record is one object and its elements.
 *
 * The cell operations map onto two writes: `set` is the Map's set of a new cell (value and width replaced), `assign` the old
 * `cell.value = value` (an existing slot keeps its width; a new one takes the given width). The store itself stands for the record's
 * storage where an adapter needs an identity (the FArray and hash-table views of script-class-link.mjs and script-state-link.mjs).
 */
const NEAR = 0x800;           // offsets below this have a direct position table (the Island's go to 0x4d4)
const SMALL = 8;              // a shape this small is searched, not tabled
const MAX_OFFSET = 1 << 22;   // offset * 256 + 255 stays a small integer (V8's 31-bit Smi)
const MAX_WIDTH = 254;

const key = (offset, width) => {
  if (!Number.isInteger(offset) || offset < 0 || offset >= MAX_OFFSET)
    throw new TypeError(`Native slot offset ${String(offset)} is outside 0..0x${(MAX_OFFSET - 1).toString(16)}`);
  if (width === undefined) return offset * 256;
  if (!Number.isInteger(width) || width < 0 || width > MAX_WIDTH)
    throw new TypeError(`Native slot +0x${offset.toString(16)} width ${String(width)} is outside 0..${MAX_WIDTH}`);
  return offset * 256 + width + 1;
};

/** The ordered keys of the stores that share it, and the shapes one more key or one replaced key leads to. */
class SlotShape {
  constructor(keys) {
    this.keys = keys;
    this.size = keys.length;
    this.added = null;      // key -> the shape with that key appended
    this.replaced = null;   // position * 2^23 + key -> the shape with the key at that position replaced
    this.near = null;       // Int16Array: offset -> position, -1 when absent (built at the first search of a larger shape)
    this.far = null;        // Map: the offsets from NEAR up
  }

  /** The shape with `slotKey` appended. */
  add(slotKey) {
    let next = this.added?.get(slotKey);
    if (next === undefined) {
      next = new SlotShape([...this.keys, slotKey]);
      (this.added ??= new Map()).set(slotKey, next);
    }
    return next;
  }

  /** The shape with the key at `at` replaced. */
  replace(at, slotKey) {
    const id = at * 0x800000 + slotKey;
    let next = this.replaced?.get(id);
    if (next === undefined) {
      const keys = this.keys.slice();
      keys[at] = slotKey;
      next = new SlotShape(keys);
      (this.replaced ??= new Map()).set(id, next);
    }
    return next;
  }

  /** The offset's position, or -1. */
  position(offset) {
    if (typeof offset !== 'number') return -1;
    const keys = this.keys, size = this.size;
    if (size <= SMALL) {
      for (let at = 0; at < size; at++) if ((keys[at] >> 8) === offset) return at;
      return -1;
    }
    if (this.near === null) {
      const near = new Int16Array(NEAR).fill(-1);
      for (let at = 0; at < size; at++) {
        const at8 = keys[at] >> 8;
        if (at8 < NEAR) near[at8] = at; else (this.far ??= new Map()).set(at8, at);
      }
      this.near = near;
    }
    if (offset < NEAR) {
      const at = this.near[offset];
      return at === undefined ? -1 : at;
    }
    const at = this.far?.get(offset);
    return at === undefined ? -1 : at;
  }
}

const EMPTY = new SlotShape([]);

/** The record's slot value, or undefined when it has no such slot or no NativeSlots. */
export const slotValue = (record, offset) => record?.nativeSlots instanceof NativeSlots ? record.nativeSlots.value(offset) : undefined;

export class NativeSlots {
  constructor() {
    this.shape = EMPTY;
  }

  /** Fixtures: [offset, cell] entries, a cell being {value, width} (width optional) or the raw value. */
  static from(entries = []) {
    const slots = new NativeSlots();
    for (const [offset, cell] of entries) {
      if (cell !== null && typeof cell === 'object' && Object.hasOwn(cell, 'value')) slots.set(offset, cell.value, cell.width);
      else slots.set(offset, cell);
    }
    return slots;
  }

  /** The offset's position in the elements, or -1. */
  at(offset) { return this.shape.position(offset); }

  get size() { return this.shape.size; }

  has(offset) { return this.shape.position(offset) >= 0; }

  /** The slot's value, or undefined when the slot is absent. */
  value(offset) {
    const at = this.shape.position(offset);
    return at < 0 ? undefined : this[at];
  }

  /** The slot's width, or undefined when the slot is absent or its writer gave none. */
  width(offset) {
    const shape = this.shape, at = shape.position(offset);
    if (at < 0) return undefined;
    const code = shape.keys[at] & 255;
    return code === 0 ? undefined : code - 1;
  }

  /** The slot becomes (value, width), whether or not it was present. */
  set(offset, value, width) {
    const slotKey = key(offset, width), shape = this.shape, at = shape.position(offset);
    if (at >= 0) {
      if (shape.keys[at] !== slotKey) this.shape = shape.replace(at, slotKey);
      this[at] = value;
    } else this.append(slotKey, value);
    return value;
  }

  /** A present slot takes the value and keeps its width; an absent one is added with the given width. */
  assign(offset, value, width) {
    const at = this.shape.position(offset);
    if (at >= 0) this[at] = value;
    else this.append(key(offset, width), value);
    return value;
  }

  append(slotKey, value) {
    const shape = this.shape;
    this[shape.size] = value;
    this.shape = shape.add(slotKey);
  }

  /** fn(value, offset, width) for every slot, in first-write order (a slot fn adds is visited, as the array it was is). */
  forEach(fn) {
    for (let at = 0; at < this.shape.size; at++) {
      const code = this.shape.keys[at] & 255;
      fn(this[at], this.shape.keys[at] >> 8, code === 0 ? undefined : code - 1);
    }
  }
}
