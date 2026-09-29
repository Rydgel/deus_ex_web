//! The statement loop and typed expression evaluator (docs/rust-core.md,
//! step R2b-2). The lowered word code and its semantics are the contract with
//! the JavaScript lowering pass (script-vm-lower.mjs); every kind transcribes
//! the JavaScript VM's closure for the same original node (script-vm.mjs:
//! `native` for the operators, `compileEv`/`compileAssign` for variables,
//! contexts and conversions, `resumeCompiled` for the statement loop). A node
//! this file has no kind for is lowered to a `JS_*` kind, which evaluates the
//! original node with the JavaScript closures on the same frame.
//!
//! Values: int, byte and bool as i32/bool; float as f64, the JavaScript
//! number the closures carry (so `Math.fround(a * b)` is
//! `((a * b) as f32) as f64`), with `UNDEF_F64` standing for a JavaScript
//! undefined; object as a handle (script-object-handles.mjs), 0 for None and
//! `UNDEFINED` for a JavaScript undefined.
//!
//! Re-entrancy: an import may run another script function, which enters
//! `vm_run` again, and a CALL runs its callee as a nested `Run` in the same
//! invocation. Each run's state lives in its own `Run` on the shadow stack;
//! only the words the host synchronizes are statics.
//!
//! Stores (effects, after S_EXPR). A local store writes the frame block at
//! `locals + off`. A SELF field store (`off, node, key, len`, then the value)
//! selects the storage first with the field fast-path rule; a field on the
//! JavaScript path skips the `len` value words unevaluated and runs `node`
//! (the whole original node) with js_eval. The value is then evaluated with
//! SELF as receiver and stored by the property codec: int as the word, byte
//! as its low byte, bool merged into the word read after the value, float as
//! its f32 bits (UNDEF_F64 as 0.0), object as the handle word (UNDEFINED as
//! 0: copyPointer's `value ?? null`, then the POINTER cell's handle).
//! * SET_LOCAL_OBJECT 68 `off`; SET_FIELD_OBJECT 69 `off, node, key, len`
//!   (never Actor.Base, whose JavaScript store bumps an epoch).
//! * COMPOUND_LOCAL 56 `op, off`; COMPOUND_FIELD 57 `op, off, node, key,
//!   len` (`node` the out native's call node): a statement `X op= V` on a
//!   local or SELF field (compileNative evaluates X as a reference, then V,
//!   then the native reads X). An unknown `op` fails first with ERR_KIND.
//!   After the storage: `b` = V, then `a` = the target's current value, then
//!   the store. Ops: 1 `+=` float (native 184) f(a + b); 2 `-=` float (185)
//!   f(f(a) - f(b)); 3 `*=` float (182) f(a * b), with `a` the widened f32
//!   and `b` a float value (UNDEF_F64 computes as JavaScript's NaN from
//!   undefined, never as a store's 0); 4 `+=` int (161) and 5 `-=` int (162),
//!   wrapping i32.
//!
//! Compares added with the stores: INT_LE 96 / INT_GE 113 (natives 152/153,
//! signed); FLOAT_LE 127 (native 178) `!(f(a ?? 0) > f(b ?? 0))`: UNDEF_F64
//! counts as 0.0 before the fround (the raw compares 125/126/128 do not), a
//! NaN stays NaN, so an unordered pair is true.

use core::ptr::{addr_of, addr_of_mut, read_unaligned, write_unaligned};

const UNDEFINED: u32 = u32::MAX;
const UNDEF_F64_BITS: u64 = 0x7ff8_0000_0000_0001;
/// js_step: the callee returned in JavaScript (RESULT written there).
const RETURNED: u32 = 0xffff_fffe;

