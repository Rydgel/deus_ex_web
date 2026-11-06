//! A foreach over CycleActors that Rust owns, and the struct out arguments of a script call (docs/firefox-60fps-plan.md "The bunker
//! bundle"; the lowering is script-vm-lower.mjs `foreachStart` and `call`, the host script-vm-foreach.mjs).
//!
//! Both transcribe what the JavaScript VM does for the same original nodes, step for step; where Rust cannot decide the same
//! thing before anything has run, the node goes to JavaScript whole.
//!
//! * S_FOREACH_CYCLE 10 `node, rid, after, actor kind, offset, key, index kind, offset, key` (statement): stepCompiled's 0x2f over
//!   native 1002 (CycleActors(Class'X', out Actor, out int Index) in a function body, once per body). `node` is the native call,
//!   `rid` the class record id of the literal BaseClass, `after` the statement after the IteratorPop. The out arguments are a local
//!   (kind 0, offset) or a field of SELF (kind 1, offset, key id) of an object and an int. createCycleActorsIterator's creation: the
//!   cursor is `Index` when it lies in [0, Actors.Num()), else 0, the step bound Actors.Num(); then `next()`: clear Actor, bound =
//!   min(bound, Actors.Num()), scan forward from the cursor (render.rs cycle_scan; an actor without a class row goes to
//!   js_cycle_class_test, which is `classIsA`), then Actor = the one found, Index = the cursor, or Index alone on exhaustion. A
//!   found actor continues at the next statement (the body), none at `after`. The iterator lives in the run (`Iter`), which a
//!   *callee* run keeps until it returns; a start that cannot be Rust's (not a callee run, an out argument the image cannot
//!   address, no actor list) is an S_YIELD, and its IteratorNext and IteratorPop go to the JavaScript iterator stack as before
//!   (`iter.active` says which owns the loop). The lowering emits the kind only for a body with one foreach and no Return that
//!   stays in JavaScript (stepCompiled throws on a Return with an iterator active; the Rust Return checks `iter.active`).
//!   js_cycle_list is the actor list ([count, handle...]) of the receiver's level, refreshed for every step, or 0.
//! * CALL_OUT 208: a script call (CALL) whose callee has `out` struct parameters of scalar members: `node, rkind, sig, argc,
//!   args_len`, then the count of sources and each `(kind, offset, key)` (a local or a field of SELF holding the struct), then the
//!   arguments; a P_STRUCT argument is `dst offset, source index`, `n`, and `n` members `(kind, offset, mask)`. callFunction's
//!   order: each argument in turn, the struct copied in from its source (readCell, copyValue, writeCell: each member through its
//!   codec, a float as `Math.fround`, an object as its handle or None for a released one, a bool merged into its word), then the
//!   callee, then the out parameters in reverse, each copied back into its source. A call whose source field the image cannot
//!   address (a bound or host receiver) goes to JavaScript whole, before anything is pushed; one that stops being addressable
//!   by the time it is copied (impossible short of a binding added by the callee) raises ERR_OUT_STRUCT.
//!
//! FEATURES = [OUT_STRUCT=verify, FOREACH_START=verify]: with a word set each copy and each iterator step is compared by the host with
//! the JavaScript codec and a shadow iterator (js_out_struct_check, js_foreach_check).

use crate::interp::{
    float_bits, float_of, live, load32, load8, merge_bool, pointer_word, store32, store8, Run, ERR_FOREACH, ERR_OUT_STRUCT, P_BOOL, P_BYTE,
    P_FLOAT, P_INT,
};
use core::ptr::{addr_of, addr_of_mut};

pub(crate) const MAX_OUT: usize = 4;
/// A struct out argument's source: (kind, offset, key id): kind 0 a local of the caller at `offset`, 1 a field of its SELF.
pub(crate) type Source = (u32, u32, u32);
pub(crate) type Sources = [Source; MAX_OUT];
pub(crate) const NO_SOURCES: Sources = [(0, 0, 0); MAX_OUT];

#[derive(Clone, Copy)]
pub(crate) struct OutArg {
    source: Source,
    index: u32,
    dst: u32,
    members: *const u32,
    n: u32,
}
const NO_OUT: OutArg = OutArg { source: (0, 0, 0), index: 0, dst: 0, members: core::ptr::null(), n: 0 };
/// The struct out arguments a call has copied in, to copy back.
pub(crate) struct Outs {
    args: [OutArg; MAX_OUT],
    count: usize,
}
pub(crate) const NO_OUTS: Outs = Outs { args: [NO_OUT; MAX_OUT], count: 0 };

