/**
 * ULevel::MoveActor for a Pawn source in Rust (native/script-vm/src/move_pawn.rs,
 * docs/rust-core.md step R3-b B4). The JavaScript body (player-move.mjs
 * `playerMove` over move-query.mjs `moveQuery`, reached through the map pawn
 * view's `moveActor` in script-pawn-physics.mjs) stays the reference: it
 * runs whenever this host declines a call or the kernel hands one back,
 * which happens before any store.
 *
 * A call runs in Rust only when every field the body reads or writes is the
 * image cell `readNamed` and the field references use (the move field
 * table shared with the rider kernel, move-actor-kernel.mjs), the source is
 * a Pawn and not a brush, and the level carries its collision hash. The
 * effects stay the reference's own functions, called from the imports at
 * the reference's points: the MultiLineCheck query (with `decorate` on each
 * hit's actor), IsBasedOn and the candidate type tests, the rider pass, the
 * hash remove/add, BumpWall or the Bump pair, the Touch pass's tests and
 * BeginTouch, IsOverlapping and EndTouch, and SetActorZone. Nested moves
 * (an event that moves another pawn) get their own context by depth.
 *
 * Switches (Node only): MOVE_PAWN_KERNEL=js keeps every call in JavaScript;
 * MOVE_PAWN_DIFFERENTIAL=1 compares each call completed in Rust with
 * `moveQuery` on the same hits (the pure prefix: the selected hit, the
 * displacement and the time) and counts the calls.
 */
import {moveQuery} from './move-query.mjs';
import {basedOn} from './player-move.mjs';

const env = typeof process !== 'undefined' ? process.env ?? {} : {};
const DISABLED = env.MOVE_PAWN_KERNEL === 'js' || globalThis.DEUS_EX_MOVE_PAWN_KERNEL === 'js';
const DIFFERENTIAL = env.MOVE_PAWN_DIFFERENTIAL === '1';
const counts = {calls: 0, tiny: 0, blocked: 0, handedBack: 0, declined: 0, declinedBy: {}};
const declined = (why, name) => {
  counts.declined++;
  if (DIFFERENTIAL) { const key = `${why} ${name ?? '?'}`; counts.declinedBy[key] = (counts.declinedBy[key] ?? 0) + 1; }
};
if (DIFFERENTIAL) process.on('exit', () => process.stderr.write(`pawn move differential: ${JSON.stringify(counts)}\n`));

const f = Math.fround;
const int32 = v => Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff;
const C_SKIP = 1, C_WORLD = 2, C_BRUSH = 4, C_PLAYER_OR_PROJECTILE = 8;

