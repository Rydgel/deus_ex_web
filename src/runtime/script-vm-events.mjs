/**
 * The host side of script events dispatched in Rust (dispatch.rs,
 * docs/rust-core.md "October 1: tick events in Rust"). Host bookkeeping,
 * not an original structure.
 *
 * `gate` is processEvent's first two gates (GIsScriptable, then the Level
 * gate, eventLevelGate), run as processEvent runs them; it also hands the
 * JavaScript runaway count to Rust's RUNAWAY. `resolve` fills one slot of
 * the event cache with processEvent's decision for the receiver's class and
 * state: the JavaScript path (anything processEvent would throw on, a
 * singular function, a function Rust cannot call), no call (a native
 * function: processEvent returns false), or a Rust run with the function's
 * lowered code, frame size, float parameter offset and run template. A
 * template ({compiled, lowered, layout, services}) is what
 * script-vm-rust.mjs `run` needs to build the JavaScript Run of a body Rust
 * began, when one of its imports asks for it.
 *
 * The cache's epoch advances when an entry could change: a lowering is
 * replaced, operands are relinked (ScriptObjects.operandEpoch) or the field
 * registry changes. Class rows, state rows and function lookups are fixed
 * per (class, state node). DISPATCH_VERIFY=1 makes Rust resolve every
 * dispatch and this host compare a filled slot with what it computes.
 */
import {identityOfHandle} from './script-object-handles.mjs';
import {scriptRunawayCount} from './script-vm.mjs';
import {frameLayout} from './script-frame-locals.mjs';
import {functionSignature, fieldKeyId} from './script-vm-lower.mjs';
import {fieldImageCell, scalarCell, onFieldImageCellWithdrawn} from './script-object-image.mjs';
import {probeNames, probeIndex} from '../unreal/probe-names.mjs';
import {handleOf} from './script-object-handles.mjs';
import {ScriptState, originalProcess, originalIsProbing} from './script-state.mjs';

const DISPATCH_VERIFY = typeof process !== 'undefined' && process.env?.DISPATCH_VERIFY === '1';
// RUST_EVENTS=0 keeps every tick event in JavaScript (the reference path).
const DISABLED = typeof process !== 'undefined' && process.env?.RUST_EVENTS === '0';
const SLOTS = 1024, SLOT = 48, CALL_SLOTS = 4096, CALL_SLOT = 48;
// RUST_CALLS=0 keeps every CALL's begin in JavaScript (js_call_begin).
const CALLS_DISABLED = typeof process !== 'undefined' && process.env?.RUST_CALLS === '0';
// RUST_STATE=0 crosses to ProcessState for every ticked actor (tick.rs).
const STATE_DISABLED = typeof process !== 'undefined' && process.env?.RUST_STATE === '0';
// RUST_POLLS=0 keeps every latent poll in JavaScript (tick.rs, loco.rs).
const POLLS_DISABLED = typeof process !== 'undefined' && process.env?.RUST_POLLS === '0';
// RUST_PROBES=0 asks JavaScript for the tick's IsProbing (js_tick_probing).
const PROBES_DISABLED = typeof process !== 'undefined' && process.env?.RUST_PROBES === '0';
/** The tick word's bits (EVENTS[3], tick.rs): events dispatch in Rust; a
 * ProcessState with no code to run is skipped; Sleep and the locomotion
 * latent actions are polled in Rust; the tick's IsProbing('Tick') and
 * IsProbing('EnemyNotVisible') read the state table's probe words. */
export const TICK_EVENTS_BIT = 1, TICK_STATE_BIT = 2, TICK_POLL_BIT = 4, TICK_PROBE_BIT = 8;
const K_JS = 1, K_NOCALL = 2, K_RUN = 3;
export const MAX_RUNS = 256;
/** The Actor.Tick events (tick.rs E_*): [name, takes the delta]. */
export const TICK_EVENTS = Object.freeze([['Tick', true], ['Timer', false], ['Expired', false], ['UpdateEyeHeight', true],
  ['PainTimer', false], ['SpeechTimer', false], ['UpdateTactics', true]]);

const hosts = new Set();
onFieldImageCellWithdrawn(() => {
  for (const ref of hosts) {
    const host = ref.deref();
    if (host) host.bump();
    else hosts.delete(ref);
  }
});

