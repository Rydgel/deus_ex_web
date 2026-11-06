//! XWindow::DrawTree (Extension.dll 0x10051490) over the window host's native heap, in Rust (docs/script-play-hud.md "The draw tree
//! in Rust"). src/runtime/script-window-tree-natives.mjs `drawTree` stays the reference: this body makes the same heap reads and
//! stores in the same order, and runs the window's DrawWindow and PostDrawWindow script events as the host's `processScript` does,
//! from the event cache (dispatch.rs `dispatch_window_event`), without the JavaScript around each event.
//!
//! One window, in order (the JavaScript body's):
//! 1. a window the host delegates to another owner (`externalSubtree`: InfoLink, ConPlay) is skipped;
//! 2. LockWindow (+0x34 += 1); the rest runs, then UnlockWindow (a lock count above zero is decremented, and a window flagged
//!    destroying (+0x30 & 0x10) goes to SafeDestroy, `js_window_destroy`);
//! 3. nothing is drawn unless the GC (+0x130) is set, the visible flag (+0x30 & 1) is on and the clip width and height (+0xe4,
//!    +0xe8) are above zero (an unordered value fails the test: the x87 compares c0/c3 of the JavaScript are both false only above);
//! 4. PushGC; the GC's canvas (+0x28) and multipliers (+0x9c, +0xa0) are set;
//! 5. a window with a background style (+0x3c) and a background texture (+0xec) draws its icon pattern (`js_window_background`);
//! 6. DrawWindow, the children in sibling order (+0x13c, +0x148), PostDrawWindow, PopGC to the depth PushGC returned.
//!
//! The JavaScript `granularityDepth` global that drawTree raises and lowers around steps 6's events has no reader but drawTree
//! itself (the reconfigure diagnostics read `global100aeb08`, a different entry), so it is not kept here.
//!
//! The host describes each window and GC it meets once (`js_window_info`: its VM handle and what its draw is), into a table keyed
//! by native address and WINDOWS' epoch, which the host advances whenever a heap object is freed or forgotten (a freed address can
//! be reused) and when a subtree is delegated. A window the host cannot describe is drawn by the JavaScript body
//! (`js_window_tree`), and so is a draw that is not the plain script event (the Text, Button, Checkbox, List ... families,
//! `js_window_phase`), or an event whose function the cache sends to JavaScript.
//!
//! WINDOWS = [table, slot count (a power of two), epoch]; a slot is [address, epoch, handle, flags].

use crate::dispatch::dispatch_window_event;
use crate::gc::{host, push_gc, restore_gc, GC_STATUS, G_CANVAS, G_HMULT, G_VMULT, HEAP_BASE};
use crate::interp::{load32, load8, store32};
use core::ptr::{addr_of, addr_of_mut};

static mut WINDOWS: [u32; 3] = [0; 3];
static mut FAULT: u32 = 0;
const SLOT: u32 = 16;
/// Slot flag bits (script-vm-window.mjs).
const F_DRAW_SCRIPT: u32 = 1;
const F_POST_SCRIPT: u32 = 2;
const F_EXTERNAL: u32 = 4;

// XWindow fields (script-window-tree-natives.mjs O).
const O_FLAGS: u32 = 0x30;
const O_LOCK: u32 = 0x34;
const O_BG_STYLE: u32 = 0x3c;
const O_CLIP_W: u32 = 0xe4;
const O_CLIP_H: u32 = 0xe8;
const O_BACKGROUND: u32 = 0xec;
const O_GGC: u32 = 0x130;
const O_FIRST_CHILD: u32 = 0x13c;
const O_NEXT_SIBLING: u32 = 0x148;

