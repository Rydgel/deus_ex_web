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

const entryIds = new WeakMap();
let nextEntryId = 1;
const interned = new Map();
/** One frozen array for every list of entries that holds the same entries (by identity) at the same positions (holes
 * included): the hosts of a class all install the same members, so the array a host's state keeps is the class's. The
 * entries are objects shared per cell (their identity is stable), compared by a number made for each. */
export function internEntries(list) {
  let key = '';
  for (let index = 0; index < list.length; index++) {
    const entry = list[index];
    if (entry === undefined) { key += ','; continue; }
    let id = entryIds.get(entry);
    if (id === undefined) entryIds.set(entry, id = nextEntryId++);
    key += `${id},`;
  }
  let shared = interned.get(key);
  if (shared === undefined) interned.set(key, shared = Object.freeze(list.slice()));
  return shared;
}
