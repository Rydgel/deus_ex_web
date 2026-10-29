//! XComputerWindow::Tick's per-frame x87 arithmetic (Extension.dll 0x1000f7b0) on the 80-bit model (x87.rs), the integer form of the
//! BigInt body in src/runtime/script-window-computer-playback.mjs, which stays as the reference (`computerTick` runs it when the kernel
//! is not loaded; test/script-window-computer-tick.test.mjs runs both over random float32 values and edge cases).
//!
//! Every value crosses as a float32 bit pattern in the block below, so a NaN keeps its payload and a zero its sign; the host
//! (computer-tick-kernel.mjs) writes the inputs, calls one step and reads the outputs. The operations are the body's, in its order:
//! FLD m32 of each field, FMUL/FADD/FSUB at the precision control (x87.rs), one FST/FSTP m32 where the body stores.

use crate::galaxy::{below, cmp, Cmp};
use crate::x87::Ext;

const IO_WORDS: usize = 16;
static mut IO: [u32; IO_WORDS] = [0; IO_WORDS];

#[no_mangle]
pub extern "C" fn computer_io_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(IO) as *mut u32
}

fn io(i: usize) -> u32 {
    unsafe { (*core::ptr::addr_of!(IO))[i] }
}
fn put(i: usize, value: u32) {
    unsafe { (*core::ptr::addr_of_mut!(IO))[i] = value };
}
/// FLD m32 of an IO word.
fn ld(i: usize) -> Ext {
    Ext::load(io(i))
}
fn sub(a: Ext, b: Ext) -> Ext {
    a.add(b.neg())
}

/// The cursor blink step. In: 0 cursorNextEvent, 1 delta, 2 cursorBlinkSpeed. `cursor = next - delta` is stored to word 8; when it is
/// below zero or unordered (`lt`), word 9 is 1 and word 10 holds `cursor + blink` stored (the host puts it over the first store and
/// toggles the cursor flag); else word 9 is 0.
#[no_mangle]
pub extern "C" fn computer_cursor_step() {
    let cursor = sub(ld(0), ld(1));
    put(8, cursor.store());
    if below(cmp(cursor, Ext::load(0))) {
        put(9, 1);
        put(10, cursor.add(ld(2)).store());
    } else {
        put(9, 0);
    }
}

/// The time step. In: 0 delta, 1 throttle, 2 timeCurrent, 3 timeLastEvent, 4 eventTimeInterval. `current = delta * throttle +
/// timeCurrent` is stored to word 8; when `current - timeLastEvent` is above the interval, word 9 is 1 and word 10 holds `current +
/// interval` stored (timeNextEvent); else word 9 is 0.
#[no_mangle]
pub extern "C" fn computer_time_step() {
    let current = ld(0).mul(ld(1)).add(ld(2));
    put(8, current.store());
    if cmp(sub(current, ld(3)), ld(4)) == Cmp::Gt {
        put(9, 1);
        put(10, current.add(ld(4)).store());
    } else {
        put(9, 0);
    }
}
