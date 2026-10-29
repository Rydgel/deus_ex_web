/**
 * The host half of the Rust perception natives (docs/rust-core.md R3-c,
 * native/script-vm/src/percep.rs): IsValidEnemy (2105), GetPawnAllianceType
 * (2107) and AICanSee (705) run in the interpreter, reading the actors'
 * images. This module owns what Rust cannot know by itself:
 *
 * - the field table (P_FIELDS): each field's offset, bool mask and key id,
 *   from the cell registry, checked against the kind the Rust body reads;
 * - each class row's field word: which fields `readNamed` resolves, for
 *   that class, to the key and cell the table describes;
 * - the imports: the reads, writes and queries that stay JavaScript (they
 *   call the same services the JavaScript bodies call), the hand-backs,
 *   which run the JavaScript body on the evaluated arguments, and
 *   PERCEPTION_DIFFERENTIAL's comparison.
 */
import {fieldImageCell, fieldImageCellVersion, cellKind, sameCell} from './script-object-image.mjs';
import {fieldKeyId} from './script-vm-lower.mjs';
import {foldedNameId, nameSpelling} from './script-name-ids.mjs';
import {handleOf, identityOfHandle} from './script-object-handles.mjs';
import {execPawnAlliance} from './script-pawn-alliance.mjs';
import {execAICanSee} from './script-pawn-perception.mjs';
import {actorsEpoch} from './base-epoch.mjs';

/** The fields the Rust bodies read (percep.rs F_*), in index order:
 * [the spelling the JavaScript bodies read, key, cell kind]. */
export const PERCEPTION_FIELDS = Object.freeze([
  ['bDeleteMe', 'engine.actor.bdeleteme', 'bool'],
  ['bDetectable', 'engine.actor.bdetectable', 'bool'],
  ['Health', 'engine.pawn.health', 'int'],
  ['Alliance', 'engine.pawn.alliance', 'name'],
  ['AlliancesEx', 'deusex.scriptedpawn.alliancesex', 'fixed'],
  ['bLikesNeutral', 'deusex.scriptedpawn.blikesneutral', 'bool'],
  ['bReverseAlliances', 'deusex.scriptedpawn.breversealliances', 'bool'],
  ['Location', 'engine.actor.location', 'vector'],
  ['CollisionRadius', 'engine.actor.collisionradius', 'float'],
  ['CollisionHeight', 'engine.actor.collisionheight', 'float'],
  ['VisUpdateTime', 'engine.actor.visupdatetime', 'float'],
  ['CurrentVisibility', 'engine.actor.currentvisibility', 'float'],
  ['LastVisibility', 'engine.actor.lastvisibility', 'float'],
  ['Velocity', 'engine.actor.velocity', 'vector'],
  ['bUnlit', 'engine.actor.bunlit', 'bool'],
  ['BaseEyeHeight', 'engine.pawn.baseeyeheight', 'float'],
  ['MinAngularSize', 'engine.pawn.minangularsize', 'float'],
  ['AspectRatio', 'engine.pawn.aspectratio', 'float'],
  ['AIHorizontalFOV', 'engine.pawn.aihorizontalfov', 'float'],
  ['Rotation', 'engine.actor.rotation', 'rotator'],
  ['ViewRotation', 'engine.pawn.viewrotation', 'rotator'],
  ['AIAddViewRotation', 'engine.pawn.aiaddviewrotation', 'rotator'],
  ['VisibilityThreshold', 'engine.pawn.visibilitythreshold', 'float'],
  ['LightType', 'engine.actor.lighttype', 'byte'],
  ['LightBrightness', 'engine.actor.lightbrightness', 'byte'],
  ['LightRadius', 'engine.actor.lightradius', 'byte'],
  ['LightSaturation', 'engine.actor.lightsaturation', 'byte'],
  ['bStatic', 'engine.actor.bstatic', 'bool'],
  ['TimeSeconds', 'engine.levelinfo.timeseconds', 'float'],
  ['AmbientBrightness', 'engine.zoneinfo.ambientbrightness', 'byte'],
  ['AmbientSaturation', 'engine.zoneinfo.ambientsaturation', 'byte'],
]);
const F_ALLIANCES = 4;
// The AlliancesEx element's members (script-pawn-alliance.mjs).
const ALLIANCE_MEMBERS = ['deusex.scriptedpawn.allianceinfoex.alliancename',
  'deusex.scriptedpawn.allianceinfoex.alliancelevel', 'deusex.scriptedpawn.allianceinfoex.agitationlevel'];
