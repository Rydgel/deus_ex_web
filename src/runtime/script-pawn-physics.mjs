/** Original APawn::performPhysics (Engine.dll 0x103c9a70) for a script-attached
 * map pawn, plus its APawn::physicsRotation (0x103c9f30) and the reached
 * fixRotation mode (0x103c9dc0, motionFlags 0x40 set/0x20 clear).
 *
 * performPhysics: dispatch on the Physics byte jump table (PHYS_Walking=1 ->
 * physWalking 0x10303fd0, PHYS_Falling=2 -> physFalling 0x10302fef), then —
 * unless Physics is PHYS_Spider (0xa) — run physicsRotation when the actor
 * IsA PlayerPawn (0x1058c160) or Rotation differs from DesiredRotation or
 * RotationRate.Roll is positive. The tail decrements MoveTimer (+0x348) by
 * the timestep and recomputes AvgPhysicsTime (+0x32c) as old*0.8 + dt*0.2
 * (double math, f32 store). The original's final PendingTouch queue (+0x21c)
 * is the deferred-touch list the linked synchronous MoveActor path never
 * populates.
 *
 * physicsRotation: PlayerPawn ancestry returns immediately. Otherwise install
 * rotation mode flags (clear 0x20, set 0x40), step Yaw toward
 * DesiredRotation.Yaw by trunc(dt*RotationRate.Yaw) (fild/fmul/__ftol), step
 * Pitch toward 0 for Walking pawns and for Falling Pawn-ancestry actors
 * (DesiredRotation.Pitch otherwise) by trunc(dt*32768.0f), clamp Pitch to
 * ±RotationRate.Pitch, then ULevel::MoveActor applies the new rotation when
 * pitch/yaw changed or roll is nonzero.
 *
 * Physics modes outside {Walking, Falling} remain explicit boundaries; world
 * queries, event dispatch, zone updates and the RNG are caller services.
 * Evidence: Engine.dll bodies above; docs/player-physics.md,
 * docs/script-pawn-locomotion.md field map. */
import { falling } from './falling.mjs';
import { walking } from './walking.mjs';
import { processLanded } from './landing.mjs';
import { walkingSurfacePrelude } from './walking-surface.mjs';
import { processPlayerHitWall, setSupportBase, setBase } from './walking-callbacks.mjs';
import { setActorPhysics, findActorBase } from './script-actor-collision.mjs';
import { playerMove } from './player-move.mjs';
import { moveActorRiders } from './move-riders.mjs';
import { moveQuery } from './move-query.mjs';
import { actorBlockedBy, checkActorEncroachment } from './check-encroachment.mjs';
import { beginTouch, endTouch, isOverlapping } from './actor-touch.mjs';
import { farMoveActor } from './relocation.mjs';
import { setActorZone } from './zone.mjs';
import { linkDecorationCollision } from './decoration-physics.mjs';

const f = Math.fround;
const unsupported = name => { throw new Error(`Original pawn physics boundary not linked: ${name}`); };
const sameRotation = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** fixRotation mode (motionFlags 0x40 set, 0x20 clear — installed by
 * physicsRotation): rotate current toward target along the shorter arc by at
 * most |delta|, 16-bit masked. */
function fixToward(current, target, delta) {
  current &= 0xffff; target &= 0xffff;
  if (delta === 0) return current;
  const step = Math.abs(delta);
  const forward = (target - current) & 0xffff;
  if (forward < 0x8000) return (current + Math.min(step, forward)) & 0xffff;
  return (current - Math.min(step, (current - target) & 0xffff)) & 0xffff;
}

/** PointRegion struct field binding with the plain {zone,leaf,zoneNumber}
 * shape setActorZone reads and writes (same storage as
 * ScriptRuntime.regionValue/setRegion). */
function regionBinding(field, actor, name) {
  const ref = field(actor, name);
  const k = 'engine.actor.pointregion';
  return {
    get() {
      const v = ref.get() ?? {};
      return { zone: v[`${k}.zone`] ?? null, leaf: v[`${k}.ileaf`] ?? -1, zoneNumber: v[`${k}.zonenumber`] ?? 0 };
    },
    set(v) { ref.set({ [`${k}.zone`]: v.zone ?? null, [`${k}.ileaf`]: v.leaf ?? -1, [`${k}.zonenumber`]: v.zoneNumber ?? 0 }); },
  };
}

