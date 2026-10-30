// Verbatim copy of src/runtime/host-accessors.mjs at ca8ab34e (before docs/live-heap.md "Actor hosts and mesh bindings"), the reference the differential in
// test/host-members.test.mjs compares the shared-entry modules with. Only the import paths differ.
/**
 * Accessor properties of a host object whose functions are shared by every host (docs/live-heap.md, "Step 5's
 * results").
 *
 * The installers of an actor host's image-backed members (actor-pose-fields, actor-mirror-fields, actor-link-fields,
 * actor-flag-words) defined each accessor with a getter and a setter closed over that host's entry, so every host held
 * a function pair and its context for every member: about 120 objects a host. An accessor here is a pair of functions
 * made once for a slot (a symbol key under which the host keeps its entries) and an index; they find the host's entry
 * through `this`. A host holds only the property's AccessorPair, and the entry objects it held before.
 *
 * The accessor is still an own, enumerable, non-configurable property of the host, as before: its value is read through
 * the host (`host.position`, a spread, Object.keys), and `this` is the host. A slot property copied to another object by
 * Object.getOwnPropertyDescriptors carries its entries with it.
 */
const pairs = new Map();

/** The accessor pair for entry `index` of the array under `slot`: get() reads `this[slot][index].get()`, set(value) writes
 * `this[slot][index].set(value)`. The same pair every time it is asked for. */
export function entryAccessor(slot, index) {
  let list = pairs.get(slot);
  if (list === undefined) pairs.set(slot, list = []);
  return list[index] ??= Object.freeze({
    get() { return this[slot][index].get(); },
    set(value) { this[slot][index].set(value); },
  });
}

/** Define an own accessor member on `target` over entry `index` under `slot`, with the descriptor every installer used. */
export function defineEntryAccessor(target, prop, slot, index) {
  const {get, set} = entryAccessor(slot, index);
  Object.defineProperty(target, prop, {configurable: false, enumerable: true, get, set});
}
