/**
 * AActor::performPhysics for a falling non-Pawn actor in Rust
 * (native/script-vm/src/fall.rs, docs/rust-core.md step R3-b B6c). The
 * JavaScript body (actor-physics.mjs `performActorPhysics` with
 * script-actor-physics.mjs `runSpawnedActorFalling` over falling.mjs
 * `falling`, reached from the actor tick's physics callback through
 * ScriptRuntime.processActorPhysics and the Play host's
 * `runtime.actorPhysics`) stays the reference: when this host declines, the
 * tick takes the callback as before, with nothing done yet.
 *
 * The tick's Rust body (tick.rs) asks `js_fall_begin` for a non-Pawn whose
 * Physics is PHYS_Falling. The host admits it when:
 * - the physics callback would reach the linked services unchanged (the
 *   runtime's own processActorPhysics, the `runtime.actorPhysics` the Play
 *   host linked, no ACTOR_TICK_DIFFERENTIAL log);
 * - the actor is a serialized map move host or a spawned collision view,
 *   the move sources `runSpawnedActorFalling` admits (mapMoveLevel runs
 *   here, as there), on a level with its collision hash;
 * - every MOVE_FIELDS spelling (the rider table, move-actor-kernel.mjs)
 *   and every FALL_FIELDS actor spelling (with Decoration's bBobbing for a
 *   Decoration) is the image cell `readNamed` uses, unbound.
 * It then pushes a move context at the pawn MoveActor host's next depth
 * (`move_source` runs its imports there) and returns that depth. The
 * imports run the reference's own functions at its points: playerMove where
 * the Rust MoveActor hands back, processDecorationHitWall, the bBounce
 * HitWall event, the host's processLanded, the zone reads for a zone without
 * an image, and the performPhysics tail (`actorPhysicsTail`).
 *
 * ACTOR_PHYSICS=js (`?actorPhysics=js`) keeps every call in JavaScript, ACTOR_PROJECTILE=js (`?projectilePhysics=js`) the
 * PHYS_Projectile calls (the Rust body is fall.rs `perform_projectile`; the host admits them as it does a falling actor, with
 * Projectile.MaxSpeed's row for an engine.projectile);
 * ACTOR_PHYSICS_STATS=1 prints the counts at exit.
 */
import {fieldImageCell, fieldImageCellVersion, cellKind, sameCell, scalarCell} from './script-object-image.mjs';
import {switchReader} from './switch-reader.mjs';
import {o3Wants} from './o3-record.mjs';
import {rolling} from './rolling.mjs';
import {handleOf, identityOfHandle} from './script-object-handles.mjs';
import {isMapMoveHost} from './map-actor-native.mjs';
import {playerMove} from './player-move.mjs';
import {processDecorationHitWall, setSupportBase} from './walking-callbacks.mjs';
import {setActorPhysics, findActorBase} from './script-actor-collision.mjs';
import {spawnedFallingAdapter, runSpawnedActorFalling} from './script-actor-physics.mjs';
import {actorPhysicsTail, linkedActorPhysics} from './actor-physics.mjs';

const env = typeof process !== 'undefined' ? process.env ?? {} : {};
// Read when an interpreter attaches: the viewer sets the global from
// `?actorPhysics=` after this module loads.
const disabled = () => env.ACTOR_PHYSICS === 'js' || globalThis.DEUS_EX_ACTOR_PHYSICS === 'js';
// ACTOR_PROJECTILE=js (`?projectilePhysics=js`) keeps PHYS_Projectile calls in JavaScript and leaves the falling body in Rust.
const projectileOff = () => env.ACTOR_PROJECTILE === 'js' || globalThis.DEUS_EX_PROJECTILE_PHYSICS === 'js';
/** 'rust' (default), 'js' or 'verify': ROLLING_PHYSICS / DEUS_EX_ROLLING_PHYSICS / `?rollingPhysics=`. PHYS_Rolling of a non-Pawn actor (a
 * TrashPaper on a street: physRolling, rolling.mjs) in Rust (fall.rs `perform_rolling`); `js` keeps the callback's JavaScript body. `verify` runs
 * the Rust body for real with the host recording every service call and the actor's fields around it, then runs rolling.mjs on a mock host
 * made of the recorded start, answering each service from the record, and compares the calls (their arguments bit for bit), the fields at
 * each call and at the end. */