/** Persistent pawn view over a script-attached map actor: script-visible
 * fields route through `field(name)` bindings (Location/Velocity/Physics/
 * Base/MoveTimer/...), the native collision bitfields derive from the bool
 * fields exactly like installActorCollisionView, and host-only physics state
 * (motionFlags, hitSlopedWall, pawnFlags) lives on the actor's host props like
 * the player path's motionFlags. Cached on the actor as `_pawnPhysics`. */
export function pawnPhysicsView(actor, services) {
  if (actor._pawnPhysics) return actor._pawnPhysics;
  const { field, level, worldActor } = services;
  const get = name => field(actor, name).get();
  const set = (name, value) => field(actor, name).set(value);
  const zone = () => services.zoneFields(pawn.region.zone ?? level.pointRegion(pawn.position).zone);
  const pawn = { self: actor, worldActor, isPawn: true, pawn: true,
    controlledPlayer: false, decoration: false, movingBrush: false,
    projectile: false, model: actor.model ?? null };
  const bind = (prop, name, read = v => v, write = v => v) =>
    Object.defineProperty(pawn, prop, { get: () => read(get(name)), set: v => set(name, write(v)), enumerable: true });
  bind('position', 'Location'); bind('rotation', 'Rotation');
  bind('velocity', 'Velocity'); bind('acceleration', 'Acceleration');
  bind('physics', 'Physics', v => Number(v) & 0xff);
  bind('base', 'Base'); bind('oldLocation', 'OldLocation');
  bind('destination', 'Destination'); bind('moveTimer', 'MoveTimer');
  bind('avgPhysicsTime', 'AvgPhysicsTime'); bind('standingCount', 'StandingCount');
  bind('radius', 'CollisionRadius'); bind('height', 'CollisionHeight');
  bind('baseEyeHeight', 'BaseEyeHeight'); bind('desiredRotation', 'DesiredRotation');
  bind('rotationRate', 'RotationRate'); bind('owner', 'Owner');
  for (const [prop, name] of [['groundSpeed', 'GroundSpeed'], ['accelRate', 'AccelRate'],
    ['airControl', 'AirControl'], ['maxStepHeight', 'MaxStepHeight'], ['minHitWall', 'MinHitWall'],
    ['mass', 'Mass'], ['playerReplicationInfo', 'PlayerReplicationInfo']])
    Object.defineProperty(pawn, prop, { get: () => get(name), enumerable: true });
  for (const [prop, name] of [['canJump', 'bCanJump'], ['isWalking', 'bIsWalking'],
    ['isPlayer', 'bIsPlayer'], ['deleted', 'bDeleteMe']])
    Object.defineProperty(pawn, prop, { get: () => Boolean(get(name)), enumerable: true });
  for (const [prop, name] of [['region', 'Region'], ['footRegion', 'FootRegion'], ['headRegion', 'HeadRegion']]) {
    const ref = regionBinding(field, actor, name);
    Object.defineProperty(pawn, prop, { get: () => ref.get(), set: v => ref.set(v), enumerable: true });
  }
  // The native +0x1dc bitfield and the actor-flag word derive from the bool
  // fields exactly as installActorCollisionView encodes them (evidence:
  // AActor::SetCollision 0x10369200 flag writes, native 262/283).
  Object.defineProperty(pawn, 'collisionBits', {
    get: () => (get('bCollideActors') ? 1 : 0) | (get('bBlockActors') ? 4 : 0) |
      (get('bBlockPlayers') ? 8 : 0) | (get('bProjTarget') ? 0x10 : 0), enumerable: true });
  Object.defineProperty(pawn, 'flags', {
    get: () => pawn.collisionBits | (get('bCollideWorld') ? 2 : 0),
    set(v) { set('bCollideActors', Boolean(v & 1)); set('bBlockActors', Boolean(v & 4)); set('bBlockPlayers', Boolean(v & 8)); },
    enumerable: true });
  Object.defineProperty(pawn, 'actorFlags', {
    get: () => (get('bStatic') ? 1 : 0) | (get('bDeleteMe') ? 0x80 : 0) |
      (get('bCollideWhenPlacing') ? 0x20000 : 0) | (get('bMovable') ? 0x80000 : 0), enumerable: true });
  Object.defineProperty(pawn, 'static', { get() { return Boolean(this.actorFlags & 1); }, enumerable: true });
  Object.defineProperty(pawn, 'movable', { get() { return Boolean(this.actorFlags & 0x80000); }, enumerable: true });
  // Host collision/identity props (registration entries are values-keyed).
  for (const prop of ['lineage', 'values', 'touching'])
    Object.defineProperty(pawn, prop, { get: () => actor[prop], enumerable: true });
  Object.defineProperty(pawn, 'pawnFlags', { get: () => actor.pawnFlags ?? 0, set: v => { actor.pawnFlags = v; }, enumerable: true });
  Object.defineProperty(pawn, 'motionFlags', { get: () => actor.motionFlags ?? 0, set: v => { actor.motionFlags = v; }, enumerable: true });
  Object.defineProperty(pawn, 'justTeleported', {
    get: () => Boolean(actor.motionFlags & 0x100),
    set: v => { actor.motionFlags = ((actor.motionFlags & ~0x100) | (v ? 0x100 : 0)) >>> 0; }, enumerable: true });
  Object.defineProperty(pawn, 'hitSlopedWall', { get: () => actor.hitSlopedWall ?? false, set: v => { actor.hitSlopedWall = v; }, enumerable: true });
  // Zone-derived fields read through the actor's stored Region.Zone — the same
  // field the original physics reads after every SetActorZone update.
  Object.defineProperty(pawn, 'gravity', { get: () => (zone().ZoneGravity ?? [0, 0, -950]).map(f), enumerable: true });
  Object.defineProperty(pawn, 'zoneVelocity', { get: () => (zone().ZoneVelocity ?? [0, 0, 0]).map(f), enumerable: true });
  Object.defineProperty(pawn, 'terminalVelocity', { get: () => f(zone().ZoneTerminalVelocity ?? 2500), enumerable: true });
  Object.defineProperty(pawn, 'friction', { get: () => f(zone().ZoneGroundFriction ?? 8), enumerable: true });

  // The original collision-hash entries, Touching slots and IsBlockedBy bits
  // live on the registered host identities. Candidates that never ran the
  // scene's actor preparation are normalized on first contact — the same
  // decode the player path's decorate() performs.
  const decorate = a => {
    if (a && a !== worldActor && typeof a === 'object') {
      a.isPawn ??= a.lineage?.includes('engine.pawn') ?? false;
      a.pushableDecoration ??= Boolean(a.lineage?.includes('engine.decoration') ||
        a.lineage?.includes('deusex.deusexdecoration')) && Boolean(a.values?.bPushable);
      a.mass ??= a.values?.Mass;
      a.standingCount ??= a.values?.StandingCount ?? 0;
      a.physics ??= a.values?.Physics ?? 0;
      a.position ??= a.values?.Location;
      a.radius ??= a.values?.CollisionRadius ?? 0;
      a.height ??= a.values?.CollisionHeight ?? 0;
      a.movingBrush ??= Boolean(a.model);
      a.touching ??= [null, null, null, null];
      a.pawnFlags ??= 0;
    }
    return a;
  };
  const dispatch = (target, event, args = []) =>
    services.dispatch(target === pawn ? actor : target, event, args.map(a => a === pawn ? actor : a));
  const lineCheck = (start, end, extent, flags, extra = 0) =>
    level.hash.lineCheck(start, end, extent, flags, extra, pawn);
  pawn.lineCheck = lineCheck;
  // SetActorZone's world callbacks are the zone actor's ActorLeaving/
  // ActorEntered events plus the pawn's ZoneChange/FootZoneChange/
  // HeadZoneChange (zone.mjs order). The dry player-scene variants encode
  // JC-only counters and are deliberately not reused.
  const zoneWorld = { levelInfo: worldActor, netMode: level.netMode ?? 0,
    pointRegion: position => level.pointRegion(position),
    actorLeaving: (z, a) => dispatch(z, 'ActorLeaving', [a]),
    actorEntered: (z, a) => dispatch(z, 'ActorEntered', [a]),
    zoneChange: (a, z) => dispatch(a, 'ZoneChange', [z]),
    footZoneChange: (a, z) => dispatch(a, 'FootZoneChange', [z]),
    headZoneChange: (a, z) => dispatch(a, 'HeadZoneChange', [z]) };
  pawn.setActorZone = (test, force) => setActorZone(pawn, zoneWorld, test, force);
  pawn.move = delta => {
    const result = moveActor(pawn, delta, null, services, dispatch, decorate);
    return { time: f(result.time), normal: (result.hit?.normal ?? [0, 0, 0]).map(f), actor: result.hit?.actor ?? null };
  };
  /* ULevel::MoveActor under bTest=1 (vtable +0x88): the recovered test-move
   * the navigation natives' probing workers (checkMove/flyMove) drive. */
  pawn.testMove = (delta, rotation, flags) =>
    testMoveActor(pawn, delta, rotation, flags, services, decorate);
  pawn.farMove = (position, test, noCheck) =>
    // farMoveActor's passenger detach scans level.actors for child.base===actor;
    // map Base entries are host identities, never the view (relocation.mjs
    // reads actor.self). The detach runs the recovered SetBase through
    // farLevel.setBase.
    farMoveActor(farLevel(pawn, actor, services, dispatch), pawn, position, test, noCheck);
  pawn.findSpot = (position, extent, checkActors, checkFirst) => {
    const fitted = [...position];
    return level.findSpot(extent, fitted, checkActors, checkFirst) ? fitted : null;
  };
  pawn.random = services.random;
  pawn.walkingPrelude = () => walkingSurfacePrelude(pawn);
  pawn.airControlBlocked = delta => lineCheck(pawn.position, pawn.position.map((v, i) => f(v + delta[i])),
    [pawn.radius, pawn.radius, pawn.height], 6, 0).time < 1;
  pawn.landedEvent = normal => dispatch(actor, 'Landed', [normal]);
  pawn.fallingEvent = () => dispatch(actor, 'Falling', []);
  pawn.mayFall = () => dispatch(actor, 'MayFall', []);
  pawn.walkTexture = (texture, location, normal) => dispatch(actor, 'WalkTexture', [texture, location, normal]);
  pawn.textureForHit = hit => {
    if (hit?.actor !== worldActor) return null;
    const node = level.model.nodes[hit.item];
    if (!node) throw new Error(`WalkTexture world hit item is not a valid BSP node: ${hit.item}`);
    return level.surfaceTexture[node.surface] ?? null;
  };
  pawn.hitWall = hit => processPlayerHitWall(pawn, hit.normal, hit.actor,
    { isProbing: (target, name) => services.isProbing(actor, name), dispatch });
  pawn.landed = (hit, remaining, iterations) => processLanded(pawn, hit, remaining, iterations);
  pawn.walking = (seconds, iterations) => walking(pawn, seconds, iterations);
  pawn.falling = (seconds, iterations) => falling(pawn, seconds, iterations);
  pawn.setPhysics = (next, support = null) => setActorPhysics(pawn, next, support,
    { dispatch, findBase: a => findActorBase(a, { lineCheck, dispatch }) });
  pawn.setSupportBase = target => setSupportBase(pawn, target, dispatch);
  pawn.setBase = target => setBase(pawn, target, dispatch);

  // The recovered LoadMap pass runs SetActorZone(actor,1,1) for every actor;
  // script-attached map pawns missed it. Populate the three region fields from
  // the point query without events — the net effect of that original pass.
  if (!pawn.region.zone) {
    const position = pawn.position;
    pawn.region = level.pointRegion(position);
    pawn.footRegion = level.pointRegion([position[0], position[1], f(position[2] - pawn.height)]);
    pawn.headRegion = level.pointRegion([position[0], position[1], f(position[2] + pawn.baseEyeHeight)]);
  }
  // Track the live position in the collision hash the way a mover/decoration
  // does, so moves re-register the pawn's cylinder at the moved cell. The
  // host props the hash getters read must exist first.
  actor.position ??= get('Location')?.map(f);
  actor.rotation ??= get('Rotation');
  actor.radius ??= get('CollisionRadius');
  actor.height ??= get('CollisionHeight');
  actor.isPawn ??= true;
  actor.touching ??= [null, null, null, null];
  linkDecorationCollision(level.hash, actor);
  return actor._pawnPhysics = pawn;
}

