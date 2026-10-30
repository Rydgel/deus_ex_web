/** The lowercase object paths of a package's exports, to their 1-based export references: `AssetStore`'s `exportsByPath`.
 *
 * Host representation only (docs/live-heap.md "Package tables"). It was a `Map` from each export's lowercase path (a string made for
 * the key) to its position. This is the Map's interface (`get`, `has`, `size`, iteration in insertion order, `forEach`) over an
 * open-addressing table of export positions and one hash a position, and keeps no string: a lookup builds the candidate's path
 * to compare it. The table is built when first asked for, from the export columns.
 *
 * Map semantics kept: two exports with the same lowercase path give the later position under the earlier one's place in the iteration.
 */
const hashText = text => {
  let hash = 0x811c9dc5 | 0;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return hash;
};

export class ExportPaths {
  /** `exports`: the package's ExportTable. */
  constructor(exports) {
    this.exports = exports;
    this.slots = null;
    this.hashes = null;
    this.mask = 0;
    this.repeats = null;     // positions that repeated an earlier export's path (Set), or null
    this.lastOf = null;      // first position of a repeated path -> the last (Map), or null
    this.count = 0;
  }

  #build() {
    const exports = this.exports, length = exports.length;
    let capacity = 8;
    while (capacity < length * 2) capacity *= 2;
    const slots = new Int32Array(capacity), hashes = new Int32Array(length), mask = capacity - 1;
    let repeats = null, lastOf = null, firstOf = null, count = 0;
    for (let index = 0; index < length; index += 1) {
      const lower = exports.path(index).toLowerCase(), hash = hashText(lower);
      hashes[index] = hash;
      let slot = hash & mask;
      for (;;) {
        const held = slots[slot];
        if (held === 0) { slots[slot] = index + 1; count += 1; break; }
        const other = held - 1;
        if (hashes[other] === hash && exports.path(other).toLowerCase() === lower) {
          slots[slot] = index + 1;
          const first = firstOf?.get(other) ?? other;
          (repeats ??= new Set()).add(index);
          (firstOf ??= new Map()).set(index, first);
          (lastOf ??= new Map()).set(first, index);
          break;
        }
        slot = (slot + 1) & mask;
      }
    }
    this.slots = slots; this.hashes = hashes; this.mask = mask; this.repeats = repeats; this.lastOf = lastOf; this.count = count;
  }

  get size() { if (this.slots === null) this.#build(); return this.count; }

  /** The 1-based export reference whose lowercase path is `path`, or undefined. */
  get(path) {
    if (typeof path !== 'string') return undefined;
    if (this.slots === null) this.#build();
    const slots = this.slots, hashes = this.hashes, mask = this.mask, hash = hashText(path), exports = this.exports;
    for (let slot = hash & mask; ; slot = (slot + 1) & mask) {
      const held = slots[slot];
      if (held === 0) return undefined;
      const index = held - 1;
      if (hashes[index] === hash && exports.path(index).toLowerCase() === path) return held;
    }
  }

  has(path) { return this.get(path) !== undefined; }

  /** [lowercase path, reference] in the order the Map was filled. */
  *entries() {
    if (this.slots === null) this.#build();
    const exports = this.exports;
    for (let index = 0; index < exports.length; index += 1) {
      if (this.repeats?.has(index)) continue;
      yield [exports.path(index).toLowerCase(), (this.lastOf?.get(index) ?? index) + 1];
    }
  }
  [Symbol.iterator]() { return this.entries(); }
  *keys() { for (const [path] of this.entries()) yield path; }
  *values() { for (const [, index] of this.entries()) yield index; }
  forEach(visit, thisArg) { for (const [path, index] of this.entries()) visit.call(thisArg, index, path, this); }
}
