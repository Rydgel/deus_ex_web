/**
 * The host half of the Rust actor tick (docs/rust-core.md R3-d,
 * native/script-vm/src/tick.rs). `tickStandaloneActor` (actor-tick.mjs),
 * with actorInStasis, the timer phase and the animation phase
 * (animation-tick.mjs over script-anim.mjs's tick view), runs in the
 * interpreter's instance on the actor's image. This module owns what Rust
 * cannot know by itself:
 *
 * - the field table (T_FIELDS): each field's offset and bool mask or
 *   fixed-array stride, from the cell registry, checked against the kind the
 *   Rust body reads;
 * - each actor's field mask: field i is set when `readNamed` on that actor
 *   reads the cell the table describes (the class resolves the spelling to
 *   the key and that cell, and the instance has no binding for the key), and
 *   its class flags (Pawn, PlayerPawn, Weapon, by record key as the tick's
 *   isA compares). Both are cached on the instance while its bindings, the
 *   class's resolved names and the table are unchanged;
 * - the imports: the callbacks (the same services the JavaScript body calls,
 *   at the same points), the JavaScript reads and writes for fields outside
 *   the mask, the hand-backs, and ACTOR_TICK_DIFFERENTIAL's replay.
 *
 * ACTOR_TICK_KERNEL=js keeps the JavaScript body. ACTOR_TICK_DIFFERENTIAL=1
 * records every callback with the actor's fields before and after it, and
 * every read of state outside the actor (the zone render time, the owner's
 * bTicked, IsProbing, the latent action, the notify's mesh). After each
 * tick Rust completed, the JavaScript body runs again on a virtual copy of
 * the actor's fields: its callbacks must be Rust's, in order and with the
 * same arguments, its fields must equal the real ones before each callback
 * and at the end, and its result must be Rust's.
 */
import {fieldImageCell, fieldImageCellVersion, cellKind, sameCell} from './script-object-image.mjs';
import {handleOf, identityOfHandle} from './script-object-handles.mjs';
import {nameCellWord} from './script-name-ids.mjs';
import {tickStandaloneActor} from './actor-tick.mjs';
import {tickActorAnimation, selectAnimNotify, named} from './animation-tick.mjs';
import {animationTickView} from './script-anim.mjs';
import {propertyReference, propertyCodec} from './script-values.mjs';
import {setScriptRunaway} from './script-vm.mjs';
import {probeNames} from '../unreal/probe-names.mjs';

const env = typeof process !== 'undefined' ? process.env ?? {} : {};
const DISABLED = env.ACTOR_TICK_KERNEL === 'js' || globalThis.DEUS_EX_ACTOR_TICK_KERNEL === 'js';
const DIFFERENTIAL = env.ACTOR_TICK_DIFFERENTIAL === '1';
const STATS = DIFFERENTIAL || env.ACTOR_TICK_STATS === '1';

/** The fields the Rust body reads (tick.rs F_*), in index order: [the
 * spelling the JavaScript body reads, key, cell kind, fixed-array element
 * kind]. */
