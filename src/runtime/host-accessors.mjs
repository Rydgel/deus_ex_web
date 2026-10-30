/**
 * Accessor properties of a host object whose functions are shared by every host (docs/live-heap.md, "Step 5's
 * results"), and the entries behind them shared by every host of a class ("Actor hosts and mesh bindings").
 *
 * The installers of an actor host's image-backed members (actor-pose-fields, actor-mirror-fields, actor-link-fields,
 * actor-flag-words) defined each accessor with a getter and a setter closed over that host's entry, so every host held
 * a function pair and its context for every member: about 120 objects a host. An accessor here is a pair of functions
 * made once for a slot (a symbol key under which the host keeps its state) and an index; they find the host's state
 * through `this` and ask it for member `index`: `this[slot].get(index)`, `this[slot].set(index, value)`. A host holds
 * only the property's AccessorPair and one state object a slot. What a state does for a member (the cell, the codec,
 * the spec) belongs to the class and is shared: the state keeps the host's own part (its instance, its values) and an
 * interned array of the class's entries.
 *
 * The accessor is still an own, enumerable, non-configurable property of the host, as before: its value is read through
 * the host (`host.position`, a spread, Object.keys), and `this` is the host. A slot property copied to another object by
 * Object.getOwnPropertyDescriptors carries its state with it.
 */
const pairs = new Map();

/** The accessor pair for member `index` under `slot`: get() reads `this[slot].get(index)`, set(value) writes
 * `this[slot].set(index, value)`. The same pair every time it is asked for. */
export function entryAccessor(slot, index) {
  let list = pairs.get(slot);
  if (list === undefined) pairs.set(slot, list = []);
  return list[index] ??= Object.freeze({
    get() { return this[slot].get(index); },
    set(value) { this[slot].set(index, value); },
  });
}

/** Define an own accessor member on `target` over member `index` under `slot`, with the descriptor every installer used. */
export function defineEntryAccessor(target, prop, slot, index) {
  const {get, set} = entryAccessor(slot, index);
  Object.defineProperty(target, prop, {configurable: false, enumerable: true, get, set});
}

// A trie over the entries of a list, one WeakMap a level keyed by the entry itself: nothing global holds a level's entries (their cells and
// codecs reach the level's class graph), so the arrays go with the entries when the level does. A string-keyed Map of the arrays kept the first
// level of a browser session alive after the second was loaded (the Island's worker held two script processes).
const HOLE = {};
const trie = {children: new WeakMap(), array: null};
const noEntries = {array: null};
/** One frozen array for every list of entries that holds the same entries (by identity) at the same positions (holes
 * included): the hosts of a class all install the same members, so the array a host's state keeps is the class's. */
export function internEntries(list) {
  if (list.length === 0) return noEntries.array ??= Object.freeze([]);
  let node = trie;
  for (let index = 0; index < list.length; index++) {
    const key = list[index] === undefined ? HOLE : list[index];
    let next = node.children.get(key);
    if (next === undefined) node.children.set(key, next = {children: new WeakMap(), array: null});
    node = next;
  }
  return node.array ??= Object.freeze(list.slice());
}

/** A class of four-slot arrays whose elements are the accessors `slots` (four {get, set} pairs, shared functions that find their
 * owner through `this`) on the prototype. An array of the class is a holey Array of length 4 with no element of its own: the
 * four AccessorPairs and the dictionary of elements of an array that defined them on itself (about seven objects and fifty
 * edges a host) are gone. Array.isArray, length, index reads and stores, indexOf, fill, the iterator, JSON and a spread see
 * what they saw; the array's own keys are none (a key list of the old array was '0'..'3'), and the species is Array, so
 * map, filter and slice give plain arrays. */
export function slotArrayClass(slots) {
  class SlotArray extends Array {
    static get [Symbol.species]() { return Array; }
  }
  for (let index = 0; index < 4; index++) Object.defineProperty(SlotArray.prototype, index, {enumerable: true, ...slots[index]});
  return SlotArray;
}