export const rollingMode = switchReader('ROLLING_PHYSICS', 'DEUS_EX_ROLLING_PHYSICS', 'rust');
const STATS = env.ACTOR_PHYSICS_STATS === '1';
// fall.rs FALL_COUNTS, in order.
export const RUST_COUNTS = ['calls', 'substeps', 'water', 'bobbing', 'apex', 'blocked', 'bounces', 'landings', 'walls',
  'slides', 'twoWalls', 'terminal', 'deleted', 'tails', 'moveHandBacks', 'zoneFallbacks',
  'projectiles', 'projectileIterations', 'projectileHits', 'projectileFalls', 'projectileClamps', 'projectileBounces', 'projectileWater',
  'rolls', 'rollSubsteps', 'rollWalls', 'rollBounces', 'rollSlides', 'rollFalls', 'rollBases', 'rollMoves'];
const stats = {declined: new Map(), rust: null};
let statsHost = null;
if (STATS) process.on('exit', () => {
  if (statsHost) {
    const counts = new Uint32Array(statsHost.vm.arena.memory.buffer, statsHost.x.fall_counts_ptr(), RUST_COUNTS.length);
    stats.rust = Object.fromEntries(RUST_COUNTS.map((key, i) => [key, counts[i]]));
  }
  process.stderr.write(`actor physics kernel: ${JSON.stringify({...stats, declined: Object.fromEntries(stats.declined)})}\n`);
});
const decline = why => {
  if (STATS) stats.declined.set(why, (stats.declined.get(why) ?? 0) + 1);
  return -1;
};
// fall.rs's js_fall_error codes.
const ERRORS = {1: 'physFalling requires the actor Region.Zone (actor+0xc8)',
  2: "Non-Pawn physFalling/physRolling in Rust: the actor's image changed during a script event"};

// [spelling, key, kind]: the ABI with fall.rs (FF_*). Rows 10..14 are the
// zone actor's fields, 15 Decoration's bBobbing, 16 Region (its Zone and
// ZoneNumber members become rows 16 and 17).
export const FALL_FIELDS = [
  ['Velocity', 'engine.actor.velocity', 'vector'],
  ['Acceleration', 'engine.actor.acceleration', 'vector'],
  ['OldLocation', 'engine.actor.oldlocation', 'vector'],
  ['Physics', 'engine.actor.physics', 'byte'],
  ['bJustTeleported', 'engine.actor.bjustteleported', 'bool'],
  ['bBounce', 'engine.actor.bbounce', 'bool'],
  ['Mass', 'engine.actor.mass', 'float'],
  ['Buoyancy', 'engine.actor.buoyancy', 'float'],
  ['RotationRate', 'engine.actor.rotationrate', 'rotator'],
  ['PendingTouch', 'engine.actor.pendingtouch', 'pointer'],
  ['ZoneGravity', 'engine.zoneinfo.zonegravity', 'vector'],
  ['ZoneVelocity', 'engine.zoneinfo.zonevelocity', 'vector'],
  ['ZoneTerminalVelocity', 'engine.zoneinfo.zoneterminalvelocity', 'float'],
  ['ZoneFluidFriction', 'engine.zoneinfo.zonefluidfriction', 'float'],
  ['bWaterZone', 'engine.zoneinfo.bwaterzone', 'bool'],
  ['bBobbing', 'engine.decoration.bbobbing', 'bool'],
  ['Region', 'engine.actor.region', 'struct'],
  // physProjectile's clamp, for an engine.projectile only.
  ['MaxSpeed', 'engine.projectile.maxspeed', 'float'],
  // physRolling's support test.
  ['Base', 'engine.actor.base', 'pointer'],
];
const ACTOR_ROWS = 10, BOBBING = 15, REGION = 16, MAX_SPEED = 17, BASE = 18, ZONE_NUMBER = 19;
// js_fall_begin's second argument: the actor's Physics.
const PHYS_FALLING = 2, PHYS_PROJECTILE = 6, PHYS_ROLLING = 7;
/** The mode of a Physics value: the tables per falling (0), projectile (1) and rolling (2) call. */
const modeOf = physics => physics === PHYS_PROJECTILE ? 1 : physics === PHYS_ROLLING ? 2 : 0;

