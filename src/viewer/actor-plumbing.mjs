/** The actor mesh layer's host plumbing switches (docs/firefox-actors-phase.md "Host plumbing"). Three changes to how the host
 * moves the same data around the original passes; none changes what is drawn or any simulation state:
 *
 *   hidden  a plain hidden record that follows a hidden record of the same binding is not sent (actor-mesh-sim.mjs compactRecords)
 *   pairs   mesh_reads' (handle, block) pair table is kept between frames (actor-mesh-sim.mjs meshReads)
 *   movers  the moving brushes' reads are one Rust pass and an unchanged mover is not updated again (sim-session.mjs
 *           updateMovers, render.rs mover_reads)
 *
 * and, from the bulk actors layer (docs/firefox-60fps-plan.md "Actors layer in bulk"), the layer's own summary and update loop:
 *
 *   summary the summary object's lists and counts are computed when read (actor-mesh-sim.mjs refreshSummary), not at every take and retire
 *   roster  the bindings' blocks, their membership in Level.Actors, their Mesh change and the admission scan's candidates are one Rust pass
 *           over a table of rows kept with the binding list (render.rs roster_reads, admit_filter; actor-mesh-sim.mjs reconcileRoster)
 *   pack    the main frame's SetupDynamics candidates for the bindings are ordered and packed by one Rust pass over the roster
 *           (render.rs pack_order, pack_words; dynamics-candidates.mjs packFromRoster; needs `roster`)
 *   skip    a binding that returned a plain hidden record in a frame with an occlusion result, and is in neither the main frame's
 *           Frame->Sprite nor a child frame's, is not updated again (actor-mesh-sim.mjs update; needs `hidden`)
 *
 * ACTOR_PLUMBING=js (Node) or ?actorPlumbing=js keeps the reference bodies of all of them; `no-hidden`, `no-pairs`, `no-movers`,
 * `no-summary`, `no-skip`, `no-roster`, `no-pack` (a comma list) keeps one; `verify` runs the new bodies and checks each against the reference as it goes (the page checks that a
 * skipped record would have changed nothing). */
export function actorPlumbing() {
  const value = (typeof process !== 'undefined' && process.env?.ACTOR_PLUMBING) || globalThis.DEUS_EX_ACTOR_PLUMBING || '';
  const tokens = new Set(String(value).split(',').map(token => token.trim()).filter(Boolean));
  const reference = tokens.has('js');
  const on = name => !reference && !tokens.has(`no-${name}`);
  const hidden = on('hidden');
  return { hidden, pairs: on('pairs'), movers: on('movers'), summary: on('summary'), roster: on('roster'), pack: on('pack'), skip: hidden && on('skip'), verify: tokens.has('verify') };
}
