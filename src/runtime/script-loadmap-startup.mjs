/**
 * Recovered `UGameEngine::LoadMap` actor-array primitives (Engine.dll image
 * base 0x10300000, function body 0x1038c1f0).
 *
 * The original runs map startup as separate passes over the live
 * `ULevel::Actors` TArray instead of a per-actor event chain. Every pass loop
 * rereads the array data pointer (+0x2c) and Num (+0x30) on each iteration,
 * skips null slots, and advances by index: an actor appended during a pass is
 * reached by that same pass, while a destroyed actor's cleared slot drops it
 * out of every later pass (PreBeginPlay 0x1038d99a-0x1038d9cc, BeginPlay
 * 0x1038d9ce-0x1038da02, SetActorZone 0x1038da02-0x1038da26, LastRenderTime
 * 0x1038da26-0x1038da45, PostBeginPlay 0x1038da45-0x1038da79, SetInitialState
 * 0x1038da79-0x1038daad, base fixup 0x1038daad-0x1038dbe0, PostPostBeginPlay
 * 0x1038dc65-0x1038dc9d).
 */

/** One original pass over the live actor array. The TArray data pointer is
 * reread each iteration (`level.actors` identity), so a mid-pass realloc —
 * an append that replaces the storage — is observed exactly like the
 * original's `mov eax,[ecx+0x2c]` reread; Num is likewise reread so appends
 * extend the current pass. Null slots are skipped. */
export function forEachLiveActor(level, body) {
  for (let index = 0; ; index++) {
    const actors = level.actors;
    if (index >= actors.length) break;
    const actor = actors[index];
    if (actor == null) continue;
    body(actor, index);
  }
}

/** The LoadMap tail (0x1038dcd5-0x1038de5x): rebuild `Level.Actors` as
 * [slot 0, slot 1, ...non-null static actors, ...non-null dynamic actors].
 * Slots 0 and 1 are copied verbatim — slot 1 keeps a null when one is there —
 * and every later slot is compacted, so refused-export nulls and actors
 * destroyed mid-startup drop out of the live array. `Level+0x110`
 * (`iFirstNetActor`) receives the write count after the static partition.
 * Returns the rebuilt array plus that boundary index; the caller owns the
 * `level.actors` slot and the `iFirstNetActor` bookkeeping. */
export function partitionActorArray(actors, isStatic) {
  const head = [actors[0] ?? null, actors.length > 1 ? actors[1] ?? null : null];
  const statics = [], dynamic = [];
  for (let index = 2; index < actors.length; index++) {
    const actor = actors[index];
    if (actor == null) continue;
    (isStatic(actor) ? statics : dynamic).push(actor);
  }
  return { actors: [...head, ...statics, ...dynamic], firstNetActor: head.length + statics.length };
}