export class ActorPhysicsHost {
  constructor(vm) {
    this.vm = vm;
    this.runtime = vm.runtime;
    this.version = -1;
    this.cells = null;
    this.valid = false;
    // Per physics mode (falling, projectile): the rows differ (Decoration's bBobbing, Projectile's MaxSpeed).
    this.classes = [new Map(), new Map(), new Map()];
    this.instances = [new WeakMap(), new WeakMap(), new WeakMap()];
    // One context per move depth (the pawn MoveActor host's index).
    this.contexts = [];
  }
  attach(x) {
    this.x = x;
    this.fieldsAt = x.fall_fields_ptr();
    this.ioAt = x.fall_io_ptr();
    this.stateAt = x.fall_state_ptr();
    this.enabled = !disabled();
    if (STATS) statsHost = this;
  }
  table() {
    const version = fieldImageCellVersion();
    if (version === this.version) return;
    this.version = version;
    this.classes.forEach(map => map.clear());
    this.instances = [new WeakMap(), new WeakMap(), new WeakMap()];
    this.cells = FALL_FIELDS.map(([, key, kind]) => {
      const cell = fieldImageCell(key);
      return cellKind(cell) === kind ? cell : null;
    });
    this.vm.zone.table();
    const members = this.vm.zone.members;
    // MaxSpeed's cell exists once a Projectile class is linked; the other rows are needed by every class.
    this.valid = !this.cells.some((cell, i) => cell === null && i !== MAX_SPEED) && members !== null;
    if (!this.valid) return;
    const view = this.vm.arena.view, region = this.cells[REGION];
    this.cells.forEach((cell, i) => {
      if (i === REGION || cell === null) return;
      view.setUint32(this.fieldsAt + i * 8, cell.offset, true);
      view.setUint32(this.fieldsAt + i * 8 + 4, (scalarCell(cell)?.mask ?? 0) >>> 0, true);
    });
    // move_actor.rs's region rows: members[0] Zone, members[2] ZoneNumber.
    view.setUint32(this.fieldsAt + REGION * 8, region.offset + members[0].offset, true);
    view.setUint32(this.fieldsAt + REGION * 8 + 4, 0, true);
    view.setUint32(this.fieldsAt + ZONE_NUMBER * 8, region.offset + members[2].offset, true);
    view.setUint32(this.fieldsAt + ZONE_NUMBER * 8 + 4, 0, true);
  }
  /** Whether `cls` and the instance read every actor row (and bBobbing
   * for a Decoration falling, MaxSpeed for a Projectile in PHYS_Projectile)
   * from the table's cell. */
  eligible(instance, physics = PHYS_FALLING) {
    const {cls, cells, fieldTable: names} = instance;
    const mode = modeOf(physics), classes = this.classes[mode];
    let info = classes.get(cls);
    if (!info || info.names !== names.size) {
      let decoration = false, projectile = false;
      for (let c = cls; c; c = c.base) {
        if (c.record?.key === 'engine.decoration') decoration = true;
        else if (c.record?.key === 'engine.projectile') projectile = true;
      }
      const actorRows = [...Array(ACTOR_ROWS).keys()];
      const rows = mode === 1 ? (projectile ? [...actorRows, MAX_SPEED] : actorRows)
        : mode === 2 ? [...actorRows, BASE]
        : decoration ? [...actorRows, BOBBING] : actorRows;
      let ok = this.valid && (!rows.includes(MAX_SPEED) || this.cells[MAX_SPEED] !== null);
      for (const i of rows) {
        if (!ok) break;
        const [name, key] = FALL_FIELDS[i];
        let field;
        try { field = this.runtime.lookupMember(cls, 'fields', name); } catch { ok = false; break; }
        const cached = names.get(name);
        const cell = cached === undefined ? cells.get(key) : cached?.field === field ? cached.cell : null;
        if (field?.key !== key || !sameCell(cell, this.cells[i])) ok = false;
      }
      classes.set(cls, info = {names: names.size, ok, decoration: decoration && mode === 0, projectile: projectile && mode === 1,
        keys: rows.map(i => FALL_FIELDS[i][1])});
    }
    if (!info.ok) return null;
    const instances = this.instances[mode];
    let entry = instances.get(instance);
    if (!entry || entry.info !== info || entry.bindings !== instance.bindings.size) {
      const ok = info.keys.every(key => !instance.bindings.has(key));
      instances.set(instance, entry = {info, bindings: instance.bindings.size, ok});
    }
    return entry.ok ? info : null;
  }
  /** js_fall_begin for the tick context `c` and the actor's Physics: the move depth, or -1. */
  begin(c, physics) {
    if (!this.enabled) return decline('disabled');
    if (physics === PHYS_PROJECTILE && projectileOff()) return decline('projectile off');
    if (physics === PHYS_ROLLING && rollingMode() === 'js') return decline('rolling off');
    if (c.log) return decline('tick differential');
    const runtime = this.runtime, actor = c.receiver, mover = this.vm.moveActor;
    if (Object.hasOwn(runtime, 'processActorPhysics')) return decline('replaced');
    const services = linkedActorPhysics.get(runtime.actorPhysics);
    if (!services) return decline('replaced');
    const instance = c.instance;
    if (!instance?.cells || !instance.base || instance.arena !== this.vm.arena ||
      instance.poison?.size || instance.imageToken?.released || instance.nativeObject?.released) return decline('instance');
    if (!this.vm.movePawn.x || !this.vm.zone.enabled) return decline('move host');
    // runSpawnedActorFalling's level and source admission.
    let level;
    if (runtime.collisionViewActors.has(actor)) {
      if (actor.pawn || actor.movingBrush || actor.model) return decline('kind');
      level = runtime.levelFor(actor);
    } else if (isMapMoveHost(actor)) level = runtime.mapMoveLevel(actor, 'physFalling');
    else return decline('kind');
    if (!level?.hash) return decline('level');
    // (runActorRolling records an O3 replay of its body through o3Body)
    if (physics === PHYS_ROLLING && (o3Wants(actor) || typeof services.rollingZone !== 'function')) return decline('rolling services');
    mover.table(); this.table();
    const info = mover.eligible(instance) ? this.eligible(instance, physics) : null;
    if (!info) return decline('fields');
    const view = this.vm.arena.view, base = instance.base;
    // FellOutOfWorld (Region.ZoneNumber 0) and the static or immovable
    // source stay the reference's.
    if (view.getUint8(base + view.getUint32(this.fieldsAt + ZONE_NUMBER * 8, true)) === 0) return decline('zone 0');
    const bit = cell => (view.getUint32(base + cell.offset, true) & scalarCell(cell).mask) !== 0;
    if (bit(mover.cells[0]) || !bit(mover.cells[1])) return decline('static');
    view.setUint32(this.stateAt, info.decoration ? 1 : 0, true);
    view.setUint32(this.stateAt + 4, info.projectile ? 1 : 0, true);
    const world = target => target === level.hash.levelInfo ? level.actors[0] : target;
    const rolls = physics === PHYS_ROLLING, verify = rolls && rollingMode() === 'verify';
    if (rolls) {
      // fall.rs rolling: whether the call is traced, and the handles `world()` maps between (a world hit's actor)
      view.setUint32(this.stateAt + 8, verify ? 1 : 0, true);
      view.setUint32(this.stateAt + 12, level.hash.levelInfo ? handleOf(level.hash.levelInfo) : 0, true);
      view.setUint32(this.stateAt + 16, level.actors[0] ? handleOf(level.actors[0]) : 0, true);
    }
    const ops = runtime.spawnedMoveServices(actor, level);
    const depth = this.vm.movePawn.contexts.length;
    this.vm.movePawn.contexts.push({pawn: actor, actor, ops, hits: null, times: null});
    this.contexts[depth] = {actor, ops, world, services, adapter: null, level, rolls, trace: verify ? new RollTrace(this, actor, level, world) : null,
      dispatch: (target, event, args) => runtime.dispatchSpawnedEvent(world(target), event, args)};
    c.fallDepth = depth;
    return depth;
  }
  /** The contexts popped (also after an import threw). */
  end(c) {
    const depth = c.fallDepth;
    if (depth === undefined) return;
    c.fallDepth = undefined;
    this.vm.movePawn.contexts.length = depth;
    this.contexts.length = depth;
  }
  imports() {
    const host = this, runtime = this.runtime, tick = () => host.vm.actorTick;
    const context = depth => {
      const c = host.contexts[depth];
      if (!c) throw new Error(`Actor physics context ${depth} is not active`);
      return c;
    };
    const io = () => new Float64Array(host.vm.arena.memory.buffer, host.ioAt, 9);
    const actorOf = handle => handle ? identityOfHandle(handle) : null;
    // The reference's host, built where an import needs its own body.
    const adapter = c => c.adapter ??= spawnedFallingAdapter(runtime, c.actor);
    return {
      js_fall_begin: (i, physics) => host.begin(tick().contextAt(i), physics),
      js_fall_move(depth, dx, dy, dz) {
        const c = context(depth), result = playerMove(c.actor, [dx, dy, dz], c.ops), v = io();
        const normal = result.hit?.normal ?? [0, 0, 0];
        v[0] = result.time; v[1] = normal[0]; v[2] = normal[1]; v[3] = normal[2];
        v[4] = result.hit?.actor ? handleOf(result.hit.actor) : 0;
      },
      js_fall_hit_wall(depth, nx, ny, nz, actor) {
        const c = context(depth);
        processDecorationHitWall(c.actor, [nx, ny, nz], c.world(actorOf(actor)),
          {isProbing: (source, name) => runtime.isProbing(source, name), dispatch: c.dispatch});
      },
      js_fall_bounce(depth, nx, ny, nz, actor) {
        const c = context(depth);
        c.dispatch(c.actor, 'HitWall', [[nx, ny, nz], c.world(actorOf(actor))]);
      },
      // A decoration's blocked move (fall.rs, falling.mjs `blockedBy`).
      js_fall_blocked(depth, actor) {
        const c = context(depth);
        adapter(c).host.blockedBy(c.world(actorOf(actor)));
      },
      js_fall_landed(depth, time, nx, ny, nz, actor) {
        const c = context(depth);
        adapter(c).host.landed({time, normal: [nx, ny, nz], actor: c.world(actorOf(actor))});
      },
      js_fall_zone(depth) {
        const zone = runtime.regionValue(context(depth).actor).zone;
        if (!zone) throw new Error(ERRORS[1]);
        const read = name => runtime.readNamed(zone, name), v = io();
        const gravity = read('ZoneGravity'), velocity = read('ZoneVelocity');
        v.set([...gravity, ...velocity, read('ZoneTerminalVelocity'), read('ZoneFluidFriction'), read('bWaterZone') ? 1 : 0]);
      },
      // A bounce that left a projectile falling (projectile.mjs `physFalling`, runActorProjectile's service).
      js_fall_falling(depth, remaining, iterations) {
        runSpawnedActorFalling(runtime, context(depth).actor, remaining, iterations);
      },
      // physRolling's zone: the reference's `zoneAt(actor.position) ?? {}` (script-doors.mjs `rollingZone`) with rolling.mjs's defaults.
      js_roll_zone(depth, seconds) {
        const c = context(depth), zone = c.services.rollingZone(c.actor), v = io();
        const gravity = zone.ZoneGravity ?? [0, 0, -950], velocity = zone.ZoneVelocity ?? [0, 0, 0];
        v[0] = gravity[0]; v[1] = gravity[1]; v[2] = gravity[2]; v[3] = velocity[0]; v[4] = velocity[1]; v[5] = velocity[2];
        v[6] = zone.ZoneGroundFriction ?? 8; v[7] = zone.ZoneFluidFriction ?? .02;
        if (c.trace) { c.trace.zone = zone; c.trace.seconds = seconds; }
      },
      // physRolling's services (runActorRolling): the Falling event, SetPhysics(next) and SetBase(target).
      js_roll_service(depth, op, arg) {
        const c = context(depth);
        if (op === 0) c.dispatch(c.actor, 'Falling', []);
        else if (op === 1) setActorPhysics(c.actor, arg, undefined, {dispatch: c.dispatch,
          findBase: target => findActorBase(target, {lineCheck: (...args) => c.level.hash.lineCheck(...args), dispatch: c.dispatch})});
        else setSupportBase(c.actor, c.world(actorOf(arg)), c.dispatch);
      },
      js_roll_trace(depth, kind, a, b, c, d, e) { context(depth).trace.record(kind, [a, b, c, d, e]); },
      js_fall_error(depth, code) { throw new Error(ERRORS[code] ?? `Non-Pawn physFalling error ${code}`); },
      js_fall_tail(depth, delta) {
        const c = context(depth);
        actorPhysicsTail(c.actor, delta, c.services);
      },
      js_fall_end(i) {
        const c = tick().contextAt(i);
        // ROLLING_PHYSICS=verify: the recorded call against rolling.mjs (not after an import threw: `end` alone runs then)
        const trace = c.fallDepth === undefined ? null : host.contexts[c.fallDepth]?.trace;
        if (trace) trace.verify();
        host.end(c);
        tick().refresh(c);
      },
    };
  }
}

