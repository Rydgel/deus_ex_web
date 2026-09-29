import { falling } from './falling.mjs';
import { bumpBaseEpoch } from './base-epoch.mjs';
import { decorationLanded } from './landing.mjs';
import { moveQuery } from './move-query.mjs';
import { rolling, PHYS_NONE, PHYS_FALLING, PHYS_ROLLING } from './rolling.mjs';

const f = Math.fround;

/** Link a decoration's collision-hash cylinder to its live position so it can be
 * moved. The hash keys on `valuesOf(actor).Location`; a non-mover decoration is
 * registered with a static `values.Location` array distinct from its live
 * `actor.position` (only movers link them). This re-registers the actor with a
 * `collisionValues` whose `Location` tracks `actor.position` (like a mover), so a
 * later `changeActor` removes from and re-inserts at the moved cell. Idempotent,
 * and a no-op safe to call before the first move (Location is unchanged then). */
export function linkDecorationCollision(queries, host) {
  if (host.collisionValues) return;
  const values = host.values ?? {};
  // Only a host whose +0x1dc word has bCollideActors is in the hash; a
  // non-colliding export keeps its word and stays out until SetCollision.
  const registered = Boolean(host.flags & 1);
  if (registered) queries.removeActor(host);
  host.collisionValues = { ...values,
    get Location() { return host.position; },
    get CollisionRadius() { return host.radius ?? values.CollisionRadius ?? 0; },
    get CollisionHeight() { return host.height ?? values.CollisionHeight ?? 0; } };
  if (registered) queries.addActor(host);
}

function moveDecoration(host, delta, queries) {
  const values = host.values ?? {};
  const radius = f(host.radius ?? values.CollisionRadius ?? 0);
  const height = f(host.height ?? values.CollisionHeight ?? 0);
  const actorFlags = host.actorFlags ?? 0;
  const source = { decoration: true, flags: host.flags ?? 0,
    static: Boolean(actorFlags & 1), movable: (actorFlags & 0x80000) !== 0, movingBrush: false };
  const { position, hit, time } = moveQuery({ source, worldActor: queries.levelInfo,
    start: host.position.map(f), delta, extent: [radius, radius, height],
    multiLineCheck: query => queries.multiLineCheck(query) });
  queries.changeActor(host, () => { host.position = position; });
  const wall = hit?.actor ?? null;
  // Decode the wall's Pawn ancestry so processHitWall's inlined wall->IsA(APawn)
  // gate can read it (mirrors the player move path's decorate()). Idempotent: a
  // scene that already tagged the actor keeps its flag.
  if (wall && wall.isPawn === undefined) wall.isPawn = wall.lineage?.includes('engine.pawn') ?? false;
  return { time: f(time), normal: hit?.normal?.map(f) ?? [0, 0, 0], actor: wall };
}

/** Original non-Pawn physFalling step: advance one decoration falling a timestep
 * against the live collision hash, dispatching the VM Landed event on a floor
 * contact. `onHitWall` is the reached native processHitWall boundary. */
function fallingStep(host, seconds, iterations, { queries, zone, landedEvent, onHitWall }) {
  const values = host.values ?? {};
  const gravity = (zone.ZoneGravity ?? [0, 0, -950]).map(f);
  const pawn = {
    position: (host.position ?? values.Location ?? [0, 0, 0]).map(f),
    velocity: (host.velocity ?? values.Velocity ?? [0, 0, 0]).map(f),
    acceleration: (host.acceleration ?? [0, 0, 0]).map(f),
    airControl: 0, accelRate: 0, groundSpeed: 0,
    gravity, zoneVelocity: (zone.ZoneVelocity ?? [0, 0, 0]).map(f),
    terminalVelocity: f(zone.ZoneTerminalVelocity ?? 2500),
    physics: host.physics ?? values.Physics ?? PHYS_NONE, justTeleported: false,
    landingCounter: host.landingCounter ?? 0,
    move(delta) { const hit = moveDecoration(host, delta, queries); pawn.position = host.position.map(f); return hit; },
    hitWall(hit) { onHitWall(hit); },
    landedEvent(normal) { landedEvent(normal); },
    setPhysics(next, floor) {
      // Original setPhysics (0x103c95f0): rebase and zero velocity/acceleration
      // into PHYS_None/Interpolating.
      pawn.physics = next; host.physics = next; host.base = floor ?? null; bumpBaseEpoch();
      if (next === PHYS_NONE || next === 5) { pawn.velocity = [0, 0, 0]; host.velocity = [0, 0, 0]; host.acceleration = [0, 0, 0]; }
    },
    landed(hit) { decorationLanded(pawn, hit); },
  };
  falling(pawn, seconds, iterations, {nonPawn: true});
  host.position = pawn.position;
  host.velocity = pawn.velocity;
  host.physics = pawn.physics;
  host.landingCounter = pawn.landingCounter;
  return pawn.physics;
}

