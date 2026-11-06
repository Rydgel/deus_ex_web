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
import {handleOf, identityOfHandle} from './script-object-handles.mjs';
import {isMapMoveHost} from './map-actor-native.mjs';
import {playerMove} from './player-move.mjs';
import {processDecorationHitWall} from './walking-callbacks.mjs';
import {spawnedFallingAdapter, runSpawnedActorFalling} from './script-actor-physics.mjs';
import {actorPhysicsTail, linkedActorPhysics} from './actor-physics.mjs';

const env = typeof process !== 'undefined' ? process.env ?? {} : {};
// Read when an interpreter attaches: the viewer sets the global from
// `?actorPhysics=` after this module loads.
const disabled = () => env.ACTOR_PHYSICS === 'js' || globalThis.DEUS_EX_ACTOR_PHYSICS === 'js';
// ACTOR_PROJECTILE=js (`?projectilePhysics=js`) keeps PHYS_Projectile calls in JavaScript and leaves the falling body in Rust.
const projectileOff = () => env.ACTOR_PROJECTILE === 'js' || globalThis.DEUS_EX_PROJECTILE_PHYSICS === 'js';
const STATS = env.ACTOR_PHYSICS_STATS === '1';
// fall.rs FALL_COUNTS, in order.
export const RUST_COUNTS = ['calls', 'substeps', 'water', 'bobbing', 'apex', 'blocked', 'bounces', 'landings', 'walls',
  'slides', 'twoWalls', 'terminal', 'deleted', 'tails', 'moveHandBacks', 'zoneFallbacks',
  'projectiles', 'projectileIterations', 'projectileHits', 'projectileFalls', 'projectileClamps', 'projectileBounces', 'projectileWater'];
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
  2: "Non-Pawn physFalling in Rust: the actor's image changed during a script event"};

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
];
const ACTOR_ROWS = 10, BOBBING = 15, REGION = 16, MAX_SPEED = 17, ZONE_NUMBER = 18;
// js_fall_begin's second argument: the actor's Physics.
const PHYS_FALLING = 2, PHYS_PROJECTILE = 6;

export class ActorPhysicsHost {
  constructor(vm) {
    this.vm = vm;
    this.runtime = vm.runtime;
    this.version = -1;
    this.cells = null;
    this.valid = false;
    // Per physics mode (falling, projectile): the rows differ (Decoration's bBobbing, Projectile's MaxSpeed).
    this.classes = [new Map(), new Map()];
    this.instances = [new WeakMap(), new WeakMap()];
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
    this.instances = [new WeakMap(), new WeakMap()];
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
    const mode = physics === PHYS_PROJECTILE ? 1 : 0, classes = this.classes[mode];
    let info = classes.get(cls);
    if (!info || info.names !== names.size) {
      let decoration = false, projectile = false;
      for (let c = cls; c; c = c.base) {
        if (c.record?.key === 'engine.decoration') decoration = true;
        else if (c.record?.key === 'engine.projectile') projectile = true;
      }
      const actorRows = [...Array(ACTOR_ROWS).keys()];
      const rows = mode === 1 ? (projectile ? [...actorRows, MAX_SPEED] : actorRows)
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
    const ops = runtime.spawnedMoveServices(actor, level);
    const depth = this.vm.movePawn.contexts.length;
    this.vm.movePawn.contexts.push({pawn: actor, actor, ops, hits: null, times: null});
    this.contexts[depth] = {actor, ops, world, services, adapter: null,
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
      js_fall_error(depth, code) { throw new Error(ERRORS[code] ?? `Non-Pawn physFalling error ${code}`); },
      js_fall_tail(depth, delta) {
        const c = context(depth);
        actorPhysicsTail(c.actor, delta, c.services);
      },
      js_fall_end(i) {
        const c = tick().contextAt(i);
        host.end(c);
        tick().refresh(c);
      },
    };
  }
}
