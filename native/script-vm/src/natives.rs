//! Small Actor and Object natives in the interpreter (docs/rust-core.md,
//! "October 1: small natives"). Each body transcribes its case of
//! script-runtime.mjs `invokeNative` step for step; the lowering emits these
//! kinds only where the runtime's own invokeNative would run that case (the
//! same gate as the perception natives: no host has replaced invokeNative
//! and the index is not a boundary native), with no arguments.
//!
//! * STATE_NAME 203 `node` (name): GetStateName (284),
//!   `scriptGetStateName(instance.state ? (state.stateNode ?? instance.cls)
//!   : null)`, from the state table (script-vm-states.mjs): the first name of
//!   the entry's row, or None for a row without names.
//! * LAST_RENDERED 204 `node, offset, key` (float): LastRendered (723).
//!   execLastRendered 0x1036de30 is `max(XLevel->TimeSeconds -
//!   LastRenderTime, 0)` as an f32, which the JavaScript body computes as
//!   `clock - Math.fround(LastRenderTime)` in doubles, 0 when negative or
//!   NaN, else `Math.fround`. `offset, key` locate LastRenderTime.
//! * IN_STASIS 205 `node`, then [offset, key] of LastRenderTime, [offset,
//!   key, mask] of bStasis, [offset, key] of Physics, [offset, key, mask] of
//!   bForceStasis and [offset, key] of DistanceFromPlayer (bool): InStasis
//!   (721), actor-tick.mjs `actorInStasis` with the native's level.
//!
//! The bodies only read. A field outside the image (a HOST receiver, a bound
//! key on a BOUND receiver) or a host value the JavaScript body would not
//! compute with (the clock imports set NATIVE_FAULT: an error, a value that
//! is not a number) hands the whole node to JavaScript, which reads again
//! and raises the body's errors. The clock imports run no script.

use crate::interp::{load32, load8, Recv, Run, CK_BOOL, CK_FLOAT, CK_NAME, NAME_NONE};
use core::ptr::{addr_of, addr_of_mut};

/// STATES = [table, capacity, verify] (script-vm-states.mjs).
static mut STATES: [u32; 3] = [0; 3];
/// Set by a clock import whose value the body would not use.
static mut NATIVE_FAULT: u32 = 0;
const ENTRY: u32 = 12;

#[no_mangle]
pub extern "C" fn vm_states_ptr() -> *mut u32 {
    addr_of_mut!(STATES) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_native_fault_ptr() -> *mut u32 {
    addr_of_mut!(NATIVE_FAULT)
}

#[link(wasm_import_module = "env")]
extern "C" {
    fn js_state(handle: u32) -> u32;
    /// Mode 0: `soundField(actor, 'TimeSeconds')` (LastRendered); mode 1:
    /// `levelFor(actor).timeSeconds`, a number (actorInStasis).
    fn js_level_clock(handle: u32, mode: u32) -> f64;
    /// `levelFor(actor).zoneLastRenderTime(actor)`, a number.
    fn js_zone_render_time(handle: u32) -> f64;
    /// `levelFor(actor).netMode === 0`.
    fn js_level_standalone(handle: u32) -> i32;
}

/// The address of `handle`'s state entry [row, probe lo, probe hi], computed
/// by the host when it is not filled (or always, under STATE_VERIFY), or 0
/// when the host does not describe the handle.
pub(crate) fn state_entry(handle: u32) -> u32 {
    let states = addr_of!(STATES) as *const u32;
    let (table, capacity, verify) = unsafe { (*states, *states.add(1), *states.add(2)) };
    if verify == 0 && handle < capacity {
        let at = table.wrapping_add(ENTRY.wrapping_mul(handle));
        if load32(at) != 0 {
            return at;
        }
    }
    if unsafe { js_state(handle) } == 0 {
        return 0;
    }
    // js_state entered the handle, growing the table if it had to.
    let table = unsafe { *states };
    table.wrapping_add(ENTRY.wrapping_mul(handle))
}

/// A fault a clock import reported, cleared.
fn fault() -> bool {
    unsafe {
        let f = NATIVE_FAULT != 0;
        NATIVE_FAULT = 0;
        f
    }
}

impl Run {
    /// GetStateName (284) on receiver `r`.
    pub(crate) fn state_name(&mut self, r: Recv) -> u32 {
        let node = self.op(1);
        self.skip(2);
        let entry = state_entry(self.handle(r));
        if entry == 0 {
            return self.host_name(node, r);
        }
        let row = load32(entry);
        let v = if load32(row.wrapping_add(4)) == 0 { NAME_NONE } else { load32(row.wrapping_add(8)) };
        self.verify(node, r, CK_NAME, v as f64);
        v
    }

    /// LastRendered (723) on receiver `r`.
    pub(crate) fn last_rendered(&mut self, r: Recv) -> f64 {
        let (node, offset, key) = (self.op(1), self.op(2), self.op(3));
        self.skip(4);
        let addr = match self.field(r, key, offset) {
            Some(addr) => addr,
            None => return self.host_float(node, r),
        };
        let clock = unsafe { js_level_clock(self.handle(r), 0) };
        if fault() {
            return self.host_float(node, r);
        }
        let last = f32::from_bits(load32(addr)) as f64;
        let delta = clock - last;
        let v = if delta < 0.0 || delta != delta { 0.0 } else { (delta as f32) as f64 };
        self.verify(node, r, CK_FLOAT, v);
        v
    }

    /// InStasis (721) on receiver `r`.
    pub(crate) fn in_stasis(&mut self, r: Recv) -> bool {
        // [offset, key] LastRenderTime, [offset, key, mask] bStasis, [offset,
        // key] Physics, [offset, key, mask] bForceStasis, [offset, key]
        // DistanceFromPlayer.
        let node = self.op(1);
        let mut w = [0u32; 12];
        for (i, word) in w.iter_mut().enumerate() {
            *word = self.op(2 + i);
        }
        self.skip(14);
        let (last, stasis, physics, force, distance) = match (
            self.field(r, w[1], w[0]),
            self.field(r, w[3], w[2]),
            self.field(r, w[6], w[5]),
            self.field(r, w[8], w[7]),
            self.field(r, w[11], w[10]),
        ) {
            (Some(a), Some(b), Some(c), Some(d), Some(e)) => (a, b, c, d, e),
            _ => return self.host_bool(node, r),
        };
        let handle = self.handle(r);
        let time = unsafe { js_level_clock(handle, 1) };
        if fault() {
            return self.host_bool(node, r);
        }
        let v = 'body: {
            // `!(level.timeSeconds - LastRenderTime > 5) || !bStasis`.
            if !(time - f32::from_bits(load32(last)) as f64 > 5.0) || load32(stasis) & w[4] == 0 {
                break 'body false;
            }
            // `!bForceStasis && Physics !== PHYS_None && Physics !== PHYS_Rotating`.
            let p = load8(physics);
            if load32(force) & w[9] == 0 && p != 0 && p != 5 {
                break 'body false;
            }
            let rendered = unsafe { js_zone_render_time(handle) };
            if fault() {
                return self.host_bool(node, r);
            }
            if !(time - rendered > 5.0) && !(f32::from_bits(load32(distance)) as f64 > 1200.0) {
                break 'body false;
            }
            unsafe { js_level_standalone(handle) != 0 }
        };
        self.verify(node, r, CK_BOOL, v as i32 as f64);
        v
    }
}