// ---------------------------------------------------------------------------
// ROLLING_PHYSICS=verify.

// fall.rs T_*: js_roll_trace's services (`kind | phase << 8`, phase 0 before the service and 1 after it; T_END 7 once the body is done).
const T_MOVE = 1, T_WALL = 2, T_FALLING_EVENT = 3, T_SET_PHYSICS = 4, T_SET_BASE = 5, T_PHYS_FALLING = 6, T_END = 7;
const TRACED = ['Velocity', 'Acceleration', 'OldLocation', 'Location', 'Physics', 'bJustTeleported', 'bBounce', 'Base'];
const sameValue = (a, b) => Array.isArray(a) ? Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i])) : Object.is(a, b);
const verifyCounts = {calls: 0, services: 0, states: 0};
// (a page's session reads the counts as `deusExVerifyCounts.rolling`)
(globalThis.deusExVerifyCounts ??= {}).rolling = verifyCounts;
if (rollingMode() === 'verify' && typeof process !== 'undefined')
  process.on('exit', () => process.stderr.write(`rolling verify: ${JSON.stringify(verifyCounts)}\n`));

/** One verified call of fall.rs `perform_rolling`: the Rust body ran on the actor's image, and every service it used was recorded with the
 * fields the reference's host exposes (TRACED) before and after it. `verify` runs rolling.mjs `rolling` on a mock host that starts where the
 * call started and takes each service's answer and effect from the record, and compares: the services in the same order with the same
 * arguments (bit for bit), the mock's fields at each service (before it) with the image's, and the final fields. */
