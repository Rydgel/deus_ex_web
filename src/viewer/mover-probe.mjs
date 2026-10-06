/** Validation only (docs/brush-tracker.md "Play"): the moving brush
 * tracker's movers on whichever side runs the simulation (sim-worker.mjs
 * `call`, or the page with ?sim=inline). `set` writes movers' Location
 * (and Rotation) directly, as a test placement; returns each tracked
 * mover's fragment count and the polygons the last main frame drew.
 * `renderTimes` adds every actor's LastRenderTime (name to seconds). */
export function moverProbe(game, session, { set = null, renderTimes = false } = {}) {
  const runtime = game.doors.scriptRuntime.runtime, level = runtime.levelFor(game.player.collisionActor);
  for (const { name, location, offset, rotation } of set ?? []) {
    const actor = level.actors.find(a => a?.name === name);
    if (!actor) throw new Error(`moverProbe: no actor ${name}`);
    const at = offset ? [...runtime.readNamed(actor, 'Location')].map((v, i) => v + offset[i]) : location;
    // A mover through the collision model (its hash entry and the collider
    // offset the page draws it with), as MoveActor leaves it.
    const mover = game.collision.movers.find(m => m.name === name);
    if (at && mover) game.collision.setMoverPosition(mover, at);
    else if (at) runtime.writeNamed(actor, 'Location', at.map(Math.fround));
    if (rotation) runtime.writeNamed(actor, 'Rotation', rotation.map(v => v | 0));
  }
  const state = session.moverState();
  if (renderTimes) state.renderTimes = Object.fromEntries(level.actors.filter(Boolean)
    .map(actor => [actor.name, runtime.readNamed(actor, 'LastRenderTime')]));
  return state;
}
