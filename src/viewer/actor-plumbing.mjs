/** The actor mesh layer's host plumbing switches (docs/firefox-actors-phase.md "Host plumbing"). Three changes to how the host
 * moves the same data around the original passes; none changes what is drawn or any simulation state:
 *
 *   hidden  a plain hidden record that follows a hidden record of the same binding is not sent (actor-mesh-sim.mjs compactRecords)
 *   pairs   mesh_reads' (handle, block) pair table is kept between frames (actor-mesh-sim.mjs meshReads)
 *   movers  the moving brushes' reads are one Rust pass and an unchanged mover is not updated again (sim-session.mjs
 *           updateMovers, render.rs mover_reads)
 *
 * ACTOR_PLUMBING=js (Node) or ?actorPlumbing=js keeps the reference bodies of all three; `no-hidden`, `no-pairs`, `no-movers`
 * (a comma list) keeps one; `verify` runs the new bodies and checks each against the reference as it goes (the page checks that a
 * skipped record would have changed nothing). */
export function actorPlumbing() {
  const value = (typeof process !== 'undefined' && process.env?.ACTOR_PLUMBING) || globalThis.DEUS_EX_ACTOR_PLUMBING || '';
  const tokens = new Set(String(value).split(',').map(token => token.trim()).filter(Boolean));
  const reference = tokens.has('js');
  const on = name => !reference && !tokens.has(`no-${name}`);
  return { hidden: on('hidden'), pairs: on('pairs'), movers: on('movers'), verify: tokens.has('verify') };
}
