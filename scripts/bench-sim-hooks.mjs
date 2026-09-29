/** Module load hooks for scripts/bench-sim.mjs --bypass, and the same source
 * patches for scripts/profile-play-browser.mjs --bypass (host measurement only).
 *
 * A map can reach explicit, unimplemented original boundaries soon after
 * Player start. Play pauses there by design. To measure the cost of a *running*
 * simulation, --bypass rewrites those throws into early returns. The rewritten
 * behavior is NOT original: frames after a bypass are only a workload for timing
 * and for A/B state digests of the same build pair. Each patch is removed when
 * its behavior lands: aiPickSearch's waterMove patch with APawn::swimMove
 * (docs/script-pawn-nav.md "Swimming contract"), the performPhysics default
 * patch once neither map's bench workload reached it (errors {} without it,
 * docs/roadmap.md), and native 708's `return false` with
 * execAIDirectionReachable (docs/script-pawn-nav.md "AIDirectionReachable
 * native 708").
 *
 * The list is empty: --bypass then loads every module unchanged. An entry is
 * [path pattern, exact source text, replacement]; a pattern whose text no
 * longer matches fails the load rather than running unpatched.
 */
export const BYPASS_PATCHES = [];

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const patch = BYPASS_PATCHES.find(([pattern]) => pattern.test(new URL(url).pathname));
  if (!patch) return result;
  const source = String(result.source);
  if (!source.includes(patch[1])) throw new Error(`bench-sim bypass no longer matches ${url}`);
  return {...result, source: source.replace(patch[1], patch[2])};
}