/** Measurement only (process-probe.mjs): the event hosts the cell walk reaches. */
export const eventHostCount = () => hosts.size;

export class EventHost {
  constructor(vm) {
    this.vm = vm;
    this.at = 0;
    this.templates = [null];
    this.templateIds = new WeakMap();
    this.deleteMe = null;
    // This host's entry in `hosts` (attach), until dispose.
    this.ref = null;
  }
  attach(x) {
    const vm = this.vm, arena = vm.arena;
    this.at = x.vm_events_ptr();
    this.deleteAt = x.vm_delete_me_ptr();
    this.runsAt = x.vm_runs_ptr();
    const bytes = SLOTS * SLOT, table = arena.alloc(bytes), view = arena.view;
    arena.bytes.fill(0, table, table + bytes);
    view.setUint32(this.at, table, true);
    view.setUint32(this.at + 4, SLOTS, true);
    view.setUint32(this.at + 8, 1, true);
    view.setUint32(this.at + 16, DISPATCH_VERIFY ? 1 : 0, true);
    const enames = x.vm_enames_ptr();
    TICK_EVENTS.forEach(([name], i) => view.setUint32(enames + 4 * i, (probeNames.get(name.toLowerCase()) ?? -1) >>> 0, true));
    vm.runtime.objects?.operandListeners?.push(() => this.bump());
    vm.runtime.boundaryFunctions?.listeners?.push(() => this.bump());
    hosts.add(this.ref = new WeakRef(this));
    // The call cache (dispatch.rs CALLS): on unless RUST_CALLS=0.
    this.callsAt = x.vm_calls_ptr();
    const calls = arena.alloc(CALL_SLOTS * CALL_SLOT);
    // The allocation may grow the Wasm memory, detaching the earlier view.
    const callsView = arena.view;
    arena.bytes.fill(0, calls, calls + CALL_SLOTS * CALL_SLOT);
    callsView.setUint32(this.callsAt, calls, true);
    callsView.setUint32(this.callsAt + 4, CALL_SLOTS, true);
    callsView.setUint32(this.callsAt + 8, CALLS_DISABLED ? 0 : 1, true);
  }
  /** A lowering was replaced: the slots that run its code, and the call
   * slots keyed by it as the caller, are resolved again. Its code is
   * released once no run can be executing it, and the address may then be
   * reused by another lowering. */
  retire(code) {
    if (!this.at) return;
    const view = this.vm.arena.view, events = view.getUint32(this.at, true), calls = view.getUint32(this.callsAt, true);
    for (let slot = events, end = events + SLOTS * SLOT; slot < end; slot += SLOT)
      if (view.getUint32(slot + 20, true) === code) view.setUint32(slot, 0, true);
    for (let slot = calls, end = calls + CALL_SLOTS * CALL_SLOT; slot < end; slot += CALL_SLOT)
      if (view.getUint32(slot, true) === code || view.getUint32(slot + 24, true) === code) view.setUint32(slot, 0, true);
  }
  /** The level is gone (RustScriptVm.dispose): its caches follow no withdrawn cell. */
  dispose() { if (this.ref) hosts.delete(this.ref); this.ref = null; }
  /** Every cache entry is resolved again. */
  bump() {
    if (!this.at) return;
    const view = this.vm.arena.view, epoch = (view.getUint32(this.at + 8, true) + 1) >>> 0;
    view.setUint32(this.at + 8, epoch || 1, true);
  }
  get enabled() { return this.at ? this.vm.arena.view.getUint32(this.at + 12, true) : 0; }
  set enabled(value) { if (this.at) this.vm.arena.view.setUint32(this.at + 12, value, true); }
  /** The tick word of an actor tick with these services, which must be
   * the runtime's own (actorTickServices' `runtimeEvents`) under the Rust
   * interpreter. TICK_EVENTS_BIT: events may dispatch in Rust, with
   * processEvent, executeScript, eventLevelGate and lookup as
   * script-runtime.mjs defines them (not wrapped on the prototype or the
   * runtime). TICK_STATE_BIT: ProcessState may be skipped when the state
   * table's frame word says it would return at once, with
   * ScriptState.prototype.process unwrapped. TICK_POLL_BIT (with the state
   * bit): Sleep and the locomotion latent actions may be polled in Rust,
   * with the runtime's poll methods unwrapped. TICK_PROBE_BIT (with the
   * events bit): the tick's IsProbing reads the state table, with
   * runtime.isProbing and ScriptState.prototype.isProbing unwrapped. */
  allowed(services) {
    const runtime = this.vm.runtime, m = runtime.constructor.originalMethods;
    if (services?.runtimeEvents !== true || runtime.services?.scriptVm !== this.vm || m === undefined) return 0;
    const events = !DISABLED &&
      runtime.processEvent === m.processEvent && runtime.executeScript === m.executeScript &&
      runtime.eventLevelGate === m.eventLevelGate && runtime.lookup === m.lookup;
    const state = !STATE_DISABLED && ScriptState.prototype.process === originalProcess;
    const polls = state && !POLLS_DISABLED && runtime.pollPawnLocomotion === m.pollPawnLocomotion &&
      runtime.pawnView === m.pawnView && runtime.locomotionServices === m.locomotionServices &&
      runtime.latentFloat === m.latentFloat && runtime.readNamed === m.readNamed && runtime.writeNamed === m.writeNamed;
    if (polls) this.vm.loco.table();
    // The probe words are ScriptState.isProbing's ProbeMask (script-vm-states.mjs).
    const probes = events && !PROBES_DISABLED && runtime.isProbing === m.isProbing &&
      ScriptState.prototype.isProbing === originalIsProbing;
    return (events ? TICK_EVENTS_BIT : 0) | (state ? TICK_STATE_BIT : 0) | (polls ? TICK_POLL_BIT : 0) |
      (probes ? TICK_PROBE_BIT : 0);
  }
  /** js_event_gate. */
  gate(handle) {
    const vm = this.vm, runtime = vm.runtime, receiver = identityOfHandle(handle);
    if (receiver === null) return -1;
    vm.arena.view.setUint32(vm.runawayAt, scriptRunawayCount(), true);
    if (!runtime.scriptability()) return 0;
    return runtime.eventLevelGate(receiver, runtime.instance(receiver)) ? 1 : 0;
  }
  /** js_event_resolve: processEvent's decision into the slot at `slot`. */
  resolve(handle, which, slot) {
    const decision = this.decide(identityOfHandle(handle), which);
    const view = this.vm.arena.view;
    if (DISPATCH_VERIFY && view.getUint32(slot + 16, true) !== 0 && this.sameKey(handle, which, slot)) {
      const words = [16, 20, 24, 28, 32].map(at => view.getUint32(slot + at, true));
      const fresh = [decision.kind, decision.code, decision.size, decision.param, decision.template];
      if (words.some((w, i) => w !== fresh[i]))
        throw new Error(`Event cache slot for handle ${handle} event ${TICK_EVENTS[which][0]} is stale: [${words}], now [${fresh}]`);
    }
    view.setUint32(slot + 16, decision.kind, true);
    view.setUint32(slot + 20, decision.code, true);
    view.setUint32(slot + 24, decision.size, true);
    view.setUint32(slot + 28, decision.param, true);
    view.setUint32(slot + 32, decision.template, true);
  }
  /** Whether the slot holds the current key for this dispatch (verify). */
  sameKey(handle, which, slot) {
    const vm = this.vm, view = vm.arena.view, row = vm.classRow(handle);
    const entry = vm.states.entry(handle), state = entry ? view.getUint32(entry, true) : 0;
    return view.getUint32(slot, true) === row && view.getUint32(slot + 4, true) === state &&
      view.getUint32(slot + 8, true) === which && view.getUint32(slot + 12, true) === view.getUint32(this.at + 8, true);
  }
  decide(receiver, which) {
    const js = {kind: K_JS, code: 0, size: 0, param: 0, template: 0};
    const vm = this.vm, runtime = vm.runtime, loader = runtime.classLoader;
    if (receiver === null || !loader) return js;
    const [name, withDelta] = TICK_EVENTS[which];
    const instance = runtime.instance(receiver);
    // An actor's pendingKill is its bDeleteMe cell; another object's is a
    // host value.
    if (!instance?.deleteMe || !this.deleteMeCell(instance.deleteMe)) return js;
    const fn = runtime.lookup(receiver, name)?.function;
    if (!fn) return js;
    if ((fn.script.nativeIndex & 0xffff) !== 0) return {...js, kind: K_NOCALL};
    // processEvent's errors (a native hook, a result without a reference,
    // a parameter count other than the event's), a singular function.
    if (fn.script.functionFlags & 0x420 || fn.result || fn.parameters.length !== (withDelta ? 1 : 0)) return js;
    const signature = functionSignature(fn, loader);
    if (!signature || (withDelta && signature.params[0].kind !== 'float')) return js;
    const layout = frameLayout(fn, loader), lowered = layout && vm.loweringFor(fn.compiled, layout, runtime.services, receiver);
    if (!lowered) return js;
    return {kind: K_RUN, code: lowered.code, size: layout.size, param: withDelta ? signature.params[0].offset + 1 : 0,
      template: this.template(fn, lowered, layout)};
  }
  /** DELETE_ME from bDeleteMe's registered cell; false when it has none. */
  deleteMeCell(field) {
    if (this.deleteMe === field) return true;
    const cell = scalarCell(fieldImageCell(field.key));
    if (cell?.kind !== 'bool') return false;
    const view = this.vm.arena.view;
    view.setUint32(this.deleteAt, cell.offset, true);
    view.setUint32(this.deleteAt + 4, fieldKeyId(field.key), true);
    view.setUint32(this.deleteAt + 8, cell.mask, true);
    this.deleteMe = field;
    return true;
  }
  /** The run template of a lowering (one per lowering: its function,
   * layout and services are fixed). */
  template(fn, lowered, layout, services = this.vm.runtime.services) {
    let id = this.templateIds.get(lowered);
    if (id === undefined) {
      id = this.templates.length;
      this.templates.push({compiled: fn.compiled, lowered, layout, services, resultField: fn.result ?? null});
      this.templateIds.set(lowered, id);
    }
    return id;
  }
  /** js_call_resolve: beginCall's decision (script-vm-rust.mjs) for the CALL
   * `node` of run `frame` on `handle`, into the slot at `slot`. */
  callResolve(frame, node, handle, sig, slot) {
    const decision = this.callDecision(frame, node, handle, sig), view = this.vm.arena.view;
    if (DISPATCH_VERIFY && view.getUint32(slot + 20, true) !== 0 && view.getUint32(slot, true) === this.vm.run(frame).lowered.code &&
      view.getUint32(slot + 4, true) === node && view.getUint32(slot + 8, true) === this.vm.classRow(handle) &&
      view.getUint32(slot + 12, true) === (this.vm.states.entry(handle) ? view.getUint32(this.vm.states.entry(handle), true) : 0) &&
      view.getUint32(slot + 16, true) === view.getUint32(this.at + 8, true)) {
      const words = [20, 24, 28, 32, 36].map(at => view.getUint32(slot + at, true));
      const fresh = [decision.kind, decision.code, decision.size, decision.template, decision.probe ?? 0xffffffff];
      if (words.some((w, i) => w !== fresh[i]))
        throw new Error(`Call cache slot for node ${node} on handle ${handle} is stale: [${words}], now [${fresh}]`);
    }
    view.setUint32(slot + 20, decision.kind, true);
    view.setUint32(slot + 24, decision.code, true);
    view.setUint32(slot + 28, decision.size, true);
    view.setUint32(slot + 32, decision.template, true);
    view.setUint32(slot + 36, decision.probe ?? 0xffffffff, true);
  }
  callDecision(frame, node, handle, sig) {
    const js = {kind: K_JS, code: 0, size: 0, template: 0};
    const vm = this.vm, caller = vm.run(frame), n = caller.nodes[node], runtime = vm.runtime, services = caller.services;
    const receiver = handle === caller.selfHandle ? caller.self : identityOfHandle(handle);
    if (receiver === null) return js;
    const record = vm.callRecord(n, receiver, caller);
    const fn = record?.function;
    if (!fn || runtime.boundaryFunctions.has(record.key) || fn.script.nativeIndex || fn.script.functionFlags & 0x400 ||
      fn.script.functionFlags & 0x20 || n.args.length > fn.parameters.length ||
      (receiver?.kind === 'Class' && !runtime.instances.has(receiver))) return js;
    if (functionSignature(fn, runtime.classLoader)?.id !== sig) return js;
    const layout = frameLayout(fn, runtime.classLoader), lowered = vm.loweringFor(fn.compiled, layout, services, receiver);
    if (!lowered) return js;
    return {kind: K_RUN, code: lowered.code, size: layout.size, template: this.template(fn, lowered, layout, services), probe: probeIndex(record)};
  }
}