/** Advance one decoration through the original non-Pawn AActor physics for a single
 * actor timestep, selecting the recovered native by the actor's Physics field:
 *
 *  - PHYS_Falling: reuse the oracle-validated physFalling/processLanded path
 *    (docs/script-plant-contact.md, docs/landing.md).
 *  - PHYS_Rolling: the oracle-validated AActor.physRolling path (src/runtime/
 *    rolling.mjs, docs/rolling.md) for a settled decoration pushed along a floor.
 *  - Any other Physics: untouched.
 *
 * A wall contact during a fall reaches the non-Pawn native processHitWall
 * (0x103cecc0), recovered and oracle-validated as `processDecorationHitWall`
 * (src/runtime/walking-callbacks.mjs, docs/walking-callbacks.md): it returns for
 * a Pawn wall and otherwise dispatches the unmodified HitWall(normal,wall) solely
 * while the decoration probes HitWall — no Pawn direction/MinHitWall/MoveTimer
 * bookkeeping. The caller supplies that as `onHitWall`. A straight settle onto a
 * floor hits Landed, not a wall, so it is not reached. Rolling handles its own
 * wall response (eventHitWall + slide) and never calls processHitWall. Audible
 * playback and AI propagation remain Stage-4 boundaries.
 *
 * `host` is the shared actor object (its `.position` is both the collision
 * cylinder and the VM Location; `.velocity`/`.physics`/`.base` are the writable
 * VM bindings). Requires linkDecorationCollision first. Evidence:
 * docs/script-plant-contact.md, docs/rolling.md, docs/move-query.md. */
export function runDecorationPhysics(host, dt, { queries, zone, landedEvent, onHitWall, onFalling, onHitWallEvent, setBase } = {}) {
  const values = host.values ?? {};
  const physics = host.physics ?? values.Physics ?? PHYS_NONE;
  if (physics !== PHYS_FALLING && physics !== PHYS_ROLLING) return physics;
  const hitWall = onHitWall ?? (() => {
    throw new Error('Decoration physics requires an onHitWall handler for the recovered non-Pawn processHitWall (0x103cecc0)');
  });

  if (physics === PHYS_FALLING)
    return fallingStep(host, dt, 0, { queries, zone, landedEvent, onHitWall: hitWall });

  rolling(host, dt, {
    zone,
    move: delta => moveDecoration(host, delta, queries),
    eventHitWall(normal, actor) { onHitWallEvent?.(normal, actor); },
    eventFalling() { onFalling?.(); },
    setPhysics(next, floor) {
      // Original setPhysics (0x103c95f0), decoration transitions.
      host.physics = next; host.base = floor ?? null; bumpBaseEpoch();
      if (next === PHYS_NONE || next === 5) { host.velocity = [0, 0, 0]; host.acceleration = [0, 0, 0]; }
    },
    physFalling(remaining, iterations) {
      fallingStep(host, remaining, iterations, { queries, zone, landedEvent, onHitWall: hitWall });
    },
    setBase(actor) { if (setBase) setBase(actor); else { host.base = actor; bumpBaseEpoch(); } },
  });
  return host.physics;
}

export { PHYS_NONE, PHYS_FALLING, PHYS_ROLLING };
