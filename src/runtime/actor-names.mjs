/**
 * Level.Actors' name map (and, for the mesh lighting, its membership set), kept across the epochs of the array (base-epoch.mjs
 * actorsEpoch).
 *
 * The map (name -> the first non-null entry of that name in array order, or the last one) was rebuilt from all of Level.Actors,
 * reading every actor's name, whenever the epoch advanced: at the Dockyard that is 60 percent of the ticks, 0.37 ms of a Firefox frame
 * for the texture pans' zone names (game.mjs surfacePan) and 0.24 for the mesh lighting's (mesh-lighting-view.mjs levelMembership;
 * docs/firefox-60fps-plan.md "Dockyard spawns and js_eval"). What an advance changes is a spawn (an appended actor) and a destroy (an
 * entry turned null, and, within the tick, CompactActors' removal of the null entries: 84 percent of the advances of a 1,000-tick run
 * are compactions, which shift every slot after the first removed one). The map depends only on the sequence of the non-null entries,
 * which a compaction keeps, so `update` walks the array against the sequence it saw last (`list`, in order) and finds what left it
 * (entries that are no longer there) and what joined it at the end (entries not in it before), then maintains the map:
 *   * an appended actor takes its name where the name is absent, or where the map keeps the last entry of a name; a name that two
 *     entries share is remembered in `duplicated`;
 *   * a removed actor that held its name is deleted from the map, unless the name is in `duplicated`: then, and for any change that
 *     is not "some entries left, some joined at the end" (entries reordered or inserted, an entry seen again), the map is rebuilt.
 * With `live`, the Set of the array's entries (null among them while a slot is null) follows the same changes.
 * The result is the fresh build's in every case (mode 'verify' compares them at each update); names are fixed for an actor's life.
 */
