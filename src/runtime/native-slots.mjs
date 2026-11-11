/** A load-graph record's native slots: byte offset -> value and the slot's byte width, in the order the offsets were first written.
 *
 * Host representation only (docs/live-heap.md, steps 7 and "Load records and functions"; docs/firefox-60fps-plan.md "Native slots out of
 * the collector's marking"). The slots used to be a Map of one {value, width} cell per slot, about a million objects for the simulation
 * worker's major GC to mark on the Island. Step 7 made them one array of (key, value) pairs; then the slots were shaped like V8 shapes
 * objects: a `SlotShape` is the ordered list of the keys (offset * 256 + width + 1, or offset * 256 when the writer gave no width) a
 * store has, shared by every store that took the same writes in the same order, and the values were the store's indexed elements. A
 * record is its own slot store (LoadRecord extends NativeSlots, script-load-graph.mjs), so a record is one object and its words.
 *
 * Now a slot that holds an int32 (the load graph's names, sizes, flags, indexes and vtable words: 63% of the Island's 820,000 slots)
 * keeps it in an Int32Array, which a collector's marker never visits, where an array element is visited whatever it holds. Every other
 * value (null, a record or other object, a string, a number past int32, -0, NaN, a BigInt) is an indexed element of the store itself,
 * dense in the order the slots took to that representation. A slot is an int slot until it is given a value that is not an int32; from
 * then on it is an element slot (no way back: a slot that is given a null and then a number would otherwise move words on each flip).
 * Its int word is left unused, so no other slot's place changes.
 *
 * The int words are a block of a shared Int32Array chunk (4096 words, handed out by a bump allocator): a store costs no typed array
 * object of its own (one more cell for the marker, 35,000 on the Island), a block a store outgrows is left behind, a chunk is freed
 * when no store has a block in it, and the most a long-lived store can pin is the rest of its chunk. A block holds, from its first word
 * up, a header (the block's room, the int words and the elements used: so the store itself has three fields, a record being a
 * SpiderMonkey object of at most 16 fixed slots and its own thirteen leaving three), the store's int words and, from its last word down,
 * one code for each slot position: the rank of its int word (>= 0), or ~rank of its element (< 0). The code lives with the store, not in the shape, so the shapes stay the ones of the write orders (a shape that
 * said where each slot lives would be one for every combination of value kinds: 6,900 against 300 on the Island).
 *
 * The cell operations map onto two writes: `set` is the Map's set of a new cell (value and width replaced), `assign` the old
 * `cell.value = value` (an existing slot keeps its width; a new one takes the given width). The store itself stands for the record's
 * storage where an adapter needs an identity (the FArray and hash-table views of script-class-link.mjs and script-state-link.mjs).
 */
const NEAR = 0x800;           // offsets below this have a direct position table (the Island's go to 0x4d4)
const SMALL = 8;              // a shape this small is searched, not tabled
const MAX_OFFSET = 1 << 22;   // offset * 256 + 255 stays a small integer (V8's 31-bit Smi)
const MAX_WIDTH = 254;
const CHUNK = 4096;           // int words in a shared chunk
const OWN_BLOCK = 1024;       // a block this large has an Int32Array of its own
const HEADER = 3;             // a slot store's block starts with its room, its int words used and its elements used
const FIRST_BLOCK = 48;       // the first block of a slot store: the header, the words of 10 to 15 slots and the codes of 24 (the Island's records)
const FIRST_ENTRIES = 8;      // the first entries of an offset map

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

const NO_WORDS = new Int32Array(0);

let chunk = new Int32Array(CHUNK), claimed = 0;
let blockWords = NO_WORDS, blockBase = 0;

