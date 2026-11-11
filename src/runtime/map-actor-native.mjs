/**
 * Native actor surface of a serialized map actor (a level export), shared by
 * the recovered ULevel move/relocation and AActor collision bodies.
 *
 * A spawned actor carries a field-backed collision view
 * (script-actor-collision.mjs installActorCollisionView). A map actor is the
 * level-load host object itself: its `position`, `radius`, `height`,
 * `rotation`, `base`, `standingCount` and `touching` are the native members.
 * `base` and `touching` are host state that script-doors.mjs binds the
 * matching script fields onto. The others are accessors over its object
 * image: the flag words (`flags`, `actorFlags`, `motionFlags`,
 * actor-flag-words.mjs), `standingCount` (actor-mirror-fields.mjs) and the
 * pose (`position`, `rotation`, `radius`, `height`, a map move host's
 * `oldLocation`, actor-pose-fields.mjs). See docs/script-map-actor-move.md.
 *
 * Retail AActor layout (sdk-layouts.mjs, checked against the GOTY DLLs):
 *   +0x1dc bit0 bCollideActors, bit1 bCollideWorld, bit2 bBlockActors,
 *          bit3 bBlockPlayers, bit4 bProjTarget        -> host `flags`
 *   +0x1ec bit8 (+0x1ed bit0) bJustTeleported          -> host `motionFlags`
 *   +0x114 Location, +0x120 Rotation                   -> host `position`, `rotation`
 *   +0x12c OldLocation                                 -> host `oldLocation`
 *   +0x1d4 CollisionRadius, +0x1d8 CollisionHeight     -> host `radius`, `height`
 */

import { flagWordsOf } from './actor-flag-words.mjs';
import { liveCylinderValues } from './actor-pose-fields.mjs';

/** The +0x1dc word from serialized/default property values. */
export function collisionFlagsFrom(values) {
  return (values?.bCollideActors ? 1 : 0) | (values?.bCollideWorld ? 2 : 0) | (values?.bBlockActors ? 4 : 0)
    | (values?.bBlockPlayers ? 8 : 0) | (values?.bProjTarget ? 0x10 : 0);
}

/** Store the +0x1dc word on a map host. `flags` is the native word; the
 * other members are the host's per-bit copies read by the line filter
 * (`collisionBits`, the word without bCollideWorld), the mover and player
 * scene (`collideActors`, `collideWorld`, `blockActors`, `blockPlayers`) and
 * the frob trace (`blocking`). They are all rewritten here so no reader sees
 * a stale bit. The hash is not touched: that is the caller's native body. */
export function writeCollisionFlags(host, flags) {
  flags >>>= 0;
  // An attached map actor's word is its image (actor-flag-words.mjs); the
  // per-bit members derive from it.
  if (flagWordsOf(host)?.collision) { host.flags = flags; return; }
  host.flags = flags;
  host.collisionBits = flags & ~0x2;
  host.collideActors = Boolean(flags & 0x1);
  host.collideWorld = Boolean(flags & 0x2);
  host.blockActors = Boolean(flags & 0x4);
  host.blockPlayers = Boolean(flags & 0x8);
  host.blocking = host.blockPlayers;
}

/** The level-queries hash keys a registration on `collisionValues ?? values`.
 * A map actor registers with its serialized `values`, so its cylinder does
 * not follow `position`. Before a native body moves it, give it live
 * Location/CollisionRadius/CollisionHeight (as linkDecorationCollision does
 * for a falling decoration and game.mjs for a mover), re-registering it only
 * when it is in the hash (+0x1dc bit0). Idempotent. */
export function linkLiveCollision(queries, host) {
  if (host.collisionValues) return;
  const values = host.values ?? {};
  const registered = Boolean(host.flags & 1);
  if (registered) queries.removeActor(host);
  host.collisionValues = liveCylinderValues(host, values);
  if (registered) queries.addActor(host);
}

/** Whether a host is a non-pawn, non-brush map actor with the full native
 * surface the recovered move bodies read. Pawns keep their own recovered
 * move entry (script-pawn-physics.mjs), brushes the mover entry, and the
 * controlled player the player scene. */
export function isMapMoveHost(host) {
  return Boolean(host) && !host.controlledPlayer && !host.isPawn && !host.movingBrush && !host.model
    && Number.isInteger(host.flags) && Number.isInteger(host.actorFlags)
    && Array.isArray(host.position) && Array.isArray(host.touching) && host.touching.length === 4;
}
