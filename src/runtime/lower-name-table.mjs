/** A table of texts that are equal when their `toLowerCase()` is, numbered in the order they were added: PreparedDynamicLoadGraph's name table.
 *
 * Host representation only (docs/live-heap.md "Package tables"). It was a `Map` from `text.toLowerCase()` to the next number, which made a lowercase
 * string of every distinct name (63,000 on the Island, most of DeusExConText's). This keeps the first text added for each number and compares through
 * the lowercase fold, so a text that is already in the package's tables is the one string both hold.
 *
 * The fold is `toLowerCase()`'s for the texts that are ASCII, as every package's names are. A text with another character takes its lowercase string
 * first (`toLowerCase` is not a per-character map: a final sigma, the dotted capital I, the Kelvin sign that lowercases to an ASCII `k`): a result
 * that is ASCII goes in the table as that string, any other result is a key of a small Map beside it. A text added to the table twice under one
 * spelling or another answers the same number, whichever form it comes in.
 */
const isAscii = text => {
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) > 0x7f) return false;
  return true;
};
const lowerCode = code => code >= 65 && code <= 90 ? code + 32 : code;
const lowerHash = text => {
  let hash = 0x811c9dc5 | 0;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ lowerCode(text.charCodeAt(index)), 16777619);
  return hash;
};
const lowerEqual = (a, b) => {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (lowerCode(a.charCodeAt(index)) !== lowerCode(b.charCodeAt(index))) return false;
  return true;
};

export class LowerNameTable {
  /** `first`: the number of the first text added. */
  constructor(first = 0) {
    this.first = first;
    this.texts = [];                    // the first text of each ASCII-keyed number, in order of addition; null for an exotic one
    this.numbers = new Int32Array(64);  // the number a position in `texts` has (they differ only when an exotic key took a number between)
    this.hashes = new Int32Array(64);
    this.slots = new Int32Array(128);   // positions in `texts` + 1
    this.mask = 127;
    this.exotic = null;                 // lowercase key (not ASCII) -> number
    this.count = 0;
  }

  get size() { return this.count; }

  /** The number of `text`, or -1 when it has none. */
  find(text) {
    let probe = text;
    if (!isAscii(probe)) {
      probe = probe.toLowerCase();
      if (!isAscii(probe)) return this.exotic?.get(probe) ?? -1;
    }
    const hash = lowerHash(probe), slots = this.slots, mask = this.mask;
    for (let slot = hash & mask; ; slot = (slot + 1) & mask) {
      const held = slots[slot];
      if (held === 0) return -1;
      const position = held - 1;
      if (this.hashes[position] === hash && lowerEqual(this.texts[position], probe)) return this.numbers[position];
    }
  }

  /** Give `text` the next number (the caller has found it absent). */
  add(text) {
    const number = this.first + this.count++;
    let probe = text;
    if (!isAscii(probe)) {
      probe = probe.toLowerCase();
      if (!isAscii(probe)) { (this.exotic ??= new Map()).set(probe, number); return number; }
    }
    const position = this.texts.length;
    if (position === this.hashes.length) {
      const hashes = new Int32Array(position * 2), numbers = new Int32Array(position * 2);
      hashes.set(this.hashes); numbers.set(this.numbers);
      this.hashes = hashes; this.numbers = numbers;
    }
    if ((position + 1) * 2 > this.slots.length) this.#rehash(this.slots.length * 2);
    this.texts.push(probe);
    this.numbers[position] = number;
    const hash = lowerHash(probe);
    this.hashes[position] = hash;
    this.#place(position, hash);
    return number;
  }

  #place(position, hash) {
    const slots = this.slots, mask = this.mask;
    let slot = hash & mask;
    while (slots[slot] !== 0) slot = (slot + 1) & mask;
    slots[slot] = position + 1;
  }

  #rehash(capacity) {
    this.slots = new Int32Array(capacity);
    this.mask = capacity - 1;
    for (let position = 0; position < this.texts.length; position += 1) this.#place(position, this.hashes[position]);
  }
}
