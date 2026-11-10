/** A load-graph record's native slots: byte offset -> value and the slot's byte width, in the order the offsets were first written.
 *
 * Host representation only (docs/live-heap.md, steps 7 and "Load records and functions"; docs/firefox-60fps-plan.md "Native slots out of
 * the collector's marking"). The slots used to be a Map of one {value, width} cell per slot, about a million objects for the simulation
 * worker's major GC to mark on the Island. Step 7 made them one array of (key, value) pairs; then the slots were shaped like V8 shapes
 * objects: a `SlotShape` is the ordered list of the keys (offset * 256 + width + 1, or offset * 256 when the writer gave no width) a
 * store has, shared by every store that took the same writes in the same order. A record is its own slot store (LoadRecord extends
 * NativeSlots, script-load-graph.mjs), so a record is one object and its words.
 *
 * Where the words live depends on what they hold, and the shape says which for each slot. A slot that holds an int32 (the load graph's
 * names, sizes, flags, indexes and vtable words: 63% of the Island's 820,000 slots) keeps it in `ints`, one Int32Array a store: a typed
 * array's contents are never visited by a collector's marker, where an array element is visited whatever it holds. Every other value
 * (null, a record or other object, a string, a number past int32, -0, NaN, a BigInt) is an indexed element of the store itself, dense in
 * the order the slots took to that representation. A slot is an int slot until it is given a value that is not an int32; from then on it
 * is an element slot (no way back: a slot that is given a null and then a number would otherwise move words on each flip, and the
 * shape would depend on the value written last). Its int word is left unused, so no other slot's place changes. `index` of the shape
 * answers a slot's place: an int rank (>= 0) in `ints`, or ~rank (< 0) among the elements.
 *
 * The cell operations map onto two writes: `set` is the Map's set of a new cell (value and width replaced), `assign` the old
 * `cell.value = value` (an existing slot keeps its width; a new one takes the given width). The store itself stands for the record's
 * storage where an adapter needs an identity (the FArray and hash-table views of script-class-link.mjs and script-state-link.mjs).
 */
const NEAR = 0x800;           // offsets below this have a direct position table (the Island's go to 0x4d4)
const SMALL = 8;              // a shape this small is searched, not tabled
const MAX_OFFSET = 1 << 22;   // offset * 256 + 255 stays a small integer (V8's 31-bit Smi)
const MAX_WIDTH = 254;
const INTS = 16;              // the first capacity of a store's int words (64 bytes: V8 keeps a typed array this small on its heap)

const key = (offset, width) => {
  if (!Number.isInteger(offset) || offset < 0 || offset >= MAX_OFFSET)
    throw new TypeError(`Native slot offset ${String(offset)} is outside 0..0x${(MAX_OFFSET - 1).toString(16)}`);
  if (width === undefined) return offset * 256;
  if (!Number.isInteger(width) || width < 0 || width > MAX_WIDTH)
    throw new TypeError(`Native slot +0x${offset.toString(16)} width ${String(width)} is outside 0..${MAX_WIDTH}`);
  return offset * 256 + width + 1;
};

/** True when the value is exactly an int32 (-0 is not: an Int32Array would read it back as 0). */
const isInt32 = value => typeof value === 'number' && (value | 0) === value && (value !== 0 || 1 / value > 0);

const NO_INTS = new Int32Array(0);

/** The ordered keys of the stores that share it, where each slot's value lives, and the shapes one more key, one replaced key or one
 * slot moved to the elements leads to. */
class SlotShape {
  constructor(keys, index, ints, refs) {
    this.keys = keys;
    this.size = keys.length;
    this.index = index;     // Int32Array: position -> rank in `ints` (>= 0), or ~rank among the elements; shared by the replacements
    this.ints = ints;       // the int words a store of this shape has allocated (an unused one of a slot that moved included)
    this.refs = refs;       // the elements a store of this shape has
    this.addedInt = null;   // key -> the shape with that key appended as an int slot
    this.addedRef = null;   // key -> the shape with that key appended as an element slot
    this.replaced = null;   // position * 2^23 + key -> the shape with the key at that position replaced
    this.moved = null;      // position * 2^23 + key -> the shape with the int slot at that position moved to the elements
    this.near = null;       // Int16Array: offset -> position, -1 when absent (built at the first search of a larger shape)
    this.far = null;        // Map: the offsets from NEAR up
  }

