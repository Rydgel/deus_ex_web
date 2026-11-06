//! Extension.dll's GC state and tile natives over the window host's native
//! heap (docs/play-cpu-plan.md, Phase 5), for a statement `gc.Native(...)`
//! whose native is one of SetStyle 1212, SetTileColor 1230, SetTextColor
//! 1240, SetFont 1242, SetAlignments 1256, EnableWordWrap 1258, DrawTexture
//! 1284 or DrawPattern 1285. Each body transcribes its JavaScript reference
//! (script-gc-*.mjs, script-gc-draw-model.mjs) step for step: the same
//! rounding points, the same heap reads in the same order, so the bit
//! patterns stored and handed to the canvas are the ones the JavaScript
//! computes. The GC draws inside the render pass (PaintWindows from
//! PostRenderFlash), under x87 precision control 24: the clip helper's
//! operations and the `+ 0.1` before each _ftol round to 24 bits (p24.rs,
//! docs/render-pass-precision.md).
//!
//! The native heap (script-native-heap.mjs) is a range of the arena: native
//! address A is `region + (A - HEAP_BASE)` while A is inside [HEAP_BASE,
//! HEAP_BASE + capacity), the JavaScript `byteIndex` check. GC_HOST = [region,
//! capacity, gate, verify, epoch], written by the host (script-vm-gc.mjs).
//! `gate` is nonzero only while the window host paints and its own native
//! dispatch would reach dispatchGcNative for these indices (no boundary
//! native, no replaced invokeNative); otherwise the native node runs in
//! JavaScript.
//!
//! GC_EFFECT 206 `ctx, node, index, len`, the context object's code, then
//! `args, n` and per argument a kind and its code:
//! * GA_FLOAT 1 (float code): dispatchGcNative's f32Bits(value), the f32 bits
//!   of the value (UNDEF_F64, JavaScript's undefined, as the quiet NaN);
//! * GA_INT 2 (int code), GA_BOOL 3 (bool code, `v ? 1 : 0`);
//! * GA_OBJECT 4 (object code): `heap.addressOf(value)` after every argument
//!   is evaluated (js_gc_address, which may materialize a resource image);
//! * GA_COLOR_LOCAL 5 `off` and GA_COLOR_FIELD 6 `off, key`: a Color
//!   variable, dispatchGcNative's pack() of its R, G, B, A bytes, which is
//!   the struct's u32. A field on the JavaScript path runs the native node
//!   in JavaScript (the lowering puts a color only as a sole argument).
//!
//! The context object is evaluated with SELF; None reports Accessed None
//! and skips the native (the CONTEXT rule). Arguments are evaluated with
//! SELF, in order, as compileNative's evaluateArgument does. A receiver
//! without a heap image (js_gc_address), a closed gate, or a color field on
//! the JavaScript path runs the native node with js_eval on the context
//! object before any argument is evaluated. A heap address outside the heap
//! hands the evaluated arguments to js_gc_native, which runs the JavaScript
//! body (and raises its error) before any store or canvas call.

use crate::interp::{load32, store32, store8, to_int32, Recv, Run, SELF, UNDEFINED, UNDEF_F64_BITS};
use crate::p24::{add, div, mul, sub, sum_exact};
use core::ptr::{addr_of, addr_of_mut};

pub(crate) const GC_EFFECT: u32 = 206;
const GA_FLOAT: u32 = 1;
const GA_INT: u32 = 2;
const GA_BOOL: u32 = 3;
const GA_OBJECT: u32 = 4;
const GA_COLOR_LOCAL: u32 = 5;
const GA_COLOR_FIELD: u32 = 6;