// The fields each native's body reads.
const NATIVE_FIELDS = new Map([
  [2105, [0, 1, 2, 3, 4, 5, 6]],
  [2107, [3, 4, 5, 6]],
  [705, [1, ...Array.from({length: 24}, (_, i) => 7 + i)]],
]);
// Argument kinds per native (percep.rs P_ARGS).
const ARGUMENTS = new Map([[2105, ['object', 'bool']], [2107, ['object']],
  [705, ['object', 'float', 'bool', 'bool', 'bool', 'bool']]]);
// A class row's flag word: a ScriptedPawn (by record key, as the alliance
// isA compares), and computed.
const H_SCRIPTED_PAWN = 1, H_VALID = 0x80000000;
// js_pread sites: script-pawn-perception.mjs `rd`, script-ai-visibility.mjs `read`.
const SITE_PERCEP = 1, SITE_AIVIS = 2;
const UNDEFINED = 0xffffffff, UNDEF_LO = 1, UNDEF_HI = 0x7ff80000;
// AIVisibility's cache fields, which AICanSee writes.
const CACHE_FIELDS = ['VisUpdateTime', 'CurrentVisibility', 'LastVisibility'];

const DIFFERENTIAL = typeof process !== 'undefined' && process.env?.PERCEPTION_DIFFERENTIAL === '1';
const differential = {alliance: 0, aiCanSee: 0, traces: 0, writes: 0, scans: 0, reused: 0};
if (DIFFERENTIAL) process.on('exit', () => {
  process.stderr.write(`perception differential: ${differential.alliance} alliance and ${differential.aiCanSee} AICanSee ` +
    `calls, ${differential.traces} traces and ${differential.writes} cache fields compared; ${differential.scans} ` +
    `Level.Actors scans, ${differential.reused} reused lists equal to a fresh build\n`);
});

const f64io = new DataView(new ArrayBuffer(8));
/** Same float64 bits, any NaN matching any NaN (script-vm-rust.mjs sameBits). */
function sameNumber(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return Object.is(a, b);
  if (a !== a || b !== b) return a !== a && b !== b;
  f64io.setFloat64(0, a, true);
  const lo = f64io.getUint32(0, true), hi = f64io.getUint32(4, true);
  f64io.setFloat64(0, b, true);
  return lo === f64io.getUint32(0, true) && hi === f64io.getUint32(4, true);
}

