/**
 * The host half of the Rust AI event manager (docs/ai-event-manager.md, native/script-vm/src/aievent.rs).
 */

// Core's GCRCTable as appInit fills it (UE1 appCRCInit: polynomial 0x04C11DB7, MSB first).
const CRC = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let c = (index << 24) >>> 0;
  for (let bit = 0; bit < 8; bit++) c = (c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) : (c << 1)) >>> 0;
  CRC[index] = c;
}
/** appStrihash of an event name (UEventManager::GetEventHash, inlined in FindEvent 0x103834b0): per UTF-16 unit, upper-cased
 * for a-z, the CRC step on its low byte and then its high byte. */
export function aiNameHash(text) {
  let hash = 0;
  const step = (h, byte) => ((h >>> 8) ^ CRC[(h ^ byte) & 0xff]) >>> 0;
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0x61 && c <= 0x7a) c -= 0x20;
    hash = step(hash, c & 0xff);
    hash = step(hash, (c >> 8) & 0xff);
  }
  return hash >>> 0;
}

import {handleOf, identityOfHandle} from './script-object-handles.mjs';
import {nameId, nameSpelling} from './script-name-ids.mjs';
import {zeroValue} from './script-values.mjs';
import {actorInStasis} from './actor-tick.mjs';
import {execAICanSee} from './script-pawn-perception.mjs';
import {functionSignature} from './script-vm-lower.mjs';
import {frameLayout} from './script-frame-locals.mjs';

const view = new DataView(new ArrayBuffer(8));
const bitsOf = value => { view.setFloat32(0, value, true); return view.getUint32(0, true); };
const valueOf = bits => { view.setUint32(0, bits >>> 0, true); return view.getFloat32(0, true); };
// The Rust manager's flag bits (aievent.rs js_ai_flags) and float fields (js_ai_float).
const F_DELETED = 1, F_PAWN = 2, F_INVENTORY = 4, F_DETECTABLE = 8;
const FLOAT_FIELDS = [null, null, null, 'CollisionRadius', 'CollisionHeight', 'LastRenderTime', 'DistanceFromPlayer', 'HearingThreshold'];

/** Natives 710/711 and 713-716, LevelInfo.InitEventManager and ULevel::Tick's EventManager.Tick on the Rust manager. One manager per
 * runtime (one live level at a time): `active` is set by InitEventManager and cleared by `destroy`. Event and callback names cross as
 * name ids (script-name-ids.mjs, `None` as 0) and remember their first spelling for the callbacks' Name arguments. */
export class AiEventHost {
  constructor(vm) {
    this.vm = vm;
    this.runtime = vm.runtime;
    this.x = null;
    this.active = false;
    this.pool = 0;
    this.levelInfo = null;
    this.spellings = new Map();
    this.kinds = new WeakMap();
    this.paramKeys = null;
  }
  attach(exports) { this.x = exports; }
  nid(name) {
    const text = typeof name === 'string' ? name : String(name ?? '');
    const id = nameId(text);
    if (id === 1) return 0;
    if (!this.spellings.has(id)) this.spellings.set(id, text);
    return id;
  }
  spelling(id) { return id === 0 ? 'None' : this.spellings.get(id) ?? nameSpelling(id); }
  /** LevelInfo.InitEventManager (0x10384a90) in the level's PreBeginPlay: a new, empty manager. The original makes it for a LevelInfo
   * whose EventManager is null, and LoadMap gives every level a new LevelInfo; Play's Player start re-runs the startup on the same
   * LevelInfo object, so the previous generation's manager (its senders and receivers name released actors) is dropped here. */
  init(levelInfo) {
    if (!this.pool) {
      this.pool = this.vm.arena.alloc(this.x.ai_pool_size());
      this.x.ai_attach(this.pool);
    }
    if (!this.scores) {
      // dispatch.rs SCORES = [table, slot count]: the score callbacks' cache, 256 slots of 48 bytes
      this.scores = this.vm.arena.alloc(256 * 48);
      const view = this.vm.arena.view, at = this.x.vm_scores_ptr();
      view.setUint32(at, this.scores, true);
      view.setUint32(at + 4, 256, true);
    }
    this.x.ai_reset();
    this.levelInfo = levelInfo;
    this.active = true;
  }
  /** Whether `actor` belongs to the level whose manager this is. */
  owns(actor) {
    return this.active && this.runtime.levelFor(actor)?.actors?.[0] === this.levelInfo;
  }
  destroy() { if (this.active) this.x.ai_destroy(); this.active = false; this.levelInfo = null; }
  guarded(run) {
    const x = this.x, sp = x.__stack_pointer.value;
    try { return run(); } catch (error) { x.__stack_pointer.value = sp; x.ai_recover(); throw error; }
  }
  setCallback(receiver, event, callback, score, checks) {
    this.x.ai_set_callback(handleOf(receiver), this.nid(event), this.nid(callback), this.nid(score), +checks[0], +checks[1], +checks[2], +checks[3]);
  }
  clearCallback(receiver, event) { this.x.ai_clear_callback(handleOf(receiver), this.nid(event)); }
  send(sender, event, type, value, radius) { this.x.ai_send(handleOf(sender), this.nid(event), type & 255, bitsOf(value), bitsOf(radius)); }
  start(sender, event, type, value, radius) { this.x.ai_start(handleOf(sender), this.nid(event), type & 255, bitsOf(value), bitsOf(radius)); }
  end(sender, event, type) { this.x.ai_end(handleOf(sender), this.nid(event), type & 255); }
  clear(sender, event) { this.x.ai_clear(handleOf(sender), this.nid(event)); }
  destroyActor(actor) { this.x.ai_destroy_actor(handleOf(actor)); }
  /** UEventManager::Tick. */
  tick() {
    // AICanSee runs in Rust once the perception natives' field table is built (script-vm-perception.mjs ready(705)); until then, here.
    this.vm.arena.view.setUint32(this.x.ai_direct_ptr(), this.vm.perception.ready(705) ? 1 : 0, true);
    return this.guarded(() => this.x.ai_tick());
  }

