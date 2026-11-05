/** Which registered actors' collision cylinders are the object image's own cells (docs/collision-hash.md, "The hash reads
 * the image"): the cylinder `valuesOf(actor)` gives the collision hash (level-queries.mjs) is Location, CollisionRadius
 * and CollisionHeight read through
 *
 * - a spawned actor's collision view (script-actor-collision.mjs): its field storage, which is the object image for a
 *   class linked at the retail offsets;
 * - a map host's live collision values (actor-pose-fields.mjs liveCylinderInImage): its pose members, accessors over
 *   image cells once installed.
 *
 * Every other actor (a brush, a host whose `collisionValues` is absent and whose cylinder is its serialized values, the
 * player's facade) is read through JavaScript. For the ones named above, hash.rs reads the cells itself where its
 * receiver table says the image holds them as readNamed reads them, and the JavaScript import answers otherwise. */
import {existingHandle} from './script-object-handles.mjs';
import {hasCollisionViewValues} from './script-actor-collision.mjs';
import {liveCylinderInImage, moverPoseInImage} from './actor-pose-fields.mjs';

/** The image identity (its handle) hash.rs reads `actor`'s cylinder from, or 0 for the JavaScript to read it. */
export function cylinderImageHandle(actor) {
  if (actor.model || !actor.collisionValues) return 0;
  const handle = existingHandle(actor);
  if (handle === 0) return 0;
  return hasCollisionViewValues(actor) || liveCylinderInImage(actor) ? handle : 0;
}

/** The numbers `valuesOf(actor)` gives the hash for a map actor that never moved (no `collisionValues`: its cylinder is its
 * serialized values, which nothing writes), [x, y, z, radius, height], and its image identity: hash.rs answers with them
 * while the image holds the same float32s (collision-kernel.mjs `describe`). Null for any other actor. */
export function serializedCylinder(actor) {
  if (actor.model || actor.collisionValues || actor.controlledPlayer) return null;
  const values = actor.values, location = values?.Location;
  if (!Array.isArray(location) || location.length !== 3) return null;
  const radius = values.CollisionRadius ?? 0, height = values.CollisionHeight ?? 0;
  if (typeof location[0] !== 'number' || typeof location[1] !== 'number' || typeof location[2] !== 'number'
    || typeof radius !== 'number' || typeof height !== 'number') return null;
  return existingHandle(actor) === 0 ? null : [location[0], location[1], location[2], radius, height];
}

/** The image identity hash.rs reads a mover brush's pose (Location, Rotation) from, or 0. A mover's ToWorld is a
 * function of that pose and of PrePivot, PostScale and MainScale, which its `collisionValues` (game.mjs) hold as
 * copies of the serialized values that nothing writes: hash.rs keeps the ToWorld the host computed for a pose and
 * answers with it while the image holds that pose again (collision-kernel.mjs `fillBrush`). */
export function brushImageHandle(actor) {
  if (!actor.model || !actor.collisionValues || !moverPoseInImage(actor)) return 0;
  return existingHandle(actor);
}
