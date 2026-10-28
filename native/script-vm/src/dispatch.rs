//! Script events dispatched in Rust (docs/rust-core.md "October 1: tick
//! events in Rust"): the Actor.Tick body's events (tick.rs `event`) run
//! script-runtime.mjs `processEvent` here when the event's function has a
//! Rust lowering, instead of crossing to JavaScript for the dispatch.
//!
//! processEvent, in order, and where each step runs:
//! 1. `scriptability()`, then the Level gate (an Actor with a level whose
//!    Level has not begun play does not receive events): `js_event_gate`,
//!    the runtime's own `eventGate`, which processEvent also calls. It also
//!    hands the JavaScript runaway count to RUNAWAY (the body's jumps count
//!    on from it).
//! 2. `state.isProbing(ename)`: the state table entry (natives.rs): a row
//!    with names is an instance with a ScriptState; its probe words decide.
//! 3. `lookup(receiver, name)` and the function's checks: the event cache,
//!    keyed by (class row, state row, event), filled by `js_event_resolve`
//!    with the decision for that key: JavaScript (the whole dispatch runs in
//!    processEvent, which also raises its errors), no call (a native
//!    function), or a Rust run (code, frame size, the parameter's offset, the
//!    JavaScript run template). An entry holds while EVENTS' epoch is
//!    unchanged: the host advances it when a lowering is replaced, when
//!    operands are relinked and when the field registry changes.
//! 4. `instance.pendingKill`: bDeleteMe in the receiver's image (DELETE_ME:
//!    offset, key id, mask), or JavaScript when the image cannot be read.
//! 5. The frame block, zeroed, with the float parameter stored through the
//!    float codec; the body as a callee run (S_YIELD statements through
//!    js_step) with its own hang budget; the stack restored. The JavaScript
//!    `Run` of the body is built on demand from RUNS[id] = [template, SELF
//!    handle, locals, serial] (script-vm-rust.mjs `run`).
//!
//! Results: 1 when the body ran (the caller refreshes what it caches about
//! the actor through `js_tick_refresh`, which also hands RUNAWAY back to
//! JavaScript), 0 when processEvent would return false before any script
//! ran, -1 when the caller must dispatch in JavaScript.

use crate::interp::{
    class_entry, field_addr, float_bits, frames_restore, frames_save, js_class_row, load32, receiver, store32,
    vm_frame_push, Run, BUDGET, FRAMES, HANG_BUDGET, RELEASED,
};
use crate::natives::state_entry;
use core::ptr::{addr_of, addr_of_mut};

/// EVENTS = [table, slot count (a power of two), epoch, enabled, verify].
static mut EVENTS: [u32; 5] = [0; 5];
/// bDeleteMe's [offset, key id, mask] in an Actor image.
static mut DELETE_ME: [u32; 3] = [0; 3];
/// The probe index (ename) of each tick event (tick.rs E_*).
static mut ENAMES: [u32; 8] = [0; 8];
/// RUNS[id] = [template, SELF handle, locals, serial] of a run Rust began.
pub(crate) const MAX_RUNS: u32 = 256;
static mut RUNS: [[u32; 4]; MAX_RUNS as usize] = [[0; 4]; MAX_RUNS as usize];
static mut SERIAL: u32 = 0;

// A slot: [class row, state row, event, epoch, kind, code, frame size,
// parameter offset + 1 (0 for none), template].
const SLOT: u32 = 48;
const K_JS: u32 = 1;
const K_NOCALL: u32 = 2;
const K_RUN: u32 = 3;