class RollTrace {
  constructor(host, actor, level, world) {
    this.runtime = host.runtime; this.actor = actor; this.level = level; this.world = world;
    this.zone = null; this.seconds = NaN;
    this.start = this.snapshot();
    this.events = [];
  }
  snapshot() {
    const state = {};
    for (const name of TRACED) {
      const value = this.runtime.readNamed(this.actor, name);
      state[name] = Array.isArray(value) ? value.slice() : value;
    }
    return state;
  }
  record(kind, args) { this.events.push({kind, args, state: this.snapshot()}); }
  verify() {
    verifyCounts.calls++;
    const where = this.actor.name ?? '?', events = this.events;
    const fail = message => { throw new Error(`ROLLING_PHYSICS=verify ${where}: ${message}`); };
    const clone = state => Object.fromEntries(Object.entries(state).map(([key, value]) => [key, Array.isArray(value) ? value.slice() : value]));
    let state = clone(this.start), at = 0;
    const compare = (label, expected) => {
      verifyCounts.states++;
      for (const name of TRACED) if (!sameValue(state[name], expected[name]))
        fail(`${label}: ${name} is ${JSON.stringify(state[name])} in the reference and ${JSON.stringify(expected[name])} in Rust`);
    };
    const take = (service, phase) => {
      const event = events[at++];
      if (!event || event.kind !== (service | phase << 8)) fail(`call ${at}: the reference makes service ${service}/${phase}, Rust recorded ${event?.kind}`);
      return event;
    };
    const identity = handle => handle ? identityOfHandle(handle) : null;
    const around = (service, check) => {
      const before = take(service, 0);
      if (check) check(before.args);
      compare(`before service ${service} (call ${at})`, before.state);
      const after = take(service, 1);
      state = clone(after.state);
      verifyCounts.services++;
      return after;
    };
    const vector = (label, got, args) => {
      for (let i = 0; i < 3; i++) if (!Object.is(got[i], args[i])) fail(`${label}[${i}] is ${got[i]} in the reference and ${args[i]} in Rust`);
    };
    const host = {};
    const property = (key, name, read = value => value, write = value => value) =>
      Object.defineProperty(host, key, {get: () => read(state[name]), set: value => { state[name] = write(value); }, enumerable: true});
    const vec = value => Array.isArray(value) ? value.slice() : value;
    const f32 = value => value.map(Math.fround);
    property('position', 'Location', vec, f32); property('velocity', 'Velocity', vec, f32); property('acceleration', 'Acceleration', vec, f32);
    property('oldLocation', 'OldLocation', vec, f32); property('physics', 'Physics', v => v, v => v);
    property('justTeleported', 'bJustTeleported', v => v, Boolean); property('bBounce', 'bBounce', v => v, Boolean);
    property('base', 'Base', v => v, v => v);
    const services = {
      zone: this.zone,
      move: delta => {
        const after = around(T_MOVE, args => vector('move delta', delta, args));
        const [time, nx, ny, nz, handle] = after.args;
        return {time, normal: [nx, ny, nz], actor: this.world(identity(handle))};
      },
      eventHitWall: (normal, wall) => {
        around(T_WALL, args => {
          vector('HitWall normal', normal, args);
          if (wall !== this.world(identity(args[3]))) fail('HitWall actor differs');
        });
      },
      eventFalling: () => { around(T_FALLING_EVENT); },
      setPhysics: next => { around(T_SET_PHYSICS, args => { if (args[0] !== next) fail(`SetPhysics(${next}) is SetPhysics(${args[0]}) in Rust`); }); },
      physFalling: (remaining, iterations) => {
        around(T_PHYS_FALLING, args => {
          if (!Object.is(args[0], remaining) || args[1] !== iterations) fail(`physFalling(${remaining}, ${iterations}) is (${args[0]}, ${args[1]}) in Rust`);
        });
      },
      setBase: target => { around(T_SET_BASE, args => { if (target !== this.world(identity(args[0]))) fail('SetBase target differs'); }); },
    };
    rolling(host, this.seconds, services);
    const end = events[at++];
    if (!end || end.kind !== T_END || at !== events.length) fail(`the reference ends after ${at - 1} services, Rust recorded ${events.length - 1}`);
    compare('at the end', end.state);
  }
}
