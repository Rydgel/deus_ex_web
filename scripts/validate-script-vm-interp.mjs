#!/usr/bin/env node
/**
 * The Rust interpreter (native/script-vm/src/interp.rs, docs/rust-core.md
 * R2b-2) against the JavaScript VM it transcribes. Hand-assembled lowered code
 * (the R2b-2 word format) exercises every kind on a fresh ObjectArena memory
 * with mock imports. Each value is compared with the script-vm.mjs expression
 * for the same original node — native() operator cases, compileEv's
 * conversions and contexts, compileAssign's stores, resumeCompiled's loop —
 * evaluated here in JavaScript on the same operands; each import call is
 * compared (node, receiver, order) with what the closures would evaluate.
 */
import assert from 'node:assert/strict';
import {instantiateScriptVm, loadScriptVmKernel} from '../src/runtime/script-vm-kernel.mjs';
import {ObjectArena, RESERVED} from '../src/runtime/script-object-arena.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {classRecordId} from '../src/runtime/script-vm-lower.mjs';

const K = {
  S_EXPR: 1, S_JUMP: 2, S_JUMP_IF_NOT: 3, S_RETURN: 4, S_NOTHING: 5, S_YIELD: 6, S_ITER_NEXT: 7, S_ITER_POP: 8,
  LIT_INT: 20, LIT_FLOAT: 21, LIT_BOOL: 23, LIT_NONE: 24,
  FIELD_ELEM_INT: 25, FIELD_ELEM_BYTE: 26, FIELD_ELEM_BOOL: 27, FIELD_ELEM_FLOAT: 28, FIELD_ELEM_OBJECT: 29,
  LOCAL_INT: 30, LOCAL_BYTE: 31, LOCAL_BOOL: 32, LOCAL_FLOAT: 33, LOCAL_OBJECT: 34,
  LOCAL_ELEM_INT: 35, LOCAL_ELEM_BYTE: 36, LOCAL_ELEM_BOOL: 37, LOCAL_ELEM_FLOAT: 38, LOCAL_ELEM_OBJECT: 39,
  FIELD_INT: 40, FIELD_BYTE: 41, FIELD_BOOL: 42, FIELD_FLOAT: 43, FIELD_OBJECT: 44,
  DEFAULT_INT: 45, DEFAULT_BYTE: 46, DEFAULT_BOOL: 47, DEFAULT_FLOAT: 48,
  JS_INT: 50, JS_BOOL: 52, JS_FLOAT: 53, JS_OBJECT: 54, JS_VOID: 55, COMPOUND_LOCAL: 56, COMPOUND_FIELD: 57,
  SET_LOCAL_INT: 60, SET_LOCAL_BYTE: 61, SET_LOCAL_BOOL: 62, SET_LOCAL_FLOAT: 63,
  SET_FIELD_INT: 64, SET_FIELD_BYTE: 65, SET_FIELD_BOOL: 66, SET_FIELD_FLOAT: 67, SET_LOCAL_OBJECT: 68, SET_FIELD_OBJECT: 69,
  CONTEXT: 70, SELF: 71, CALL: 72, DYNAMIC_CAST: 73,
  NOT: 80, AND: 81, OR: 82, BOOL_NE: 83, BOOL_EQ: 84,
  INT_ADD: 90, INT_SUB: 91, INT_MUL: 92, INT_LT: 93, INT_GT: 94, INT_DIV: 95, INT_LE: 96, INT_EQ: 97, INT_NE: 98,
  INT_AND: 99, INT_XOR: 100, INT_OR: 101, INT_NEG: 102, INT_NOT: 103, INT_SHL: 104, INT_SAR: 105,
  INT_SHR: 106, INT_MIN: 107, INT_MAX: 108, INT_CLAMP: 109,
  INC_LOCAL_PRE: 110, DEC_LOCAL_PRE: 111, INC_LOCAL_POST: 112, INT_GE: 113,
  FLOAT_MUL: 120, FLOAT_DIV: 121, FLOAT_ADD: 122, FLOAT_SUB: 123, FLOAT_NEG: 124, FLOAT_LT: 125,
  FLOAT_GT: 126, FLOAT_LE: 127, FLOAT_GE: 128, FLOAT_EQ: 129, FLOAT_NE: 130, FLOAT_NEAR: 131, FLOAT_MIN: 132, FLOAT_MAX: 133,
  OBJECT_EQ: 140, OBJECT_NE: 141,
  BYTE_TO_INT: 150, INT_TO_BYTE: 151, INT_TO_FLOAT: 152, BYTE_TO_FLOAT: 153, FLOAT_TO_INT: 154, FLOAT_TO_BYTE: 155,
};
const ERR = {HANG: 1, RUNAWAY: 2, OUTSIDE: 3, KIND: 4, DIV_OVERFLOW: 5, FLOAT_TO_INT: 6, FLOAT_TO_BYTE: 7};
const R = {VOID: 0, INT: 1, BOOL: 2, FLOAT: 3, OBJECT: 4};
const P = {SKIP: 0, INT: 1, BOOL: 2, FLOAT: 3, OBJECT: 4, BYTE: 5};
const RETURNED = 0xfffffffe, HANG_BUDGET = 200_000_000;
const NEXT_NONE = 0xffffffff, UNDEFINED = 0xffffffff, BOUND = 1, HOST = 2;
// The handle class table (R2b-5): a released handle; a row's unreadable
// default image; js_check value kinds.
const RELEASED = 1, UNREADABLE = 1;
const CK = {INT: 1, BOOL: 2, FLOAT: 3, OBJECT: 4, CAST: 5};
const RUNAWAY_LIMIT = 10_000_000;
const f = Math.fround;

// ---- Memory and instance ------------------------------------------------
const arena = new ObjectArena();
const CODE = [arena.alloc(0x10000), arena.alloc(0x10000)];
// Callee functions' code (the CALL section).
const FN_CODE = Array.from({length: 12}, () => arena.alloc(0x1000));
const LOCALS = arena.alloc(256), INNER_LOCALS = arena.alloc(256);
const SELF_IMG = arena.alloc(256), OTHER_IMG = arena.alloc(256), THIRD_IMG = arena.alloc(256), INNER_IMG = arena.alloc(256);
const BOUND_TABLE = arena.alloc(64);
const SELF_H = 7, OTHER_H = 9, THIRD_H = 11, INNER_H = 13;
const FRAME = 42, INNER_FRAME = 43;
assert.equal(CODE[0], RESERVED, 'the first arena allocation is at the reserved boundary');

class VmError extends Error {
  constructor(frame, code, node) { super(`js_error ${code} (node ${node})`); Object.assign(this, {frame, code, node}); }
}
const handlers = new Map(), infos = new Map(), calls = [];
let nextNode = 1000;
/** A node id whose JS evaluation is `fn(receiver, frame)`. */
const node = (fn = () => { throw new Error('node evaluated unexpectedly'); }) => {
  const id = nextNode++;
  handlers.set(id, fn);
  return id;
};
const evaluate = (n, receiver, frame) => {
  const fn = handlers.get(n);
  if (!fn) throw new Error(`unknown node ${n}`);
  return fn(receiver, frame);
};
const view = () => arena.view;
const rd32 = at => view().getUint32(at, true);
const wr32 = (at, v) => view().setUint32(at, v >>> 0, true);
const imports = {
  js_int(frame, n, receiver) { calls.push({imp: 'int', frame, node: n, receiver}); return evaluate(n, receiver, frame) | 0; },
  js_float(frame, n, receiver) {
    calls.push({imp: 'float', frame, node: n, receiver});
    const v = evaluate(n, receiver, frame);
    // The host protocol (script-vm-rust.mjs): undefined sets FLOAT_UNDEF.
    if (v === undefined) { wr32(UNDEF_AT, 1); return NaN; }
    return +v;
  },
  js_bool(frame, n, receiver) { calls.push({imp: 'bool', frame, node: n, receiver}); return evaluate(n, receiver, frame) ? 1 : 0; },
  js_object(frame, n, receiver) {
    calls.push({imp: 'object', frame, node: n, receiver});
    const v = evaluate(n, receiver, frame);
    return v === undefined ? UNDEFINED : v === null ? 0 : v;
  },
  js_eval(frame, n, receiver) { calls.push({imp: 'eval', frame, node: n, receiver}); evaluate(n, receiver, frame); },
  js_receiver(handle) { calls.push({imp: 'receiver', receiver: handle}); return infos.get(handle) ?? HOST; },
  js_accessed_none(frame, n) { calls.push({imp: 'none', frame, node: n}); },
  js_error(frame, code, n) { calls.push({imp: 'error', frame, code, node: n}); throw new VmError(frame, code, n); },
  // The host's iterator stack (script-vm-rust.mjs): each entry scripts its
  // next() results and the statements it continues at.
  js_iterator_next(frame) {
    calls.push({imp: 'iterNext', frame});
    const current = iterators.at(-1);
    if (!current) throw new Error('IteratorNext without an active iterator');
    if (current.results.shift()) return current.body;
    iterators.pop();
    return current.after;
  },
  js_iterator_pop(frame) {
    calls.push({imp: 'iterPop', frame});
    if (!iterators.pop()) throw new Error('IteratorPop without an active iterator');
  },
  // Script calls (the R2b-3 host): a call site either resolves to a lowered
  // function, whose frame block is pushed with Rust's FrameStack push
  // (vm_frame_push) and described in CALL_BLOCK, or takes the JavaScript path.
  // A begun callee raises the host's run count (FRAMES[3]), as
  // script-vm-rust.mjs does; Rust puts it back with the frame stack.
  js_call_begin(frame, n, receiver, sig) {
    calls.push({imp: 'callBegin', frame, node: n, receiver, sig, frames: framesKey()});
    const site = callSites.get(n);
    if (!site) throw new Error(`unknown call site ${n}`);
    if (!site.target) return -1;
    const target = site.target, base = x.vm_frame_push(target.size), id = nextFrameId++;
    frameInfo.set(id, {target, base, self: receiver});
    wr32(FRAMES_AT + 12, rd32(FRAMES_AT + 12) + 1);
    wr32(CALL_BLOCK_AT, base);
    wr32(CALL_BLOCK_AT + 4, target.code);
    wr32(CALL_BLOCK_AT + 8, receiver);
    return id;
  },
  js_step(frame, index) {
    calls.push({imp: 'step', frame, index});
    const info = frameInfo.get(frame);
    const step = info?.target.steps[index];
    if (!step) throw new Error(`no JavaScript step ${index} on frame ${frame}`);
    return step(info);
  },
  // FrameStack.advance (script-frame-locals.mjs) over chunks that start dirty.
  js_frame_advance(size) {
    calls.push({imp: 'advance', size});
    let index = (rd32(FRAMES_AT) | 0) + 1;
    while (index < chunks.length && chunks[index].size < size) index++;
    if (index === chunks.length) {
      const chunkSize = Math.max(CHUNK, size), base = arena.alloc(chunkSize);
      arena.bytes.fill(0xaa, base, base + chunkSize);
      chunks.push({base, size: chunkSize});
    }
    const chunk = chunks[index];
    wr32(FRAMES_AT, index);
    wr32(FRAMES_AT + 4, chunk.base);
    wr32(FRAMES_AT + 8, chunk.base + chunk.size);
  },
  // The host's handle class table (script-vm-rust.mjs classRow): a test
  // installs `classRowHost` to describe handles; none describes nothing.
  js_class_row(handle) {
    calls.push({imp: 'classRow', receiver: handle});
    return classRowHost ? classRowHost(handle) : 0;
  },
  // castObject in JavaScript on the evaluated value: the node's handler
  // receives the value handle as its receiver.
  js_cast(frame, n, handle) {
    calls.push({imp: 'cast', frame, node: n, receiver: handle});
    const v = evaluate(n, handle, frame);
    return v === null ? 0 : v;
  },
  js_check(frame, n, handle, kind, v) { calls.push({imp: 'check', frame, node: n, receiver: handle, kind, value: v}); },
};
let classRowHost = null;
const iterators = [];
const CHUNK = 64, chunks = [], callSites = new Map(), frameInfo = new Map();
let nextFrameId = 100;
const framesKey = () => `${rd32(FRAMES_AT) | 0},${rd32(FRAMES_AT + 4)},${rd32(FRAMES_AT + 8)}`;
const x = await instantiateScriptVm(arena.memory, imports);
assert.ok(x.__heap_base.value <= RESERVED, 'statics below the reserved boundary');
const RUNAWAY_AT = x.vm_runaway_ptr(), BUDGET_AT = x.vm_budget_ptr(), RESULT_AT = x.vm_result_ptr();
const UNDEF_AT = x.vm_float_undef_ptr(), KEYS_AT = x.vm_bound_keys_ptr();
const FRAMES_AT = x.vm_frames_ptr(), CALL_BLOCK_AT = x.vm_call_block_ptr();
const CLASSES_AT = x.vm_classes_ptr(), CHECK_AT = x.vm_check_ptr();
// Bound keys: the table marks keys 3 and 20, but only keys below 16 count.
wr32(KEYS_AT, BOUND_TABLE);
wr32(KEYS_AT + 4, 16);
arena.bytes[BOUND_TABLE + 3] = 1;
arena.bytes[BOUND_TABLE + 20] = 1;

function reset() {
  handlers.clear();
  nextNode = 1000;
  calls.length = 0;
  infos.clear();
  infos.set(SELF_H, SELF_IMG).set(OTHER_H, OTHER_IMG).set(THIRD_H, THIRD_IMG).set(INNER_H, INNER_IMG);
  wr32(UNDEF_AT, 0);
  for (const base of [LOCALS, INNER_LOCALS, SELF_IMG, OTHER_IMG, THIRD_IMG, INNER_IMG]) arena.bytes.fill(0, base, base + 256);
  if (callSites.size || frameInfo.size) {
    callSites.clear();
    frameInfo.clear();
    nextFrameId = 100;
  }
  // An empty FrameStack (index -1); its chunks are dirty until pushed.
  wr32(FRAMES_AT, -1);
  wr32(FRAMES_AT + 4, 0);
  wr32(FRAMES_AT + 8, 0);
  wr32(FRAMES_AT + 12, 0);
  for (const chunk of chunks) arena.bytes.fill(0xaa, chunk.base, chunk.base + chunk.size);
  // No handle class table (every handle live, none described), CHECK off.
  wr32(CLASSES_AT, 0);
  wr32(CLASSES_AT + 4, 0);
  wr32(CHECK_AT, 0);
  classRowHost = null;
}
const count = (imp, receiver) => calls.filter(c => c.imp === imp && (receiver === undefined || c.receiver === receiver)).length;

// ---- Assembler ------------------------------------------------------------
const used = new Set();
/** One node: its kind, then operand words and sub-expression word arrays. */
const w = (kind, ...parts) => (used.add(kind), [kind, ...parts.flat()]);
const E = {
  int: v => w(K.LIT_INT, v >>> 0),
  float: bitsValue => w(K.LIT_FLOAT, bitsValue >>> 0),
  bool: v => w(K.LIT_BOOL, v ? 1 : 0),
  none: () => w(K.LIT_NONE),
  self: () => w(K.SELF),
  context: (n, object, value) => w(K.CONTEXT, n, value.length, object, value),
  and: (a, b) => w(K.AND, b.length, a, b),
  or: (a, b) => w(K.OR, b.length, a, b),
  setField: (kind, offset, n, key, value, mask) => kind === K.SET_FIELD_BOOL
    ? w(kind, offset, n, key, value.length, mask, value) : w(kind, offset, n, key, value.length, value),
};
const S = {
  expr: effect => w(K.S_EXPR, effect),
  jump: target => w(K.S_JUMP, target),
  jumpIfNot: (target, condition) => w(K.S_JUMP_IF_NOT, target, condition),
  ret: (rkind, expr = []) => w(K.S_RETURN, rkind, expr),
  nothing: () => w(K.S_NOTHING),
  yield: () => w(K.S_YIELD),
  iterNext: () => w(K.S_ITER_NEXT),
  iterPop: () => w(K.S_ITER_POP),
};
function assembleAt(base, statements, next) {
  const n = statements.length, words = [n];
  let pc = 1 + 2 * n;
  for (let i = 0; i < n; i++) {
    words.push(pc, next ? next[i] : i + 1 < n ? i + 1 : NEXT_NONE);
    pc += statements[i].length;
  }
  for (const s of statements) words.push(...s);
  new Uint32Array(arena.memory.buffer, base, words.length).set(words.map(v => v >>> 0));
  return base;
}
const assemble = (statements, {slot = 0, next} = {}) => assembleAt(CODE[slot], statements, next);
/** vm_run with the host's stack-pointer discipline. */
function enter(fn) {
  const sp = x.__stack_pointer.value;
  try { return fn(); } finally { x.__stack_pointer.value = sp; }
}
function run(statements, {entry = 0, self = SELF_H, locals = LOCALS, frame = FRAME, budget = 1_000_000, runaway = 0, slot = 0, next} = {}) {
  const code = assemble(statements, {slot, next});
  wr32(BUDGET_AT, budget);
  wr32(RUNAWAY_AT, runaway);
  return enter(() => x.vm_run(code, frame, locals, self, entry));
}
function result(rkind) {
  if (rd32(RESULT_AT) === 1 && rd32(RESULT_AT + 4) === 0x7ff80000) return undefined;
  const v = view().getFloat64(RESULT_AT, true);
  if (rkind === R.BOOL) { assert.ok(v === 0 || v === 1, `bool RESULT ${v}`); return v === 1; }
  return v;
}
/** The value of one typed expression through S_RETURN. */
function value(rkind, expr, options) {
  assert.equal(run([S.ret(rkind, expr)], options), -1);
  return result(rkind);
}
/** An object expression, observed as the receiver its context hands a JS_INT
 * (0 when the object is None or undefined). */
function objectOf(expr) {
  const n = node(receiver => receiver);
  return value(R.INT, E.context(node(), expr, w(K.JS_INT, n))) >>> 0;
}
function vmError(fn) {
  try { fn(); } catch (error) { if (error instanceof VmError) return error; throw error; }
  assert.fail('expected a js_error');
}

let checks = 0;
const same = (actual, expected, message) => {
  assert.ok(Object.is(actual, expected), `${message}: Rust ${String(actual)}, JavaScript ${String(expected)}`);
  checks++;
};

// ---- Operands ---------------------------------------------------------------
const f32io = new DataView(new ArrayBuffer(4));
const bits = v => (f32io.setFloat32(0, v, true), f32io.getUint32(0, true));
const num = b => (f32io.setUint32(0, b >>> 0, true), f32io.getFloat32(0, true));
let seed = 0x9e3779b9;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
let operandIndex = 0;

const INTS = [0, 1, -1, 2, -2, 5, -7, 31, 32, 33, 63, 64, -31, -32, -33, 255, 256, 0x7fff, 0x8000, 0xffff,
  0x7fffffff, -0x80000000, -0x7fffffff, 0x40000000, 123456789, -987654321];
