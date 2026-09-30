/** Host bookkeeping for the MoveActor rider pass (move-riders.mjs), not an
 * original structure. The counter advances on every write of any actor's
 * Base, on every structural change of a Level.Actors array, and on storage
 * events that change what a Base read returns or throws (bulk restores,
 * poisoning, releases). A rider list recorded by a full Level.Actors scan
 * stays exactly the list that scan would produce while the counter is unchanged.
 * The perception natives' Level.Actors list (script-vm-perception.mjs) uses
 * the same counter, which host bindings advance too (bindProperty). */
let epoch = 0;
export const baseEpoch = () => epoch;
export const bumpBaseEpoch = () => { epoch++; };