export class PerceptionHost {
  constructor(vm) {
    this.vm = vm;
    this.runtime = vm.runtime;
    // Per field: the registry cell the table describes, or null.
    this.expected = null;
    this.tableVersion = -1;
    this.readyFor = new Map();
    this.services = null;
    this.alliance = null;
    this.bits = new WeakMap();
    this.scan = 0;
    this.scanCapacity = 0;
    // The Level.Actors list last built: its array, length and base epoch.
    this.scanKey = null;
    this.pending = null;
    this.recording = null;
  }
  attach(exports) {
    this.fieldsAt = exports.percep_fields_ptr();
    this.allianceAt = exports.percep_alliance_ptr();
    this.namesAt = exports.percep_names_ptr();
    this.argsAt = exports.percep_args_ptr();
    this.ioAt = exports.percep_io_ptr();
    if (DIFFERENTIAL) this.vm.arena.view.setUint32(exports.percep_check_ptr(), 1, true);
  }
  /** Whether native `index` can run in Rust: its fields are all in the
   * registry with the kinds the Rust body reads. A field's table entry is
   * written once, the first time a lowering asks while the registry has its
   * cell; later entries (a class linked later) extend the table, and the
   * class rows' field words are computed again. */
  ready(index) {
    if (this.readyFor.get(index)) return true;
    const version = fieldImageCellVersion();
    if (!this.expected || (this.tableVersion !== version && this.expected.includes(null))) {
      const added = this.buildTable();
      this.tableVersion = version;
      if (added) {
        this.bits = new WeakMap();
        const view = this.vm.arena.view;
        for (const {address} of this.vm.rows.values()) {
          const at = address + 8 + 8 * view.getUint32(address + 4, true);
          view.setUint32(at, 0, true);
          view.setUint32(at + 4, 0, true);
        }
      }
    }
    const ready = NATIVE_FIELDS.get(index)?.every(field => this.expected[field] !== null) ?? false;
    this.readyFor.set(index, ready);
    return ready;
  }
  /** Fill the table's missing entries from the registry; whether any was. */
  buildTable() {
    const view = this.vm.arena.view, expected = this.expected ??= PERCEPTION_FIELDS.map(() => null);
    let added = false;
    PERCEPTION_FIELDS.forEach(([, key, kind], index) => {
      if (expected[index]) return;
      let cell = fieldImageCell(key);
      if (cellKind(cell) !== kind) cell = null;
      if (cell && index === F_ALLIANCES) {
        const members = cell.dim === 16 && cellKind(cell.element) === 'struct'
          ? ALLIANCE_MEMBERS.map(member => cell.element.members.find(item => item.key === member)) : [];
        if (members.length !== 3 || cellKind(members[0]) !== 'name' || cellKind(members[1]) !== 'float' ||
          cellKind(members[2]) !== 'float') cell = null;
        else {
          const at = this.allianceAt;
          view.setUint32(at, cell.stride, true);
          members.forEach((member, i) => view.setUint32(at + 4 + 4 * i, member.offset, true));
        }
      }
      if (!cell) return;
      expected[index] = cell;
      added = true;
      const at = this.fieldsAt + 12 * index;
      view.setUint32(at, cell.offset, true);
      view.setUint32(at + 4, cell.mask >>> 0, true);
      view.setUint32(at + 8, fieldKeyId(key), true);
    });
    view.setUint32(this.namesAt, foldedNameId('playerpawn'), true);
    view.setUint32(this.namesAt + 4, foldedNameId('levelinfo'), true);
    view.setUint32(this.namesAt + 8, foldedNameId('pawn'), true);
    view.setUint32(this.namesAt + 12, foldedNameId('inventory'), true);
    return added;
  }
  /** The field word and flags of a class (percep.rs): field i is set when
   * `readNamed` on an instance of `cls` resolves the spelling to the key and
   * reads a cell the table describes. */
  classBits(cls, cells) {
    let bits = this.bits.get(cls);
    if (bits) return bits;
    let fields = 0, flags = H_VALID;
    const expected = this.expected ?? [];
    PERCEPTION_FIELDS.forEach(([name, key], index) => {
      if (!expected[index] || !cells) return;
      let field;
      try { field = this.runtime.lookupMember(cls, 'fields', name); } catch { return; }
      if (field?.key === key && sameCell(cells.get(key), expected[index])) fields |= 1 << index;
    });
    for (let c = cls; c; c = c.base) if (c.record?.key === 'deusex.scriptedpawn') { flags |= H_SCRIPTED_PAWN; break; }
    bits = [fields >>> 0, flags >>> 0];
    this.bits.set(cls, bits);
    return bits;
  }
  /** js_class_fields: the words after the row's names (no script runs). */
  classFields(handle) {
    const vm = this.vm, address = vm.classRow(handle);
    if (!address) return;
    const identity = identityOfHandle(handle), runtime = this.runtime;
    const instance = identity[runtime.instanceKey] ?? runtime.instances.get(identity);
    const [fields, flags] = this.classBits(instance.cls, instance.cells);
    const view = vm.arena.view, at = address + 8 + 8 * view.getUint32(address + 4, true);
    view.setUint32(at, fields, true);
    view.setUint32(at + 4, flags, true);
  }
  /** The services the JavaScript bodies get from invokeNative. */
  perceptionServices() {
    return this.services ??= this.runtime.perceptionServices({receiver: null});
  }
  allianceServices() {
    return this.alliance ??= this.runtime.allianceServices();
  }
  /** P_ARGS as the values `evaluateArgument` returned. */
  args(run, index) {
    const view = this.vm.arena.view, at = this.argsAt, kinds = ARGUMENTS.get(index);
    const argc = view.getFloat64(at, true), nothing = view.getFloat64(at + 8, true), values = [];
    for (let i = 0; i < argc; i++) {
      const slot = at + 16 + 8 * i, value = view.getFloat64(slot, true);
      if (nothing & (1 << i)) values.push(undefined);
      else if (kinds[i] === 'object') values.push(value === UNDEFINED ? undefined : value === 0 ? null
        : value === run.selfHandle ? run.self : identityOfHandle(value));
      else if (kinds[i] === 'float') values.push(view.getUint32(slot, true) === UNDEF_LO &&
        view.getUint32(slot + 4, true) === UNDEF_HI ? undefined : value);
      else values.push(value !== 0);
    }
    return {argc, values};
  }
  call(run, node, receiver) {
    const n = run.nodes[node], {argc, values} = this.args(run, n.index);
    return {index: n.index, receiver: this.receiver(run, receiver), argumentCount: argc, resultDiscarded: false,
      evaluateArgument: i => values[i]};
  }
  receiver(run, handle) {
    return handle === run.selfHandle ? run.self : this.vm.identity(handle);
  }
  /** js_level_actors: Level.Actors of the actor's level as (handle,
   * receiver info) pairs, 0 for an empty slot.
   *
   * The list is kept while the array, its length and the actors epoch
   * (base-epoch.mjs) are unchanged. That epoch advances on every structural
   * change of a Level.Actors array (SpawnActor's append and DestroyActor's
   * removal included) and on every storage event that changes a receiver
   * info from readable to HOST or BOUND: poisoning, bulk restores, releases
   * (the collection's freeObject), and host bindings (bindProperty). A change the other way (a poison cleared, an object
   * attached later) leaves a stale HOST entry, whose fields Rust then reads
   * through JavaScript: slower, never different. PERCEPTION_DIFFERENTIAL
   * compares every reused list with a fresh build. */
  levelActors(run, handle) {
    const services = this.perceptionServices(), actor = this.receiver(run, handle);
    const actors = services.levelActors(services.level(actor)), count = actors.length, epoch = actorsEpoch();
    const key = this.scanKey;
    if (key && key.actors === actors && key.count === count && key.epoch === epoch) {
      if (DIFFERENTIAL) this.checkScan(actors, count);
      return this.scan;
    }
    const bytes = 4 + 8 * count;
    if (bytes > this.scanCapacity) {
      if (this.scan) this.vm.arena.release(this.scan, this.scanCapacity);
      this.scanCapacity = Math.max(4096, bytes * 2);
      this.scan = this.vm.arena.alloc(this.scanCapacity);
    }
    const view = this.vm.arena.view, base = this.scan;
    view.setUint32(base, count, true);
    for (let i = 0; i < count; i++) {
      // (scanEntry's pair, without the array)
      const light = actors[i], h = light ? handleOf(light) : 0, at = base + 4 + 8 * i;
      view.setUint32(at, h, true);
      view.setUint32(at + 4, light ? this.vm.receiverInfo(h) : 0, true);
    }
    this.scanKey = {actors, count, epoch};
    if (DIFFERENTIAL) differential.scans++;
    return base;
  }
  scanEntry(light) {
    if (!light) return [0, 0];
    const h = handleOf(light);
    return [h, this.vm.receiverInfo(h)];
  }
  /** PERCEPTION_DIFFERENTIAL: a reused list equals a fresh build, except
   * for a HOST entry that became readable (see levelActors). */
  checkScan(actors, count) {
    const view = this.vm.arena.view, base = this.scan;
    for (let i = 0; i < count; i++) {
      const [h, info] = this.scanEntry(actors[i]), at = base + 4 + 8 * i;
      const oldHandle = view.getUint32(at, true), oldInfo = view.getUint32(at + 4, true);
      if (oldHandle !== h || (oldInfo !== info && !(oldInfo & 2)))
        throw new Error(`PERCEPTION_DIFFERENTIAL: reused Level.Actors entry ${i} is ${oldHandle}/${oldInfo}, now ${h}/${info}`);
    }
    differential.reused++;
  }
  /** A read the Rust body makes in JavaScript: the body's own read service. */
  read(run, handle, field, site) {
    const name = PERCEPTION_FIELDS[field][0], value = this.perceptionServices().read(this.receiver(run, handle), name);
    if (site === SITE_AIVIS && value === undefined) throw new Error(`AI visibility requires original ${name}`);
    return value;
  }
  imports(enter, leave, count) {
    // SYNTHETIC_FRAME (percep.rs): a body called from Rust code that is no interpreted run (the AI event manager): no SELF, no node.
    const SYNTHETIC = 0xfffffff0, synthetic = {self: null, selfHandle: 0, compiled: {displayName: 'AI event manager'}};
    const host = this, vm = this.vm, frame = id => (id >>> 0 === SYNTHETIC ? synthetic : vm.run(id));
    const guarded = fn => (...args) => {
      enter();
      try { return fn(...args); } finally { leave(); }
    };
    return {
      js_class_fields: handle => host.classFields(handle),
      js_pread: guarded((id, handle, field, site) => {
        if (count) count(`perception js read ${PERCEPTION_FIELDS[field][0]}`);
        const value = host.read(frame(id), handle, field, site);
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value !== 'number') throw new Error(`Perception read of ${PERCEPTION_FIELDS[field][0]} is not a number`);
        return value;
      }),
      js_pread3: guarded((id, handle, field, site) => {
        if (count) count(`perception js read ${PERCEPTION_FIELDS[field][0]}`);
        const value = host.read(frame(id), handle, field, site), view = vm.arena.view, at = host.ioAt;
        if (!Array.isArray(value) || value.length !== 3 || !value.every(v => typeof v === 'number'))
          throw new Error(`Perception read of ${PERCEPTION_FIELDS[field][0]} is not three numbers`);
        for (let i = 0; i < 3; i++) view.setFloat64(at + 8 * i, value[i], true);
      }),
      js_pwrite: guarded((id, handle, field, value) => {
        if (count) count(`perception js write ${PERCEPTION_FIELDS[field][0]}`);
        host.perceptionServices().write(host.receiver(frame(id), handle), PERCEPTION_FIELDS[field][0], value);
      }),
      js_is_a: guarded((id, handle, name) => host.perceptionServices().isA(host.receiver(frame(id), handle), nameSpelling(name)) ? 1 : 0),
      // The JavaScript bodies on the evaluated arguments, before any effect.
      js_alliance: guarded((id, node, receiver) => {
        const run = frame(id), call = host.call(run, node, receiver);
        if (count) count(`perception handback ${call.index}`);
        return Number(execPawnAlliance(call, host.allianceServices()));
      }),
      js_aicansee: guarded((id, node, receiver) => {
        const run = frame(id), call = host.call(run, node, receiver);
        if (count) count('perception handback 705');
        host.pending = null;
        host.recording = null;
        return execAICanSee(call, host.perceptionServices());
      }),
      js_vis_info: guarded((id, handle) => {
        // actorVisibilityExtended's LevelInfo check; 0 hands the call back
        // when a host lighting seam replaces AIGetLightLevel.
        const services = host.perceptionServices(), actor = host.receiver(frame(id), handle);
        const info = services.levelInfo(services.level(actor));
        if (!info || !services.isA(info, 'LevelInfo')) throw new Error('AIVisibility requires Actors[0] to be LevelInfo');
        return typeof host.runtime.perceptionLighting === 'function' ? 0 : handleOf(info);
      }),
      js_zone: guarded((id, handle) => {
        const services = host.perceptionServices(), actor = host.receiver(frame(id), handle);
        const zone = services.zone(actor);
        services.level(actor);
        if (!zone) throw new Error('AIGetLightLevel requires the original Region.Zone');
        return handleOf(zone);
      }),
      js_level_actors: guarded((id, handle) => host.levelActors(frame(id), handle)),
      js_light_trace: guarded((id, source, px, py, pz, sx, sy, sz) => {
        const services = host.perceptionServices(), actor = host.receiver(frame(id), source);
        const point = [px, py, pz], start = [sx, sy, sz];
        const result = services.lightLineCheck(services.level(actor), actor, point, start) ? 1 : 0;
        host.recording?.push(['light', actor, ...point, ...start, result]);
        return result;
      }),
      js_los_trace: guarded((id, viewer, other, ex, ey, ez, sx, sy, sz) => {
        const services = host.perceptionServices(), run = frame(id);
        const from = host.receiver(run, viewer), to = host.receiver(run, other);
        const end = [ex, ey, ez].map(Math.fround), eye = [sx, sy, sz].map(Math.fround);
        const result = services.singleLineCheck(services.level(from), from, to, end, eye) ? 1 : 0;
        host.recording?.push(['los', from, to, ...end, ...eye, result]);
        return result;
      }),
      js_atan: Math.atan,
      js_atan2: Math.atan2,
      js_percep_begin: guarded((id, node, receiver) => host.begin(frame(id), node, receiver)),
      js_percep_verify: guarded((id, node, receiver, result) => host.verify(frame(id), node, receiver, result)),
    };
  }
  /** PERCEPTION_DIFFERENTIAL: AICanSee's target cache before Rust runs. */
  begin(run, node, receiver) {
    const {values} = this.args(run, 705), other = values[0];
    const snapshot = CACHE_FIELDS.map(name => this.tryRead(other, name));
    this.pending = {snapshot, other, traces: []};
    this.recording = this.pending.traces;
  }
  tryRead(actor, name) {
    try { return {ok: true, value: this.runtime.readNamed(actor, name)}; }
    catch (error) { return {ok: false, value: String(error?.message)}; }
  }
  /** PERCEPTION_DIFFERENTIAL: the JavaScript body on the same arguments and
   * state; the result, AICanSee's cache writes and its traces must match. */
  verify(run, node, receiver, result) {
    const call = this.call(run, node, receiver), where = `${run.compiled.displayName} native ${call.index}`;
    const fail = message => { throw new Error(`PERCEPTION_DIFFERENTIAL ${where}: ${message}`); };
    if (call.index !== 705) {
      const expected = Number(execPawnAlliance(call, this.allianceServices()));
      differential.alliance++;
      if (expected !== result) fail(`Rust ${result}, JavaScript ${expected}`);
      return;
    }
    const pending = this.pending;
    this.pending = null;
    this.recording = null;
    if (!pending) fail('no snapshot');
    const other = pending.other, rust = CACHE_FIELDS.map(name => this.tryRead(other, name));
    CACHE_FIELDS.forEach((name, i) => { if (pending.snapshot[i].ok) this.runtime.writeNamed(other, name, pending.snapshot[i].value); });
    const services = this.perceptionServices(), traces = [];
    const {lightLineCheck, singleLineCheck} = services;
    services.lightLineCheck = (level, actor, point, start) => {
      const value = lightLineCheck(level, actor, point, start);
      traces.push(['light', actor, ...point, ...start, value ? 1 : 0]);
      return value;
    };
    services.singleLineCheck = (level, from, to, end, eye) => {
      const value = singleLineCheck(level, from, to, end, eye);
      traces.push(['los', from, to, ...end, ...eye, value ? 1 : 0]);
      return value;
    };
    let expected;
    try { expected = execAICanSee(call, services); }
    finally { services.lightLineCheck = lightLineCheck; services.singleLineCheck = singleLineCheck; }
    differential.aiCanSee++;
    if (!sameNumber(expected, result)) fail(`Rust ${result}, JavaScript ${expected}`);
    const js = CACHE_FIELDS.map(name => this.tryRead(other, name));
    CACHE_FIELDS.forEach((name, i) => {
      differential.writes++;
      if (rust[i].ok !== js[i].ok || !sameNumber(rust[i].value, js[i].value))
        fail(`${name} Rust ${rust[i].value}, JavaScript ${js[i].value}`);
    });
    const ours = pending.traces;
    if (ours.length !== traces.length) fail(`${ours.length} traces in Rust, ${traces.length} in JavaScript`);
    ours.forEach((trace, i) => {
      differential.traces++;
      if (trace.length !== traces[i].length || !trace.every((v, k) => sameNumber(v, traces[i][k])))
        fail(`trace ${i} differs`);
    });
  }
}