/** A block of `size` words: `blockWords` and `blockBase` name it. */
function claim(size) {
  if (size >= OWN_BLOCK) {
    blockWords = new Int32Array(size);
    blockBase = 0;
    return;
  }
  if (claimed + size > CHUNK) { chunk = new Int32Array(CHUNK); claimed = 0; }
  blockWords = chunk;
  blockBase = claimed;
  claimed += size;
}

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
    // Three fields, whatever the store holds: a record is a SpiderMonkey object of at most 16 fixed slots, and its own thirteen leave three.
    this.shape = EMPTY;
    this.intWords = NO_WORDS;   // the chunk (or array) that has the store's block
    this.intBase = 0;           // the block's first word: [room, intCount, refCount], the int words, free words, the position codes
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

  /** The words of the block (0 before the first slot): the header, the int words, the free words and the codes. */
  get intRoom() { return this.intWords === NO_WORDS ? 0 : this.intWords[this.intBase]; }

  /** The offset's position in the slot order, or -1. */
  at(offset) { return this.shape.position(offset); }

  get size() { return this.shape.size; }

  has(offset) { return this.shape.position(offset) >= 0; }

  /** The value of the slot at a position. */
  valueAt(at) {
    const words = this.intWords, base = this.intBase, code = words[base + words[base] - 1 - at];
    return code >= 0 ? words[base + HEADER + code] : this[~code];
  }

  /** The slot's value, or undefined when the slot is absent. */
  value(offset) {
    const at = this.shape.position(offset);
    if (at < 0) return undefined;
    const words = this.intWords, base = this.intBase, code = words[base + words[base] - 1 - at];
    return code >= 0 ? words[base + HEADER + code] : this[~code];
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
    const shape = this.shape;
    if (shape.keys[at] !== slotKey) this.shape = shape.replace(at, slotKey);
    const words = this.intWords, base = this.intBase, codeAt = base + words[base] - 1 - at, code = words[codeAt];
    if (code < 0) this[~code] = value;
    else if (isInt32(value)) words[base + HEADER + code] = value;
    else {
      const rank = words[base + 2]++;
      this[rank] = value;
      words[codeAt] = ~rank;
    }
  }

  append(slotKey, value) {
    const shape = this.shape, at = shape.size;
    if (this.intWords === NO_WORDS || HEADER + this.intWords[this.intBase + 1] + at + 2 > this.intWords[this.intBase]) this.grow(at);
    const words = this.intWords, base = this.intBase, codeAt = base + words[base] - 1 - at;
    if (isInt32(value)) {
      const rank = words[base + 1]++;
      words[base + HEADER + rank] = value;
      words[codeAt] = rank;
    } else {
      const rank = words[base + 2]++;
      this[rank] = value;
      words[codeAt] = ~rank;
    }
    this.shape = shape.add(slotKey);
  }

  /** The block becomes one half as large again, its int words and its `size` codes kept. */
  grow(size) {
    const from = this.intWords, start = this.intBase, first = from === NO_WORDS;
    const was = first ? 0 : from[start], ints = first ? 0 : from[start + 1], refs = first ? 0 : from[start + 2];
    const room = first ? FIRST_BLOCK : (was * 3 >> 1) + 7 & ~7;
    claim(room);
    const words = blockWords, base = blockBase;
    words[base] = room;
    words[base + 1] = ints;
    words[base + 2] = refs;
    for (let at = 0; at < ints; at++) words[base + HEADER + at] = from[start + HEADER + at];
    for (let at = 0; at < size; at++) words[base + room - 1 - at] = from[start + was - 1 - at];
    this.intWords = words;
    this.intBase = base;
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
 * byte offset -> value, in the order the offsets were first set. Every Map method the readers use answers as the Map did, and
 * `instanceof Map` holds; the Map itself stays empty. The entries are a block of the shared int chunks, with the storage of the slot
 * stores above: from the block's first word `room` offsets (a lookup is a scan of up to 100 of them: the maps are read when a class is
 * linked or a resource constructed, not per frame), then `room` codes (the rank of the entry's int word, or ~rank of its element), then
 * `room` int words. No shape: the order of a class's defaults is its own, so shapes would be one a class (6,900 shapes' worth of keys
 * on the Island). A key that is not a plain offset (an integer from 0 below 1 << 22) or a `delete` turns the store into an ordinary Map
 * for the rest of its life (`plain`), so nothing a Map accepts is refused; neither happens in the load graph. */
export class OffsetMap extends Map {
  constructor(entries) {
    super();
    this.intWords = NO_WORDS;
    this.intBase = 0;
    this.intRoom = 0;           // the entries the block has room for
    this.intCount = 0;          // the int words used
    this.refCount = 0;          // the elements used
    this.count = 0;             // the entries
    this.plain = false;
    if (entries !== undefined && entries !== null) for (const [offset, value] of entries) this.set(offset, value);
  }