pub(crate) const HEAP_BASE: u32 = 0x2100_0000;
// UGC fields (script-gc-state-model.mjs GC).
pub(crate) const G_CANVAS: u32 = 0x28;
const G_ORIGIN_X: u32 = 0x2c;
const G_ORIGIN_Y: u32 = 0x30;
const G_CLIP_X: u32 = 0x34;
const G_CLIP_Y: u32 = 0x38;
const G_CLIP_W: u32 = 0x3c;
const G_CLIP_H: u32 = 0x40;
const G_STYLE: u32 = 0x44;
const G_FLAGS: u32 = 0x48;
const G_POLY: u32 = 0x4c;
const G_TILE_COLOR: u32 = 0x54;
const G_TILE_FLOATS: u32 = 0x58;
const G_TEXT_COLOR: u32 = 0x68;
const G_TEXT_FLOATS: u32 = 0x6c;
const G_NORMAL_FONT: u32 = 0x7c;
const G_BOLD_FONT: u32 = 0x80;
const G_HALIGN: u32 = 0x94;
const G_VALIGN: u32 = 0x95;
const G_TEXT_FLAGS: u32 = 0x98;
pub(crate) const G_HMULT: u32 = 0x9c;
pub(crate) const G_VMULT: u32 = 0xa0;
/// The UGC image size: the verify snapshot.
pub(crate) const GC_SIZE: usize = 0xb8;
const F_DRAWING: u32 = 0x2;
// script-gc-draw-model.mjs GC_DRAW.
const CANVAS_Z: u32 = 0x4c;
const DRAW_TILE_SLOT: u32 = 0x5c;
const TEX_USIZE: u32 = 0x34;
const TEX_VSIZE: u32 = 0x38;
/// The 1/255 f64 at 0x1005e3c0 (gcColorChannel).
const COLOR_SCALE_BITS: u64 = 0x3f70_1010_1010_1010;
/// The f64 0.1 at 0x1005e470 (ftolBiased).
const FTOL_BIAS_BITS: u64 = 0x3fb9_9999_9999_999a;
const CACHE: usize = 32;

/// [region, capacity, gate, verify, epoch].
static mut GC_HOST: [u32; 5] = [0; 5];
/// The converted arguments js_gc_native / js_gc_verify read.
static mut GC_ARGS: [u32; 8] = [0; 8];
/// A DrawTile command: texture, x, y, xl, yl, u, v, ul, vl, z, color[4],
/// polyFlags (drawTileCommand's fields, float bits).
static mut GC_TILE: [u32; 15] = [0; 15];
/// The GC image before a body ran (verify).
static mut GC_SNAP: [u8; GC_SIZE] = [0; GC_SIZE];
/// [handle, address, epoch]: receivers (objectAddress) and arguments
/// (addressOf), direct-mapped by handle.
static mut RECV_CACHE: [[u32; 3]; CACHE] = [[0; 3]; CACHE];
static mut ARG_CACHE: [[u32; 3]; CACHE] = [[0; 3]; CACHE];
static mut FAULT: bool = false;

