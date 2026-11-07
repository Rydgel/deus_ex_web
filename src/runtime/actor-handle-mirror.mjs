/**
 * The handles of a Level.Actors array, kept between rebuilds (host bookkeeping for the Rust core's copies of the array, not an
 * original structure): the level loop's list (actor-tick-kernel.mjs), the render scans' list (script-vm-render.mjs) and the perception
 * natives' list (script-vm-perception.mjs) are each rebuilt after every structural change of the array (base-epoch.mjs actorsEpoch)
 * as `handleOf(actors[i])` for every slot, a hash lookup on a cold identity each, though a SpawnActor or a DestroyActor changes one
 * or two slots. `sync` compares each slot with what the mirror saw last and asks `handleOf` only for those that differ.
 *
 * Exact by construction: a live identity's handle never changes (script-object-handles.mjs allocates it once and never reuses it),
 * except through a release, which advances `releaseCount`; a sync after one starts over. HANDLE_MIRROR=js (HANDLE_MIRROR /
 * DEUS_EX_HANDLE_MIRROR) rebuilds every slot with `handleOf` as before, and =verify does both and throws on a difference.
 */
import {handleOf, releaseCount} from './script-object-handles.mjs';
import {switchReader} from './switch-reader.mjs';

/** 'mirror' (default), 'js' or 'verify'. */
export const handleMirrorMode = switchReader('HANDLE_MIRROR', 'DEUS_EX_HANDLE_MIRROR', 'mirror');

export class HandleMirror {
  constructor() {
    this.actors = null;
    this.prev = [];
    this.handles = new Uint32Array(0);
    this.count = 0;
    this.releases = -1;
  }
  /** Bring the mirror to `actors` as it is now. Returns the slots that were recomputed (an array of indices, empty when none
   * changed), or null when every slot was (a new array, a release since the last sync, or `js` mode). `handles[0..count)` then
   * holds the handles, 0 for an empty slot. */
  sync(actors) {
    const count = actors.length, mode = handleMirrorMode();
    const full = mode === 'js' || this.actors !== actors || this.releases !== releaseCount();
    if (this.handles.length < count) {
      const grown = new Uint32Array(Math.max(1024, 2 * count));
      grown.set(this.handles.subarray(0, this.count));
      this.handles = grown;
    }
    const handles = this.handles, prev = this.prev, kept = full ? 0 : Math.min(this.count, count);
    const changed = full ? null : [];
    for (let i = 0; i < count; i++) {
      const actor = actors[i];
      if (i < kept && prev[i] === actor) continue;
      handles[i] = actor ? handleOf(actor) : 0;
      prev[i] = actor;
      if (changed) changed.push(i);
    }
    prev.length = count;
    if (mode === 'verify' && !full) {
      for (let i = 0; i < count; i++) {
        const want = actors[i] ? handleOf(actors[i]) : 0;
        if (handles[i] !== want) throw new Error(`HANDLE_MIRROR=verify: slot ${i} holds handle ${handles[i]}, handleOf says ${want}`);
      }
    }
    this.actors = actors;
    this.count = count;
    this.releases = releaseCount();
    return changed;
  }
}
