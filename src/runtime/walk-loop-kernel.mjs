/**
 * APawn::physWalking's dry path in Rust (native/script-vm/src/walk_loop.rs,
 * docs/rust-core.md step R3-b B5). The JavaScript body (walking.mjs
 * `walking`, reached from runScriptPawnPhysics through the pawn view's
 * `walking`) stays the reference: it runs whenever this host declines a call
 * or the kernel hands one back, which happens before any effect.
 *
 * A call runs in Rust only when the pawn's image holds every field the loop
 * reads or writes as the cell `readNamed` uses (the walk field table below,
 * plus the move field table for `move_pawn`), the pawn is admitted by the
 * pawn MoveActor host, and the level carries its zone model. The effects
 * stay the pawn view's own functions, called from the imports at the
 * reference's points: the surface prelude, the line checks, HitWall, the
 * Falling and MayFall events, SetSupportBase, setPhysics, FarMoveActor, and
 * the physFalling and startSwimming tail calls. The zone fields (gravity,
 * zone velocity, ground friction) are read from the zone actor's image, or
 * from the view's `zoneFields` service where that actor has no image.
 *
 * Switches (Node only): WALK_LOOP_KERNEL=js keeps every call in JavaScript;
 * WALK_LOOP_DIFFERENTIAL=1 counts calls by outcome and the branches they
 * took: each effect import, and the Rust-side counters (COUNTERS, from the
 * state block): `moves` are the MoveActor bodies the loop entered directly,
 * `handedBackMoves` those `move_pawn` handed back to the JavaScript body
 * from inside the loop. A zero count names a branch the run did not reach.
 */
import {fieldImageCell, fieldImageCellVersion, cellKind, sameCell, scalarCell} from './script-object-image.mjs';
import {handleOf} from './script-object-handles.mjs';
import {identityOfHandle} from './script-object-handles.mjs';

const env = typeof process !== 'undefined' ? process.env ?? {} : {};
const DISABLED = env.WALK_LOOP_KERNEL === 'js' || globalThis.DEUS_EX_WALK_LOOP_KERNEL === 'js';
const DIFFERENTIAL = env.WALK_LOOP_DIFFERENTIAL === '1';
// The Rust-side counters, in the state block's order from word 2 (walk_loop.rs WL_STATE).
export const COUNTERS = ['moves', 'slopeProbes', 'nudges', 'slides', 'retreats', 'stepUps'];
const counts = {calls: 0, handedBack: 0, declined: 0, declinedBy: {}, prelude: 0, lines: 0, handedBackMoves: 0, zoneFallbacks: 0,
  hitWalls: 0, fallingEvents: 0, mayFalls: 0, supportBases: 0, physicsSets: 0, farMoves: 0, fallings: 0, swims: 0,
  ...Object.fromEntries(COUNTERS.map(key => [key, 0]))};
if (DIFFERENTIAL) process.on('exit', () => process.stderr.write(`walk loop differential: ${JSON.stringify(counts)}\n`));
const declined = (why, name) => {
  counts.declined++;
  if (DIFFERENTIAL) { const key = `${why} ${name ?? '?'}`; counts.declinedBy[key] = (counts.declinedBy[key] ?? 0) + 1; }
};
const f = Math.fround;

// [spelling, key, kind]: the order is the ABI shared with walk_loop.rs
// (W_*). The last three are the zone actor's fields.
export const WALK_FIELDS = [
  ['GroundSpeed', 'engine.pawn.groundspeed', 'float'],
  ['AccelRate', 'engine.pawn.accelrate', 'float'],
  ['MaxStepHeight', 'engine.pawn.maxstepheight', 'float'],
  ['bCanJump', 'engine.pawn.bcanjump', 'bool'],
  ['bIsWalking', 'engine.pawn.biswalking', 'bool'],
  ['MoveTimer', 'engine.pawn.movetimer', 'float'],
  ['bHitSlopedWall', 'engine.pawn.bhitslopedwall', 'bool'],
  ['bIsPlayer', 'engine.pawn.bisplayer', 'bool'],
  ['Mass', 'engine.actor.mass', 'float'],
  ['Velocity', 'engine.actor.velocity', 'vector'],
  ['Acceleration', 'engine.actor.acceleration', 'vector'],
  ['OldLocation', 'engine.actor.oldlocation', 'vector'],
  ['Physics', 'engine.actor.physics', 'byte'],
  ['Base', 'engine.actor.base', 'pointer'],
  ['Region', 'engine.actor.region', 'struct'],
  ['Location', 'engine.actor.location', 'vector'],
  ['CollisionRadius', 'engine.actor.collisionradius', 'float'],
  ['CollisionHeight', 'engine.actor.collisionheight', 'float'],
  ['bJustTeleported', 'engine.actor.bjustteleported', 'bool'],
  ['ZoneGravity', 'engine.zoneinfo.zonegravity', 'vector'],
  ['ZoneVelocity', 'engine.zoneinfo.zonevelocity', 'vector'],
  ['ZoneGroundFriction', 'engine.zoneinfo.zonegroundfriction', 'float'],
];
const PAWN_FIELDS = 19;