// Statement kinds.
const S_EXPR: u32 = 1;
const S_JUMP: u32 = 2;
const S_JUMP_IF_NOT: u32 = 3;
const S_RETURN: u32 = 4;
const S_NOTHING: u32 = 5;
const S_YIELD: u32 = 6;
// IteratorNext / IteratorPop of a foreach whose Iterator statement ran in
// JavaScript: the host keeps the frame's iterator stack.
const S_ITER_NEXT: u32 = 7;
const S_ITER_POP: u32 = 8;
// Expression kinds.
const LIT_INT: u32 = 20;
const LIT_FLOAT: u32 = 21;
const LIT_BOOL: u32 = 23;
const LIT_NONE: u32 = 24;
const LOCAL_INT: u32 = 30;
const LOCAL_BYTE: u32 = 31;
const LOCAL_BOOL: u32 = 32;
const LOCAL_FLOAT: u32 = 33;
const LOCAL_OBJECT: u32 = 34;
const FIELD_INT: u32 = 40;
const FIELD_BYTE: u32 = 41;
const FIELD_BOOL: u32 = 42;
const FIELD_FLOAT: u32 = 43;
const FIELD_OBJECT: u32 = 44;
const JS_INT: u32 = 50;
const JS_BOOL: u32 = 52;
const JS_FLOAT: u32 = 53;
const JS_OBJECT: u32 = 54;
const JS_VOID: u32 = 55;
const COMPOUND_LOCAL: u32 = 56;
const COMPOUND_FIELD: u32 = 57;
const SET_LOCAL_INT: u32 = 60;
const SET_LOCAL_BYTE: u32 = 61;
const SET_LOCAL_BOOL: u32 = 62;
const SET_LOCAL_FLOAT: u32 = 63;
const SET_FIELD_INT: u32 = 64;
const SET_FIELD_BYTE: u32 = 65;
const SET_FIELD_BOOL: u32 = 66;
const SET_FIELD_FLOAT: u32 = 67;
const SET_LOCAL_OBJECT: u32 = 68;
const SET_FIELD_OBJECT: u32 = 69;
const CONTEXT: u32 = 70;
const SELF_OBJECT: u32 = 71;
const CALL: u32 = 72;
const NOT: u32 = 80;
const AND: u32 = 81;
const OR: u32 = 82;
const BOOL_NE: u32 = 83;
const BOOL_EQ: u32 = 84;
const INT_ADD: u32 = 90;
const INT_SUB: u32 = 91;
const INT_MUL: u32 = 92;
const INT_LT: u32 = 93;
const INT_GT: u32 = 94;
const INT_DIV: u32 = 95;
const INT_LE: u32 = 96;
const INT_EQ: u32 = 97;
const INT_NE: u32 = 98;
const INT_AND: u32 = 99;
const INT_XOR: u32 = 100;
const INT_OR: u32 = 101;
const INT_NEG: u32 = 102;
const INT_NOT: u32 = 103;
const INT_SHL: u32 = 104;
const INT_SAR: u32 = 105;
const INT_SHR: u32 = 106;
const INT_MIN: u32 = 107;
const INT_MAX: u32 = 108;
const INT_CLAMP: u32 = 109;
const INC_LOCAL_PRE: u32 = 110;
const DEC_LOCAL_PRE: u32 = 111;
const INC_LOCAL_POST: u32 = 112;
const INT_GE: u32 = 113;
const FLOAT_MUL: u32 = 120;
const FLOAT_DIV: u32 = 121;
const FLOAT_ADD: u32 = 122;
const FLOAT_SUB: u32 = 123;
const FLOAT_NEG: u32 = 124;
const FLOAT_LT: u32 = 125;
const FLOAT_GT: u32 = 126;
const FLOAT_LE: u32 = 127;
const FLOAT_GE: u32 = 128;
const FLOAT_EQ: u32 = 129;
const FLOAT_NE: u32 = 130;
const FLOAT_NEAR: u32 = 131;
const FLOAT_MIN: u32 = 132;
const FLOAT_MAX: u32 = 133;
const OBJECT_EQ: u32 = 140;
const OBJECT_NE: u32 = 141;
const BYTE_TO_INT: u32 = 150;
const INT_TO_BYTE: u32 = 151;
const INT_TO_FLOAT: u32 = 152;
const BYTE_TO_FLOAT: u32 = 153;
const FLOAT_TO_INT: u32 = 154;
const FLOAT_TO_BYTE: u32 = 155;

// COMPOUND_LOCAL / COMPOUND_FIELD ops.
const C_FLOAT_ADD: u32 = 1;
const C_FLOAT_SUB: u32 = 2;
const C_FLOAT_MUL: u32 = 3;
const C_INT_ADD: u32 = 4;
const C_INT_SUB: u32 = 5;

// Receiver info: the image base with flags in the low bits (bases are
// 16-byte aligned). BOUND: the instance has host bindings, so a field whose
// key is marked in the bound-keys table takes the JavaScript path. HOST:
// every field does (no image, a poisoned value, a released allocation, a
// class receiver).
const BOUND: u32 = 1;
const HOST: u32 = 2;

// Errors raised through js_error, which throws the JavaScript VM's message.
const ERR_HANG: u32 = 1;
const ERR_RUNAWAY: u32 = 2;
const ERR_OUTSIDE: u32 = 3;
const ERR_KIND: u32 = 4;
const ERR_DIV_OVERFLOW: u32 = 5;
const ERR_FLOAT_TO_INT: u32 = 6;
const ERR_FLOAT_TO_BYTE: u32 = 7;

// CALL result kinds (also S_RETURN's) and argument kinds.
const R_VOID: u32 = 0;
const R_INT: u32 = 1;
const R_BOOL: u32 = 2;
const R_FLOAT: u32 = 3;
const R_OBJECT: u32 = 4;
const P_SKIP: u32 = 0;
const P_INT: u32 = 1;
const P_BOOL: u32 = 2;
const P_FLOAT: u32 = 3;
const P_OBJECT: u32 = 4;
const P_BYTE: u32 = 5;

/// Core's runaway-loop limit (script-vm.mjs SCRIPT_RUNAWAY_LIMIT).
const RUNAWAY_LIMIT: u32 = 10_000_000;
/// resumeCompiled's hang guard: each script frame's statement budget.
const HANG_BUDGET: u32 = 200_000_000;
/// 2^63: `_ftol`'s int64 range, the JavaScript conversions' boundary.
const TWO_63: f64 = 9_223_372_036_854_775_808.0;

#[link(wasm_import_module = "env")]
extern "C" {
    fn js_int(frame: u32, node: u32, receiver: u32) -> i32;
    fn js_float(frame: u32, node: u32, receiver: u32) -> f64;
    fn js_bool(frame: u32, node: u32, receiver: u32) -> i32;
    fn js_object(frame: u32, node: u32, receiver: u32) -> u32;
    fn js_eval(frame: u32, node: u32, receiver: u32);
    fn js_receiver(handle: u32) -> u32;
    fn js_accessed_none(frame: u32, node: u32);
    fn js_error(frame: u32, code: u32, node: u32);
    fn js_iterator_next(frame: u32) -> u32;
    fn js_iterator_pop(frame: u32);
    fn js_call_begin(frame: u32, node: u32, receiver: u32, sig: u32) -> i32;
    fn js_step(frame: u32, index: u32) -> u32;
    fn js_frame_advance(size: u32);
}

