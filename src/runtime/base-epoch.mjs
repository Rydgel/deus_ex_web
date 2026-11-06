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
let epoch = 0, actors = 0, cells = 0;
const listeners = [];
/** 'kept' (default), 'js' or 'verify': RIDER_TABLE / DEUS_EX_RIDER_TABLE. 'js' keeps the reference: every advance below also drops
 * the rider scan's table of Base reads (move-riders.mjs), as the single `bumpBaseEpoch` did before the table was kept. */
let tableMode = null;
export const riderTableMode = () => tableMode ??= (typeof process !== 'undefined' && process.env?.RIDER_TABLE) || globalThis.DEUS_EX_RIDER_TABLE || 'kept';
export const baseEpoch = () => epoch;
export const actorsEpoch = () => actors;
/** What the rider scan's table of direct Base reads is valid for (move-riders.mjs baseTableFor): the advances that can change
 * what a read of some live actor's Base cell returns or whether it is a plain read, other than those `bumpBaseEpochFor` names an
 * identity for (`cellsNotedSince`) and the pure array movements (`bumpBaseMoveEpoch`). */
export const cellEpoch = () => cells;
/** Call `listener(actorsEpoch)` after every advance (the Rust level loop's mirror, actor-tick-kernel.mjs `batch`). */
export const onActorsEpoch = listener => { listeners.push(listener); };
export const bumpBaseEpoch = () => { epoch++; actors++; cells++; for (const listener of listeners) listener(actors); };
export const bumpActorsEpoch = () => { actors++; for (const listener of listeners) listener(actors); };
/** An advance for a change of `Level.Actors` that only moves actors between slots (CompactActors' shifts, a slot nulled or written):
 * no actor's cells changed, and the table of direct reads follows the identities it holds per slot. The rider lists and everything
 * else that follows the epoch advance as with `bumpBaseEpoch`. */
export const bumpBaseMoveEpoch = () => { epoch++; actors++; if (riderTableMode() === 'js') cells++; for (const listener of listeners) listener(actors); };
// The identities `bumpBaseEpochFor` noted, in order, `logBase` entries having been dropped from the front.
const noted = [];
let notedBase = 0;
/** An advance for an event that changes the reads of `identity`'s own cells only (its Base link installed, its storage restored,
 * its image released): the rider scan's table forgets that identity's slot and keeps the rest. */
export const bumpBaseEpochFor = identity => {
  epoch++; actors++;
  if (riderTableMode() === 'js') cells++;
  else {
    noted.push(identity);
    if (noted.length > 4096) { noted.splice(0, 2048); notedBase += 2048; }
  }
  for (const listener of listeners) listener(actors);
};
/** The position after the last identity noted. */
export const notedEnd = () => notedBase + noted.length;
/** The identities noted since position `from`, or null when the log no longer reaches back that far. */
export const notedSince = from => from < notedBase ? null : noted.slice(from - notedBase);
/** The rider scan's table of direct Base reads per Level.Actors array (move-riders.mjs): {epoch: the cellEpoch it is valid for,
 * noted: the position in the noted identities it has applied, arena, hosts[slot]: the identity the slot was filled for, ats[slot]:
 * the arena address of that actor's Base word, or 0 for an actor that takes the plain reads}. */
export const baseTables = new WeakMap();
/** CompactActors moved the actor in slot `from` to slot `to`: the table's entry for that actor goes with it. */
export function moveBaseSlot(actorsArray, from, to) {
  const table = baseTables.get(actorsArray);
  if (table === undefined || riderTableMode() === 'js') return;
  table.hosts[to] = table.hosts[from];
  table.ats[to] = table.ats[from];
}
/** CompactActors cut the array to `length`: the table's entries beyond it go. */
export function cutBaseSlots(actorsArray, length) {
  const table = baseTables.get(actorsArray);
  if (table === undefined || table.hosts.length <= length) return;
  table.hosts.length = length;
  table.ats.length = Math.min(table.ats.length, length);
}
const changes = new WeakMap();
export const riderEpochOf = mover => changes.get(mover) ?? 0;
export function noteBaseChange(oldBase, newBase) {
  if (oldBase === newBase) return;
  if (oldBase !== null && typeof oldBase === 'object') changes.set(oldBase, (changes.get(oldBase) ?? 0) + 1);
  if (newBase !== null && typeof newBase === 'object') changes.set(newBase, (changes.get(newBase) ?? 0) + 1);
}
