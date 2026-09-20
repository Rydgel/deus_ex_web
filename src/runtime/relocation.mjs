const f = Math.fround;
const collides = actor => Boolean(actor.flags & 1);

/** Original ULevel.FarMoveActor10398ba0. Scene callbacks are mandatory when
 * reached; this routine establishes their order, not their implementation.
 * level.hash supplies removeActor/addActor using the actor's current bounds.
 * findSpot mutates the supplied destination and returns its original boolean.
 * Actor flags at +28 are distinct from collision flags at +1dc (`flags`). */
export function farMoveActor(level, actor, destination, test = 0, noCheck = 0) {
  if (((actor.actorFlags & 1) || !(actor.actorFlags & 0x80000)) && !level.editor) return false;
  if (collides(actor) && level.hash) level.hash.removeActor(actor);
  const position = destination.map(f);
  let success = true;
  if (!noCheck && ((actor.flags & 2) || ((actor.actorFlags & 0x20000) && level.netMode !== 3))) {
    success = Boolean(level.findSpot([f(actor.radius), f(actor.radius), f(actor.height)], position, 0, 0));
  }
  if (success && !test && !noCheck) success = !level.checkEncroachment(actor, position, actor.rotation, 1);
  if (success) {
    if (!test) {
      if (actor.standingCount) {
        // Children store the mover's identity in +0xc4 Base; callers that
        // move through a field view (the pawn view) carry it as `self`.
        const self = actor.self ?? actor;
        for (let index = 0; index < level.actors.length; index++) {
          const child = level.actors[index];
          if (child && child.base === self) level.setBase(child, null, true);
        }
      }
      actor.motionFlags = ((actor.motionFlags ?? 0) | 0x100) >>> 0;
    }
    actor.position = position.slice();
    actor.oldLocation = position.slice();
  }
  if (collides(actor) && level.hash) level.hash.addActor(actor);
  if (success) level.setActorZone(actor, test, 0);
  return success;
}

/** Original AActor.SetCollisionSize10369320. Negative sizes are legal at this
 * native boundary; the calling DeusEx script performs its own clamp. */
export function setCollisionSize(level, actor, radius, height) {
  if (collides(actor) && level.hash) level.hash.removeActor(actor);
  actor.radius = f(radius);
  actor.height = f(height);
  if (collides(actor) && level.hash) level.hash.addActor(actor);
}
