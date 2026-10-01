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
import {fieldImageCell, scalarCell, onFieldImageCellVersion} from './script-object-image.mjs';
import {probeNames} from '../unreal/probe-names.mjs';

const DISPATCH_VERIFY = typeof process !== 'undefined' && process.env?.DISPATCH_VERIFY === '1';
// RUST_EVENTS=0 keeps every tick event in JavaScript (the reference path).
const DISABLED = typeof process !== 'undefined' && process.env?.RUST_EVENTS === '0';
const SLOTS = 1024, SLOT = 48;
const K_JS = 1, K_NOCALL = 2, K_RUN = 3;
export const MAX_RUNS = 256;
/** The Actor.Tick events (tick.rs E_*): [name, takes the delta]. */
export const TICK_EVENTS = Object.freeze([['Tick', true], ['Timer', false], ['Expired', false], ['UpdateEyeHeight', true],
  ['PainTimer', false], ['SpeechTimer', false], ['UpdateTactics', true]]);

const hosts = new Set();
onFieldImageCellVersion(() => {
  for (const ref of hosts) {
    const host = ref.deref();
    if (host) host.bump();
    else hosts.delete(ref);
  }
});

export class EventHost {
  constructor(vm) {
    this.vm = vm;
    this.at = 0;
    this.templates = [null];
    this.templateIds = new WeakMap();
    this.deleteMe = null;
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
    hosts.add(new WeakRef(this));
  }
  /** Every cache entry is resolved again. */
  bump() {
    if (!this.at) return;
    const view = this.vm.arena.view, epoch = (view.getUint32(this.at + 8, true) + 1) >>> 0;
    view.setUint32(this.at + 8, epoch || 1, true);
  }
  get enabled() { return this.at ? this.vm.arena.view.getUint32(this.at + 12, true) : 0; }
  set enabled(value) { if (this.at) this.vm.arena.view.setUint32(this.at + 12, value, true); }
  /** Whether an actor tick with these services may dispatch in Rust: the
   * runtime's own processEvent behind them, not wrapped, and the Rust
   * interpreter running script bodies. */
  allowed(services) {
    const runtime = this.vm.runtime;
    return !DISABLED && services?.runtimeEvents === true && runtime.services?.scriptVm === this.vm &&
      !Object.hasOwn(runtime, 'processEvent') && !Object.hasOwn(runtime, 'executeScript') &&
      !Object.hasOwn(runtime, 'eventLevelGate') && !Object.hasOwn(runtime, 'lookup') ? 1 : 0;
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
    const states = vm.states, entry = states.table + 12 * handle;
    const state = handle < states.capacity ? view.getUint32(entry, true) : 0;
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
  template(fn, lowered, layout) {
    let id = this.templateIds.get(lowered);
    if (id === undefined) {
      id = this.templates.length;
      this.templates.push({compiled: fn.compiled, lowered, layout, services: this.vm.runtime.services});
      this.templateIds.set(lowered, id);
    }
    return id;
  }
}
