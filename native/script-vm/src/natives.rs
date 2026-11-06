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
//! * PLAYER_PAWN 207 `node` (object): GetPlayerPawn (720), `handleOf(playerPawnShortcut(receiver))`, the Engine native's pointer
//!   walk (the level's engine, its client, the first viewport's actor) that triggers' resolver follows over the host's graph. The
//!   answer comes from PLAYER_PAWN_CELL, [graph epoch, the epoch the handle is valid for, handle, verify]: the host (script-vm-
//!   player-pawn.mjs) advances the graph epoch whenever one of the properties the walk reads is written, and js_player_pawn
//!   computes the walk, fills the handle and marks it valid for the epoch it was computed at. An epoch that differs, and every
//!   node while `verify` is set (PLAYER_PAWN=verify), cross to js_player_pawn.
//!
//! The bodies only read. A field outside the image (a HOST receiver, a bound
//! key on a BOUND receiver) or a host value the JavaScript body would not
//! compute with (the clock imports set NATIVE_FAULT: an error, a value that
//! is not a number) hands the whole node to JavaScript, which reads again
//! and raises the body's errors. The clock imports run no script.

use crate::interp::{handle_slot, load32, load8, Recv, Run, CK_BOOL, CK_FLOAT, CK_NAME, CK_OBJECT, GONE, NAME_NONE};
use core::ptr::{addr_of, addr_of_mut};

/// STATES = [table, capacity, verify] (script-vm-states.mjs): an entry per
/// handle slot, `capacity` the window (interp.rs header, HANDLES).
static mut STATES: [u32; 3] = [0; 3];
/// Set by a clock import whose value the body would not use.
static mut NATIVE_FAULT: u32 = 0;
const ENTRY: u32 = 16;
/// The frame word of a ProcessState that returns at once (no execution, or
/// a null cursor): script-vm-states.mjs FRAME_NONE.
pub(crate) const FRAME_NONE: u32 = 0xffff_ffff;
/// Sleep's latent action (execSleep 0x103dfef0 writes 0x180).
pub(crate) const LATENT_SLEEP: u32 = 384;

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
    /// GetPlayerPawn's walk for the node's receiver, the cell filled; the handle (script-vm-rust.mjs `playerPawnCell`).
    fn js_player_pawn(frame: u32, node: u32, receiver: u32) -> u32;
}

/// [graph epoch, epoch the handle is valid for, handle, verify]: the epoch is 1 or more once the host has attached (the cell's
/// valid word starts at 0, so a cell nothing has filled is never current).
static mut PLAYER_PAWN_CELL: [u32; 4] = [0; 4];
#[no_mangle]
pub extern "C" fn vm_player_pawn_ptr() -> *mut u32 {
    addr_of_mut!(PLAYER_PAWN_CELL) as *mut u32
}

/// Whether STATE_VERIFY=1 set the table's verify word.
pub(crate) fn state_verify() -> bool {
    unsafe { *(addr_of!(STATES) as *const u32).add(2) != 0 }
}

/// The address of `handle`'s state entry [row, probe lo, probe hi, frame], computed
/// by the host when it is not filled (or always, under STATE_VERIFY), or 0
/// when the host does not describe the handle.
pub(crate) fn state_entry(handle: u32) -> u32 {
    let states = addr_of!(STATES) as *const u32;
    let (table, capacity, verify) = unsafe { (*states, *states.add(1), *states.add(2)) };
    if verify == 0 {
        let slot = handle_slot(handle, capacity);
        if slot < GONE {
            let at = table.wrapping_add(ENTRY.wrapping_mul(slot));
            if load32(at) != 0 {
                return at;
            }
        }
    }
    if unsafe { js_state(handle) } == 0 {
        return 0;
    }
    // js_state entered the handle, growing the table if it had to (a handle
    // it describes is live, so it has a slot then).
    let (table, capacity) = unsafe { (*states, *states.add(1)) };
    match handle_slot(handle, capacity) {
        slot if slot < GONE => table.wrapping_add(ENTRY.wrapping_mul(slot)),
        _ => 0,
    }
}

/// Whether `handle`'s object probes the name with probe index `ename` (0x12c..0x16b): the state table's probe words decide as
/// ScriptState.isProbing does; an instance without a ScriptState (a row with no names) or one the host does not describe probes every
/// name. ProcessInternal's gate on a script call (Core 0x1013f6c6-0x1013f6fe).
pub(crate) fn probing_name(handle: u32, ename: u32) -> bool {
    let entry = state_entry(handle);
    if entry == 0 {
        return true;
    }
    let bit = ename.wrapping_sub(0x12c);
    load32(load32(entry).wrapping_add(4)) == 0 || bit >= 64 || load32(entry.wrapping_add(4 + 4 * (bit >> 5))) & (1u32 << (bit & 31)) != 0
}

/// `handle`'s frame word (script-vm-states.mjs), or 0 (state code to run,
/// which makes the caller cross) when the host does not describe it.
pub(crate) fn state_frame(handle: u32) -> u32 {
    match state_entry(handle) {
        0 => 0,
        at => load32(at.wrapping_add(12)),
    }
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
    /// GetPlayerPawn (720) on receiver `r`: the cell's handle while the graph epoch is the one it was filled at.
    pub(crate) fn player_pawn(&mut self, r: Recv) -> u32 {
        let node = self.op(1);
        self.skip(2);
        let cell = addr_of!(PLAYER_PAWN_CELL) as *const u32;
        let (epoch, valid, handle, verify) = unsafe { (*cell, *cell.add(1), *cell.add(2), *cell.add(3)) };
        let v = if verify == 0 && epoch == valid {
            handle
        } else {
            let v = unsafe { js_player_pawn(self.frame, node, self.handle(r)) };
            self.self_fresh = false;
            v
        };
        self.verify(node, r, CK_OBJECT, v as f64);
        v
    }

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