export const TICK_FIELDS = Object.freeze([
  ['Role', 'engine.actor.role', 'byte'],
  ['RemoteRole', 'engine.actor.remoterole', 'byte'],
  ['LastRenderTime', 'engine.actor.lastrendertime', 'float'],
  ['bStasis', 'engine.actor.bstasis', 'bool'],
  ['bForceStasis', 'engine.actor.bforcestasis', 'bool'],
  ['Physics', 'engine.actor.physics', 'byte'],
  ['DistanceFromPlayer', 'engine.actor.distancefromplayer', 'float'],
  ['bTransient', 'engine.actor.btransient', 'bool'],
  ['Owner', 'engine.actor.owner', 'pointer'],
  ['bTicked', 'engine.actor.bticked', 'bool'],
  ['bIsPawn', 'engine.actor.bispawn', 'bool'],
  ['TimerRate', 'engine.actor.timerrate', 'float'],
  ['TimerCounter', 'engine.actor.timercounter', 'float'],
  ['bTimerLoop', 'engine.actor.btimerloop', 'bool'],
  ['LifeSpan', 'engine.actor.lifespan', 'float'],
  ['bIsPlayer', 'engine.pawn.bisplayer', 'bool'],
  ['bViewTarget', 'engine.pawn.bviewtarget', 'bool'],
  ['ViewRotation', 'engine.pawn.viewrotation', 'rotator'],
  ['Rotation', 'engine.actor.rotation', 'rotator'],
  ['Weapon', 'engine.pawn.weapon', 'pointer'],
  ['Location', 'engine.actor.location', 'vector'],
  ['SightCounter', 'engine.pawn.sightcounter', 'float'],
  ['bHidden', 'engine.actor.bhidden', 'bool'],
  ['PainTime', 'engine.pawn.paintime', 'float'],
  ['SpeechTime', 'engine.pawn.speechtime', 'float'],
  ['bAdvancedTactics', 'engine.pawn.badvancedtactics', 'bool'],
  ['AnimSequence', 'engine.actor.animsequence', 'name'],
  ['AnimFrame', 'engine.actor.animframe', 'float'],
  ['AnimRate', 'engine.actor.animrate', 'float'],
  ['TweenRate', 'engine.actor.tweenrate', 'float'],
  ['AnimLast', 'engine.actor.animlast', 'float'],
  ['AnimMinRate', 'engine.actor.animminrate', 'float'],
  ['Velocity', 'engine.actor.velocity', 'vector'],
  ['bAnimFinished', 'engine.actor.banimfinished', 'bool'],
  ['bAnimLoop', 'engine.actor.banimloop', 'bool'],
  ['bAnimNotify', 'engine.actor.banimnotify', 'bool'],
  ['BlendAnimSequence', 'engine.actor.blendanimsequence', 'fixed', 'name'],
  ['BlendAnimFrame', 'engine.actor.blendanimframe', 'fixed', 'float'],
  ['BlendAnimRate', 'engine.actor.blendanimrate', 'fixed', 'float'],
  ['BlendTweenRate', 'engine.actor.blendtweenrate', 'fixed', 'float'],
  ['BlendAnimLast', 'engine.actor.blendanimlast', 'fixed', 'float'],
  ['BlendAnimMinRate', 'engine.actor.blendanimminrate', 'fixed', 'float'],
  // Sleep's remaining time (script-sleep.mjs), polled in Rust.
  ['LatentFloat', 'engine.actor.latentfloat', 'float'],
]);
const F = Object.fromEntries(TICK_FIELDS.map(([name], i) => [name, i]));
// js_tick_get/js_tick_set: the animation view's animFlags accessor.
const A_FLAGS = 64;
// The animation view's accessors (script-anim.mjs) the fallbacks go through:
// the main sequence's, and a blend slot's.
const ANIM_MAIN = new Map(['AnimSequence', 'AnimFrame', 'AnimRate', 'TweenRate', 'AnimLast', 'AnimMinRate']
  .map(key => [F[key], key]));
const ANIM_BLEND = new Map([['BlendAnimSequence', 'AnimSequence'], ['BlendAnimFrame', 'AnimFrame'],
  ['BlendAnimRate', 'AnimRate'], ['BlendTweenRate', 'TweenRate'], ['BlendAnimLast', 'AnimLast'],
  ['BlendAnimMinRate', 'AnimMinRate']].map(([name, key]) => [F[name], key]));
const NAME_FIELDS = new Set([F.AnimSequence, F.BlendAnimSequence]);
const BOOL_FIELDS = new Set(TICK_FIELDS.flatMap(([, , kind], i) => kind === 'bool' ? [i] : []));
// The fields ACTOR_TICK_DIFFERENTIAL compares, besides TICK_FIELDS: the
// replication planes replicateCompletion writes.
const STRUCT_FIELDS = new Set(['SimAnim', 'SimBlendAnim']);
const SNAPSHOT_FIELDS = [...TICK_FIELDS.map(([name]) => name), ...STRUCT_FIELDS];
// Class flags (tick.rs C_*).
const C_PAWN = 1, C_PLAYERPAWN = 2, C_WEAPON = 4;
const HANDBACK = -1, DEFER = -2, HOST = 2;
// tick.rs E_*: the event and whether it takes the delta.
const EVENTS = [['Tick', true], ['Timer', false], ['Expired', false], ['UpdateEyeHeight', true],
  ['PainTimer', false], ['SpeechTimer', false], ['UpdateTactics', true]];
const PROBES = ['Tick', 'EnemyNotVisible'];
const S_VIEWROTATION = 0;

const stats = {calls: 0, handback: new Map(), defer: 0, callbacks: 0, get: 0, set: 0, statements: 0, animation: 0,
  verified: 0, compared: 0, mismatches: 0, imports: new Map()};
const counted = STATS ? name => stats.imports.set(name, (stats.imports.get(name) ?? 0) + 1) : null;
if (STATS) process.on('exit', () => {
  const handbacks = [...stats.handback].map(([why, n]) => `${why} ${n}`).join(', ') || 'none';
  process.stderr.write(`actor tick kernel: ${stats.calls} calls, handed back: ${handbacks}; ${stats.defer} deferred, ` +
    `${stats.callbacks} callbacks, ${stats.get} JavaScript reads, ${stats.set} writes, ${stats.statements} statements, ` +
    `${stats.animation} animation phases in JavaScript` +
    (DIFFERENTIAL ? `; differential: ${stats.verified} ticks replayed, ${stats.compared} field states compared, ` +
      `${stats.mismatches} mismatches\n` : '\n'));
});

