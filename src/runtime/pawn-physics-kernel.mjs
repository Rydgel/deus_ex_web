/**
 * APawn::performPhysics for a walking or flying pawn in Rust
 * (native/script-vm/src/pawn_phys.rs and fly.rs, docs/rust-core.md steps
 * R3-b B6a and B6b). The JavaScript body
 * (script-pawn-physics.mjs `runScriptPawnPhysics`, reached from the actor
 * tick's physics callback through ScriptRuntime.processActorPhysics) stays
 * the reference: when this host declines, the tick takes the callback as
 * before, with nothing done yet.
 *
 * The tick's Rust body (tick.rs) asks `js_pawn_begin` for a non-player
 * Pawn whose Physics is PHYS_Walking or PHYS_Flying. The host admits it
 * when:
 * - the physics callback would reach runScriptPawnPhysics unchanged (the
 *   runtime's own processActorPhysics, no ACTOR_TICK_DIFFERENTIAL log);
 * - the walk loop host would run `walking` in Rust (walk-loop-kernel.mjs:
 *   the image, the walk and move field tables, the zone model, a pawn that
 *   is not a brush);
 * - DesiredRotation, RotationRate, AvgPhysicsTime, PendingTouch, the
 *   motion word's bFixedRotationDir and bRotateToDesired, AirSpeed and
 *   DesiredSpeed (PHYS_FIELDS) are the image cells `readNamed` uses, unbound
 *   on the instance, the two bools bits 0x20 and 0x40 of one word, and the
 *   actor's `motionFlags` is that image word (actor-flag-words.mjs); the
 *   table's last row is Region.ZoneNumber (the Region cell checked by the
 *   walk and move hosts, ZoneHost's member offset).
 * It then pushes the walk's contexts (the pawn view and its walk services,
 * as WalkLoopHost.walk does) and returns their depth. The imports run the
 * reference's own functions where Rust hands a step back: the `walking`
 * body, physFlying where it raises a boundary, the rotation's MoveActor,
 * and the body's rest from a stage (`pawnPhysicsTail`).
 *
 * PAWN_PHYSICS=js (`?pawnPhysics=js`) keeps every call in JavaScript.
 */
import {fieldImageCell, fieldImageCellVersion, cellKind, sameCell, scalarCell} from './script-object-image.mjs';
import {handleOf} from './script-object-handles.mjs';
import {flagWordsOf} from './actor-flag-words.mjs';
import {pawnPhysicsView, pawnPhysicsTail, pawnDispatch} from './script-pawn-physics.mjs';
import {walking} from './walking.mjs';
import {physFlying} from './flying.mjs';
import {directWalkBegin, directWalkEnd} from './walk-loop-kernel.mjs';

const env = typeof process !== 'undefined' ? process.env ?? {} : {};
// Read when an interpreter attaches: the viewer sets the global from
// `?pawnPhysics=` after this module loads.
const disabled = () => env.PAWN_PHYSICS === 'js' || globalThis.DEUS_EX_PAWN_PHYSICS === 'js';
const STATS = env.PAWN_PHYSICS_STATS === '1';
// `rust`: pawn_phys.rs's counts (PP_COUNTS: physicsRotation entered, its
// MoveActor completed in Rust, PostTouch tails, then physFlying's calls,
// blocked moves, stepUps, wall hits, slides and TwoWallAdjusts).
const stats = {calls: 0, declined: new Map(), walks: 0, flyBoundaries: 0, rotations: 0, tails: [0, 0, 0], rust: null};
let statsHost = null;
if (STATS) process.on('exit', () => {
  if (statsHost) stats.rust = Array.from(new Uint32Array(statsHost.vm.arena.memory.buffer, statsHost.x.pawn_phys_counts_ptr(), 9));
  process.stderr.write(`pawn physics kernel: ${JSON.stringify({...stats, declined: Object.fromEntries(stats.declined)})}\n`);
});
const decline = why => {
  if (STATS) stats.declined.set(why, (stats.declined.get(why) ?? 0) + 1);
  return -1;
};