/** An int operand as a literal, a JS_INT or a local. */
function intOperand(v) {
  const i = operandIndex++;
  if (i % 3 === 0) return E.int(v);
  if (i % 3 === 1) return w(K.JS_INT, node(() => v));
  const offset = 0x80 + (i % 16) * 4;
  wr32(LOCALS + offset, v);
  return w(K.LOCAL_INT, offset);
}
// Doubles the closures can carry (JS_FLOAT results are not always float32),
// float32 edges, and undefined.
const FLOATS = [0, -0, 1, -1, 0.5, 0.1, -0.1, 1 / 3, 2 / 3, 1.5, 2.5, 100, -100, 1e-7, 1e10, NaN, Infinity, -Infinity,
  2 ** -149, -(2 ** -149), 2 ** -126, 2 ** -127 * 1.5, 5e-324, -5e-324, 3.4028234663852886e38, -3.4028234663852886e38,
  3.4028235677973366e38, 1e300, -1e300, 1e-300, 16777216, 16777217, 1 + 2 ** -24, 1 + 2 ** -23, 1 + 2 ** -24 + 2 ** -52,
  0.0001, 0.00009999999747378752, 0.0001000000047497451, undefined];
const FLOAT_BITS = [0x7fc00000, 0xffc00000, 0x7f800001, 0x7fa00000, 0xffffffff, 0x00000001, 0x807fffff, 0x7f7fffff];
/** A float operand: {words, js}, `js` being the value the closure holds. */
function floatOperand(v) {
  const i = operandIndex++;
  if (v !== undefined && Object.is(f(v), v) && !Number.isNaN(v) && i % 2 === 0) return {words: E.float(bits(v)), js: v};
  return {words: w(K.JS_FLOAT, node(() => v)), js: v};
}
const floatBitsOperand = b => ({words: E.float(b), js: num(b)});
const floatOperands = () => [...FLOATS.map(v => () => floatOperand(v)), ...FLOAT_BITS.map(b => () => floatBitsOperand(b))];
const randomFloatOperand = () => {
  const r = random() % 3;
  if (r === 0) return floatBitsOperand(random());
  if (r === 1) return floatOperand((random() / 2 ** 32 - 0.5) * 2 ** ((random() % 80) - 40));
  return floatOperand(FLOATS[random() % FLOATS.length]);
};

// ---- Literals, locals, SELF -------------------------------------------------
reset();
same(value(R.INT, E.int(0xffffffff)), -1, 'LIT_INT 0xffffffff');
same(value(R.INT, E.int(0x7fffffff)), 0x7fffffff, 'LIT_INT max');
same(value(R.BOOL, E.bool(1)), true, 'LIT_BOOL 1');
same(value(R.BOOL, E.bool(0)), false, 'LIT_BOOL 0');
same(value(R.FLOAT, E.float(0x80000000)), -0, 'LIT_FLOAT -0');
same(value(R.FLOAT, E.float(bits(0.1))), f(0.1), 'LIT_FLOAT 0.1');
wr32(LOCALS + 8, -5);
same(value(R.INT, w(K.LOCAL_INT, 8)), -5, 'LOCAL_INT');
wr32(LOCALS + 12, 0x00ff7f80);
same(value(R.INT, w(K.LOCAL_BYTE, 12)), 0x80, 'LOCAL_BYTE is unsigned');
same(value(R.INT, w(K.LOCAL_BYTE, 14)), 0xff, 'LOCAL_BYTE 0xff');
wr32(LOCALS + 16, 0x8000000a);
same(value(R.BOOL, w(K.LOCAL_BOOL, 16, 2)), true, 'LOCAL_BOOL mask 2');
same(value(R.BOOL, w(K.LOCAL_BOOL, 16, 4)), false, 'LOCAL_BOOL mask 4');
same(value(R.BOOL, w(K.LOCAL_BOOL, 16, 0x80000000)), true, 'LOCAL_BOOL mask bit 31');
for (const b of [bits(0.1), 0x80000000, 0x00000001, 0x7f800000, 0x7fc00001]) {
  wr32(LOCALS + 20, b);
  same(value(R.FLOAT, w(K.LOCAL_FLOAT, 20)), num(b), `LOCAL_FLOAT ${b.toString(16)}`);
}
wr32(LOCALS + 24, OTHER_H);
same(objectOf(w(K.LOCAL_OBJECT, 24)), OTHER_H, 'LOCAL_OBJECT');
same(objectOf(E.self()), SELF_H, 'SELF');
reset();
same(value(R.INT, E.context(node(), E.self(), w(K.JS_INT, node(r => r))), {self: 0x12345}), 0x12345, 'SELF is the run\'s self handle');
same(objectOf(E.none()), 0, 'LIT_NONE');
same(count('none'), 1, 'LIT_NONE context reports Accessed None');

// ---- Int operators (native() cases) -----------------------------------------
const INT_BINARY = new Map([
  [K.INT_ADD, (a, b) => ((a | 0) + (b | 0)) | 0],        // native 146
  [K.INT_SUB, (a, b) => ((a | 0) - (b | 0)) | 0],        // 147
  [K.INT_MUL, (a, b) => Math.imul(a | 0, b | 0)],        // 144
  [K.INT_AND, (a, b) => (a | 0) & (b | 0)],              // 156
  [K.INT_XOR, (a, b) => (a | 0) ^ (b | 0)],              // 157
  [K.INT_OR, (a, b) => (a | 0) | (b | 0)],               // 158
  [K.INT_SHL, (a, b) => (a | 0) << (b | 0)],             // 148
  [K.INT_SAR, (a, b) => (a | 0) >> (b | 0)],             // 149
  [K.INT_SHR, (a, b) => ((a | 0) >>> (b | 0)) | 0],      // 196
  [K.INT_MIN, (a, b) => Math.min(a | 0, b | 0)],         // 249
  [K.INT_MAX, (a, b) => Math.max(a | 0, b | 0)],         // 250
  [K.INT_DIV, (a, b) => {                                // 145
    const dividend = a | 0, divisor = b | 0;
    if (divisor === 0) return 0;
    if (dividend === -0x80000000 && divisor === -1) return 'overflow';
    return (Math.trunc(dividend / divisor)) | 0;
  }],
]);
const INT_COMPARE = new Map([
  [K.INT_LT, (a, b) => (a | 0) < (b | 0)],               // 150
  [K.INT_GT, (a, b) => (a | 0) > (b | 0)],               // 151
  [K.INT_LE, (a, b) => (a | 0) <= (b | 0)],              // 152 (script-decoration-primitives.mjs)
  [K.INT_GE, (a, b) => (a | 0) >= (b | 0)],              // 153 (script-decoration-primitives.mjs)
  [K.INT_EQ, (a, b) => (a | 0) === (b | 0)],             // 154
  [K.INT_NE, (a, b) => (a | 0) !== (b | 0)],             // 155
]);
const intPairs = [];
for (const a of INTS) for (const b of INTS) intPairs.push([a, b]);
for (let i = 0; i < 3000; i++) intPairs.push([random() | 0, i % 2 ? random() | 0 : (random() % 80) - 40]);
for (const [kind, reference] of INT_BINARY) {
  for (const [a, b] of intPairs) {
    reset();
    const expected = reference(a, b), expr = w(kind, intOperand(a), intOperand(b));
    if (expected === 'overflow') {
      const error = vmError(() => value(R.INT, expr));
      same(error.code, ERR.DIV_OVERFLOW, `INT_DIV(${a}, ${b}) error`);
      same(error.node, 0, 'INT_DIV error node');
    } else same(value(R.INT, expr), expected, `kind ${kind}(${a}, ${b})`);
  }
}
for (const [kind, reference] of INT_COMPARE) {
  for (const [a, b] of intPairs) {
    reset();
    same(value(R.BOOL, w(kind, intOperand(a), intOperand(b))), reference(a, b), `kind ${kind}(${a}, ${b})`);
  }
}
for (const a of [...INTS, ...Array.from({length: 500}, () => random() | 0)]) {
  reset();
  same(value(R.INT, w(K.INT_NEG, intOperand(a))), (-(a | 0)) | 0, `INT_NEG(${a})`);    // native 143
  same(value(R.INT, w(K.INT_NOT, intOperand(a))), ~(a | 0), `INT_NOT(${a})`);          // 141
}
const CLAMP_INTS = [0, 1, -1, 5, -7, 100, 0x7fffffff, -0x80000000, 255];
for (const a of CLAMP_INTS) for (const b of CLAMP_INTS) for (const c of CLAMP_INTS) {
  reset();
  // native 251
  const expected = (a | 0) < (b | 0) ? b | 0 : (a | 0) < (c | 0) ? a | 0 : c | 0;
  same(value(R.INT, w(K.INT_CLAMP, intOperand(a), intOperand(b), intOperand(c))), expected, `INT_CLAMP(${a}, ${b}, ${c})`);
}
// Operands evaluate left to right, each with SELF as receiver.
reset();
{
  const [p, q, r] = [node(() => 1), node(() => 2), node(() => 3)];
  same(value(R.INT, w(K.INT_CLAMP, w(K.JS_INT, p), w(K.JS_INT, q), w(K.JS_INT, r))), 2, 'INT_CLAMP value');
  same(calls.map(c => c.node).join(), [p, q, r].join(), 'operands left to right');
  same(calls.every(c => c.receiver === SELF_H && c.frame === FRAME), true, 'imports get the frame id and SELF');
}

// ---- Conversions (compileEv 0x3a/0x3c/0x3d/0x3f/0x43/0x44) -------------------
const CONVERT_INTS = [...INTS, 16777217, 16777219, 16777218, 33554435, 2147483520, 2147483584, 2147483583, -2147483584,
  -16777217, 0x7ffffffe, ...Array.from({length: 500}, () => random() | 0)];
for (const a of CONVERT_INTS) {
  reset();
  same(value(R.INT, w(K.BYTE_TO_INT, intOperand(a))), a & 255, `BYTE_TO_INT(${a})`);
  same(value(R.INT, w(K.INT_TO_BYTE, intOperand(a))), a & 255, `INT_TO_BYTE(${a})`);
  same(value(R.FLOAT, w(K.INT_TO_FLOAT, intOperand(a))), f(a | 0), `INT_TO_FLOAT(${a})`);
  same(value(R.FLOAT, w(K.BYTE_TO_FLOAT, intOperand(a))), f(a & 255), `BYTE_TO_FLOAT(${a})`);
}
const TO_INT_FLOATS = [...FLOATS, 2 ** 31, 2 ** 31 + 256, -(2 ** 31) - 256, 2 ** 32 + 512, 2 ** 40 + 4096, 2 ** 53, 2 ** 62,
  2 ** 63, -(2 ** 63), 9.2233715e18, 9.223371e18, -9.2233715e18, -9.223373e18, 1e19, -1e19, 0.99999, -0.99999, 255.9,
  256.5, -1.5, -255.5, 4294967295.5, 1e12 + 0.5];
const ftol = (v, mask) => {                              // compileEv 0x44 / 0x43
  const x = f(v);
  if (!Number.isFinite(x) || x < -(2 ** 63) || x >= 2 ** 63) return 'error';
  return mask ? Math.trunc(x) & 255 : Math.trunc(x) | 0;
};
for (const make of [...TO_INT_FLOATS.map(v => () => floatOperand(v)), ...FLOAT_BITS.map(b => () => floatBitsOperand(b)),
  ...Array.from({length: 1000}, () => randomFloatOperand)]) {
  for (const [kind, mask, code] of [[K.FLOAT_TO_INT, false, ERR.FLOAT_TO_INT], [K.FLOAT_TO_BYTE, true, ERR.FLOAT_TO_BYTE]]) {
    reset();
    const operand = make(), expected = ftol(operand.js, mask), expr = w(kind, operand.words);
    if (expected === 'error') {
      const error = vmError(() => value(R.INT, expr));
      same(error.code, code, `kind ${kind}(${operand.js}) error`);
    } else same(value(R.INT, expr), expected, `kind ${kind}(${operand.js})`);
  }
}

// ---- Float operators (native() cases) ---------------------------------------
const isNaN = Number.isNaN;
const FLOAT_BINARY = new Map([
  [K.FLOAT_MUL, (a, b) => f(a * b)],                     // native 171
  [K.FLOAT_DIV, (a, b) => f(a / b)],                     // 172
  [K.FLOAT_ADD, (a, b) => f(a + b)],                     // 174
  [K.FLOAT_SUB, (a, b) => f(a - b)],                     // 175
  [K.FLOAT_MIN, (a, b) => a > b ? b : a],                // 244
  [K.FLOAT_MAX, (a, b) => a >= b ? a : b],               // 245
]);
const FLOAT_COMPARE = new Map([
  [K.FLOAT_LT, (a, b) => a < b],                         // 176
  [K.FLOAT_GT, (a, b) => a > b],                         // 177
  [K.FLOAT_GE, (a, b) => a >= b],                        // 179
  // 178 (script-decoration-primitives.mjs): undefined counts as 0 before the
  // fround, unlike the raw 176/177/179; unordered is true.
  [K.FLOAT_LE, (a, b) => !(f(a ?? 0) > f(b ?? 0))],
  [K.FLOAT_EQ, (a, b) => { const x = f(a), y = f(b); return isNaN(x) || isNaN(y) || x === y; }],     // 180
  [K.FLOAT_NE, (a, b) => { const x = f(a), y = f(b); return !(isNaN(x) || isNaN(y) || x === y); }],  // 181
  [K.FLOAT_NEAR, (a, b) => { const x = f(a), y = f(b), d = x - y; return isNaN(d) || Math.abs(d) < 0.0001; }], // 210
]);
const floatPairs = [];
for (const a of floatOperands()) for (const b of floatOperands()) floatPairs.push([a, b]);
for (let i = 0; i < 3000; i++) floatPairs.push([randomFloatOperand, randomFloatOperand]);
for (const [kind, reference] of FLOAT_BINARY) {
  for (const [makeA, makeB] of floatPairs) {
    reset();
    const a = makeA(), b = makeB();
    same(value(R.FLOAT, w(kind, a.words, b.words)), reference(a.js, b.js), `kind ${kind}(${a.js}, ${b.js})`);
  }
}
for (const [kind, reference] of FLOAT_COMPARE) {
  for (const [makeA, makeB] of floatPairs) {
    reset();
    const a = makeA(), b = makeB();
    same(value(R.BOOL, w(kind, a.words, b.words)), reference(a.js, b.js), `kind ${kind}(${a.js}, ${b.js})`);
  }
}
for (const make of [...floatOperands(), ...Array.from({length: 1000}, () => randomFloatOperand)]) {
  reset();
  const a = make();
  same(value(R.FLOAT, w(K.FLOAT_NEG, a.words)), f(-f(a.js)), `FLOAT_NEG(${a.js})`);        // 169
}
// FLOAT_NEAR subtracts in double: an exact difference in [0.0001, the
// float32 rounding midpoint) is not near, though its float32 would be.
{
  const x = f(0.0001000000047497451), y = f(4e-12), d = x - y;
  assert.ok(d >= 0.0001 && f(d) < 0.0001, 'NEAR edge operands');
  reset();
  same(value(R.BOOL, w(K.FLOAT_NEAR, E.float(bits(x)), E.float(bits(y)))), false, 'FLOAT_NEAR double difference');
  reset();
  same(value(R.BOOL, w(K.FLOAT_NEAR, E.float(bits(y)), E.float(bits(x)))), false, 'FLOAT_NEAR double difference, negative');
}
reset();
same(value(R.FLOAT, w(K.FLOAT_NEG, E.float(0x80000000))), 0, 'FLOAT_NEG(-0) is +0');
same(value(R.FLOAT, w(K.FLOAT_NEG, E.float(0))), -0, 'FLOAT_NEG(+0) is -0');
// The FMin/FMax results are the raw operands (a JS double stays unrounded).
reset();
same(value(R.FLOAT, w(K.FLOAT_MIN, floatOperand(0.1).words, floatOperand(NaN).words)), 0.1, 'FMin(0.1, NaN) is a');
reset();
same(value(R.FLOAT, w(K.FLOAT_MIN, floatOperand(NaN).words, floatOperand(0.1).words)), NaN, 'FMin(NaN, 0.1) is a');
reset();
same(value(R.FLOAT, w(K.FLOAT_MAX, floatOperand(0.1).words, floatOperand(NaN).words)), NaN, 'FMax(0.1, NaN) is b');
reset();
same(value(R.FLOAT, w(K.FLOAT_MAX, floatOperand(NaN).words, floatOperand(0.1).words)), 0.1, 'FMax(NaN, 0.1) is b');

// ---- Bool operators ------------------------------------------------------------
for (const a of [false, true]) {
  reset();
  same(value(R.BOOL, w(K.NOT, E.bool(a))), !a, `NOT(${a})`);                              // 129
  same(value(R.BOOL, w(K.NOT, w(K.JS_BOOL, node(() => a ? 'x' : 0)))), !a, `NOT(JS ${a})`);
  for (const b of [false, true]) {
    same(value(R.BOOL, w(K.BOOL_EQ, E.bool(a), E.bool(b))), Boolean(a) === Boolean(b), `BOOL_EQ(${a}, ${b})`); // 242
    same(value(R.BOOL, w(K.BOOL_NE, E.bool(a), E.bool(b))), Boolean(a) !== Boolean(b), `BOOL_NE(${a}, ${b})`); // 243/131
  }
}
// AndAnd/OrOr (130/132): a && Boolean(Skip operand): the operand after a
// deciding first value is never evaluated, and evaluation resumes after it.
for (const kind of [K.AND, K.OR]) for (const a of [false, true]) for (const b of [false, true]) {
  reset();
  let evaluated = 0, after = 0;
  const expected = kind === K.AND ? a && b : a || b;
  const second = w(K.BOOL_EQ, w(K.JS_BOOL, node(() => (evaluated++, b))), w(K.NOT, E.bool(0)));
  const expr = w(K.BOOL_EQ, (kind === K.AND ? E.and : E.or)(w(K.JS_BOOL, node(() => a)), second),
    w(K.JS_BOOL, node(() => (after++, expected))));
  same(value(R.BOOL, expr), true, `kind ${kind}(${a}, ${b}) value`);
  same(evaluated, (kind === K.AND ? a : !a) ? 1 : 0, `kind ${kind}(${a}, ${b}) second operand evaluations`);
  same(after, 1, `kind ${kind}(${a}, ${b}) resumes after the skipped operand`);
}

// ---- Object compare (native 114/119: a === b) ---------------------------------
{
  const identity = {[SELF_H]: {}, [OTHER_H]: {}};
  const OBJECTS = [
    [() => E.none(), null],
    [() => E.self(), identity[SELF_H]],
    [() => (wr32(LOCALS + 40, OTHER_H), w(K.LOCAL_OBJECT, 40)), identity[OTHER_H]],
    [() => w(K.JS_OBJECT, node(() => OTHER_H)), identity[OTHER_H]],
    [() => w(K.JS_OBJECT, node(() => undefined)), undefined],
    [() => w(K.JS_OBJECT, node(() => null)), null],
  ];
  for (const [makeA, ja] of OBJECTS) for (const [makeB, jb] of OBJECTS) {
    reset();
    same(value(R.BOOL, w(K.OBJECT_EQ, makeA(), makeB())), ja === jb, 'OBJECT_EQ');
    reset();
    same(value(R.BOOL, w(K.OBJECT_NE, makeA(), makeB())), ja !== jb, 'OBJECT_NE');
  }
}

