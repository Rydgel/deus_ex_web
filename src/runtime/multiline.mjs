const f = Math.fround;
const copyHit = hit => ({ ...hit, location: [...hit.location], normal: [...hit.normal] });

function compare(a, b) {
  // Original x87 unordered comparison takes the same first branch as <.
  if (a.time < b.time || Number.isNaN(a.time) || Number.isNaN(b.time)) return -1;
  return a.time > b.time ? 1 : 0;
}

/** The supplied MSVCRT.dll qsort (0x7802543d), specialized to FCheckResult.
 * Preserve its unstable ordering of ties and its eight-entry partition cutoff.
 * Engine's comparator at 0x1039c060 observes only Time.
 */
export function sortLineHits(hits) {
  // Zero or one entry: the qsort below pops one range of fewer than two.
  if (hits.length < 2) return hits;
  const swap = (a, b) => { [hits[a], hits[b]] = [hits[b], hits[a]]; };
  const pending = [[0, hits.length - 1]];
  while (pending.length) {
    const [low, high] = pending.pop(), count = high - low + 1;
    if (count < 2) continue;
    if (count <= 8) {
      for (let end = high; end > low; end--) {
        let maximum = low;
        for (let i = low + 1; i <= end; i++) if (compare(hits[i], hits[maximum]) > 0) maximum = i;
        swap(maximum, end);
      }
      continue;
    }
    swap(low, low + (count >> 1));
    let forward = low, backward = high + 1;
    for (;;) {
      do { forward++; } while (forward <= high && compare(hits[forward], hits[low]) <= 0);
      do { backward--; } while (backward > low && compare(hits[backward], hits[low]) >= 0);
      if (backward < forward) break;
      swap(forward, backward);
    }
    swap(low, backward);
    const left = [low, backward - 1], right = [forward, high];
    // Native comparison uses byte distances and subtracts one byte on the left.
    if ((backward - low) * 44 - 1 < (high - forward) * 44) {
      if (right[0] < right[1]) pending.push(right);
      if (left[0] < left[1]) pending.push(left);
    } else {
      if (left[0] < left[1]) pending.push(left);
      if (right[0] < right[1]) pending.push(right);
    }
  }
  return hits;
}

/** Original ULevel.MultiLineCheck, Engine.dll 0x1039b220.
 * queries supplies original worldLineCheck and ordered actorLineCheck results,
 * hashPresent, and inherited isMover(actor). The actor list's Time/Location
 * fields are mutated as in the DLL; returned results are copied and relinked.
 * Array order represents the native linked-list order at the query boundary.
 */
export function multiLineCheck(queries, end, start, extent, checkActors, worldActor, extra = 0) {
  end = end.map(f); start = start.map(f); extent = extent.map(f);
  const hits = [];
  let factor = 1, onlyMovers = false, world = null;
  if (worldActor) {
    world = queries.worldLineCheck([...end], [...start], [...extent], extra & 0xff);
    if (world) {
      world = copyHit(world);
      world.actor = worldActor;
      hits.push(world);
      const difference = world.location.map((v, i) => v - start[i]);
      const d = Math.sqrt(difference[0] ** 2 + difference[1] ** 2 + difference[2] ** 2);
      factor = f(Math.min(1, (d + 5) * world.time / (d + f(.0001))));
      end = [f(start[0] + f(f(end[0] - start[0]) * factor)),
        f(start[1] + f(f(end[1] - start[1]) * factor)), f(start[2] + (end[2] - start[2]) * factor)];
      onlyMovers = world.time < .01 && d < 30;
    }
  }
  if (checkActors && queries.hashPresent) {
    const actors = queries.actorLineCheck([...end], [...start], [...extent], extra);
    for (const actorHit of actors) {
      if (hits.length >= 64) break;
      const mover = queries.isMover(actorHit.actor);
      if (onlyMovers && !mover) continue;
      if (world && mover && actorHit.normal.every((v, i) => v === world.normal[i])) {
        const separation = actorHit.location.map((v, i) => v - world.location[i]);
        if (separation[0] ** 2 + separation[1] ** 2 + separation[2] ** 2 < 4) {
          const rawX = end[0] - start[0], delta = end.map((v, i) => f(v - start[i]));
          // X is retained across its store for the first squared product.
          const length = Math.sqrt(rawX * delta[0] + delta[1] ** 2 + delta[2] ** 2), reciprocal = 1 / length;
          const backoff = [f((reciprocal * delta[0]) * 2),
            f(f(reciprocal * delta[1]) * 2), f(f(reciprocal * delta[2]) * 2)];
          actorHit.location = world.location.map((v, i) => f(v - backoff[i]));
          const distance = actorHit.location.map((v, i) => f(v - start[i]));
          actorHit.time = f(Math.sqrt(distance[2] ** 2 + distance[1] ** 2 + distance[0] ** 2) / f(length));
        }
      }
      actorHit.time = f(factor * actorHit.time);
      hits.push(copyHit(actorHit));
    }
  }
  sortLineHits(hits);
  for (let i = 0; i < hits.length; i++) hits[i].next = hits[i + 1] ?? null;
  return hits;
}