/** Original ULevel::MoveActor for the pawn: the recovered move body with the
 * general non-player IsBlockedBy and an optional absolute NewRotation (the
 * rotation-update path physicsRotation reaches). Hash slots and Touch events
 * act on the registered host identity, not the field view. */
function moveActor(pawn, delta, newRotation, services, dispatch, decorate) {
  const { level, worldActor } = services;
  return playerMove(pawn, delta, {
    worldActor,
    multiLineCheck: query => level.hash.multiLineCheck(query).map(h => (decorate(h.actor), h)),
    removeActor: () => level.hash.removeActor(pawn.self),
    addActor: () => level.hash.addActor(pawn.self),
    dispatch,
    isBlockedBy: (source, other) => actorBlockedBy(source, decorate(other), { worldActor }),
    isOverlapping: (a, b) => isOverlapping(a, decorate(b)),
    beginTouch: (a, b) => beginTouch(a, decorate(b), dispatch),
    endTouch: (a, b, suppress) => endTouch(a, decorate(b), suppress, dispatch),
    setActorZone: (a, test, force) => a === pawn ? pawn.setActorZone(test, force)
      : unsupported('MoveActor zone update for a non-pawn source'),
    // 0x103998a0-0x10399bb0: based riders ride the committed move. The base
    // identity riders store is the host actor (pawn.self), not the view; the
    // recursive rider MoveActor only admits spawned collision-view riders
    // (ScriptRuntime.moveSpawnedActor raises the explicit boundary for any
    // other identity).
    moveRiders: (src, finalDelta, rot) => moveActorRiders(pawn.self, finalDelta, rot, {
      actors: level.actors,
      baseOf: other => other.base !== undefined ? other.base : services.field(other, 'Base').get(),
      location: other => other.position ?? services.field(other, 'Location').get(),
      rotation: other => other.rotation ?? services.field(other, 'Rotation').get(),
      isPawn: other => Boolean(other.lineage?.includes('engine.pawn')),
      addViewRotationYaw: (other, dyaw) => {
        const ref = services.field(other, 'ViewRotation');
        const value = ref.get();
        ref.set([value[0], (value[1] + dyaw) | 0, value[2]]);
      },
      moveActor: (other, riderDelta, riderRot) => services.moveRider
        ? services.moveRider(other, riderDelta, riderRot)
        : unsupported('rider MoveActor'),
      actorLocation: () => pawn.position,
      actorRotation: () => pawn.rotation,
    }),
  }, newRotation);
}

