/** What the process knows of one linked script: the identities its bytecode refers to, which identity each expanded operand is, and the
 * null-Context results prepared for it. One object a script, and its numbers in shared Int32Array chunks.
 *
 * Host representation only (docs/firefox-60fps-plan.md "The per-script offset tables"). It was three WeakMap entries and three Maps a
 * script (`linkedScripts`: package index -> identity, `linkedOperands`: expression offset -> identity, `contextResults`: offset ->
 * descriptor object), 7,200 scripts on the Island with 86,000 operands, 38,000 bindings and 11,700 descriptors. A collector's marker
 * visits every key, value and chain word of a Map and every slot of an object, and a typed array's words not at all.
 *
 * The block (Int32 words of a shared chunk, from `base`):
 *
 *   [0] bindings  [1] operands
 *   the package index of each binding, in the order the script first refers to them (the order of the Map's entries)
 *   the expression offset of each operand, ascending (a lookup is a binary search: the Rust interpreter and the compiled bodies keep
 *   what they resolved while ScriptObjects.operandEpoch is unchanged, so the hot paths read a few dozen a tick)
 *   the binding position of each operand, in offset order
 *
 * The elements of the object are the bindings' identities (position 0 to bindings - 1: `get(index)` is their Map's `get`) and, after
 * `prepared`, the context results' key and metadata (two a result, in order of the result's value offset). It is an Array so that
 * the engine makes the element store exactly as long as it is (an object's own elements start at 17 slots in V8), and its Array methods
 * other than the ones the bindings Map had are not for use. An operand is its binding's identity until something writes it (the GC
 * archive clears one: ScriptObjects.operandReference), which `overrides` (operand position -> value) then holds; the binding is as it
 * was, because `reference(script, index)` asks for the identity the package index names, whatever an expanded occurrence of it says.
 *
 * The null-Context results (script-context-results.mjs) are another block: [0] count, then the results' value offsets (ascending), their
 * context offsets, their widths (NO_WIDTH when the result's descriptor had none) and their type codes. `contextWords` is null until a
 * script's results are prepared, so that a script that was never prepared and one that has no result stay apart as they were.
 */
const CHUNK = 4096;       // words in a shared chunk
const OWN_BLOCK = 1024;   // a block this large has an Int32Array of its own
const NO_WIDTH = -1;

let chunk = new Int32Array(CHUNK), claimed = 0;
let blockWords = chunk, blockBase = 0;

/** A block of `size` words: `blockWords` and `blockBase` name it. A chunk is freed when no script's block is left in it. */
function claim(size) {
  if (size >= OWN_BLOCK) { blockWords = new Int32Array(size); blockBase = 0; return; }
  if (claimed + size > CHUNK) { chunk = new Int32Array(CHUNK); claimed = 0; }
  blockWords = chunk;
  blockBase = claimed;
  claimed += size;
}

const NO_BLOCK = new Int32Array(1);   // a prepared script with no result: count 0

export class ScriptLinks extends Array {
  /** `length` is the number of elements the object will hold (the bindings, and two a context result). */
  constructor(length, words, base) {
    super(length);
    this.words = words;
    this.base = base;
    this.overrides = null;      // operand position -> value, once an operand is written
    this.contextWords = null;   // the null-Context block, once the script's results are prepared
    this.contextBase = 0;
  }

  // Array methods that make a new array would call this class with a length: they are not for use.
  static get [Symbol.species]() { return Array; }

  /** The links of a script: `indexes` are the package indexes its bytecode refers to, in first-reference order, `identities` what they
   * resolved to; `offsets` and `positions` are the expanded operands (a binding position each) in any order. An offset that appears
   * twice keeps its last position, as a Map's `set` did. */
  static make(indexes, identities, offsets, positions) {
    const bindings = indexes.length;
    let operands = offsets.length;
    let order = null;
    for (let at = 1; at < operands; at++) if (offsets[at - 1] >= offsets[at]) { order = sortedOrder(offsets); break; }
    if (order !== null) {
      // the operands in offset order; of equal offsets (a later one overwrote an earlier one in the Map) the last
      let kept = 0;
      for (let at = 0; at < operands; at++) {
        const here = order[at];
        if (kept > 0 && offsets[order[kept - 1]] === offsets[here]) order[kept - 1] = here; else order[kept++] = here;
      }
      operands = kept;
    }
    claim(2 + bindings + 2 * operands);
    const words = blockWords, base = blockBase, links = new ScriptLinks(bindings, words, base);
    words[base] = bindings;
    words[base + 1] = operands;
    for (let at = 0; at < bindings; at++) {
      words[base + 2 + at] = indexes[at];
      links[at] = identities[at];
    }
    const offsetAt = base + 2 + bindings, positionAt = offsetAt + operands;
    for (let at = 0; at < operands; at++) {
      const from = order === null ? at : order[at];
      words[offsetAt + at] = offsets[from];
      words[positionAt + at] = positions[from];
    }
    return links;
  }