/**
 * Map actor hosts as instances of a class, whose image-backed members are accessors on the prototype
 * (docs/live-heap.md, "Actor hosts and mesh bindings").
 *
 * A host that the installers turned from data properties into own accessors was a dictionary-mode object: V8 normalizes an object
 * when a data property of it is redefined as an accessor, and a dictionary-mode host holds a table slot for each of its forty-odd
 * members and an AccessorPair for each of its twenty-two accessors (2,237 hosts and 49,000 pairs on the Island). A MapActorHost
 * has the members as accessors of its prototype from the start, so it stays a fast-mode object whose own properties are its
 * data. Until an installer takes a member into the object image, the accessor stores the member's value in the host's pending
 * table, which is what the data property held; the installer moves that value into the image and the accessor then reads and
 * writes the image through the host's state (`this[slot]`, as the own accessors did). A member no installer takes keeps its
 * pending value for good.
 *
 * Own-ness is the one difference with a plain host: the members are not own properties of a MapActorHost (Object.keys and a spread
 * do not list them; `in` and every read and write see them), and `delete` of one is a no-op that `hostDelete` does properly. The
 * installers still install on plain hosts (the player's identity, fixtures) as they did.
 */
export const PENDING = Symbol('hostPending');
const BACKED = Symbol('mapActorHost');

export class MapActorHost {
  /** The decoded actor's fields in their order, and `values`. */
  constructor(actor, values) {
    this.index = actor.index; this.name = actor.name; this.className = actor.className; this.properties = actor.properties;
    this.values = values; this.nativeBytes = actor.nativeBytes; this.stack = actor.stack;
  }
}
Object.defineProperty(MapActorHost.prototype, BACKED, {value: true});

/** Whether `host`'s image-backed members are accessors of its prototype (a MapActorHost). */
export const isBackedHost = host => host?.[BACKED] === true;

function pendingOf(host) {
  let table = host[PENDING];
  if (table === undefined) { table = Object.create(null); Object.defineProperty(host, PENDING, {value: table, writable: true}); }
  return table;
}

/** A member `prop` of a MapActorHost: `taken(host)` says whether the host's state has taken it (then `read(host)` and `write(host,
 * value)` are the state's, the functions the own accessors had), else the pending value. `write` is null for a member the state
 * only reads: a store to it after it was taken throws as the own getter-only accessor did. */
export function defineBackedMember(prop, taken, read, write) {
  Object.defineProperty(MapActorHost.prototype, prop, {
    enumerable: true, configurable: false,
    get() { return taken(this) ? read(this) : this[PENDING]?.[prop]; },
    set(value) {
      if (taken(this)) {
        if (write === null) throw new TypeError(`Cannot set property ${prop} of #<MapActorHost> which has only a getter`);
        write(this, value);
      } else pendingOf(this)[prop] = value;
    },
  });
}

/** The value `host` holds for `prop` before an installer takes it (a plain host's data property, a MapActorHost's pending value). */
export const peekPending = (host, prop) => host[PENDING]?.[prop];

/** An installer has moved `prop`'s value into the image: a MapActorHost forgets its pending value (a plain host's data property
 * became the accessor). */
export function dropPending(host, prop) {
  const table = host[PENDING];
  if (table !== undefined) delete table[prop];
}

/** After the map actors are attached: a host whose pending table is empty lets it go (a later store makes it again). */
export function releasePendingTables(hosts) {
  for (const host of hosts) {
    const table = host[PENDING];
    if (table !== undefined && Object.keys(table).length === 0) host[PENDING] = undefined;
  }
}

/** `delete host[prop]` for a member the installers did not take: a plain host loses the property, a MapActorHost its pending value. */
export function hostDelete(host, prop) {
  if (isBackedHost(host)) { const table = host[PENDING]; if (table !== undefined) delete table[prop]; } else delete host[prop];
}