// ---- Context (compileEv 0x12/0x19) --------------------------------------------
for (const [rkind, zero, makeValue] of [
  [R.INT, 0, n => w(K.JS_INT, n)], [R.FLOAT, 0, n => w(K.JS_FLOAT, n)], [R.BOOL, false, n => w(K.JS_BOOL, n)],
]) {
  for (const makeObject of [() => E.none(), () => w(K.JS_OBJECT, node(() => undefined)), () => w(K.JS_OBJECT, node(() => null))]) {
    reset();
    const contextNode = node(), skipped = node();
    const expr = E.context(contextNode, makeObject(), makeValue(skipped));
    same(value(rkind, expr), zero, `None context result (return kind ${rkind})`);
    same(count('none'), 1, 'None context reports Accessed None once');
    same(calls.find(c => c.imp === 'none').node, contextNode, 'Accessed None names the context node');
    same(calls.find(c => c.imp === 'none').frame, FRAME, 'Accessed None gets the frame id');
    same(calls.some(c => c.node === skipped), false, 'None context never evaluates its value');
    same(count('receiver'), 0, 'None context fetches no receiver info');
  }
}
reset();
{
  // A None object context: zero object; evaluation resumes after the value.
  const tail = node(() => 5);
  same(value(R.INT, w(K.INT_ADD, E.context(node(), E.none(), w(K.JS_INT, node())), w(K.JS_INT, tail))), 5, 'None context then operand');
  reset();
  same(value(R.BOOL, w(K.OBJECT_EQ, E.context(node(), E.none(), w(K.FIELD_OBJECT, 0, node(), 1)), E.none())), true,
    'None context in an object position is None');
}
reset();
{
  // Non-None: the value is evaluated with the context object as receiver; an
  // operator's operands (compileNative) use SELF; the object child uses the
  // current receiver (a nested context's object sees the outer object).
  const probe = node(r => r);
  wr32(LOCALS + 44, OTHER_H);
  same(value(R.INT, E.context(node(), w(K.LOCAL_OBJECT, 44), w(K.JS_INT, probe))), OTHER_H, 'context value receiver');
  same(count('receiver', OTHER_H), 1, 'context receiver info fetched once');
  reset();
  const p = node(r => r), q = node(r => r);
  same(value(R.INT, E.context(node(), w(K.JS_OBJECT, node(() => OTHER_H)), w(K.INT_ADD, w(K.JS_INT, p), w(K.JS_INT, q)))),
    2 * SELF_H, 'operator operands under a context use SELF');
  reset();
  const outer = node(r => (calls.push({imp: 'seen-outer', receiver: r}), OTHER_H));
  const nested = node(r => (calls.push({imp: 'seen-inner', receiver: r}), THIRD_H));
  const leaf = node(r => r);
  same(value(R.INT, E.context(node(), w(K.JS_OBJECT, outer), E.context(node(), w(K.JS_OBJECT, nested), w(K.JS_INT, leaf)))),
    THIRD_H, 'nested context leaf receiver');
  same(calls.find(c => c.imp === 'seen-outer').receiver, SELF_H, 'outer object child evaluated with SELF');
  same(calls.find(c => c.imp === 'seen-inner').receiver, OTHER_H, 'inner object child evaluated with the outer object');
  reset();
  // A context of a context object: context(context(A, B), C).
  const a = node(r => (calls.push({imp: 'seen-a', receiver: r}), OTHER_H));
  const b = node(r => (calls.push({imp: 'seen-b', receiver: r}), THIRD_H));
  same(value(R.INT, E.context(node(), E.context(node(), w(K.JS_OBJECT, a), w(K.JS_OBJECT, b)), w(K.JS_INT, node(r => r)))), THIRD_H,
    'context of a context');
  same(calls.find(c => c.imp === 'seen-b').receiver, OTHER_H, 'B evaluated with A');
  // Fields of a context receiver use its own info.
  reset();
  wr32(OTHER_IMG + 0x10, 321);
  wr32(LOCALS + 44, OTHER_H);
  same(value(R.INT, E.context(node(), w(K.LOCAL_OBJECT, 44), w(K.FIELD_INT, 0x10, node(), 1))), 321, 'context field fast path');
  same(count('receiver', SELF_H), 0, 'context field does not fetch SELF info');
  reset();
  infos.set(OTHER_H, OTHER_IMG | HOST);
  wr32(LOCALS + 44, OTHER_H);
  const host = node(r => r + 1000);
  same(value(R.INT, E.context(node(), w(K.LOCAL_OBJECT, 44), w(K.FIELD_INT, 0x10, host, 1))), OTHER_H + 1000, 'context field HOST path');
}

// ---- Fields: fast path, HOST, BOUND + bound keys --------------------------------
function fieldImage(base) {
  wr32(base + 0x10, -123);
  wr32(base + 0x14, 0xfe00);
  wr32(base + 0x18, 0b100);
  wr32(base + 0x1c, bits(0.1));
  wr32(base + 0x20, OTHER_H);
}
const FIELD_READS = [
  // [return kind, expr for (key, node), fast value, host handler value, JS-path expectation]
  [R.INT, (key, n) => w(K.FIELD_INT, 0x10, n, key), -123, 77, 77],
  [R.INT, (key, n) => w(K.FIELD_BYTE, 0x15, n, key), 0xfe, 300, 300],
  [R.BOOL, (key, n) => w(K.FIELD_BOOL, 0x18, n, key, 4), true, 0, false],
  [R.BOOL, (key, n) => w(K.FIELD_BOOL, 0x18, n, key, 2), false, 'yes', true],
  [R.FLOAT, (key, n) => w(K.FIELD_FLOAT, 0x1c, n, key), f(0.1), 0.3, 0.3],
];
for (const [flags, key, jsPath] of [
  [0, 3, false], [HOST, 4, true], [BOUND, 3, true], [BOUND, 4, false], [BOUND, 20, false], [0, 20, false], [BOUND | HOST, 4, true],
]) {
  for (const [rkind, make, fast, hostValue, jsValue] of FIELD_READS) {
    reset();
    fieldImage(SELF_IMG);
    infos.set(SELF_H, SELF_IMG | flags);
    const n = node(() => hostValue);
    same(value(rkind, make(key, n)), jsPath ? jsValue : fast, `field read flags ${flags} key ${key}`);
    same(calls.filter(c => c.node === n).length, jsPath ? 1 : 0, `field read flags ${flags} key ${key} import`);
    if (jsPath) same(calls.find(c => c.node === n).receiver, SELF_H, 'field JS path receiver');
  }
  reset();
  fieldImage(SELF_IMG);
  infos.set(SELF_H, SELF_IMG | flags);
  const n = node(() => THIRD_H);
  same(objectOf(w(K.FIELD_OBJECT, 0x20, n, key)), jsPath ? THIRD_H : OTHER_H, `FIELD_OBJECT flags ${flags} key ${key}`);
}

// ---- SELF info caching ------------------------------------------------------------
{
  const a = () => w(K.FIELD_INT, 0x10, node(() => 1000), 1), b = () => w(K.FIELD_INT, 0x14, node(() => 2000), 1);
  const setup = () => { reset(); wr32(SELF_IMG + 0x10, 5); wr32(SELF_IMG + 0x14, 7); wr32(OTHER_IMG + 0x10, 11); wr32(LOCALS + 44, OTHER_H); };
  setup();
  same(value(R.INT, w(K.INT_ADD, a(), b())), 12, 'two SELF fields');
  same(count('receiver', SELF_H), 1, 'SELF info cached between field reads');
  setup();
  same(value(R.INT, w(K.INT_ADD, a(), w(K.INT_ADD, w(K.JS_INT, node(() => 100)), b()))), 112, 'import between');
  same(count('receiver', SELF_H), 2, 'SELF info refetched after js_int');
  setup();
  same(value(R.INT, w(K.INT_ADD, a(), w(K.INT_ADD, E.context(node(), w(K.LOCAL_OBJECT, 44), w(K.FIELD_INT, 0x10, node(), 1)), b()))),
    23, 'context between');
  same(count('receiver', SELF_H), 1, 'js_receiver does not stale SELF info');
  same(count('receiver', OTHER_H), 1, 'context info fetched once');
  setup();
  same(value(R.INT, w(K.INT_ADD, a(), w(K.INT_ADD, E.context(node(), E.none(), w(K.JS_INT, node())), b()))), 12, 'None between');
  same(count('receiver', SELF_H), 2, 'SELF info refetched after js_accessed_none');
  setup();
  // The refetched info takes effect: SELF became HOST inside the import.
  same(value(R.INT, w(K.INT_ADD, a(), w(K.INT_ADD, w(K.JS_INT, node(() => (infos.set(SELF_H, HOST), 0))), b()))), 2005,
    'field after SELF turned HOST');
  for (const [name, between] of [
    ['js_float', () => S.expr(w(K.SET_LOCAL_FLOAT, 48, w(K.JS_FLOAT, node(() => 1))))],
    ['js_bool', () => S.expr(w(K.SET_LOCAL_BOOL, 48, 1, w(K.JS_BOOL, node(() => 1))))],
    ['js_object', () => S.expr(w(K.SET_LOCAL_BOOL, 48, 1, w(K.OBJECT_EQ, w(K.JS_OBJECT, node(() => 0)), E.none())))],
    ['js_eval', () => S.expr(w(K.JS_VOID, node(() => {})))],
    ['nothing', () => S.nothing()],
  ]) {
    setup();
    run([S.expr(w(K.SET_LOCAL_INT, 0, a())), between(), S.ret(R.INT, b())]);
    same(result(R.INT), 7, `${name} statement between`);
    same(count('receiver', SELF_H), name === 'nothing' ? 1 : 2, `SELF info across statements with ${name}`);
  }
  setup();
  value(R.INT, a());
  value(R.INT, a());
  same(count('receiver', SELF_H), 2, 'each run fetches SELF info');
}

// ---- Stores ---------------------------------------------------------------------
const floatStore = v => bits(f(Number(v ?? 0)));       // the float codec: Math.fround(Number(v ?? 0))
{
  reset();
  run([S.expr(w(K.SET_LOCAL_INT, 0x40, E.int(-5))), S.ret(R.VOID)]);
  same(rd32(LOCALS + 0x40), (-5) >>> 0, 'SET_LOCAL_INT');
  for (const [v, expected] of [[0x1ff, 0xaabbffdd], [-2, 0xaabbfedd], [0x80, 0xaabb80dd]]) {
    reset();
    wr32(LOCALS + 0x44, 0xaabbccdd);
    run([S.expr(w(K.SET_LOCAL_BYTE, 0x45, intOperand(v))), S.ret(R.VOID)]);
    same(rd32(LOCALS + 0x44), expected, `SET_LOCAL_BYTE ${v}`);
  }
  for (const [initial, mask, v, expected] of [[0xf0f0, 0x100, 1, 0xf1f0], [0xf0f0, 0x10, 0, 0xf0e0], [0xffffffff, 0x80000000, 0, 0x7fffffff]]) {
    reset();
    wr32(LOCALS + 0x48, initial);
    run([S.expr(w(K.SET_LOCAL_BOOL, 0x48, mask, E.bool(v))), S.ret(R.VOID)]);
    same(rd32(LOCALS + 0x48), expected, `SET_LOCAL_BOOL mask ${mask} ${v}`);
  }
  // The word is merged after the value is evaluated.
  reset();
  wr32(LOCALS + 0x48, 0x1);
  run([S.expr(w(K.SET_LOCAL_BOOL, 0x48, 0x4, w(K.JS_BOOL, node(() => (wr32(LOCALS + 0x48, 0x10000001), true))))), S.ret(R.VOID)]);
  same(rd32(LOCALS + 0x48), 0x10000005, 'SET_LOCAL_BOOL merges the word after the value');
  for (const make of [...floatOperands(), ...Array.from({length: 300}, () => randomFloatOperand)]) {
    reset();
    const operand = make();
    run([S.expr(w(K.SET_LOCAL_FLOAT, 0x4c, operand.words)), S.ret(R.VOID)]);
    const stored = rd32(LOCALS + 0x4c), expected = floatStore(operand.js);
    if (isNaN(num(expected))) same(isNaN(num(stored)), true, `SET_LOCAL_FLOAT ${operand.js} stores a NaN`);
    else same(stored, expected, `SET_LOCAL_FLOAT ${operand.js}`);
  }
  // Increment/decrement preoperators and the postoperator (native 163/164/165).
  for (const [kind, reference] of [
    [K.INC_LOCAL_PRE, a => { const v = ((a | 0) + 1) | 0; return [v, v]; }],
    [K.DEC_LOCAL_PRE, a => { const v = ((a | 0) - 1) | 0; return [v, v]; }],
    [K.INC_LOCAL_POST, a => [a | 0, ((a | 0) + 1) | 0]],
  ]) {
    for (const a of [0, 5, -1, 0x7fffffff, -0x80000000]) {
      reset();
      wr32(LOCALS + 0x50, a);
      const [returned, stored] = reference(a);
      same(value(R.INT, w(kind, 0x50)), returned, `kind ${kind}(${a}) value`);
      same(rd32(LOCALS + 0x50) | 0, stored, `kind ${kind}(${a}) store`);
      reset();
      wr32(LOCALS + 0x50, a);
      run([S.expr(w(kind, 0x50)), S.ret(R.INT, w(K.LOCAL_INT, 0x50))]);
      same(result(R.INT), stored, `kind ${kind}(${a}) as a statement`);
    }
  }
}
{
  // SET_FIELD: the fast path stores into SELF's image.
  const letNode = () => node(() => { throw new Error('the Let node must not run on the fast path'); });
  const cases = [
    [K.SET_FIELD_INT, 0x10, () => E.int(-9), undefined, base => rd32(base + 0x10) | 0, -9],
    [K.SET_FIELD_BYTE, 0x15, () => E.int(0x1cd), undefined, base => rd32(base + 0x14), 0xababcdab],
    [K.SET_FIELD_BOOL, 0x18, () => E.bool(1), 0x40, base => rd32(base + 0x18), 0xabababeb],
    [K.SET_FIELD_BOOL, 0x18, () => E.bool(0), 0x20, base => rd32(base + 0x18), 0xabababab & ~0x20],
    [K.SET_FIELD_FLOAT, 0x1c, () => floatOperand(0.1).words, undefined, base => rd32(base + 0x1c), bits(f(0.1))],
    [K.SET_FIELD_FLOAT, 0x1c, () => floatOperand(undefined).words, undefined, base => rd32(base + 0x1c), 0],
  ];
  for (const [kind, offset, makeValue, mask, read, expected] of cases) {
    reset();
    for (let i = 0x10; i < 0x20; i += 4) wr32(SELF_IMG + i, 0xabababab);
    run([S.expr(E.setField(kind, offset, letNode(), 4, makeValue(), mask)), S.ret(R.VOID)]);
    same(read(SELF_IMG) >>> 0, expected >>> 0, `kind ${kind} fast store`);
    same(count('eval'), 0, `kind ${kind} fast path runs no Let node`);
    // The JavaScript path: HOST, or BOUND with a bound key. The value words
    // are skipped unevaluated and the Let node runs with SELF.
    for (const [flags, key] of [[HOST, 4], [BOUND, 3]]) {
      reset();
      for (let i = 0x10; i < 0x20; i += 4) wr32(SELF_IMG + i, 0xabababab);
      infos.set(SELF_H, SELF_IMG | flags);
      let ran = 0;
      const n = node((receiver, frame) => { ran++; same(receiver, SELF_H, 'Let receiver'); same(frame, FRAME, 'Let frame'); });
      const skipped = node();
      const skippedValue = kind === K.SET_FIELD_FLOAT ? w(K.FLOAT_ADD, w(K.JS_FLOAT, skipped), E.float(0))
        : kind === K.SET_FIELD_BOOL ? w(K.NOT, w(K.JS_BOOL, skipped)) : w(K.INT_ADD, w(K.JS_INT, skipped), E.int(1));
      run([S.expr(E.setField(kind, offset, n, key, skippedValue, mask)), S.ret(R.INT, E.int(99))]);
      same(result(R.INT), 99, `kind ${kind} JS path continues after the skipped value`);
      same(ran, 1, `kind ${kind} JS path runs the Let node once`);
      same(calls.some(c => c.node === skipped), false, `kind ${kind} JS path skips the value`);
      same(rd32(SELF_IMG + 0x18), 0xabababab, `kind ${kind} JS path leaves the image`);
    }
  }
  // Storage is selected before the value: the value's import moves SELF's
  // image (and makes it HOST), yet the store lands at the address chosen first.
  for (const kind of [K.SET_FIELD_INT, K.SET_FIELD_BYTE, K.SET_FIELD_BOOL, K.SET_FIELD_FLOAT]) {
    for (const moved of [OTHER_IMG, OTHER_IMG | HOST]) {
      reset();
      const move = () => infos.set(SELF_H, moved);
      const valueWords = kind === K.SET_FIELD_FLOAT ? w(K.JS_FLOAT, node(() => (move(), 1)))
        : kind === K.SET_FIELD_BOOL ? w(K.JS_BOOL, node(() => (move(), 1))) : w(K.JS_INT, node(() => (move(), 42)));
      run([S.expr(E.setField(kind, 0x10, node(), 4, valueWords, 1)), S.ret(R.VOID)]);
      same(rd32(SELF_IMG + 0x10), kind === K.SET_FIELD_FLOAT ? bits(1) : kind === K.SET_FIELD_BOOL ? 1 : 42,
        `kind ${kind} stores at the storage selected before the value`);
      same(rd32(OTHER_IMG + 0x10), 0, `kind ${kind} does not follow a moved image`);
      same(count('eval'), 0, `kind ${kind} selected fast storage runs no Let node`);
      same(count('receiver', SELF_H), 1, `kind ${kind} selects SELF's storage once`);
    }
  }
  // The bool word is merged after the value.
  reset();
  wr32(SELF_IMG + 0x18, 1);
  run([S.expr(E.setField(K.SET_FIELD_BOOL, 0x18, node(), 4, w(K.JS_BOOL, node(() => (wr32(SELF_IMG + 0x18, 0x100), 1))), 2)), S.ret(R.VOID)]);
  same(rd32(SELF_IMG + 0x18), 0x102, 'SET_FIELD_BOOL merges the word after the value');
}

// ---- FLOAT_LE (native 178): operand order and the `?? 0` edge ------------------------
{
  reset();
  const [p, q] = [node(() => 2), node(() => 1)];
  same(value(R.BOOL, w(K.FLOAT_LE, w(K.JS_FLOAT, p), w(K.JS_FLOAT, q))), false, 'FLOAT_LE(2, 1)');
  same(calls.map(c => c.node).join(), [p, q].join(), 'FLOAT_LE operands left to right');
  same(calls.every(c => c.receiver === SELF_H && c.frame === FRAME), true, 'FLOAT_LE operands with SELF');
  // undefined is 0 for 178 only: -1e-45 <= undefined, while 179's raw
  // undefined >= -1e-45 is false and a NaN (not undefined) stays unordered.
  for (const [kind, a, b, expected] of [
    [K.FLOAT_LE, undefined, 0, true], [K.FLOAT_LE, 0, undefined, true], [K.FLOAT_LE, undefined, -(2 ** -149), false],
    [K.FLOAT_LE, 2 ** -149, undefined, false], [K.FLOAT_LE, NaN, -1, true], [K.FLOAT_LE, 1, NaN, true],
    [K.FLOAT_GE, undefined, -1, false], [K.FLOAT_LT, undefined, 1, false], [K.FLOAT_GT, 1, undefined, false],
    // The fround: two doubles rounding to one float32 compare equal.
    [K.FLOAT_LE, 1 + 2 ** -25, 1, true], [K.FLOAT_LE, 1 + 2 ** -23 - 2 ** -41, 1 + 2 ** -23 - 2 ** -40, true],
  ]) {
    reset();
    same(value(R.BOOL, w(kind, w(K.JS_FLOAT, node(() => a)), w(K.JS_FLOAT, node(() => b)))), expected, `kind ${kind}(${a}, ${b})`);
  }
}