#[no_mangle]
pub extern "C" fn vm_gc_ptr() -> *mut u32 {
    addr_of_mut!(GC_HOST) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_gc_args_ptr() -> *mut u32 {
    addr_of_mut!(GC_ARGS) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_gc_tile_ptr() -> *mut u32 {
    addr_of_mut!(GC_TILE) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_gc_snap_ptr() -> *mut u8 {
    addr_of_mut!(GC_SNAP) as *mut u8
}

#[link(wasm_import_module = "env")]
extern "C" {
    /// `receiver` 1: gcServices.objectAddress (0 when the object has no heap
    /// image); 0: heap.addressOf.
    fn js_gc_address(handle: u32, receiver: u32) -> u32;
    /// gcCallDrawTile's services.callVirtual(slot, canvas, command) with the
    /// command in GC_TILE.
    fn js_gc_tile(slot: u32, canvas: u32);
    /// The JavaScript body of `index` on GC_ARGS (it raises the heap error).
    fn js_gc_native(index: u32, handle: u32);
    /// GC_NATIVE=verify: the JavaScript body on the snapshot, compared.
    fn js_gc_verify(index: u32, handle: u32, base: u32);
}

#[inline(always)]
pub(crate) fn host(i: usize) -> u32 {
    unsafe { (*addr_of!(GC_HOST))[i] }
}

/// The arena address of native address `a` for a `width`-byte access, or a
/// fault (read as 0).
#[inline(always)]
fn at(a: u32, width: u32) -> u32 {
    let off = a.wrapping_sub(HEAP_BASE);
    if a < HEAP_BASE || off as u64 + width as u64 > host(1) as u64 {
        unsafe { FAULT = true };
        return 0;
    }
    host(0).wrapping_add(off)
}
#[inline(always)]
fn r32(a: u32) -> u32 {
    let p = at(a, 4);
    if p == 0 {
        0
    } else {
        load32(p)
    }
}
#[inline(always)]
fn rf(a: u32) -> f64 {
    f32::from_bits(r32(a)) as f64
}
#[inline(always)]
fn f(v: f64) -> f64 {
    (v as f32) as f64
}
#[inline(always)]
fn fbits(v: f64) -> u32 {
    (v as f32).to_bits()
}

/// ftolBiased: ToInt32 of `v + 0.1`, the FADD m64 rounded once to 24 bits.
fn ftol(v: f64) -> i32 {
    to_int32(sum_exact(v, f64::from_bits(FTOL_BIAS_BITS)))
}

fn cached(cache: *mut [[u32; 3]; CACHE], handle: u32, receiver: u32) -> u32 {
    let epoch = host(4);
    let slot = (handle as usize) % CACHE;
    unsafe {
        let entry = &mut (*cache)[slot];
        if entry[0] == handle && entry[2] == epoch && entry[1] != 0 {
            return entry[1];
        }
        let address = js_gc_address(handle, receiver);
        if address != 0 {
            *entry = [handle, address, epoch];
        }
        address
    }
}

/// gcColorChannel: `Math.fround((byte & 0xff) * GC_COLOR_SCALE)`.
#[inline(always)]
fn channel(byte: u32) -> u32 {
    fbits(((byte & 0xff) as f64) * f64::from_bits(COLOR_SCALE_BITS))
}

/// The UGC stores of the state natives; the image range was checked.
fn state_body(index: u32, base: u32, a: &[u32; 8]) {
    let p = |off: u32| host(0).wrapping_add(base.wrapping_sub(HEAP_BASE)).wrapping_add(off);
    match index {
        // gcSetStyle, then updatePolyFlagsFromFlags.
        1212 => {
            let style = a[0] & 0xff;
            store8(p(G_STYLE), style as u8);
            let flags = load32(p(G_FLAGS));
            if style == 0 {
                store32(p(G_FLAGS), flags & !F_DRAWING);
                return;
            }
            let mut next = flags | F_DRAWING;
            next = match style {
                2 => (next & !0x18) | 0x4,
                3 => (next & !0x14) | 0x8,
                4 => (next & !0x0c) | 0x10,
                _ => next & !0x1c,
            };
            store32(p(G_FLAGS), next);
            let flags = load32(p(G_FLAGS));
            let mut pf = 0x100;
            if flags & 0x4 != 0 {
                pf = 0x102;
            }
            if flags & 0x8 != 0 {
                pf |= 0x4;
            }
            if flags & 0x10 != 0 {
                pf |= 0x40;
            }
            if flags & 0x1 == 0 {
                pf |= 0x800;
            }
            store32(p(G_POLY), pf);
        }
        // gcSetTileColor / gcSetTextColor.
        1230 | 1240 => {
            let (word, floats) = if index == 1230 { (G_TILE_COLOR, G_TILE_FLOATS) } else { (G_TEXT_COLOR, G_TEXT_FLOATS) };
            let color = a[0];
            store32(p(word), color);
            store32(p(floats), channel(color));
            store32(p(floats + 4), channel(color >> 8));
            store32(p(floats + 8), channel(color >> 16));
            store32(p(floats + 12), 0);
        }
        // gcSetFont.
        1242 => {
            store32(p(G_NORMAL_FONT), a[0]);
            store32(p(G_BOLD_FONT), a[0]);
        }
        // gcSetAlignments.
        1256 => {
            store8(p(G_HALIGN), (a[0] & 0xff) as u8);
            store8(p(G_VALIGN), (a[1] & 0xff) as u8);
        }
        // gcEnableWordWrap.
        1258 => {
            let flags = load32(p(G_TEXT_FLAGS));
            store32(p(G_TEXT_FLAGS), ((flags ^ a[0]) & 1) ^ flags);
        }
        _ => {}
    }
}

/// The clip helper 0x1002a4f0 (gcClipTile) over s = [x, y, w, h, u, v, ul, vl]:
/// the stores f32, the stack values 24-bit (one rounding per FADD, FSUB,
/// FMUL and FDIV), the FILD'd texture size through `sum_exact`.
fn clip(base: u32, s: &mut [f64; 8], flag_w: bool, flag_h: bool, tex: u32) {
    let (x, y, w, h, u, v, ul, vl) = (0, 1, 2, 3, 4, 5, 6, 7);
    s[x] = f(add(rf(base + G_ORIGIN_X), s[x]));
    s[y] = f(add(rf(base + G_ORIGIN_Y), s[y]));
    let clip_left = f(add(rf(base + G_CLIP_X), rf(base + G_ORIGIN_X)));
    let clip_top = f(add(rf(base + G_CLIP_Y), rf(base + G_ORIGIN_Y)));

    if flag_w {
        if !(s[x] >= clip_left) {
            let d = sub(s[x], clip_left);
            s[u] = f(sub(s[u], d));
            s[w] = f(add(d, s[w]));
            s[x] = clip_left;
        }
        let clip_right = add(clip_left, rf(base + G_CLIP_W));
        if add(s[x], s[w]) > clip_right {
            s[w] = f(sub(clip_right, s[x]));
        }
        s[ul] = s[w];
    } else {
        if s[w] > 0.0 && !(s[x] >= clip_left) {
            let d = sub(s[x], clip_left);
            let t = div(mul(d, s[ul]), s[w]);
            s[ul] = f(add(t, s[ul]));
            s[u] = f(sub(s[u], t));
            s[w] = f(add(d, s[w]));
            s[x] = clip_left;
        }
        if s[w] > 0.0 {
            let dest_right = add(s[x], s[w]);
            let clip_right = add(clip_left, rf(base + G_CLIP_W));
            if dest_right > clip_right {
                s[ul] = f(add(div(mul(sub(clip_right, dest_right), s[ul]), s[w]), s[ul]));
                s[w] = f(sub(add(clip_left, rf(base + G_CLIP_W)), s[x]));
            }
        }
        if s[ul] > 0.0 {
            if !(s[u] >= 0.0) {
                let d = div(mul(s[u], s[w]), s[ul]);
                s[w] = f(add(d, s[w]));
                s[x] = f(sub(s[x], d));
                s[ul] = f(add(s[u], s[ul]));
                s[u] = 0.0;
            }
            let tex_w = r32(tex.wrapping_add(TEX_USIZE)) as i32 as f64;
            let u_end = add(s[u], s[ul]);
            if u_end > tex_w {
                s[w] = f(add(div(mul(sum_exact(tex_w, -u_end), s[w]), s[ul]), s[w]));
                s[ul] = f(sum_exact(tex_w, -s[u]));
            }
        }
    }

    if flag_h {
        if !(s[y] >= clip_top) {
            let d = sub(s[y], clip_top);
            s[v] = f(sub(s[v], d));
            s[h] = f(add(d, s[h]));
            s[y] = clip_top;
        }
        let clip_bottom = add(clip_top, rf(base + G_CLIP_H));
        if add(s[y], s[h]) > clip_bottom {
            s[h] = f(sub(clip_bottom, s[y]));
        }
        s[vl] = s[h];
    } else {
        if s[h] > 0.0 && !(s[y] >= clip_top) {
            let d = sub(s[y], clip_top);
            let t = div(mul(d, s[vl]), s[h]);
            s[vl] = f(add(t, s[vl]));
            s[v] = f(sub(s[v], t));
            s[h] = f(add(d, s[h]));
            s[y] = clip_top;
        }
        if s[h] > 0.0 {
            let dest_bottom = add(s[y], s[h]);
            let clip_bottom = add(clip_top, rf(base + G_CLIP_H));
            if dest_bottom > clip_bottom {
                s[vl] = f(add(div(mul(sub(clip_bottom, dest_bottom), s[vl]), s[h]), s[vl]));
                s[h] = f(sub(add(clip_top, rf(base + G_CLIP_H)), s[y]));
            }
        }
        if s[vl] > 0.0 {
            if !(s[v] >= 0.0) {
                let d = div(mul(s[v], s[h]), s[vl]);
                s[h] = f(add(d, s[h]));
                s[y] = f(sub(s[y], d));
                s[vl] = f(add(s[v], s[vl]));
                s[v] = 0.0;
            }
            let tex_h = r32(tex.wrapping_add(TEX_VSIZE)) as i32 as f64;
            let v_end = add(s[v], s[vl]);
            if v_end > tex_h {
                s[h] = f(add(div(mul(sum_exact(tex_h, -v_end), s[h]), s[vl]), s[h]));
                s[vl] = f(sum_exact(tex_h, -s[v]));
            }
        }
    }
}

/// DrawTexture's gate, DrawPattern, the tile gate 0x10028770 and the sink
/// 0x1002a820 up to the canvas call: Some((slot, canvas)) with the command
/// in GC_TILE, or None when a gate suppresses it. Only reads the heap.
fn draw_body(index: u32, base: u32, a: &[u32; 8]) -> Option<(u32, u32)> {
    let tex = a[6];
    if tex == 0 {
        return None;
    }
    if r32(base + G_FLAGS) & F_DRAWING == 0 {
        return None;
    }
    let g = |i: usize| f32::from_bits(a[i]) as f64;
    let (ul, vl) = if index == 1284 { (g(2), g(3)) } else { (0.0, 0.0) };
    // gcTileEmitGate: zeroOrUnordered(ul/vl); DrawPattern passes 1, 1.
    let (flag_w, flag_h) = if index == 1284 { (!(ul > 0.0) && !(ul < 0.0), !(vl > 0.0) && !(vl < 0.0)) } else { (true, true) };
    // gcTileEmitGate's drawing test (DrawTexture only), then the sink's.
    if index == 1284 && r32(base + G_FLAGS) & F_DRAWING == 0 {
        return None;
    }
    if r32(base + G_FLAGS) & F_DRAWING == 0 {
        return None;
    }
    if r32(base + G_CANVAS) == 0 {
        return None;
    }
    let mut s = [g(0), g(1), g(2), g(3), g(4), g(5), ul, vl];
    clip(base, &mut s, flag_w, flag_h, tex);
    if !(s[2] > 0.0) || !(s[3] > 0.0) || !(s[6] > 0.0) || !(s[7] > 0.0) {
        return None;
    }
    let canvas = r32(base + G_CANVAS);
    let hmult = r32(base + G_HMULT) as i32;
    let vmult = r32(base + G_VMULT) as i32;
    let color = [r32(base + G_TILE_FLOATS), r32(base + G_TILE_FLOATS + 4), r32(base + G_TILE_FLOATS + 8), r32(base + G_TILE_FLOATS + 12)];
    let int_bits = |v: i32| (v as f32).to_bits();
    let tile = [
        tex,
        int_bits(ftol(s[0]).wrapping_mul(hmult)),
        int_bits(ftol(s[1]).wrapping_mul(vmult)),
        int_bits(ftol(s[2]).wrapping_mul(hmult)),
        int_bits(ftol(s[3]).wrapping_mul(vmult)),
        int_bits(ftol(s[4])),
        int_bits(ftol(s[5])),
        int_bits(ftol(s[6])),
        int_bits(ftol(s[7])),
        r32(canvas.wrapping_add(CANVAS_Z)),
        color[0],
        color[1],
        color[2],
        color[3],
        r32(base + G_POLY),
    ];
    // gcCallDrawTile: canvas, its vtable, the DrawTile slot.
    let canvas = r32(base + G_CANVAS);
    let vtable = r32(canvas);
    let slot = r32(vtable.wrapping_add(DRAW_TILE_SLOT));
    unsafe { *addr_of_mut!(GC_TILE) = tile };
    Some((slot, canvas))
}

impl Run {
    /// A GC_EFFECT statement (see the header).
    pub(crate) fn gc_effect(&mut self) {
        let (ctx, node, index) = (self.op(1), self.op(2), self.op(3));
        self.skip(5);
        let object = self.object(SELF);
        let args_len = self.op(0) as usize;
        self.skip(1);
        let end = unsafe { self.pc.add(args_len) };
        if object == 0 || object == UNDEFINED {
            self.pc = end;
            self.accessed_none(ctx);
            return;
        }
        let gc = Recv { handle: object, info: 0, bind: 0 };
        let base = if host(2) != 0 && host(0) != 0 { cached(addr_of_mut!(RECV_CACHE), object, 1) } else { 0 };
        if base == 0 {
            self.pc = end;
            self.host_eval_on(node, gc);
            return;
        }
        let n = self.op(0) as usize;
        self.skip(1);
        let mut a = [0u32; 8];
        for i in 0..n.min(8) {
            let kind = self.op(0);
            self.skip(1);
            a[i] = match kind {
                GA_FLOAT => {
                    let v = self.float(SELF);
                    if v.to_bits() == UNDEF_F64_BITS {
                        0x7fc0_0000
                    } else {
                        fbits(v)
                    }
                }
                GA_INT => self.int(SELF) as u32,
                GA_BOOL => self.boolean(SELF) as u32,
                GA_OBJECT => self.object(SELF),
                GA_COLOR_LOCAL => {
                    let off = self.op(0);
                    self.skip(1);
                    load32(self.locals.wrapping_add(off))
                }
                GA_COLOR_FIELD => {
                    let (off, key) = (self.op(0), self.op(1));
                    self.skip(2);
                    match self.field(SELF, key, off) {
                        Some(addr) => load32(addr),
                        None => {
                            self.pc = end;
                            self.host_eval_on(node, gc);
                            return;
                        }
                    }
                }
                _ => {
                    self.pc = end;
                    self.host_eval_on(node, gc);
                    return;
                }
            };
        }
        self.pc = end;
        // dispatchGcNative's addressOf conversions, after every argument.
        let object_arg = match index {
            1242 => 0,
            1284 | 1285 => 6,
            _ => usize::MAX,
        };
        if object_arg != usize::MAX {
            let handle = a[object_arg];
            a[object_arg] = if handle == 0 || handle == UNDEFINED { 0 } else { cached(addr_of_mut!(ARG_CACHE), handle, 0) };
        }
        unsafe { *addr_of_mut!(GC_ARGS) = a };
        let verify = host(3) != 0;
        if verify {
            let p = at(base, GC_SIZE as u32);
            if p != 0 {
                unsafe {
                    core::ptr::copy_nonoverlapping(p as usize as *const u8, addr_of_mut!(GC_SNAP) as *mut u8, GC_SIZE);
                }
            }
        }
        unsafe { FAULT = false };
        match index {
            1284 | 1285 => {
                // GC_TILE[0] (the texture, nonzero for a tile) marks a tile.
                unsafe { (*addr_of_mut!(GC_TILE))[0] = 0 };
                let tile = draw_body(index, base, &a);
                if unsafe { FAULT } {
                    unsafe { js_gc_native(index, object) };
                } else if verify {
                    unsafe { js_gc_verify(index, object, base) };
                } else if let Some((slot, canvas)) = tile {
                    unsafe { js_gc_tile(slot, canvas) };
                }
            }
            _ => {
                if at(base, GC_SIZE as u32) == 0 {
                    unsafe { js_gc_native(index, object) };
                } else {
                    state_body(index, base, &a);
                    if verify {
                        unsafe { js_gc_verify(index, object, base) };
                    }
                }
            }
        }
        self.self_fresh = false;
    }
}

// PushGC 0x10027c90 / PopGC's restore 0x10027d40 and CopyGC 0x10027b40
// (script-gc-push-gc.mjs, script-gc-pop-gc.mjs, script-gc-copy-gc.mjs), for
// the window host's DrawTree and PaintWindows (script-window-tree-natives
// .mjs), which call them directly. Each read and store is the JavaScript
// body's, in its order. GC_STATUS = [status, address]: 0 done; 1 the
// JavaScript body must run instead (PushGC with an empty free list, which
// allocates a node), before any store; 2 a heap access at `address` fell
// outside the heap after the stores the JavaScript body makes before the
// same access, which then throws there.
const G_NODE_FLAGS: u32 = 0xa4;
const G_DEPTH: u32 = 0xa8;
const G_STACK_TOP: u32 = 0xac;
const G_FREE_LIST: u32 = 0xb0;
const G_OWNER: u32 = 0xb4;
const G_TEXT_POLY: u32 = 0x50;
const G_UNKNOWN84: u32 = 0x84;
const G_UNDERLINE: u32 = 0x88;
const G_BASELINE: u32 = 0x8c;
const G_VSPACING: u32 = 0x90;
pub(crate) static mut GC_STATUS: [u32; 2] = [0; 2];

#[no_mangle]
pub extern "C" fn vm_gc_status_ptr() -> *mut u32 {
    addr_of_mut!(GC_STATUS) as *mut u32
}

/// A checked heap access for the stack bodies: the arena address, or None
/// after recording the fault.
#[inline(always)]
fn checked(a: u32, width: u32) -> Option<u32> {
    let off = a.wrapping_sub(HEAP_BASE);
    if a < HEAP_BASE || off as u64 + width as u64 > host(1) as u64 {
        unsafe { *addr_of_mut!(GC_STATUS) = [2, a] };
        return None;
    }
    Some(host(0).wrapping_add(off))
}
fn g32(a: u32) -> Option<u32> {
    checked(a, 4).map(load32)
}
fn s32(a: u32, v: u32) -> Option<()> {
    checked(a, 4).map(|p| store32(p, v))
}
fn g8(a: u32) -> Option<u8> {
    checked(a, 1).map(|p| crate::interp::load8(p))
}
fn s8(a: u32, v: u8) -> Option<()> {
    checked(a, 1).map(|p| store8(p, v))
}

/// gcCopyGC(dst, src).
fn copy_gc(dst: u32, src: u32) -> Option<()> {
    s32(dst.wrapping_add(G_CANVAS), g32(src.wrapping_add(G_CANVAS))?)?;
    let mut off = G_ORIGIN_X;
    while off <= G_CLIP_H {
        s32(dst.wrapping_add(off), g32(src.wrapping_add(off))?)?;
        off += 4;
    }
    s8(dst.wrapping_add(G_STYLE), g8(src.wrapping_add(G_STYLE))?)?;
    let flags = g32(dst.wrapping_add(G_FLAGS))?;
    s32(dst.wrapping_add(G_FLAGS), (flags & !0x3f) | (g32(src.wrapping_add(G_FLAGS))? & 0x3f))?;
    for off in [G_POLY, G_TEXT_POLY, G_TILE_COLOR] {
        s32(dst.wrapping_add(off), g32(src.wrapping_add(off))?)?;
    }
    for i in 0..4 {
        s32(dst.wrapping_add(G_TILE_FLOATS + 4 * i), g32(src.wrapping_add(G_TILE_FLOATS + 4 * i))?)?;
    }
    s32(dst.wrapping_add(G_TEXT_COLOR), g32(src.wrapping_add(G_TEXT_COLOR))?)?;
    for i in 0..4 {
        s32(dst.wrapping_add(G_TEXT_FLOATS + 4 * i), g32(src.wrapping_add(G_TEXT_FLOATS + 4 * i))?)?;
    }
    for off in [G_NORMAL_FONT, G_BOLD_FONT, G_UNKNOWN84, G_UNDERLINE, G_BASELINE, G_VSPACING] {
        s32(dst.wrapping_add(off), g32(src.wrapping_add(off))?)?;
    }
    s8(dst.wrapping_add(G_HALIGN), g8(src.wrapping_add(G_HALIGN))?)?;
    s8(dst.wrapping_add(G_VALIGN), g8(src.wrapping_add(G_VALIGN))?)?;
    let text_flags = g32(dst.wrapping_add(G_TEXT_FLAGS))?;
    s32(dst.wrapping_add(G_TEXT_FLAGS), (text_flags & !0x3) | (g32(src.wrapping_add(G_TEXT_FLAGS))? & 0x3))?;
    for off in [G_HMULT, G_VMULT] {
        s32(dst.wrapping_add(off), g32(src.wrapping_add(off))?)?;
    }
    Some(())
}

pub(crate) fn push_gc(gc: u32) -> Option<i32> {
    let depth = g32(gc + G_DEPTH)? as i32;
    if g32(gc + G_OWNER)? != 0 {
        return Some(depth);
    }
    let node = g32(gc + G_FREE_LIST)?;
    if node == 0 {
        unsafe { *addr_of_mut!(GC_STATUS) = [1, 0] };
        return None;
    }
    s32(gc + G_FREE_LIST, g32(node.wrapping_add(G_STACK_TOP))?)?;
    copy_gc(node, gc)?;
    s32(node.wrapping_add(G_OWNER), gc)?;
    s32(node.wrapping_add(G_NODE_FLAGS), g32(node.wrapping_add(G_NODE_FLAGS))? & !1)?;
    s32(node.wrapping_add(G_FREE_LIST), 0)?;
    s32(node.wrapping_add(G_DEPTH), g32(gc + G_DEPTH)?)?;
    s32(node.wrapping_add(G_STACK_TOP), g32(gc + G_STACK_TOP)?)?;
    s32(gc + G_STACK_TOP, node)?;
    s32(gc + G_DEPTH, (g32(gc + G_DEPTH)? as i32).wrapping_add(1) as u32)?;
    Some(depth)
}

/// gcRestoreGC(gc, n).
pub(crate) fn restore_gc(gc: u32, n: i32) -> Option<()> {
    if n >= g32(gc + G_DEPTH)? as i32 {
        return Some(());
    }
    if g32(gc + G_OWNER)? != 0 {
        return Some(());
    }
    let mut found = false;
    let mut last = 0;
    let mut node = g32(gc + G_STACK_TOP)?;
    while node != 0 {
        let node_depth = g32(node.wrapping_add(G_DEPTH))? as i32;
        if node_depth < n {
            break;
        }
        if node_depth == n {
            found = true;
        }
        last = node;
        let next = g32(node.wrapping_add(G_STACK_TOP))?;
        s32(gc + G_STACK_TOP, next)?;
        s32(gc + G_DEPTH, node_depth as u32)?;
        let free = g32(gc + G_FREE_LIST)?;
        let depth = if free != 0 { (g32(free.wrapping_add(G_DEPTH))? as i32).wrapping_add(1) } else { 1 };
        s32(node.wrapping_add(G_DEPTH), depth as u32)?;
        s32(node.wrapping_add(G_OWNER), gc)?;
        s32(node.wrapping_add(G_NODE_FLAGS), g32(node.wrapping_add(G_NODE_FLAGS))? | 1)?;
        s32(node.wrapping_add(G_STACK_TOP), g32(gc + G_FREE_LIST)?)?;
        s32(node.wrapping_add(G_FREE_LIST), 0)?;
        s32(gc + G_FREE_LIST, node)?;
        if found {
            break;
        }
        node = next;
    }
    if last != 0 {
        copy_gc(gc, last)?;
    }
    Some(())
}

/// gcPushGC on the GC at native address `gc`: its depth before the push.
#[no_mangle]
pub extern "C" fn vm_gc_push(gc: u32) -> i32 {
    unsafe { *addr_of_mut!(GC_STATUS) = [0, 0] };
    push_gc(gc).unwrap_or(0)
}

/// gcPopGC(gc, gcNum).
#[no_mangle]
pub extern "C" fn vm_gc_pop(gc: u32, gc_num: i32) {
    unsafe { *addr_of_mut!(GC_STATUS) = [0, 0] };
    let _ = (|| -> Option<()> {
        if gc_num == -1 {
            let top = g32(gc + G_STACK_TOP)?;
            // `L.read(depth) - 1` is a double; gcRestoreGC's `n |= 0` wraps it.
            let target = if top != 0 { g32(top.wrapping_add(G_DEPTH))? as i32 } else { (g32(gc + G_DEPTH)? as i32).wrapping_sub(1) };
            restore_gc(gc, target)
        } else {
            restore_gc(gc, gc_num)
        }
    })();
}
