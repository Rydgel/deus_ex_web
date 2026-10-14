/** The original's global-object slot allocator, continued from a measured
 * registry state (docs/object-index-captures.md "Runtime spawns").
 *
 * Every UObject the original creates takes a GObjObjects slot from
 * UObject::AddObject (Core 0x10157830): the last entry of GObjAvailable when
 * there is one (FArray::Remove of the tail, LIFO), else a new slot at
 * GObjObjects.Num. ~UObject (0x10150040) appends the freed slot to
 * GObjAvailable and never shortens the array (docs/script-object-release.md).
 * A sound's channel id is `(Index << 4) + (Slot << 1) + bNoOverride`
 * (execPlaySound), so a runtime spawn's id needs the slot AddObject gave it.
 *
 * This model is that rule and nothing else. It is exact for a spawn only when
 * (1) it starts from the original's real state at a known moment: the live
 * dump of GObjObjects and GObjAvailable (a measured host input), and (2) every
 * AddObject and every ~UObject after that moment is replayed in the original's
 * order. Play models the spawns, `new`s and final releases of the script
 * runtime; what it does not create (windows, graphics contexts, render
 * iterators, event-manager receivers, ...) is outside the model, and the
 * slots of everything after them are then the model's, not measured. The id a
 * model slot yields is therefore labelled "modeled", never "measured". */
export class OriginalObjectIndexModel {
  constructor({count, freeIndices = [], source = 'unspecified', exact = true, packages = null} = {}) {
    if (!Number.isInteger(count) || count < 0) throw new Error('Original object index model requires the registry high-water mark');
    const seen = new Set();
    for (const index of freeIndices) {
      if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index))
        throw new Error(`Original object index model: free slot ${index} is not a distinct slot below ${count}`);
      seen.add(index);
    }
    this.count = count;
    this.freeIndices = [...freeIndices];
    this.source = source;
    // False when the order the free list was filled in is not known (a dump
    // lists the holes as a set): the first slots reused are then an assumption.
    this.exact = exact;
    this.allocated = 0;
    this.released = 0;
    /** The packages already resident in the original (lower case), when a measured dump says so (a harness; the registry's `Package`
     * rows). A first load at run time then creates a UPackage and its LinkerLoad (`loadPackage`); null: not known, not modeled. */
    this.packages = Array.isArray(packages) ? new Set(packages.map(name => String(name).toLowerCase())) : null;
    this.loaded = new WeakSet();
    /** Validation only: an array that receives one {ev, index, cls, name} per allocation and give-back, with `clock()` as `u`. */
    this.log = null;
    this.clock = () => 0;
    // Releases of objects whose slot is not known (made before the seed, or a pre-placed actor with no measured index): the free list misses them.
    this.unattributed = 0;
    // Releases the model could not take back (see `release`).
    this.rejected = 0;
  }
  /** UObject::AddObject(-1): the slot a new object takes. `cls`/`name` only label the validation log. */
  allocate(cls = null, name = null) {
    this.allocated++;
    const index = this.freeIndices.length ? this.freeIndices.pop() : this.count++;
    this.log?.push({u: this.clock(), ev: 'add', index, cls, name});
    return index;
  }
  /** A runtime load of an export of package `name` (StaticLoadObject over a package the process had not loaded): the first one creates
   * the UPackage (CreatePackage) and its linker (GetPackageLinker), in that order, each an AddObject; the export itself is `loadExport`.
   * Returns whether it created them. Only with a measured set of resident packages (`packages`). */
  loadPackage(name) {
    if (!this.packages) return false;
    const key = String(name).toLowerCase();
    if (this.packages.has(key)) return false;
    this.packages.add(key);
    this.allocate('Package', name);
    this.allocate('LinkerLoad', null);
    return true;
  }
  /** CreateExport of a runtime-loaded object: one AddObject the first time `object` is loaded. */
  loadExport(object, cls, name = null) {
    if (!this.packages || this.loaded.has(object)) return false;
    this.loaded.add(object);
    this.allocate(cls, name);
    return true;
  }
  /** `allocate` for a holder object: it carries the slot (`originalIndex`) and the model it came from, so a holder that outlives a
   * re-seed (a harness replaces the boot's seed with the original's own dump) does not give a foreign slot back. */
  take(holder, cls = null, name = null) {
    holder.originalIndex = this.allocate(cls, name);
    holder.originalModel = this;
    return holder.originalIndex;
  }
  /** The holder's slot goes back to this model, if this model gave it. */
  giveBack(holder) {
    // An object created before this model was seeded: the slot it frees is not known, so the free list misses it.
    if (holder.originalModel !== this || !Number.isInteger(holder.originalIndex)) { this.unattributed++; return false; }
    this.release(holder.originalIndex);
    holder.originalIndex = null;
    return true;
  }
  /** ~UObject's GObjAvailable append of a freed slot. A slot this model cannot take back (outside the registry, or already free: a
   * measured index of another session's table, a release the model missed the allocation of) is counted in `rejected` and left out:
   * the model numbers sounds, it never stops the game. Returns whether the slot was taken back. */
  release(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.count || this.freeIndices.includes(index)) {
      this.rejected++;
      return false;
    }
    this.released++;
    this.freeIndices.push(index);
    this.log?.push({u: this.clock(), ev: 'free', index});
    return true;
  }
  snapshot() { return {count: this.count, freeIndices: [...this.freeIndices], source: this.source, exact: this.exact}; }
}
