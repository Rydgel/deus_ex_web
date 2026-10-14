/** Original APawn::performPhysics (Engine.dll 0x103c9a70) for a script-attached
 * map pawn, plus its APawn::physicsRotation (0x103c9f30) and the reached
 * fixRotation mode (0x103c9dc0, motionFlags 0x40 set/0x20 clear).
 *
 * performPhysics: dispatch on the Physics byte jump table (PHYS_Walking=1 ->
 * physWalking 0x10303fd0, PHYS_Falling=2 -> physFalling 0x10302fef,
 * PHYS_Swimming=3 -> physSwimming 0x10303215, PHYS_Flying=4 -> physFlying
 * 0x10301ee7; table 0x103c9cdc), then —
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
 * Physics modes outside {Walking, Falling, Swimming, Flying} remain explicit boundaries; world
 * queries, event dispatch, zone updates and the RNG are caller services.
 * Evidence: Engine.dll bodies above; docs/player-physics.md,
 * docs/script-pawn-locomotion.md field map. */
import { falling } from './falling.mjs';
import { fixedTurn } from './actor-rotation.mjs';
import { walking } from './walking.mjs';
import { physFlying } from './flying.mjs';
import { physSwimming, startSwimming } from './swimming.mjs';
import { processLanded } from './landing.mjs';
import { walkingSurfacePrelude } from './walking-surface.mjs';
import { processPlayerHitWall, setSupportBase, setBase } from './walking-callbacks.mjs';
import { setActorPhysics, findActorBase } from './script-actor-collision.mjs';
import { playerMove } from './player-move.mjs';
import { moveActorRiders } from './move-riders.mjs';
import { moveQuery } from './move-query.mjs';
import { actorBlockedBy, checkActorEncroachment } from './check-encroachment.mjs';
import { ACTOR_IDENTITY, beginTouch, endTouch, isOverlapping } from './actor-touch.mjs';
import { farMoveActor } from './relocation.mjs';
import { setActorZone } from './zone.mjs';
import { linkDecorationCollision } from './decoration-physics.mjs';
import { flagWordsOf } from './actor-flag-words.mjs';
import { x87add, x87double, x87load, x87mul, x87store } from './script-vm.mjs';
import { scriptVmKernel } from './script-vm-kernel.mjs';
import { physPathing } from './pathing.mjs';
import { interpolationVelocity } from './actor-physics.mjs';

const f = Math.fround;
const unsupported = name => { throw new Error(`Original pawn physics boundary not linked: ${name}`); };
const sameRotation = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

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
 * fields exactly like installActorCollisionView, the +0x1ec motion word is the
 * actor's own (`actor.motionFlags`, an accessor over its object image), and
 * host-only physics state (pawnFlags) lives on the actor's host props. Cached
 * on the actor as `_pawnPhysics`. */
