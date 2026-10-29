/**
 * Allocation-site warm-up (docs/live-heap.md "Cut: promoted garbage").
 *
 * V8 pretenures an allocation site (an array or object literal, an `Array(n)` call) whose objects were mostly still alive at a
 * scavenge: from then on every object the site makes is allocated in old space, and dies there. Chromium's `--trace-pretenuring`
 * log (its threshold line reads 0.80) shows the states: a site is "undecided", then "maybe tenure" or "tenure" when at least 100 of
 * its objects were counted and 80% survived, or "don't tenure" when they were counted and fewer survived. Over a whole session
 * no site left "tenure" or "don't tenure" (545 and 47 repeat decisions, none a change), so the first window with 100 objects counted
 * decides for good.
 *
 * The first windows of a worker are its map load, which keeps nearly everything it reads and builds. The sites the load shares with
 * the frame loop (the object image's composite reads, the script frames) were all decided "tenure" there, and every vector and frame
 * the frame loop makes through them since then is born in old space: about 100 KB per worker frame on the Island, three quarters of
 * the old generation's growth (13.4 MB/s against 3.6 MB/s with `--no-allocation-site-pretenuring`), which is what starts the major
 * GCs.
 *
 * A module that owns such a site registers a warmer: a function that runs the site's code `count` times on values it drops at
 * once. `warmAllocationSites()` runs them all before the first map is read (the worker's `init`, the inline host's first
 * `createSimHost`) and then allocates garbage until a scavenge counts them, so each site's first window has a survival rate of
 * zero and its decision is "don't tenure". The warmers use fabricated inputs and keep nothing: they read and write nothing the
 * simulation owns, so what it computes is unchanged.
 *
 * Finding a site that needs one: `node scripts/promotion-probe.mjs --sites 20` (leaf functions that left the young generation,
 * headless), compared with the same run under `--no-allocation-site-pretenuring`; what vanishes there was pretenured.
 */
const warmers = [];
let warmed = false;

/** Add `warm(count)` to the warm-up: it runs the registering module's allocation sites `count` times and keeps nothing. */
export function registerAllocationSiteWarmer(warm) { warmers.push(warm); }

// Each round's allocations per site stay well over V8's 100-object minimum for a decision.
const PER_ROUND = 400, ROUNDS = 2;

let sink = null;
/** Allocate short-lived garbage until at least one scavenge has run (a semi-space is 1 MB at the start of an isolate). */
function scavenge() {
  for (let i = 0; i < 1 << 17; i++) sink = [i, i + 0.5, sink === null];
  sink = null;
}

/** Run every registered warmer, then scavenge, so the sites they exercise are decided "don't tenure" before any load keeps the
 * values they make. Once per isolate; returns whether it ran. */
export function warmAllocationSites() {
  if (warmed) return false;
  warmed = true;
  for (let round = 0; round < ROUNDS; round++) {
    for (const warm of warmers) warm(PER_ROUND);
    scavenge();
  }
  return true;
}
