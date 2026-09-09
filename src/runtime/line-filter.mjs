const f = Math.fround;
const classFlags = [['LevelInfo', 4], ['Pawn', 1], ['Mover', 2], ['ZoneInfo', 8]];

/** Original ULevel.SingleLineCheck, Engine.dll 0x1039aed0.
 * queries supplies inherited isA(), levelInfo, and an already ordered
 * multiLineCheck(end, start, extent, checkActors, worldActor, extra) result list.
 * The hash, primitive checks and ordering remain separate dependencies.
 * Actors expose owner and the original collision bitfield (actor +0x1dc).
 * Mutates the caller's FCheckResult fields; returns native 1=clear, 0=hit.
 */
export function singleLineCheck(queries, hit, source, end, start, flags, extent = [0, 0, 0], extra = 0) {
  const hits = queries.multiLineCheck(end.map(f), start.map(f), extent.map(f),
    flags & 0x17 ? 1 : 0, flags & 4 ? queries.levelInfo : null, extra);
  candidates: for (const candidate of hits) {
    for (let owner = source; owner; owner = owner.owner) {
      if (owner === candidate.actor) continue candidates;
    }
    let recognized = false;
    for (const [kind, required] of classFlags) {
      if (!queries.isA(candidate.actor, kind)) continue;
      if (!(flags & required)) continue candidates;
      recognized = true;
      break;
    }
    if (!recognized) {
      if (!(flags & 0x10)) continue;
      const bits = candidate.actor.collisionBits;
      if (flags & 0x20 && !(bits & 0x10) && (bits & 0x0c) !== 0x0c) continue;
    }
    // The native copy includes the list link and primitive/item fields. Copy
    // vectors by value, preserving the caller/result independence of 44 bytes.
    for (const field of ['next', 'actor', 'primitive', 'time', 'item']) hit[field] = candidate[field];
    hit.location = [...candidate.location];
    hit.normal = [...candidate.normal];
    return 0;
  }
  hit.time = 1;
  hit.actor = null;
  return 1;
}