  /** The same links with the null-Context results of `entries` (one object a result: {offset, contextOffset, width, type, key,
   * metadata}, `offset` ascending, `width` NO_WIDTH or an int32, `type` a small code): a new object, as long as its elements need
   * to be. An empty list marks a script that holds no results yet prepared on the object itself. */
  prepared(entries) {
    const count = entries.length, bindings = this.words[this.base];
    if (count === 0 && this.length === bindings) { this.contextWords = NO_BLOCK; this.contextBase = 0; return this; }
    const next = new ScriptLinks(bindings + 2 * count, this.words, this.base);
    for (let at = 0; at < bindings; at++) next[at] = this[at];
    next.overrides = this.overrides;
    claim(1 + 4 * count);
    const words = blockWords, base = blockBase;
    words[base] = count;
    for (let at = 0; at < count; at++) {
      const entry = entries[at];
      words[base + 1 + at] = entry.offset;
      words[base + 1 + count + at] = entry.contextOffset;
      words[base + 1 + 2 * count + at] = entry.width;
      words[base + 1 + 3 * count + at] = entry.type;
      next[bindings + 2 * at] = entry.key;
      next[bindings + 2 * at + 1] = entry.metadata;
    }
    next.contextWords = words;
    next.contextBase = base;
    return next;
  }

  // The bindings, as the Map of package index -> identity they replaced.

  get size() { return this.words[this.base]; }

  /** The position of a package index among the bindings, or -1. */
  bindingAt(index) {
    const words = this.words, base = this.base + 2, count = words[this.base];
    for (let at = 0; at < count; at++) if (words[base + at] === index) return at;
    return -1;
  }

  has(index) { return this.bindingAt(index) >= 0; }

  get(index) {
    const at = this.bindingAt(index);
    return at < 0 ? undefined : this[at];
  }

  * values() { for (let at = 0; at < this.words[this.base]; at++) yield this[at]; }

  * keys() { for (let at = 0; at < this.words[this.base]; at++) yield this.words[this.base + 2 + at]; }

  * entries() { for (let at = 0; at < this.words[this.base]; at++) yield [this.words[this.base + 2 + at], this[at]]; }

  [Symbol.iterator]() { return this.entries(); }

  forEach(fn, thisArg) {
    for (let at = 0; at < this.words[this.base]; at++) fn.call(thisArg, this[at], this.words[this.base + 2 + at], this);
  }

  // The operands, as the Map of expression offset -> identity they replaced.

  get operandCount() { return this.words[this.base + 1]; }

  /** The position of an expression offset among the operands, or -1 (not a number, or no operand at it). */
  find(offset) {
    const words = this.words, base = this.base, at = base + 2 + words[base];
    let low = 0, high = words[base + 1] - 1;
    while (low <= high) {
      const mid = (low + high) >> 1, value = words[at + mid];
      if (value < offset) low = mid + 1;
      else if (value > offset) high = mid - 1;
      else return value === offset ? mid : -1;
    }
    return -1;
  }

  /** The operand at position `rank` of `find`: what was written to it, else the identity of its binding. */
  operandAt(rank) {
    const overrides = this.overrides;
    if (overrides !== null && overrides.has(rank)) return overrides.get(rank);
    const words = this.words, base = this.base;
    return this[words[base + 2 + words[base] + words[base + 1] + rank]];
  }

  /** Write the operand at position `rank`. */
  setOperandAt(rank, value) {
    (this.overrides ??= new Map()).set(rank, value);
  }

  /** Every operand as [offset, value], ascending by offset (tests). */
  * operands() {
    const words = this.words, base = this.base, offsetAt = base + 2 + words[base];
    for (let rank = 0; rank < words[base + 1]; rank++) yield [words[offsetAt + rank], this.operandAt(rank)];
  }

  // The null-Context results.

  get hasContexts() { return this.contextWords !== null; }

  get contextCount() { return this.contextWords === null ? 0 : this.contextWords[this.contextBase]; }

  /** The position of a value offset among the null-Context results, or -1. */
  contextFind(offset) {
    const words = this.contextWords;
    if (words === null) return -1;
    const base = this.contextBase + 1;
    let low = 0, high = words[this.contextBase] - 1;
    while (low <= high) {
      const mid = (low + high) >> 1, value = words[base + mid];
      if (value < offset) low = mid + 1;
      else if (value > offset) high = mid - 1;
      else return value === offset ? mid : -1;
    }
    return -1;
  }

  /** A result's value offset (column 0), context offset (1), width (2) or type code (3). */
  contextInt(rank, column) {
    const words = this.contextWords, base = this.contextBase;
    return words[base + 1 + column * words[base] + rank];
  }

  contextKey(rank) { return this[this.words[this.base] + 2 * rank]; }

  contextMetadata(rank) { return this[this.words[this.base] + 2 * rank + 1]; }
}

/** The order that sorts `offsets` ascending, ties kept in their order. */
function sortedOrder(offsets) {
  const order = new Array(offsets.length);
  for (let at = 0; at < order.length; at++) order[at] = at;
  return order.sort((a, b) => offsets[a] - offsets[b] || a - b);
}

export { NO_WIDTH };