/// The foreach a run owns.
#[derive(Clone, Copy)]
pub(crate) struct Iter {
    pub(crate) active: bool,
    node: u32,
    rid: u32,
    body: u32,
    after: u32,
    cursor: u32,
    steps: u32,
    bound: u32,
    actor: Source,
    index: Source,
}
pub(crate) const NO_ITER: Iter =
    Iter { active: false, node: 0, rid: 0, body: 0, after: 0, cursor: 0, steps: 0, bound: 0, actor: (0, 0, 0), index: (0, 0, 0) };

/// [OUT_STRUCT=verify, FOREACH_START=verify, 0, 0] (script-vm-foreach.mjs).
static mut FEATURES: [u32; 4] = [0; 4];
#[no_mangle]
pub extern "C" fn vm_features_ptr() -> *mut u32 {
    addr_of_mut!(FEATURES) as *mut u32
}
#[inline(always)]
fn feature(i: usize) -> bool {
    unsafe { *(addr_of!(FEATURES) as *const u32).add(i) != 0 }
}

#[link(wasm_import_module = "env")]
extern "C" {
    /// The receiver level's actor list ([count, handle...], script-vm-render.mjs listFor), or 0 when the host leaves the start to JavaScript.
    fn js_cycle_list(frame: u32, node: u32, receiver: u32) -> u32;
    /// `classIsA` of the actor's class against the foreach's BaseClass (an actor without a class row), 1 or 0.
    fn js_cycle_class_test(frame: u32, node: u32, actor: u32) -> u32;
    /// FOREACH_START=verify: phase 0 a start with Index `start`, 1 a step; the host's shadow iterator must reach the same actor and cursor.
    fn js_foreach_check(frame: u32, node: u32, phase: u32, start: u32, found: u32, cursor: u32);
    /// OUT_STRUCT=verify: the struct copied from `from` to `to` (dir 0 in, 1 out) against the JavaScript codec.
    fn js_out_struct_check(frame: u32, node: u32, index: u32, dir: u32, from: u32, to: u32);
}

/// The members `(kind, offset, mask)` of a struct, copied from `from` to `to` as the codecs copy them (see the header).
fn copy_members(members: *const u32, n: usize, from: u32, to: u32) {
    for i in 0..n {
        let (kind, offset, mask) = unsafe { (*members.add(3 * i), *members.add(3 * i + 1), *members.add(3 * i + 2)) };
        let (f, t) = (from.wrapping_add(offset), to.wrapping_add(offset));
        match kind {
            P_INT => store32(t, load32(f)),
            P_BYTE => store8(t, load8(f)),
            P_BOOL => store32(t, merge_bool(load32(t), mask, load32(f) & mask != 0)),
            P_FLOAT => store32(t, float_bits(float_of(load32(f)))),
            // an object: its handle, None for one that has been released (readCell's identityOfHandle, writeCell's handleOf)
            _ => store32(t, live(load32(f))),
        }
    }
}

impl Run {
    /// The address a source names now, or None when the image cannot address it.
    fn out_addr(&mut self, at: Source) -> Option<u32> {
        if at.0 == 0 {
            Some(self.locals.wrapping_add(at.1))
        } else {
            self.field(crate::interp::SELF, at.2, at.1)
        }
    }
    fn out_source(&mut self, at: Source, node: u32) -> u32 {
        match self.out_addr(at) {
            Some(addr) => addr,
            None => self.fail(ERR_OUT_STRUCT, node),
        }
    }

    /// A CALL_OUT's source list, past its header.
    pub(crate) fn out_sources(&mut self) -> Sources {
        let n = (self.op(6) as usize).min(MAX_OUT);
        let mut sources = NO_SOURCES;
        for (i, source) in sources.iter_mut().enumerate().take(n) {
            *source = (self.op(7 + 3 * i), self.op(8 + 3 * i), self.op(9 + 3 * i));
        }
        self.skip(7 + 3 * n);
        sources
    }
    /// Whether every field source can be addressed in the image now.
    pub(crate) fn out_addressable(&mut self, sources: &Sources) -> bool {
        for source in sources.iter() {
            if source.0 == 1 && self.field(crate::interp::SELF, source.2, source.1).is_none() {
                return false;
            }
        }
        true
    }
    /// A P_STRUCT argument: `n`, the members, then the copy in from source `index` to the callee's parameter at `dst`.
    pub(crate) fn out_struct_in(&mut self, sources: &Sources, index: u32, dst: u32, node: u32, outs: &mut Outs) {
        let n = self.op(0) as usize;
        let members = unsafe { self.pc.add(1) };
        self.skip(1 + 3 * n);
        let source = sources[(index as usize).min(MAX_OUT - 1)];
        let src = self.out_source(source, node);
        copy_members(members, n, src, dst);
        if feature(0) {
            unsafe { js_out_struct_check(self.frame, node, index, 0, src, dst) };
            self.self_fresh = false;
        }
        if outs.count >= MAX_OUT {
            self.fail(ERR_OUT_STRUCT, node);
        }
        outs.args[outs.count] = OutArg { source, index, dst, members, n: n as u32 };
        outs.count += 1;
    }
    /// The out parameters, last first, copied back into their sources.
    pub(crate) fn out_struct_back(&mut self, outs: &Outs, node: u32) {
        let mut j = outs.count;
        while j > 0 {
            j -= 1;
            let o = outs.args[j];
            let to = self.out_source(o.source, node);
            copy_members(o.members, o.n as usize, o.dst, to);
            if feature(0) {
                unsafe { js_out_struct_check(self.frame, node, o.index, 1, o.dst, to) };
                self.self_fresh = false;
            }
        }
    }

