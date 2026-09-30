/**
 * The Rust script interpreter on one runtime (docs/rust-core.md, step R2b-2).
 *
 * native/script-vm/src/interp.rs runs a function's lowered code
 * (script-vm-lower.mjs) in the runtime's object arena: locals in the frame
 * block, fields in object images, objects as handles. A node the lowering
 * leaves to JavaScript is evaluated here, by the compiled closures of
 * script-vm.mjs on the same frame; a statement it leaves to JavaScript is
 * run by `compiled.step`, the body of the compiled statement loop. The
 * driver below is that loop (resumeCompiled) with runs of lowered statements
 * in Rust.
 *
 * Shared state crosses as the JavaScript VM keeps it: GRunaway is copied
 * into the module before a run and around every import, and back after; the
 * hang budget is the loop's own counter.
 *
 * A script call lowered as CALL runs its function in Rust too (R2b-3):
 * `beginCall` resolves it as runtime.invoke/callFunction would and pushes the
 * callee's frame block, Rust stores the arguments and runs the body, and a
 * callee statement left to JavaScript runs through `step`. The callee's
 * JavaScript frame object exists only once one of its nodes needs it.
 */
import {instantiateScriptVm} from './script-vm-kernel.mjs';
import {handleOf, identityOfHandle, onHandleRelease, handleLimit} from './script-object-handles.mjs';
import {scriptRunawayCount, setScriptRunaway, SCRIPT_RUNAWAY_LIMIT} from './script-vm.mjs';
import {FrameLocals, frameLayout} from './script-frame-locals.mjs';
import {copyValue} from './script-values.mjs';
import {lowerFunction, fieldKeyId, functionSignature, classRecordId, nameId, foldedNameId, nameSpelling} from './script-vm-lower.mjs';
import {PerceptionHost} from './script-vm-perception.mjs';

// Receiver info flags (interp.rs).
const BOUND = 1, HOST = 2;
// Handle class table words (interp.rs): a released handle, and a class
// row's default image word when DefaultVariable reads stay in JavaScript.
const RELEASED = 1, UNREADABLE = 1;
// js_check value kinds (interp.rs).
const CK_INT = 1, CK_BOOL = 2, CK_FLOAT = 3, CK_OBJECT = 4, CK_CAST = 5, CK_VECTOR = 6, CK_ROTATOR = 7, CK_OP = 8;
// CK_OP (R2b-6): each checked native's operand kinds, in the order Rust
// reports them (CHECK_VALUES[0..3], [3..6]); a float or name operand is the
// first slot of its group.
const CHECKED_OPERANDS = new Map([
  [215, ['vector', 'vector']], [216, ['vector', 'vector']], [212, ['vector', 'float']], [213, ['float', 'vector']],
  [214, ['vector', 'float']], [211, ['vector']], [296, ['vector', 'vector']], [226, ['vector']], [300, ['vector', 'vector']],
  [276, ['vector', 'rotator']], [316, ['rotator', 'rotator']], [317, ['rotator', 'rotator']], [287, ['rotator', 'float']],
  [288, ['float', 'rotator']], [225, ['vector']], [219, ['vector', 'vector']], [217, ['vector', 'vector']],
  [218, ['vector', 'vector']], [142, ['rotator', 'rotator']], [203, ['rotator', 'rotator']], [254, ['name', 'name']],
  [255, ['name', 'name']],
  // The out natives (VCOMPOUND): argument 0 is the target's reference.
  [221, ['vector', 'float']], [222, ['vector', 'float']], [223, ['vector', 'vector']], [224, ['vector', 'vector']],
  [297, ['vector', 'vector']], [318, ['rotator', 'rotator']], [319, ['rotator', 'rotator']],
]);
const OUT_NATIVES = new Set([221, 222, 223, 224, 297, 318, 319]);
const UNDEF_BITS_HI = 0x7ff80000, UNDEF_BITS_LO = 1;
const f64io = new DataView(new ArrayBuffer(8));
/** Whether two JavaScript numbers have the same float64 bits, any NaN
 * matching any NaN: V8 does not keep a NaN payload stably inside an Array
 * (an optimized store may canonicalize it) or across tiers (two NaN
 * operands), so the JavaScript VM's own vector NaN payloads depend on JIT
 * state (docs/rust-core.md R2b-6); validate-script-vm-interp checks Rust's
 * payload rules. */
