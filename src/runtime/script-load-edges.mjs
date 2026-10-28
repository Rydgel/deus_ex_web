/** The load graph's load edges (createScriptLoadGraph's `recordLoadEdges`; docs/class-graph-design.md "Loaded in the original's
 * sense"): record -> the records its load reached.
 *
 * Host representation only (docs/live-heap.md, step 7). This was a Map of Sets, and keeps its order and lifetimes: a record's
 * targets without repeats in the order first added; the records with an entry in the order their first edge was added (an entry
 * that is deleted loses its place, and a later edge from the record puts it last); an entry stays when its targets are deleted.
 * A record is held while it has an entry or is the target of an edge, as the Map and Sets held it.
 *
 * Each record taking part gets an ordinal (its `loadOrdinal`, which the graph's records carry from makeRecord). The entries and
 * the edges are typed-array lists over the ordinals, so the only references a GC traces here are one per record held (`records`),
 * not one per edge plus a Set per entry.
 */
const grow = (array, size, fill) => {
  let length = array.length;
  while (length < size) length *= 2;
  if (length === array.length) return array;
  const next = new array.constructor(length);
  next.set(array);
  if (fill !== 0) next.fill(fill, array.length);
  return next;
};

export class LoadEdges {
  constructor() {
    this.records = [];                    // ordinal -> record, while held
    this.count = 0;                       // ordinals handed out
    // per ordinal
    this.holds = new Int32Array(1024);    // edges to it, plus one while it has an entry
    this.member = new Uint8Array(1024);   // it has an entry
    this.first = new Int32Array(1024).fill(-1);  // its edges
    this.last = new Int32Array(1024).fill(-1);
    this.prev = new Int32Array(1024).fill(-1);   // the entries' order
    this.next = new Int32Array(1024).fill(-1);
    this.head = -1;
    this.tail = -1;
    this.size = 0;                        // entries
    // per edge
    this.to = new Int32Array(4096);
    this.link = new Int32Array(4096);
    this.edges = 0;                       // edge slots used
    this.free = -1;                       // deleted edge slots, linked through `link`
  }

  ordinal(record) {
    let ordinal = record.loadOrdinal;
    if (Number.isInteger(ordinal) && ordinal >= 0) {
      if (ordinal >= this.count) throw new Error('A load edge record carries another graph\'s ordinal');
      return ordinal;
    }
    ordinal = this.count++;
    record.loadOrdinal = ordinal;
    const size = this.count;
    this.holds = grow(this.holds, size, 0);
    this.member = grow(this.member, size, 0);
    this.first = grow(this.first, size, -1);
    this.last = grow(this.last, size, -1);
    this.prev = grow(this.prev, size, -1);
    this.next = grow(this.next, size, -1);
    return ordinal;
  }

  hold(ordinal, record) {
    const held = this.records[ordinal];
    if (held !== undefined && held !== record) throw new Error('A load edge record carries another graph\'s ordinal');
    this.holds[ordinal]++;
    this.records[ordinal] = record;
  }

  release(ordinal) {
    if (--this.holds[ordinal] === 0) this.records[ordinal] = undefined;
  }

  /** The record's ordinal when it has an entry here, else -1. */
  entry(record) {
    const ordinal = record?.loadOrdinal;
    return Number.isInteger(ordinal) && ordinal >= 0 && ordinal < this.count && this.member[ordinal] === 1 &&
      this.records[ordinal] === record ? ordinal : -1;
  }

  has(record) { return this.entry(record) >= 0; }

  add(from, to) {
    const f = this.ordinal(from), t = this.ordinal(to);
    if (this.member[f] === 0) {
      this.member[f] = 1;
      this.prev[f] = this.tail;
      this.next[f] = -1;
      if (this.tail === -1) this.head = f; else this.next[this.tail] = f;
      this.tail = f;
      this.size++;
      this.hold(f, from);
    }
    for (let edge = this.first[f]; edge !== -1; edge = this.link[edge]) if (this.to[edge] === t) return;
    let edge = this.free;
    if (edge !== -1) this.free = this.link[edge];
    else {
      edge = this.edges++;
      this.to = grow(this.to, this.edges, 0);
      this.link = grow(this.link, this.edges, 0);
    }
    this.to[edge] = t;
    this.link[edge] = -1;
    if (this.last[f] === -1) this.first[f] = edge; else this.link[this.last[f]] = edge;
    this.last[f] = edge;
    this.hold(t, to);
  }

  /** fn(target) for each of the record's targets, in order. fn must not change the edges. */
  forEachTarget(from, fn) {
    const f = this.entry(from);
    if (f < 0) return;
    for (let edge = this.first[f]; edge !== -1; edge = this.link[edge]) fn(this.records[this.to[edge]]);
  }

  /** fn(record) for each record with an entry, in order. fn must not change the edges. */
  forEachFrom(fn) {
    for (let at = this.head; at !== -1; at = this.next[at]) fn(this.records[at]);
  }

  /** The record's entry and its edges go. */
  delete(from) {
    const f = this.entry(from);
    if (f < 0) return false;
    for (let edge = this.first[f]; edge !== -1;) {
      const following = this.link[edge];
      this.release(this.to[edge]);
      this.link[edge] = this.free;
      this.free = edge;
      edge = following;
    }
    this.first[f] = this.last[f] = -1;
    if (this.prev[f] === -1) this.head = this.next[f]; else this.next[this.prev[f]] = this.next[f];
    if (this.next[f] === -1) this.tail = this.prev[f]; else this.prev[this.next[f]] = this.prev[f];
    this.prev[f] = this.next[f] = -1;
    this.member[f] = 0;
    this.size--;
    this.release(f);
    return true;
  }

  /** Every edge to a record in `targets` (a Set) goes; the entries stay. */
  deleteTargets(targets) {
    for (let f = this.head; f !== -1; f = this.next[f]) {
      let before = -1;
      for (let edge = this.first[f]; edge !== -1;) {
        const following = this.link[edge];
        if (targets.has(this.records[this.to[edge]])) {
          if (before === -1) this.first[f] = following; else this.link[before] = following;
          if (this.last[f] === edge) this.last[f] = before;
          this.release(this.to[edge]);
          this.link[edge] = this.free;
          this.free = edge;
        } else before = edge;
        edge = following;
      }
    }
  }
}