    /// The actor list for the S_FOREACH_CYCLE at pc when Rust can own the loop (a callee run, out arguments in the image, a list), else 0.
    pub(crate) fn foreach_ready(&mut self) -> u32 {
        if self.iter.active {
            self.fail(ERR_FOREACH, self.op(1));
        }
        if !self.callee {
            return 0;
        }
        let node = self.op(1);
        let (actor, index) = ((self.op(4), self.op(5), self.op(6)), (self.op(7), self.op(8), self.op(9)));
        if self.out_addr(actor).is_none() || self.out_addr(index).is_none() {
            return 0;
        }
        let list = unsafe { js_cycle_list(self.frame, node, self.self_handle) };
        self.self_fresh = false;
        list
    }
    /// The start (see the header); `body` is the statement after it. Returns the statement to continue at.
    pub(crate) fn foreach_start(&mut self, body: u32, list: u32) -> u32 {
        let (node, rid, after) = (self.op(1), self.op(2), self.op(3));
        let actor = (self.op(4), self.op(5), self.op(6));
        let index = (self.op(7), self.op(8), self.op(9));
        self.skip(10);
        let Some(index_addr) = self.out_addr(index) else { self.fail(ERR_FOREACH, node) };
        let start = load32(index_addr);
        let bound = load32(list);
        let cursor = if (start as i32) >= 0 && start < bound { start } else { 0 };
        self.iter = Iter { active: true, node, rid, body, after, cursor, steps: 0, bound, actor, index };
        if self.foreach_step(list, 0, start) {
            body
        } else {
            self.iter.active = false;
            after
        }
    }
    /// IteratorNext of the loop Rust owns: the statement to continue at.
    pub(crate) fn foreach_next(&mut self) -> u32 {
        let node = self.iter.node;
        let list = unsafe { js_cycle_list(self.frame, node, self.self_handle) };
        self.self_fresh = false;
        if list == 0 {
            self.fail(ERR_FOREACH, node);
        }
        if self.foreach_step(list, 1, 0) {
            self.iter.body
        } else {
            self.iter.active = false;
            self.iter.after
        }
    }
    /// createCycleActorsIterator's next(): true when an actor was found.
    fn foreach_step(&mut self, list: u32, phase: u32, start: u32) -> bool {
        let it = self.iter;
        let node = it.node;
        match self.out_addr(it.actor) {
            Some(addr) => store32(addr, 0),
            None => self.fail(ERR_FOREACH, node),
        }
        let count = load32(list);
        let bound = if count < it.bound { count } else { it.bound };
        let (mut cursor, mut steps, mut found) = (it.cursor, it.steps, 0);
        loop {
            let (kind, c, s) = crate::render::cycle_scan_step(list, cursor, steps, bound, it.rid);
            cursor = c;
            steps = s;
            if kind == 0 {
                break;
            }
            let h = load32(list.wrapping_add(4).wrapping_add((cursor - 1).wrapping_mul(4)));
            if kind == 1 {
                found = h;
                break;
            }
            let ok = unsafe { js_cycle_class_test(self.frame, node, h) } != 0;
            self.self_fresh = false;
            if ok {
                found = h;
                break;
            }
        }
        self.iter.cursor = cursor;
        self.iter.steps = steps;
        self.iter.bound = bound;
        if found != 0 {
            match self.out_addr(it.actor) {
                Some(addr) => store32(addr, pointer_word(found)),
                None => self.fail(ERR_FOREACH, node),
            }
        }
        match self.out_addr(it.index) {
            Some(addr) => store32(addr, cursor),
            None => self.fail(ERR_FOREACH, node),
        }
        if feature(1) {
            unsafe { js_foreach_check(self.frame, node, phase, start, found, cursor) };
            self.self_fresh = false;
        }
        found != 0
    }
}
