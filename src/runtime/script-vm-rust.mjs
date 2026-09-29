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
import {handleOf, identityOfHandle} from './script-object-handles.mjs';
import {scriptRunawayCount, setScriptRunaway, SCRIPT_RUNAWAY_LIMIT} from './script-vm.mjs';
import {FrameLocals, frameLayout} from './script-frame-locals.mjs';
import {copyValue} from './script-values.mjs';
import {lowerFunction, fieldKeyId, functionSignature} from './script-vm-lower.mjs';

// Receiver info flags (interp.rs).
const BOUND = 1, HOST = 2;
const UNDEFINED = 0xffffffff, NEXT_NONE = 0xffffffff;
const HANG_BUDGET = 200000000;
// SCRIPT_VM_STATS=1: count runs, JavaScript nodes and JavaScript statements
// by original op, printed at exit (coverage of the lowering).
const STATS = typeof process !== 'undefined' && process.env?.SCRIPT_VM_STATS === '1' ? new Map() : null;
const opName = n => n?.op === 'native' ? `native ${n.index}` : typeof n?.op === 'number' ? `0x${n.op.toString(16)}` : String(n?.op);
const CHECK = typeof process !== 'undefined' && process.env?.SCRIPT_VM_CHECK === '1';
const count = key => STATS.set(key, (STATS.get(key) ?? 0) + 1);
// bench-sim clears its measurements after the warm-up ticks.
if (STATS) globalThis.__scriptVmStatsReset = () => STATS.clear();
if (STATS) process.on('exit', () => {
  const rows = [...STATS].sort((a, b) => b[1] - a[1]).slice(0, 60);
  console.error(`script-vm stats:\n${rows.map(([key, n]) => `${String(n).padStart(10)}  ${key}`).join('\n')}`);
});
const RETURN_BOOL = 2, RETURN_FLOAT = 3, RETURN_OBJECT = 4;
const RETURNED = 0xfffffffe;

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
      if (STATS) count(`js value ${opName(run.nodes[node])}${vm.why(run, node, handle)}`);
      return run.compiled.nodeValue(run.nodes[node], run.frame, receiver(run, handle));
    };
    return {
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
          if (STATS) count(`js effect ${opName(run.nodes[node])}${vm.whyEffect(run, node, handle)}`);
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
          default: throw new Error(`Script VM code error ${code} (${node})`);
        }
      },
    };
  }
  /** The lowering of `compiled` for a frame, or null when the frame runs in
   * JavaScript (state code, a frame without an arena block). */
  lowering(compiled, frame) {
    if (frame.state || !(frame.locals instanceof FrameLocals)) {
      if (STATS) count(frame.state ? 'frame state (js)' : 'frame without block (js)');
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
        if (STATS) count(`js statement ${opName(entry.node)}`);
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
  /** The frame result of a Return in Rust: a void Return leaves the
   * undefined marker, a typed one its value (lowered.returnKind). */
  result(kind) {
    const view = this.arena.view, at = this.resultAt;
    if (view.getUint32(at, true) === 1 && view.getUint32(at + 4, true) === 0x7ff80000) return undefined;
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
    if (STATS) count(`js statement ${opName(entry.node)} (callee)`);
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
