/** Module load hooks for scripts/bench-sim.mjs --bypass, and the same source
 * patches for scripts/profile-play-browser.mjs --bypass (host measurement only).
 *
 * Some maps reach explicit, unimplemented original boundaries soon after
 * Player start (native 708 AIDirectionReachable where reached). Play pauses
 * there by design. To measure the cost of a *running* simulation, --bypass rewrites
 * those throws into early returns. The rewritten behavior is NOT original:
 * frames after a bypass are only a workload for timing and for A/B state
 * digests of the same build pair. aiPickSearch's waterMove patch was removed
 * when APawn::swimMove landed (docs/script-pawn-nav.md "Swimming contract"),
 * and the performPhysics default patch once neither map's bench workload
 * reached it (errors {} without it, docs/roadmap.md).
 */
export const BYPASS_PATCHES = [
  [/\/src\/runtime\/script-doors\.mjs$/,
    'throw new Error(`Unsupported original door native ${call.index} in ${path}`);',
    'if(call.index===708)return false;throw new Error(`Unsupported original door native ${call.index} in ${path}`);'],
];

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const patch = BYPASS_PATCHES.find(([pattern]) => pattern.test(new URL(url).pathname));
  if (!patch) return result;
  const source = String(result.source);
  if (!source.includes(patch[1])) throw new Error(`bench-sim bypass no longer matches ${url}`);
  return {...result, source: source.replace(patch[1], patch[2])};
}