/** ULevel::MoveActor with bTest=1 (vtable +0x88, Engine.dll 0x103990e0): the
 * query prefix, FCheckResult write, position/rotation commit, hash
 * re-registration and SetActorZone(actor,test=1,0) still run; the
 * standing-rider, fit-retry and Touch event sections are gated off by bTest.
 * The navigation workers (checkMove 0x103c3290, flyMove 0x103c3900) call it
 * with bIgnorePawns=1, bIgnoreBalls=0, bNoFail=0. Returns the FCheckResult
 * fields the workers read: { time, normal, actor, item }. */
function testMoveActor(pawn, delta, newRotation, flags, services, decorate) {
  const { level, worldActor } = services;
  if ((flags?.test ?? 0) !== 1 || (flags?.ignoreBalls ?? 0) !== 0 || (flags?.noFail ?? 0) !== 0)
    throw new Error(`MoveActor flag combination is not linked: test=${flags?.test} ignoreBalls=${flags?.ignoreBalls} noFail=${flags?.noFail}`);
  const miss = { time: 1, normal: [0, 0, 0], actor: null, item: -1 };
  // 0x1039912d: non-editor !static && !movable -> return 0, untouched fields.
  // A static source passes this gate; moveQuery's shared player-path static
  // rejection then answers it as a no-move (its position/hit outcome matches
  // what a sub-epsilon commit produces).
  if (!pawn.static && pawn.movable === false) return miss;
  const rotation = newRotation ? newRotation.slice() : [...pawn.rotation];
  if (delta.every(v => Math.abs(v) < .0001)) {               // 0x1039915a..0x103991c6
    if (sameRotation(rotation, pawn.rotation)) return miss;  // rot equal -> ret 1
    if (!pawn.standingCount) { pawn.rotation = rotation; return miss; }
    // StandingCount nonzero falls into the full path; the recovered query
    // answers it without multiLineCheck, and the commit/zone steps still run.
  }
  const query = moveQuery({ source: pawn, worldActor, start: pawn.position,
    delta, extent: [pawn.radius, pawn.radius, pawn.height],
    multiLineCheck: q => level.hash.multiLineCheck(q).map(h => (decorate(h.actor), h)),
    ignorePawns: Boolean(flags?.ignorePawns) });
  // 0x10399c9a: hash remove -> commit location/rotation -> hash add (0x10399d11).
  if (pawn.flags & 1) level.hash.removeActor(pawn.self);
  pawn.position = query.position;
  pawn.rotation = rotation;
  if (pawn.flags & 1) level.hash.addActor(pawn.self);
  pawn.setActorZone(1, 0);                                    // 0x10399f0f
  return query.hit ? { time: query.hit.time, normal: query.hit.normal?.slice() ?? [0, 0, 0],
    actor: query.hit.actor ?? null, item: query.hit.item ?? -1 } : miss;
}