  /** The shape with `slotKey` appended, as an int slot or as an element slot. */
  add(slotKey, element) {
    let next = (element ? this.addedRef : this.addedInt)?.get(slotKey);
    if (next === undefined) {
      const size = this.size, index = new Int32Array(size + 1);
      index.set(this.index);
      index[size] = element ? ~this.refs : this.ints;
      next = new SlotShape([...this.keys, slotKey], index, this.ints + (element ? 0 : 1), this.refs + (element ? 1 : 0));
      if (element) (this.addedRef ??= new Map()).set(slotKey, next); else (this.addedInt ??= new Map()).set(slotKey, next);
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
      next = new SlotShape(keys, this.index, this.ints, this.refs);
      (this.replaced ??= new Map()).set(id, next);
    }
    return next;
  }

  /** The shape with the int slot at `at` moved to the elements (as the last of them), under `slotKey`. */
  move(at, slotKey) {
    const id = at * 0x800000 + slotKey;
    let next = this.moved?.get(id);
    if (next === undefined) {
      const keys = this.keys.slice(), index = this.index.slice();
      keys[at] = slotKey;
      index[at] = ~this.refs;
      next = new SlotShape(keys, index, this.ints, this.refs + 1);
      (this.moved ??= new Map()).set(id, next);
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

const EMPTY = new SlotShape([], new Int32Array(0), 0, 0);

/** The record's slot value, or undefined when it has no such slot or no NativeSlots. */
export const slotValue = (record, offset) => record?.nativeSlots instanceof NativeSlots ? record.nativeSlots.value(offset) : undefined;

export class NativeSlots {
  constructor() {
    this.shape = EMPTY;
    this.ints = NO_INTS;
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

  /** The offset's position in the slot order, or -1. */
  at(offset) { return this.shape.position(offset); }

  get size() { return this.shape.size; }

  has(offset) { return this.shape.position(offset) >= 0; }

  /** The value of the slot at a position. */
  valueAt(at) {
    const index = this.shape.index[at];
    return index >= 0 ? this.ints[index] : this[~index];
  }

  /** The slot's value, or undefined when the slot is absent. */
  value(offset) {
    const shape = this.shape, at = shape.position(offset);
    if (at < 0) return undefined;
    const index = shape.index[at];
    return index >= 0 ? this.ints[index] : this[~index];
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
    const slotKey = key(offset, width), at = this.shape.position(offset);
    if (at >= 0) this.store(at, slotKey, value); else this.append(slotKey, value);
    return value;
  }

  /** A present slot takes the value and keeps its width; an absent one is added with the given width. */
  assign(offset, value, width) {
    const shape = this.shape, at = shape.position(offset);
    if (at >= 0) this.store(at, shape.keys[at], value); else this.append(key(offset, width), value);
    return value;
  }

  /** The present slot at `at` takes the value under `slotKey` (its own key keeps its width). */
  store(at, slotKey, value) {
    const shape = this.shape, index = shape.index[at];
    if (index < 0) {
      if (shape.keys[at] !== slotKey) this.shape = shape.replace(at, slotKey);
      this[~index] = value;
    } else if (isInt32(value)) {
      if (shape.keys[at] !== slotKey) this.shape = shape.replace(at, slotKey);
      this.ints[index] = value;
    } else {
      this[shape.refs] = value;
      this.shape = shape.move(at, slotKey);
    }
  }

  append(slotKey, value) {
    const shape = this.shape;
    if (isInt32(value)) {
      const at = shape.ints;
      if (at >= this.ints.length) {
        const ints = new Int32Array(this.ints.length === 0 ? INTS : this.ints.length * 2);
        ints.set(this.ints);
        this.ints = ints;
      }
      this.ints[at] = value;
      this.shape = shape.add(slotKey, false);
    } else {
      this[shape.refs] = value;
      this.shape = shape.add(slotKey, true);
    }
  }

  /** fn(value, offset, width) for every slot, in first-write order (a slot fn adds is visited, as the array it was is). */
  forEach(fn) {
    for (let at = 0; at < this.shape.size; at++) {
      const code = this.shape.keys[at] & 255;
      fn(this.valueAt(at), this.shape.keys[at] >> 8, code === 0 ? undefined : code - 1);
    }
  }
}

/** A resource's instance memory above +0x28 (`record.instanceValues`) and a class's default data (`record.defaults.data`): a Map of
 * byte offset -> value, in the order the offsets were first set, with the slots' storage (shapes, int32 words in a typed array, the
 * other values as elements: the header comment). Every Map method the readers use answers as the Map did, and `instanceof Map` holds;
 * the Map itself stays empty. A key that is not a plain offset (an integer from 0 below 1 << 22) or a `delete` turns the store into an
 * ordinary Map for the rest of its life (`plain`), so nothing a Map accepts is refused; neither happens in the load graph. */
export class OffsetMap extends Map {
  constructor(entries) {
    super();
    this.shape = EMPTY;
    this.ints = NO_INTS;
    this.plain = false;
    if (entries !== undefined && entries !== null) for (const [offset, value] of entries) this.set(offset, value);
  }

  /** The store becomes the Map it stands for. */
  makePlain() {
    if (this.plain) return;
    const entries = [...this.entries()];
    for (let at = 0; at < this.shape.refs; at++) this[at] = undefined;
    this.shape = EMPTY;
    this.ints = NO_INTS;
    this.plain = true;
    for (const [offset, value] of entries) super.set(offset, value);
  }

  get size() { return this.plain ? super.size : this.shape.size; }

  has(offset) { return this.plain ? super.has(offset) : this.shape.position(offset) >= 0; }

  get(offset) {
    if (this.plain) return super.get(offset);
    const shape = this.shape, at = shape.position(offset);
    if (at < 0) return undefined;
    const index = shape.index[at];
    return index >= 0 ? this.ints[index] : this[~index];
  }

  set(offset, value) {
    if (this.plain) return super.set(offset, value);
    if (!Number.isInteger(offset) || offset < 0 || offset >= MAX_OFFSET) {
      this.makePlain();
      return super.set(offset, value);
    }
    const at = this.shape.position(offset);
    if (at >= 0) this.store(at, this.shape.keys[at], value); else this.append(offset * 256, value);
    return this;
  }

  delete(offset) {
    if (!this.has(offset)) return false;
    this.makePlain();
    return super.delete(offset);
  }

  clear() {
    if (this.plain) { super.clear(); return; }
    for (let at = 0; at < this.shape.refs; at++) this[at] = undefined;
    this.shape = EMPTY;
    this.ints = NO_INTS;
  }

  /** [offset, value] for every entry in order (an entry added during the walk is visited, as the Map's iterators do). */
  * entries() {
    if (this.plain) { yield* super.entries(); return; }
    for (let at = 0; at < this.shape.size; at++) yield [this.shape.keys[at] >> 8, this.valueAt(at)];
  }

  * keys() {
    if (this.plain) { yield* super.keys(); return; }
    for (let at = 0; at < this.shape.size; at++) yield this.shape.keys[at] >> 8;
  }

  * values() {
    if (this.plain) { yield* super.values(); return; }
    for (let at = 0; at < this.shape.size; at++) yield this.valueAt(at);
  }

  [Symbol.iterator]() { return this.entries(); }

  forEach(fn, thisArg) {
    if (this.plain) { super.forEach(fn, thisArg); return; }
    for (let at = 0; at < this.shape.size; at++) fn.call(thisArg, this.valueAt(at), this.shape.keys[at] >> 8, this);
  }
}

OffsetMap.prototype.valueAt = NativeSlots.prototype.valueAt;
OffsetMap.prototype.store = NativeSlots.prototype.store;
OffsetMap.prototype.append = NativeSlots.prototype.append;
