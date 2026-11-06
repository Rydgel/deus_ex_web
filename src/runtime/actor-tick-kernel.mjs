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
 * `batch` runs ULevel::Tick's actor loop over a run of Level.Actors in Rust
 * (level_loop.rs): each actor whose descriptor (what `run` takes from
 * `describe`) is current is ticked there with no JavaScript, and the host's
 * per-actor chain runs only for the others. LEVEL_LOOP=js (Node) or
 * ?levelLoop=js keeps the chain for every actor; LEVEL_LOOP=verify describes
 * every actor again and throws when a current descriptor differs.
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
import {tickStandaloneActor, actorInStasis} from './actor-tick.mjs';
import {scriptedPawnTick} from './scripted-pawn-tick.mjs';
import {tickActorAnimation, selectAnimNotify, named} from './animation-tick.mjs';
import {animationTickView} from './script-anim.mjs';
import {propertyReference, propertyCodec} from './script-values.mjs';
import {setScriptRunaway} from './script-vm.mjs';
import {probeNames} from '../unreal/probe-names.mjs';
import {receiverEpoch} from './receiver-epoch.mjs';
import {HandleMirror} from './actor-handle-mirror.mjs';
import {actorsEpoch, onActorsEpoch} from './base-epoch.mjs';
import {tickReadsMode} from './script-vm-events.mjs';

const env = typeof process !== 'undefined' ? process.env ?? {} : {};
const DISABLED = env.ACTOR_TICK_KERNEL === 'js' || globalThis.DEUS_EX_ACTOR_TICK_KERNEL === 'js';
const DIFFERENTIAL = env.ACTOR_TICK_DIFFERENTIAL === '1';
const STATS = DIFFERENTIAL || env.ACTOR_TICK_STATS === '1';
/** The level loop (level_loop.rs): 'rust' (default), 'js' or 'verify'. */
export const levelLoopMode = () => env.LEVEL_LOOP || globalThis.DEUS_EX_LEVEL_LOOP || 'rust';

// LEVEL_IO (level_loop.rs): two doubles, then these words, then the deferred slots.
const L_LIST = 0, L_DESC = 1, L_START = 2, L_ROWS = 3, L_VERSION = 4, L_TICK_TYPE = 5, L_TICK_TAG = 6, L_EVENTS = 7,
  L_ACTORS_EPOCH = 8, L_VERIFY = 9, L_NEXT = 10, L_PROGRESS = 11, L_CURRENT = 12, L_HANDLE = 13, L_FLAGS = 14, L_TICKED = 15,
  L_DEFERRED = 16, L_WORDS = 17, ROW_WORDS = 5;
/** An actor JavaScript ticks (level_loop.rs JS_TICK). */
const JS_TICK = 0x80000000;
// The batch in progress, whose LEVEL_IO mirrors actorsEpoch.
let batching = null;
onActorsEpoch(epoch => { if (batching) batching.vm.arena.view.setUint32(batching.levelWords + 4 * L_ACTORS_EPOCH, epoch, true); });

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
  // Region.ZoneNumber's byte, for the zone render time (tick.rs zone_render_time); the table's offset is the struct cell's plus the member's.
  ['Region', 'engine.actor.region', 'struct'],
]);
const ZONE_NUMBER = 'engine.actor.pointregion.zonenumber';
/** The fields AScriptedPawn::Tick reads and writes besides TICK_FIELDS's (sptick.rs S_*), in index order: [the spelling, key, cell
 * kind]. A pawn runs the phase in Rust only when its class resolves every one of them to the cell the table describes. */