/** farMoveActor's level needs the non-player encroachment variant and the
 * pawn's zone update. The hash query runs on the host identity so the
 * candidate===actor self-exclusion holds. */
function farLevel(pawn, actor, services, dispatch) {
  const level = Object.create(services.level);
  // The collision hash registers the host identity, not the field view; the
  // queries wrappers key bounds/location on the registered object. Map the
  // view arg to the host so remove/add actually re-register the pawn's
  // cylinder instead of silently no-oping on the unregistered view.
  const hash = Object.create(services.level.hash);
  hash.removeActor = a => services.level.hash.removeActor(a === pawn ? actor : a);
  hash.addActor = a => services.level.hash.addActor(a === pawn ? actor : a);
  // The base level's `hash` is an accessor; shadow it with an own property.
  Object.defineProperty(level, 'hash', { value: hash, enumerable: true });
  level.checkEncroachment = (a, position, rotation, notify) =>
    checkActorEncroachment(a, position, rotation, notify, {
      worldActor: services.worldActor, dispatch,
      encroachmentCheck: (s, p, r, e) => services.level.hash.actorEncroachmentCheck(s === pawn ? actor : s, p, r, e) });
  level.setActorZone = (a, test, force) => a === pawn ? pawn.setActorZone(test, force)
    : unsupported('FarMoveActor zone update for a non-pawn source');
  // 0x10398e10 region: a non-test far move of a pawn with StandingCount!=0
  // detaches every based child through the recovered AActor::SetBase
  // (SetBase(child, NULL, 1) -> StandingCount-1 -> Detach -> BaseChange).
  level.setBase = (child, target, notify) => setBase(child, target, dispatch, notify);
  return level;
}