const sameBits = (a, b) => {
  if (typeof a !== 'number' || typeof b !== 'number') return Object.is(a, b);
  if (a !== a || b !== b) return a !== a && b !== b;
  f64io.setFloat64(0, a, true);
  const lo = f64io.getUint32(0, true), hi = f64io.getUint32(4, true);
  f64io.setFloat64(0, b, true);
  return lo === f64io.getUint32(0, true) && hi === f64io.getUint32(4, true);
};
const UNDEFINED = 0xffffffff, NEXT_NONE = 0xffffffff;
const HANG_BUDGET = 200000000;
// SCRIPT_VM_STATS=1: count runs, JavaScript nodes and JavaScript statements
// by original op, printed at exit (coverage of the lowering).
const STATS = typeof process !== 'undefined' && process.env?.SCRIPT_VM_STATS === '1' ? new Map() : null;
const opName = n => n?.op === 'native' ? `native ${n.index}` : typeof n?.op === 'number' ? `0x${n.op.toString(16)}` : String(n?.op);
const CHECK = typeof process !== 'undefined' && process.env?.SCRIPT_VM_CHECK === '1';
// SCRIPT_VM_STATS_DETAIL=1: JavaScript nodes and Returns keyed by their
// operand shapes (op, property type) instead of their op alone.
const DETAIL = STATS && process.env.SCRIPT_VM_STATS_DETAIL === '1';
const count = key => STATS.set(key, (STATS.get(key) ?? 0) + 1);
function shape(run, n, depth = 2) {
  if (n === null || typeof n !== 'object') return String(n);
  let type = '';
  if (n.op === 0x00 || n.op === 0x01 || n.op === 0x36 || n.op === 0x02) {
    try {
      const field = run.frame.services.operand(run.compiled.script, n), m = field?.metadata;
      type = `:${m?.type ?? '?'}${m?.structKey ? `/${String(m.structKey).split('.').pop()}` : ''}${n.op === 0x01 ? `=${field.key}` : ''}`;
    } catch { type = ':?'; }
  } else if (n.op === 'literal') type = `:${n.token?.toString(16)}`;
  if (depth <= 0) return opName(n) + type;
  const kids = n.op === 'native' ? n.args : n.op === 0x19 || n.op === 0x12 ? [n.context, n.value]
    : n.op === 0x0f || n.op === 0x14 ? [n.left, n.right]
    : n.op === 0x1a ? [n.right, n.left] : n.op === 0x1b || n.op === 0x1c ? [] : 'value' in n && typeof n.value === 'object' ? [n.value] : [];
  const name = n.op === 0x1b || n.op === 0x1c ? ` ${n.name ?? ''}` : '';
  return `${opName(n)}${type}${name}${kids?.length ? `(${kids.map(k => shape(run, k, depth - 1)).join(', ')})` : ''}`;
}
// bench-sim clears its measurements after the warm-up ticks.
if (STATS) globalThis.__scriptVmStatsReset = () => STATS.clear();
if (STATS) process.on('exit', () => {
  const rows = [...STATS].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.SCRIPT_VM_STATS_ROWS) || 60);
  console.error(`script-vm stats:\n${rows.map(([key, n]) => `${String(n).padStart(10)}  ${key}`).join('\n')}`);
});
const RETURN_BOOL = 2, RETURN_FLOAT = 3, RETURN_OBJECT = 4, RETURN_VECTOR = 5, RETURN_ROTATOR = 6;
const RETURNED = 0xfffffffe;
// Word kinds the state driver inspects (interp.rs).
const S_EXPR = 1, S_JUMP_IF_NOT = 3, JS_BOOL = 52, JS_VOID = 55;
// State code's frame layout: a state has no parameters or locals.
const STATE_LAYOUT = Object.freeze({size: 0, refCount: 0, cells: new Map(), fields: new Map()});

// Interpreters whose handle class tables follow handle releases and class
// default changes, weakly held (an interpreter lives as long as its runtime).
const interpreters = new Set();
function eachInterpreter(fn) {
  for (const ref of interpreters) {
    const vm = ref.deref();
    if (vm) fn(vm);
    else interpreters.delete(ref);
  }
}
onHandleRelease(handle => eachInterpreter(vm => vm.markReleased(handle)));
/** A class default or a class default image changed (script-runtime.mjs):
 * each class row's default image is validated again before Rust reads it. */
export function classDefaultsChanged() {
  eachInterpreter(vm => vm.invalidateDefaultImages());
}
/** Per statement of a lowered state body: whether it runs in Rust (an
 * effect or a conditional jump with lowered work); a jump, Nothing, foreach
 * step, Return, yield or wholly JavaScript statement is one compiled step. */
function stateStatements(words) {
  const count = words[0], inRust = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const at = words[1 + 2 * i], kind = words[at];
    inRust[i] = kind === S_EXPR && words[at + 1] !== JS_VOID || kind === S_JUMP_IF_NOT && words[at + 2] !== JS_BOOL ? 1 : 0;
  }
  return inRust;
}
/** Whether `cls.propertyLink` is its chain's propertyOrders in order, so a
 * property is in it exactly when its declaring class is in the chain (the
 * DEFAULT_* owner test). */
function propertyLinkIsChain(cls) {
  const link = cls.propertyLink;
  if (!Array.isArray(link)) return false;
  let i = 0;
  for (let c = cls; c; c = c.base) {
    if (!Array.isArray(c.propertyOrder)) return false;
    for (const field of c.propertyOrder) if (link[i++] !== field) return false;
  }
  return i === link.length;
}

/** One function body running in Rust: an import's `frame` argument names
 * it. A body entered from JavaScript has its frame object; a callee of a
 * CALL gets one on first use (its locals are the pushed block). */
class Run {
  constructor(vm, compiled, lowered, self, services, frame, layout = null, base = 0, resultField = null) {
    this.vm = vm; this.compiled = compiled; this.lowered = lowered;
    this.nodes = lowered.nodes; this.indexOf = lowered.indexOf; this.entries = lowered.entries;
    this.fieldNodes = lowered.fieldNodes;
    this.self = self; this.selfHandle = handleOf(self); this.services = services;
    this.frameObject = frame; this.layout = layout; this.base = base; this.resultField = resultField;
  }
  get frame() {
    return this.frameObject ??= this.compiled.createFrame(this.self,
      new FrameLocals(this.layout, this.vm.arena, this.base, null), this.services);
  }
}

