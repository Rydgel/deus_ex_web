/**
 * A linked class's `defaults` (field key -> the values of that default by array index), counting its changes.
 *
 * Every construction asked whether the class image still matched the class (`sameDefaults`: a walk over the whole Map, every
 * default of an Actor class, comparing each entry by identity with the image's snapshot): 0.05 ms of a Dockyard frame in Firefox
 * (3.2 spawns a frame), 5.5 times what V8 spends. A change of the table is a `set`, `delete` or `clear` of this object, whichever code
 * makes it, so `version` says whether any happened since an image was made from it; nothing changes a value Map in place (a changed
 * default replaces the class's entry), which is what the identity comparison relied on too.
 *
 * The host layout (docs/firefox-60fps-plan.md, "The linked classes' defaults and property links"): a derived class's table repeated
 * its base's, 75,000 of the 85,000 entries on the Island, and every class image and every attached object's snapshot copied the whole
 * table again. A table is now its own entries over a frozen layer: `snapshot()` freezes what the table holds (its entries become a
 * layer the table stands on; a later write goes to a fresh overlay), so a class's image, the objects attached to it and a class
 * linked from it share that layer instead of copying it. What a reader sees is the table as it was: `get`, `has`, `size` and the
 * entries are those of one flat Map holding the same writes. The order of the entries is not: the table's own entries come first, then
 * the layers' (no reader depends on it; the class loader walks the class's property list for its order).
 */
const HIDDEN = Symbol('hidden default');
// A table whose layers pile up (a default rewritten between snapshots, again and again) is flattened into one layer, so a read stays a few steps.
const MAX_LAYERS = 24;

const frozenError = () => new TypeError('A frozen defaults layer is never changed: a class\'s image and objects hold it as it was');
const sharedValuesError = () => new TypeError('A default\'s values are shared between classes and never changed in place: a changed default replaces the class\'s entry');

/**
 * The values of one default property, index -> value, as the class loader links them. Shared between classes and never changed in
 * place (docs/live-heap.md; the class's entry is replaced instead), so a write throws: a writer would change every class that shares it.
 * Make one with `defaultValues` or `defaultValuesOf` (its constructor takes no entries: the Map constructor would call `set`).
 */
export class DefaultValues extends Map {
  set() { throw sharedValuesError(); }
  delete() { throw sharedValuesError(); }
  clear() { throw sharedValuesError(); }
}
const fill = Map.prototype.set;

// The commonest default is one scalar at index 0 (a bool, an int, a float, a name): 7,000 of the Island's 10,300 value Maps, 1,900
// different. They are one object a value. Only values that hold no reference are interned (the table is the process's: it would keep
// what a purged class's value references), and a NaN is not (its bits are not told apart by `Object.is`, so merging two would not be
// the identity comparison's equal).
const scalars = new Map();
let negativeZero = null;
const SCALAR_LIMIT = 1 << 16;
const scalarOf = value => {
  let values;
  if (value === 0 && 1 / value < 0) values = negativeZero;
  else values = scalars.get(value);
  if (values !== undefined && values !== null) return values;
  values = new DefaultValues();
  fill.call(values, 0, value);
  if (value === 0 && 1 / value < 0) negativeZero = values;
  else if (scalars.size < SCALAR_LIMIT) scalars.set(value, values);
  return values;
};
const internable = value => value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint' ||
  typeof value === 'number' && value === value;

/** The values of one default from parallel lists of indices and values (the first `count` of them; the caller's scratch arrays). */
export function defaultValuesOf(indices, values, count = indices.length) {
  if (count === 1 && indices[0] === 0 && internable(values[0])) return scalarOf(values[0]);
  const result = new DefaultValues();
  for (let i = 0; i < count; i += 1) fill.call(result, indices[i], values[i]);
  return result;
}

/** The values of one default from a Map or any iterable of [index, value]; a `DefaultValues` is returned as it is. */
export function defaultValues(source) {
  if (source instanceof DefaultValues) return source;
  const result = new DefaultValues();
  let only = null, count = 0;
  for (const [index, value] of source) { fill.call(result, index, value); count += 1; only = [index, value]; }
  return count === 1 && only[0] === 0 && internable(only[1]) ? scalarOf(only[1]) : result;
}

