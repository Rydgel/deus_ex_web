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
    class_entry, field_addr, float_bits, frames_restore, frames_save, js_class_row, load32, receiver_info, store32,
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

#[link(wasm_import_module = "env")]
extern "C" {
    /// The runtime's eventGate (1 pass, 0 processEvent returns false, -1
    /// the JavaScript path); RUNAWAY = the JavaScript runaway count.
    fn js_event_gate(handle: u32) -> i32;
    /// Fill the slot at `slot` (kind, code, size, parameter, template) for
    /// `handle`'s event `which`; under verify, compare a filled slot first.
    fn js_event_resolve(handle: u32, which: u32, slot: u32);
}

#[inline(always)]
fn events() -> [u32; 5] {
    unsafe { *addr_of!(EVENTS) }
}

/// The cache slot for (class row, state row, event).
#[inline(always)]
fn slot_for(row: u32, state: u32, which: u32) -> u32 {
    let e = events();
    let h = (row >> 3).wrapping_mul(0x9e37_79b1) ^ (state >> 3).wrapping_mul(0x85eb_ca77) ^ which.wrapping_mul(0xc2b2_ae3d);
    e[0].wrapping_add((h & e[1].wrapping_sub(1)).wrapping_mul(SLOT))
}

/// processEvent(handle, event `which`) with the float `delta` when the event
/// takes one (`has_delta`); see the header for the results.
pub(crate) fn dispatch_event(handle: u32, which: u32, delta: f64, has_delta: bool) -> i32 {
    let e = events();
    if e[3] == 0 {
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
    let slot = slot_for(row, state, which);
    if e[4] != 0 || load32(slot) != row || load32(slot.wrapping_add(4)) != state || load32(slot.wrapping_add(8)) != which
        || load32(slot.wrapping_add(12)) != e[2]
    {
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
    let Some(deleted) = field_addr(receiver_info(handle), d[1], d[0]) else {
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
    let mut run = Run { code, pc: code, frame: id, locals, self_handle: handle, self_info: 0, self_fresh: false, callee: true };
    run.statements(0);
    unsafe { BUDGET = outer_budget };
    frames_restore(saved);
    1
}

/// dispatch_event for validators (validate-script-vm-interp).
#[no_mangle]
pub extern "C" fn vm_dispatch_event(handle: u32, which: u32, delta: f64, has_delta: u32) -> i32 {
    dispatch_event(handle, which, delta, has_delta != 0)
}