export class RustScriptVm {
  /** One interpreter instance on `runtime`'s object arena. */
  static async create(runtime) {
    const vm = new RustScriptVm(runtime);
    vm.exports = await instantiateScriptVm(vm.arena.memory, vm.imports());
    vm.attach();
    return vm;
  }
  constructor(runtime) {
    this.runtime = runtime;
    this.arena = runtime.objectArena();
    this.exports = null;
    // Active runs by id; an import's `frame` argument indexes it. The count
    // of active runs (the next id) is FRAMES[3], which Rust puts back with
    // the frame stack after a call, so a callee whose arguments are still
    // being evaluated keeps its id through nested calls.
    this.frames = [];
    // Code of replaced lowerings, released when no run can be executing it.
    this.retired = [];
    // compiled function -> its lowering for this runtime.
    this.lowerings = new WeakMap();
    this.boundTable = 0;
    this.boundCapacity = 0;
    this.lowered = 0;
    // The handle class table (interp.rs CLASSES) and its class rows by class.
    this.classTable = 0;
    this.classCapacity = 0;
    this.rows = new Map();
    // R3-c: the perception natives' tables and imports.
    this.perception = new PerceptionHost(this);
  }
  attach() {
    const x = this.exports;
    this.runawayAt = x.vm_runaway_ptr();
    this.budgetAt = x.vm_budget_ptr();
    this.resultAt = x.vm_result_ptr();
    this.undefAt = x.vm_float_undef_ptr();
    this.boundAt = x.vm_bound_keys_ptr();
    for (const key of this.runtime.boundKeys) this.markBound(key);
    // The FMemStack's state words move into Rust's FRAMES (R2b-3).
    this.framesAt = x.vm_frames_ptr();
    this.runtime.frameStack().attach(this.framesAt);
    this.callAt = x.vm_call_block_ptr();
    // R2b-5: the handle class table starts with every handle released so
    // far; later releases arrive through onHandleRelease.
    this.classesAt = x.vm_classes_ptr();
    // R2b-6: vector and rotator values from JavaScript, vector and rotator
    // Returns, and SCRIPT_VM_CHECK's operator reports.
    this.vectorAt = x.vm_vector_io_ptr();
    this.result3At = x.vm_result3_ptr();
    this.checkValuesAt = x.vm_check_values_ptr();
    this.perception.attach(x);
    const limit = handleLimit();
    this.growClassTable(limit);
    for (let handle = 1; handle < limit; handle++) if (identityOfHandle(handle) === null) this.markReleased(handle);
    interpreters.add(new WeakRef(this));
    if (CHECK) this.arena.view.setUint32(x.vm_check_ptr(), 1, true);
  }
  /** Make the class table cover `handle`. */
  growClassTable(handle) {
    if (handle < this.classCapacity) return;
    const capacity = Math.max(4096, (handle + 1) * 2), base = this.arena.alloc(capacity * 4);
    if (this.classTable) {
      this.arena.bytes.copyWithin(base, this.classTable, this.classTable + this.classCapacity * 4);
      this.arena.release(this.classTable, this.classCapacity * 4);
    }
    this.classTable = base;
    this.classCapacity = capacity;
    const view = this.arena.view;
    view.setUint32(this.classesAt, base, true);
    view.setUint32(this.classesAt + 4, capacity, true);
  }
  /** A handle was released: a pointer holding it reads None in Rust. */
  markReleased(handle) {
    this.growClassTable(handle);
    this.arena.view.setUint32(this.classTable + 4 * handle, RELEASED, true);
  }
  invalidateDefaultImages() {
    const view = this.arena.view;
    for (const row of this.rows.values()) view.setUint32(row.address, 0, true);
  }
  /** js_class_row: the class row of `handle`'s attached instance (interp.rs
   * header), entered in the table, or 0 for a handle that is not described
   * (released, not attached to this runtime, a class identity), whose casts
   * run castObject in JavaScript. A row whose default image word is 0 is
   * validated again. Runs no script. */
  classRow(handle) {
    const identity = identityOfHandle(handle);
    if (identity === null || typeof identity !== 'object' || identity.kind === 'Class') return 0;
    const runtime = this.runtime, instance = identity[runtime.instanceKey] ?? runtime.instances.get(identity);
    const cls = instance?.cls;
    if (!cls) return 0;
    let row = this.rows.get(cls);
    if (!row) {
      // castObject walks cls.record along cls.base; IsA compares
      // lower(cls.record.name) along the same chain (R2b-6).
      const chain = [], names = [];
      for (let c = cls; c; c = c.base) {
        if (!c.record || typeof c.record !== 'object') return 0;
        chain.push(classRecordId(c.record));
        names.push(foldedNameId(String(c.record.name).toLowerCase()));
      }
      // The row, then (R3-c) its field and flag words for the perception
      // natives, 0 until js_class_fields computes them (the arena zeroes).
      const n = chain.length, address = this.arena.alloc(8 + 8 * n + 8), view = this.arena.view;
      view.setUint32(address + 4, n, true);
      chain.forEach((id, i) => view.setUint32(address + 8 + 4 * i, id, true));
      names.forEach((id, i) => view.setUint32(address + 8 + 4 * (n + i), id, true));
      row = {address, cls, linkIsChain: propertyLinkIsChain(cls)};
      this.rows.set(cls, row);
    }
    if (this.arena.view.getUint32(row.address, true) === 0)
      this.arena.view.setUint32(row.address, this.defaultImage(row), true);
    this.growClassTable(handle);
    this.arena.view.setUint32(this.classTable + 4 * handle, row.address, true);
    return row.address;
  }
  /** A class row's default image word: the class default image's base when
   * it is current (classImage would return it unchanged), in this arena and
   * without a default that could not be produced, else UNREADABLE. */
  defaultImage(row) {
    if (!row.linkIsChain) return UNREADABLE;
    const image = this.runtime.currentClassImage?.(row.cls);
    return image && image.arena === this.arena && !image.poison ? image.base : UNREADABLE;
  }
  /** Whether perception native `index` runs in Rust (script-vm-lower.mjs). */
  perceptionReady(index) {
    return this.perception.ready(index);
  }
  /** SCRIPT_VM_CHECK: a value Rust read for `node` against the closure's. */
  check(frameId, node, handle, kind, value) {
    const run = this.frames[frameId], n = run.nodes[node];
    const object = handle === run.selfHandle ? run.self : identityOfHandle(handle);
    if (kind === CK_VECTOR || kind === CK_ROTATOR || kind === CK_OP) return this.checkComposite(run, n, object, kind);
    let expected;
    if (kind === CK_CAST) {
      const s = run.services, target = s.objectReference(run.compiled.script, n.fieldIndex, n);
      expected = handleOf(s.castObject(object, target, 'dynamic'));
    } else {
      const v = run.compiled.nodeValue(n, run.frame, object);
      expected = kind === CK_INT ? v | 0 : kind === CK_BOOL ? (v ? 1 : 0) : kind === CK_FLOAT ? (v === undefined ? undefined : +v)
        : kind === CK_OBJECT ? handleOf(v) : NaN;
    }
    if (!Object.is(expected, value))
      throw new Error(`SCRIPT_VM_CHECK ${run.compiled.displayName} ${opName(n)} at ${n.offset}: Rust ${value}, JavaScript ${expected}`);
  }
  /** SCRIPT_VM_CHECK (R2b-6): a vector or rotator Rust read from memory
   * against the closure's value, or an operator's result against the
   * JavaScript VM's body (compiled.primitive) on the operands Rust used. */
  checkComposite(run, n, object, kind) {
    const view = this.arena.view, at = this.checkValuesAt, slot = i => view.getFloat64(at + 8 * i, true);
    const group = base => [slot(base), slot(base + 1), slot(base + 2)];
    const fail = (rust, js) => {
      throw new Error(`SCRIPT_VM_CHECK ${run.compiled.displayName} ${opName(n)} at ${n.offset}: Rust ${String(rust)}, JavaScript ${String(js)}`);
    };
    const result = group(6);
    if (kind !== CK_OP) {
      const expected = run.compiled.nodeValue(n, run.frame, object);
      if (!Array.isArray(expected) || expected.length !== 3 || !expected.every((v, i) => sameBits(v, result[i]))) fail(result, expected);
      return;
    }
    // A member of a vector or rotator value: structValue on the value Rust used.
    if (n.op === 0x36) {
      const expected = run.services.structValue(group(0), run.compiled.script, n);
      if (!sameBits(expected, result[0])) fail(`${result[0]} from ${group(0)}`, expected);
      return;
    }
    const kinds = CHECKED_OPERANDS.get(n.index);
    if (!kinds) fail(result, `no check for native ${n.index}`);
    const operand = (kind, base) => {
      if (kind === 'vector' || kind === 'rotator') return group(base);
      const v = slot(base);
      if (kind === 'name') return nameSpelling(v);
      f64io.setFloat64(0, v, true);
      return f64io.getUint32(4, true) === UNDEF_BITS_HI && f64io.getUint32(0, true) === UNDEF_BITS_LO ? undefined : v;
    };
    const values = kinds.map((kind, i) => operand(kind, 3 * i));
    // An out native writes its target through the reference (assign).
    if (OUT_NATIVES.has(n.index)) {
      const target = values[0];
      values[0] = {reference: true, get: () => target, set: value => value};
    }
    const expected = run.compiled.primitive(n.index, values);
    const same = Array.isArray(expected) ? expected.length === 3 && expected.every((v, i) => sameBits(v, result[i]))
      : typeof expected === 'boolean' ? (expected ? 1 : 0) === result[0] : sameBits(expected, result[0]);
    if (!same) fail(`${result} from ${JSON.stringify(values)}`, expected);
  }
  get depth() { return this.arena.view.getUint32(this.framesAt + 12, true); }
  set depth(value) { this.arena.view.setUint32(this.framesAt + 12, value, true); }
  /** A field key some host binding uses: a bound receiver's field with this
   * key takes the JavaScript path (interp.rs field_base). */
  markBound(key) {
    const id = fieldKeyId(key);
    if (id >= this.boundCapacity) {
      const capacity = Math.max(1024, (id + 1) * 2), base = this.arena.alloc(capacity);
      if (this.boundTable) {
        this.arena.bytes.copyWithin(base, this.boundTable, this.boundTable + this.boundCapacity);
        this.arena.release(this.boundTable, this.boundCapacity);
      }
      this.boundTable = base;
      this.boundCapacity = capacity;
      const view = this.arena.view;
      view.setUint32(this.boundAt, base, true);
      view.setUint32(this.boundAt + 4, capacity, true);
    }
    this.arena.bytes[this.boundTable + id] = 1;
  }
  /** The receiver info word of a handle: its image base, BOUND when it has
   * host bindings, or HOST when field accesses must take the JavaScript
   * path (no image here, a poisoned value, a released or class receiver). */
  receiverInfo(handle) {
    const identity = identityOfHandle(handle);
    if (identity === null || typeof identity !== 'object') return HOST;
    const runtime = this.runtime;
    const instance = identity[runtime.instanceKey] ?? runtime.instances.get(identity);
    if (!instance || !instance.cells || !instance.base || instance.arena !== this.arena || instance.poison?.size ||
      instance.imageToken?.released || instance.nativeObject?.released) return HOST;
    return (instance.base | (instance.bindings.size ? BOUND : 0)) >>> 0;
  }
  /** SCRIPT_VM_STATS: what an assignment left to JavaScript assigns. */
  whyEffect(run, node, handle) {
    const n = run.nodes[node];
    if (n?.op !== 0x0f && n?.op !== 0x14) return '';
    let target = n.left;
    if (target?.op === 0x2d) target = target.value;
    if (target?.op !== 0x00 && target?.op !== 0x01) return ` [target ${opName(target)}]`;
    let field = null;
    try { field = run.frame.services.operand(run.compiled.script, target); } catch {}
    const where = target.op === 0x00 ? 'local' : run.fieldNodes?.has(node) ? 'field fallback' : 'field';
    const why = where === 'field fallback' ? (this.receiverInfo(handle) & HOST ? ' host' : ' bound') : '';
    return ` [${where} ${field?.metadata?.type ?? '?'}${why}]`;
  }
  /** SCRIPT_VM_STATS: why an instance variable read is in JavaScript. */
  why(run, node, handle) {
    const n = run.nodes[node];
    if (n?.op === 0x36 || n?.op === 0x2e) {
      let inner = n.value;
      while (inner?.op === 0x36) inner = inner.value;
      const shape = inner?.op === 0x19 ? `context ${opName(inner.value)}` : opName(inner);
      return ` [of ${shape}]`;
    }
    if (n?.op !== 0x01) return '';
    let field = null;
    try { field = run.frame.services.operand(run.compiled.script, n); } catch {}
    const type = field?.metadata?.type ?? '?';
    const lowered = run.fieldNodes?.has(node);
    if (!lowered) return ` [unlowered ${type}]`;
    const info = this.receiverInfo(handle);
    if (!(info & HOST)) return ` [bound ${field.key}]`;
    const identity = identityOfHandle(handle), runtime = this.runtime;
    const instance = identity && (identity[runtime.instanceKey] ?? runtime.instances.get(identity));
    const reason = !identity ? 'released' : !instance ? `unattached ${identity.kind ?? typeof identity}` : !instance.cells ? 'no image'
      : instance.arena !== this.arena ? 'other arena' : instance.poison?.size ? 'poison' : 'released image';
    return ` [host ${reason}]`;
  }
  identity(handle) {
    const identity = identityOfHandle(handle);
    if (identity === null) throw new Error('Script object allocation has been released');
    return identity;
  }
  imports() {
    const vm = this;
    const enter = () => setScriptRunaway(vm.arena.view.getUint32(vm.runawayAt, true));
    const leave = () => vm.arena.view.setUint32(vm.runawayAt, scriptRunawayCount(), true);
    const receiver = (run, handle) => handle === run.selfHandle ? run.self : vm.identity(handle);
    const value = (frame, node, handle) => {
      const run = vm.frames[frame];
      if (STATS) count(`js value ${DETAIL ? shape(run, run.nodes[node]) : opName(run.nodes[node])}${vm.why(run, node, handle)}`);
      return run.compiled.nodeValue(run.nodes[node], run.frame, receiver(run, handle));
    };
    return {
      ...vm.perception.imports(enter, leave, STATS ? count : null),
      js_int(frame, node, handle) {
        enter();
        try { return value(frame, node, handle) | 0; } finally { leave(); }
      },
      js_float(frame, node, handle) {
        enter();
        try {
          const v = value(frame, node, handle);
          if (v === undefined) { vm.arena.view.setUint32(vm.undefAt, 1, true); return NaN; }
          return +v;
        } finally { leave(); }
      },
      js_bool(frame, node, handle) {
        enter();
        try { return value(frame, node, handle) ? 1 : 0; } finally { leave(); }
      },
      js_object(frame, node, handle) {
        enter();
        try {
          const v = value(frame, node, handle);
          if (v === undefined) return UNDEFINED;
          if (v !== null && typeof v !== 'object') throw new Error(`Script VM object position holds a ${typeof v}`);
          return handleOf(v);
        } finally { leave(); }
      },
      js_eval(frame, node, handle) {
        enter();
        try {
          const run = vm.frames[frame];
          if (STATS) count(`js effect ${DETAIL ? shape(run, run.nodes[node]) : opName(run.nodes[node])}${vm.whyEffect(run, node, handle)}`);
          run.compiled.nodeEffect(run.nodes[node], run.frame, receiver(run, handle));
        } finally { leave(); }
      },
      js_receiver: handle => vm.receiverInfo(handle),
      // stepCompiled's IteratorNext and IteratorPop on the frame's iterator
      // stack; IteratorNext returns the statement to continue at.
      js_iterator_next(frame) {
        enter();
        try {
          const run = vm.frames[frame], iterators = run.frame.iterators, current = iterators.at(-1);
          if (!current) throw new Error('IteratorNext without an active iterator');
          let target = current.body;
          if (!current.iterator.next()) { iterators.pop(); target = current.after; }
          return run.indexOf.get(target) ?? NEXT_NONE;
        } finally { leave(); }
      },
      js_iterator_pop(frame) {
        enter();
        try {
          if (!vm.frames[frame].frame.iterators.pop()) throw new Error('IteratorPop without an active iterator');
        } finally { leave(); }
      },
      js_accessed_none(frame, node) {
        enter();
        try {
          // The closure's None path: the warning, then the result type's zero
          // (the lowering only types a context whose valueSize is nonzero;
          // zeroContextResult's refusal is kept, its value is the kind's zero).
          const run = vm.frames[frame], n = run.nodes[node], services = run.frame.services;
          services.warning?.({type: 'Accessed None', script: run.compiled.name, offset: n.offset});
          if (!services.zeroContextResult) throw new Error('Null context requires linked result type');
          services.zeroContextResult(run.compiled.script, n.value, n.valueSize);
        } finally { leave(); }
      },
      js_call_begin(frame, node, handle, sig) {
        enter();
        try { return vm.beginCall(frame, node, handle, sig); } finally { leave(); }
      },
      js_step(frame, index) {
        enter();
        try { return vm.step(vm.frames[frame], index); } finally { leave(); }
      },
      // No script runs here: the stack takes (or creates) its next chunk.
      js_frame_advance: size => vm.runtime.frameStack().advance(size),
      // No script runs here either: the row of an attached instance's class.
      js_class_row: handle => vm.classRow(handle),
      // A DYNAMIC_CAST Rust does not decide: the closure's castObject on the
      // evaluated value (SELF is the frame's instance, as `fr.instance`).
      js_cast(frame, node, handle) {
        enter();
        try {
          const run = vm.frames[frame], n = run.nodes[node], s = run.services;
          if (STATS) count('js cast (DynamicCast value in Rust)');
          const target = s.objectReference(run.compiled.script, n.fieldIndex, n);
          return handleOf(s.castObject(handle === run.selfHandle ? run.self : identityOfHandle(handle), target, 'dynamic'));
        } finally { leave(); }
      },
      js_check(frame, node, handle, kind, value) {
        enter();
        if (STATS) count(`SCRIPT_VM_CHECK kind ${kind}`);
        try { vm.check(frame, node, handle, kind, value); } finally { leave(); }
      },
      // R2b-6: a vector or rotator in JavaScript. The lowering admits only
      // nodes whose closure value is a codec copy; anything else is a host
      // fault, as a non-object in an object position is.
      js_vector(frame, node, handle) {
        enter();
        try {
          const v = value(frame, node, handle), view = vm.arena.view, at = vm.vectorAt;
          if (!Array.isArray(v) || v.length !== 3 || !v.every(c => typeof c === 'number' && (c !== c || Math.fround(c) === c)))
            throw new Error(`Script VM vector position holds ${String(v)}`);
          view.setFloat32(at, v[0], true);
          view.setFloat32(at + 4, v[1], true);
          view.setFloat32(at + 8, v[2], true);
        } finally { leave(); }
      },
      js_rotator(frame, node, handle) {
        enter();
        try {
          const v = value(frame, node, handle), view = vm.arena.view, at = vm.vectorAt;
          if (!Array.isArray(v) || v.length !== 3 || !v.every(c => Object.is(c | 0, c)))
            throw new Error(`Script VM rotator position holds ${String(v)}`);
          view.setInt32(at, v[0], true);
          view.setInt32(at + 4, v[1], true);
          view.setInt32(at + 8, v[2], true);
        } finally { leave(); }
      },
      // A name: the id of its folded spelling, as 254/255 and IsA fold it.
      js_name(frame, node, handle) {
        enter();
        try { return nameId(value(frame, node, handle)); } finally { leave(); }
      },
      // No script runs here: the frame's active iterators (a callee's frame
      // object exists once one of its statements ran in JavaScript).
      js_iterators(frame) {
        const run = vm.frames[frame];
        return run.frameObject?.iterators.length ?? 0;
      },
      js_error(frame, code, node) {
        enter();
        const name = vm.frames[frame]?.compiled.displayName ?? 'script';
        switch (code) {
          case 1: throw new Error(`Script resume exceeded the host hang guard in ${name} (the original would not return)`);
          case 2: throw new Error(`Runaway loop detected (over ${SCRIPT_RUNAWAY_LIMIT} iterations) in ${name}`);
          case 3: throw new Error('VM instruction pointer outside script');
          case 5: throw new Error('Original Divide_IntInt signed overflow (x86 divide exception) is unsupported');
          case 6: throw new Error('Original FloatToInt _ftol nonfinite/overflow conversion is not implemented');
          case 7: throw new Error('Original FloatToByte _ftol nonfinite/overflow conversion is not implemented');
          case 8: throw new Error('Return requires compiled iterator unwind');
          default: throw new Error(`Script VM code error ${code} (${node})`);
        }
      },
    };
  }
  /** The lowering of `compiled` for a frame, or null when the frame runs in
   * JavaScript (a function frame without an arena block). State code has no
   * parameters or locals, so it is lowered with the empty layout. */
  lowering(compiled, frame) {
    if (frame.state) return this.loweringFor(compiled, STATE_LAYOUT, frame.services, frame.instance);
    if (!(frame.locals instanceof FrameLocals)) {
      if (STATS) count('frame without block (js)');
      return null;
    }
    return this.loweringFor(compiled, frame.locals.layout, frame.services, frame.instance);
  }
  /** `compiled` lowered for frames with `layout`, cached while the operand
   * epoch, services, layout and field registry are unchanged. `instance`
   * is the running object, for resolving calls on SELF. */
  loweringFor(compiled, layout, services, instance) {
    const epoch = services.operandEpoch();
    let entry = this.lowerings.get(compiled);
    if (!entry || entry.services !== services || entry.epoch !== epoch || entry.layout !== layout ||
      entry.stale?.()) {
      if (entry?.lowered) this.retired.push(entry.lowered);
      const lowered = lowerFunction(compiled, layout, services, this.runtime, instance);
      if (lowered) {
        lowered.code = this.arena.alloc(lowered.bytes);
        new Uint32Array(this.arena.memory.buffer, lowered.code, lowered.words.length).set(lowered.words);
        this.lowered++;
      }
      if (STATS) count(lowered ? 'function lowered' : 'function not lowered');
      entry = {services, epoch, layout, lowered, stale: lowered?.stale ?? null};
      this.lowerings.set(compiled, entry);
    }
    return entry.lowered;
  }
  /** resumeCompiled for a function frame, with lowered statements in Rust. */
  resume(frame, compiled, lowered) {
    if (CHECK) this.runtime.checkMirrors();
    const x = this.exports, selfHandle = handleOf(frame.instance), id = this.depth;
    // A run entered from an import shares BUDGET with the run around it,
    // whose loop keeps its own count: that count is put back on the way out.
    const outerBudget = this.arena.view.getUint32(this.budgetAt, true);
    // Rust pops a callee's frame block after the call; a callee that throws
    // unwinds past that, so the stack is put back here.
    const stack = this.runtime.frameStack(), stackIndex = stack.index, stackTop = stack.top;
    let budget = HANG_BUDGET;
    this.frames[id] = new Run(this, compiled, lowered, frame.instance, frame.services, frame);
    this.depth = id + 1;
    try {
      while (frame.cursor !== null && (!frame.latent || frame.iterators.length) && !frame.returned) {
        const index = lowered.indexOf.get(frame.cursor);
        if (index === undefined) throw new Error('VM instruction pointer outside script');
        const pointer = x.__stack_pointer.value;
        let view = this.arena.view, status;
        view.setUint32(this.runawayAt, scriptRunawayCount(), true);
        view.setUint32(this.budgetAt, budget, true);
        if (STATS) count('vm_run');
        try {
          status = x.vm_run(lowered.code, id, frame.locals.base, selfHandle, index);
        } finally {
          x.__stack_pointer.value = pointer;
          view = this.arena.view;
          setScriptRunaway(view.getUint32(this.runawayAt, true));
          budget = view.getUint32(this.budgetAt, true);
        }
        if (status < 0) {
          frame.result = this.result(lowered.returnKind);
          frame.returned = true;
          frame.cursor = null;
          break;
        }
        // A statement the lowering left to JavaScript: exactly one step of
        // the compiled loop, which advances the cursor before dispatch.
        const entry = lowered.entries[status];
        if (STATS) count(`js statement ${DETAIL ? shape(this.frames[id], entry.node) : opName(entry.node)}`);
        if (!budget--) throw new Error(`Script resume exceeded the host hang guard in ${compiled.displayName} (the original would not return)`);
        frame.cursor = entry.next;
        compiled.step(frame, entry);
      }
      return frame.result;
    } finally {
      this.frames.length = id;
      this.depth = id;
      this.arena.view.setUint32(this.budgetAt, outerBudget, true);
      if (stack.top !== stackTop || stack.index !== stackIndex) stack.restore(stackIndex, stackTop);
      if (!id && this.retired.length) {
        for (const old of this.retired) this.arena.release(old.code, old.bytes);
        this.retired.length = 0;
      }
    }
  }
  /** resumeCompiled for a state frame (R2b-5). The loop is JavaScript's:
   * the hang budget, the cursor lookup and advance, and the latent action,
   * cursor, iterator and return checks between statements, since any
   * statement may start a latent action, go to a label or change state. A
   * statement with lowered work (an effect or a condition not wholly left
   * to JavaScript) runs in Rust through vm_statement; every other one is
   * one step of the compiled loop, as before. */
  resumeState(frame, compiled, lowered) {
    if (CHECK) this.runtime.checkMirrors();
    const x = this.exports, selfHandle = handleOf(frame.instance), id = this.depth, entries = lowered.entries;
    const inRust = lowered.stateStatements ??= stateStatements(lowered.words);
    const outerBudget = this.arena.view.getUint32(this.budgetAt, true);
    const stack = this.runtime.frameStack(), stackIndex = stack.index, stackTop = stack.top;
    let budget = HANG_BUDGET;
    this.frames[id] = new Run(this, compiled, lowered, frame.instance, frame.services, frame);
    this.depth = id + 1;
    try {
      while (frame.cursor !== null && (!frame.latent || frame.iterators.length) && !frame.returned) {
        if (!budget--) throw new Error(`Script resume exceeded the host hang guard in ${compiled.displayName} (the original would not return)`);
        const index = lowered.indexOf.get(frame.cursor);
        if (index === undefined) throw new Error('VM instruction pointer outside script');
        const entry = entries[index];
        frame.cursor = entry.next;
        if (!inRust[index]) {
          if (STATS) count(`js statement ${opName(entry.node)} (state)`);
          compiled.step(frame, entry);
          continue;
        }
        if (STATS) count('state statement in rust');
        const pointer = x.__stack_pointer.value;
        this.arena.view.setUint32(this.runawayAt, scriptRunawayCount(), true);
        let jumped;
        try {
          jumped = x.vm_statement(lowered.code, id, 0, selfHandle, index);
        } finally {
          x.__stack_pointer.value = pointer;
          setScriptRunaway(this.arena.view.getUint32(this.runawayAt, true));
        }
        // stepCompiled's `frame.cursor = n.target` after the condition.
        if (jumped) frame.cursor = entry.node.target;
      }
      return frame.result;
    } finally {
      this.frames.length = id;
      this.depth = id;
      this.arena.view.setUint32(this.budgetAt, outerBudget, true);
      if (stack.top !== stackTop || stack.index !== stackIndex) stack.restore(stackIndex, stackTop);
      if (!id && this.retired.length) {
        for (const old of this.retired) this.arena.release(old.code, old.bytes);
        this.retired.length = 0;
      }
    }
  }
  /** The frame result of a Return in Rust: a void Return leaves the
   * undefined marker, a typed one its value (lowered.returnKind). */
  result(kind) {
    const view = this.arena.view, at = this.resultAt;
    if (view.getUint32(at, true) === 1 && view.getUint32(at + 4, true) === 0x7ff80000) return undefined;
    // R2b-6: a fresh Array, as the closures' vector and rotator values are.
    if (kind === RETURN_VECTOR || kind === RETURN_ROTATOR) {
      const r = this.result3At, read = kind === RETURN_VECTOR ? i => view.getFloat32(r + 4 * i, true) : i => view.getInt32(r + 4 * i, true);
      return [read(0), read(1), read(2)];
    }
    const value = view.getFloat64(at, true);
    return kind === RETURN_BOOL ? value !== 0 : kind === RETURN_OBJECT ? identityOfHandle(value) : value;
  }
  /** js_call_begin: runtime.invoke's resolution and callFunction's checks
   * for a CALL, then the callee's frame block. -1 leaves the whole call to
   * JavaScript (nothing has been evaluated yet); otherwise the callee's run
   * id, with CALL_BLOCK = [locals, code, self handle]. */
  beginCall(callerId, node, handle, sig) {
    const caller = this.frames[callerId], n = caller.nodes[node], runtime = this.runtime, services = caller.services;
    const receiver = handle === caller.selfHandle ? caller.self : this.identity(handle);
    const record = n.op === 0x1c ? services.operand(caller.compiled.script, n)
      : runtime.lookup(receiver, n.name, false);
    const fn = record?.function;
    if (!fn || runtime.boundaryFunctions.has(record.key) || fn.script.nativeIndex || fn.script.functionFlags & 0x400 ||
      fn.script.functionFlags & 0x20 || n.args.length > fn.parameters.length ||
      (receiver?.kind === 'Class' && !runtime.instances.has(receiver))) return this.jsCall(n, 'not eligible');
    const signature = functionSignature(fn, runtime.classLoader);
    if (signature?.id !== sig) return this.jsCall(n, 'signature');
    const layout = frameLayout(fn, runtime.classLoader), lowered = this.loweringFor(fn.compiled, layout, services, receiver);
    if (!lowered) return this.jsCall(n, 'callee not lowered');
    const base = layout.size ? runtime.frameStack().push(layout.size) : 0;
    const view = this.arena.view;
    view.setUint32(this.callAt, base, true);
    view.setUint32(this.callAt + 4, lowered.code, true);
    view.setUint32(this.callAt + 8, handleOf(receiver), true);
    const id = this.depth;
    this.frames[id] = new Run(this, fn.compiled, lowered, receiver, services, null, layout, base, fn.result ?? null);
    this.depth = id + 1;
    if (STATS) count('call in rust');
    return id;
  }
  jsCall(n, why) {
    if (STATS) count(`call in js (${why}) ${opName(n)} ${n.name ?? ''}`);
    return -1;
  }
  /** js_step: one callee statement in JavaScript. RETURNED after a Return
   * (RESULT holds callFunction's copy of the value, or the undefined
   * marker), else the statement to continue at. */
  step(run, index) {
    const frame = run.frame, entry = run.entries[index];
    if (STATS) count(`js statement ${DETAIL ? shape(run, entry.node) : opName(entry.node)} (callee)`);
    frame.cursor = entry.next;
    run.compiled.step(frame, entry);
    if (frame.returned || frame.cursor === null) {
      this.writeResult(run.resultField, frame.result);
      return RETURNED;
    }
    return run.indexOf.get(frame.cursor) ?? NEXT_NONE;
  }
  writeResult(field, value) {
    const view = this.arena.view, at = this.resultAt;
    if (value === undefined || !field) {
      view.setUint32(at, 1, true);
      view.setUint32(at + 4, 0x7ff80000, true);
      return;
    }
    const copied = copyValue(field, value), type = field.metadata.type;
    view.setFloat64(at, type === 'object' || type === 'class' ? handleOf(copied) : type === 'bool' ? (copied ? 1 : 0) : copied, true);
  }
}