export class ActorNames {
  /** `last`: the map keeps the last entry of a name (the mesh lighting's), not the first; `live`: also keep the entries' Set;
   * `reference`: what mode 'js' does, the code this replaced: 'rebuild' at every advance (surfacePan's), or 'append' (the mesh
   * lighting's: when the slots seen before are all unchanged the appended ones are added, any other change rebuilds). */
  constructor({last = false, live = false, reference = 'rebuild'} = {}) {
    this.last = last;
    this.reference = reference;
    this.wantLive = live;
    this.actors = null;
    this.epoch = -1;
    this.byName = new Map();
    this.duplicated = new Set();
    this.live = live ? new Set() : null;
    // the non-null entries as last seen, in order, and the same as a Set; a second array to write the next sequence into
    this.list = [];
    this.spare = [];
    this.present = new Set();
    // the slots as last seen (the reference form, mode 'js', follows appends by comparing them)
    this.members = [];
    // what the updates did (a validator reads them)
    this.counts = {rebuilds: 0, updates: 0, appended: 0, removed: 0};
  }
  /** The name map of `actors` at `epoch` (this object's `byName` and `live` are then current). `mode` is 'kept' (the incremental form),
   * 'js' (the reference this object was made with) or 'verify' (the incremental form, compared with a fresh build at each update). */
  at(actors, epoch, mode = 'kept') {
    if (this.actors === actors && this.epoch === epoch) return this.byName;
    if (mode === 'js') {
      if (this.actors !== actors || this.reference === 'rebuild' || !this.followAppends(actors)) this.rebuild(actors, false);
    } else if (this.actors !== actors || !this.update(actors)) this.rebuild(actors, true);
    else if (mode === 'verify') this.check(actors);
    this.epoch = epoch;
    return this.byName;
  }
  rebuild(actors, kept) {
    this.counts.rebuilds++;
    const byName = new Map(), duplicated = new Set(), last = this.last, list = kept ? this.list : null;
    if (kept) list.length = 0;
    for (const actor of actors) {
      if (!actor) continue;
      if (kept) list.push(actor);
      if (byName.has(actor.name)) {
        duplicated.add(actor.name);
        if (!last) continue;
      }
      byName.set(actor.name, actor);
    }
    this.actors = actors; this.byName = byName; this.duplicated = duplicated;
    if (kept) this.present = new Set(list); else if (this.reference === 'append') this.members = actors.slice();
    if (this.wantLive) this.live = new Set(actors);
  }
  /** The reference form of the mesh lighting's map: the slots seen before all unchanged, the appended ones are added. */
  followAppends(actors) {
    const members = this.members, length = members.length;
    if (length > actors.length) return false;
    for (let i = 0; i < length; i++) if (members[i] !== actors[i]) return false;
    for (let i = length; i < actors.length; i++) {
      const actor = actors[i];
      members.push(actor);
      if (this.live !== null) this.live.add(actor);
      if (actor) this.add(actor);
    }
    return true;
  }
  /** Take `actor` into the map: its name where the name is absent, or where the map keeps the last entry of a name. */
  add(actor) {
    const byName = this.byName;
    if (byName.has(actor.name)) {
      this.duplicated.add(actor.name);
      if (!this.last) return;
    }
    byName.set(actor.name, actor);
  }
  /** Apply what left the sequence of non-null entries and what joined it at its end; false (nothing changed) for any other change. */
  update(actors) {
    const list = this.list, n = list.length, next = this.spare, present = this.present;
    next.length = 0;
    let i = 0, removed = null, appended = null, nulls = 0, undefineds = 0;
    for (let j = 0; j < actors.length; j++) {
      const actor = actors[j];
      if (!actor) {
        if (actor === null) nulls++; else if (actor === undefined) undefineds++; else return false;
        continue;
      }
      if (appended === null) {
        if (i < n && list[i] === actor) { next.push(actor); i++; continue; }
        // the entries of the old sequence before `actor` are gone; if `actor` is not in the rest of it, the appended tail starts here
        let k = i + 1;
        while (k < n && list[k] !== actor) k++;
        if (k < n) {
          for (let q = i; q < k; q++) (removed ??= []).push(list[q]);
          next.push(actor); i = k + 1;
          continue;
        }
        appended = [];
      }
      appended.push(actor);
    }
    for (let q = i; q < n; q++) (removed ??= []).push(list[q]);
    // an entry that left must not be back in the tail, nor an old one seen again: the tail holds actors the sequence never had
    if (appended !== null) for (const actor of appended) if (present.has(actor)) return false;
    const byName = this.byName, duplicated = this.duplicated, live = this.live;
    if (removed !== null) {
      // A holder that shares its name is the rebuild's to settle (which of the others is next).
      for (const gone of removed) {
        const name = gone.name;
        if (byName.get(name) === gone && duplicated.has(name)) return false;
      }
      for (const gone of removed) {
        if (byName.get(gone.name) === gone) byName.delete(gone.name);
        present.delete(gone);
        if (live !== null) live.delete(gone);
      }
      this.counts.removed += removed.length;
    }
    if (appended !== null) {
      for (const actor of appended) {
        next.push(actor); present.add(actor);
        if (live !== null) live.add(actor);
        this.add(actor);
      }
      this.counts.appended += appended.length;
    }
    if (live !== null) {
      if (nulls > 0) live.add(null); else live.delete(null);
      if (undefineds > 0) live.add(undefined); else live.delete(undefined);
    }
    this.spare = list; this.list = next;
    this.counts.updates++;
    return true;
  }
  check(actors) {
    const fresh = new Map(), last = this.last;
    for (const actor of actors) if (actor && (last || !fresh.has(actor.name))) fresh.set(actor.name, actor);
    const kept = this.byName;
    let same = fresh.size === kept.size;
    for (const [name, actor] of fresh) if (same && kept.get(name) !== actor) same = false;
    if (same && this.live !== null) {
      const live = new Set(actors);
      same = live.size === this.live.size;
      for (const actor of live) if (same && !this.live.has(actor)) same = false;
    }
    if (same) {
      // the sequence the next update starts from
      let q = 0;
      for (const actor of actors) if (actor) { if (this.list[q] !== actor) same = false; q++; }
      if (q !== this.list.length || this.present.size !== q) same = false;
    }
    if (!same) throw new Error(`ACTOR_NAMES=verify: the kept name map (${kept.size}) differs from a fresh build (${fresh.size})`);
  }
}