export const SP_FIELDS = Object.freeze([
  ['bSimulatedPawn', 'engine.actor.bsimulatedpawn', 'bool'],
  ['Acceleration', 'engine.actor.acceleration', 'vector'],
  ['MoveTimer', 'engine.pawn.movetimer', 'float'],
  ['Health', 'engine.pawn.health', 'int'],
  ['bOnFire', 'engine.pawn.bonfire', 'bool'],
  ['burnTimer', 'engine.pawn.burntimer', 'float'],
  ['PrePivot', 'engine.actor.prepivot', 'vector'],
  ['DesiredPrePivot', 'deusex.scriptedpawn.desiredprepivot', 'vector'],
  ['PrePivotTime', 'deusex.scriptedpawn.prepivottime', 'float'],
  ['CarcassCheckTimer', 'deusex.scriptedpawn.carcasschecktimer', 'float'],
  ['PotentialEnemyTimer', 'deusex.scriptedpawn.potentialenemytimer', 'float'],
  ['BeamCheckTimer', 'deusex.scriptedpawn.beamchecktimer', 'float'],
  ['bAlliancesChanged', 'deusex.scriptedpawn.ballianceschanged', 'bool'],
  ['ReloadTimer', 'deusex.scriptedpawn.reloadtimer', 'float'],
  ['bCanBleed', 'deusex.scriptedpawn.bcanbleed', 'bool'],
  ['BleedRate', 'deusex.scriptedpawn.bleedrate', 'float'],
  ['DropCounter', 'deusex.scriptedpawn.dropcounter', 'float'],
  ['ClotPeriod', 'deusex.scriptedpawn.clotperiod', 'float'],
  ['AgitationDecayRate', 'deusex.scriptedpawn.agitationdecayrate', 'float'],
  ['AgitationTimer', 'deusex.scriptedpawn.agitationtimer', 'float'],
  ['AgitationCheckTimer', 'deusex.scriptedpawn.agitationchecktimer', 'float'],
  ['PlayerAgitationTimer', 'deusex.scriptedpawn.playeragitationtimer', 'float'],
  ['FearSustainTime', 'deusex.scriptedpawn.fearsustaintime', 'float'],
  ['FearDecayRate', 'deusex.scriptedpawn.feardecayrate', 'float'],
  ['FearTimer', 'deusex.scriptedpawn.feartimer', 'float'],
  ['FearLevel', 'deusex.scriptedpawn.fearlevel', 'float'],
  ['AlarmTimer', 'deusex.scriptedpawn.alarmtimer', 'float'],
  ['WeaponTimer', 'deusex.scriptedpawn.weapontimer', 'float'],
  ['FireTimer', 'deusex.scriptedpawn.firetimer', 'float'],
  ['SpecialTimer', 'deusex.scriptedpawn.specialtimer', 'float'],
  ['bDisappear', 'deusex.scriptedpawn.bdisappear', 'bool'],
  ['bTickVisibleOnly', 'deusex.scriptedpawn.btickvisibleonly', 'bool'],
  ['bClearedObstacle', 'deusex.scriptedpawn.bclearedobstacle', 'bool'],
  ['TurnDirection', 'deusex.scriptedpawn.turndirection', 'byte'],
  ['NextDirection', 'deusex.scriptedpawn.nextdirection', 'byte'],
  ['ActorAvoiding', 'deusex.scriptedpawn.actoravoiding', 'pointer'],
  ['AvoidWallTimer', 'deusex.scriptedpawn.avoidwalltimer', 'float'],
  ['AvoidBumpTimer', 'deusex.scriptedpawn.avoidbumptimer', 'float'],
  ['ObstacleTimer', 'deusex.scriptedpawn.obstacletimer', 'float'],
  ['TakeHitTimer', 'deusex.scriptedpawn.takehittimer', 'float'],
  ['BurnPeriod', 'deusex.scriptedpawn.burnperiod', 'float'],
  ['FutzTimer', 'deusex.scriptedpawn.futztimer', 'float'],
  ['DistressTimer', 'deusex.scriptedpawn.distresstimer', 'float'],
  ['bHasCloak', 'deusex.scriptedpawn.bhascloak', 'bool'],
  ['CloakThreshold', 'deusex.scriptedpawn.cloakthreshold', 'int'],
  ['CloakEMPTimer', 'deusex.scriptedpawn.cloakemptimer', 'float'],
  ['AlliancesEx', 'deusex.scriptedpawn.alliancesex', 'fixed'],
  // a name: its id lives in its bytes, so Rust writes it (to None) through the host only
  ['PotentialEnemyAlliance', 'deusex.scriptedpawn.potentialenemyalliance', 'name'],
]);
const SPB = 100;
const SP_ALLIANCE_MEMBERS = ['deusex.scriptedpawn.allianceinfoex.alliancename', 'deusex.scriptedpawn.allianceinfoex.agitationlevel',
  'deusex.scriptedpawn.allianceinfoex.bpermanent'];
const SP_INDEX = Object.fromEntries(SP_FIELDS.map(([name], i) => [name, i]));
// every SP field in the image (the name PotentialEnemyAlliance is written through the host and is not in the mask)
const SP_FULL_LO = 0xffffffff, SP_FULL_HI = (2 ** (SP_FIELDS.length - 32 - 1) - 1) >>> 0;
const SP_ALLIANCES = SP_INDEX.AlliancesEx, SP_POTENTIAL = SP_INDEX.PotentialEnemyAlliance;
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
const STRUCT_FIELDS = new Set(['SimAnim', 'SimBlendAnim', 'AlliancesEx']);
const SNAPSHOT_FIELDS = [...TICK_FIELDS.map(([name]) => name).filter(name => name !== 'Region'), ...SP_FIELDS.map(([name]) => name), ...STRUCT_FIELDS];
// Class flags (tick.rs C_*).
const C_PAWN = 1, C_PLAYERPAWN = 2, C_WEAPON = 4, C_SCRIPTEDPAWN = 8;
const HANDBACK = -1, DEFER = -2, HOST = 2;
// tick.rs E_*: the event and whether it takes the delta.
const EVENTS = [['Tick', true], ['Timer', false], ['Expired', false], ['UpdateEyeHeight', true],
  ['PainTimer', false], ['SpeechTimer', false], ['UpdateTactics', true],
  // AScriptedPawn::Tick's (sptick.rs E_*): the bool parameter, then no arguments; each looked up first, as FindFunctionChecked
  // does, and an event the class does not declare is dropped
  ['EnableCloak', false, [false]], ['EnableCloak', false, [true]], ['ExtinguishFire', false, []], ['SpurtBlood', false, []]];