#[no_mangle]
pub extern "C" fn vm_events_ptr() -> *mut u32 {
    addr_of_mut!(EVENTS) as *mut u32
}
/// bDeleteMe of an actor read from its image (the table above), or None when the image cannot be read.
pub(crate) fn image_deleted(handle: u32) -> Option<bool> {
    let d = unsafe { *addr_of!(DELETE_ME) };
    if d[2] == 0 {
        return None;
    }
    let (info, bind) = receiver(handle);
    let deleted = field_addr(info, bind, d[1], d[0])?;
    Some(load32(deleted) & d[2] != 0)
}
#[no_mangle]
pub extern "C" fn vm_delete_me_ptr() -> *mut u32 {
    addr_of_mut!(DELETE_ME) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_enames_ptr() -> *mut u32 {
    addr_of_mut!(ENAMES) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_runs_ptr() -> *mut u32 {
    addr_of_mut!(RUNS) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_serial_ptr() -> *mut u32 {
    addr_of_mut!(SERIAL)
}

/// SCORES = [table, slot count (a power of two), enabled] of the AI event manager's score-callback cache (call_score). The host sets
/// `enabled` per manager tick, when processEvent, executeScript, eventLevelGate and lookup are the runtime's own (EventHost.allowed).
static mut SCORES: [u32; 3] = [0; 3];
#[no_mangle]
pub extern "C" fn vm_scores_ptr() -> *mut u32 {
    addr_of_mut!(SCORES) as *mut u32
}

#[link(wasm_import_module = "env")]
extern "C" {
    /// The runtime's eventGate (1 pass, 0 processEvent returns false, -1
    /// the JavaScript path); RUNAWAY = the JavaScript runaway count.
    fn js_event_gate(handle: u32) -> i32;
    /// Fill the slot at `slot` (kind, code, size, parameter, template) for
    /// `handle`'s event `which`; under verify, compare a filled slot first.
    fn js_event_resolve(handle: u32, which: u32, slot: u32);
    /// Fill the SCORES slot at `slot` (kind, code, size, three parameter offsets + 1, template) for `handle`'s function `name`.
    fn js_score_resolve(handle: u32, name: u32, slot: u32);
}

/// processEvent's gate (see the header) for a caller outside the actor tick: 1 pass, 0 no call, -1 JavaScript.
pub(crate) fn event_gate(handle: u32) -> i32 {
    if unsafe { (*addr_of!(SCORES))[2] } == 0 {
        return -1;
    }
    unsafe { js_event_gate(handle) }
}

/// A script function `float Name(Object receiver, Object other, float value)` run on `receiver` from Rust (the AI event manager's score
/// callbacks, aievent.rs), as processEvent would run it after `event_gate` passed: pendingKill from the image, the function from a cache
/// keyed by (class row, state row, name, epoch) that `js_score_resolve` fills, a zeroed frame with the three parameters, the body as a
/// callee run, RESULT. None when the host must do it (the JavaScript path); Some(float32 bits). A native function or a deleted
/// receiver is processEvent returning false: 0.
pub(crate) fn call_score(receiver: u32, name: u32, other: u32, value: u32) -> Option<u32> {
    let e = events();
    let t = unsafe { *addr_of!(SCORES) };
    if t[2] == 0 || t[0] == 0 {
        return None;
    }
    match image_deleted(receiver) {
        Some(true) => return Some(0),
        Some(false) => {}
        None => return None,
    }
    let entry = state_entry(receiver);
    if entry == 0 {
        return None;
    }
    let state = load32(entry);
    let mut row = class_entry(receiver);
    if row <= RELEASED {
        row = unsafe { js_class_row(receiver) };
        if row <= RELEASED {
            return None;
        }
    }
    let (slot, hit) = find(t[0], t[1], SLOT, mix(row ^ mix(state ^ mix(name))), &[row, state, name, e[2]]);
    if e[4] != 0 || !hit {
        unsafe { js_score_resolve(receiver, name, slot) };
        store32(slot, row);
        store32(slot.wrapping_add(4), state);
        store32(slot.wrapping_add(8), name);
        store32(slot.wrapping_add(12), events()[2]);
    }
    match load32(slot.wrapping_add(16)) {
        K_NOCALL => return Some(0),
        K_RUN => {}
        _ => return None,
    }
    let saved = frames_save();
    let id = saved[3];
    if id >= MAX_RUNS {
        return None;
    }
    let (code, size, o0, o1, o2, template) = (
        load32(slot.wrapping_add(20)),
        load32(slot.wrapping_add(24)),
        load32(slot.wrapping_add(28)),
        load32(slot.wrapping_add(32)),
        load32(slot.wrapping_add(36)),
        load32(slot.wrapping_add(40)),
    );
    let locals = if size != 0 { vm_frame_push(size) } else { 0 };
    store32(locals.wrapping_add(o0 - 1), receiver);
    store32(locals.wrapping_add(o1 - 1), other);
    store32(locals.wrapping_add(o2 - 1), value);
    unsafe {
        let serial = SERIAL.wrapping_add(1);
        SERIAL = serial;
        (*addr_of_mut!(RUNS))[id as usize] = [template, receiver, locals, serial];
        (*addr_of_mut!(FRAMES))[3] = id + 1;
    }
    let outer_budget = unsafe { BUDGET };
    unsafe { BUDGET = HANG_BUDGET };
    let code = code as usize as *const u32;
    let mut run = Run { code, pc: code, frame: id, locals, self_handle: receiver, self_info: 0, self_bind: 0, self_fresh: false, callee: true };
    run.statements(0);
    unsafe { BUDGET = outer_budget };
    frames_restore(saved);
    // callFunction's copyValue(fn.result, value): undefined is the zero, a float is stored float32.
    let result = crate::interp::last_result();
    Some(if result.to_bits() == crate::interp::UNDEF_F64_BITS { 0 } else { (result as f32).to_bits() })
}

/// The enable word's bits (script-vm-events.mjs): events dispatch in Rust;
/// a ProcessState with no code to run is skipped (tick.rs); latent polls
/// run in Rust (tick.rs, loco.rs); the tick's IsProbing reads the state
/// table's probe words (tick.rs).
const TICK_EVENTS_BIT: u32 = 1;
const TICK_STATE_BIT: u32 = 2;
const TICK_POLL_BIT: u32 = 4;
const TICK_PROBE_BIT: u32 = 8;

/// Whether the actor tick may skip a ProcessState with no code to run.
pub(crate) fn state_skip_enabled() -> bool {
    events()[3] & TICK_STATE_BIT != 0
}
/// Whether the actor tick may poll Sleep and the locomotion latent actions
/// in Rust.
pub(crate) fn polls_enabled() -> bool {
    events()[3] & TICK_POLL_BIT != 0
}
/// Whether the actor tick's IsProbing may read the state table.
pub(crate) fn probes_enabled() -> bool {
    events()[3] & TICK_PROBE_BIT != 0
}

/// Set EVENTS' enable word; returns the previous one.
pub(crate) fn set_events_enabled(value: u32) -> u32 {
    unsafe {
        let words = addr_of_mut!(EVENTS) as *mut u32;
        let previous = *words.add(3);
        *words.add(3) = value;
        previous
    }
}

#[inline(always)]
fn events() -> [u32; 5] {
    unsafe { *addr_of!(EVENTS) }
}

/// MurmurHash3's 32-bit finalizer: every input bit reaches the low bits the
/// slot index takes.
#[inline(always)]
fn mix(mut h: u32) -> u32 {
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^ (h >> 16)
}

/// The way a miss replaces when every way of a set holds a key (round
/// robin).
static mut VICTIM: u32 = 0;
const WAYS: u32 = 4;

/// The slot holding `key` (words 0..N of a slot) in the 4-way set of hash
/// `h` of a table of `count` slots of `size` bytes, or the slot to fill
/// (an empty way first, then the ways in turn) and false. The key's last
/// word is the epoch, so a slot of an older epoch never matches.
#[inline(always)]
fn find<const N: usize>(table: u32, count: u32, size: u32, h: u32, key: &[u32; N]) -> (u32, bool) {
    let first = table.wrapping_add((h & count.wrapping_sub(1) & !(WAYS - 1)).wrapping_mul(size));
    for way in 0..WAYS {
        let slot = first.wrapping_add(way * size);
        if (0..N).all(|i| load32(slot.wrapping_add(4 * i as u32)) == key[i]) {
            return (slot, true);
        }
    }
    for way in 0..WAYS {
        let slot = first.wrapping_add(way * size);
        if load32(slot) == 0 {
            return (slot, false);
        }
    }
    let way = unsafe {
        VICTIM = (VICTIM + 1) & (WAYS - 1);
        VICTIM
    };
    (first.wrapping_add(way * size), false)
}

/// processEvent(handle, event `which`) with the float `delta` when the event
/// takes one (`has_delta`); see the header for the results.
pub(crate) fn dispatch_event(handle: u32, which: u32, delta: f64, has_delta: bool) -> i32 {
    let e = events();
    if e[3] & TICK_EVENTS_BIT == 0 {
        return -1;
    }
    // 1. scriptability and the Level gate.
    match unsafe { js_event_gate(handle) } {
        1 => {}
        0 => return 0,
        _ => return -1,
    }
    // 2. Probing.
    let entry = state_entry(handle);
    if entry == 0 {
        return -1;
    }
    let state = load32(entry);
    if load32(state.wrapping_add(4)) != 0 {
        let bit = unsafe { (*addr_of!(ENAMES))[which as usize] }.wrapping_sub(0x12c);
        if bit < 64 && load32(entry.wrapping_add(4 + 4 * (bit >> 5))) & (1u32 << (bit & 31)) == 0 {
            return 0;
        }
    }
    // 3. The function.
    let mut row = class_entry(handle);
    if row <= RELEASED {
        row = unsafe { js_class_row(handle) };
        if row <= RELEASED {
            return -1;
        }
    }
    let (slot, hit) = find(e[0], e[1], SLOT, mix(row ^ mix(state ^ mix(which))), &[row, state, which, e[2]]);
    if e[4] != 0 || !hit {
        unsafe { js_event_resolve(handle, which, slot) };
        store32(slot, row);
        store32(slot.wrapping_add(4), state);
        store32(slot.wrapping_add(8), which);
        store32(slot.wrapping_add(12), events()[2]);
    }
    match load32(slot.wrapping_add(16)) {
        K_NOCALL => return 0,
        K_RUN => {}
        K_JS => return -1,
        _ => return -1,
    }
    // 4. pendingKill.
    let d = unsafe { *addr_of!(DELETE_ME) };
    let (info, bind) = receiver(handle);
    let Some(deleted) = field_addr(info, bind, d[1], d[0]) else {
        return -1;
    };
    if load32(deleted) & d[2] != 0 {
        return 0;
    }
    // 5. The body.
    let saved = frames_save();
    let id = saved[3];
    if id >= MAX_RUNS {
        return -1;
    }
    let (code, size, param, template) =
        (load32(slot.wrapping_add(20)), load32(slot.wrapping_add(24)), load32(slot.wrapping_add(28)), load32(slot.wrapping_add(32)));
    let locals = if size != 0 { vm_frame_push(size) } else { 0 };
    if param != 0 {
        // copyValue(parameter, delta): the float codec's store.
        store32(locals.wrapping_add(param - 1), float_bits(if has_delta { delta } else { 0.0 }));
    }
    unsafe {
        let serial = SERIAL.wrapping_add(1);
        SERIAL = serial;
        (*addr_of_mut!(RUNS))[id as usize] = [template, handle, locals, serial];
        (*addr_of_mut!(FRAMES))[3] = id + 1;
    }
    let outer_budget = unsafe { BUDGET };
    unsafe { BUDGET = HANG_BUDGET };
    let code = code as usize as *const u32;
    let mut run = Run { code, pc: code, frame: id, locals, self_handle: handle, self_info: 0, self_bind: 0, self_fresh: false, callee: true };
    run.statements(0);
    unsafe { BUDGET = outer_budget };
    frames_restore(saved);
    1
}

// ---- Script calls (CALL) ----------------------------------------------------
//
// A CALL's begin (script-vm-rust.mjs `beginCall`: runtime.invoke's
// resolution and callFunction's checks) from a cache keyed by (caller code,
// call node, receiver class row, receiver state row): the resolution is the
// operand (final calls) or lookup(receiver, name) (virtual), which depends
// only on the receiver's class and state node; the checks depend on the
// function and the call site. `js_call_resolve` fills a slot with
// beginCall's decision, the JavaScript path or a Rust run: the callee's
// code, frame size, run template and probe index. A hit pushes the zeroed
// block and records the run (RUNS) without an import. The epoch and verify
// words are EVENTS'; the host also advances the epoch when a boundary
// function is added or removed.

/// CALLS = [table, slot count (a power of two), enabled].
static mut CALLS: [u32; 3] = [0; 3];
// A call slot: [caller code, node, class row, state row, epoch, kind,
// callee code, frame size, template, probe index].
const CALL_SLOT: u32 = 48;

#[no_mangle]
pub extern "C" fn vm_calls_ptr() -> *mut u32 {
    addr_of_mut!(CALLS) as *mut u32
}

#[link(wasm_import_module = "env")]
extern "C" {
    /// beginCall's decision for the CALL `node` of run `frame` on `handle`
    /// into the slot at `slot` (kind, code, size, template, probe); under
    /// verify, compared with a filled slot first. Runs no script.
    fn js_call_resolve(frame: u32, node: u32, handle: u32, sig: u32, slot: u32);
}

/// A begun call: its run id, frame block and code.
pub(crate) struct Callee {
    pub(crate) id: u32,
    pub(crate) locals: u32,
    pub(crate) code: u32,
    /// The callee's probe index (0x12c..0x16b) or PROBE_NONE: ProcessInternal's ProbeMask gate.
    pub(crate) probe: u32,
}

/// beginCall from the cache, or None when the caller must ask js_call_begin
/// (dispatch off, an undescribed receiver or state, the JavaScript decision,
/// no RUNS record left).
pub(crate) fn begin_call(frame: u32, caller: u32, node: u32, handle: u32, sig: u32) -> Option<Callee> {
    let c = unsafe { *addr_of!(CALLS) };
    if c[2] == 0 {
        return None;
    }
    let mut row = class_entry(handle);
    if row <= RELEASED {
        row = unsafe { js_class_row(handle) };
        if row <= RELEASED {
            return None;
        }
    }
    let entry = state_entry(handle);
    if entry == 0 {
        return None;
    }
    let state = load32(entry);
    let e = events();
    let h = mix(caller ^ mix(node ^ mix(row ^ mix(state))));
    let (slot, hit) = find(c[0], c[1], CALL_SLOT, h, &[caller, node, row, state, e[2]]);
    if e[4] != 0 || !hit {
        unsafe { js_call_resolve(frame, node, handle, sig, slot) };
        store32(slot, caller);
        store32(slot.wrapping_add(4), node);
        store32(slot.wrapping_add(8), row);
        store32(slot.wrapping_add(12), state);
        store32(slot.wrapping_add(16), events()[2]);
    }
    if load32(slot.wrapping_add(20)) != K_RUN {
        return None;
    }
    let runs = unsafe { (*addr_of!(FRAMES))[3] };
    if runs >= MAX_RUNS {
        return None;
    }
    let (code, size, template) = (load32(slot.wrapping_add(24)), load32(slot.wrapping_add(28)), load32(slot.wrapping_add(32)));
    let locals = if size != 0 { vm_frame_push(size) } else { 0 };
    unsafe {
        let serial = SERIAL.wrapping_add(1);
        SERIAL = serial;
        (*addr_of_mut!(RUNS))[runs as usize] = [template, handle, locals, serial];
        (*addr_of_mut!(FRAMES))[3] = runs + 1;
    }
    Some(Callee { id: runs, locals, code, probe: load32(slot.wrapping_add(36)) })
}

/// dispatch_event for validators (validate-script-vm-interp).
#[no_mangle]
pub extern "C" fn vm_dispatch_event(handle: u32, which: u32, delta: f64, has_delta: u32) -> i32 {
    dispatch_event(handle, which, delta, has_delta != 0)
}