  kind(actor) {
    const cls = this.runtime.instance(actor).cls;
    let kind = this.kinds.get(cls);
    if (kind === undefined) {
      kind = 0;
      for (let c = cls; c; c = c.base) {
        if (c.record?.key === 'engine.pawn') kind |= F_PAWN;
        if (c.record?.key === 'engine.inventory') kind |= F_INVENTORY;
      }
      this.kinds.set(cls, kind);
    }
    return kind;
  }
  imports() {
    const host = this, runtime = this.runtime;
    const actorOf = handle => identityOfHandle(handle);
    const read = (actor, name) => runtime.readNamed(actor, name);
    return {
      js_ai_name_hash: id => aiNameHash(host.spelling(id)),
      js_ai_name_cmp: (a, b) => {
        // appStricmp: the spellings compared case-insensitively
        const x = host.spelling(a).toLowerCase(), y = host.spelling(b).toLowerCase();
        return x < y ? -1 : x > y ? 1 : 0;
      },
      js_ai_flags: handle => {
        const actor = actorOf(handle);
        if (!actor) return F_DELETED;
        return (read(actor, 'bDeleteMe') ? F_DELETED : 0) | host.kind(actor) | (read(actor, 'bDetectable') ? F_DETECTABLE : 0);
      },
      js_ai_float: (handle, field) => {
        const actor = actorOf(handle);
        if (field < 3) return bitsOf(read(actor, 'Location')[field]);
        return bitsOf(read(actor, FLOAT_FIELDS[field]));
      },
      js_ai_locs: (a, b, out) => {
        const memory = host.vm.arena.view, p = read(actorOf(a), 'Location'), q = read(actorOf(b), 'Location');
        for (let i = 0; i < 3; i++) { memory.setFloat32(out + 4 * i, p[i], true); memory.setFloat32(out + 12 + 4 * i, q[i], true); }
      },
      js_ai_owner: handle => handleOf(read(actorOf(handle), 'Owner')),
      js_ai_time: handle => runtime.levelFor(actorOf(handle)).timeSeconds,
      js_ai_in_stasis: handle => {
        const actor = actorOf(handle);
        return actorInStasis(actor, {read, level: runtime.levelFor(actor)}) ? 1 : 0;
      },
      js_ai_can_see: (pawn, other, visibility, c0, c1, c2, c3) => {
        const receiver = actorOf(pawn), target = actorOf(other);
        const args = [target, valueOf(visibility), !!c0, !!c1, !!c2, !!c3];
        const call = {receiver, argumentCount: 6, evaluateArgument: i => args[i]};
        // the services do not depend on the call (soundServices reads only call.script, which AICanSee does not use)
        return bitsOf(execAICanSee(call, host.services ??= runtime.perceptionServices({})));
      },
      js_ai_line_check: (receiver, sender) => {
        // ULevel::SingleLineCheck(Hit, Source = receiver, End = sender.Location, Start = receiver.Location, TRACE_Movers|TRACE_Level):
        // Hit.Time is 1.0 when nothing is hit
        const from = actorOf(receiver), to = actorOf(sender);
        const services = runtime.perceptionServices({receiver: from});
        const clear = services.lightLineCheck(runtime.levelFor(from), from, [...read(to, 'Location')], [...read(from, 'Location')]);
        return bitsOf(clear ? 1 : 0.5);
      },
      js_ai_callback: (handle, callback, event, state) => host.callback(actorOf(handle), callback, event, state),
      js_ai_score: (receiver, sender, callback, score) => host.score(actorOf(receiver), actorOf(sender), callback, score),
      js_score_resolve: (handle, name, slot) => host.resolveScore(handle, name, slot),
      js_ai_warn: () => {},
    };
  }
  /** js_score_resolve (dispatch.rs call_score): the SCORES slot at `slot` for `handle`'s function `name`: kind (1 JavaScript, 2 no call,
   * 3 a Rust run), the lowering's code and frame size, the three parameters' offsets + 1 and the run template. The decision is
   * processEvent's: a function with a body, not native or singular, `float Name(Object, Object, float)`, lowered. */
  resolveScore(handle, nameId, slot) {
    const K_JS = 1, K_NOCALL = 2, K_RUN = 3, view = this.vm.arena.view;
    const decision = this.decideScore(identityOfHandle(handle), this.spelling(nameId)) ?? {kind: K_JS};
    view.setUint32(slot + 16, decision.kind, true);
    view.setUint32(slot + 20, decision.code ?? 0, true);
    view.setUint32(slot + 24, decision.size ?? 0, true);
    for (let i = 0; i < 3; i++) view.setUint32(slot + 28 + 4 * i, decision.offsets?.[i] ?? 0, true);
    view.setUint32(slot + 40, decision.template ?? 0, true);
    void K_NOCALL; void K_RUN;
  }
  decideScore(receiver, name) {
    const vm = this.vm, runtime = this.runtime, loader = runtime.classLoader, events = vm.events;
    if (receiver === null || !loader) return null;
    const instance = runtime.instance(receiver);
    if (!instance?.deleteMe || !events.deleteMeCell(instance.deleteMe)) return null;
    let record = null;
    try { record = runtime.lookup(receiver, name); } catch { return null; }
    const fn = record?.function;
    if (!fn) return null;
    if ((fn.script.nativeIndex & 0xffff) !== 0) return {kind: 2};
    if (fn.script.functionFlags & 0x420 || !fn.result || fn.parameters.length !== 3) return null;
    const signature = functionSignature(fn, loader);
    if (!signature || signature.rkind !== 3 || signature.params.map(p => p.kind).join() !== 'object,object,float') return null;
    const layout = frameLayout(fn, loader), lowered = layout && vm.loweringFor(fn.compiled, layout, runtime.services, receiver);
    if (!lowered) return null;
    return {kind: 3, code: lowered.code, size: layout.size, offsets: signature.params.map(p => p.offset + 1), template: events.template(fn, lowered, layout)};
  }
  /** AIEvent (0x10384980): the receiver's callback function with (event, state, XAIParams), when it has one. */
  callback(actor, callback, event, state) {
    const runtime = this.runtime, name = callback ? this.spelling(callback) : 'AIEvent';
    let record = null;
    try { record = runtime.lookup(actor, name); } catch { record = null; }
    const fn = record?.function;
    if (!fn) return;
    const words = new Uint32Array(this.vm.arena.memory.buffer, this.x.ai_params_ptr(), 5);
    const params = zeroValue(fn.parameters[2]);
    const suffixes = ['bestactor', 'score', 'visibility', 'volume', 'smell'];
    const keys = Object.keys(params);
    suffixes.forEach((suffix, i) => {
      const key = keys.find(k => k.endsWith(`.${suffix}`));
      params[key] = i === 0 ? identityOfHandle(words[0]) : valueOf(words[i]);
    });
    runtime.processEvent(actor, name, [this.spelling(event), state, params], null, record);
  }
  /** AIComputeScore's callback (0x10383f50): the float the script function returns for (receiver, sender, score). */
  score(receiver, sender, callback, score) {
    const runtime = this.runtime, name = this.spelling(callback);
    const record = runtime.lookup(receiver, name);
    if (!record) throw new Error(`Original AI score callback was not found: ${name}`);
    let result = 0;
    const reference = {reference: true, get: () => result, set: value => { result = value; }};
    runtime.processEvent(receiver, name, [receiver, sender, valueOf(score)], reference, record);
    return bitsOf(result);
  }
}