/** APawn::physicsRotation (0x103c9f30): face DesiredRotation at RotationRate,
 * then MoveActor when the rotation actually changed. */
function physicsRotation(pawn, dt, services, dispatch) {
  if (services.isA(pawn.self, 'engine.playerpawn')) return;
  pawn.motionFlags = ((pawn.motionFlags & ~0x20) | 0x40) >>> 0;
  const yaw = fixToward(pawn.rotation[1], pawn.desiredRotation[1], Math.trunc(pawn.rotationRate[1] * dt));
  const pitchTarget = pawn.physics === 1 || (pawn.physics === 2 && services.isA(pawn.self, 'engine.pawn'))
    ? 0 : pawn.desiredRotation[0];
  let pitch = fixToward(pawn.rotation[0], pitchTarget, Math.trunc(dt * f(32768)));
  const limit = pawn.rotationRate[0];
  if (pitch < 0x8000) { if (pitch > limit) pitch = limit; }
  else { const lo = 0x10000 - limit; if (pitch < lo) pitch = lo; }
  if (pitch !== pawn.rotation[0] || yaw !== pawn.rotation[1] || pawn.rotation[2] !== 0)
    moveActor(pawn, [0, 0, 0], [pitch, yaw, 0], services, dispatch);
}

/** APawn::performPhysics (0x103c9a70), dry standalone dispatch. Non-Pawn
 * actors keep their own recovered routes (decorations: runDecorationPhysics). */
export function runScriptPawnPhysics(actor, dt, services) {
  if (!services.isA(actor, 'engine.pawn')) unsupported('non-Pawn APawn::performPhysics');
  const pawn = pawnPhysicsView(actor, services);
  const delta = f(dt);
  const dispatch = (target, event, args = []) =>
    services.dispatch(target === pawn ? actor : target, event, args.map(a => a === pawn ? actor : a));
  switch (pawn.physics) {
    case 1: pawn.walking(delta, 0); break;
    case 2: pawn.falling(delta, 0); break;
    default: unsupported(`APawn::performPhysics Physics=${pawn.physics}`);
  }
  if (pawn.physics !== 0xa && (services.isA(actor, 'engine.playerpawn') ||
      !sameRotation(pawn.rotation, pawn.desiredRotation) || pawn.rotationRate[2] > 0))
    physicsRotation(pawn, delta, services, dispatch);
  pawn.moveTimer = f(pawn.moveTimer - delta);
  pawn.avgPhysicsTime = f(pawn.avgPhysicsTime * 0.8 + delta * 0.2);
}