export class WalkLoopHost {
  constructor(vm) {
    this.vm = vm;
    this.runtime = vm.runtime;
    this.version = -1;
    this.cells = null;
    this.classes = new Map();
    this.zoneClasses = new Map();
    this.instances = new WeakMap();
    this.contexts = [];
  }
  attach(x) {
    this.x = x;
    this.fieldsAt = x.walk_fields_ptr();
    this.ioAt = x.walk_loop_io_ptr();
    this.stateAt = x.walk_loop_state_ptr();
    this.enabled = !DISABLED;
  }
  /** The registry cells of WALK_FIELDS and their table rows: Region's Zone
   * member replaces the Region row. */
  table() {
    const version = fieldImageCellVersion();
    if (version === this.version) return;
    this.version = version;
    this.classes.clear();
    this.zoneClasses.clear();
    this.instances = new WeakMap();
    this.cells = WALK_FIELDS.map(([, key, kind]) => {
      const cell = fieldImageCell(key);
      return cellKind(cell) === kind ? cell : null;
    });
    const region = this.cells[14];
    const zoneMember = region?.members?.find(item => item.key === 'engine.actor.pointregion.zone');
    this.valid = !this.cells.includes(null) && zoneMember && cellKind(zoneMember) === 'pointer';
    if (!this.valid) return;
    const view = this.vm.arena.view;
    this.cells.forEach((cell, i) => {
      const scalar = scalarCell(cell);
      const offset = i === 14 ? region.offset + zoneMember.offset : cell.offset;
      view.setUint32(this.fieldsAt + i * 8, offset, true);
      view.setUint32(this.fieldsAt + i * 8 + 4, (scalar?.mask ?? 0) >>> 0, true);
    });
  }
  /** Whether every pawn spelling of `cls` resolves to the table's cell. */
  eligible(instance) {
    const {cls, cells, fieldTable: names} = instance;
    let info = this.classes.get(cls);
    if (!info || info.names !== names.size) {
      let ok = this.valid;
      for (let i = 0; ok && i < PAWN_FIELDS; i++) {
        const [name, key] = WALK_FIELDS[i];
        let field;
        try { field = this.runtime.lookupMember(cls, 'fields', name); } catch { ok = false; break; }
        const cached = names.get(name);
        const cell = cached === undefined ? cells.get(key) : cached?.field === field ? cached.cell : null;
        if (field?.key !== key || !sameCell(cell, this.cells[i])) ok = false;
      }
      this.classes.set(cls, info = {names: names.size, ok});
    }
    if (!info.ok) return false;
    let entry = this.instances.get(instance);
    if (!entry || entry.info !== info || entry.bindings !== instance.bindings.size) {
      const ok = WALK_FIELDS.slice(0, PAWN_FIELDS).every(([, key]) => !instance.bindings.has(key));
      this.instances.set(instance, entry = {info, bindings: instance.bindings.size, ok});
    }
    return entry.ok;
  }
  /** `walking(pawn, seconds, iterations)` in Rust: true when it ran there,
   * false when the JavaScript body must run. `ops` are the move services
   * script-pawn-physics.mjs builds for this pawn. */
  walk(pawn, seconds, iterations, ops) {
    if (DISABLED || !this.x || !this.vm.zone.enabled) return false;
    const actor = pawn.self, runtime = this.runtime;
    const instance = actor?.[runtime.instanceKey] ?? runtime.instances.get(actor);
    if (!instance?.cells || !instance.base || instance.arena !== this.vm.arena ||
      instance.poison?.size || instance.imageToken?.released || instance.nativeObject?.released) { declined('instance', actor?.name); return false; }
    if (typeof seconds !== 'number' || !Number.isInteger(iterations)) { declined('args', actor?.name); return false; }
    const mover = this.vm.moveActor, pawnMover = this.vm.movePawn;
    mover.table(); this.table();
    if (!mover.eligiblePawn(instance) || !this.eligible(instance)) { declined('fields', actor?.name); return false; }
    if (!pawn.pawn || pawn.movingBrush || pawn.model) { declined('kind', actor?.name); return false; }
    const level = ops.level;
    const model = this.vm.zone.model(level);
    const view = this.vm.arena.view;
    view.setUint32(this.stateAt, model, true);
    view.setUint32(this.stateAt + 4, ops.worldActor ? handleOf(ops.worldActor) : 0, true);
    // The depth is the pawn MoveActor host's: `move_pawn` runs on its
    // context at this depth, and this host's context sits at the same
    // index (a nested walk inside a move's callback gets a deeper one).
    const depth = pawnMover.contexts.length;
    const context = {pawn, actor, ops};
    pawnMover.contexts.push({pawn, actor, ops: ops.move, hits: null, times: null});
    this.contexts[depth] = context;
    const x = this.x, stack = x.__stack_pointer.value;
    const before = DIFFERENTIAL ? COUNTERS.map((_, i) => view.getUint32(this.stateAt + 8 + i * 4, true)) : null;
    let code;
    try {
      code = x.walk_loop(depth, instance.base, f(seconds), iterations);
    } catch (error) {
      x.__stack_pointer.value = stack;
      throw error;
    } finally {
      this.contexts[depth] = undefined;
      pawnMover.contexts.pop();
      if (DIFFERENTIAL) {
        // Counted also for a call an import ended by throwing (the
        // reference's error at the same point). The arena's view is
        // re-derived when the memory grew during the call.
        const after = this.vm.arena.view;
        COUNTERS.forEach((key, i) => { counts[key] += (after.getUint32(this.stateAt + 8 + i * 4, true) - before[i]) >>> 0; });
      }
    }
    if (code === 0) { counts.handedBack++; return false; }
    counts.calls++;
    return true;
  }
  imports() {
    const host = this;
    const context = depth => {
      const c = host.contexts[depth];
      if (!c) throw new Error(`Walk loop context ${depth} is not active`);
      return c;
    };
    const io = () => new Float64Array(host.vm.arena.memory.buffer, host.ioAt, 8);
    const answer = hit => {
      const v = io();
      v[0] = hit.time; v[1] = hit.normal[0]; v[2] = hit.normal[1]; v[3] = hit.normal[2];
      v[4] = hit.actor ? handleOf(hit.actor) : 0;
    };
    const ERRORS = {1: 'Walking requires timestep in (0,0.4]', 2: 'Walking entered unsupported non-dry physics',
      3: 'Original stepUp recursion budget exceeded', 4: 'Ground velocity requires an original actor timestep in (0, 0.4]'};
    return {
      js_walk_prelude(depth, dt, iterations) {
        counts.prelude++;
        return context(depth).pawn.walkingPrelude(dt, iterations) ? 1 : 0;
      },
      js_walk_line(depth, sx, sy, sz, ex, ey, ez, rx, ry, rz, flags) {
        counts.lines++;
        answer(context(depth).pawn.lineCheck([sx, sy, sz], [ex, ey, ez], [rx, ry, rz], flags, 0));
      },
      js_walk_move(depth, dx, dy, dz) {
        counts.handedBackMoves++;
        answer(context(depth).pawn.move([dx, dy, dz]));
      },
      js_walk_hit_wall(depth, time, nx, ny, nz, actor) {
        counts.hitWalls++;
        context(depth).pawn.hitWall({time, normal: [nx, ny, nz], actor: actor ? identityOfHandle(actor) : null});
      },
      js_walk_pushable(depth, actor) { return identityOfHandle(actor)?.pushableDecoration ? 1 : 0; },
      js_walk_actor_mass(depth, actor) { return identityOfHandle(actor).mass; },
      js_walk_falling_event(depth) { counts.fallingEvents++; context(depth).pawn.fallingEvent(); },
      js_walk_may_fall(depth) { counts.mayFalls++; context(depth).pawn.mayFall(); },
      js_walk_set_support_base(depth, actor) { counts.supportBases++; context(depth).pawn.setSupportBase(actor ? identityOfHandle(actor) : null); },
      js_walk_set_physics(depth, next) { counts.physicsSets++; context(depth).pawn.setPhysics(next); },
      js_walk_far_move(depth, x, y, z) { counts.farMoves++; context(depth).pawn.farMove([x, y, z], 0, 0); },
      js_walk_falling(depth, remaining, iterations) { counts.fallings++; context(depth).pawn.falling(remaining, iterations); },
      js_walk_swim(depth, step, remaining, iterations) {
        counts.swims++;
        const pawn = context(depth).pawn;
        if (typeof pawn.startSwimming !== 'function') throw Error('physWalking entered PHYS_Swimming without the startSwimming service (0x103cb44e)');
        pawn.startSwimming(pawn.velocity.map(f), step, remaining, iterations);
      },
      js_walk_zone_vec(depth, which) {
        counts.zoneFallbacks++;
        const pawn = context(depth).pawn, v = io();
        const value = which === 19 ? pawn.gravity : pawn.zoneVelocity;
        v[0] = value[0]; v[1] = value[1]; v[2] = value[2];
      },
      js_walk_zone_float(depth) {
        counts.zoneFallbacks++;
        return context(depth).pawn.friction;
      },
      js_walk_error(depth, code) { throw new Error(ERRORS[code] ?? `Walk loop error ${code}`); },
    };
  }
}