// ---- Object stores (compileAssign: copyPointer, then the POINTER cell's handle) ---------
{
  const BIG_H = 0xfffffffe;
  // [object expr, the handle word the JavaScript store writes]
  const OBJECT_VALUES = [
    [() => E.none(), 0],
    [() => E.self(), SELF_H],
    [() => (wr32(LOCALS + 40, OTHER_H), w(K.LOCAL_OBJECT, 40)), OTHER_H],
    [() => w(K.JS_OBJECT, node(() => OTHER_H)), OTHER_H],
    [() => w(K.JS_OBJECT, node(() => BIG_H)), BIG_H],
    [() => w(K.JS_OBJECT, node(() => undefined)), 0],
    [() => w(K.JS_OBJECT, node(() => null)), 0],
    [() => (wr32(SELF_IMG + 0x20, THIRD_H), w(K.FIELD_OBJECT, 0x20, node(), 4)), THIRD_H],
    [() => w(K.FIELD_OBJECT, 0x20, node(() => undefined), 3), 0],
    [() => E.context(node(), E.none(), w(K.JS_OBJECT, node())), 0],
    [() => E.context(node(), w(K.JS_OBJECT, node(() => OTHER_H)), w(K.JS_OBJECT, node(() => undefined))), 0],
  ];
  const letNode = () => node(() => { throw new Error('the Let node must not run on the fast path'); });
  for (const [makeValue, handle] of OBJECT_VALUES) {
    for (const bound of [0, BOUND]) {
      reset();
      infos.set(SELF_H, SELF_IMG | bound);
      wr32(LOCALS + 0x70, 0xdeadbeef);
      run([S.expr(w(K.SET_LOCAL_OBJECT, 0x70, makeValue())), S.ret(R.VOID)]);
      same(rd32(LOCALS + 0x70), handle, `SET_LOCAL_OBJECT stores ${handle}`);
      same(rd32(LOCALS + 0x74), 0, 'SET_LOCAL_OBJECT writes one word');
      reset();
      infos.set(SELF_H, SELF_IMG | bound);
      wr32(SELF_IMG + 0x24, 0xdeadbeef);
      run([S.expr(E.setField(K.SET_FIELD_OBJECT, 0x24, letNode(), 4, makeValue())), S.ret(R.VOID)]);
      same(rd32(SELF_IMG + 0x24), handle, `SET_FIELD_OBJECT stores ${handle}`);
      same(rd32(SELF_IMG + 0x28), 0, 'SET_FIELD_OBJECT writes one word');
      same(count('eval'), 0, 'SET_FIELD_OBJECT fast path runs no Let node');
    }
  }
  // The value is evaluated with SELF (a Let's right side).
  reset();
  run([S.expr(w(K.SET_LOCAL_OBJECT, 0x70, w(K.JS_OBJECT, node((r, frame) => (same(frame, FRAME, 'object value frame'), r))))), S.ret(R.VOID)]);
  same(rd32(LOCALS + 0x70), SELF_H, 'SET_LOCAL_OBJECT value receiver');
  // The JavaScript path: the value words are skipped unevaluated and the Let
  // node runs with SELF; the image keeps its word.
  for (const [flags, key] of [[HOST, 4], [BOUND, 3], [BOUND | HOST, 20]]) {
    reset();
    infos.set(SELF_H, SELF_IMG | flags);
    wr32(SELF_IMG + 0x24, 0xdeadbeef);
    let ran = 0;
    const n = node((receiver, frame) => { ran++; same(receiver, SELF_H, 'object Let receiver'); same(frame, FRAME, 'object Let frame'); });
    const skipped = node();
    const valueWords = E.context(node(), w(K.JS_OBJECT, skipped), w(K.JS_OBJECT, skipped));
    run([S.expr(E.setField(K.SET_FIELD_OBJECT, 0x24, n, key, valueWords)), S.ret(R.INT, E.int(99))]);
    same(result(R.INT), 99, `SET_FIELD_OBJECT JS path (flags ${flags}) continues`);
    same(ran, 1, 'SET_FIELD_OBJECT JS path runs the Let node once');
    same(calls.filter(c => c.imp === 'eval').map(c => c.node).join(), String(n), 'SET_FIELD_OBJECT JS path evaluates the Let node');
    same(calls.some(c => c.node === skipped), false, 'SET_FIELD_OBJECT JS path skips the value');
    same(rd32(SELF_IMG + 0x24), 0xdeadbeef, 'SET_FIELD_OBJECT JS path leaves the image');
  }
  // Storage before the value: the value's import moves SELF's image.
  for (const moved of [OTHER_IMG, OTHER_IMG | HOST]) {
    reset();
    const v = node(() => (infos.set(SELF_H, moved), THIRD_H));
    run([S.expr(E.setField(K.SET_FIELD_OBJECT, 0x24, node(), 4, w(K.JS_OBJECT, v))), S.ret(R.VOID)]);
    same(rd32(SELF_IMG + 0x24), THIRD_H, 'SET_FIELD_OBJECT stores at the storage selected before the value');
    same(rd32(OTHER_IMG + 0x24), 0, 'SET_FIELD_OBJECT does not follow a moved image');
    same(count('eval'), 0, 'SET_FIELD_OBJECT selected storage runs no Let node');
    same(calls.findIndex(c => c.imp === 'receiver') < calls.findIndex(c => c.node === v), true,
      'SET_FIELD_OBJECT selects storage before the value');
  }
}

// ---- Compound assignment (out natives 184/185/182/161/162) ---------------------------------
// compileNative evaluates argument 0 as a reference (the storage), then
// argument 1's value, then native() reads the target (refValue), computes and
// stores through the reference: the float codec Math.fround(Number(v ?? 0))
// then setFloat32, or the int codec Number(v) | 0 then setInt32.
{
  const OP = {FLOAT_ADD: 1, FLOAT_SUB: 2, FLOAT_MUL: 3, INT_ADD: 4, INT_SUB: 5};
  const COMPOUND_FLOAT = new Map([
    [OP.FLOAT_ADD, (a, b) => f(a + b)],                  // native 184
    [OP.FLOAT_SUB, (a, b) => f(f(a) - f(b))],            // 185
    [OP.FLOAT_MUL, (a, b) => f(a * b)],                  // 182
  ]);
  const COMPOUND_INT = new Map([
    [OP.INT_ADD, (a, b) => ((a | 0) + (b | 0)) | 0],     // 161
    [OP.INT_SUB, (a, b) => ((a | 0) - (b | 0)) | 0],     // 162
  ]);
  const LOCAL_AT = 0x60, FIELD_AT = 0x30, FIELD_KEY = 4;
  /** A compound statement on the local or SELF field at the target offset. */
  const compound = (op, onField, valueWords, n = node(() => { throw new Error('the out native must not run in JavaScript'); }), key = FIELD_KEY) =>
    onField ? w(K.COMPOUND_FIELD, op, FIELD_AT, n, key, valueWords.length, valueWords) : w(K.COMPOUND_LOCAL, op, LOCAL_AT, valueWords);
  const targetAt = onField => onField ? SELF_IMG + FIELD_AT : LOCALS + LOCAL_AT;
  // The reference's get: readCell's getFloat32, then the codec's copyFloat.
  const floatTarget = b => f(Number(num(b) ?? 0));
  const f32store = v => (f32io.setFloat32(0, f(Number(v ?? 0)), true), f32io.getUint32(0, true));
  const TARGET_BITS = [0, 0x80000000, bits(1), bits(-1), bits(0.1), bits(1.5), bits(-2.5), bits(100), 0x3f800001, 0x4b800000,
    0x00000001, 0x80000001, 0x807fffff, 0x00800000, 0x7f7fffff, 0xff7fffff, 0x7f800000, 0xff800000,
    0x7fc00000, 0xffc00000, 0x7fc00001, 0xffe12345, 0x7f800001, 0x7fa00000, 0x7fbfffff, 0xffffffff];
  const floatCases = [];
  for (const target of TARGET_BITS) for (const make of floatOperands()) floatCases.push([target, make]);
  for (let i = 0; i < 1500; i++) floatCases.push([random() % 4 ? random() : TARGET_BITS[random() % TARGET_BITS.length], randomFloatOperand]);
  let nanStores = 0;
  for (const [op, reference] of COMPOUND_FLOAT) {
    for (const [target, make] of floatCases) {
      for (const onField of [false, true]) {
        reset();
        const operand = make(), at = targetAt(onField);
        wr32(at, target);
        run([S.expr(compound(op, onField, operand.words)), S.ret(R.VOID)]);
        const expected = f32store(reference(floatTarget(target), operand.js));
        if (isNaN(num(expected))) nanStores++;
        same(rd32(at), expected, `compound ${op} ${onField ? 'field' : 'local'} 0x${target.toString(16)} op ${operand.js}`);
      }
    }
  }
  assert.ok(nanStores > 1000, 'the float sweep stores NaN payloads');
  const intCases = [];
  for (const a of INTS) for (const b of INTS) intCases.push([a, b]);
  for (let i = 0; i < 2000; i++) intCases.push([random() | 0, i % 2 ? random() | 0 : (random() % 80) - 40]);
  for (const [op, reference] of COMPOUND_INT) {
    for (const [a, b] of intCases) {
      for (const onField of [false, true]) {
        reset();
        const at = targetAt(onField);
        wr32(at, a);
        run([S.expr(compound(op, onField, intOperand(b))), S.ret(R.VOID)]);
        same(rd32(at) | 0, reference(a, b), `compound ${op} ${onField ? 'field' : 'local'} ${a}, ${b}`);
      }
    }
  }
  // Explicit edges: the marker is JavaScript's undefined, NaN in arithmetic
  // (never the store's 0); a target NaN keeps its payload; signed zeros;
  // overflow to infinity; subnormal results.
  for (const [op, target, b, expectedBits, message] of [
    [OP.FLOAT_ADD, bits(1), undefined, 0x7fc00000, '1 += undefined is NaN'],
    [OP.FLOAT_SUB, bits(1), undefined, 0x7fc00000, '1 -= undefined is NaN'],
    [OP.FLOAT_MUL, bits(1), undefined, 0x7fc00000, '1 *= undefined is NaN'],
    [OP.FLOAT_ADD, 0x7fa00000, undefined, 0x7fe00000, 'sNaN target += undefined keeps its payload, quieted'],
    [OP.FLOAT_SUB, 0xffe12345, undefined, 0xffe12345, 'NaN target -= undefined keeps its payload'],
    [OP.FLOAT_ADD, 0x80000000, -0, 0x80000000, '-0 += -0 is -0'],
    [OP.FLOAT_ADD, 0x80000000, 0, 0, '-0 += 0 is +0'],
    [OP.FLOAT_SUB, 0, 0, 0, '0 -= 0 is +0'],
    [OP.FLOAT_SUB, 0x80000000, 0, 0x80000000, '-0 -= 0 is -0'],
    [OP.FLOAT_MUL, 0, -1, 0x80000000, '0 *= -1 is -0'],
    [OP.FLOAT_ADD, 0x7f7fffff, 3.4028235677973366e38, 0x7f800000, 'max += a double overflowing float32'],
    [OP.FLOAT_MUL, 0x7f7fffff, 2, 0x7f800000, 'max *= 2 is infinity'],
    [OP.FLOAT_MUL, 0x00800000, 0.5, 0x00400000, 'min normal *= 0.5 is subnormal'],
    [OP.FLOAT_SUB, 0x00800001, 2 ** -126, 0x00000001, 'subnormal difference'],
    [OP.FLOAT_MUL, 0x00000001, 0.5, 0, 'min subnormal *= 0.5 rounds to even 0'],
    [OP.FLOAT_ADD, bits(1), 2 ** -24 + 2 ** -52, 0x3f800001, '184 rounds a + b once'],
    [OP.FLOAT_SUB, bits(1), 1 + 2 ** -24 + 2 ** -52, 0xb4000000, '185 rounds b before subtracting'],
  ]) {
    for (const onField of [false, true]) {
      reset();
      const at = targetAt(onField);
      wr32(at, target);
      run([S.expr(compound(op, onField, w(K.JS_FLOAT, node(() => b)))), S.ret(R.VOID)]);
      same(f32store(COMPOUND_FLOAT.get(op)(floatTarget(target), b)), expectedBits, `${message} (JavaScript)`);
      same(rd32(at), expectedBits, `${message} (${onField ? 'field' : 'local'})`);
    }
  }
  // The marker reaching the value through a HOST field read (js_float's
  // FLOAT_UNDEF protocol) and through FMin, which returns it raw.
  for (const onField of [false, true]) {
    reset();
    infos.set(OTHER_H, OTHER_IMG | HOST);
    wr32(LOCALS + 44, OTHER_H);
    const at = targetAt(onField);
    wr32(at, bits(2));
    run([S.expr(compound(OP.FLOAT_MUL, onField, E.context(node(), w(K.LOCAL_OBJECT, 44), w(K.FIELD_FLOAT, 0x1c, node(() => undefined), 1)))),
      S.ret(R.VOID)]);
    same(rd32(at), f32store(f(2 * undefined)), `*= an undefined HOST field (${onField ? 'field' : 'local'})`);
    same(rd32(UNDEF_AT), 0, 'FLOAT_UNDEF cleared');
    reset();
    wr32(at, bits(2));
    run([S.expr(compound(OP.FLOAT_ADD, onField, w(K.FLOAT_MIN, w(K.JS_FLOAT, node(() => undefined)), E.float(bits(5))))), S.ret(R.VOID)]);
    same(rd32(at), f32store(f(2 + (undefined > 5 ? 5 : undefined))), `+= FMin(undefined, 5) (${onField ? 'field' : 'local'})`);
  }
  // Order: the value is evaluated (with SELF) before the target is read, so a
  // value that writes the target is seen by the read; the storage is selected
  // before the value.
  for (const [op, reference] of [...COMPOUND_FLOAT, ...COMPOUND_INT]) {
    const isFloat = COMPOUND_FLOAT.has(op);
    for (const onField of [false, true]) {
      reset();
      const at = targetAt(onField);
      wr32(at, isFloat ? bits(1) : 1);
      let seen = null;
      const v = node((r, frame) => {
        seen = {r, frame, fetched: count('receiver', SELF_H)};
        wr32(at, isFloat ? bits(10) : 10);
        return isFloat ? 0.3 : 3;
      });
      run([S.expr(compound(op, onField, w(isFloat ? K.JS_FLOAT : K.JS_INT, v))), S.ret(R.VOID)]);
      const expected = isFloat ? f32store(reference(10, 0.3)) : reference(10, 3) >>> 0;
      same(rd32(at), expected, `compound ${op} ${onField ? 'field' : 'local'} reads the target after the value`);
      same(seen.r, SELF_H, 'compound value receiver');
      same(seen.frame, FRAME, 'compound value frame');
      same(seen.fetched, onField ? 1 : 0, `compound ${op} ${onField ? 'field storage selected' : 'local selects no field'} before the value`);
      // The value's import moves SELF's image: the read and the store stay
      // at the storage selected first.
      if (onField) for (const moved of [OTHER_IMG, OTHER_IMG | HOST]) {
        reset();
        wr32(SELF_IMG + FIELD_AT, isFloat ? bits(1) : 1);
        wr32(OTHER_IMG + FIELD_AT, isFloat ? bits(1000) : 1000);
        const mv = node(() => (infos.set(SELF_H, moved), isFloat ? 0.3 : 3));
        run([S.expr(compound(op, true, w(isFloat ? K.JS_FLOAT : K.JS_INT, mv))), S.ret(R.VOID)]);
        same(rd32(SELF_IMG + FIELD_AT), isFloat ? f32store(reference(1, 0.3)) : reference(1, 3) >>> 0,
          `compound ${op} uses the storage selected before the value`);
        same(rd32(OTHER_IMG + FIELD_AT), isFloat ? bits(1000) : 1000, `compound ${op} does not follow a moved image`);
        same(count('eval'), 0, `compound ${op} selected fast storage runs no JavaScript`);
        same(count('receiver', SELF_H), 1, `compound ${op} selects SELF's storage once`);
      }
    }
  }
  // The field JavaScript path (HOST, or BOUND with a bound key): the value
  // words are skipped unevaluated and the out native's call node runs whole.
  for (const op of [...COMPOUND_FLOAT.keys(), ...COMPOUND_INT.keys()]) {
    const isFloat = COMPOUND_FLOAT.has(op);
    for (const [flags, key] of [[HOST, FIELD_KEY], [BOUND, 3], [BOUND | HOST, 20]]) {
      reset();
      infos.set(SELF_H, SELF_IMG | flags);
      wr32(SELF_IMG + FIELD_AT, 0xabababab);
      let ran = 0;
      const n = node((receiver, frame) => { ran++; same(receiver, SELF_H, 'out native receiver'); same(frame, FRAME, 'out native frame'); });
      const skipped = node();
      const valueWords = isFloat ? w(K.FLOAT_ADD, w(K.JS_FLOAT, skipped), E.float(0)) : w(K.INT_ADD, w(K.JS_INT, skipped), E.int(1));
      run([S.expr(compound(op, true, valueWords, n, key)), S.ret(R.INT, E.int(99))]);
      same(result(R.INT), 99, `compound ${op} JS path (flags ${flags}) continues`);
      same(ran, 1, `compound ${op} JS path runs the call node once`);
      same(calls.filter(c => c.imp === 'eval').map(c => c.node).join(), String(n), `compound ${op} JS path evaluates the call node`);
      same(calls.some(c => c.node === skipped), false, `compound ${op} JS path skips the value`);
      same(rd32(SELF_IMG + FIELD_AT), 0xabababab, `compound ${op} JS path leaves the image`);
    }
    // A key that is not bound (or beyond the table) stays on the fast path.
    for (const [flags, key] of [[BOUND, FIELD_KEY], [BOUND, 20], [0, 3]]) {
      reset();
      infos.set(SELF_H, SELF_IMG | flags);
      wr32(SELF_IMG + FIELD_AT, isFloat ? bits(1) : 1);
      run([S.expr(compound(op, true, isFloat ? E.float(bits(2)) : E.int(2), undefined, key)), S.ret(R.VOID)]);
      same(rd32(SELF_IMG + FIELD_AT), isFloat ? f32store(COMPOUND_FLOAT.get(op)(1, 2)) : COMPOUND_INT.get(op)(1, 2) >>> 0,
        `compound ${op} fast path flags ${flags} key ${key}`);
    }
  }
  // Compounds on a context-free statement use the run's locals and SELF.
  reset();
  wr32(INNER_LOCALS + LOCAL_AT, 5);
  wr32(INNER_IMG + FIELD_AT, 7);
  run([S.expr(compound(OP.INT_ADD, false, E.int(2))), S.expr(compound(OP.INT_SUB, true, E.int(2))), S.ret(R.VOID)],
    {locals: INNER_LOCALS, self: INNER_H});
  same(rd32(INNER_LOCALS + LOCAL_AT), 7, 'COMPOUND_LOCAL uses the run\'s locals');
  same(rd32(INNER_IMG + FIELD_AT), 5, 'COMPOUND_FIELD uses the run\'s SELF');
  same(rd32(LOCALS + LOCAL_AT) + rd32(SELF_IMG + FIELD_AT), 0, 'no other storage written');
  // Bad ops fail with ERR_KIND (the op as the node) before any storage
  // selection or value evaluation.
  for (const op of [0, 6, 7, 0x80000001, 0xffffffff]) {
    for (const [onField, flags] of [[false, 0], [true, 0], [true, HOST]]) {
      reset();
      infos.set(SELF_H, SELF_IMG | flags);
      const v = node(), n = node();
      const error = vmError(() => run([S.expr(compound(op, onField, w(K.JS_INT, v), n))]));
      same(error.code, ERR.KIND, `compound op ${op} error`);
      same(error.node >>> 0, op >>> 0, `compound op ${op} error node`);
      same(error.frame, FRAME, 'compound op error frame');
      same(calls.filter(c => c.imp !== 'error').length, 0, `compound op ${op} evaluates nothing first`);
    }
  }
}

