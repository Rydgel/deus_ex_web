/**
 * A class's defaults as they were when an object attached (docs/live-heap.md, "Step 5's results").
 *
 * An object keeps the defaults of its class as of its attachment (a property reset and the slot fallback read them, whatever a
 * later SaveConfig or `Default.X =` changed). That was a copy of the class's Map per object: the Island's 2,425 map actors held
 * 233,000 entries in copies of 230 classes' Maps. A changed default replaces the class's entry (the inner Maps are never changed
 * in place) and nothing writes a snapshot, so objects attached while the class's entries are the same ones share one copy.
 */
const snapshots = new WeakMap();

const sameEntries = (copy, defaults) => {
  if (copy.size !== defaults.size) return false;
  for (const [key, value] of copy) if (defaults.get(key) !== value) return false;
  return true;
};

/** A Map with `cls.defaults`'s entries now: the previous snapshot of the class when it still has exactly those entries. Read-only. */
export function defaultsSnapshot(cls) {
  const defaults = cls.defaults, kept = snapshots.get(cls);
  if (kept !== undefined && sameEntries(kept, defaults)) return kept;
  const copy = new Map(defaults);
  snapshots.set(cls, copy);
  return copy;
}