export class DefaultsMap {
  /** @param source a DefaultsMap (the table starts as a view of its snapshot) or an iterable of [key, values] (copied) */
  constructor(source) {
    this.own = null;      // Map key -> values | HIDDEN (a key of the layers the table hides), made by the first write
    this.parent = null;   // the frozen layer under `own`
    this.count = 0;       // the entries the table has
    this.depth = 1;       // a frozen layer: the layers under it, itself included
    this.version = 0;
    this.frozen = false;
    if (source instanceof DefaultsMap) {
      const layer = source.snapshot();
      this.parent = layer;
      this.count = layer.count;
    } else if (source) {
      for (const [key, value] of source) this.set(key, value);
      this.version = 0;
    }
  }
  get size() { return this.count; }
  get(key) {
    let layer = this;
    do {
      const own = layer.own;
      if (own !== null) {
        const value = own.get(key);
        if (value !== undefined) return value === HIDDEN ? undefined : value;
      }
      layer = layer.parent;
    } while (layer !== null);
    return undefined;
  }
  has(key) { return this.get(key) !== undefined; }
  set(key, value) {
    if (this.frozen) throw frozenError();
    if (value === undefined) throw new TypeError('A default is never undefined');
    this.version++;
    const own = this.own ?? (this.own = new Map());
    const had = own.get(key);
    if (had === undefined) {
      if (this.parent === null || !this.parent.has(key)) this.count++;
    } else if (had === HIDDEN) this.count++;
    own.set(key, value);
    return this;
  }
  delete(key) {
    if (this.frozen) throw frozenError();
    this.version++;
    const own = this.own, had = own === null ? undefined : own.get(key);
    if (had !== undefined) {
      if (had === HIDDEN) return false;
      this.count--;
      if (this.parent !== null && this.parent.has(key)) own.set(key, HIDDEN); else own.delete(key);
      return true;
    }
    if (this.parent !== null && this.parent.has(key)) {
      (this.own ?? (this.own = new Map())).set(key, HIDDEN);
      this.count--;
      return true;
    }
    return false;
  }
  clear() {
    if (this.frozen) throw frozenError();
    this.version++;
    this.own = null; this.parent = null; this.count = 0;
  }
  *entries() {
    const own = this.own, parent = this.parent;
    if (own !== null) for (const entry of own) if (entry[1] !== HIDDEN) yield entry;
    if (parent !== null) {
      if (own === null) yield* parent.entries();
      else for (const entry of parent.entries()) if (!own.has(entry[0])) yield entry;
    }
  }
  [Symbol.iterator]() { return this.entries(); }
  *keys() { for (const entry of this.entries()) yield entry[0]; }
  *values() { for (const entry of this.entries()) yield entry[1]; }
  forEach(callback, thisArg) { for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this); }

  /**
   * The table as it is now, frozen: its entries become a layer this table stands on from here (a later write is an overlay on it), so
   * the snapshot costs nothing and a table nobody has written since returns the layer it has. A class image, an object's defaults and a
   * class linked from this one hold it.
   */
  snapshot() {
    if (this.frozen) return this;
    if (this.own === null && this.parent !== null) return this.parent;
    const layer = new DefaultsMap();
    layer.frozen = true;
    layer.depth = (this.parent === null ? 0 : this.parent.depth) + 1;
    if (layer.depth > MAX_LAYERS) {
      const flat = new Map(this.entries());
      layer.own = flat; layer.count = flat.size; layer.depth = 1;
    } else {
      layer.own = this.own; layer.parent = this.parent; layer.count = this.count;
    }
    this.own = null; this.parent = layer;
    return layer;
  }
  /** Whether this table holds exactly the entries `snapshot` does (nothing written since it was taken from it). */
  isViewOf(snapshot) { return this.own === null && this.parent === snapshot; }
}

/** A copy of a class's defaults as they are: a frozen layer of a DefaultsMap, a Map copy of any other table. */
export const snapshotOfDefaults = defaults => defaults instanceof DefaultsMap ? defaults.snapshot() : new Map(defaults);