// ---- Statements (resumeCompiled) ---------------------------------------------------
{
  // A counted loop: while (i < 10) ++i; return i.
  reset();
  const loop = [
    S.jumpIfNot(3, w(K.INT_LT, w(K.LOCAL_INT, 0), E.int(10))),
    S.expr(w(K.INC_LOCAL_PRE, 0)),
    S.jump(0),
    S.ret(R.INT, w(K.LOCAL_INT, 0)),
  ];
  same(run(loop, {runaway: 1000, budget: 500}), -1, 'loop returns');
  same(result(R.INT), 10, 'loop result');
  same(rd32(RUNAWAY_AT), 1000 + 11 + 10, 'each jump counts one runaway iteration');
  same(rd32(BUDGET_AT), 500 - 32, 'each executed statement consumes budget');
  // The runaway count is taken before the condition is evaluated.
  reset();
  let seen = -1;
  run([S.jumpIfNot(1, w(K.JS_BOOL, node(() => (seen = rd32(RUNAWAY_AT), true)))), S.ret(R.VOID)], {runaway: 77});
  same(seen, 78, 'S_JUMP_IF_NOT counts before its condition');
  // The limit: > 10,000,000 resets the count and raises RUNAWAY.
  for (const kind of ['jump', 'jumpIfNot']) {
    reset();
    let conditions = 0;
    const statement = kind === 'jump' ? S.jump(0) : S.jumpIfNot(0, w(K.JS_BOOL, node(() => (conditions++, false))));
    const error = vmError(() => run([statement], {runaway: RUNAWAY_LIMIT - 3}));
    same(error.code, ERR.RUNAWAY, `${kind} runaway error`);
    same(rd32(RUNAWAY_AT), 0, `${kind} runaway resets the count`);
    if (kind === 'jumpIfNot') same(conditions, 3, 'the failing jump does not evaluate its condition');
    reset();
    same(run([statement.length === 2 ? S.jump(1) : S.jumpIfNot(1, E.bool(1)), S.ret(R.VOID)], {runaway: RUNAWAY_LIMIT - 1}), -1,
      `${kind} reaching exactly the limit is allowed`);
    same(rd32(RUNAWAY_AT), RUNAWAY_LIMIT, `${kind} count at the limit`);
  }
  // Non-jump statements do not count.
  reset();
  run([S.nothing(), S.expr(w(K.SET_LOCAL_INT, 0, E.int(1))), S.ret(R.VOID)], {runaway: 5});
  same(rd32(RUNAWAY_AT), 5, 'non-jump statements leave the runaway count');
  // The hang budget.
  reset();
  const hang = vmError(() => run([S.jump(0)], {budget: 100}));
  same(hang.code, ERR.HANG, 'budget exhausted raises HANG');
  same(rd32(BUDGET_AT), 0, 'budget runs down to zero');
  same(rd32(RUNAWAY_AT), 100, 'the hanging loop ran exactly its budget');
  reset();
  same(vmError(() => run([S.ret(R.VOID)], {budget: 0})).code, ERR.HANG, 'a zero budget refuses the first statement');
  reset();
  run([S.nothing(), S.nothing(), S.ret(R.VOID)], {budget: 3});
  same(rd32(BUDGET_AT), 0, 'the budget covers exactly its statements');
  // S_YIELD: returns its index and leaves the budget to the JavaScript loop.
  reset();
  const yielding = [S.expr(w(K.SET_LOCAL_INT, 0, E.int(3))), S.yield(), S.ret(R.INT, w(K.LOCAL_INT, 0))];
  same(run(yielding, {budget: 10}), 1, 'S_YIELD returns its index');
  same(rd32(BUDGET_AT), 9, 'S_YIELD consumes no budget');
  same(rd32(LOCALS), 3, 'statements before the yield ran');
  same(run(yielding, {budget: 0, entry: 1}), 1, 'S_YIELD returns even with no budget');
  same(run(yielding, {budget: 10, entry: 2}), -1, 're-entry after the yield');
  same(result(R.INT), 3, 're-entry result');
  // S_RETURN kinds.
  reset();
  same(value(R.INT, E.int(-5)), -5, 'int RESULT');
  same(value(R.BOOL, E.bool(1)), true, 'bool RESULT true');
  same(view().getFloat64(RESULT_AT, true), 1, 'bool RESULT is 1');
  same(value(R.BOOL, E.bool(0)), false, 'bool RESULT false');
  same(value(R.FLOAT, floatOperand(-0).words), -0, 'float RESULT -0');
  same(value(R.FLOAT, w(K.JS_FLOAT, node(() => 0.1))), 0.1, 'float RESULT is the raw value');
  same(value(R.FLOAT, w(K.JS_FLOAT, node(() => undefined))), undefined, 'float RESULT undefined');
  view().setFloat64(RESULT_AT, 123, true);
  same(run([S.ret(R.VOID)]), -1, 'void return');
  same(rd32(RESULT_AT), 1, 'void RESULT low word');
  same(rd32(RESULT_AT + 4), 0x7ff80000, 'void RESULT high word');
  same(result(R.VOID), undefined, 'void RESULT is undefined');
  // Instruction pointer outside the script.
  reset();
  same(vmError(() => run([S.nothing()])).code, ERR.OUTSIDE, 'falling off the last statement (NEXT_NONE)');
  same(vmError(() => run([S.nothing(), S.nothing()], {next: [5, NEXT_NONE]})).code, ERR.OUTSIDE, 'next beyond the count');
  same(vmError(() => run([S.ret(R.VOID)], {entry: 1})).code, ERR.OUTSIDE, 'entry at the count');
  same(vmError(() => run([S.ret(R.VOID)], {entry: NEXT_NONE})).code, ERR.OUTSIDE, 'entry NEXT_NONE');
  same(vmError(() => run([S.jump(NEXT_NONE)], {budget: 5})).code, ERR.OUTSIDE, 'jump to NEXT_NONE');
  // JavaScript order: `if (!budget--)` precedes the statement lookup.
  same(vmError(() => run([S.nothing()], {entry: 1, budget: 0})).code, ERR.HANG, 'no budget outside the script');
  // Bad code words.
  for (const [statement, kind] of [
    [[9], 9], [S.expr(E.int(1)), K.LIT_INT], [S.ret(R.INT, E.float(0)), K.LIT_FLOAT], [S.ret(9, E.int(1)), 9],
    [S.ret(R.BOOL, E.int(1)), K.LIT_INT], [S.ret(R.FLOAT, E.bool(1)), K.LIT_BOOL],
    [S.ret(R.BOOL, w(K.OBJECT_EQ, E.int(1), E.none())), K.LIT_INT],
  ]) {
    reset();
    const error = vmError(() => run([statement]));
    same(error.code, ERR.KIND, `bad kind ${kind}`);
    same(error.node, kind, `bad kind ${kind} node`);
    same(error.frame, FRAME, 'js_error frame');
  }
  // JS_VOID evaluates its node with SELF.
  reset();
  let voided = 0;
  run([S.expr(w(K.JS_VOID, node((r, frame) => { voided++; same(r, SELF_H, 'JS_VOID receiver'); same(frame, FRAME, 'JS_VOID frame'); }))), S.ret(R.VOID)]);
  same(voided, 1, 'JS_VOID evaluated once');
}

// ---- The FLOAT_UNDEF protocol ------------------------------------------------------
{
  reset();
  same(value(R.FLOAT, w(K.FLOAT_ADD, w(K.JS_FLOAT, node(() => undefined)), E.float(bits(1)))), f(undefined + 1), 'undefined + 1');
  same(rd32(UNDEF_AT), 0, 'FLOAT_UNDEF cleared after reading it');
  reset();
  wr32(LOCALS + 0x4c, 0xdeadbeef);
  run([S.expr(w(K.SET_LOCAL_FLOAT, 0x4c, w(K.FLOAT_MIN, w(K.JS_FLOAT, node(() => undefined)), E.float(bits(5))))), S.ret(R.VOID)]);
  // FMin(undefined, 5) is undefined (native 244), stored as fround(0).
  same(rd32(LOCALS + 0x4c), floatStore(undefined > 5 ? 5 : undefined), 'FMin(undefined, 5) stores 0');
  reset();
  run([S.expr(w(K.SET_LOCAL_FLOAT, 0x4c, w(K.JS_FLOAT, node(() => NaN)))), S.ret(R.VOID)]);
  same(isNaN(num(rd32(LOCALS + 0x4c))), true, 'a NaN (not undefined) stores a NaN');
  // A field on the JavaScript path reads through js_float with the same protocol.
  reset();
  infos.set(SELF_H, HOST);
  wr32(LOCALS + 0x4c, 0xdeadbeef);
  run([S.expr(w(K.SET_LOCAL_FLOAT, 0x4c, w(K.FIELD_FLOAT, 0x1c, node(() => undefined), 1))), S.ret(R.VOID)]);
  same(rd32(LOCALS + 0x4c), 0, 'undefined HOST field stores 0');
  same(rd32(UNDEF_AT), 0, 'FLOAT_UNDEF cleared after a field read');
}

// ---- Re-entrant runs ------------------------------------------------------------------
{
  const inner = () => [
    S.expr(w(K.SET_LOCAL_INT, 0, w(K.FIELD_INT, 0x10, node(), 1))),
    S.jumpIfNot(3, w(K.JS_BOOL, node((r, frame) => (calls.push({imp: 'inner-probe', receiver: r, frame}), true)))),
    S.nothing(),
    S.ret(R.INT, w(K.INT_ADD, w(K.LOCAL_INT, 0), E.int(1000))),
  ];
  const failing = () => [S.ret(R.INT, w(K.INT_DIV, E.int(-0x80000000), E.int(-1)))];
  for (const mode of ['returns', 'throws']) {
    reset();
    wr32(SELF_IMG + 0x10, 5);
    wr32(SELF_IMG + 0x14, 9);
    wr32(INNER_IMG + 0x10, 70);
    const sp0 = x.__stack_pointer.value;
    let innerBudget = -1;
    const innerCode = mode === 'returns' ? inner() : failing();
    const nested = node(() => {
      // The host around a nested resume: its own budget, the outer one restored.
      const outerBudget = rd32(BUDGET_AT);
      const code = assemble(innerCode, {slot: 1});
      wr32(BUDGET_AT, 50);
      try {
        const status = enter(() => x.vm_run(code, INNER_FRAME, INNER_LOCALS, INNER_H, 0));
        same(status, -1, 'inner run returns');
        innerBudget = rd32(BUDGET_AT);
        return result(R.INT);
      } catch (error) {
        if (!(error instanceof VmError)) throw error;
        same(error.frame, INNER_FRAME, 'inner error frame');
        same(error.code, ERR.DIV_OVERFLOW, 'inner error code');
        return 0;
      } finally {
        wr32(BUDGET_AT, outerBudget);
      }
    });
    const outer = [
      S.expr(w(K.SET_LOCAL_INT, 0, w(K.FIELD_INT, 0x10, node(), 1))),
      S.expr(w(K.SET_LOCAL_INT, 4, w(K.INT_ADD, w(K.LOCAL_INT, 0), w(K.JS_INT, nested)))),
      S.jumpIfNot(4, w(K.INT_EQ, w(K.FIELD_INT, 0x14, node(), 1), E.int(9))),
      S.ret(R.INT, w(K.INT_ADD, w(K.LOCAL_INT, 4), w(K.FIELD_INT, 0x10, node(), 1))),
      S.ret(R.INT, E.int(-1)),
    ];
    same(run(outer, {budget: 100, runaway: 10}), -1, `outer run (${mode})`);
    same(result(R.INT), mode === 'returns' ? 5 + 1070 + 5 : 5 + 0 + 5, `outer result (${mode})`);
    same(rd32(BUDGET_AT), 96, `outer budget after the nested run (${mode})`);
    same(rd32(RUNAWAY_AT), mode === 'returns' ? 12 : 11, `runaway shared with the nested run (${mode})`);
    same(rd32(LOCALS + 4), mode === 'returns' ? 1075 : 5, `outer local (${mode})`);
    same(count('receiver', SELF_H), 2, `outer SELF info refetched after the nested import (${mode})`);
    same(x.__stack_pointer.value, sp0, `stack pointer after nested runs (${mode})`);
    if (mode === 'returns') {
      same(innerBudget, 50 - 4, 'inner budget');
      same(count('receiver', INNER_H), 1, 'inner SELF info');
      same(rd32(INNER_LOCALS), 70, 'inner local');
      const probe = calls.find(c => c.imp === 'inner-probe');
      same(probe.receiver, INNER_H, 'inner import receiver');
      same(probe.frame, INNER_FRAME, 'inner import frame');
    }
  }
}

// ---- Stack pointer after an import throws ------------------------------------------------
{
  reset();
  const sp0 = x.__stack_pointer.value;
  const thrower = node(() => { throw new Error('host import failure'); });
  const code = assemble([S.ret(R.INT, w(K.INT_ADD, E.int(1), w(K.CONTEXT, node(), 2, E.self(), w(K.JS_INT, thrower))))]);
  wr32(BUDGET_AT, 100);
  let spAfterThrow = null;
  try { x.vm_run(code, FRAME, LOCALS, SELF_H, 0); } catch (error) {
    assert.equal(error.message, 'host import failure');
    spAfterThrow = x.__stack_pointer.value;
  }
  assert.notEqual(spAfterThrow, null, 'the import threw');
  same(spAfterThrow < sp0, true, 'a throw through Wasm frames leaves the stack pointer lowered');
  x.__stack_pointer.value = sp0;
  for (let i = 0; i < 2000; i++) {
    wr32(BUDGET_AT, 100);
    try { enter(() => x.vm_run(code, FRAME, LOCALS, SELF_H, 0)); } catch (error) { if (error.message !== 'host import failure') throw error; }
  }
  same(x.__stack_pointer.value, sp0, 'restored in finally after each throw');
  same(value(R.INT, E.int(7)), 7, 'a run after the throws works');
  same(x.__stack_pointer.value, sp0, 'a normal run leaves the stack pointer');
}

// ---- The x87 operator exports in the interpreter instance ----------------------------------
{
  // Rotate reads the uploaded sine table; the kernel instance is the reference.
  const kernel = await loadScriptVmKernel(), resultWords = x.result_ptr();
  for (let i = 0; i < 200; i++) {
    const v = [random(), random(), random()].map(b => num(b & 0x7fffffff) % 1000), r = [random() | 0, random() | 0, random() | 0];
    x.op_rotate(bits(v[0]), bits(v[1]), bits(v[2]), r[0], r[1], r[2]);
    const expected = kernel.rotate(v, r);
    for (let c = 0; c < 3; c++) same(num(rd32(resultWords + 4 * c)), expected[c], `op_rotate component ${c}`);
    same(num(x.op_sqrt(bits(v[0]))), kernel.sqrt(v[0]), 'op_sqrt');
  }
}

// ---- Foreach steps -------------------------------------------------------------------------
{
  // A body that counts its passes in local 0, then IteratorNext: the host's
  // next() results decide between the body (statement 0) and after (2).
  reset();
  iterators.length = 0;
  iterators.push({results: [true, true, false], body: 0, after: 2});
  const loop = [
    S.expr(w(K.INC_LOCAL_PRE, 0)),
    S.iterNext(),
    S.ret(R.INT, w(K.LOCAL_INT, 0)),
  ];
  same(run(loop, {budget: 100}), -1, 'foreach loop returns');
  same(result(R.INT), 3, 'body ran once per true next() plus the first pass');
  same(count('iterNext'), 3, 'one IteratorNext import per pass');
  same(iterators.length, 0, 'a finished iterator is popped by the host');
  same(rd32(BUDGET_AT), 100 - 7, 'IteratorNext statements consume budget');
  // IteratorNext marks SELF stale: the field read after it refetches.
  reset();
  iterators.push({results: [false], body: 0, after: 2});
  run([S.ret(R.INT, w(K.FIELD_INT, 0, node(), 1)), S.iterNext(), S.ret(R.INT, w(K.FIELD_INT, 0, node(), 1))], {entry: 1});
  same(count('receiver', SELF_H), 1, 'SELF info fetched after IteratorNext');
  reset();
  iterators.push({results: [false], body: 0, after: 2});
  run([S.nothing(), S.nothing(), S.iterPop(), S.ret(R.INT, w(K.FIELD_INT, 0, node(), 1)), S.ret(R.INT, w(K.FIELD_INT, 0, node(), 1))], {entry: 2});
  same(count('iterPop'), 1, 'IteratorPop import');
  same(iterators.length, 0, 'IteratorPop popped');
  same(count('receiver', SELF_H), 1, 'SELF info fetched after IteratorPop');
  // Host errors propagate; NEXT_NONE from IteratorNext is outside the script.
  reset();
  iterators.length = 0;
  let threw = null;
  try { run([S.iterPop(), S.ret(R.VOID)]); } catch (error) { threw = error; }
  same(threw?.message, 'IteratorPop without an active iterator', 'IteratorPop error propagates');
  reset();
  iterators.push({results: [false], body: 0, after: NEXT_NONE});
  same(vmError(() => run([S.iterNext(), S.ret(R.VOID)])).code, ERR.OUTSIDE, 'IteratorNext to NEXT_NONE');
  iterators.length = 0;
}