/** The counters above (validators). */
export const actorTickStats = () => stats;

const f64io = new DataView(new ArrayBuffer(8));
/** Same float64 bits, any NaN matching any NaN (script-vm-rust.mjs sameBits). */
function sameNumber(a, b) {
  if (a !== a || b !== b) return a !== a && b !== b;
  f64io.setFloat64(0, a, true);
  const lo = f64io.getUint32(0, true), hi = f64io.getUint32(4, true);
  f64io.setFloat64(0, b, true);
  return lo === f64io.getUint32(0, true) && hi === f64io.getUint32(4, true);
}
function sameValue(name, a, b) {
  if (typeof a === 'number' && typeof b === 'number') return sameNumber(a, b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameValue(name, v, b[i]));
  if (STRUCT_FIELDS.has(name) && a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameValue('', a[key], b[key]));
  }
  return Object.is(a, b);
}
// A copy of a snapshot value, so the replay never shares an array or plane
// with the snapshot it came from.
function copyOf(name, value) {
  if (!Array.isArray(value)) return STRUCT_FIELDS.has(name) && value && typeof value === 'object' ? {...value} : value;
  return name === 'SimBlendAnim' ? value.map(item => item && typeof item === 'object' ? {...item} : item) : value.slice();
}
const describeValue = value => {
  if (typeof value === 'number') { f64io.setFloat64(0, value, true); return `${value} (0x${f64io.getBigUint64(0, true).toString(16)})`; }
  if (Array.isArray(value)) return `[${value.map(describeValue).join(', ')}]`;
  if (value && typeof value === 'object') return value.name ?? value.key ?? JSON.stringify(value);
  return String(value);
};

/** One tick in progress: what the imports need (reused per depth). */
class TickContext {
  constructor() {
    this.receiver = null; this.instance = null; this.services = null; this.level = null;
    this.view = null; this.notify = null; this.log = null;
    this.timeSeconds = 0; this.tickTag = 0; this.seconds = 0; this.tickType = 0;
    // pawn-physics-kernel.mjs: the walk contexts' depth while they are pushed.
    this.pawnDepth = undefined;
  }
  clear() {
    this.receiver = null; this.instance = null; this.services = null; this.level = null;
    this.view = null; this.notify = null; this.log = null;
  }
}