// [spelling, key, kind]: the ABI with pawn_phys.rs (P_*).
export const PHYS_FIELDS = [
  ['DesiredRotation', 'engine.actor.desiredrotation', 'rotator'],
  ['RotationRate', 'engine.actor.rotationrate', 'rotator'],
  ['AvgPhysicsTime', 'engine.pawn.avgphysicstime', 'float'],
  ['PendingTouch', 'engine.actor.pendingtouch', 'pointer'],
  ['bFixedRotationDir', 'engine.actor.bfixedrotationdir', 'bool'],
  ['bRotateToDesired', 'engine.actor.brotatetodesired', 'bool'],
  ['AirSpeed', 'engine.pawn.airspeed', 'float'],
  ['DesiredSpeed', 'engine.pawn.desiredspeed', 'float'],
];
const FIXED = 4, ROTATE = 5;
// pawn_phys.rs P_ZONE_NUMBER: the row after PHYS_FIELDS.
const ZONE_NUMBER = PHYS_FIELDS.length;

export class PawnPhysicsHost {
  constructor(vm) {
    this.vm = vm;
    this.runtime = vm.runtime;
    this.version = -1;
    this.cells = null;
    this.valid = false;
    this.classes = new Map();
    this.instances = new WeakMap();
  }
  attach(x) {
    this.x = x;
    this.fieldsAt = x.pawn_phys_fields_ptr();
    this.enabled = !disabled();
    if (STATS) statsHost = this;
  }
  /** The registry cells of PHYS_FIELDS and their table rows. */
  table() {
    const version = fieldImageCellVersion();
    if (version === this.version) return;
    this.version = version;
    this.classes.clear();
    this.instances = new WeakMap();
    this.cells = PHYS_FIELDS.map(([, key, kind]) => {
      const cell = fieldImageCell(key);
      return cellKind(cell) === kind ? cell : null;
    });
    const fixed = scalarCell(this.cells[FIXED]), rotate = scalarCell(this.cells[ROTATE]);
    // Region.ZoneNumber at its member offset (move_actor.rs's region rows).
    this.vm.zone.table();
    const region = fieldImageCell('engine.actor.region'), members = this.vm.zone.members;
    this.valid = !this.cells.includes(null) && fixed && rotate && fixed.offset === rotate.offset &&
      fixed.mask === 0x20 && rotate.mask === 0x40 && cellKind(region) === 'struct' && members !== null;
    if (!this.valid) return;
    const view = this.vm.arena.view;
    this.cells.forEach((cell, i) => {
      view.setUint32(this.fieldsAt + i * 8, cell.offset, true);
      view.setUint32(this.fieldsAt + i * 8 + 4, (scalarCell(cell)?.mask ?? 0) >>> 0, true);
    });
    view.setUint32(this.fieldsAt + ZONE_NUMBER * 8, region.offset + members[2].offset, true);
    view.setUint32(this.fieldsAt + ZONE_NUMBER * 8 + 4, 0, true);
  }
  /** Whether every spelling of `cls` resolves to the table's cell and the
   * instance binds none of the keys. */
  eligible(instance) {
    const {cls, cells, fieldTable: names} = instance;
    let info = this.classes.get(cls);
    if (!info || info.names !== names.size) {
      let ok = this.valid;
      for (let i = 0; ok && i < PHYS_FIELDS.length; i++) {
        const [name, key] = PHYS_FIELDS[i];
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
      const ok = PHYS_FIELDS.every(([, key]) => !instance.bindings.has(key));
      this.instances.set(instance, entry = {info, bindings: instance.bindings.size, ok});
    }
    return entry.ok;
  }
  /** js_pawn_begin for the tick context `c`: the walk's depth, or -1. */
  begin(c) {
    if (!this.enabled) return decline('disabled');
    if (c.log) return decline('tick differential');
    const runtime = this.runtime, actor = c.receiver, walk = this.vm.walkLoop, mover = this.vm.moveActor;
    // The callback's processActorPhysics, unless a host replaced it.
    if (Object.hasOwn(runtime, 'processActorPhysics') || Object.hasOwn(runtime, 'pawnPhysicsServices')) return decline('replaced');
    const instance = c.instance;
    if (!instance?.cells || !instance.base || instance.arena !== this.vm.arena ||
      instance.poison?.size || instance.imageToken?.released || instance.nativeObject?.released) return decline('instance');
    if (!walk.enabled || !walk.x || !this.vm.zone.enabled || !this.vm.movePawn.x) return decline('walk host');
    const level = runtime.levelFor(actor);
    // pawnPhysicsServices' own error stays the callback's.
    if (!level?.hash) return decline('level');
    mover.table(); walk.table(); this.table();
    if (!mover.eligiblePawn(instance) || !walk.eligible(instance) || !this.eligible(instance)) return decline('fields');
    if (!(flagWordsOf(actor)?.motion || (actor.scriptView === true && runtime.collisionViewActors?.has(actor)))) return decline('motion word');
    const pawn = actor._pawnPhysics ?? pawnPhysicsView(actor, runtime.pawnPhysicsServices(actor));
    if (!pawn.pawn || pawn.movingBrush || pawn.model) return decline('kind');
    const ops = pawn.walkOps();
    // WalkLoopHost.walk's state words and contexts.
    const view = this.vm.arena.view;
    view.setUint32(walk.stateAt, this.vm.zone.model(ops.level), true);
    view.setUint32(walk.stateAt + 4, ops.worldActor ? handleOf(ops.worldActor) : 0, true);
    const depth = this.vm.movePawn.contexts.length;
    this.vm.movePawn.contexts.push({pawn, actor, ops: ops.move, hits: null, times: null});
    walk.contexts[depth] = {pawn, actor, ops};
    c.pawnDepth = depth;
    c.walkCounts = directWalkBegin(walk);
    c.walkHandedBack = false;
    if (STATS) stats.calls++;
    return depth;
  }
  /** The walk's contexts popped (also after an import threw). */
  end(c) {
    const depth = c.pawnDepth;
    if (depth === undefined) return;
    c.pawnDepth = undefined;
    directWalkEnd(this.vm.walkLoop, c.walkCounts, c.walkHandedBack);
    c.walkCounts = null;
    this.vm.movePawn.contexts.length = depth;
    this.vm.walkLoop.contexts.length = depth;
  }
  imports() {
    const host = this, tick = () => host.vm.actorTick;
    const context = depth => {
      const c = host.vm.walkLoop.contexts[depth];
      if (!c) throw new Error(`Pawn physics context ${depth} is not active`);
      return c;
    };
    // The reference's body from `stage` on, with the services and dispatch
    // runScriptPawnPhysics builds.
    const rest = (depth, stage, delta) => {
      const {pawn, actor} = context(depth), services = host.runtime.pawnPhysicsServices(actor);
      pawnPhysicsTail(actor, pawn, delta, services, pawnDispatch(actor, pawn, services), stage);
    };
    return {
      js_pawn_begin: i => host.begin(tick().contexts[i]),
      js_pawn_walk(depth, delta) {
        if (STATS) stats.walks++;
        const c = tick().contexts.find(c => c?.pawnDepth === depth);
        if (c) c.walkHandedBack = true;
        walking(context(depth).pawn, delta, 0);
      },
      js_pawn_fly(depth, delta) {
        if (STATS) stats.flyBoundaries++;
        physFlying(context(depth).pawn, delta, 0);
      },
      js_pawn_rotate(depth, pitch, yaw) {
        if (STATS) stats.rotations++;
        context(depth).pawn.moveActor([0, 0, 0], [pitch, yaw, 0]);
      },
      js_pawn_tail(depth, stage, delta) {
        if (STATS) stats.tails[stage]++;
        rest(depth, stage, delta);
      },
      js_pawn_end(i) {
        const c = tick().contexts[i];
        host.end(c);
        tick().refresh(c);
      },
    };
  }
}