// ---- Script calls (R2b-3: compileCall -> invoke -> callFunction -> executeScript) ----------
{
  const SIG = 5;
  let fnSlot = 0;
  /** A lowered callee: its code, frame size and the statements it leaves to
   * JavaScript (index -> step(info) returning the next index or RETURNED). */
  const defineFn = (statements, {size = 32, steps = {}} = {}) =>
    ({code: assembleAt(FN_CODE[fnSlot++ % FN_CODE.length], statements), size, steps});
  /** A call site resolving to `target` (null: the JavaScript path, whose
   * evaluation of the whole call node is `js`). */
  const site = (target, js) => {
    const n = node(js ?? (() => { throw new Error('call took the JavaScript path unexpectedly'); }));
    callSites.set(n, {target});
    return n;
  };
  const arg = (pkind, offset, mask, expr = []) => [pkind, offset, mask, ...expr];
  const skipArg = () => [P.SKIP, 0, 0];
  const call = (n, rkind, args = [], sig = SIG) => {
    const words = args.flat();
    return w(K.CALL, n, rkind, sig, args.length, words.length, words);
  };
  const writeResult = v => {
    if (v === undefined) { wr32(RESULT_AT, 1); wr32(RESULT_AT + 4, 0x7ff80000); }
    else view().setFloat64(RESULT_AT, v, true);
  };
  const frameBytes = (base, size) => Array.from(arena.bytes.subarray(base, base + size));
  const INITIAL_FRAMES = '-1,0,0';

  // The JavaScript path (js_call_begin -1): the whole call runs there with the
  // call's receiver; the argument words are skipped unevaluated.
  const IMPORT_OF = {[R.VOID]: 'eval', [R.INT]: 'int', [R.BOOL]: 'bool', [R.FLOAT]: 'float', [R.OBJECT]: 'object'};
  const JS_VALUE = {[R.VOID]: undefined, [R.INT]: -7, [R.BOOL]: true, [R.FLOAT]: 0.1, [R.OBJECT]: OTHER_H};
  for (const rkind of [R.VOID, R.INT, R.BOOL, R.FLOAT, R.OBJECT]) {
    for (const position of ['effect', 'value', 'context']) {
      if (position !== 'effect' && rkind === R.VOID) continue;
      reset();
      let evaluated = 0;
      const n = site(null, () => JS_VALUE[rkind]);
      const args = [arg(P.INT, 0, 0, w(K.JS_INT, node(() => (evaluated++, 1)))), skipArg(),
        arg(P.BOOL, 4, 1, w(K.NOT, w(K.JS_BOOL, node(() => (evaluated++, 1))))),
        arg(P.FLOAT, 8, 0, w(K.JS_FLOAT, node(() => (evaluated++, 1))))];
      const expr = call(n, rkind, args);
      wr32(LOCALS + 44, OTHER_H);
      const receiver = position === 'context' ? OTHER_H : SELF_H;
      if (position === 'effect') {
        run([S.expr(expr), S.ret(R.INT, E.int(99))]);
        same(result(R.INT), 99, `JS-path call rkind ${rkind} as a statement continues after its arguments`);
      } else {
        run([S.ret(rkind, position === 'context' ? E.context(node(), w(K.LOCAL_OBJECT, 44), expr) : expr)]);
        same(result(rkind), JS_VALUE[rkind], `JS-path call rkind ${rkind} (${position}) value`);
      }
      const begin = calls.find(c => c.imp === 'callBegin');
      same(count('callBegin'), 1, `JS-path call rkind ${rkind} begins once`);
      same(begin.node, n, 'js_call_begin node');
      same(begin.receiver, receiver, `js_call_begin receiver (${position})`);
      same(begin.sig, SIG, 'js_call_begin signature');
      same(begin.frame, FRAME, 'js_call_begin frame');
      const jsCalls = calls.filter(c => c.node === n && c.imp !== 'callBegin');
      same(jsCalls.length, 1, `JS-path call rkind ${rkind} evaluated once in JavaScript`);
      same(jsCalls[0].imp, IMPORT_OF[rkind], `JS-path call rkind ${rkind} import`);
      same(jsCalls[0].receiver, receiver, `JS-path call rkind ${rkind} receiver`);
      same(evaluated, 0, `JS-path call rkind ${rkind} skips its arguments`);
      same(framesKey(), INITIAL_FRAMES, 'JS-path call leaves the frame stack');
    }
  }
  // Evaluation continues after a call (its argument words consumed or skipped).
  for (const target of ['js', 'rust']) {
    const FOLLOWED = [
      [R.INT, (c, after) => w(K.INT_ADD, c, w(K.JS_INT, after)), 1, R.INT, -7 + 1],
      [R.BOOL, (c, after) => w(K.BOOL_EQ, c, w(K.JS_BOOL, after)), true, R.BOOL, true],
      [R.FLOAT, (c, after) => w(K.FLOAT_ADD, c, w(K.JS_FLOAT, after)), 0, R.FLOAT, f(0.1)],
      [R.OBJECT, (c, after) => w(K.OBJECT_EQ, c, w(K.JS_OBJECT, after)), OTHER_H, R.BOOL, true],
    ];
    for (const [rkind, wrap, afterValue, resultKind, expected] of FOLLOWED) {
      reset();
      let afterCalls = 0;
      const after = node(() => (afterCalls++, afterValue));
      const returns = {[R.INT]: E.int(-7), [R.BOOL]: E.bool(1), [R.FLOAT]: E.float(bits(0.1)), [R.OBJECT]: w(K.JS_OBJECT, node(() => OTHER_H))};
      const n = target === 'js' ? site(null, () => JS_VALUE[rkind]) : site(defineFn([S.ret(rkind, returns[rkind])]));
      const args = [arg(P.INT, 0, 0, w(K.INT_ADD, E.int(1), E.int(2))), skipArg(), arg(P.FLOAT, 4, 0, E.float(bits(2)))];
      same(value(resultKind, wrap(call(n, rkind, args), after)), expected, `${target} call rkind ${rkind} followed by an operand`);
      same(afterCalls, 1, `${target} call rkind ${rkind}: the operand after it evaluates once`);
    }
  }
  reset();
  wr32(LOCALS + 0x4c, 0xdeadbeef);
  run([S.expr(w(K.SET_LOCAL_FLOAT, 0x4c, call(site(null, () => undefined), R.FLOAT))), S.ret(R.VOID)]);
  same(rd32(LOCALS + 0x4c), 0, 'JS-path float call yielding undefined stores 0');
  same(rd32(UNDEF_AT), 0, 'JS-path float call clears FLOAT_UNDEF');

  // Arguments: in order, each stored in the callee block before the next is
  // evaluated (callFunction: locals.set(field, copyValue(field, value))).
  {
    reset();
    const order = [];
    let block = 0;
    const F = defineFn([S.ret(R.VOID)], {size: 36});
    const argNode = (index, value, check) => node((r, frame) => {
      order.push(index);
      block = frameInfo.get(nextFrameId - 1).base;
      same(r, SELF_H, `argument ${index} receiver is the caller's SELF`);
      same(frame, FRAME, `argument ${index} frame is the caller's`);
      check?.();
      return value;
    });
    const args = [
      arg(P.INT, 0, 0, w(K.JS_INT, argNode(0, -123456))),
      arg(P.BYTE, 5, 0, w(K.JS_INT, argNode(1, -128, () => same(rd32(block) | 0, -123456, 'int stored before the next argument')))),
      arg(P.BYTE, 4, 0, w(K.JS_INT, argNode(2, 0x1ff))),
      arg(P.BOOL, 8, 1, w(K.JS_BOOL, argNode(3, true))),
      // The bool word is read after its value is evaluated.
      arg(P.BOOL, 8, 4, w(K.JS_BOOL, argNode(4, 1, () => wr32(block + 8, rd32(block + 8) | 0x100)))),
      skipArg(),
      arg(P.FLOAT, 12, 0, w(K.JS_FLOAT, argNode(6, 0.1))),
      arg(P.OBJECT, 16, 0, w(K.JS_OBJECT, argNode(7, OTHER_H))),
      arg(P.FLOAT, 20, 0, w(K.JS_FLOAT, argNode(8, undefined))),
      arg(P.OBJECT, 24, 0, w(K.JS_OBJECT, argNode(9, undefined))),
      arg(P.BOOL, 28, 2, w(K.JS_BOOL, argNode(10, 0))),
    ];
    run([S.expr(call(site(F), R.VOID, args)), S.ret(R.VOID)]);
    same(order.join(), '0,1,2,3,4,6,7,8,9,10', 'arguments evaluate in order; a skipped one not at all');
    const base = frameInfo.get(100).base;
    same(rd32(base) | 0, -123456 | 0, 'int parameter (copyInt)');
    same(arena.bytes[base + 4], 0x1ff & 0xff, 'byte parameter (copyByte)');
    same(arena.bytes[base + 5], -128 & 0xff, 'second byte parameter');
    same(rd32(base + 4) >>> 16, 0, 'byte stores leave their neighbours');
    same(rd32(base + 8), 0x105, 'bool parameters merge their masks into the word read after the value');
    same(rd32(base + 12), bits(Math.fround(Number(0.1 ?? 0))), 'float parameter (copyFloat)');
    same(rd32(base + 16), OTHER_H, 'object parameter');
    same(rd32(base + 20), bits(Math.fround(Number(undefined ?? 0))), 'undefined float parameter stores 0');
    same(rd32(base + 24), 0, 'undefined object parameter stores None');
    same(rd32(base + 28), 0, 'false bool parameter');
    same(rd32(base + 32), 0, 'the rest of the block stays zero');
    same(framesKey(), INITIAL_FRAMES, 'frame stack restored after the call');
  }
  // Bad parameter and result kinds.
  reset();
  {
    const F = defineFn([S.ret(R.VOID)]);
    const error = vmError(() => run([S.expr(call(site(F), R.VOID, [arg(9, 0, 0)])), S.ret(R.VOID)]));
    same(error.code, ERR.KIND, 'bad parameter kind');
    same(error.node, 9, 'bad parameter kind node');
    reset();
    const bad = vmError(() => run([S.expr(call(site(null, () => 0), 7)), S.ret(R.VOID)]));
    same(bad.code, ERR.KIND, 'bad call result kind');
    same(bad.node, 7, 'bad call result kind node');
    same(count('callBegin'), 0, 'a bad result kind is refused before the call begins');
  }

  // The caller evaluates arguments with its own SELF, locals and frame id; the
  // callee runs with its own frame id, SELF (the call's receiver) and block.
  {
    reset();
    wr32(SELF_IMG + 0x10, 11);
    wr32(OTHER_IMG + 0x10, 22);
    wr32(LOCALS + 0x40, 33);
    wr32(LOCALS + 44, OTHER_H);
    const seen = [];
    const probe = tag => node((r, frame) => (seen.push({tag, r, frame}), 0));
    const G = defineFn([S.ret(R.INT, w(K.INT_ADD, w(K.INT_ADD, w(K.LOCAL_INT, 0), w(K.FIELD_INT, 0x10, node(), 1)),
      E.context(node(), E.self(), w(K.JS_INT, probe('callee')))))], {size: 16});
    const argument = w(K.INT_ADD, w(K.INT_ADD, w(K.LOCAL_INT, 0x40), w(K.FIELD_INT, 0x10, node(), 1)), w(K.JS_INT, probe('argument')));
    // Parameters 4 and 8 take a field and a JS value directly: still the
    // caller's SELF, not the call's context receiver.
    same(value(R.INT, E.context(node(), w(K.LOCAL_OBJECT, 44), call(site(G), R.INT, [arg(P.INT, 0, 0, argument),
      arg(P.INT, 4, 0, w(K.FIELD_INT, 0x10, node(), 1)), arg(P.INT, 8, 0, w(K.JS_INT, probe('direct')))]))), 33 + 11 + 22,
      'argument from the caller, body on the callee');
    same(rd32(frameInfo.get(100).base + 4), 11, 'a field argument reads the caller SELF');
    same(seen.find(s => s.tag === 'direct').r, SELF_H, 'a direct JS argument gets the caller SELF');
    same(seen.find(s => s.tag === 'argument').r, SELF_H, 'argument receiver');
    same(seen.find(s => s.tag === 'argument').frame, FRAME, 'argument frame');
    same(seen.find(s => s.tag === 'callee').r, OTHER_H, 'callee SELF is the call receiver');
    same(seen.find(s => s.tag === 'callee').frame, 100, 'callee frame id');
    same(calls.find(c => c.imp === 'callBegin').receiver, OTHER_H, 'context call receiver');
    same(rd32(LOCALS + 0x40), 33, 'caller locals untouched by the callee');
  }

  // The frame stack: pushes zero their blocks, advance when a chunk is full,
  // and every call restores all three words after its callee.
  {
    reset();
    for (let i = 0; i < 3 && chunks.length < 2; i++) imports.js_frame_advance(64);
    reset();
    const snaps = {}, blocks = {};
    const snap = tag => w(K.JS_VOID, node((r, frame) => {
      snaps[tag] = framesKey();
      const info = frameInfo.get(frame);
      if (info) blocks[tag] = frameBytes(info.base, (info.target.size + 7) & ~7).every(b => b === 0);
    }));
    const C = defineFn([S.expr(snap('C')), S.ret(R.VOID)], {size: 16});
    const B = defineFn([S.expr(snap('B')), S.expr(call(site(C), R.VOID)), S.expr(snap('B2')), S.ret(R.VOID)], {size: 30});
    const A = defineFn([S.expr(snap('A')), S.expr(call(site(B), R.VOID)), S.expr(snap('A2')), S.ret(R.VOID)], {size: 24});
    run([S.expr(call(site(A), R.VOID)), S.expr(snap('top')), S.ret(R.VOID)]);
    const [c0, c1] = [chunks[0].base, chunks[1].base];
    same(snaps.A, `0,${c0 + 24},${c0 + 64}`, 'first push advances to chunk 0');
    same(snaps.B, `0,${c0 + 56},${c0 + 64}`, 'a push that fits does not advance (30 aligned to 32)');
    same(snaps.C, `1,${c1 + 16},${c1 + 64}`, 'a push past the end advances to chunk 1');
    same(snaps.B2, `0,${c0 + 56},${c0 + 64}`, 'restored after C (index, top and end)');
    same(snaps.A2, `0,${c0 + 24},${c0 + 64}`, 'restored after B');
    same(snaps.top, INITIAL_FRAMES, 'restored after A');
    same(calls.filter(c => c.imp === 'advance').map(c => c.size).join(), '24,16', 'js_frame_advance only when the chunk is full');
    same(blocks.A && blocks.B && blocks.C, true, 'pushed blocks are zeroed');
    same(framesKey(), INITIAL_FRAMES, 'frame stack after the run');
    // vm_frame_push directly: alignment, zeroing, exact fit, advance.
    reset();
    wr32(FRAMES_AT, 0);
    wr32(FRAMES_AT + 4, c0);
    wr32(FRAMES_AT + 8, c0 + 64);
    same(x.vm_frame_push(13), c0, 'push base');
    same(framesKey(), `0,${c0 + 16},${c0 + 64}`, 'push aligns to 8');
    same(frameBytes(c0, 16).every(b => b === 0), true, 'push zeroes its block');
    same(arena.bytes[c0 + 16], 0xaa, 'push leaves the bytes after its block');
    same(x.vm_frame_push(48), c0 + 16, 'an exact fit');
    same(count('advance'), 0, 'an exact fit does not advance');
    same(x.vm_frame_push(1), c1, 'a full chunk advances');
    same(calls.find(c => c.imp === 'advance').size, 8, 'advance gets the aligned size');
    same(framesKey(), `1,${c1 + 8},${c1 + 64}`, 'after the advance');
  }

  // Budgets: the callee has its own (executeScript's resumeCompiled), and the
  // caller's is restored.
  {
    reset();
    let seen = -1;
    const L = defineFn([S.nothing(), S.expr(w(K.JS_VOID, node(() => { seen = rd32(BUDGET_AT); }))), S.ret(R.VOID)]);
    const M = defineFn([S.ret(R.INT, E.int(1))]);
    run([S.expr(call(site(L), R.VOID)), S.ret(R.INT, call(site(M), R.INT))], {budget: 1000});
    same(seen, HANG_BUDGET - 2, 'the callee counts its own budget');
    same(rd32(BUDGET_AT), 1000 - 2, 'the caller budget is restored after each call');
    // A callee without budget left: the error names the callee frame.
    reset();
    const H = defineFn([S.yield(), S.nothing(), S.ret(R.VOID)], {steps: {0: () => (wr32(BUDGET_AT, 0), 1)}});
    const hang = vmError(() => run([S.expr(call(site(H), R.VOID)), S.ret(R.VOID)]));
    same(hang.code, ERR.HANG, 'callee hang');
    same(hang.frame, 100, 'callee hang frame');
    reset();
    const H2 = defineFn([S.yield(), S.yield(), S.ret(R.VOID)], {steps: {0: () => (wr32(BUDGET_AT, 0), 1), 1: () => 2}});
    const yieldHang = vmError(() => run([S.expr(call(site(H2), R.VOID)), S.ret(R.VOID)]));
    same(yieldHang.code, ERR.HANG, 'a callee yield checks the budget');
    same(count('step'), 1, 'the refused yield does not step');
  }

  // Callee statements left to JavaScript run through js_step on the callee
  // frame; RETURNED ends the callee with RESULT written there.
  {
    reset();
    let stepBudget = -1;
    const Y = defineFn([S.expr(w(K.SET_LOCAL_INT, 0, E.int(5))), S.yield(), S.ret(R.INT, w(K.LOCAL_INT, 0))],
      {steps: {1: info => { stepBudget = rd32(BUDGET_AT); wr32(info.base, rd32(info.base) + 37); return 2; }}});
    same(value(R.INT, call(site(Y), R.INT)), 42, 'js_step continues the callee');
    same(stepBudget, HANG_BUDGET - 2, 'the yield statement is counted before js_step');
    const step = calls.find(c => c.imp === 'step');
    same(step.frame, 100, 'js_step frame');
    same(step.index, 1, 'js_step statement index');
    reset();
    let passes = 0;
    const J = defineFn([S.expr(w(K.INC_LOCAL_PRE, 0)), S.yield(), S.ret(R.INT, w(K.LOCAL_INT, 0))],
      {steps: {1: () => (passes++ < 3 ? 0 : 2)}});
    same(value(R.INT, call(site(J), R.INT)), 4, 'js_step jumping back');
    for (const [rkind, written, expected] of [[R.INT, 77, 77], [R.INT, undefined, 0], [R.FLOAT, 0.1, f(0.1)], [R.BOOL, 3, true]]) {
      reset();
      const Z = defineFn([S.nothing(), S.yield()], {steps: {1: () => (writeResult(written), RETURNED)}});
      same(value(rkind, call(site(Z), rkind)), expected, `RETURNED ${written} (rkind ${rkind})`);
    }
    reset();
    const N = defineFn([S.yield()], {steps: {0: () => NEXT_NONE}});
    const outside = vmError(() => value(R.INT, call(site(N), R.INT)));
    same(outside.code, ERR.OUTSIDE, 'js_step NEXT_NONE is outside the script');
    same(outside.frame, 100, 'outside error on the callee frame');
    // js_step ran JavaScript: the callee's SELF info is refetched.
    reset();
    wr32(SELF_IMG + 0x10, 3);
    const R2 = defineFn([S.expr(w(K.SET_LOCAL_INT, 0, w(K.FIELD_INT, 0x10, node(), 1))), S.yield(),
      S.ret(R.INT, w(K.INT_ADD, w(K.LOCAL_INT, 0), w(K.FIELD_INT, 0x10, node(), 1)))], {steps: {1: () => 2}});
    same(value(R.INT, call(site(R2), R.INT)), 6, 'fields around a callee step');
    same(count('receiver', SELF_H), 2, 'callee SELF info refetched after js_step');
  }

  // Result conversion (callFunction's copyValue(fn.result, value)).
  {
    const CONVERSIONS = [
      [R.INT, v => Number(v ?? 0) | 0, [3.7, -3.7, 2 ** 32 + 5, -(2 ** 31) - 1, 2 ** 31, 1e20, -1e20, 2 ** 63, -(2 ** 64) - 2 ** 13,
        2 ** 70 + 2 ** 20, NaN, Infinity, -0, 123, -2147483648.9, undefined]],
      [R.BOOL, v => Boolean(v), [2, 0, -0, NaN, 0.5, -1, 1, undefined]],
      [R.FLOAT, v => Math.fround(Number(v ?? 0)), [0.1, 1e300, -0, NaN, 5e-324, 1 / 3, -3.4028235677973366e38, undefined]],
      [R.OBJECT, v => v === UNDEFINED ? 0 : v ?? 0, [OTHER_H, 0, UNDEFINED, undefined]],
    ];
    for (const [rkind, copy, written] of CONVERSIONS) {
      for (const v of written) {
        reset();
        const Z = defineFn([S.yield()], {steps: {0: () => (writeResult(v), RETURNED)}});
        same(value(rkind, call(site(Z), rkind)), copy(v), `call result ${v} (rkind ${rkind})`);
      }
    }
    // Typed Returns in Rust.
    const RETURNS = [
      [R.INT, () => E.int(-9), -9], [R.BOOL, () => E.bool(1), true], [R.FLOAT, () => w(K.JS_FLOAT, node(() => 0.1)), f(0.1)],
      [R.FLOAT, () => w(K.JS_FLOAT, node(() => undefined)), 0], [R.OBJECT, () => E.self(), OTHER_H],
      [R.OBJECT, () => w(K.JS_OBJECT, node(() => undefined)), 0], [R.VOID, () => [], undefined],
    ];
    for (const [rkind, make, expected] of RETURNS) {
      reset();
      wr32(LOCALS + 44, OTHER_H);
      const T = defineFn([S.ret(rkind, make())]);
      const expr = E.context(node(), w(K.LOCAL_OBJECT, 44), call(site(T), rkind));
      if (rkind === R.VOID) {
        run([S.expr(call(site(T), R.VOID)), S.ret(R.VOID)]);
        same(result(R.VOID), undefined, 'void call');
      } else same(value(rkind, expr), expected, `Rust Return rkind ${rkind}`);
    }
    // A value call in an effect position discards its result.
    reset();
    const V = defineFn([S.ret(R.INT, E.int(5))]);
    run([S.expr(call(site(V), R.INT)), S.ret(R.INT, E.int(8))]);
    same(result(R.INT), 8, 'a value call as a statement');
  }

  // Object Return (rkind 4): the handle as f64.
  reset();
  same(value(R.OBJECT, E.self()), SELF_H, 'object RESULT SELF');
  same(value(R.OBJECT, E.none()), 0, 'object RESULT None');
  same(value(R.OBJECT, w(K.JS_OBJECT, node(() => undefined))), UNDEFINED, 'object RESULT undefined handle');
  wr32(LOCALS + 44, THIRD_H);
  same(value(R.OBJECT, w(K.LOCAL_OBJECT, 44)), THIRD_H, 'object RESULT local');

  // A context whose object is None skips the call entirely.
  reset();
  {
    const F = defineFn([S.ret(R.INT, E.int(5))]);
    same(value(R.INT, w(K.INT_ADD, E.context(node(), E.none(), call(site(F), R.INT, [arg(P.INT, 0, 0, w(K.JS_INT, node()))])),
      E.int(4))), 4, 'None context call');
    same(count('callBegin'), 0, 'None context call never begins');
  }

  // Calls in arguments: the outer callee block is read before the arguments
  // run, and each nested call restores the stack above it.
  {
    reset();
    let inG = null, runsInG = null, runsAfterG = null;
    const Fn = defineFn([S.ret(R.INT, w(K.INT_ADD, w(K.INT_MUL, w(K.LOCAL_INT, 0), E.int(100)), w(K.LOCAL_INT, 4)))], {size: 8});
    const G = defineFn([S.expr(w(K.JS_VOID, node(() => { inG = framesKey(); runsInG = rd32(FRAMES_AT + 12); }))),
      S.ret(R.INT, w(K.INT_MUL, w(K.LOCAL_INT, 0), E.int(10)))], {size: 8});
    const afterG = w(K.JS_INT, node(() => (runsAfterG = rd32(FRAMES_AT + 12), 0)));
    same(value(R.INT, call(site(Fn), R.INT, [arg(P.INT, 0, 0, E.int(7)),
      arg(P.INT, 4, 0, w(K.INT_ADD, call(site(G), R.INT, [arg(P.INT, 0, 0, E.int(3))]), afterG))])),
      730, 'a call in an argument');
    same(runsInG, 2, 'the argument call runs above the pending outer callee');
    same(runsAfterG, 1, 'the run count comes back after the argument call, the outer callee still pending');
    same(rd32(FRAMES_AT + 12), 0, 'run count after calls in arguments');
    same(inG, `0,${chunks[0].base + 16},${chunks[0].base + 64}`, 'the argument call pushes above the outer callee block');
    same(framesKey(), INITIAL_FRAMES, 'frame stack after calls in arguments');
    same(frameInfo.get(100).target, Fn, 'the outer call began first');
  }

  // After a call the caller's SELF info is stale (JavaScript ran).
  {
    reset();
    const Q = defineFn([S.ret(R.VOID)]);
    run([S.expr(w(K.SET_LOCAL_INT, 0, w(K.FIELD_INT, 0x10, node(), 1))), S.expr(call(site(Q), R.VOID)), S.ret(R.INT, w(K.FIELD_INT, 0x14, node(), 1))]);
    same(count('receiver', SELF_H), 2, 'caller SELF info refetched after a call');
    // An argument refetches it after js_call_begin; the callee's JavaScript
    // then makes SELF HOST, which the read after the call must see.
    reset();
    wr32(SELF_IMG + 0x14, 9);
    const Q2 = defineFn([S.yield(), S.ret(R.VOID)], {size: 8, steps: {0: () => (infos.set(OTHER_H, HOST), infos.set(SELF_H, HOST), 1)}});
    wr32(LOCALS + 44, OTHER_H);
    run([S.expr(w(K.SET_LOCAL_INT, 0, E.context(node(), w(K.LOCAL_OBJECT, 44),
      call(site(Q2), R.INT, [arg(P.INT, 0, 0, w(K.FIELD_INT, 0x10, node(), 1))])))),
      S.ret(R.INT, w(K.FIELD_INT, 0x14, node(() => 1000), 1))]);
    same(result(R.INT), 1000, 'caller SELF info is stale after a call');
    same(count('receiver', SELF_H), 2, 'caller SELF info fetched for the argument and after the call');
  }

  // Recursion: fact(n) = n > 1 ? n * fact(n - 1) : 1, each level a callee Run.
  {
    reset();
    const sp0 = x.__stack_pointer.value;
    const factSite = node(() => { throw new Error('fact took the JavaScript path'); });
    const depths = [];
    const fact = defineFn([
      S.jumpIfNot(2, w(K.INT_GT, w(K.LOCAL_INT, 0), E.int(1))),
      S.ret(R.INT, w(K.INT_MUL, w(K.LOCAL_INT, 0), call(factSite, R.INT, [arg(P.INT, 0, 0, w(K.INT_SUB, w(K.LOCAL_INT, 0), E.int(1)))]))),
      S.ret(R.INT, w(K.INT_ADD, E.int(1), w(K.JS_INT, node((r, frame) => (depths.push(frame), 0))))),
    ], {size: 8});
    callSites.set(factSite, {target: fact});
    same(value(R.INT, call(factSite, R.INT, [arg(P.INT, 0, 0, E.int(6))]), {runaway: 0}), 720, 'fact(6)');
    same(count('callBegin'), 6, 'six nested calls');
    same(calls.filter(c => c.imp === 'callBegin').map(c => c.frame).join(), `${FRAME},100,101,102,103,104`, 'each level calls from its own frame');
    same(depths.join(), '105', 'the innermost level runs on its own frame');
    same(rd32(RUNAWAY_AT), 6, 'each level counts its jump');
    for (let id = 100; id <= 105; id++) same(rd32(frameInfo.get(id).base), 6 - (id - 100), `level ${id} kept its own parameter`);
    same(framesKey(), INITIAL_FRAMES, 'frame stack after the recursion');
    same(x.__stack_pointer.value, sp0, 'stack pointer after the recursion');
  }

  // A callee step that re-enters vm_run (JavaScript running another lowered
  // function), which itself calls: the callee's state survives.
  {
    reset();
    wr32(SELF_IMG + 0x10, 5);
    wr32(SELF_IMG + 0x14, 9);
    let innerValue = -1, framesAround = null, calleeBudget = -1;
    const P2 = defineFn([S.ret(R.INT, w(K.INT_MUL, w(K.LOCAL_INT, 0), E.int(2)))], {size: 16});
    const innerCode = () => assemble([S.ret(R.INT, call(site(P2), R.INT, [arg(P.INT, 0, 0, E.int(21))]))], {slot: 1});
    let inner = 0;
    const Nn = defineFn([
      S.expr(w(K.SET_LOCAL_INT, 0, w(K.FIELD_INT, 0x10, node(), 1))),
      S.yield(),
      S.ret(R.INT, w(K.INT_ADD, w(K.INT_ADD, w(K.LOCAL_INT, 0), w(K.FIELD_INT, 0x14, node(), 1)), w(K.JS_INT, node(() => rd32(BUDGET_AT) === calleeBudget - 1 ? 0 : 1000)))),
    ], {size: 16, steps: {1: () => {
      // The host around a nested resume: its own budget, the outer restored.
      const before = framesKey(), outerBudget = rd32(BUDGET_AT);
      wr32(BUDGET_AT, 50);
      const status = enter(() => x.vm_run(inner, INNER_FRAME, INNER_LOCALS, INNER_H, 0));
      same(status, -1, 'nested run returns');
      innerValue = result(R.INT);
      wr32(BUDGET_AT, outerBudget);
      calleeBudget = outerBudget;
      framesAround = [before, framesKey()];
      return 2;
    }}});
    inner = innerCode();
    same(value(R.INT, call(site(Nn), R.INT), {budget: 10}), 14, 'callee after a nested run');
    same(innerValue, 42, 'nested run result');
    same(framesAround[0], framesAround[1], 'the nested run restored the frame stack');
    same(rd32(BUDGET_AT), 10 - 1, 'caller budget after the call');
    same(count('receiver', SELF_H), 2, 'callee SELF info refetched after the nested run');
    same(calls.find(c => c.imp === 'callBegin' && c.frame === INNER_FRAME)?.receiver, INNER_H, 'the nested run calls on its own frame');
    same(framesKey(), INITIAL_FRAMES, 'frame stack after all');
  }

  // A throw inside a callee: the host restores the stack pointer (and its
  // frame stack); the next call works.
  {
    reset();
    const sp0 = x.__stack_pointer.value;
    const T = defineFn([S.expr(w(K.SET_LOCAL_INT, 0, E.int(1))), S.ret(R.INT, w(K.JS_INT, node(() => { throw new Error('callee import failure'); })))]);
    const code = assemble([S.ret(R.INT, w(K.INT_ADD, E.int(1), call(site(T), R.INT)))]);
    wr32(BUDGET_AT, 100);
    let spAfterThrow = null;
    try { x.vm_run(code, FRAME, LOCALS, SELF_H, 0); } catch (error) {
      assert.equal(error.message, 'callee import failure');
      spAfterThrow = x.__stack_pointer.value;
    }
    assert.notEqual(spAfterThrow, null, 'the callee import threw');
    same(spAfterThrow < sp0, true, 'a throw through callee frames leaves the stack pointer lowered');
    x.__stack_pointer.value = sp0;
    reset();
    const U = defineFn([S.ret(R.INT, E.int(41))]);
    same(value(R.INT, w(K.INT_ADD, E.int(1), call(site(U), R.INT))), 42, 'a call after the throw');
    same(x.__stack_pointer.value, sp0, 'stack pointer after the following call');
  }
}