const SP_EVENT = 7;
const PROBES = ['Tick', 'EnemyNotVisible'];
const S_VIEWROTATION = 0;

const stats = {calls: 0, handback: new Map(), defer: 0, callbacks: 0, get: 0, set: 0, statements: 0, animation: 0,
  verified: 0, compared: 0, mismatches: 0, imports: new Map(), batched: 0, batchStops: new Map()};
// level_loop.rs STOP_*
const BATCH_STOPS = ['end', 'JavaScript actor', 'list changed', 'hand-back', 'deferred list full'];
const counted = STATS ? name => stats.imports.set(name, (stats.imports.get(name) ?? 0) + 1) : null;
if (STATS) process.on('exit', () => {
  const handbacks = [...stats.handback].map(([why, n]) => `${why} ${n}`).join(', ') || 'none';
  process.stderr.write(`actor tick kernel: ${stats.calls} calls, handed back: ${handbacks}; ${stats.defer} deferred, ` +
    `${stats.callbacks} callbacks, ${stats.get} JavaScript reads, ${stats.set} writes, ${stats.statements} statements, ` +
    `${stats.animation} animation phases in JavaScript; level loop: ${stats.batched} ticked in Rust runs, runs ended by ` +
    `${[...stats.batchStops].map(([why, n]) => `${why} ${n}`).join(', ') || 'none'}` +
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
  if (name === 'AlliancesEx' && Array.isArray(value)) return value.map(item => ({...item}));
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
    this.timeSeconds = 0; this.tickTag = 0; this.seconds = 0; this.tickType = 0; this.flags = 0;
    // pawn-physics-kernel.mjs: the walk contexts' depth while they are pushed.
    this.pawnDepth = undefined;
    this.fallDepth = undefined;
    // A level loop batch's context (`batch`): the actor is the one Rust ticks now (LEVEL_IO's handle), bound when an import asks.
    this.batch = false;
    this.handle = 0;
  }
  clear() {
    this.receiver = null; this.instance = null; this.services = null; this.level = null;
    this.view = null; this.notify = null; this.log = null;
    this.batch = false; this.handle = 0;
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
    this.spExpected = null;
    this.registryVersion = -1;
    // Advances whenever the table gains an entry.
    this.version = 0;
    this.classes = new WeakMap();
    this.snapshotNames = new WeakMap();
    // The ticks in progress (nested ticks run inside callbacks), by depth;
    // an import's `ctx` indexes it.
    this.contexts = [];
    this.depth = 0;
    // The level loop's copy of Level.Actors with a descriptor per slot (level_loop.rs), kept per array, length and actorsEpoch,
    // and the interned descriptor rows.
    this.mirror = new HandleMirror();
    this.listKey = null; this.listAt = 0; this.descAt = 0; this.listBytes = 0; this.descBytes = 0;
    this.rowIds = new Map(); this.rowsAt = 0; this.rowCapacity = 0;
  }
  attach(x) {
    this.x = x;
    // No Rust frame is active yet: the shadow stack's top.
    this.stackTop = x.__stack_pointer.value;
    this.fieldsAt = x.tick_fields_ptr();
    this.stateAt = x.tick_state_ptr();
    this.zonesAt = typeof x.tick_zones_ptr === 'function' ? x.tick_zones_ptr() : 0;
    this.f64At = x.tick_f64_ptr();
    this.spAt = x.tick_sp_ptr();
    this.spAllianceAt = x.tick_sp_alliance_ptr();
    // tick_record's arguments (tick.rs TickArgs): seconds and time at +0 and +8, then the words ctx, handle, base, mask lo, mask hi,
    // flags, tick type, tick tag and events from +16.
    this.argsAt = x.tick_args_ptr();
    // The level loop's LEVEL_IO: seconds and time at +0 and +8, the L_* words from +16, the deferred slots after them.
    this.levelAt = typeof x.level_io_ptr === 'function' ? x.level_io_ptr() : 0;
    this.levelWords = this.levelAt + 16;
    // SCRIPT_VM_IMPORT_TIME=1 SCRIPT_VM_IMPORT_CLASS=1 (script-vm-rust.mjs timedImports): each import's time also by the class of the actor
    // the level loop is ticking, as `<class key> <import>` rows beside the import's own (measurement only).
    if (env.SCRIPT_VM_IMPORT_CLASS === '1') globalThis.__curActorKey = () => { try { const h = this.vm.arena.view.getUint32(this.levelWords + 4 * L_HANDLE, true); const r = identityOfHandle(h); return r ? this.runtime.instance(r).cls.record.key : '(none)'; } catch { return '(err)'; } };
    this.levelDeferred = this.levelWords + 4 * L_WORDS;
    this.vm.arena.view.setUint32(x.tick_empty_name_ptr(), nameCellWord(''), true);
    // The probe index of each js_tick_probing name, for tick.rs `probing`.
    const probes = x.tick_probe_names_ptr();
    PROBES.forEach((name, i) => this.vm.arena.view.setUint32(probes + 4 * i, (probeNames.get(name.toLowerCase()) ?? -1) >>> 0, true));
    this.enabled = !DISABLED;
  }
  /** The level's zone render times for tick.rs zone_render_time (TICK_READS): copied into the Rust table before a run or batch of ticks
   * (nothing writes them during a tick: the render feedback and the level reset do, between ticks). Only the level that
   * script-doors.mjs built (its zoneLastRenderTime is marked `direct`) can be read there; a stub level keeps the import. */
  syncZones(level) {
    if (!this.zonesAt) return;
    const times = level.zoneLastRenderTime?.direct === true ? level.zoneLastRenderTimes : null;
    const mode = tickReadsMode(), arena = this.vm.arena;
    if (!(times instanceof Float32Array) || mode === 'js' || DIFFERENTIAL) { arena.view.setUint32(this.zonesAt, 0, true); return; }
    const count = Math.min(times.length, 256), memory = arena.memory.buffer;
    if (this.zoneWords?.buffer !== memory) this.zoneWords = new Float32Array(memory, this.zonesAt + 8, 256);
    this.zoneWords.set(count === times.length ? times : times.subarray(0, count));
    arena.view.setUint32(this.zonesAt, mode === 'verify' ? 2 : 1, true);
    arena.view.setUint32(this.zonesAt + 4, count, true);
  }
  /** Fill the table's missing entries from the registry. An entry, once
   * written, never changes (the registry keeps a key's cell or drops it). */
  table() {
    if (this.registryVersion !== fieldImageCellVersion()) this.fillTable();
  }
  /** table()'s slow path, a function of its own: the closures below make the function that holds them allocate a context object
   * on entry (scripts/closure-context-scan.mjs), and table() runs for every actor of every tick. */
  fillTable() {
    const version = fieldImageCellVersion();
    this.registryVersion = version;
    const expected = this.expected ??= TICK_FIELDS.map(() => null);
    let added = this.spTable();
    if (!expected.includes(null)) { if (added) this.version++; return; }
    const view = this.vm.arena.view;
    TICK_FIELDS.forEach(([, key, kind, element], i) => {
      if (expected[i]) return;
      let cell = fieldImageCell(key);
      if (cellKind(cell) !== kind) cell = null;
      if (cell && kind === 'fixed' && (cell.dim !== 4 || cellKind(cell.element) !== element || cell.element.offset !== 0))
        cell = null;
      // The Region's zone number: a byte member of the struct, addressed from the actor's base.
      let zone = null;
      if (cell && kind === 'struct') {
        zone = cell.members.find(member => member.key === ZONE_NUMBER);
        if (cellKind(zone) !== 'byte') cell = null;
      }
      if (!cell) return;
      expected[i] = cell;
      added = true;
      view.setUint32(this.fieldsAt + 8 * i, zone ? cell.offset + zone.offset : cell.offset, true);
      view.setUint32(this.fieldsAt + 8 * i + 4, zone ? 0 : kind === 'fixed' ? cell.stride : cell.mask >>> 0, true);
    });
    if (added) this.version++;
  }
  /** The SP table (AScriptedPawn::Tick's fields), filled like TICK_FIELDS's; whether an entry was added. */
  spTable() {
    const expected = this.spExpected ??= SP_FIELDS.map(() => null);
    if (!expected.includes(null)) return false;
    const view = this.vm.arena.view;
    let added = false;
    SP_FIELDS.forEach(([, key, kind], i) => {
      if (expected[i] || i === SP_POTENTIAL) return;
      let cell = fieldImageCell(key);
      if (cellKind(cell) !== kind) cell = null;
      if (cell && i === SP_ALLIANCES) {
        const members = cell.dim === 16 && cellKind(cell.element) === 'struct'
          ? SP_ALLIANCE_MEMBERS.map(member => cell.element.members.find(item => item.key === member)) : [];
        if (members.length !== 3 || cellKind(members[0]) !== 'name' || cellKind(members[1]) !== 'float' || cellKind(members[2]) !== 'bool') cell = null;
        else {
          view.setUint32(this.spAllianceAt, members[0].offset, true);
          view.setUint32(this.spAllianceAt + 4, members[1].offset, true);
          view.setUint32(this.spAllianceAt + 8, members[2].offset, true);
          view.setUint32(this.spAllianceAt + 12, members[2].mask >>> 0, true);
        }
      }
      if (!cell) return;
      expected[i] = cell;
      added = true;
      view.setUint32(this.spAt + 8 * i, cell.offset, true);
      view.setUint32(this.spAt + 8 * i + 4, kind === 'fixed' ? cell.stride : cell.mask >>> 0, true);
    });
    return added;
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
    let scripted = false;
    for (let c = cls; c; c = c.base) {
      const key = c.record?.key;
      if (key === 'engine.pawn') flags |= C_PAWN;
      else if (key === 'engine.playerpawn') flags |= C_PLAYERPAWN;
      else if (key === 'engine.weapon') flags |= C_WEAPON;
      else if (key === 'deusex.scriptedpawn') scripted = true;
    }
    // A ScriptedPawn runs AScriptedPawn::Tick in Rust when its class gives the SP table's every field the table's cell.
    let splo = 0, sphi = 0, spFull = scripted && Boolean(cells);
    if (scripted && cells) SP_FIELDS.forEach(([name, key], i) => {
      if (i === SP_POTENTIAL) return;
      let field;
      try { field = runtime.lookupMember(cls, 'fields', name); } catch { spFull = false; return; }
      if (field?.key !== key) { spFull = false; return; }
      const cached = names.get(name);
      const cell = cached === undefined ? cells.get(key) : cached?.field === field ? cached.cell : null;
      if (!this.spExpected?.[i] || !sameCell(cell, this.spExpected[i])) { spFull = false; return; }
      if (i < 32) splo |= 1 << i; else sphi |= 1 << (i - 32);
    });
    info = {version: this.version, names: names.size, lo: lo >>> 0, hi: hi >>> 0, flags: flags | (spFull ? C_SCRIPTEDPAWN : 0), scripted,
      splo: splo >>> 0, sphi: sphi >>> 0};
    this.classes.set(cls, info);
    return info;
  }
  /** An instance's mask (its class's bits without the fields it binds),
   * class flags and handle. The cache is keyed by the bindings' count:
   * bindings are only ever added (bindProperty), so an unchanged count is
   * an unchanged key set. */
  describe(instance, receiver) {
    const d = instance.tickDesc;
    if (d !== undefined && d.version === this.version && d.bindings === instance.bindings.size &&
      d.names === instance.fieldTable.size) return d;
    return this.describeNew(instance, receiver);
  }
  /** describe()'s slow path (see fillTable). */
  describeNew(instance, receiver) {
    const names = instance.fieldTable;
    const info = this.classInfo(instance.cls, instance.cells, names);
    let lo = info.lo, hi = info.hi, flags = info.flags, splo = info.splo, sphi = info.sphi;
    if (instance.bindings.size) {
      TICK_FIELDS.forEach(([, key], i) => {
        if (!instance.bindings.has(key)) return;
        if (i < 32) lo &= ~(1 << i); else hi &= ~(1 << (i - 32));
      });
      // A bound SP field is read and written through the binding (js_tick_get / js_tick_set), not in the image.
      SP_FIELDS.forEach(([, key], i) => {
        if (!instance.bindings.has(key)) return;
        if (i < 32) splo &= ~(1 << i); else sphi &= ~(1 << (i - 32));
      });
    }
    // `words`: the masks as a typed array, which the per-tick stores into the image read without making a heap number of each
    // (a mask above the small-integer range read from an object field is one in the tiers below TurboFan): lo, hi, splo, sphi.
    return instance.tickDesc = {version: this.version, bindings: instance.bindings.size, names: names.size,
      lo: lo >>> 0, hi: hi >>> 0, flags, scripted: info.scripted, splo: splo >>> 0, sphi: sphi >>> 0, handle: handleOf(receiver),
      words: Uint32Array.of(lo, hi, splo, sphi)};
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
    if (this.depth === 0) this.syncZones(level);
    const d = this.describe(instance, receiver);
    if (d.flags & C_PLAYERPAWN) return this.handback('PlayerPawn');
    // A ScriptedPawn whose fields are not all in its image runs AScriptedPawn::Tick in JavaScript (processActorTick).
    if (d.scripted && (!(d.flags & C_SCRIPTEDPAWN) || d.splo !== SP_FULL_LO || d.sphi !== SP_FULL_HI)) return this.handback('scripted pawn fields');
    const view = this.vm.arena.view, words = d.words;
    view.setUint32(this.stateAt + 20, words[2], true);
    view.setUint32(this.stateAt + 24, words[3], true);
    const ctx = this.depth, c = this.contexts[ctx] ??= new TickContext();
    c.receiver = receiver; c.instance = instance; c.services = services; c.level = level;
    c.view = null; c.notify = null; c.log = DIFFERENTIAL ? [] : null;
    c.timeSeconds = level.timeSeconds; c.tickTag = level.tickTag; c.seconds = seconds; c.tickType = tickType; c.flags = d.flags;
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
      // The arguments go through memory (tick.rs `tick_record`): as call arguments, the doubles and the masks would be heap numbers.
      const at = this.argsAt;
      view.setFloat64(at, seconds, true);
      view.setFloat64(at + 8, level.timeSeconds, true);
      view.setUint32(at + 16, ctx, true);
      view.setUint32(at + 20, d.handle, true);
      view.setUint32(at + 24, instance.base, true);
      view.setUint32(at + 28, words[0], true);
      view.setUint32(at + 32, words[1], true);
      view.setUint32(at + 36, d.flags, true);
      view.setUint32(at + 40, tickType, true);
      view.setUint32(at + 44, level.tickTag, true);
      view.setUint32(at + 48, events, true);
      result = x.tick_record();
    } catch (error) {
      // An import that throws unwinds past the Rust frames: the shadow
      // stack, then the frame stack, hang budget and events word as the
      // tick found them (tick_unwind).
      x.__stack_pointer.value = pointer;
      x.tick_unwind(ctx);
      // The walk contexts of a pawn's performPhysics in Rust.
      this.vm.pawnPhysics?.end(c);
      this.vm.actorPhysics?.end(c);
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
  /** The level loop's run of `actors` from `start` (level-tick.mjs tickStandaloneLevel), each actor `run` would tick in Rust ticked
   * by level_loop.rs with no JavaScript: true with `out` = {next, progress, stop} (the actors before `next` ticked, their deferred
   * nodes linked as `run` links them), or false when the loop cannot run here and every actor takes `run`. `out.current` names
   * the slot whose tick threw. */
  batch(actors, start, seconds, entry, out) {
    if (!this.levelAt || DIFFERENTIAL || this.depth !== 0 || levelLoopMode() === 'js') return false;
    const services = entry.services, level = services.level, tickType = entry.tickType;
    // `run`'s gates on the level, the same for every actor of the run.
    if (typeof seconds !== 'number' || (tickType !== 0 && tickType !== 1 && tickType !== 2) || !level ||
      level.netMode !== 0 || level.demoRecDriver !== null || (level.tickTag !== 0 && level.tickTag !== 1) ||
      typeof level.timeSeconds !== 'number') return false;
    this.table();
    this.syncZones(level);
    this.listFor(actors);
    const view = this.vm.arena.view, at = this.levelWords, x = this.x;
    view.setFloat64(this.levelAt, seconds, true);
    view.setFloat64(this.levelAt + 8, level.timeSeconds, true);
    view.setUint32(at + 4 * L_LIST, this.listAt, true);
    view.setUint32(at + 4 * L_DESC, this.descAt, true);
    view.setUint32(at + 4 * L_START, start, true);
    view.setUint32(at + 4 * L_ROWS, this.rowsAt, true);
    view.setUint32(at + 4 * L_VERSION, this.version, true);
    view.setUint32(at + 4 * L_TICK_TYPE, tickType, true);
    view.setUint32(at + 4 * L_TICK_TAG, level.tickTag, true);
    view.setUint32(at + 4 * L_EVENTS, this.vm.events.allowed(services), true);
    view.setUint32(at + 4 * L_ACTORS_EPOCH, actorsEpoch(), true);
    view.setUint32(at + 4 * L_VERIFY, levelLoopMode() === 'verify' ? 1 : 0, true);
    const c = this.contexts[0] ??= new TickContext();
    c.receiver = null; c.instance = null; c.services = services; c.level = level; c.view = null; c.notify = null; c.log = null;
    c.timeSeconds = level.timeSeconds; c.tickTag = level.tickTag; c.seconds = seconds; c.tickType = tickType; c.flags = 0;
    c.batch = true; c.handle = 0;
    // As `run`: the shadow stack pointer to restore if an import throws through the Rust frames.
    const pointer = this.vm.depth === 0 ? this.stackTop : x.__stack_pointer.value;
    this.depth = 1;
    batching = this;
    let stop;
    try {
      stop = x.level_tick_batch();
    } catch (error) {
      x.__stack_pointer.value = pointer;
      // as `run` unwinds its tick, when one was in flight (a descriptor's host call throws before it); the run's actors may have
      // grown the arena, whose new buffer `view` does not see: its current view
      const arena = this.vm.arena;
      if (arena.view.getUint32(at + 4 * L_HANDLE, true) !== 0) {
        x.tick_unwind(0);
        arena.view.setUint32(at + 4 * L_HANDLE, 0, true);
      }
      this.vm.pawnPhysics?.end(c);
      this.vm.actorPhysics?.end(c);
      out.current = arena.view.getUint32(at + 4 * L_CURRENT, true);
      c.clear();
      throw error;
    } finally {
      this.depth = 0;
      batching = null;
    }
    c.clear();
    // The run's actors may have grown the arena (a new buffer, `view` detached): read through its current view from here, and again
    // after each deferred node's allocation.
    const arena = this.vm.arena;
    // `run`'s DEFER tail for each deferred slot, in the run's order.
    const deferred = arena.view.getUint32(at + 4 * L_DEFERRED, true);
    for (let k = 0; k < deferred; k++) {
      const slot = arena.view.getUint32(this.levelDeferred + 4 * k, true);
      const receiver = identityOfHandle(arena.view.getUint32(this.listAt + 4 + 4 * slot, true));
      const node = services.allocateDeferredActor();
      if (node !== null && typeof node !== 'object') throw new Error('Original deferred-actor allocation result is not provided');
      if (node) { node.actor = receiver; node.next = level.deferredHead; }
      level.deferredHead = node;
    }
    if (STATS) {
      const ticked = arena.view.getUint32(at + 4 * L_TICKED, true), why = BATCH_STOPS[stop] ?? stop;
      stats.calls += ticked; stats.defer += deferred; stats.batched += ticked;
      stats.batchStops.set(why, (stats.batchStops.get(why) ?? 0) + 1);
    }
    out.next = arena.view.getUint32(at + 4 * L_NEXT, true);
    out.progress = arena.view.getInt32(at + 4 * L_PROGRESS, true);
    out.stop = stop;
    return true;
  }
  /** The level loop's `[count, handle...]` copy of `actors` and its slots' descriptors, rebuilt when the array, its length or
   * actorsEpoch changes (every structural change of a Level.Actors array advances it); a slot keeps the descriptor its actor had
   * (level_loop.rs `level_desc_carry`). */
  listFor(actors) {
    const count = actors.length, epoch = actorsEpoch(), key = this.listKey;
    if (key && key.actors === actors && key.count === count && key.epoch === epoch) return;
    const arena = this.vm.arena, listBytes = 4 + 4 * count, descBytes = 16 * count;
    const listAt = arena.alloc(listBytes), descAt = arena.alloc(descBytes), view = arena.view;
    view.setUint32(listAt, count, true);
    this.mirror.sync(actors);
    new Uint32Array(arena.memory.buffer, listAt + 4, count).set(this.mirror.handles.subarray(0, count));
    this.x.level_desc_carry(this.listAt, this.descAt, listAt, descAt);
    if (this.listAt) { arena.release(this.listAt, this.listBytes); arena.release(this.descAt, this.descBytes); }
    this.listAt = listAt; this.descAt = descAt; this.listBytes = listBytes; this.descBytes = descBytes;
    this.listKey = {actors, count, epoch};
  }
  /** js_tick_describe: slot `index`'s descriptor, [receiver epoch, table version, image base, row], from what `run` checks and
   * `describe` returns for the actor; JS_TICK for one `run` hands back before its tick (no image, the PlayerPawn, a ScriptedPawn
   * with SP fields outside its image). Under LEVEL_LOOP=verify a current descriptor must be the one written now. */
  describeSlot(index, handle) {
    const identity = identityOfHandle(handle), runtime = this.runtime;
    const instance = identity === null || typeof identity !== 'object' ? undefined : identity[runtime.instanceKey] ?? runtime.instances.get(identity);
    let base = 0, row;
    if (instance === undefined || this.host(instance)) row = this.row(0, 0, 0, 0, JS_TICK);
    else {
      const d = this.describe(instance, identity), w = d.words;
      const js = d.flags & C_PLAYERPAWN || d.scripted && (!(d.flags & C_SCRIPTEDPAWN) || d.splo !== SP_FULL_LO || d.sphi !== SP_FULL_HI);
      base = instance.base;
      row = this.row(w[0], w[1], w[2], w[3], (d.flags | (js ? JS_TICK : 0)) >>> 0);
    }
    const view = this.vm.arena.view, at = this.descAt + 16 * index, epoch = receiverEpoch() >>> 0;
    if (view.getUint32(at, true) === epoch && view.getUint32(at + 4, true) === this.version &&
      (view.getUint32(at + 8, true) !== base || view.getUint32(at + 12, true) !== row))
      throw new Error(`Level loop: the descriptor of ${identity?.name ?? handle} is stale (base ${view.getUint32(at + 8, true)}, row ` +
        `${view.getUint32(at + 12, true)}; now ${base}, ${row})`);
    view.setUint32(at, epoch, true);
    view.setUint32(at + 4, this.version, true);
    view.setUint32(at + 8, base, true);
    view.setUint32(at + 12, row, true);
  }
  /** The row index of `[lo, hi, splo, sphi, flags]` (level_loop.rs), entered once. */
  row(lo, hi, splo, sphi, flags) {
    const key = `${lo},${hi},${splo},${sphi},${flags}`;
    let row = this.rowIds.get(key);
    if (row !== undefined) return row;
    row = this.rowIds.size;
    const arena = this.vm.arena;
    if (row >= this.rowCapacity) {
      const capacity = Math.max(64, this.rowCapacity * 2), base = arena.alloc(4 * ROW_WORDS * capacity);
      if (this.rowsAt) {
        arena.bytes.copyWithin(base, this.rowsAt, this.rowsAt + 4 * ROW_WORDS * this.rowCapacity);
        arena.release(this.rowsAt, 4 * ROW_WORDS * this.rowCapacity);
      }
      this.rowsAt = base; this.rowCapacity = capacity;
      // a batch in progress reads the rows from LEVEL_IO
      arena.view.setUint32(this.levelWords + 4 * L_ROWS, base, true);
    }
    const view = arena.view, at = this.rowsAt + 4 * ROW_WORDS * row;
    view.setUint32(at, lo, true); view.setUint32(at + 4, hi, true); view.setUint32(at + 8, splo, true); view.setUint32(at + 12, sphi, true);
    view.setUint32(at + 16, flags, true);
    this.rowIds.set(key, row);
    return row;
  }
  /** Tick context `i`, as an import of the tick (or of the physics it calls) takes it. */
  contextAt(i) {
    const c = this.contexts[i];
    if (c.batch) this.bind(c);
    return c;
  }
  /** A batch context's actor: the one level_loop.rs ticks now, bound when one of its imports runs. */
  bind(c) {
    const handle = this.vm.arena.view.getUint32(this.levelWords + 4 * L_HANDLE, true);
    if (c.handle === handle) return;
    const receiver = identityOfHandle(handle), runtime = this.runtime;
    c.handle = handle; c.receiver = receiver;
    c.instance = receiver[runtime.instanceKey] ?? runtime.instances.get(receiver);
    c.flags = this.vm.arena.view.getUint32(this.levelWords + 4 * L_FLAGS, true) & ~JS_TICK;
    c.view = null; c.notify = null;
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
      const words = d.words;
      view.setUint32(at + 4, words[0], true);
      view.setUint32(at + 8, words[1], true);
      view.setUint32(at + 20, words[2], true);
      view.setUint32(at + 24, words[3], true);
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
    else if (field >= SPB) value = c.services.read(c.receiver, SP_FIELDS[field - SPB][0]);
    else value = c.services.read(c.receiver, TICK_FIELDS[field][0]);
    // an element of a vector (the SP table's, or Velocity read for the bleeding block)
    if (element >= 0 && Array.isArray(value) && !ANIM_BLEND.has(field)) value = value[element];
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
    else if (field >= SPB) {
      const index = field - SPB, [name, , kind] = SP_FIELDS[index], s = c.services;
      if (index === SP_POTENTIAL) s.write(c.receiver, name, 'None');
      else if (kind === 'pointer') s.write(c.receiver, name, null);
      else if (element >= 0) { const whole = s.read(c.receiver, name).slice(); whole[element] = value; s.write(c.receiver, name, whole); }
      else s.write(c.receiver, name, kind === 'bool' ? value !== 0 : value);
    } else c.services.write(c.receiver, TICK_FIELDS[field][0], BOOL_FIELDS.has(field) ? value !== 0 : value);
  }
  f64(index, value) {
    this.vm.arena.view.setFloat64(this.f64At + 8 * index, value, true);
  }
  imports() {
    const host = this, context = i => host.contextAt(i);
    return {
      js_tick_describe: (index, handle) => host.describeSlot(index, handle),
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
        host.vm.events.readsTable();
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
        const c = context(i), [name, withDelta, fixed] = EVENTS[which], args = fixed ? fixed.slice() : withDelta ? [delta] : [];
        if (which >= SP_EVENT) {
          // FindFunctionChecked on the pawn, then ProcessEvent: a name the class does not declare gets the original's no-op
          const record = host.runtime.lookup(c.receiver, name)?.function ?? null;
          c.log?.push({kind: 'lookup', name, record});
          if (!record) { host.refresh(c); return; }
        }
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
        if (code === 3) throw new Error('Original zone render timestamp is not provided');
        if (code === 5) throw new Error(`TICK_READS=verify: the zone render time of ${context(i).receiver?.name} in Rust differs from level.zoneLastRenderTime`);
        if (code === 4) throw new Error(`Actor tick kernel: ${context(i).receiver?.name} left its image during AScriptedPawn::Tick`);
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
    if (c.flags & C_SCRIPTEDPAWN) {
      const pawn = {
        read: services.read, write: services.write, level, processEvent: services.processEvent, destroyActor: services.destroyActor,
        // the lookup Rust logged for the event
        findFunction: (a, name) => {
          self(a);
          const entry = replay.next('lookup');
          if (entry.name !== name) replay.fail(`FindFunctionChecked ${name} in JavaScript, ${entry.name} in Rust`);
          return entry.record;
        },
        inStasis: a => actorInStasis(a, services),
      };
      if (!scriptedPawnTick(actor, c.seconds, c.tickType, pawn)) return 1;
    }
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