// The words the host synchronizes. RUNAWAY is the JavaScript VM's
// scriptRunaway (the host writes it before each entry and after each import
// returns, and reads it back); BUDGET the remaining hang budget; RESULT a
// typed Return's value; FLOAT_UNDEF set by js_float when its value was
// undefined; BOUND_KEYS [table address, length] of the bound field keys;
// FRAMES the frame-block FMemStack [chunk index, top, end], shared with the
// JavaScript FrameStack (script-frame-locals.mjs), then the host's count of
// active runs (the next run id), restored with the stack after a call;
// CALL_BLOCK [callee locals,
// callee code, callee SELF], written by js_call_begin.
static mut RUNAWAY: u32 = 0;
static mut BUDGET: u32 = 0;
static mut RESULT: f64 = 0.0;
static mut FLOAT_UNDEF: u32 = 0;
static mut BOUND_KEYS: [u32; 2] = [0; 2];
static mut FRAMES: [u32; 4] = [0; 4];
static mut CALL_BLOCK: [u32; 3] = [0; 3];

#[no_mangle]
pub extern "C" fn vm_runaway_ptr() -> *mut u32 {
    addr_of_mut!(RUNAWAY)
}
#[no_mangle]
pub extern "C" fn vm_budget_ptr() -> *mut u32 {
    addr_of_mut!(BUDGET)
}
#[no_mangle]
pub extern "C" fn vm_result_ptr() -> *mut f64 {
    addr_of_mut!(RESULT)
}
#[no_mangle]
pub extern "C" fn vm_float_undef_ptr() -> *mut u32 {
    addr_of_mut!(FLOAT_UNDEF)
}
#[no_mangle]
pub extern "C" fn vm_bound_keys_ptr() -> *mut u32 {
    addr_of_mut!(BOUND_KEYS) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_frames_ptr() -> *mut u32 {
    addr_of_mut!(FRAMES) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_call_block_ptr() -> *mut u32 {
    addr_of_mut!(CALL_BLOCK) as *mut u32
}

#[inline(always)]
fn frames_save() -> [u32; 4] {
    unsafe { *addr_of!(FRAMES) }
}
#[inline(always)]
fn frames_restore(saved: [u32; 4]) {
    unsafe { *addr_of_mut!(FRAMES) = saved }
}

/// FrameStack.push (script-frame-locals.mjs): a zeroed frame block of `size`
/// bytes from the FMemStack in FRAMES; JavaScript picks or creates the next
/// chunk when this one is full. Returns the block's base.
#[no_mangle]
pub extern "C" fn vm_frame_push(size: u32) -> u32 {
    let aligned = size.wrapping_add(7) & !7;
    unsafe {
        let frames = addr_of_mut!(FRAMES) as *mut u32;
        if *frames.add(1) as u64 + aligned as u64 > *frames.add(2) as u64 {
            js_frame_advance(aligned);
        }
        let base = *frames.add(1);
        *frames.add(1) = base.wrapping_add(aligned);
        core::ptr::write_bytes(base as usize as *mut u8, 0, aligned as usize);
        base
    }
}

#[inline(always)]
fn load32(addr: u32) -> u32 {
    unsafe { read_unaligned(addr as usize as *const u32) }
}
#[inline(always)]
fn store32(addr: u32, value: u32) {
    unsafe { write_unaligned(addr as usize as *mut u32, value) }
}
#[inline(always)]
fn load8(addr: u32) -> u8 {
    unsafe { *(addr as usize as *const u8) }
}
#[inline(always)]
fn store8(addr: u32, value: u8) {
    unsafe { *(addr as usize as *mut u8) = value }
}
/// Math.fround.
#[inline(always)]
fn fround(v: f64) -> f64 {
    v as f32 as f64
}
#[inline(always)]
fn float_of(bits: u32) -> f64 {
    f32::from_bits(bits) as f64
}
/// The float codec's store: `Math.fround(Number(v ?? 0))`.
#[inline(always)]
fn float_bits(v: f64) -> u32 {
    if v.to_bits() == UNDEF_F64_BITS {
        0
    } else {
        (v as f32).to_bits()
    }
}
/// A POINTER cell's word for an object value: copyPointer's `value ?? null`
/// (UNDEFINED is None), then the handle, 0 for None.
#[inline(always)]
fn pointer_word(handle: u32) -> u32 {
    if handle == UNDEFINED {
        0
    } else {
        handle
    }
}
/// `r`, the FPU's result of JavaScript's `x op y`, with the NaN operand
/// choice made explicit: a NaN operand yields the first NaN operand, quieted,
/// which is what the FPU returns for `x op y` in that operand order (x86 SSE
/// and ARM alike for quiet operands; JavaScript's float values are quiet, as
/// its f32 widening quiets them). Rust leaves the payload of a NaN result
/// unspecified: LLVM's wasm stackifier commutes f64.add/f64.mul operands
/// when the second was computed first (a compound's value is evaluated
/// before its target is read), which would return y's payload, and LLVM may
/// fold an f32 widening with the fround after it, so an f32 sNaN target
/// would pass through unquieted. Both are measured by the validator. A NaN
/// from non-NaN operands (inf - inf, 0 * inf) stays the FPU's default NaN,
/// as it is in JavaScript on the same machine.
#[inline(always)]
fn nan_first(x: f64, y: f64, r: f64) -> f64 {
    const QUIET: u64 = 0x0008_0000_0000_0000;
    if x.is_nan() {
        f64::from_bits(x.to_bits() | QUIET)
    } else if y.is_nan() {
        f64::from_bits(y.to_bits() | QUIET)
    } else {
        r
    }
}
/// FLOAT_LE's `v ?? 0`: an undefined float value is 0.
#[inline(always)]
fn undef_zero(v: f64) -> f64 {
    if v.to_bits() == UNDEF_F64_BITS {
        0.0
    } else {
        v
    }
}
/// ToInt32, as copyValue's int `Number(value) | 0` applies it to a result.
#[inline(always)]
fn to_int32(v: f64) -> i32 {
    if v > -2_147_483_649.0 && v < 2_147_483_648.0 {
        return v as i32;
    }
    if !v.is_finite() {
        return 0;
    }
    if v > -TWO_63 && v < TWO_63 {
        return v as i64 as i32;
    }
    // |v| >= 2^63 is an integer m * 2^e with e >= 11: its low 32 bits.
    let bits = v.to_bits();
    let e = ((bits >> 52) & 0x7ff) as i32 - 1075;
    let m = (bits & ((1 << 52) - 1)) | (1 << 52);
    let low = if e >= 32 { 0 } else { (m << e) as u32 };
    (if bits >> 63 != 0 { low.wrapping_neg() } else { low }) as i32
}
#[inline(always)]
fn merge_bool(word: u32, mask: u32, value: bool) -> u32 {
    if value {
        word | mask
    } else {
        word & !mask
    }
}

/// An expression's receiver. `handle` 0 is SELF, whose info the run caches;
/// any other handle is a context object (never None or undefined), with the
/// info fetched when that object became known.
#[derive(Clone, Copy)]
struct Recv {
    handle: u32,
    info: u32,
}
const SELF: Recv = Recv { handle: 0, info: 0 };

struct Run {
    code: *const u32,
    pc: *const u32,
    frame: u32,
    locals: u32,
    self_handle: u32,
    self_info: u32,
    self_fresh: bool,
    /// A CALL's callee: an S_YIELD statement runs through js_step here
    /// instead of returning to the host.
    callee: bool,
}

#[cold]
#[inline(never)]
fn fail(frame: u32, code: u32, node: u32) -> ! {
    unsafe { js_error(frame, code, node) };
    core::arch::wasm32::unreachable()
}

impl Run {
    /// Operand word `i` of the node at pc.
    #[inline(always)]
    fn op(&self, i: usize) -> u32 {
        unsafe { *self.pc.add(i) }
    }
    #[inline(always)]
    fn skip(&mut self, words: usize) {
        self.pc = unsafe { self.pc.add(words) };
    }
    #[inline(always)]
    fn fail(&self, code: u32, node: u32) -> ! {
        fail(self.frame, code, node)
    }
    #[inline(always)]
    fn handle(&self, r: Recv) -> u32 {
        if r.handle == 0 {
            self.self_handle
        } else {
            r.handle
        }
    }

    // Imports. Every one except js_receiver may run JavaScript that adds
    // bindings or poison to SELF or releases it, so SELF's info goes stale.
    fn host_int(&mut self, node: u32, r: Recv) -> i32 {
        let v = unsafe { js_int(self.frame, node, self.handle(r)) };
        self.self_fresh = false;
        v
    }
    fn host_float(&mut self, node: u32, r: Recv) -> f64 {
        let v = unsafe { js_float(self.frame, node, self.handle(r)) };
        self.self_fresh = false;
        unsafe {
            if FLOAT_UNDEF != 0 {
                FLOAT_UNDEF = 0;
                return f64::from_bits(UNDEF_F64_BITS);
            }
        }
        v
    }
    fn host_bool(&mut self, node: u32, r: Recv) -> bool {
        let v = unsafe { js_bool(self.frame, node, self.handle(r)) };
        self.self_fresh = false;
        v != 0
    }
    fn host_object(&mut self, node: u32, r: Recv) -> u32 {
        let v = unsafe { js_object(self.frame, node, self.handle(r)) };
        self.self_fresh = false;
        v
    }
    fn host_eval(&mut self, node: u32, r: Recv) {
        unsafe { js_eval(self.frame, node, self.handle(r)) };
        self.self_fresh = false;
    }

    /// SELF's receiver info, refetched after any import other than
    /// js_receiver ran.
    #[inline(always)]
    fn self_info(&mut self) -> u32 {
        if !self.self_fresh {
            self.self_info = unsafe { js_receiver(self.self_handle) };
            self.self_fresh = true;
        }
        self.self_info
    }

    /// The address of `r`'s field at `offset` with key id `key`, or None
    /// when the field takes the JavaScript path.
    #[inline(always)]
    fn field(&mut self, r: Recv, key: u32, offset: u32) -> Option<u32> {
        let info = if r.handle == 0 { self.self_info() } else { r.info };
        if info & (HOST | BOUND) != 0 {
            if info & HOST != 0 {
                return None;
            }
            let keys = addr_of!(BOUND_KEYS) as *const u32;
            let (table, length) = unsafe { (*keys, *keys.add(1)) };
            if key < length && load8(table.wrapping_add(key)) != 0 {
                return None;
            }
        }
        Some((info & !15).wrapping_add(offset))
    }

    /// Core's GRunaway count for a jump, before its condition is evaluated.
    #[inline(always)]
    fn runaway(&self) {
        unsafe {
            let count = RUNAWAY.wrapping_add(1);
            RUNAWAY = count;
            if count > RUNAWAY_LIMIT {
                RUNAWAY = 0;
                self.fail(ERR_RUNAWAY, 0);
            }
        }
    }

    /// resumeCompiled's loop. Returns -1 after a Return (its value in
    /// RESULT) or the index of an S_YIELD statement, which the JavaScript
    /// loop executes (and counts) before re-entering.
    fn statements(&mut self, entry: u32) -> i32 {
        let code = self.code;
        let count = unsafe { *code };
        let mut cursor = entry;
        loop {
            // NEXT_NONE (u32::MAX) is never below the count.
            let inside = cursor < count;
            if inside {
                self.pc = unsafe { code.add(*code.add(1 + 2 * cursor as usize) as usize) };
                if self.op(0) == S_YIELD {
                    if !self.callee {
                        return cursor as i32;
                    }
                    // The callee's statement runs in JavaScript: one step of
                    // its compiled loop, counted as the loop counts it.
                    unsafe {
                        if BUDGET == 0 {
                            self.fail(ERR_HANG, 0);
                        }
                        BUDGET -= 1;
                    }
                    let next = unsafe { js_step(self.frame, cursor) };
                    self.self_fresh = false;
                    if next == RETURNED {
                        return -1;
                    }
                    cursor = next;
                    continue;
                }
            }
            // `if (!budget--)` precedes the instruction lookup in JavaScript.
            unsafe {
                if BUDGET == 0 {
                    self.fail(ERR_HANG, 0);
                }
                BUDGET -= 1;
            }
            if !inside {
                self.fail(ERR_OUTSIDE, 0);
            }
            cursor = unsafe { *code.add(2 + 2 * cursor as usize) };
            let kind = self.op(0);
            match kind {
                S_EXPR => {
                    self.skip(1);
                    self.effect();
                }
                S_JUMP => {
                    let target = self.op(1);
                    self.runaway();
                    cursor = target;
                }
                S_JUMP_IF_NOT => {
                    let target = self.op(1);
                    self.skip(2);
                    self.runaway();
                    if !self.boolean(SELF) {
                        cursor = target;
                    }
                }
                S_RETURN => {
                    let rkind = self.op(1);
                    self.skip(2);
                    let value = match rkind {
                        // A void Return: RESULT holds undefined, never a
                        // nested run's leftover value.
                        R_VOID => f64::from_bits(UNDEF_F64_BITS),
                        R_INT => self.int(SELF) as f64,
                        R_BOOL => self.boolean(SELF) as i32 as f64,
                        R_FLOAT => self.float(SELF),
                        R_OBJECT => self.object(SELF) as f64,
                        _ => self.fail(ERR_KIND, rkind),
                    };
                    unsafe { RESULT = value };
                    return -1;
                }
                S_NOTHING => {}
                S_ITER_NEXT => {
                    cursor = unsafe { js_iterator_next(self.frame) };
                    self.self_fresh = false;
                }
                S_ITER_POP => {
                    unsafe { js_iterator_pop(self.frame) };
                    self.self_fresh = false;
                }
                _ => self.fail(ERR_KIND, kind),
            }
        }
    }

    /// A statement expression, evaluated for its effect.
    fn effect(&mut self) {
        let kind = self.op(0);
        match kind {
            JS_VOID => {
                let node = self.op(1);
                self.skip(2);
                self.host_eval(node, SELF);
            }
            SET_LOCAL_INT => {
                let addr = self.locals.wrapping_add(self.op(1));
                self.skip(2);
                let v = self.int(SELF);
                store32(addr, v as u32);
            }
            SET_LOCAL_BYTE => {
                let addr = self.locals.wrapping_add(self.op(1));
                self.skip(2);
                let v = self.int(SELF);
                store8(addr, v as u8);
            }
            SET_LOCAL_BOOL => {
                let addr = self.locals.wrapping_add(self.op(1));
                let mask = self.op(2);
                self.skip(3);
                let v = self.boolean(SELF);
                store32(addr, merge_bool(load32(addr), mask, v));
            }
            SET_LOCAL_FLOAT => {
                let addr = self.locals.wrapping_add(self.op(1));
                self.skip(2);
                let v = self.float(SELF);
                store32(addr, float_bits(v));
            }
            SET_LOCAL_OBJECT => {
                let addr = self.locals.wrapping_add(self.op(1));
                self.skip(2);
                let v = self.object(SELF);
                store32(addr, pointer_word(v));
            }
            SET_FIELD_INT | SET_FIELD_BYTE | SET_FIELD_BOOL | SET_FIELD_FLOAT | SET_FIELD_OBJECT => self.set_field(kind),
            COMPOUND_LOCAL => {
                let op = self.op(1);
                let addr = self.locals.wrapping_add(self.op(2));
                if op.wrapping_sub(C_FLOAT_ADD) > C_INT_SUB - C_FLOAT_ADD {
                    self.fail(ERR_KIND, op);
                }
                self.skip(3);
                self.compound(op, addr);
            }
            COMPOUND_FIELD => {
                let (op, offset, node, key) = (self.op(1), self.op(2), self.op(3), self.op(4));
                let length = self.op(5) as usize;
                if op.wrapping_sub(C_FLOAT_ADD) > C_INT_SUB - C_FLOAT_ADD {
                    self.fail(ERR_KIND, op);
                }
                self.skip(6);
                let Some(addr) = self.field(SELF, key, offset) else {
                    // The JavaScript path runs the whole out-native call.
                    self.skip(length);
                    self.host_eval(node, SELF);
                    return;
                };
                self.compound(op, addr);
            }
            INC_LOCAL_PRE | DEC_LOCAL_PRE | INC_LOCAL_POST => {
                self.int(SELF);
            }
            CALL => {
                self.call(SELF);
            }
            _ => self.fail(ERR_KIND, kind),
        }
    }

    /// A script call (compileCall -> runtime.invoke -> callFunction ->
    /// executeScript) on receiver `r`. The value is in f64 form by the
    /// call's rkind: int as f64, bool 0/1, float, object handle; 0 for void.
    fn call(&mut self, r: Recv) -> f64 {
        let (node, rkind, sig, argc) = (self.op(1), self.op(2), self.op(3), self.op(4));
        let args_len = self.op(5) as usize;
        if rkind > R_OBJECT {
            self.fail(ERR_KIND, rkind);
        }
        self.skip(6);
        let receiver = self.handle(r);
        // CallFunction's FMemMark: the frame stack as it was before the push.
        let saved = frames_save();
        let callee = unsafe { js_call_begin(self.frame, node, receiver, sig) };
        self.self_fresh = false;
        if callee < 0 {
            // The JavaScript path performs the whole call, arguments included.
            self.skip(args_len);
            let value = match rkind {
                R_VOID => {
                    self.host_eval(node, r);
                    0.0
                }
                R_INT => self.host_int(node, r) as f64,
                R_BOOL => self.host_bool(node, r) as i32 as f64,
                R_FLOAT => self.host_float(node, r),
                _ => self.host_object(node, r) as f64,
            };
            frames_restore(saved);
            return value;
        }
        // The callee block is read before any argument runs a nested call.
        let (locals, code, callee_self) = unsafe {
            let block = addr_of!(CALL_BLOCK) as *const u32;
            (*block, *block.add(1), *block.add(2))
        };
        // Parameters in order, each stored before the next is evaluated; the
        // arguments evaluate in the caller's run with the caller's SELF.
        for _ in 0..argc {
            let (pkind, offset, mask) = (self.op(0), self.op(1), self.op(2));
            self.skip(3);
            let addr = locals.wrapping_add(offset);
            match pkind {
                P_SKIP => {}
                P_INT => {
                    let v = self.int(SELF);
                    store32(addr, v as u32);
                }
                P_BYTE => {
                    let v = self.int(SELF);
                    store8(addr, v as u8);
                }
                P_BOOL => {
                    let v = self.boolean(SELF);
                    store32(addr, merge_bool(load32(addr), mask, v));
                }
                P_FLOAT => {
                    let v = self.float(SELF);
                    store32(addr, float_bits(v));
                }
                P_OBJECT => {
                    let v = self.object(SELF);
                    store32(addr, pointer_word(v));
                }
                _ => self.fail(ERR_KIND, pkind),
            }
        }
        // executeScript: the callee's own resumeCompiled budget.
        let caller_budget = unsafe { BUDGET };
        unsafe { BUDGET = HANG_BUDGET };
        let code = code as usize as *const u32;
        let mut run = Run {
            code,
            pc: code,
            frame: callee as u32,
            locals,
            self_handle: callee_self,
            self_info: 0,
            self_fresh: false,
            callee: true,
        };
        run.statements(0);
        unsafe { BUDGET = caller_budget };
        frames_restore(saved);
        self.self_fresh = false;
        // callFunction's copyValue(fn.result, value): undefined is the zero.
        let result = unsafe { RESULT };
        if result.to_bits() == UNDEF_F64_BITS {
            return 0.0;
        }
        match rkind {
            R_INT => to_int32(result) as f64,
            R_BOOL => (result != 0.0 && !result.is_nan()) as i32 as f64,
            R_FLOAT => fround(result),
            R_OBJECT => {
                let handle = result as u32;
                (if handle == UNDEFINED { 0 } else { handle }) as f64
            }
            _ => 0.0,
        }
    }

    /// assignFieldOf on SELF: the storage is selected before the value is
    /// evaluated; a field on the JavaScript path runs the whole original Let
    /// node there instead, and its lowered value is skipped unevaluated.
    fn set_field(&mut self, kind: u32) {
        let offset = self.op(1);
        let node = self.op(2);
        let key = self.op(3);
        let length = self.op(4) as usize;
        let mask = if kind == SET_FIELD_BOOL { self.op(5) } else { 0 };
        self.skip(if kind == SET_FIELD_BOOL { 6 } else { 5 });
        let Some(addr) = self.field(SELF, key, offset) else {
            self.skip(length);
            self.host_eval(node, SELF);
            return;
        };
        match kind {
            SET_FIELD_INT => {
                let v = self.int(SELF);
                store32(addr, v as u32);
            }
            SET_FIELD_BYTE => {
                let v = self.int(SELF);
                store8(addr, v as u8);
            }
            SET_FIELD_BOOL => {
                let v = self.boolean(SELF);
                store32(addr, merge_bool(load32(addr), mask, v));
            }
            SET_FIELD_FLOAT => {
                let v = self.float(SELF);
                store32(addr, float_bits(v));
            }
            _ => {
                let v = self.object(SELF);
                store32(addr, pointer_word(v));
            }
        }
    }

    /// `X op= V` through storage `addr` already selected (compileNative's
    /// reference argument 0): V (argument 1) is evaluated with SELF, then
    /// the native reads X, computes and stores through the reference, whose
    /// set runs the float codec (`Math.fround(Number(v ?? 0))`) or the int
    /// codec (`Number(v) | 0`). A float V that is UNDEF_F64 is JavaScript's
    /// undefined, which `a + undefined` and `f(undefined)` convert to NaN:
    /// it enters the arithmetic as that NaN, never as the store's `?? 0`.
    fn compound(&mut self, op: u32, addr: u32) {
        match op {
            C_FLOAT_ADD | C_FLOAT_SUB | C_FLOAT_MUL => {
                let b = self.float(SELF);
                // ToNumber(undefined): the NaN JavaScript computes with.
                let b = if b.to_bits() == UNDEF_F64_BITS { f64::NAN } else { b };
                let a = float_of(load32(addr));
                let v = match op {
                    // 184: assign(args[0], f(a + b))
                    C_FLOAT_ADD => fround(nan_first(a, b, a + b)),
                    // 185: assign(args[0], f(f(a) - f(b)))
                    C_FLOAT_SUB => {
                        let (x, y) = (fround(a), fround(b));
                        fround(nan_first(x, y, x - y))
                    }
                    // 182: assign(args[0], f(a * b))
                    _ => fround(nan_first(a, b, a * b)),
                };
                store32(addr, float_bits(v));
            }
            C_INT_ADD | C_INT_SUB => {
                let b = self.int(SELF);
                let a = load32(addr) as i32;
                // 161/162: ((a|0) ± (b|0)) | 0, then args[0].set(result).
                let v = if op == C_INT_ADD { a.wrapping_add(b) } else { a.wrapping_sub(b) };
                store32(addr, v as u32);
            }
            _ => self.fail(ERR_KIND, op),
        }
    }

    /// `Object.Value`: the object is evaluated with the current receiver.
    /// None or undefined reports Accessed None, skips the value and yields
    /// None; otherwise the value is evaluated with the object as receiver.
    #[inline(always)]
    fn context(&mut self, r: Recv) -> Option<Recv> {
        let node = self.op(1);
        let length = self.op(2) as usize;
        self.skip(3);
        let object = self.object(r);
        if object == 0 || object == UNDEFINED {
            self.skip(length);
            unsafe { js_accessed_none(self.frame, node) };
            self.self_fresh = false;
            return None;
        }
        Some(Recv { handle: object, info: unsafe { js_receiver(object) } })
    }

    fn int(&mut self, r: Recv) -> i32 {
        let kind = self.op(0);
        match kind {
            LIT_INT => {
                let v = self.op(1) as i32;
                self.skip(2);
                v
            }
            LOCAL_INT => {
                let v = load32(self.locals.wrapping_add(self.op(1))) as i32;
                self.skip(2);
                v
            }
            LOCAL_BYTE => {
                let v = load8(self.locals.wrapping_add(self.op(1))) as i32;
                self.skip(2);
                v
            }
            FIELD_INT | FIELD_BYTE => {
                let (offset, node, key) = (self.op(1), self.op(2), self.op(3));
                self.skip(4);
                match self.field(r, key, offset) {
                    Some(addr) if kind == FIELD_INT => load32(addr) as i32,
                    Some(addr) => load8(addr) as i32,
                    None => self.host_int(node, r),
                }
            }
            JS_INT => {
                let node = self.op(1);
                self.skip(2);
                self.host_int(node, r)
            }
            CONTEXT => match self.context(r) {
                Some(object) => self.int(object),
                None => 0,
            },
            CALL => self.call(r) as i32,
            BYTE_TO_INT | INT_TO_BYTE => {
                self.skip(1);
                self.int(SELF) & 255
            }
            FLOAT_TO_INT | FLOAT_TO_BYTE => {
                self.skip(1);
                let v = fround(self.float(SELF));
                if !v.is_finite() || v < -TWO_63 || v >= TWO_63 {
                    self.fail(if kind == FLOAT_TO_INT { ERR_FLOAT_TO_INT } else { ERR_FLOAT_TO_BYTE }, 0);
                }
                // `as i64` truncates toward zero; the low dword is ToInt32.
                let t = v as i64 as i32;
                if kind == FLOAT_TO_INT {
                    t
                } else {
                    t & 255
                }
            }
            INT_ADD | INT_SUB | INT_MUL | INT_AND | INT_XOR | INT_OR | INT_SHL | INT_SAR | INT_SHR | INT_MIN
            | INT_MAX | INT_DIV => {
                self.skip(1);
                let a = self.int(SELF);
                let b = self.int(SELF);
                match kind {
                    INT_ADD => a.wrapping_add(b),
                    INT_SUB => a.wrapping_sub(b),
                    INT_MUL => a.wrapping_mul(b),
                    INT_AND => a & b,
                    INT_XOR => a ^ b,
                    INT_OR => a | b,
                    INT_SHL => a.wrapping_shl(b as u32 & 31),
                    INT_SAR => a.wrapping_shr(b as u32 & 31),
                    INT_SHR => ((a as u32) >> (b as u32 & 31)) as i32,
                    INT_MIN => {
                        if a < b {
                            a
                        } else {
                            b
                        }
                    }
                    INT_MAX => {
                        if a > b {
                            a
                        } else {
                            b
                        }
                    }
                    _ => {
                        if b == 0 {
                            0
                        } else if a == i32::MIN && b == -1 {
                            self.fail(ERR_DIV_OVERFLOW, 0)
                        } else {
                            a / b
                        }
                    }
                }
            }
            INT_CLAMP => {
                self.skip(1);
                let a = self.int(SELF);
                let b = self.int(SELF);
                let c = self.int(SELF);
                if a < b {
                    b
                } else if a < c {
                    a
                } else {
                    c
                }
            }
            INT_NEG => {
                self.skip(1);
                self.int(SELF).wrapping_neg()
            }
            INT_NOT => {
                self.skip(1);
                !self.int(SELF)
            }
            INC_LOCAL_PRE | DEC_LOCAL_PRE | INC_LOCAL_POST => {
                let addr = self.locals.wrapping_add(self.op(1));
                self.skip(2);
                let old = load32(addr) as i32;
                let new = if kind == DEC_LOCAL_PRE { old.wrapping_sub(1) } else { old.wrapping_add(1) };
                store32(addr, new as u32);
                if kind == INC_LOCAL_POST {
                    old
                } else {
                    new
                }
            }
            _ => self.fail(ERR_KIND, kind),
        }
    }

    fn float(&mut self, r: Recv) -> f64 {
        let kind = self.op(0);
        match kind {
            LIT_FLOAT => {
                let v = float_of(self.op(1));
                self.skip(2);
                v
            }
            LOCAL_FLOAT => {
                let v = float_of(load32(self.locals.wrapping_add(self.op(1))));
                self.skip(2);
                v
            }
            FIELD_FLOAT => {
                let (offset, node, key) = (self.op(1), self.op(2), self.op(3));
                self.skip(4);
                match self.field(r, key, offset) {
                    Some(addr) => float_of(load32(addr)),
                    None => self.host_float(node, r),
                }
            }
            JS_FLOAT => {
                let node = self.op(1);
                self.skip(2);
                self.host_float(node, r)
            }
            CONTEXT => match self.context(r) {
                Some(object) => self.float(object),
                None => 0.0,
            },
            CALL => self.call(r),
            INT_TO_FLOAT => {
                self.skip(1);
                self.int(SELF) as f32 as f64
            }
            BYTE_TO_FLOAT => {
                self.skip(1);
                (self.int(SELF) & 255) as f32 as f64
            }
            FLOAT_NEG => {
                self.skip(1);
                fround(-fround(self.float(SELF)))
            }
            FLOAT_MUL | FLOAT_DIV | FLOAT_ADD | FLOAT_SUB | FLOAT_MIN | FLOAT_MAX => {
                self.skip(1);
                let a = self.float(SELF);
                let b = self.float(SELF);
                match kind {
                    FLOAT_MUL => fround(a * b),
                    FLOAT_DIV => fround(a / b),
                    FLOAT_ADD => fround(a + b),
                    FLOAT_SUB => fround(a - b),
                    // FMin (244): a > b ? b : a; FMax (245): a >= b ? a : b,
                    // on the raw values.
                    FLOAT_MIN => {
                        if a > b {
                            b
                        } else {
                            a
                        }
                    }
                    _ => {
                        if a >= b {
                            a
                        } else {
                            b
                        }
                    }
                }
            }
            _ => self.fail(ERR_KIND, kind),
        }
    }

    fn boolean(&mut self, r: Recv) -> bool {
        let kind = self.op(0);
        match kind {
            LIT_BOOL => {
                let v = self.op(1) != 0;
                self.skip(2);
                v
            }
            LOCAL_BOOL => {
                let v = load32(self.locals.wrapping_add(self.op(1))) & self.op(2) != 0;
                self.skip(3);
                v
            }
            FIELD_BOOL => {
                let (offset, node, key, mask) = (self.op(1), self.op(2), self.op(3), self.op(4));
                self.skip(5);
                match self.field(r, key, offset) {
                    Some(addr) => load32(addr) & mask != 0,
                    None => self.host_bool(node, r),
                }
            }
            JS_BOOL => {
                let node = self.op(1);
                self.skip(2);
                self.host_bool(node, r)
            }
            CONTEXT => match self.context(r) {
                Some(object) => self.boolean(object),
                None => false,
            },
            CALL => self.call(r) != 0.0,
            NOT => {
                self.skip(1);
                !self.boolean(SELF)
            }
            AND | OR => {
                let length = self.op(1) as usize;
                self.skip(2);
                let a = self.boolean(SELF);
                // && with false, || with true: the Skip operand is not
                // evaluated.
                if a != (kind == AND) {
                    self.skip(length);
                    return a;
                }
                self.boolean(SELF)
            }
            BOOL_NE | BOOL_EQ => {
                self.skip(1);
                let a = self.boolean(SELF);
                let b = self.boolean(SELF);
                (a == b) == (kind == BOOL_EQ)
            }
            INT_LT | INT_GT | INT_LE | INT_GE | INT_EQ | INT_NE => {
                self.skip(1);
                let a = self.int(SELF);
                let b = self.int(SELF);
                match kind {
                    INT_LT => a < b,
                    INT_GT => a > b,
                    // Natives 152/153 (script-decoration-primitives.mjs).
                    INT_LE => a <= b,
                    INT_GE => a >= b,
                    INT_EQ => a == b,
                    _ => a != b,
                }
            }
            FLOAT_LE => {
                // Native 178: !(f(a ?? 0) > f(b ?? 0)); unordered is true.
                self.skip(1);
                let a = self.float(SELF);
                let b = self.float(SELF);
                !(fround(undef_zero(a)) > fround(undef_zero(b)))
            }
            FLOAT_LT | FLOAT_GT | FLOAT_GE => {
                self.skip(1);
                let a = self.float(SELF);
                let b = self.float(SELF);
                match kind {
                    FLOAT_LT => a < b,
                    FLOAT_GT => a > b,
                    _ => a >= b,
                }
            }
            FLOAT_EQ | FLOAT_NE => {
                // FCOMP tests C3 only: unordered compares equal.
                self.skip(1);
                let x = fround(self.float(SELF));
                let y = fround(self.float(SELF));
                let equal = x.is_nan() || y.is_nan() || x == y;
                equal == (kind == FLOAT_EQ)
            }
            FLOAT_NEAR => {
                self.skip(1);
                let x = fround(self.float(SELF));
                let y = fround(self.float(SELF));
                let d = x - y;
                d.is_nan() || (d < 0.0001 && d > -0.0001)
            }
            OBJECT_EQ | OBJECT_NE => {
                self.skip(1);
                let a = self.object(SELF);
                let b = self.object(SELF);
                (a == b) == (kind == OBJECT_EQ)
            }
            _ => self.fail(ERR_KIND, kind),
        }
    }

    fn object(&mut self, r: Recv) -> u32 {
        let kind = self.op(0);
        match kind {
            LIT_NONE => {
                self.skip(1);
                0
            }
            LOCAL_OBJECT => {
                let v = load32(self.locals.wrapping_add(self.op(1)));
                self.skip(2);
                v
            }
            FIELD_OBJECT => {
                let (offset, node, key) = (self.op(1), self.op(2), self.op(3));
                self.skip(4);
                match self.field(r, key, offset) {
                    Some(addr) => load32(addr),
                    None => self.host_object(node, r),
                }
            }
            JS_OBJECT => {
                let node = self.op(1);
                self.skip(2);
                self.host_object(node, r)
            }
            SELF_OBJECT => {
                self.skip(1);
                self.self_handle
            }
            CONTEXT => match self.context(r) {
                Some(object) => self.object(object),
                None => 0,
            },
            CALL => self.call(r) as u32,
            _ => self.fail(ERR_KIND, kind),
        }
    }
}

/// Run one lowered function body from statement `entry`. Returns -1 after a
/// Return (a typed value is in RESULT) or the index of the S_YIELD statement
/// the JavaScript loop must execute next.
#[no_mangle]
pub extern "C" fn vm_run(code: u32, frame: u32, locals: u32, self_handle: u32, entry: u32) -> i32 {
    let code = code as usize as *const u32;
    let mut run = Run { code, pc: code, frame, locals, self_handle, self_info: 0, self_fresh: false, callee: false };
    run.statements(entry)
}