export class MovePawnHost {
  constructor(vm) {
    this.vm = vm;
    this.runtime = vm.runtime;
    // One context per nesting depth: the pawn view, its move services and
    // the query's hit objects.
    this.contexts = [];
  }
  attach(x) {
    this.x = x;
    this.ioAt = x.move_pawn_io_ptr();
    this.enabled = !DISABLED;
  }
  /** `moveActor(pawn, delta, newRotation, ...)`'s body in Rust: the result
   * playerMove returns, or undefined when the JavaScript body must run. */
  move(pawn, delta, newRotation, ignoreBases, ops) {
    if (DISABLED || !this.x || !this.vm.zone.enabled) return undefined;
    const actor = pawn.self, runtime = this.runtime;
    const instance = actor?.[runtime.instanceKey] ?? runtime.instances.get(actor);
    if (!instance?.cells || !instance.base || instance.arena !== this.vm.arena ||
      instance.poison?.size || instance.imageToken?.released || instance.nativeObject?.released) { declined('instance', actor?.name); return undefined; }
    if (!pawn.pawn || pawn.movingBrush || pawn.model) { declined('kind', actor?.name); return undefined; }
    if (!Array.isArray(delta) || delta.length !== 3 || !delta.every(v => typeof v === 'number') ||
      (newRotation !== null && (!Array.isArray(newRotation) || newRotation.length !== 3 || !newRotation.every(int32)))) { declined('args', actor?.name); return undefined; }
    const mover = this.vm.moveActor;
    mover.table();
    if (!mover.eligiblePawn(instance)) { declined('fields', actor?.name); return undefined; }
    const depth = this.contexts.length;
    const context = {pawn, actor, ops, hits: null, times: null};
    this.contexts.push(context);
    const x = this.x, stack = x.__stack_pointer.value;
    let code;
    try {
      code = x.move_pawn(depth, instance.base, f(delta[0]), f(delta[1]), f(delta[2]),
        newRotation ? 1 : 0, ...(newRotation ?? [0, 0, 0]), ignoreBases ? 1 : 0);
    } catch (error) {
      // An import threw through the Rust frames: the reference's error at
      // the same point. Put the shadow stack back for the next call.
      x.__stack_pointer.value = stack;
      throw error;
    } finally {
      this.contexts.pop();
    }
    if (code === 0) { counts.handedBack++; return undefined; }
    const io = new Float64Array(this.vm.arena.memory.buffer, this.ioAt, 9);
    const time = io[0], index = io[1], success = io[2] !== 0;
    const queryDelta = [io[3], io[4], io[5]], position = [io[6], io[7], io[8]];
    let hit = null;
    if (index >= 0) {
      const candidate = context.hits[index];
      hit = {...candidate, location: candidate.location?.slice(), normal: candidate.normal?.slice()};
      hit.time = time;
    }
    const result = {success, delta: queryDelta, position, time, hit};
    if (DIFFERENTIAL) this.verify(context, delta, result, index);
    counts.calls++;
    return result;
  }
  /** The pure prefix again in JavaScript, on the same hits: the selected
   * hit, its adjusted time and the displacement must agree. The commit and
   * the events are the reference's own functions, called from the imports. */
  verify(context, delta, result, index) {
    if (context.hits === null) { if (delta.every(v => Math.abs(f(v)) < .0001)) counts.tiny++; return; }
    const {pawn, ops} = context;
    const query = moveQuery({source: pawn, worldActor: ops.worldActor, start: context.start, delta,
      extent: context.extent, multiLineCheck: () => context.hits, ignoreBases: context.ignoreBases});
    const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
    const mismatch = !Object.is(query.time, result.time) || !same(query.delta, result.delta) ||
      query.success !== result.success || Boolean(query.hit) !== Boolean(result.hit) ||
      (query.hit && (query.hit.actor !== result.hit.actor || !same(query.hit.location, result.hit.location) ||
        !same(query.hit.normal, result.hit.normal) || query.hit.item !== result.hit.item));
    if (mismatch)
      throw new Error(`Pawn move differential mismatch for ${pawn.self?.name}: time ${query.time} vs ${result.time}, ` +
        `delta ${query.delta} vs ${result.delta}, hit ${query.hit?.actor?.name ?? null} vs ${result.hit?.actor?.name ?? null} (index ${index})`);
    if (result.hit) counts.blocked++;
  }
  /** The imports: each is the reference's read or effect at that point, on
   * the context of `depth`. */
  imports() {
    const host = this;
    const context = depth => {
      const c = host.contexts[depth];
      if (!c) throw new Error(`Pawn move context ${depth} is not active`);
      return c;
    };
    return {
      js_move_hits(depth, times, sx, sy, sz, ex, ey, ez, rx, ry, rz, checkActors, world) {
        const c = context(depth), ops = c.ops;
        c.start = [sx, sy, sz]; c.extent = [rx, ry, rz];
        const hits = ops.multiLineCheck({end: [ex, ey, ez], start: [sx, sy, sz], extent: [rx, ry, rz],
          checkActors: Boolean(checkActors), worldActor: world ? ops.worldActor : null, extra: 0});
        if (!Array.isArray(hits) || hits.length > 64) return -1;
        c.hits = hits;
        const view = new Float64Array(host.vm.arena.memory.buffer, times, 64);
        c.times = hits.map(h => h.time);
        for (let i = 0; i < hits.length; i++) view[i] = hits[i].time;
        return hits.length;
      },
      js_move_cand(depth, index, ignoreBases) {
        const c = context(depth), other = c.hits[index].actor, source = c.pawn, ops = c.ops;
        c.ignoreBases = Boolean(ignoreBases);
        if (ignoreBases && basedOn(source, other)) return C_SKIP;
        if (basedOn(other, source)) return C_SKIP;
        const flags = other.flags ?? 0;
        return (other === ops.worldActor ? C_WORLD : 0) | (other.movingBrush ? C_BRUSH : 0) |
          (other.controlledPlayer || other.projectile ? C_PLAYER_OR_PROJECTILE : 0) | ((flags & 0xff) << 8);
      },
      js_move_eligible(depth) {
        // `hits` is [] until the query ran (the reference's initial value).
        const c = context(depth);
        return c.hits !== null && c.hits.some(h => !basedOn(h.actor, c.pawn)) ? 1 : 0;
      },
      js_move_riders(depth, dx, dy, dz, pitch, yaw, roll) {
        const c = context(depth);
        if (typeof c.ops.moveRiders !== 'function') throw new Error('MoveActor based passengers require the recovered rider service');
        c.ops.moveRiders(c.pawn, [dx, dy, dz], [pitch, yaw, roll]);
      },
      js_move_hash(depth, add) {
        const c = context(depth);
        if (add) c.ops.addActor(c.pawn); else c.ops.removeActor(c.pawn);
      },
      js_move_bump(depth, wall, index) {
        const c = context(depth), hit = c.hits[index], source = c.pawn, ops = c.ops;
        if (wall) ops.dispatch(source, 'BumpWall', [[...hit.location], [...hit.normal]]);
        else if (!basedOn(source, hit.actor)) {
          ops.dispatch(hit.actor, 'Bump', [source]);
          ops.dispatch(source, 'Bump', [hit.actor]);
        }
      },
      js_move_touch_facts(depth, index) {
        const c = context(depth), other = c.hits[index].actor, source = c.pawn;
        if (basedOn(other, source)) return 1;
        return c.ops.isBlockedBy(source, other) ? 2 : 0;
      },
      js_move_begin_touch(depth, index) {
        const c = context(depth);
        c.ops.beginTouch(c.pawn, c.hits[index].actor);
      },
      js_move_overlap(depth, handle) {
        const c = context(depth), other = host.vm.identity(handle);
        return c.ops.isOverlapping(c.pawn, other) ? 1 : 0;
      },
      js_move_end_touch(depth, handle) {
        const c = context(depth), other = host.vm.identity(handle);
        c.ops.endTouch(c.pawn, other, false);
      },
      js_move_zone(depth) {
        const c = context(depth);
        c.ops.setActorZone(c.pawn, false, false);
      },
    };
  }
}