  /** The store becomes the Map it stands for. */
  makePlain() {
    if (this.plain) return;
    const entries = [...this.entries()];
    for (let at = 0; at < this.refCount; at++) this[at] = undefined;
    this.intWords = NO_WORDS;
    this.intBase = 0;
    this.intRoom = this.intCount = this.refCount = this.count = 0;
    this.plain = true;
    for (const [offset, value] of entries) super.set(offset, value);
  }

  /** The entry's index, or -1. */
  indexOf(offset) {
    const words = this.intWords, base = this.intBase, count = this.count;
    for (let at = 0; at < count; at++) if (words[base + at] === offset) return at;
    return -1;
  }

  valueAt(at) {
    const code = this.intWords[this.intBase + this.intRoom + at];
    return code >= 0 ? this.intWords[this.intBase + 2 * this.intRoom + code] : this[~code];
  }

  get size() { return this.plain ? super.size : this.count; }

  has(offset) { return this.plain ? super.has(offset) : this.indexOf(offset) >= 0; }

  get(offset) {
    if (this.plain) return super.get(offset);
    const at = this.indexOf(offset);
    return at < 0 ? undefined : this.valueAt(at);
  }

  set(offset, value) {
    if (this.plain) return super.set(offset, value);
    if (!Number.isInteger(offset) || offset < 0 || offset >= MAX_OFFSET) {
      this.makePlain();
      return super.set(offset, value);
    }
    const at = this.indexOf(offset);
    if (at >= 0) this.store(at, value); else this.append(offset, value);
    return this;
  }

  /** The entry at `at` takes the value (an int slot given a value that is not an int32 becomes an element slot). */
  store(at, value) {
    const words = this.intWords, codeAt = this.intBase + this.intRoom + at, code = words[codeAt];
    if (code < 0) this[~code] = value;
    else if (isInt32(value)) words[this.intBase + 2 * this.intRoom + code] = value;
    else {
      this[this.refCount] = value;
      words[codeAt] = ~this.refCount++;
    }
  }

  append(offset, value) {
    const at = this.count;
    if (at === this.intRoom) this.grow();
    const words = this.intWords, base = this.intBase, room = this.intRoom;
    words[base + at] = offset;
    if (isInt32(value)) {
      words[base + 2 * room + this.intCount] = value;
      words[base + room + at] = this.intCount++;
    } else {
      this[this.refCount] = value;
      words[base + room + at] = ~this.refCount++;
    }
    this.count = at + 1;
  }

  /** The block becomes one half as large again. */
  grow() {
    const from = this.intWords, start = this.intBase, was = this.intRoom, count = this.count;
    const room = was === 0 ? FIRST_ENTRIES : (was * 3 >> 1) + 7 & ~7;
    claim(room * 3);
    const words = blockWords, base = blockBase;
    for (let at = 0; at < count; at++) {
      words[base + at] = from[start + at];
      words[base + room + at] = from[start + was + at];
    }
    for (let at = 0; at < this.intCount; at++) words[base + 2 * room + at] = from[start + 2 * was + at];
    this.intWords = words;
    this.intBase = base;
    this.intRoom = room;
  }

  delete(offset) {
    if (!this.has(offset)) return false;
    this.makePlain();
    return super.delete(offset);
  }

  clear() {
    if (this.plain) { super.clear(); return; }
    for (let at = 0; at < this.refCount; at++) this[at] = undefined;
    this.intWords = NO_WORDS;
    this.intBase = 0;
    this.intRoom = this.intCount = this.refCount = this.count = 0;
  }

  /** [offset, value] for every entry in order (an entry added during the walk is visited, as the Map's iterators do). */
  * entries() {
    if (this.plain) { yield* super.entries(); return; }
    for (let at = 0; at < this.count; at++) yield [this.intWords[this.intBase + at], this.valueAt(at)];
  }

  * keys() {
    if (this.plain) { yield* super.keys(); return; }
    for (let at = 0; at < this.count; at++) yield this.intWords[this.intBase + at];
  }

  * values() {
    if (this.plain) { yield* super.values(); return; }
    for (let at = 0; at < this.count; at++) yield this.valueAt(at);
  }

  [Symbol.iterator]() { return this.entries(); }

  forEach(fn, thisArg) {
    if (this.plain) { super.forEach(fn, thisArg); return; }
    for (let at = 0; at < this.count; at++) fn.call(thisArg, this.valueAt(at), this.intWords[this.intBase + at], this);
  }
}