export class ActorTickHost {
  constructor(vm) {
    this.vm = vm;
    this.runtime = vm.runtime;
    this.enabled = false;
    this.x = null;
    // Per field: the registry cell the table describes, or null.
    this.expected = null;
    this.registryVersion = -1;
    // Advances whenever the table gains an entry.
    this.version = 0;
    this.classes = new WeakMap();
    this.snapshotNames = new WeakMap();
    // The ticks in progress (nested ticks run inside callbacks), by depth;
    // an import's `ctx` indexes it.
    this.contexts = [];
    this.depth = 0;
  }
  attach(x) {
    this.x = x;
    // No Rust frame is active yet: the shadow stack's top.
    this.stackTop = x.__stack_pointer.value;
    this.fieldsAt = x.tick_fields_ptr();
    this.stateAt = x.tick_state_ptr();
    this.f64At = x.tick_f64_ptr();
    this.vm.arena.view.setUint32(x.tick_empty_name_ptr(), nameCellWord(''), true);
    // The probe index of each js_tick_probing name, for tick.rs `probing`.
    const probes = x.tick_probe_names_ptr();
    PROBES.forEach((name, i) => this.vm.arena.view.setUint32(probes + 4 * i, (probeNames.get(name.toLowerCase()) ?? -1) >>> 0, true));
    this.enabled = !DISABLED;
  }
  /** Fill the table's missing entries from the registry. An entry, once
   * written, never changes (the registry keeps a key's cell or drops it). */
  table() {
    const version = fieldImageCellVersion();
    if (this.registryVersion === version) return;
    this.registryVersion = version;
    const expected = this.expected ??= TICK_FIELDS.map(() => null);
    if (!expected.includes(null)) return;
    const view = this.vm.arena.view;
    let added = false;
    TICK_FIELDS.forEach(([, key, kind, element], i) => {
      if (expected[i]) return;
      let cell = fieldImageCell(key);
      if (cellKind(cell) !== kind) cell = null;
      if (cell && kind === 'fixed' && (cell.dim !== 4 || cellKind(cell.element) !== element || cell.element.offset !== 0))
        cell = null;
      if (!cell) return;
      expected[i] = cell;
      added = true;
      view.setUint32(this.fieldsAt + 8 * i, cell.offset, true);
      view.setUint32(this.fieldsAt + 8 * i + 4, kind === 'fixed' ? cell.stride : cell.mask >>> 0, true);
    });
    if (added) this.version++;
  }
  /** A class's field bits and flags. Field i is set when the spelling
   * resolves to the table's key and the handle `readNamed` uses for it (the
   * class's cached one, or the cell it will cache) is the table's cell. */
  classInfo(cls, cells, names) {
    let info = this.classes.get(cls);
    if (info && info.version === this.version && info.names === names.size) return info;
    let lo = 0, hi = 0, flags = 0;
    const expected = this.expected, runtime = this.runtime;
    TICK_FIELDS.forEach(([name, key], i) => {
      if (!expected[i] || !cells) return;
      let field;
      try { field = runtime.lookupMember(cls, 'fields', name); } catch { return; }
      if (field?.key !== key) return;
      const cached = names.get(name);
      const cell = cached === undefined ? cells.get(key) : cached?.field === field ? cached.cell : null;
      if (!sameCell(cell, expected[i])) return;
      if (i < 32) lo |= 1 << i; else hi |= 1 << (i - 32);
    });
    for (let c = cls; c; c = c.base) {
      const key = c.record?.key;
      if (key === 'engine.pawn') flags |= C_PAWN;
      else if (key === 'engine.playerpawn') flags |= C_PLAYERPAWN;
      else if (key === 'engine.weapon') flags |= C_WEAPON;
    }
    info = {version: this.version, names: names.size, lo: lo >>> 0, hi: hi >>> 0, flags};
    this.classes.set(cls, info);
    return info;
  }
  /** An instance's mask (its class's bits without the fields it binds),
   * class flags and handle. The cache is keyed by the bindings' count:
   * bindings are only ever added (bindProperty), so an unchanged count is
   * an unchanged key set. */
  describe(instance, receiver) {
    const d = instance.tickDesc, names = instance.fieldTable;
    if (d !== undefined && d.version === this.version && d.bindings === instance.bindings.size &&
      d.names === names.size) return d;
    const info = this.classInfo(instance.cls, instance.cells, names);
    let lo = info.lo, hi = info.hi;
    if (instance.bindings.size) TICK_FIELDS.forEach(([, key], i) => {
      if (!instance.bindings.has(key)) return;
      if (i < 32) lo &= ~(1 << i); else hi &= ~(1 << (i - 32));
    });
    return instance.tickDesc = {version: this.version, bindings: instance.bindings.size, names: names.size,
      lo: lo >>> 0, hi: hi >>> 0, flags: info.flags, handle: handleOf(receiver)};
  }
  /** Whether every field access of the instance takes the JavaScript path:
   * no image here, a poisoned value, a released allocation. */
  host(instance) {
    return !instance.cells || !instance.base || instance.arena !== this.vm.arena || instance.poison?.size > 0 ||
      instance.imageToken?.released === true || instance.nativeObject?.released === true;
  }
  handback(why) {
    if (STATS) stats.handback.set(why, (stats.handback.get(why) ?? 0) + 1);
    return undefined;
  }
  /** tickStandaloneActor in Rust: its result, or undefined when the
   * JavaScript body must run the tick (before any effect). */
  run(receiver, seconds, entry) {
    const runtime = this.runtime;
    if (STATS) stats.calls++;
    const instance = receiver?.[runtime.instanceKey] ?? runtime.instances.get(receiver);
    if (instance === undefined || this.host(instance)) return this.handback('host receiver');
    const services = entry.services, level = services.level, tickType = entry.tickType;
    // The JavaScript body's own gates and errors on these.
    if (typeof seconds !== 'number' || (tickType !== 0 && tickType !== 1 && tickType !== 2) || !level ||
      level.netMode !== 0 || level.demoRecDriver !== null || (level.tickTag !== 0 && level.tickTag !== 1) ||
      typeof level.timeSeconds !== 'number') return this.handback('level');
    this.table();
    const d = this.describe(instance, receiver);
    if (d.flags & C_PLAYERPAWN) return this.handback('PlayerPawn');
    const ctx = this.depth, c = this.contexts[ctx] ??= new TickContext();
    c.receiver = receiver; c.instance = instance; c.services = services; c.level = level;
    c.view = null; c.notify = null; c.log = DIFFERENTIAL ? [] : null;
    c.timeSeconds = level.timeSeconds; c.tickTag = level.tickTag; c.seconds = seconds; c.tickType = tickType;
    this.depth = ctx + 1;
    const before = DIFFERENTIAL ? this.snapshot(c) : null;
    // The shadow stack pointer to restore if an import throws through the
    // Rust frames: at the top level (no run or tick of this instance active)
    // it is the stack's top, read once; reading the global costs ~0.1 ms
    // per Island tick.
    const x = this.x, pointer = ctx === 0 && this.vm.depth === 0 ? this.stackTop : x.__stack_pointer.value;
    // Events may run in Rust (dispatch.rs) when processEvent behind these
    // services is the runtime's own; never under the differential log,
    // which records each event as a callback.
    const events = c.log ? 0 : this.vm.events.allowed(services);
    if (ctx >= 32) throw new Error('Actor.Tick nesting beyond the tick kernel\'s 32 contexts');
    let result;
    try {
      result = x.tick_actor(ctx, d.handle, instance.base, d.lo, d.hi, d.flags, seconds, tickType, level.timeSeconds, level.tickTag, events);
    } catch (error) {
      // An import that throws unwinds past the Rust frames: the shadow
      // stack, then the frame stack, hang budget and events word as the
      // tick found them (tick_unwind).
      x.__stack_pointer.value = pointer;
      x.tick_unwind(ctx);
      // The walk contexts of a pawn's performPhysics in Rust.
      this.vm.pawnPhysics?.end(c);
      c.clear();
      throw error;
    } finally {
      this.depth = ctx;
    }
    if (DIFFERENTIAL) this.verify(c, before, result);
    c.clear();
    if (result === HANDBACK) return this.handback('prelude');
    if (result === DEFER) {
      // The body's owner-deferred tail, after the reads Rust made.
      if (STATS) stats.defer++;
      const node = services.allocateDeferredActor();
      if (node !== null && typeof node !== 'object') throw new Error('Original deferred-actor allocation result is not provided');
      if (node) { node.actor = receiver; node.next = level.deferredHead; }
      level.deferredHead = node;
      return 0;
    }
    return result;
  }
  view(c) {
    return c.view ??= this.runtime.animationTick(c.receiver);
  }
  /** After a callback: the actor's receiver info, mask and the level's
   * DemoRecDriver test (tick.rs `refresh`). */
  refresh(c) {
    const instance = c.instance, view = this.vm.arena.view, at = this.stateAt;
    if (this.host(instance)) view.setUint32(at, HOST, true);
    else {
      const d = this.describe(instance, c.receiver);
      view.setUint32(at, instance.base, true);
      view.setUint32(at + 4, d.lo, true);
      view.setUint32(at + 8, d.hi, true);
    }
    view.setUint32(at + 12, c.level.demoRecDriver !== null ? 1 : 0, true);
  }
  callback(c, name, args, fn) {
    if (STATS) stats.callbacks++;
    if (c.log) {
      const entry = {kind: 'call', name, args, before: this.snapshot(c), after: null};
      c.log.push(entry);
      fn();
      entry.after = this.snapshot(c);
    } else fn();
    this.refresh(c);
  }
  /** js_tick_get: the JavaScript body's read of a field outside the mask. */
  get(c, field, element) {
    if (STATS) stats.get++;
    let value;
    if (field === A_FLAGS) value = this.view(c).animFlags;
    else if (ANIM_MAIN.has(field)) value = this.view(c)[ANIM_MAIN.get(field)];
    else if (ANIM_BLEND.has(field)) value = this.view(c).blends[element][ANIM_BLEND.get(field)];
    else value = c.services.read(c.receiver, TICK_FIELDS[field][0]);
    if (NAME_FIELDS.has(field)) return named(value) ? 1 : 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === null) return 0;
    if (typeof value === 'object') return handleOf(value);
    throw new Error(`Actor tick kernel: ${TICK_FIELDS[field]?.[0] ?? field} read as ${typeof value}`);
  }
  /** js_tick_set: the JavaScript body's write of a field outside the mask. */
  set(c, field, element, value) {
    if (STATS) stats.set++;
    if (field === A_FLAGS) this.view(c).animFlags = value;
    else if (ANIM_MAIN.has(field)) this.view(c)[ANIM_MAIN.get(field)] = value;
    else if (ANIM_BLEND.has(field)) this.view(c).blends[element][ANIM_BLEND.get(field)] = value;
    else c.services.write(c.receiver, TICK_FIELDS[field][0], BOOL_FIELDS.has(field) ? value !== 0 : value);
  }
  f64(index, value) {
    this.vm.arena.view.setFloat64(this.f64At + 8 * index, value, true);
  }
  imports() {
    const host = this, context = i => host.contexts[i];
    return {
      js_tick_zone_time(i) {
        counted?.('js_tick_zone_time');
        const c = context(i), value = c.level.zoneLastRenderTime(c.receiver);
        c.log?.push({kind: 'zone', value});
        const number = typeof value === 'number';
        host.vm.arena.view.setUint32(host.stateAt + 16, number ? 0 : 1, true);
        return number ? value : 0;
      },
      js_tick_owner_ticked(i, handle) {
        counted?.('js_tick_owner_ticked');
        const c = context(i), owner = identityOfHandle(handle);
        if (!owner) return -1;
        const value = c.services.read(owner, 'bTicked');
        c.log?.push({kind: 'owner', owner, value});
        return Number(Boolean(value));
      },
      js_tick_probing(i, which) {
        counted?.('js_tick_probing');
        const c = context(i), name = PROBES[which], value = c.services.isProbing(c.receiver, name);
        c.log?.push({kind: 'probe', name, value});
        return value ? 1 : 0;
      },
      js_tick_destroy(i) {
        const c = context(i);
        host.callback(c, 'destroy', [0], () => c.services.destroyActor(c.receiver, 0));
      },
      js_tick_event(i, which, delta) {
        const c = context(i), [name, withDelta] = EVENTS[which], args = withDelta ? [delta] : [];
        host.callback(c, name, args.slice(), () => c.services.processEvent(c.receiver, name, args));
      },
      // An event ran in Rust (dispatch.rs): the runaway count it left, then
      // the actor's fresh state as after a callback.
      js_tick_refresh(i) {
        setScriptRunaway(host.vm.arena.view.getUint32(host.vm.runawayAt, true));
        host.refresh(context(i));
      },
      js_tick_state(i, delta) {
        const c = context(i);
        host.callback(c, 'state', [delta], () => c.services.processState(c.receiver, delta));
      },
      // Rust polled Sleep and cleared it (tick.rs process_state): the poll's
      // LatentAction write, then ProcessState, which skips the poll and runs
      // the state code, as one ProcessState call would.
      js_tick_resume(i, delta) {
        const c = context(i);
        host.callback(c, 'state', [delta], () => {
          host.runtime.instance(c.receiver).state.latent = 0;
          c.services.processState(c.receiver, delta);
        });
      },
      js_tick_physics(i, delta) {
        const c = context(i);
        host.callback(c, 'physics', [delta], () => c.services.performPhysics(c.receiver, delta));
      },
      js_tick_far_move(i, handle, x, y, z) {
        const c = context(i), weapon = identityOfHandle(handle), location = [x, y, z];
        if (!weapon) { host.refresh(c); return; }
        host.callback(c, 'farMove', [weapon, location.slice(), 0, 0], () => c.services.farMoveActor(weapon, location, 0, 0));
      },
      js_tick_show_self(i) {
        const c = context(i);
        host.callback(c, 'showSelf', [], () => c.services.showSelf(c.receiver));
      },
      js_tick_check_enemy(i) {
        const c = context(i);
        host.callback(c, 'checkEnemy', [], () => c.services.checkEnemyVisible(c.receiver));
      },
      js_tick_animation(i, delta) {
        const c = context(i);
        if (STATS) stats.animation++;
        host.callback(c, 'animation', [delta], () => c.services.advanceAnimation(c.receiver, delta));
      },
      // The body's statement where a field it uses is outside the mask.
      js_tick_stmt(i, which) {
        const c = context(i), s = c.services, actor = c.receiver;
        if (STATS) stats.statements++;
        if (which === S_VIEWROTATION) s.write(actor, 'ViewRotation', s.read(actor, 'Rotation'));
        else {
          const weapon = s.read(actor, 'Weapon');
          if (weapon) {
            const location = s.read(actor, 'Location');
            host.callback(c, 'farMove', [weapon, location.slice(), 0, 0], () => s.farMoveActor(weapon, location, 0, 0));
            return;
          }
        }
        host.refresh(c);
      },
      js_tick_get: (i, field, element) => host.get(context(i), field, element),
      js_tick_set(i, field, element, value) {
        const c = context(i);
        host.set(c, field, element, value);
        host.refresh(c);
      },
      js_tick_error(i, code) {
        if (code === 2) throw new Error(`Actor tick kernel: the state table's IsProbing differs from JavaScript for ${context(i).receiver?.name}`);
        throw new Error('Actor.Tick callback installed an unsupported DemoRecDriver');
      },
      js_anim_end(i) {
        counted?.('js_anim_end');
        const c = context(i), runtime = host.runtime;
        const record = runtime.animationFunction(c.receiver, 'AnimEnd', true);
        c.log?.push({kind: 'lookup', name: 'AnimEnd', record});
        host.callback(c, `anim ${record.name}`, [], () => runtime.animationEvent(c.receiver, record));
      },
      js_anim_notify(i, old) {
        counted?.('js_anim_notify');
        const c = context(i);
        let mesh;
        const notify = selectAnimNotify(host.view(c), old, () => (mesh = host.runtime.meshPayload(c.receiver)));
        c.notify = notify;
        c.log?.push({kind: 'notify', mesh, notify});
        if (!notify) return 0;
        host.f64(0, notify.time);
        return 1;
      },
      js_anim_notify_event(i) {
        counted?.('js_anim_notify_event');
        const c = context(i), runtime = host.runtime;
        const record = runtime.animationFunction(c.receiver, c.notify.name, false);
        c.log?.push({kind: 'lookup', name: c.notify.name, record});
        if (record) host.callback(c, `anim ${record.name}`, [], () => runtime.animationEvent(c.receiver, record));
        else host.refresh(c);
      },
      js_anim_latent(i) {
        counted?.('js_anim_latent');
        const c = context(i), value = host.view(c).latentAction;
        c.log?.push({kind: 'latent', value});
        return value === 0x181 ? 1 : 0;
      },
      // replicateCompletion's plane write, with the frame and rate Rust computed.
      js_anim_sim(i, blend, frame, rate) {
        counted?.('js_anim_sim');
        const c = context(i), view = host.view(c), target = blend < 0 ? view : view.blends[blend];
        target.simAnim = {...target.simAnim, frame, rate};
        host.refresh(c);
      },
      js_anim_velocity(i) {
        counted?.('js_anim_velocity');
        const [x, y, z] = host.view(context(i)).Velocity;
        host.f64(0, x);
        host.f64(1, y);
        host.f64(2, z);
      },
    };
  }

  // ---- ACTOR_TICK_DIFFERENTIAL ------------------------------------------

  /** The actor's compared fields, as `readNamed` returns them (or the error
   * it throws), and whether the level has a DemoRecDriver. */
  snapshot(c) {
    const out = new Map(), runtime = this.runtime, cls = c.instance.cls;
    let names = this.snapshotNames.get(cls);
    if (!names) {
      names = SNAPSHOT_FIELDS.filter(name => { try { return Boolean(runtime.lookupMember(cls, 'fields', name)); } catch { return false; } });
      this.snapshotNames.set(cls, names);
    }
    for (const name of names) {
      try { out.set(name, {ok: true, value: runtime.readNamed(c.receiver, name)}); }
      catch (error) { out.set(name, {ok: false, value: String(error?.message ?? error)}); }
    }
    out.set('$demo', {ok: true, value: c.level.demoRecDriver !== null});
    return out;
  }
  fail(c, message) {
    const actor = `${c.receiver?.name ?? '?'} (${c.instance.cls.record.key})`;
    stats.mismatches++;
    throw new Error(`ACTOR_TICK_DIFFERENTIAL ${actor}: ${message}`);
  }
  compare(c, js, rust, where) {
    stats.compared++;
    for (const [name, expected] of rust) {
      const actual = js.get(name);
      if (!actual || actual.ok !== expected.ok || !sameValue(name, actual.value, expected.value))
        this.fail(c, `${where}: ${name} is ${describeValue(actual?.value)} in JavaScript, ${describeValue(expected.value)} in Rust`);
    }
    if (js.size !== rust.size) this.fail(c, `${where}: ${js.size} fields in JavaScript, ${rust.size} in Rust`);
  }
  /** After a Rust tick: the JavaScript body on a virtual copy of the fields,
   * with the callbacks and outside reads Rust made. */
  verify(c, before, result) {
    const after = this.snapshot(c);
    if (result === HANDBACK) {
      // Only reads may precede a hand-back.
      if (c.log.some(entry => entry.kind === 'call')) this.fail(c, 'handed back after a callback');
      this.compare(c, after, before, 'hand-back');
      return;
    }
    const replay = new Replay(this, c, before);
    let value;
    try { value = replay.run(); }
    catch (error) {
      if (String(error?.message).startsWith('ACTOR_TICK_DIFFERENTIAL')) throw error;
      this.fail(c, `the JavaScript body threw where Rust did not: ${error?.message}`);
    }
    if (replay.at !== c.log.length) this.fail(c, `Rust logged ${c.log.length - replay.at} more entries (${c.log[replay.at].kind} ${c.log[replay.at].name ?? ''})`);
    this.compare(c, replay.store, after, 'end');
    const rust = result === DEFER ? 'deferred' : result, js = replay.deferred ? (value === 0 ? 'deferred' : `deferred ${value}`) : value;
    if (rust !== js) this.fail(c, `result ${js} in JavaScript, ${rust} in Rust`);
    stats.verified++;
  }
}