export function pawnPhysicsView(actor, services) {
  if (actor._pawnPhysics) return actor._pawnPhysics;
  const { field, level, worldActor } = services;
  // Value accessors when the runtime provides them: the view's getters run
  // for every physics query, and an lvalue per read is pure host overhead.
  const get = services.read ? name => services.read(actor, name) : name => field(actor, name).get();
  const set = services.write ? (name, value) => services.write(actor, name, value)
    : (name, value) => field(actor, name).set(value);
  const zone = () => services.zoneFields(pawn.region.zone ?? level.pointRegion(pawn.position).zone);
  if (typeof services.isA !== 'function') unsupported('Pawn physics requires original class ancestry');
  const pawn = { self: actor, worldActor, isPawn: true, pawn: true,
    get controlledPlayer() { return Boolean(services.isA(actor, 'engine.playerpawn') && get('Player') != null); },
    decoration: false, movingBrush: false,
    projectile: false, model: actor.model ?? null };
  // The view stands for `actor` in the IsBasedOn/SetBase walks, and
  // BeginTouch/EndTouch refuse it (actor-touch.mjs). A symbol key: not one of
  // the view's enumerable keys.
  Object.defineProperty(pawn, ACTOR_IDENTITY, { value: actor });
  const bind = (prop, name, read = v => v, write = v => v) =>
    Object.defineProperty(pawn, prop, { get: () => read(get(name)), set: v => set(name, write(v)), enumerable: true });
  bind('position', 'Location'); bind('rotation', 'Rotation');
  bind('velocity', 'Velocity'); bind('acceleration', 'Acceleration');
  bind('physics', 'Physics', v => Number(v) & 0xff);
  bind('base', 'Base'); bind('oldLocation', 'OldLocation');
  bind('destination', 'Destination'); bind('moveTimer', 'MoveTimer');
  bind('avgPhysicsTime', 'AvgPhysicsTime'); bind('standingCount', 'StandingCount');
  bind('radius', 'CollisionRadius'); bind('height', 'CollisionHeight');
  bind('baseEyeHeight', 'BaseEyeHeight'); bind('eyeHeight', 'EyeHeight');
  bind('desiredRotation', 'DesiredRotation');
  bind('rotationRate', 'RotationRate'); bind('owner', 'Owner');
  bind('pendingTouch', 'PendingTouch');
  for (const [prop, name] of [['groundSpeed', 'GroundSpeed'], ['accelRate', 'AccelRate'],
    ['airControl', 'AirControl'], ['maxStepHeight', 'MaxStepHeight'], ['minHitWall', 'MinHitWall'],
    ['mass', 'Mass'], ['buoyancy', 'Buoyancy'], ['airSpeed', 'AirSpeed'], ['waterSpeed', 'WaterSpeed'], ['desiredSpeed', 'DesiredSpeed'],
    ['viewRotation', 'ViewRotation'], ['playerReplicationInfo', 'PlayerReplicationInfo']])
    Object.defineProperty(pawn, prop, { get: () => get(name), enumerable: true });
  // A map pawn's flag members read its image's flag words
  // (actor-flag-words.mjs), the storage of the bool fields themselves.
  const words = flagWordsOf(actor), imaged = Boolean(words?.collision && words.actor);
  if (words && !words.motion) throw new Error(`Map pawn ${actor.name} has no +0x1ec image word (actor-flag-words.mjs)`);
  for (const [prop, name] of [['canJump', 'bCanJump'], ['isPlayer', 'bIsPlayer'], ['deleted', 'bDeleteMe'],
    ['collideWorld', 'bCollideWorld'], ['bounce', 'bBounce']])
    Object.defineProperty(pawn, prop, { get: imaged && prop === 'deleted' ? () => Boolean(actor.actorFlags & 0x80)
      : imaged && prop === 'collideWorld' ? () => Boolean(actor.flags & 0x2) : () => Boolean(get(name)), enumerable: true });
  // The ladder branch (0x103cc5ed) sets bIsWalking before physFlying.
  bind('isWalking', 'bIsWalking', Boolean, Boolean);
  // calcVelocity/physFlying test the class chain for PlayerPawn (0x1058c160).
  const isPlayerPawn = services.isA(actor, 'engine.playerpawn');
  Object.defineProperty(pawn, 'isPlayerPawn', { get: () => isPlayerPawn, enumerable: true });
  Object.defineProperty(pawn, 'netMode', { get: () => level.netMode ?? 0, enumerable: true });
  Object.defineProperty(pawn, 'zoneNumber', { get: () => pawn.region.zoneNumber, enumerable: true });
  for (const [prop, name] of [['region', 'Region'], ['footRegion', 'FootRegion'], ['headRegion', 'HeadRegion']]) {
    const ref = regionBinding(field, actor, name);
    Object.defineProperty(pawn, prop, { get: () => ref.get(), set: v => ref.set(v), enumerable: true });
  }
  // The native +0x1dc bitfield and the actor-flag word: a map pawn's image
  // words, else derived from the bool fields exactly as
  // installActorCollisionView encodes them (evidence: AActor::SetCollision
  // 0x10369200 flag writes, native 262/283). The `flags` setter writes
  // bCollideActors, bBlockActors and bBlockPlayers.
  if (imaged) {
    Object.defineProperty(pawn, 'collisionBits', { get: () => actor.collisionBits, enumerable: true });
    Object.defineProperty(pawn, 'flags', {
      get: () => actor.flags, set(v) { actor.flags = ((actor.flags & ~0xd) | (v & 0xd)) >>> 0; }, enumerable: true });
    Object.defineProperty(pawn, 'actorFlags', { get: () => actor.actorFlags, enumerable: true });
  } else {
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
  }
  Object.defineProperty(pawn, 'static', { get() { return Boolean(this.actorFlags & 1); }, enumerable: true });
  Object.defineProperty(pawn, 'movable', { get() { return Boolean(this.actorFlags & 0x80000); }, enumerable: true });
  // Host collision/identity props (registration entries are values-keyed).
  for (const prop of ['lineage', 'values', 'touching'])
    Object.defineProperty(pawn, prop, { get: () => actor[prop], enumerable: true });
  Object.defineProperty(pawn, 'pawnFlags', { get: () => actor.pawnFlags ?? 0, set: v => { actor.pawnFlags = v; }, enumerable: true });
  // The +0x1ec word the original physics reads and writes on the actor
  // itself: bJustTeleported (0x100) cleared at the top of physWalking
  // 0x103ca83e, physFalling 0x103d0f04, physFlying 0x103d3177 and
  // physSwimming 0x103d3d76, set by FarMoveActor 0x10398db7 and stepUp
  // 0x103ce64e, tested before each Velocity recompute; bRotateToDesired
  // (0x40) set and bFixedRotationDir (0x20) cleared by APawn::physicsRotation
  // 0x103c9faa. A map pawn's and a spawned pawn's `motionFlags` are accessors
  // over that image word (actor-flag-words.mjs, script-actor-collision.mjs),
  // the storage of the script bools; there is no separate host copy.
  Object.defineProperty(pawn, 'motionFlags', { get: () => actor.motionFlags ?? 0, set: v => { actor.motionFlags = v; }, enumerable: true });
  Object.defineProperty(pawn, 'justTeleported', {
    get: () => Boolean(pawn.motionFlags & 0x100),
    set: v => { pawn.motionFlags = ((pawn.motionFlags & ~0x100) | (v ? 0x100 : 0)) >>> 0; }, enumerable: true });
  // bHitSlopedWall is a declared Pawn bool (Pawn.uc, "used by Physics"): the
  // +0x318 word's 0x20 bit (script-runtime.mjs Flags318, the walking oracle's
  // case field). One storage for the Rust loop and this reference.
  bind('hitSlopedWall', 'bHitSlopedWall', Boolean, Boolean);
  // Zone-derived fields read through the actor's stored Region.Zone — the same
  // field the original physics reads after every SetActorZone update.
  Object.defineProperty(pawn, 'gravity', { get: () => (zone().ZoneGravity ?? [0, 0, -950]).map(f), enumerable: true });
  Object.defineProperty(pawn, 'zoneVelocity', { get: () => (zone().ZoneVelocity ?? [0, 0, 0]).map(f), enumerable: true });
  Object.defineProperty(pawn, 'terminalVelocity', { get: () => f(zone().ZoneTerminalVelocity ?? 2500), enumerable: true });
  Object.defineProperty(pawn, 'friction', { get: () => f(zone().ZoneGroundFriction ?? 8), enumerable: true });
  // 1.2 is Engine.u's serialized ZoneInfo default, for zones read from values.
  Object.defineProperty(pawn, 'fluidFriction', { get: () => f(zone().ZoneFluidFriction ?? 1.2), enumerable: true });
  Object.defineProperty(pawn, 'zoneGravityZ', { get: () => pawn.gravity[2], enumerable: true });
  // Swimming reads bWaterZone (ZoneInfo+0x388 bit 0) of Region.Zone and
  // HeadRegion.Zone as MoveActor's SetActorZone left them, and of the
  // UModel::PointRegion zone at a findWaterLine midpoint; physFalling's
  // water-zone guard reads Region and FootRegion (docs/swimming.md). Derived
  // reads, not script fields: not enumerable, like `surfaceScan` below.
  const water = z => Boolean(z && services.zoneFields(z).bWaterZone);
  Object.defineProperty(pawn, 'regionWater', { get: () => water(pawn.region.zone) });
  Object.defineProperty(pawn, 'headWater', { get: () => water(pawn.headRegion.zone) });
  Object.defineProperty(pawn, 'footWater', { get: () => water(pawn.footRegion.zone) });
  // physFalling's PlayerPawn foot-water integration (0x103d1086) damps with
  // FootRegion.Zone->ZoneFluidFriction; it is read only while footWater holds.
  Object.defineProperty(pawn, 'footFluidFriction', { get: () => f(services.zoneFields(pawn.footRegion.zone).ZoneFluidFriction ?? 1.2) });
  Object.defineProperty(pawn, 'waterAt', { value: position => water(level.pointRegion(position.map(f)).zone) });

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
  // physicsRotation's MoveActor reaches the same candidate normalization.
  Object.defineProperty(pawn, 'decorate', { value: decorate });
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
  // The common case runs in Rust (zone-kernel.mjs) on the actor's image.
  pawn.setActorZone = (test, force) => services.zoneUpdate?.(actor, test, force) || setActorZone(pawn, zoneWorld, test, force);
  // The native MoveActor entry for script Move/SetBasedPawnSize: an equal
  // NewRotation takes the same path as none (0x1039915a).
  pawn.moveActorHit = (delta, rotation = null, ignoreBases = false) => {
    const result = moveActor(pawn, delta, rotation && !sameRotation(rotation, pawn.rotation) ? rotation : null,
      services, dispatch, decorate, ignoreBases);
    const hit = { result: Boolean(result.success), time: f(result.time), normal: (result.hit?.normal ?? [0, 0, 0]).map(f),
      actor: result.hit?.actor ?? null };
    services.moveTrace?.('moveActor', actor, delta, pawn.position, hit);   // validation only (nav-trace.mjs)
    return hit;
  };
  pawn.moveActor = (delta, rotation, ignoreBases = false) => pawn.moveActorHit(delta, rotation, ignoreBases).result;
  Object.defineProperty(pawn, 'dispatchEvent', { value: dispatch });
  pawn.move = delta => {
    const result = moveActor(pawn, delta, null, services, dispatch, decorate);
    const hit = { time: f(result.time), normal: (result.hit?.normal ?? [0, 0, 0]).map(f), actor: result.hit?.actor ?? null };
    services.moveTrace?.('move', actor, delta, pawn.position, hit);   // validation only (nav-trace.mjs)
    return hit;
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
  pawn.walkingPrelude = (seconds, iterations) => walkingSurfacePrelude(pawn, seconds, iterations);
  pawn.airControlBlocked = delta => lineCheck(pawn.position, pawn.position.map((v, i) => f(v + delta[i])),
    [pawn.radius, pawn.radius, pawn.height], 6, 0).time < 1;
  pawn.landedEvent = normal => dispatch(actor, 'Landed', [normal]);
  pawn.fallingEvent = () => dispatch(actor, 'Falling', []);
  pawn.fellOutOfWorld = () => dispatch(actor, 'FellOutOfWorld', []);
  pawn.mayFall = () => dispatch(actor, 'MayFall', []);
  pawn.walkTexture = (texture, location, normal) => dispatch(actor, 'WalkTexture', [texture, location, normal]);
  pawn.textureForHit = hit => {
    if (hit?.actor !== worldActor) return null;
    const node = level.model.nodes[hit.item];
    if (!node) throw new Error(`WalkTexture world hit item is not a valid BSP node: ${hit.item}`);
    return level.surfaceTexture[node.surface] ?? null;
  };
  // walking-surface.mjs's scan in one Rust call (docs/rust-core.md R3-b):
  // the queries of `lineCheck` above and the table of `textureForHit`. Not
  // enumerable, as `decorate`: a view reachable from script properties is
  // walked by its keys (bench-sim's digest), which stay as they were.
  Object.defineProperty(pawn, 'surfaceScan', { value: (start, ends, position, floorEnd) =>
    level.hash.surfaceScan?.(start, ends, position, floorEnd, pawn, level.model, level.surfaceTexture, worldActor) });
  pawn.hitWall = hit => processPlayerHitWall(pawn, hit.normal, hit.actor,
    { isProbing: (target, name) => services.isProbing(actor, name), dispatch });
  pawn.landed = (hit, remaining, iterations) => processLanded(pawn, hit, remaining, iterations);
  // The dry walking loop runs in Rust on the pawn's image when the
  // interpreter admits the pawn (walk-loop-kernel.mjs, docs/rust-core.md
  // B5), with MoveActor's services for the moves it makes there; otherwise,
  // or when Rust hands the call back before any effect, the body runs here.
  let walkOps = null;
  const opsOfWalk = () => walkOps ??= { level, worldActor, move: moveOps(pawn, services, dispatch, decorate, false) };
  pawn.walking = (seconds, iterations = 0) => {
    if (!services.walkLoop?.(pawn, seconds, iterations, opsOfWalk())) walking(pawn, seconds, iterations);
  };
  // The walk's services for performPhysics in Rust (pawn-physics-kernel.mjs).
  // Not enumerable, as `surfaceScan`.
  Object.defineProperty(pawn, 'walkOps', { value: opsOfWalk });
  pawn.falling = (seconds, iterations) => falling(pawn, seconds, iterations);
  pawn.flying = (seconds, iterations) => physFlying(pawn, seconds, iterations);
  pawn.swimming = (seconds, iterations) => physSwimming(pawn, seconds, iterations);
  pawn.startSwimming = (oldVelocity, timeTick, remaining, iterations) =>
    startSwimming(pawn, oldVelocity, timeTick, remaining, iterations);
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
    pawn.headRegion = level.pointRegion([position[0], position[1], f(position[2] + pawn.eyeHeight)]);
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
function moveActor(pawn, delta, newRotation, services, dispatch, decorate = pawn.decorate, ignoreBases = false) {
  const ops = moveOps(pawn, services, dispatch, decorate, ignoreBases);
  // The body runs in Rust on the pawn's image when the interpreter admits
  // the source (move-pawn-kernel.mjs, docs/rust-core.md B4), with these same
  // services as its effects; otherwise, or when Rust hands the call back
  // before any store, the JavaScript body runs.
  const completed = services.movePawn?.(pawn, delta, newRotation, ignoreBases, ops);
  if (completed !== undefined) return completed;
  return playerMove(pawn, delta, ops, newRotation);
}

/** MoveActor's services for `pawn`: the effects the body reaches, in the
 * shape player-move.mjs takes. The walking loop in Rust (walk-loop-kernel.mjs)
 * takes the same set for the moves it makes directly. */
function moveOps(pawn, services, dispatch, decorate, ignoreBases) {
  const { level, worldActor } = services;
  const readOther = (other, name) => services.read ? services.read(other, name) : services.field(other, name).get();
  return {
    worldActor,
    multiLineCheck: query => level.hash.multiLineCheck(query).map(h => (decorate(h.actor), h)),
    removeActor: () => level.hash.removeActor(pawn.self),
    addActor: () => level.hash.addActor(pawn.self),
    dispatch,
    isBlockedBy: (source, other) => actorBlockedBy(source, decorate(other), { worldActor }),
    isOverlapping: (a, b) => isOverlapping(a, decorate(b)),
    // Touching slots hold actor identities: the reciprocal AddTouch writes the
    // source into the other actor's slot, and DestroyActor/EndTouch later match
    // that slot against the registered actor. Pass the host, never the view.
    beginTouch: (a, b) => beginTouch(a === pawn ? pawn.self : a, decorate(b), dispatch),
    endTouch: (a, b, suppress) => endTouch(a === pawn ? pawn.self : a, decorate(b), suppress, dispatch),
    setActorZone: (a, test, force) => a === pawn ? pawn.setActorZone(test, force)
      : unsupported('MoveActor zone update for a non-pawn source'),
    // 0x103998a0-0x10399bb0: based riders ride the committed move. The base
    // identity riders store is the host actor (pawn.self), not the view; the
    // recursive rider MoveActor only admits spawned collision-view riders
    // (ScriptRuntime.moveSpawnedActor raises the explicit boundary for any
    // other identity).
    moveRiders: (src, finalDelta, rot) => moveActorRiders(pawn.self, finalDelta, rot, {
      riderCacheKey: 'pawn-physics',
      actors: level.actors,
      baseOf: other => { const base = other.base; return base !== undefined ? base : readOther(other, 'Base'); },
      location: other => other.position ?? readOther(other, 'Location'),
      rotation: other => other.rotation ?? readOther(other, 'Rotation'),
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
    ignoreBases,
  };
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
  // FarMoveActor 0x10398ba0 calls CheckEncroachment with notify 1
  // (docs/relocation.md step 3), so its EndTouch/BeginTouch pass
  // (0x1039a7e7-0x1039a8d6, docs/check-encroachment.md) writes and matches
  // Touching slots. As in moveActor, those slots hold actor identities
  // (AActor*): pass the host, never the view.
  level.checkEncroachment = (a, position, rotation, notify) =>
    checkActorEncroachment(a, position, rotation, notify, {
      worldActor: services.worldActor, dispatch,
      encroachmentCheck: (s, p, r, e) => services.level.hash.actorEncroachmentCheck(s === pawn ? actor : s, p, r, e),
      beginTouch: (a, b) => beginTouch(a === pawn ? actor : a, b, dispatch),
      endTouch: (a, b, suppress) => endTouch(a === pawn ? actor : a, b, suppress, dispatch) });
  level.setActorZone = (a, test, force) => a === pawn ? pawn.setActorZone(test, force)
    : unsupported('FarMoveActor zone update for a non-pawn source');
  // 0x10398e10 region: a non-test far move of a pawn with StandingCount!=0
  // detaches every based child through the recovered AActor::SetBase
  // (SetBase(child, NULL, 1) -> StandingCount-1 -> Detach -> BaseChange).
  level.setBase = (child, target, notify) => setBase(child, target, dispatch, notify);
  return level;
}

/** APawn::physicsRotation (0x103c9f30), its decisions: face DesiredRotation at RotationRate, and the NewRotation of the
 * MoveActor it ends with (null: none). The raw integer Rotation and DesiredRotation are compared as stored, not masked:
 * - a PlayerPawn takes neither step (0x103c9f75..0x103c9f96 jumps to 0x103ca058) but still zeroes a nonzero Roll;
 * - any other pawn sets bRotateToDesired and clears bFixedRotationDir (0x103c9faa), steps Yaw only while
 *   DesiredRotation.Yaw differs from Rotation.Yaw (0x103c9fc2) and Pitch only while DesiredRotation.Pitch differs from
 *   Rotation.Pitch (0x103c9fd5), so a pawn whose Rotation already equals its DesiredRotation keeps its raw Rotation
 *   (a map rotation such as (-4, -32404) stays until a script changes it) and keeps a nonzero equal Pitch while it
 *   walks or falls; the Pitch step goes toward 0 for Walking (1) and for Falling (2) Pawn-ancestry actors, else toward
 *   DesiredRotation.Pitch, by trunc(dt * 32768), and is clamped to +-RotationRate.Pitch (0x103ca031..0x103ca056).
 * Evidence: scripts/native-pawn-rotation-oracle.py (the unchanged body), validate-native-pawn-rotation.mjs. */
export function pawnRotationStep({ rotation, desiredRotation, rotationRate, physics, motionFlags }, dt, { playerPawn, pawn }) {
  const [pitch0, yaw0, roll0] = rotation;
  if (playerPawn) return { motionFlags, rotation: roll0 !== 0 ? [pitch0, yaw0, 0] : null };
  const flags = ((motionFlags & ~0x20) | 0x40) >>> 0;
  let yaw = yaw0, pitch = pitch0;
  const turn = { bFixedRotationDir: false, bRotateToDesired: true };   // the mode physicsRotation installed (0x40 set, 0x20 clear)
  if (desiredRotation[1] !== yaw0) yaw = fixedTurn(yaw0, desiredRotation[1], Math.trunc(rotationRate[1] * dt), turn);
  if (desiredRotation[0] !== pitch0) {
    const target = physics === 1 || (physics === 2 && pawn) ? 0 : desiredRotation[0];
    pitch = fixedTurn(pitch0, target, Math.trunc(dt * f(32768)), turn);
    const limit = rotationRate[0];
    if (pitch < 0x8000) { if (pitch > limit) pitch = limit; }
    else { const lo = 0x10000 - limit; if (pitch < lo) pitch = lo; }
  }
  return { motionFlags: flags, rotation: pitch !== pitch0 || yaw !== yaw0 || roll0 !== 0 ? [pitch, yaw, 0] : null };
}

function physicsRotation(pawn, dt, services, dispatch) {
  const step = pawnRotationStep({ rotation: pawn.rotation, desiredRotation: pawn.desiredRotation, rotationRate: pawn.rotationRate,
    physics: pawn.physics, motionFlags: pawn.motionFlags }, dt,
  { playerPawn: services.isA(pawn.self, 'engine.playerpawn'), pawn: services.isA(pawn.self, 'engine.pawn') });
  pawn.motionFlags = step.motionFlags;
  if (step.rotation) moveActor(pawn, [0, 0, 0], step.rotation, services, dispatch);
}

/** performPhysics's event dispatch: the view stands for its actor. */
export const pawnDispatch = (actor, pawn, services) => (target, event, args = []) =>
  services.dispatch(target === pawn ? actor : target, event, args.map(a => a === pawn ? actor : a));

/** APawn::performPhysics (0x103c9a70), dry standalone dispatch. Non-Pawn
 * actors keep their own recovered routes (decorations: runDecorationPhysics). */
export function runScriptPawnPhysics(actor, dt, services) {
  if (!services.isA(actor, 'engine.pawn')) unsupported('non-Pawn APawn::performPhysics');
  const pawn = pawnPhysicsView(actor, services);
  const delta = f(dt);
  const dispatch = pawnDispatch(actor, pawn, services);
  switch (pawn.physics) {
    case 1: pawn.walking(delta, 0); break;
    case 2: pawn.falling(delta, 0); break;
    case 3: pawn.swimming(delta, 0); break;
    case 4: pawn.flying(delta, 0); break;
    case 8: {
      // 0x103c9b20: OldLocation = Location, physPathing (0x103dd8a0) along
      // the InterpolationPoint path (pathing.mjs) through this pawn's own
      // MoveActor, then Velocity from the moved Location.
      pawn.oldLocation = [...pawn.position];
      physPathing(actor, delta, {
        read: services.read, write: services.write, isA: services.isA,
        defaultFovAngle: target => services.classDefault(target, 'FovAngle'),
        moveActor: (_actor, offset, rotation) => moveActor(pawn, offset, rotation, services, dispatch),
        interpolateEnd: (receiver, other) => services.dispatch(receiver, 'InterpolateEnd', [other]),
      });
      pawn.velocity = interpolationVelocity(pawn.position, pawn.oldLocation, delta);
      break;
    }
    default: unsupported(`APawn::performPhysics Physics=${pawn.physics}`);
  }
  pawnPhysicsTail(actor, pawn, delta, services, dispatch, 0);
}

/** performPhysics after the Physics dispatch, from `stage`: 0 the
 * physicsRotation gate, 1 MoveTimer and AvgPhysicsTime, 2 the PostTouch
 * tail. The Rust body (pawn_phys.rs) runs the rest here from the point
 * where the pawn's image changed hands, and the PostTouch tail. */
export function pawnPhysicsTail(actor, pawn, delta, services, dispatch, stage = 0) {
  if (stage <= 0 && pawn.physics !== 0xa && (services.isA(actor, 'engine.playerpawn') ||
      !sameRotation(pawn.rotation, pawn.desiredRotation) || pawn.rotationRate[2] > 0))
    physicsRotation(pawn, delta, services, dispatch);
  if (stage <= 1) pawnPhysicsTimers(pawn, delta);
  postTouchTail(actor, pawn, services, dispatch);
}

function pawnPhysicsTimers(pawn, delta) {
  pawn.moveTimer = f(pawn.moveTimer - delta);
  // 0x103c9c37..0x103c9c4e keeps both products and their sum in x87 extended
  // precision: old*double[0x10431418] + dt*double[0x1042b8e8], then FSTP m32.
  // x87double models those exact binary64 constants; the field and timestep
  // are float32 memory operands. Native 64-bit-significand rounding matters
  // for rare halfway cases, so avoid JS binary64 intermediates here.
  // The Rust x87 kernel computes the same (docs/rust-core.md R3-b).
  pawn.avgPhysicsTime = scriptVmKernel ? scriptVmKernel.avgPhysicsTime(pawn.avgPhysicsTime, delta) : x87store(x87add(
    x87mul(x87load(pawn.avgPhysicsTime), x87double(0.8)),
    x87mul(x87load(delta), x87double(0.2))));
}

function postTouchTail(actor, pawn, services, dispatch) {
  // APawn has the same deferred-touch tail ordering: call the current target's
  // PostTouch with this pawn, then re-read PendingTouch and unlink one link.
  // The callback can replace/clear PendingTouch, so unlink the post-callback
  // value exactly as the native reads at 0x103c9c78.
  const postTouchTarget = pawn.pendingTouch;
  if (postTouchTarget) {
    dispatch(postTouchTarget, 'PostTouch', [actor]);
    const unlink = pawn.pendingTouch;
    if (unlink) {
      const next = services.read ? services.read(unlink, 'PendingTouch') : services.field(unlink, 'PendingTouch').get();
      pawn.pendingTouch = next;
      if (services.write) services.write(unlink, 'PendingTouch', null);
      else services.field(unlink, 'PendingTouch').set(null);
    }
  }
}