// ---- R2b-5: float operators on NaN pairs, exact bits ---------------------------------------
// native() computes f(a op b) in JavaScript: the FPU returns the first NaN
// operand, quieted (a float operand's f32 widening already quieted it). The
// result's f64 bits and the f32 bits a float store keeps must be the same in
// Rust, whatever order the compiler evaluates the operation in. VM float
// values are quiet (f32 widenings and arithmetic results), so the doubles
// below are quiet NaNs; with a signaling operand the arm64 FPU prefers it
// over an earlier quiet one, which no VM value exercises.
{
  const u64 = new DataView(new ArrayBuffer(8));
  const bitsOf64 = v => (u64.setFloat64(0, v, true), `${u64.getUint32(4, true).toString(16)}:${u64.getUint32(0, true).toString(16)}`);
  const double = (hi, lo) => (u64.setUint32(4, hi, true), u64.setUint32(0, lo, true), u64.getFloat64(0, true));
  const resultBits = () => `${rd32(RESULT_AT + 4).toString(16)}:${rd32(RESULT_AT).toString(16)}`;
  const jsDouble = v => () => ({words: w(K.JS_FLOAT, node(() => v)), js: v});
  const operands = [
    ...[0x7fc00000, 0xffc00000, 0x7fc00001, 0xffe12345, 0x7f800001, 0x7fa00000, 0xffbfffff, 0x7fffffff]
      .map(b => () => floatBitsOperand(b)),
    jsDouble(undefined), jsDouble(double(0x7ff81234, 0xabcd0000)), jsDouble(double(0xfff87654, 0x321)), jsDouble(double(0xfff80000, 0x1000)),
    () => floatBitsOperand(bits(1.5)), jsDouble(0.1), jsDouble(Infinity), () => floatBitsOperand(0),
  ];
  let pairs = 0;
  for (const [kind, reference] of FLOAT_BINARY) {
    if (kind === K.FLOAT_MIN || kind === K.FLOAT_MAX) continue;
    for (const makeA of operands) for (const makeB of operands) {
      reset();
      let a = makeA(), b = makeB();
      const expected = reference(a.js, b.js);
      if (!isNaN(expected)) continue;
      assert.equal(run([S.ret(R.FLOAT, w(kind, a.words, b.words))]), -1);
      same(resultBits(), bitsOf64(expected), `kind ${kind} NaN result bits (${bitsOf64(a.js)}, ${bitsOf64(b.js)})`);
      reset();
      a = makeA(); b = makeB();
      run([S.expr(w(K.SET_LOCAL_FLOAT, 0x60, w(kind, a.words, b.words))), S.ret(R.VOID)]);
      same(rd32(LOCALS + 0x60), floatStore(expected), `kind ${kind} NaN stored bits (${a.js}, ${b.js})`);
      pairs++;
    }
  }
  assert.ok(pairs > 400, 'the NaN pair sweep covers the four operators');
}

// ---- R2b-5: the handle class table and DynamicCast (compileEv 0x2e) -----------------------
// castObject (script-runtime.mjs) is the reference, run on a runtime stand-in
// whose instances and class chains the mock host also describes to Rust as
// class rows [image, n, record ids...] (script-vm-rust.mjs classRow).
// One word more than the capacity: that word (RELEASED) is not an entry.
const TABLE_CAP = 64, TABLE = arena.alloc(4 * (TABLE_CAP + 1));
const classRecord = name => ({kind: 'Class', key: `test.${name}`});
const CR = {A: classRecord('a'), B: classRecord('b'), C: classRecord('c'), D: classRecord('d'), E: classRecord('e')};
const CLS = {A: {record: CR.A, base: null}};
CLS.B = {record: CR.B, base: CLS.A};
CLS.C = {record: CR.C, base: CLS.B};
CLS.D = {record: CR.D, base: CLS.A};
CLS.E = {record: CR.E, base: null};
const world = {instances: new Map(), castToNativeClass() { throw new Error('native class cast'); }};
const castObject = (value, target) => ScriptRuntime.prototype.castObject.call(world, value, target, 'dynamic');
const identities = new Map();
const attach = (handle, cls) => {
  const identity = {handle};
  identities.set(handle, identity);
  world.instances.set(identity, {cls});
};
attach(20, CLS.A); attach(21, CLS.B); attach(22, CLS.C); attach(23, CLS.D); attach(24, CLS.E);
attach(SELF_H, CLS.C); attach(OTHER_H, CLS.D);
identities.set(25, {handle: 25, objectClass: CLS.C});   // not attached: castObject walks objectClass
identities.set(26, {handle: 26});                        // no class: castObject throws
const identityOf = handle => identities.get(handle) ?? null;
const handleOfIdentity = v => v === null ? null : v.handle;
const rowAddresses = new Map();
/** The host's class row of `cls`; its default image word as given. */
function classRow(cls, image = 0) {
  let address = rowAddresses.get(cls);
  if (address === undefined) {
    const chain = [];
    for (let c = cls; c; c = c.base) chain.push(classRecordId(c.record));
    address = arena.alloc(8 + 4 * chain.length);
    wr32(address + 4, chain.length);
    chain.forEach((id, i) => wr32(address + 8 + 4 * i, id));
    rowAddresses.set(cls, address);
  }
  wr32(address, image);
  return address;
}
/** js_class_row: an attached instance's row, entered in the table. */
function describeHandle(handle) {
  const instance = world.instances.get(identityOf(handle));
  if (!instance) return 0;
  const row = rowAddresses.get(instance.cls) ?? classRow(instance.cls);
  wr32(TABLE + 4 * handle, row);
  return row;
}
function classTable() {
  arena.bytes.fill(0, TABLE, TABLE + 4 * TABLE_CAP);
  wr32(TABLE + 4 * TABLE_CAP, RELEASED);
  wr32(CLASSES_AT, TABLE);
  wr32(CLASSES_AT + 4, TABLE_CAP);
  classRowHost = describeHandle;
}
/** The js_cast node of a cast to `target`: castObject on the value's identity. */
const castNode = target => node(handle => handleOfIdentity(castObject(identityOf(handle), target)));
const castOf = (target, value) => w(K.DYNAMIC_CAST, target === null ? 0 : classRecordId(target), castNode(target), value);
{
  const TARGETS = [null, CR.A, CR.B, CR.C, CR.D, CR.E];
  const VALUES = [20, 21, 22, 23, 24, 25, 26];
  const sources = [
    ['LOCAL_OBJECT', h => (wr32(LOCALS + 44, h), w(K.LOCAL_OBJECT, 44))],
    ['FIELD_OBJECT', h => (wr32(SELF_IMG + 0x20, h), w(K.FIELD_OBJECT, 0x20, node(), 4))],
    ['JS_OBJECT', h => w(K.JS_OBJECT, node(() => h))],
  ];
  for (const target of TARGETS) {
    for (const handle of VALUES) {
      for (const [source, make] of sources) {
        reset();
        classTable();
        let expected, thrown = null;
        try { expected = handleOfIdentity(castObject(identityOf(handle), target)) ?? 0; } catch (error) { thrown = error.message; }
        const cast = castOf(target, make(handle));
        if (thrown) {
          assert.throws(() => objectOf(cast), {message: thrown}, `cast ${handle} throws as castObject does`);
          checks++;
          continue;
        }
        same(objectOf(cast), expected, `DYNAMIC_CAST ${source} ${handle} to ${target?.key ?? 'None'}`);
        const attached = world.instances.has(identityOf(handle));
        same(count('classRow'), target === null ? 0 : 1, 'the class row is looked up once, not for a None target');
        same(count('cast'), target !== null && !attached ? 1 : 0, 'an undescribed handle runs castObject in JavaScript');
        if (target !== null && attached) {
          // The row is in the table now: a second cast asks nothing.
          calls.length = 0;
          same(objectOf(castOf(target, make(handle))), expected, 'second cast');
          same(count('classRow') + count('cast'), 0, 'a described handle casts in Rust');
        }
      }
    }
  }
  // None and undefined cast to None without looking anything up.
  for (const value of [() => E.none(), () => w(K.JS_OBJECT, node(() => undefined)), () => w(K.JS_OBJECT, node(() => null))]) {
    reset();
    classTable();
    same(objectOf(castOf(CR.A, value())), 0, 'a None or undefined value casts to None');
    same(count('classRow') + count('cast'), 0, 'None needs no class');
  }
  // The value is evaluated once, with SELF, even as a context's value.
  reset();
  classTable();
  wr32(LOCALS + 44, OTHER_H);
  const probe = node(r => (calls.push({imp: 'probe', receiver: r}), 22));
  same(value(R.INT, E.context(node(), castOf(CR.B, w(K.JS_OBJECT, probe)), w(K.JS_INT, node(r => r)))), 22,
    'a cast as a context object');
  reset();
  classTable();
  wr32(LOCALS + 44, OTHER_H);
  const inner = node(r => (calls.push({imp: 'probe', receiver: r}), 21));
  same(value(R.BOOL, w(K.OBJECT_EQ, E.context(node(), w(K.LOCAL_OBJECT, 44), castOf(CR.A, w(K.JS_OBJECT, inner))), E.none())),
    false, 'a cast as a context value');
  same(calls.filter(c => c.imp === 'probe').length, 1, 'the cast value is evaluated once');
  same(calls.find(c => c.imp === 'probe').receiver, SELF_H, 'the cast value is evaluated with SELF');
  // A released handle is None where it is read; a released SELF handle is
  // cast by JavaScript (the closure casts fr.instance).
  reset();
  classTable();
  wr32(TABLE + 4 * 22, RELEASED);
  wr32(LOCALS + 44, 22);
  wr32(SELF_IMG + 0x20, 22);
  same(objectOf(w(K.LOCAL_OBJECT, 44)), 0, 'a released handle in a local reads None');
  same(objectOf(w(K.FIELD_OBJECT, 0x20, node(), 4)), 0, 'a released handle in a field reads None');
  same(value(R.BOOL, w(K.OBJECT_EQ, w(K.LOCAL_OBJECT, 44), E.none())), true, 'a released handle equals None');
  same(objectOf(castOf(CR.A, w(K.LOCAL_OBJECT, 44))), 0, 'a released handle casts to None');
  same(count('classRow') + count('cast'), 0, 'no lookup for a released handle');
  wr32(TABLE + 4 * SELF_H, RELEASED);
  same(objectOf(castOf(CR.B, E.self())), SELF_H, 'a released SELF handle casts in JavaScript');
  same(count('cast'), 1, 'released SELF: js_cast');
  wr32(LOCALS + 48, 200);
  same(objectOf(w(K.LOCAL_OBJECT, 48)), 200, 'a handle beyond the table is live');
  wr32(LOCALS + 48, TABLE_CAP);
  same(objectOf(w(K.LOCAL_OBJECT, 48)), TABLE_CAP, 'the capacity is exclusive');
  // CHECK: a cast Rust decides reports the value handle and its result.
  reset();
  classTable();
  wr32(CHECK_AT, 1);
  const checkedCast = castOf(CR.D, w(K.JS_OBJECT, node(() => 21)));
  same(objectOf(checkedCast), 0, 'checked cast');
  const check = calls.find(c => c.imp === 'check');
  same(check?.receiver, 21, 'js_check gets the value handle');
  same(check?.kind, CK.CAST, 'js_check kind CAST');
  same(check?.value, 0, 'js_check value');
  same(check?.node, checkedCast[2], 'js_check node');
  reset();
  classTable();
  wr32(CHECK_AT, 1);
  objectOf(castOf(CR.A, w(K.JS_OBJECT, node(() => 25))));
  same(count('check'), 0, 'a JavaScript cast is not checked');
}

