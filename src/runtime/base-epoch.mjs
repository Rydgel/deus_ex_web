/** Host bookkeeping for the MoveActor rider pass (move-riders.mjs) and the
 * perception natives' Level.Actors list (script-vm-perception.mjs), not an
 * original structure.
 *
 * `baseEpoch` advances on every change of a Level.Actors array that moves an
 * index (compaction, a reinsertion, a bulk restore, a slot written from
 * script) and on every storage event that changes what a read returns or
 * throws: bulk restores, poisoning, releases, and a host binding of
 * Actor.Base (bindProperty; any other binding advances only `actorsEpoch`).
 * A rider list recorded by a full Level.Actors scan is
 * exactly the list that scan would produce while the epoch is unchanged and
 * no Base it depends on changed; a slot appended by SpawnActor or nulled by
 * DestroyActor moves no index, and the pass skips a null slot as the scan
 * does, so those two advance only `actorsEpoch`.
 *
 * `actorsEpoch` advances on every one of those events and on every
 * SpawnActor append and DestroyActor removal: the perception natives'
 * Level.Actors list (its handles and receiver infos) follows it.
 *
 * A write of one actor's Base changes only the rider lists of the old and the
 * new base. `noteBaseChange(old, new)` counts it on those two identities and
 * `riderEpochOf(mover)` is the count a mover's rider list records beside the
 * epoch, so a Base change elsewhere in the level leaves the list in use. */
let epoch = 0, actors = 0;
const listeners = [];
export const baseEpoch = () => epoch;
export const actorsEpoch = () => actors;
/** Call `listener(actorsEpoch)` after every advance (the Rust level loop's mirror, actor-tick-kernel.mjs `batch`). */
export const onActorsEpoch = listener => { listeners.push(listener); };
export const bumpBaseEpoch = () => { epoch++; actors++; for (const listener of listeners) listener(actors); };
export const bumpActorsEpoch = () => { actors++; for (const listener of listeners) listener(actors); };
const changes = new WeakMap();
export const riderEpochOf = mover => changes.get(mover) ?? 0;
export function noteBaseChange(oldBase, newBase) {
  if (oldBase === newBase) return;
  if (oldBase !== null && typeof oldBase === 'object') changes.set(oldBase, (changes.get(oldBase) ?? 0) + 1);
  if (newBase !== null && typeof newBase === 'object') changes.set(newBase, (changes.get(newBase) ?? 0) + 1);
}