#[no_mangle]
pub extern "C" fn vm_windows_ptr() -> *mut u32 {
    addr_of_mut!(WINDOWS) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_window_fault_ptr() -> *mut u32 {
    addr_of_mut!(FAULT)
}

#[link(wasm_import_module = "env")]
extern "C" {
    /// Describe the window or GC at native `addr` into the slot at `slot` (handle, flags); 0 when the host cannot.
    fn js_window_info(addr: u32, slot: u32) -> u32;
    /// The JavaScript drawTree of `win` and its subtree.
    fn js_window_tree(win: u32);
    /// The host's draw (0) or postDraw (1) virtual for `win` with its GC.
    fn js_window_phase(win: u32, gc: u32, which: u32);
    /// DrawTree's background icon pattern for `win`.
    fn js_window_background(win: u32, gc: u32);
    /// UnlockWindow's SafeDestroy.
    fn js_window_destroy(win: u32);
    /// gcPushGC in JavaScript (the free list is empty: the body allocates a node); the depth.
    fn js_window_gc_push(gc: u32) -> i32;
}

struct Fault(u32);
type R<T> = Result<T, Fault>;

#[inline(always)]
fn at(a: u32, width: u32) -> R<u32> {
    let off = a.wrapping_sub(HEAP_BASE);
    if a < HEAP_BASE || off as u64 + width as u64 > host(1) as u64 {
        return Err(Fault(a));
    }
    Ok(host(0).wrapping_add(off))
}
#[inline(always)]
fn r32(a: u32) -> R<u32> {
    at(a, 4).map(load32)
}
#[inline(always)]
fn r8(a: u32) -> R<u32> {
    at(a, 1).map(|p| load8(p) as u32)
}
#[inline(always)]
fn w32(a: u32, v: u32) -> R<()> {
    at(a, 4).map(|p| store32(p, v))
}

#[inline(always)]
fn mix(mut h: u32) -> u32 {
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^ (h >> 16)
}

/// The window or GC at `addr`: its handle and flags, from the table or from the host.
fn describe(addr: u32) -> Option<(u32, u32)> {
    let w = unsafe { *addr_of!(WINDOWS) };
    if w[0] == 0 || w[1] == 0 {
        return None;
    }
    let slot = w[0].wrapping_add((mix(addr) & (w[1] - 1)).wrapping_mul(SLOT));
    if load32(slot) == addr && load32(slot.wrapping_add(4)) == w[2] {
        return Some((load32(slot.wrapping_add(8)), load32(slot.wrapping_add(12))));
    }
    if unsafe { js_window_info(addr, slot) } == 0 {
        return None;
    }
    store32(slot, addr);
    store32(slot.wrapping_add(4), unsafe { (*addr_of!(WINDOWS))[2] });
    Some((load32(slot.wrapping_add(8)), load32(slot.wrapping_add(12))))
}

struct Ctx {
    canvas: u32,
    h: u32,
    v: u32,
}

/// W.gc.push: the Rust body, or the JavaScript one when the free list is empty.
fn gc_push(gc: u32) -> R<i32> {
    unsafe { *addr_of_mut!(GC_STATUS) = [0, 0] };
    match push_gc(gc) {
        Some(depth) => Ok(depth),
        None => match unsafe { *addr_of!(GC_STATUS) } {
            [1, _] => Ok(unsafe { js_window_gc_push(gc) }),
            [_, a] => Err(Fault(a)),
        },
    }
}

/// W.gc.pop(gc, depth) with a depth (not -1).
fn gc_pop(gc: u32, depth: i32) -> R<()> {
    unsafe { *addr_of_mut!(GC_STATUS) = [0, 0] };
    let _ = restore_gc(gc, depth);
    match unsafe { *addr_of!(GC_STATUS) } {
        [2, a] => Err(Fault(a)),
        _ => Ok(()),
    }
}

/// `x > 0` as the JavaScript's `!(c0(x, 0) || c3(x, 0))`: below, equal and unordered all fail.
#[inline(always)]
fn positive(bits: u32) -> bool {
    f32::from_bits(bits) > 0.0
}

/// W.v.draw (0) or W.v.postDraw (1): the cached script event for a plain window, else the host's virtual.
fn phase(win: u32, gc: u32, handle: u32, flags: u32, which: u32) {
    if flags & if which == 0 { F_DRAW_SCRIPT } else { F_POST_SCRIPT } != 0 {
        if let Some((gc_handle, _)) = describe(gc) {
            if dispatch_window_event(handle, which, gc_handle) >= 0 {
                return;
            }
        }
    }
    unsafe { js_window_phase(win, gc, which) };
}

fn draw_locked(win: u32, handle: u32, flags: u32, ctx: &Ctx) -> R<()> {
    let gc = r32(win.wrapping_add(O_GGC))?;
    if gc == 0 || r8(win.wrapping_add(O_FLAGS))? & 1 == 0 {
        return Ok(());
    }
    if !positive(r32(win.wrapping_add(O_CLIP_W))?) || !positive(r32(win.wrapping_add(O_CLIP_H))?) {
        return Ok(());
    }
    let saved = gc_push(gc)?;
    w32(gc.wrapping_add(G_CANVAS), ctx.canvas)?;
    w32(gc.wrapping_add(G_HMULT), ctx.h)?;
    w32(gc.wrapping_add(G_VMULT), ctx.v)?;
    let texture = r32(win.wrapping_add(O_BACKGROUND))?;
    if r8(win.wrapping_add(O_BG_STYLE))? != 0 && texture != 0 {
        unsafe { js_window_background(win, gc) };
    }
    phase(win, gc, handle, flags, 0);
    let mut child = r32(win.wrapping_add(O_FIRST_CHILD))?;
    while child != 0 {
        draw_tree(child, ctx)?;
        child = r32(child.wrapping_add(O_NEXT_SIBLING))?;
    }
    phase(win, gc, handle, flags, 1);
    gc_pop(gc, saved)
}

fn draw_tree(win: u32, ctx: &Ctx) -> R<()> {
    let Some((handle, flags)) = describe(win) else {
        unsafe { js_window_tree(win) };
        return Ok(());
    };
    if flags & F_EXTERNAL != 0 {
        return Ok(());
    }
    let lock = r32(win.wrapping_add(O_LOCK))?;
    w32(win.wrapping_add(O_LOCK), lock.wrapping_add(1))?;
    draw_locked(win, handle, flags, ctx)?;
    // unlockWindow
    let count = r32(win.wrapping_add(O_LOCK))? as i32;
    if count <= 0 {
        return Ok(());
    }
    w32(win.wrapping_add(O_LOCK), (count - 1) as u32)?;
    if r8(win.wrapping_add(O_FLAGS))? & 0x10 != 0 {
        unsafe { js_window_destroy(win) };
    }
    Ok(())
}

/// DrawTree of `root` with the canvas at native address `canvas` and the root's multipliers: 0 when done, 2 when a heap access fell
/// outside the heap (the address is in the fault word; the host throws the native heap's error).
#[no_mangle]
pub extern "C" fn vm_draw_tree(root: u32, canvas: u32, h: u32, v: u32) -> u32 {
    match draw_tree(root, &Ctx { canvas, h, v }) {
        Ok(()) => 0,
        Err(Fault(a)) => {
            unsafe { FAULT = a };
            2
        }
    }
}
