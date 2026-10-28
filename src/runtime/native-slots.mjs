/** A load-graph record's native slots: byte offset -> value and the slot's byte width, in the order the offsets were first written.
 *
 * Host representation only (docs/live-heap.md, step 7). The slots used to be a Map of one {value, width} cell per slot, about a
 * million objects for the simulation worker's major GC to mark on the Island. Here they are one array of pairs: the key
 * (offset * 256 + width + 1, or offset * 256 when the writer gave no width), then the value. A record has a few dozen slots at most,
 * so a lookup scans the keys; a store that grows past INDEXED slots (the 256-word hash tables tests build) also gets an offset index.
 *
 * The cell operations map onto two writes: `set` is the Map's set of a new cell (value and width replaced), `assign` the old
 * `cell.value = value` (an existing slot keeps its width; a new one takes the given width). The store itself stands for the record's
 * storage where an adapter needs an identity (the FArray and hash-table views of script-class-link.mjs and script-state-link.mjs).
 */
const INDEXED = 64;
const MAX_OFFSET = 1 << 22; // offset * 256 + 255 stays a small integer (V8's 31-bit Smi)
const MAX_WIDTH = 254;

const key = (offset, width) => {
  if (!Number.isInteger(offset) || offset < 0 || offset >= MAX_OFFSET)
    throw new TypeError(`Native slot offset ${String(offset)} is outside 0..0x${(MAX_OFFSET - 1).toString(16)}`);
  if (width === undefined) return offset * 256;
  if (!Number.isInteger(width) || width < 0 || width > MAX_WIDTH)
    throw new TypeError(`Native slot +0x${offset.toString(16)} width ${String(width)} is outside 0..${MAX_WIDTH}`);
  return offset * 256 + width + 1;
};

/** The record's slot value, or undefined when it has no such slot or no NativeSlots. */
export const slotValue = (record, offset) => record?.nativeSlots instanceof NativeSlots ? record.nativeSlots.value(offset) : undefined;

export class NativeSlots {
  constructor() {
    this.pairs = [];
    this.index = null;
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

  /** The key's position in `pairs`, or -1. */
  at(offset) {
    if (this.index !== null) {
      const at = this.index.get(offset);
      return at === undefined ? -1 : at;
    }
    const pairs = this.pairs;
    for (let at = 0; at < pairs.length; at += 2) if ((pairs[at] >> 8) === offset) return at;
    return -1;
  }

  get size() { return this.pairs.length >> 1; }

  has(offset) { return this.at(offset) >= 0; }

  /** The slot's value, or undefined when the slot is absent. */
  value(offset) {
    const at = this.at(offset);
    return at < 0 ? undefined : this.pairs[at + 1];
  }

  /** The slot's width, or undefined when the slot is absent or its writer gave none. */
  width(offset) {
    const at = this.at(offset);
    if (at < 0) return undefined;
    const code = this.pairs[at] & 255;
    return code === 0 ? undefined : code - 1;
  }

  /** The slot becomes (value, width), whether or not it was present. */
  set(offset, value, width) {
    const slotKey = key(offset, width), at = this.at(offset);
    if (at >= 0) {
      this.pairs[at] = slotKey;
      this.pairs[at + 1] = value;
    } else this.append(offset, slotKey, value);
    return value;
  }

  /** A present slot takes the value and keeps its width; an absent one is added with the given width. */
  assign(offset, value, width) {
    const at = this.at(offset);
    if (at >= 0) this.pairs[at + 1] = value;
    else this.append(offset, key(offset, width), value);
    return value;
  }

  append(offset, slotKey, value) {
    const pairs = this.pairs;
    if (this.index !== null) this.index.set(offset, pairs.length);
    pairs.push(slotKey, value);
    if (this.index === null && pairs.length > 2 * INDEXED) {
      this.index = new Map();
      for (let at = 0; at < pairs.length; at += 2) this.index.set(pairs[at] >> 8, at);
    }
  }

  /** fn(value, offset, width) for every slot, in first-write order. */
  forEach(fn) {
    const pairs = this.pairs;
    for (let at = 0; at < pairs.length; at += 2) {
      const code = pairs[at] & 255;
      fn(pairs[at + 1], pairs[at] >> 8, code === 0 ? undefined : code - 1);
    }
  }
}