/** The JavaScript body on a virtual copy of one actor's fields. */
class Replay {
  constructor(host, c, before) {
    this.host = host;
    this.c = c;
    this.store = this.copy(before);
    this.at = 0;
    this.deferred = false;
  }
  copy(snapshot) {
    return new Map([...snapshot].map(([name, {ok, value}]) => [name, {ok, value: copyOf(name, value)}]));
  }
  fail(message) { this.host.fail(this.c, message); }
  next(kind) {
    const entry = this.c.log[this.at++];
    if (!entry || entry.kind !== kind)
      this.fail(`JavaScript reached ${kind}, Rust logged ${entry ? `${entry.kind} ${entry.name ?? ''}` : 'nothing'}`);
    return entry;
  }
  read(name) {
    const entry = this.store.get(name);
    if (!entry) this.fail(`read of ${name}, which is not compared`);
    if (!entry.ok) throw new Error(entry.value);
    return copyOf(name, entry.value);
  }
  field(name) {
    const field = this.host.runtime.lookupMember(this.c.instance.cls, 'fields', name);
    if (!field) throw new Error(`Original property was not found: ${name}`);
    return field;
  }
  write(name, value) {
    this.read(name);
    this.store.set(name, {ok: true, value: propertyCodec(this.field(name)).copy(value)});
  }
  callback(name, args) {
    const entry = this.next('call');
    if (entry.name !== name || entry.args.length !== args.length || !entry.args.every((v, i) => sameValue('', v, args[i])))
      this.fail(`callback ${name}(${args.map(describeValue)}) in JavaScript, ${entry.name}(${entry.args.map(describeValue)}) in Rust`);
    this.host.compare(this.c, this.store, entry.before, `before ${name}`);
    this.store = this.copy(entry.after);
  }
  run() {
    const replay = this, c = this.c, actor = c.receiver;
    const self = a => { if (a !== actor) replay.fail('a write to another actor'); };
    const level = {
      timeSeconds: c.timeSeconds, netMode: 0, tickTag: c.tickTag, deferredHead: null,
      get demoRecDriver() { return replay.store.get('$demo').value ? {} : null; },
      zoneLastRenderTime: a => { self(a); return replay.next('zone').value; },
    };
    const services = {
      read: (a, name) => {
        if (a === actor) return replay.read(name);
        const entry = replay.next('owner');
        if (entry.owner !== a || name !== 'bTicked') replay.fail(`read of ${name} of another actor`);
        return entry.value;
      },
      write: (a, name, value) => { self(a); replay.write(name, value); },
      // The class chain (the actor may have been released since).
      isA: (a, key) => {
        self(a);
        for (let cls = c.instance.cls; cls; cls = cls.base) if (cls.record.key === key) return true;
        return false;
      },
      level,
      isProbing: (a, name) => {
        self(a);
        const entry = replay.next('probe');
        if (entry.name !== name) replay.fail(`IsProbing ${name} in JavaScript, ${entry.name} in Rust`);
        return entry.value;
      },
      processEvent: (a, name, args = []) => { self(a); replay.callback(name, args); },
      processState: (a, delta) => { self(a); replay.callback('state', [delta]); },
      performPhysics: (a, delta) => { self(a); replay.callback('physics', [delta]); },
      destroyActor: (a, force) => { self(a); replay.callback('destroy', [force]); },
      farMoveActor: (weapon, location, test, noCheck) => replay.callback('farMove', [weapon, location, test, noCheck]),
      showSelf: a => { self(a); replay.callback('showSelf', []); },
      checkEnemyVisible: a => { self(a); replay.callback('checkEnemy', []); },
      readInput: () => replay.fail('ReadInput reached'),
      allocateDeferredActor: () => { replay.deferred = true; return {}; },
      advanceAnimation: (a, delta) => { self(a); replay.animation(delta); },
    };
    return tickStandaloneActor(actor, c.seconds, c.tickType, services);
  }
  /** processActorAnimation on the virtual fields (or the whole phase as a
   * callback, where Rust left it to JavaScript). */
  animation(delta) {
    const next = this.c.log[this.at];
    if (next?.kind === 'call' && next.name === 'animation') { this.callback('animation', [delta]); return; }
    const replay = this, c = this.c, runtime = this.host.runtime, actor = c.receiver;
    const virtual = {
      readNamed: (a, name) => replay.read(name),
      writeNamed: (a, name, value) => replay.write(name, value),
      readNamedElements: (a, name) => {
        const whole = replay.read(name);
        return Array.isArray(whole) ? {length: whole.length, at: index => whole[index]} : null;
      },
      namedReference: (a, name) => propertyReference(replay.field(name), () => replay.read(name),
        raw => { replay.read(name); replay.store.set(name, {ok: true, value: raw}); }),
      instance: () => ({cls: c.instance.cls, state: {get latent() { return replay.next('latent').value; }}}),
      warning: runtime.warning,
    };
    const view = animationTickView(virtual, actor);
    tickActorAnimation(view, delta, {
      mesh: () => replay.next('notify').mesh, simulatedPawn: view.simulatedPawn,
      // FindFunction as it answered during the tick (it follows the state).
      findFunction: (name, checked) => {
        const entry = replay.next('lookup');
        if (entry.name !== name) replay.fail(`FindFunction ${name} in JavaScript, ${entry.name} in Rust`);
        if (!entry.record && checked) replay.fail(`FindFunctionChecked ${name} found nothing`);
        return entry.record;
      },
      processEvent: record => replay.callback(`anim ${record.name}`, []),
    });
  }
}