// ---- R2b-5: DefaultVariable (compileEv 0x02, defaultReference) ------------------------------
// The class default image is what classImage writes (writeCell of each
// defaultValue), so a read at the property's offset with the cell codec is
// defaultReference's value while the image is current.
{
  const IMAGE = arena.alloc(256), OTHER_DEFAULTS = arena.alloc(256);
  const defaultsOf = base => {
    arena.bytes.fill(0, base, base + 256);
    wr32(base + 0x10, -77);
    wr32(base + 0x14, 0xc300);
    wr32(base + 0x18, 0b1010);
    wr32(base + 0x1c, bits(-2.75));
  };
  const READS = [
    // [return kind, kind, offset, mask, value read, CK kind]
    [R.INT, K.DEFAULT_INT, 0x10, 0, base => view().getInt32(base + 0x10, true), CK.INT],
    [R.INT, K.DEFAULT_BYTE, 0x15, 0, base => view().getUint8(base + 0x15), CK.INT],
    [R.BOOL, K.DEFAULT_BOOL, 0x18, 8, base => (view().getUint32(base + 0x18, true) & 8) !== 0, CK.BOOL],
    [R.BOOL, K.DEFAULT_BOOL, 0x18, 4, base => (view().getUint32(base + 0x18, true) & 4) !== 0, CK.BOOL],
    [R.FLOAT, K.DEFAULT_FLOAT, 0x1c, 0, base => view().getFloat32(base + 0x1c, true), CK.FLOAT],
  ];
  const expr = (kind, offset, mask, n, owner) => kind === K.DEFAULT_BOOL ? w(kind, offset, n, owner, mask) : w(kind, offset, n, owner);
  const setup = () => {
    reset();
    classTable();
    defaultsOf(IMAGE);
    defaultsOf(OTHER_DEFAULTS);
    wr32(OTHER_DEFAULTS + 0x10, 91);
    wr32(OTHER_DEFAULTS + 0x1c, bits(0.5));
  };
  const own = classRecordId(CR.B), foreign = classRecordId(CR.E);
  for (const [rkind, kind, offset, mask, read, ck] of READS) {
    // Fast path: SELF's class C (chain A, B, C) declares B's property.
    setup();
    classRow(CLS.C, IMAGE);
    wr32(TABLE + 4 * SELF_H, rowAddresses.get(CLS.C));
    same(value(rkind, expr(kind, offset, mask, node(), own)), read(IMAGE), `DEFAULT kind ${kind} at ${offset}`);
    same(count('classRow'), 0, 'a described receiver needs no lookup');
    // Not described yet: js_class_row describes it.
    setup();
    classRow(CLS.C, IMAGE);
    same(value(rkind, expr(kind, offset, mask, node(), own)), read(IMAGE), 'DEFAULT after js_class_row');
    same(count('classRow'), 1, 'js_class_row once');
    same(rd32(TABLE + 4 * SELF_H), rowAddresses.get(CLS.C), 'the row is in the table');
    // A row whose image word is 0 is validated again by the host.
    setup();
    classRow(CLS.C, 0);
    wr32(TABLE + 4 * SELF_H, rowAddresses.get(CLS.C));
    classRowHost = handle => (wr32(rowAddresses.get(CLS.C), IMAGE), describeHandle(handle));
    same(value(rkind, expr(kind, offset, mask, node(), own)), read(IMAGE), 'DEFAULT after the image is validated');
    same(count('classRow'), 1, 'image 0 asks the host');
    // Context receiver: OTHER_H (class D: A, D) with its own image; B's
    // property is not in D's PropertyLink, A's is.
    setup();
    classRow(CLS.D, OTHER_DEFAULTS);
    wr32(LOCALS + 44, OTHER_H);
    same(value(rkind, E.context(node(), w(K.LOCAL_OBJECT, 44), expr(kind, offset, mask, node(), classRecordId(CR.A)))),
      read(OTHER_DEFAULTS), 'DEFAULT on a context receiver');
    // The JavaScript paths: the node on the current receiver.
    for (const [why, prepare, receiver] of [
      ['HOST receiver', () => infos.set(SELF_H, SELF_IMG | HOST), SELF_H],
      ['undescribed receiver', () => { classRowHost = () => 0; }, SELF_H],
      ['unreadable image', () => { classRow(CLS.C, UNREADABLE); wr32(TABLE + 4 * SELF_H, rowAddresses.get(CLS.C)); }, SELF_H],
      ['owner outside the chain', () => { classRow(CLS.C, IMAGE); wr32(TABLE + 4 * SELF_H, rowAddresses.get(CLS.C)); }, SELF_H],
      ['context owner outside the chain', () => { classRow(CLS.D, OTHER_DEFAULTS); wr32(LOCALS + 44, OTHER_H); }, OTHER_H],
    ]) {
      setup();
      prepare();
      const hostValue = rkind === R.BOOL ? 'yes' : rkind === R.FLOAT ? 0.25 : 1234;
      const n = node(r => (calls.push({imp: 'default-host', receiver: r}), hostValue));
      const owner = why.includes('owner') ? foreign : own;
      const e = expr(kind, offset, mask, n, owner);
      const result = value(rkind, receiver === OTHER_H ? E.context(node(), w(K.LOCAL_OBJECT, 44), e) : e);
      same(result, rkind === R.BOOL ? true : rkind === R.FLOAT ? 0.25 : kind === K.DEFAULT_BYTE ? 1234 : 1234, `DEFAULT ${why}`);
      same(calls.filter(c => c.imp === 'default-host').length, 1, `DEFAULT ${why}: the node in JavaScript`);
      same(calls.find(c => c.imp === 'default-host').receiver, receiver, `DEFAULT ${why}: receiver`);
      if (why === 'HOST receiver') same(count('classRow'), 0, 'a HOST receiver needs no row');
    }
    // CHECK: a read Rust completes reports its value.
    setup();
    classRow(CLS.C, IMAGE);
    wr32(TABLE + 4 * SELF_H, rowAddresses.get(CLS.C));
    wr32(CHECK_AT, 1);
    const n = node();
    value(rkind, expr(kind, offset, mask, n, own));
    const check = calls.find(c => c.imp === 'check');
    same(check?.node, n, 'DEFAULT check node');
    same(check?.receiver, SELF_H, 'DEFAULT check receiver');
    same(check?.kind, ck, 'DEFAULT check kind');
    same(check?.value, ck === CK.BOOL ? Number(read(IMAGE)) : read(IMAGE), 'DEFAULT check value');
  }
}

// ---- R2b-5: array elements (compileEv 0x1a) and members of elements (0x36 over 0x1a) -------
// arrayReference: the index (evaluated first, with SELF) selects element
// `index` of the fixed array when 0 <= index < dim; otherwise it warns and
// clamps, which the JavaScript node does. A member read is the element's
// member at its offset (structValue on the element reference).
{
  const ARRAY = 0x40, STRIDE = 12, DIM = 5;
  const fill = base => {
    for (let i = 0; i < DIM; i++) {
      const at = base + ARRAY + i * STRIDE;
      wr32(at, -1000 - i);
      wr32(at + 4, bits(0.1 * (i + 1)));
      wr32(at + 8, i % 2 ? 0x10 | (i << 8) : (0x80 + i) << 8 | 0x1e);
    }
  };
  // [return kind, kinds (field, local), member offset, mask, reader]
  const ELEMENTS = [
    [R.INT, [K.FIELD_ELEM_INT, K.LOCAL_ELEM_INT], 0, 0, at => view().getInt32(at, true)],
    [R.FLOAT, [K.FIELD_ELEM_FLOAT, K.LOCAL_ELEM_FLOAT], 4, 0, at => view().getFloat32(at, true)],
    [R.INT, [K.FIELD_ELEM_BYTE, K.LOCAL_ELEM_BYTE], 9, 0, at => view().getUint8(at)],
    [R.BOOL, [K.FIELD_ELEM_BOOL, K.LOCAL_ELEM_BOOL], 8, 0x100, at => (view().getUint32(at, true) & 0x100) !== 0],
  ];
  const elem = (kind, member, mask, n, key, index) => {
    const field = kind <= K.FIELD_ELEM_OBJECT, parts = [kind, ARRAY + member, STRIDE, DIM, n];
    if (field) parts.push(key);
    if (mask) parts.push(mask);
    return w(...parts, index);
  };
  const INDICES = [0, 1, DIM - 1, -1, DIM, 0x7fffffff, -0x80000000, 256];
  const indexOperand = (v, i) => i % 2 ? E.int(v) : (wr32(LOCALS + 0x80, v), w(K.LOCAL_INT, 0x80));
  for (const [rkind, kinds, member, mask, read] of ELEMENTS) {
    for (const kind of kinds) {
      const field = kind === kinds[0], base = field ? SELF_IMG : LOCALS;
      INDICES.forEach((index, i) => {
        reset();
        fill(base);
        const hostValue = rkind === R.BOOL ? 1 : rkind === R.FLOAT ? 0.75 : 4321;
        const n = node(r => (calls.push({imp: 'elem-host', receiver: r}), hostValue));
        const inRange = index >= 0 && index < DIM;
        const expected = inRange ? read(base + ARRAY + index * STRIDE + member) : rkind === R.BOOL ? true : hostValue;
        same(value(rkind, elem(kind, member, mask, n, 4, indexOperand(index, i))), expected, `element kind ${kind} [${index}]`);
        same(calls.filter(c => c.imp === 'elem-host').length, inRange ? 0 : 1, `element kind ${kind} [${index}] JavaScript path`);
        if (!inRange) same(calls.find(c => c.imp === 'elem-host').receiver, SELF_H, 'out of range: the node on the receiver');
      });
      // CHECK reports a Rust read.
      reset();
      fill(base);
      wr32(CHECK_AT, 1);
      const n = node();
      value(rkind, elem(kind, member, mask, n, 4, E.int(2)));
      const check = calls.find(c => c.imp === 'check');
      same(check?.node, n, 'element check node');
      same(check?.receiver, SELF_H, 'element check receiver');
      same(check?.kind, rkind === R.INT ? CK.INT : rkind === R.BOOL ? CK.BOOL : CK.FLOAT, 'element check kind');
      same(check?.value, Number(read(base + ARRAY + 2 * STRIDE + member)), 'element check value');
    }
  }
  // Object elements go through `live`.
  for (const kind of [K.FIELD_ELEM_OBJECT, K.LOCAL_ELEM_OBJECT]) {
    reset();
    classTable();
    const base = kind === K.FIELD_ELEM_OBJECT ? SELF_IMG : LOCALS;
    wr32(base + ARRAY + STRIDE, OTHER_H);
    wr32(base + ARRAY + 2 * STRIDE, 22);
    wr32(TABLE + 4 * 22, RELEASED);
    same(objectOf(elem(kind, 0, 0, node(), 4, E.int(1))), OTHER_H, `object element kind ${kind}`);
    same(objectOf(elem(kind, 0, 0, node(), 4, E.int(2))), 0, `released object element kind ${kind} is None`);
    same(objectOf(elem(kind, 0, 0, node(() => THIRD_H), 4, E.int(DIM))), THIRD_H, `object element kind ${kind} out of range`);
  }
  // Field storage: BOUND (bound key) and HOST take the JavaScript path; a
  // context receiver reads its own image; the index comes first, with SELF.
  for (const [flags, key, jsPath] of [[BOUND, 3, true], [BOUND, 4, false], [HOST, 4, true], [0, 3, false]]) {
    reset();
    fill(SELF_IMG);
    infos.set(SELF_H, SELF_IMG | flags);
    const n = node(r => (calls.push({imp: 'elem-host', receiver: r}), 55));
    const index = node(r => (calls.push({imp: 'index', receiver: r}), 3));
    same(value(R.INT, elem(K.FIELD_ELEM_INT, 0, 0, n, key, w(K.JS_INT, index))), jsPath ? 55 : -1003, `field element flags ${flags} key ${key}`);
    const order = calls.filter(c => c.imp === 'int' && c.node === index || c.imp === 'receiver').map(c => c.imp).join(',');
    same(order, 'int,receiver', 'the index is evaluated before the storage is selected');
    same(calls.filter(c => c.imp === 'elem-host').length, jsPath ? 1 : 0, `field element flags ${flags} key ${key} path`);
  }
  reset();
  fill(OTHER_IMG);
  wr32(LOCALS + 44, OTHER_H);
  const index = node(r => (calls.push({imp: 'index', receiver: r}), 4));
  same(value(R.INT, E.context(node(), w(K.LOCAL_OBJECT, 44), elem(K.FIELD_ELEM_INT, 0, 0, node(), 4, w(K.JS_INT, index)))), -1004,
    'field element of a context receiver');
  same(calls.find(c => c.imp === 'index').receiver, SELF_H, 'the index of a context value is evaluated with SELF');
}

// ---- R2b-5: state statements (vm_statement) --------------------------------------------------
// stepCompiled's cases for one statement after the host's loop advanced the
// cursor: an effect, a jump (1: the host sets the cursor to its target) or a
// conditional jump, GRunaway counted before the condition; the loop's hang
// budget is the host's.
{
  const statement = (statements, index, runaway = 0) => {
    const code = assemble(statements);
    wr32(RUNAWAY_AT, runaway);
    wr32(BUDGET_AT, 777);
    return enter(() => x.vm_statement(code, FRAME, LOCALS, SELF_H, index));
  };
  reset();
  const body = [S.expr(w(K.SET_LOCAL_INT, 0x40, E.int(9))), S.jump(0), S.jumpIfNot(0, E.bool(0)), S.jumpIfNot(0, E.bool(1)), S.nothing(),
    S.expr(w(K.JS_VOID, node(() => {}))), S.ret(R.VOID), S.yield()];
  same(statement(body, 0), 0, 'S_EXPR continues');
  same(rd32(LOCALS + 0x40), 9, 'S_EXPR effect');
  same(rd32(BUDGET_AT), 777, 'the host counts the budget');
  same(statement(body, 1, 5), 1, 'S_JUMP jumps');
  same(rd32(RUNAWAY_AT), 6, 'S_JUMP counts GRunaway');
  same(statement(body, 2, 5), 1, 'S_JUMP_IF_NOT false jumps');
  same(statement(body, 3, 5), 0, 'S_JUMP_IF_NOT true continues');
  same(rd32(RUNAWAY_AT), 6, 'S_JUMP_IF_NOT counts GRunaway');
  same(statement(body, 4), 0, 'S_NOTHING');
  calls.length = 0;
  same(statement(body, 5), 0, 'S_EXPR JS_VOID');
  same(count('eval'), 1, 'the effect runs in JavaScript');
  const order = [];
  const probe = node(() => (order.push(rd32(RUNAWAY_AT)), true));
  statement([S.jumpIfNot(0, w(K.JS_BOOL, probe))], 0, 41);
  same(order[0], 42, 'GRunaway is counted before the condition');
  same(vmError(() => statement(body, 1, RUNAWAY_LIMIT)).code, ERR.RUNAWAY, 'runaway limit');
  same(rd32(RUNAWAY_AT), 0, 'the runaway count resets');
  same(vmError(() => statement(body, 6)).code, ERR.KIND, 'a Return is not a state statement here');
  same(vmError(() => statement(body, 7)).code, ERR.KIND, 'a yield is not a state statement here');
  same(vmError(() => statement(body, 8)).code, ERR.OUTSIDE, 'an index outside the body');
}

// ---- Coverage ---------------------------------------------------------------------------
const missing = Object.entries(K).filter(([, kind]) => !used.has(kind)).map(([name]) => name);
assert.deepEqual(missing, [], 'every contract kind is exercised');
console.log(`validate-script-vm-interp: ${Object.keys(K).length} kinds, ${checks} checks equal to the JavaScript VM ` +
  `(__heap_base 0x${x.__heap_base.value.toString(16)})`);
