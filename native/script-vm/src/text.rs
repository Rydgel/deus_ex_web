//! UGC::DrawText (Extension.dll method 0x10028180, exec 0x1002c280, native 1282) over the window host's native heap, in Rust
//! (docs/script-play-hud.md "DrawText in Rust"). src/runtime/script-gc-draw-text.mjs is the reference: this file transcribes it, and
//! the helpers it calls, step for step with the same heap reads in the same order and the same roundings, so the GC image, the
//! glyph records and the DrawTile commands it hands the host are the bits the JavaScript computes:
//! * the method (0x10028180): the drawing and canvas gates, the emit state's colour from the GC text colour, PushGC, Intersect,
//!   the vertical-alignment measure, the per-line scan and per-glyph drawGlyph, PopGC (-1);
//! * UGC::Intersect (0x10027000), the line scanner (0x10029ae0) with GetNextChar (0x100294d0) and its escapes, the measurement
//!   of GetTextExtent's method (0x10027bb0) for the vertical alignment, UFont's glyph lookup (0x10026880/0x10026950, in
//!   script-font-model.mjs `uFontGlyph`), drawGlyph (0x10029e40) with its texture realize cache (0x1002a370) and the underline.
//!
//! The text arrives as UTF-16 units in an arena buffer (`units`, `end` of them, truncated at the first NUL by the host). The
//! scanner's two process globals (a stale last character and the `|!` flag) are locals here: the JavaScript notes (the
//! reference's `nextChar`) why they are write-only on every path that returns.
//!
//! Float arithmetic follows the reference's JavaScript numbers: a float32 operand is an f64, a sum of two is an f64 sum and `f32()`
//! is one rounding to float32 (`fr`). The render pass's 24-bit precision control (p24.rs, docs/render-pass-precision.md) rounds the
//! `+ 0.1` before each `_ftol` (`ftol`).
//!
//! Host calls: a glyph's DrawTile (`js_gc_glyph`: callVirtual(slot, renderInterface, payload from GLYPH)), a texture Lock and
//! Unlock of the realize cache (`js_gc_tex_lock`, `js_gc_tex_unlock`), PushGC when the free list is empty (`js_gc_text_push`:
//! the JavaScript body allocates a node) and `js_gc_text_fail`, which throws the JavaScript body's error for a heap address
//! outside the heap (kind 1) or a font lookup it cannot model (kind 2). The realize cache's head and count live in TEXC
//! (TEXC = [head, count, record 0..4, static record]); the host's `texCache` reads them there.

use crate::gc::{host, push_gc, restore_gc, GC_STATUS, HEAP_BASE};
use crate::interp::{load32, store32, to_int32};
use crate::p24::sum_exact;
use core::ptr::{addr_of, addr_of_mut};

// UGC fields (script-gc-state-model.mjs GC).
const G_CANVAS: u32 = 0x28;
const G_ORIGIN_X: u32 = 0x2c;
const G_ORIGIN_Y: u32 = 0x30;
const G_CLIP_X: u32 = 0x34;
const G_CLIP_Y: u32 = 0x38;
const G_CLIP_W: u32 = 0x3c;
const G_CLIP_H: u32 = 0x40;
const G_FLAGS: u32 = 0x48;
const G_TEXT_POLY: u32 = 0x50;
const G_TEXT_FLOATS: u32 = 0x6c;
const G_NORMAL_FONT: u32 = 0x7c;
const G_BOLD_FONT: u32 = 0x80;
const G_UNDERLINE_TEX: u32 = 0x84;
const G_UNDERLINE_H: u32 = 0x88;
const G_BASELINE: u32 = 0x8c;
const G_VSPACING: u32 = 0x90;
const G_HALIGN: u32 = 0x94;
const G_VALIGN: u32 = 0x95;
const G_TEXT_FLAGS: u32 = 0x98;
const G_HMULT: u32 = 0x9c;
const G_VMULT: u32 = 0xa0;
const G_DEPTH: u32 = 0xa8;
const G_STACK_TOP: u32 = 0xac;
const F_DRAWING: u32 = 0x2;
const TF_WORD_WRAP: u32 = 0x1;
const TF_SPECIAL: u32 = 0x2;
// UFont (script-font-model.mjs UFONT, FONT_PAGE, FONT_GLYPH).
const FONT_CPP: u32 = 0x28;
const FONT_PAGES: u32 = 0x2c;
const FONT_PAGE_COUNT: u32 = 0x30;
const PAGE_TEXTURE: u32 = 0x0;
const PAGE_CHARS: u32 = 0x4;
const PAGE_NUM_CHARS: u32 = 0x8;
const PAGE_SIZE: u32 = 0x10;
const GLYPH_START_U: u32 = 0x0;
const GLYPH_START_V: u32 = 0x4;
const GLYPH_U_SIZE: u32 = 0x8;
const GLYPH_V_SIZE: u32 = 0xc;
const GLYPH_SIZE: u32 = 0x10;
// The canvas, scene node and render interface the glyph emit walks (script-gc-draw-text.mjs TEXT_DRAW).
const CANVAS_Z: u32 = 0x4c;
const CANVAS_VIEWPORT: u32 = 0x78;
const CANVAS_SCENE_NODE: u32 = 0x7c;
const VIEWPORT_RI: u32 = 0x64;
const GLYPH_SLOT: u32 = 0x7c;
const TEX_LOCK_SLOT: u32 = 0x54;
const TEX_UNLOCK_SLOT: u32 = 0x58;
const RECORD_NEXT: u32 = 0x80;
const CACHE_SIZE: u32 = 5;
// The emit state (script-gc-get-text-extent.mjs STATE_*): bold, has colour, continued, ampersand, then 4 float32 colour words.
const S_BOLD: usize = 0;
const S_HAS_COLOR: usize = 1;
const S_CONTINUED: usize = 2;
const S_AMP: usize = 3;
const S_COLOR: usize = 4;
const S_SIZE: usize = 20;
type State = [u8; S_SIZE];
/// 0x3f70101010101027, the f64 constant at 0x1005e3e8 the colour escapes scale a byte by.
const TEXT_COLOR_SCALE_BITS: u64 = 0x3f70_1010_1010_1027;
/// The f64 0.1 at 0x1005e470 (ftolBiased).
const FTOL_BIAS_BITS: u64 = 0x3fb9_9999_9999_999a;
const PALETTE: [[u8; 3]; 8] = [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255]];

/// GLYPH = the DrawTile command of one glyph: node, record, x, y, xl, yl, u, v, ul, vl, z, colour[4], polyFlags (float bits).
/// Sixteen words.
static mut GLYPH: [u32; 16] = [0; 16];
/// TEXC = [head, count, records[5], static record].
static mut TEXC: [u32; 8] = [0; 8];

#[no_mangle]
pub extern "C" fn vm_gc_glyph_ptr() -> *mut u32 {
    addr_of_mut!(GLYPH) as *mut u32
}
#[no_mangle]
pub extern "C" fn vm_gc_texc_ptr() -> *mut u32 {
    addr_of_mut!(TEXC) as *mut u32
}

#[link(wasm_import_module = "env")]
extern "C" {
    /// services.callVirtual(slot, object, the glyph command in GLYPH).
    fn js_gc_glyph(slot: u32, object: u32);
    /// The texture Lock of the realize cache: callVirtual(slot, texture, {record, b0, b4, arg3: 0xffffffff, ri}).
    fn js_gc_tex_lock(slot: u32, texture: u32, record: u32, b0: u32, b4: u32, ri: u32);
    /// The texture Unlock: callVirtual(slot, texture, {record}).
    fn js_gc_tex_unlock(slot: u32, texture: u32, record: u32);
    /// gcPushGC in JavaScript (the free list is empty: it allocates a node); the depth.
    fn js_gc_text_push(gc: u32) -> i32;
    /// Throw the JavaScript body's error: kind 1 a native heap address outside the heap, kind 2 a font lookup it cannot model.
    fn js_gc_text_fail(kind: u32, value: u32);
}

// ---- Heap access -----------------------------------------------------------------------------------------------------------

#[cold]
#[inline(never)]
fn fail(kind: u32, value: u32) -> ! {
    unsafe { js_gc_text_fail(kind, value) };
    core::arch::wasm32::unreachable()
}

/// The arena address of native address `a` for a `width`-byte access; an address outside the heap throws as the JavaScript heap does.
#[inline(always)]
fn pa(a: u32, width: u32) -> u32 {
    let off = a.wrapping_sub(HEAP_BASE);
    if a < HEAP_BASE || off as u64 + width as u64 > host(1) as u64 {
        fail(1, a);
    }
    host(0).wrapping_add(off)
}
#[inline(always)]
fn rd(a: u32) -> u32 {
    load32(pa(a, 4))
}
#[inline(always)]
fn wr(a: u32, v: u32) {
    store32(pa(a, 4), v)
}
#[inline(always)]
fn rd8(a: u32) -> u32 {
    unsafe { *(pa(a, 1) as usize as *const u8) as u32 }
}
/// A float32 read as the JavaScript heap reads it: widened (a signaling NaN comes back quiet).
#[inline(always)]
fn rf(a: u32) -> f64 {
    f32::from_bits(rd(a)) as f64
}
/// Math.fround.
#[inline(always)]
fn fr(v: f64) -> f64 {
    (v as f32) as f64
}
#[inline(always)]
fn ftol(v: f64) -> i32 {
    to_int32(sum_exact(v, f64::from_bits(FTOL_BIAS_BITS)))
}
/// f32Bits(int): the float32 bits of an int32 value.
#[inline(always)]
fn ibits(v: i32) -> u32 {
    (v as f32).to_bits()
}

// ---- The line scanner (0x100294d0 GetNextChar, 0x10029ae0) --------------------------------------------------------------

struct Text {
    units: *const u16,
    end: usize,
}
impl Text {
    #[inline(always)]
    fn at(&self, i: usize) -> u32 {
        unsafe { *self.units.add(i) as u32 }
    }
}

fn set_f32(state: &mut State, offset: usize, value: f64) {
    state[offset..offset + 4].copy_from_slice(&(value as f32).to_bits().to_le_bytes());
}
fn copy_text_floats(base: u32, state: &mut State) {
    for i in 0..4 {
        let word = rd(base + G_TEXT_FLOATS + 4 * i as u32);
        state[S_COLOR + 4 * i..S_COLOR + 4 * i + 4].copy_from_slice(&word.to_le_bytes());
    }
}
/// 0x100292f0: two hex digits at the cursor into `out`; a partial parse keeps the high nibble. True on a complete pair.
fn parse_hex_byte(cur: &mut usize, t: &Text, out: &mut u32) -> bool {
    *out = 0;
    if *cur >= t.end {
        return false;
    }
    let mut c = t.at(*cur);
    if (0x30..=0x39).contains(&c) {
        *out = (c << 4) & 0xff;
    } else if (0x61..=0x66).contains(&c) || (0x41..=0x46).contains(&c) {
        *out = ((c + 9) << 4) & 0xff;
    } else {
        return false;
    }
    *cur += 1;
    if *cur >= t.end {
        return false;
    }
    c = t.at(*cur);
    if (0x30..=0x39).contains(&c) {
        *out |= c - 0x30;
    } else if (0x61..=0x66).contains(&c) {
        *out |= c - 0x57;
    } else if (0x41..=0x46).contains(&c) {
        *out |= c - 0x37;
    } else {
        return false;
    }
    *cur += 1;
    true
}
/// 0x100293d0: `|cRRGGBB`, three hex bytes into the colour words as float32.
fn parse_color(cur: &mut usize, t: &Text, state: &mut State) {
    let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
    if parse_hex_byte(cur, t, &mut r) && parse_hex_byte(cur, t, &mut g) {
        parse_hex_byte(cur, t, &mut b);
    }
    let scale = f64::from_bits(TEXT_COLOR_SCALE_BITS);
    set_f32(state, S_COLOR, r as f64 * scale);
    set_f32(state, S_COLOR + 4, g as f64 * scale);
    set_f32(state, S_COLOR + 8, b as f64 * scale);
}

/// 0x100294d0: advance the cursor past escapes and return the next renderable unit (0 at the end).
fn next_char(base: u32, cur: &mut usize, end: usize, state: &mut State, t: &Text) -> u32 {
    state[S_AMP] = 0;
    // (gLastChar and gBang, the DLL's process globals, as locals: the reference's `nextChar` shows every path assigns before it reads)
    let mut last: u32 = 0;
    loop {
        if *cur >= end {
            last = 0;
            break;
        }
        if rd(base + G_TEXT_FLAGS) & TF_SPECIAL == 0 || t.at(*cur) != 0x7c {
            last = t.at(*cur);
            *cur += 1;
            break;
        }
        *cur += 1;
        let mut cx;
        if *cur < end {
            cx = t.at(*cur);
            if (0x41..=0x5a).contains(&cx) {
                cx += 0x20;
            }
            last = cx;
        } else {
            cx = last;
        }
        let bang: u32;
        if cx == 0x21 {
            bang = 1;
            *cur += 1;
            if *cur < end {
                cx = t.at(*cur);
                if (0x41..=0x5a).contains(&cx) {
                    cx += 0x20;
                }
                last = cx;
            } else {
                cx = last;
            }
        } else {
            bang = 0;
        }
        if *cur >= end {
            last = 0;
            break;
        }
        if cx == 0x62 {
            *cur += 1;
            state[S_BOLD] = if bang == 0 { 1 } else { 0 };
        } else if cx == 0x63 {
            *cur += 1;
            if bang == 0 {
                parse_color(cur, t, state);
            } else {
                copy_text_floats(base, state);
            }
            state[S_HAS_COLOR] = if bang == 0 { 1 } else { 0 };
        } else if cx == 0x70 {
            *cur += 1;
            if *cur < end {
                if bang != 0 {
                    copy_text_floats(base, state);
                    state[S_HAS_COLOR] = 0;
                } else {
                    let d = t.at(*cur);
                    last = d;
                    if (0x30..0x38).contains(&d) {
                        *cur += 1;
                        last = (d - 0x30) & 0xffff;
                        let rgb = PALETTE[last as usize];
                        let scale = f64::from_bits(TEXT_COLOR_SCALE_BITS);
                        set_f32(state, S_COLOR, rgb[0] as f64 * scale);
                        set_f32(state, S_COLOR + 4, rgb[1] as f64 * scale);
                        set_f32(state, S_COLOR + 8, rgb[2] as f64 * scale);
                        state[S_HAS_COLOR] = 1;
                    }
                }
            }
        } else if cx == 0x26 {
            *cur += 1;
            state[S_AMP] = 1;
        } else {
            last = t.at(*cur);
            *cur += 1;
            break;
        }
        if *cur >= end {
            last = 0;
            break;
        }
    }
    if *cur > end {
        *cur = end;
    }
    last
}

// ---- UFont's glyph lookup (0x10026880 / 0x10026950) ---------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Glyph {
    start_u: i32,
    start_v: i32,
    u_size: i32,
    v_size: i32,
    texture: u32,
}
const NO_GLYPH: Glyph = Glyph { start_u: 0, start_v: 0, u_size: 0, v_size: 0, texture: 0 };

fn font_glyph(font: u32, ch: u32) -> Glyph {
    let ch = (ch & 0xffff) as i32;
    let cpp = rd(font + FONT_CPP) as i32;
    if cpp == 0 {
        fail(2, 0);
    }
    // Math.trunc(ch / cpp): an int division truncating toward zero (ch is non-negative; cpp == -1 cannot overflow here).
    let page = ch.wrapping_div(cpp);
    let rem = ch.wrapping_sub(page.wrapping_mul(cpp));
    let count = rd(font + FONT_PAGE_COUNT) as i32;
    if page >= count {
        return NO_GLYPH;
    }
    let table = rd(font + FONT_PAGES);
    let page_rec = table.wrapping_add((page as u32).wrapping_mul(PAGE_SIZE));
    if page < 0 || rem < 0 {
        fail(2, 1);
    }
    if rem >= rd(page_rec + PAGE_NUM_CHARS) as i32 {
        return NO_GLYPH;
    }
    let texture = rd(page_rec + PAGE_TEXTURE);
    let glyph = rd(page_rec + PAGE_CHARS).wrapping_add((rem as u32).wrapping_mul(GLYPH_SIZE));
    Glyph {
        start_u: rd(glyph + GLYPH_START_U) as i32,
        start_v: rd(glyph + GLYPH_START_V) as i32,
        u_size: rd(glyph + GLYPH_U_SIZE) as i32,
        v_size: rd(glyph + GLYPH_V_SIZE) as i32,
        texture,
    }
}

/// The font of `bold`.
fn font_of(base: u32, bold: u8) -> u32 {
    rd(base + if bold != 0 { G_BOLD_FONT } else { G_NORMAL_FONT })
}

struct Line {
    start: usize,
    len: i64,
    width: f64,
    progress: bool,
}

/// 0x10029ae0 and its wrapper 0x10029d80: scan one line from the cursor, writing the cursor and state back.
fn scan_line(base: u32, cursor: &mut usize, t: &Text, state: &mut State, dest_width: f64) -> Line {
    let mut dest_w = dest_width;
    if !(dest_w > 0.0) {
        dest_w = 500000.0;
    }
    let saved_byte2 = state[S_CONTINUED];
    let start = *cursor;
    let mut work = *state;
    work[S_CONTINUED] = 0;
    let mut font = font_of(base, work[S_BOLD]);
    let mut run_w: f64 = 0.0;
    let mut saved_w: f64 = 0.0;
    let mut first_char = true;
    let mut in_word = true;
    let mut word_start: usize = 0;
    let mut word_end: usize = 0;
    let mut wrapped = false;
    let mut snap_a: State = [0; S_SIZE];
    let mut snap_b: State;
    let mut cur = start;
    let (out_cursor, out_len_end, out_w);
    loop {
        snap_b = work;
        let char_pos = cur;
        let ch = next_char(base, &mut cur, t.end, &mut work, t);
        if ch == 0 || ch == 0x0a {
            out_len_end = if wrapped { word_end } else { char_pos };
            out_w = if wrapped { saved_w } else { run_w };
            if ch == 0x0a {
                work[S_CONTINUED] = 1;
            }
            out_cursor = cur;
            break;
        }
        if (9..=0x0d).contains(&ch) || ch == 0x20 {
            if !in_word {
                in_word = true;
                word_end = char_pos;
                saved_w = run_w;
            }
        } else if in_word {
            if wrapped {
                out_w = saved_w;
                work = snap_b;
                out_cursor = char_pos;
                out_len_end = word_end;
                break;
            }
            snap_a = snap_b;
            in_word = false;
            word_start = char_pos;
        }
        if work[S_BOLD] != snap_b[S_BOLD] {
            font = font_of(base, work[S_BOLD]);
        }
        if font == 0 {
            first_char = false;
            continue;
        }
        let sum = run_w + font_glyph(font, ch).u_size as f64;
        if !(sum > dest_w) {
            run_w = fr(sum);
            first_char = false;
            continue;
        }
        if first_char {
            run_w = fr(sum);
            first_char = false;
            continue;
        }
        if word_end == 0 {
            out_w = run_w;
            work = snap_b;
            out_cursor = char_pos;
            out_len_end = char_pos;
            break;
        }
        if word_start <= word_end {
            wrapped = true;
            run_w = fr(sum);
            first_char = false;
            continue;
        }
        out_w = saved_w;
        work = snap_a;
        out_cursor = word_start;
        out_len_end = word_end;
        break;
    }
    *cursor = out_cursor;
    *state = work;
    Line { start, len: out_len_end as i64 - start as i64, width: out_w, progress: out_cursor > start || saved_byte2 != 0 }
}

/// gcTextExtentUnitsInto: the measurement of GetTextExtent's method (0x10027bb0) over the text, with `dest_width` (a float32
/// value); returns (xExtent, yExtent).
fn text_extent(base: u32, dest_width: f64, t: &Text) -> (f64, f64) {
    let mut state: State = [0; S_SIZE];
    let mut cursor: usize = 0;
    let mut total_y: f64 = 0.0;
    let mut line_h: f64 = 0.0;
    let mut max_x: f64 = 0.0;
    let mut bold = state[S_BOLD];
    let mut font = rd(base + G_NORMAL_FONT);
    loop {
        let line = scan_line(base, &mut cursor, t, &mut state, dest_width);
        if !line.progress {
            break;
        }
        let line_end = (line.start as i64 + line.len) as usize;
        let mut rescan = line.start;
        loop {
            let ch = next_char(base, &mut rescan, line_end, &mut state, t);
            if ch == 0 {
                break;
            }
            let cl = state[S_BOLD];
            if cl != bold {
                font = font_of(base, cl);
                bold = cl;
            }
            if ch == 0x0a || font == 0 {
                continue;
            }
            let h = font_glyph(font, ch).v_size as f64;
            if !(line_h >= h) {
                line_h = h;
            }
        }
        if !(line_h >= 1.0) && font != 0 {
            line_h = font_glyph(font, 0x20).v_size as f64;
        }
        if !(max_x >= line.width) {
            max_x = line.width;
        }
        total_y = fr(line_h + rf(base + G_VSPACING) + total_y);
        line_h = 0.0;
    }
    (max_x, fr(line_h + total_y))
}

// ---- The glyph emit (0x10029e40) and the texture realize cache (0x1002a370) --------------------------------------------------

/// callSlot: the function pointer at `slot_offset` of `object`'s vtable.
fn slot_of(object: u32, slot_offset: u32) -> u32 {
    rd(rd(object) + slot_offset)
}

/// 0x1002a370: the five-record MRU cache of FTextureInfo records, keyed by the texture pointer at record + 0.
fn realize(canvas: u32, tex: u32) -> u32 {
    let t = addr_of_mut!(TEXC) as *mut u32;
    let (mut head, mut count) = unsafe { (*t, *t.add(1)) };
    let static_record = unsafe { *t.add(7) };
    if tex == 0 {
        return static_record;
    }
    let mut rec = head;
    let mut prev = 0u32;
    loop {
        if rec == 0 {
            // Miss at the end of the list: take the next free record (or fall back to the static one).
            if count >= CACHE_SIZE {
                return static_record;
            }
            rec = unsafe { *t.add(2 + count as usize) };
            count += 1;
            unsafe { *t.add(1) = count };
            break;
        }
        let next = rd(rec + RECORD_NEXT);
        let force_tail = next == 0 && count >= CACHE_SIZE;
        if !force_tail && rd(rec) != tex {
            prev = rec;
            rec = next;
            continue;
        }
        if prev != 0 {
            wr(prev + RECORD_NEXT, next);
        } else {
            head = next;
            unsafe { *t = head };
        }
        break;
    }
    let cur = rd(rec);
    if cur != tex {
        if cur != 0 {
            unsafe { js_gc_tex_unlock(slot_of(cur, TEX_UNLOCK_SLOT), cur, rec) };
        }
        let vp = rd(canvas + CANVAS_VIEWPORT);
        unsafe { js_gc_tex_lock(slot_of(tex, TEX_LOCK_SLOT), tex, rec, rd(vp + 0xb0), rd(vp + 0xb4), rd(vp + VIEWPORT_RI)) };
    }
    // MRU re-head.
    let head = unsafe { *t };
    wr(rec + RECORD_NEXT, head);
    unsafe { *t = rec };
    rec
}

/// One glyph command into GLYPH and the host's DrawTile through the render interface `ri`.
#[allow(clippy::too_many_arguments)]
fn emit(base: u32, canvas: u32, node: u32, ri: u32, record: u32, wx: f64, wy: f64, w: f64, h: f64, u: f64, v: f64, color: &[u8]) {
    let hm = rd(base + G_HMULT) as i32;
    let vm = rd(base + G_VMULT) as i32;
    let poly = rd(base + G_TEXT_POLY);
    let g = unsafe { &mut *addr_of_mut!(GLYPH) };
    g[0] = node;
    g[1] = record;
    g[2] = ibits(ftol(wx).wrapping_mul(hm));
    g[3] = ibits(ftol(wy).wrapping_mul(vm));
    g[4] = ibits(ftol(w).wrapping_mul(hm));
    g[5] = ibits(ftol(h).wrapping_mul(vm));
    g[6] = ibits(ftol(u));
    g[7] = ibits(ftol(v));
    g[8] = ibits(ftol(w));
    g[9] = ibits(ftol(h));
    g[10] = rd(canvas + CANVAS_Z);
    for i in 0..4 {
        g[11 + i] = u32::from_le_bytes([color[4 * i], color[4 * i + 1], color[4 * i + 2], color[4 * i + 3]]);
    }
    g[15] = poly;
    unsafe { js_gc_glyph(slot_of(ri, GLYPH_SLOT), ri) };
}

/// drawGlyph 0x10029e40: the glyph `ch` of `font` at (x, y); `pen` advances by the glyph's float32 width and returns the glyph's
/// height.
fn draw_glyph(base: u32, font: u32, ch: u32, state: &State, x: f64, y: f64, pen: &mut f64) -> f64 {
    let canvas = rd(base + G_CANVAS);
    let node = rd(canvas + CANVAS_SCENE_NODE);
    let glyph = font_glyph(font, ch);
    let record = realize(canvas, glyph.texture);
    let origin_x = rf(base + G_ORIGIN_X);
    let origin_y = rf(base + G_ORIGIN_Y);
    let mut wx = fr(x + origin_x);
    let mut wy = fr(y + origin_y);
    let mut w = fr(glyph.u_size as f64);
    let mut h = fr(glyph.v_size as f64);
    let mut u = fr(glyph.start_u as f64);
    let mut v = fr(glyph.start_v as f64);
    *pen = fr(w + *pen);
    let glyph_h = h;

    let clip_left = fr(rf(base + G_CLIP_X) + origin_x);
    let clip_top = fr(rf(base + G_CLIP_Y) + origin_y);
    if !(wx >= clip_left) {
        let d = wx - clip_left;
        u = fr(u - d);
        wx = clip_left;
        w = fr(w + d);
    }
    if !(wy >= clip_top) {
        let d = wy - clip_top;
        v = fr(v - d);
        wy = clip_top;
        h = fr(h + d);
    }
    let clip_right = clip_left + rf(base + G_CLIP_W);
    if w + wx > clip_right {
        w = fr(clip_right - wx);
    }
    let clip_bottom = clip_top + rf(base + G_CLIP_H);
    if h + wy > clip_bottom {
        h = fr(clip_bottom - wy);
    }
    if !(w > 0.0) || !(h > 0.0) {
        return glyph_h;
    }
    let color = &state[S_COLOR..S_COLOR + 16];
    let ri = rd(rd(node) + VIEWPORT_RI);
    emit(base, canvas, node, ri, record, wx, wy, w, h, u, v, color);

    // The underline: the '|&' flag, an underline texture and a positive underline height gate a second emit.
    if state[S_AMP] == 0 {
        return glyph_h;
    }
    let underline_tex = rd(base + G_UNDERLINE_TEX);
    if underline_tex == 0 {
        return glyph_h;
    }
    let underline_h = rf(base + G_UNDERLINE_H);
    if !(underline_h > 0.0) {
        return glyph_h;
    }
    let record2 = realize(canvas, underline_tex);
    let (mut u2, mut v2) = (0.0f64, 0.0f64);
    let mut w2 = fr(glyph.u_size as f64 - 1.0);
    let mut h2 = underline_h;
    let mut wx2 = fr(x + origin_x);
    let mut wy2 = fr(glyph.v_size as f64 - rf(base + G_BASELINE) + origin_y + y);
    if !(wx2 >= clip_left) {
        let d = wx2 - clip_left;
        u2 = fr(-d);
        wx2 = clip_left;
        w2 = fr(w2 + d);
    }
    if !(wy2 >= clip_top) {
        let d = wy2 - clip_top;
        v2 = fr(-d);
        wy2 = clip_top;
        h2 = fr(h2 + d);
    }
    if w2 + wx2 > clip_right {
        w2 = fr(clip_right - wx2);
    }
    if h2 + wy2 > clip_bottom {
        h2 = fr(clip_bottom - wy2);
    }
    if !(w2 > 0.0) || !(h2 > 0.0) {
        return glyph_h;
    }
    emit(base, canvas, node, ri, record2, wx2, wy2, w2, h2, u2, v2, color);
    glyph_h
}

// ---- UGC::Intersect (0x10027000) and the method (0x10028180) --------------------------------------------------------------

fn intersect(base: u32, clip_x: f64, clip_y: f64, clip_w: f64, clip_h: f64) {
    let ox = rf(base + G_ORIGIN_X);
    let oy = rf(base + G_ORIGIN_Y);
    let sx = rf(base + G_CLIP_W);
    let sy = rf(base + G_CLIP_H);
    let a = fr(clip_x + ox);
    let b = fr(clip_y + oy);
    let c = fr(rf(base + G_CLIP_X) + ox);
    let d = fr(rf(base + G_CLIP_Y) + oy);
    let e = fr(c + sx);
    let f = d + sy;
    let g = a + clip_w;
    let h = fr(b + clip_h);
    let cp = if !(c >= a) { a } else { c };
    let dp = if !(d >= b) { b } else { d };
    let r = if e > g { fr(g) } else { e };
    let bt = if f > h { h } else { f };
    wr(base + G_CLIP_X, ((cp - ox) as f32).to_bits());
    wr(base + G_CLIP_Y, ((dp - oy) as f32).to_bits());
    wr(base + G_CLIP_W, ((r - cp) as f32).to_bits());
    wr(base + G_CLIP_H, ((bt - dp) as f32).to_bits());
}

/// Math.trunc.
fn trunc(v: f64) -> f64 {
    if !v.is_finite() || v.abs() >= 4503599627370496.0 {
        v
    } else {
        (v as i64) as f64
    }
}

/// W.gc.push over the native heap: the depth, from the Rust body or (an empty free list) the JavaScript one.
fn gc_push(gc: u32) {
    unsafe { *addr_of_mut!(GC_STATUS) = [0, 0] };
    if push_gc(gc).is_none() {
        match unsafe { *addr_of!(GC_STATUS) } {
            [1, _] => {
                unsafe { js_gc_text_push(gc) };
            }
            [_, a] => fail(1, a),
        }
    }
}

/// PopGC(-1) (0x100279f0): restore to the top node's depth, or the depth less one.
fn gc_pop(gc: u32) {
    unsafe { *addr_of_mut!(GC_STATUS) = [0, 0] };
    let top = rd(gc + G_STACK_TOP);
    let target = if top != 0 { rd(top + G_DEPTH) as i32 } else { (rd(gc + G_DEPTH) as i32).wrapping_sub(1) };
    let _ = restore_gc(gc, target);
    if let [2, a] = unsafe { *addr_of!(GC_STATUS) } {
        fail(1, a);
    }
}

/// Method 0x10028180 for the GC at `base`, the destination rectangle (float32 bits) and the text (`end` units at `units`).
#[no_mangle]
pub extern "C" fn vm_gc_draw_text(base: u32, dest_x: u32, dest_y: u32, dest_w: u32, dest_h: u32, units: u32, end: u32) {
    if rd(base + G_FLAGS) & F_DRAWING == 0 {
        return;
    }
    if rd(base + G_CANVAS) == 0 {
        return;
    }
    let t = Text { units: units as usize as *const u16, end: end as usize };
    let dx = f32::from_bits(dest_x) as f64;
    let dy = f32::from_bits(dest_y) as f64;
    let dw = f32::from_bits(dest_w) as f64;
    let dh = f32::from_bits(dest_h) as f64;

    let mut state_a: State = [0; S_SIZE];
    copy_text_floats(base, &mut state_a);
    let mut cur_font = rd(base + G_NORMAL_FONT);
    let mut cur_bold: u8 = 0;
    let wrap_int: i32 = if rd(base + G_TEXT_FLAGS) & TF_WORD_WRAP != 0 { to_int32(trunc(dw)) } else { 0 };

    gc_push(base);
    intersect(base, dx, dy, dw, dh);

    let mut line_y = dy;
    let valign = rd8(base + G_VALIGN);
    if valign != 0 {
        let (_, y_extent) = text_extent(base, fr(wrap_int as f64), &t);
        if valign == 1 {
            let half = to_int32(trunc(trunc(dh - y_extent) / 2.0));
            line_y = fr(half as f64 + line_y);
        } else if valign == 2 {
            line_y = fr(line_y + dh - y_extent);
        }
    }

    let mut state_b: State;
    let mut cursor: usize = 0;
    loop {
        state_b = state_a;
        let line = scan_line(base, &mut cursor, &t, &mut state_b, fr(wrap_int as f64));
        if !line.progress {
            break;
        }
        let line_w = line.width;
        let line_end = (line.start as i64 + line.len) as usize;

        let halign = rd8(base + G_HALIGN);
        let mut pen_x;
        if halign == 1 {
            let half = to_int32(trunc(trunc(dw - line_w) / 2.0));
            pen_x = fr(half as f64 + dx);
        } else if halign == 2 {
            pen_x = fr(dx + dw - line_w);
        } else {
            pen_x = dx;
        }

        let mut emit_cur = line.start;
        let mut line_max_h: f64 = 0.0;
        loop {
            let ch = next_char(base, &mut emit_cur, line_end, &mut state_a, &t);
            if ch == 0 {
                break;
            }
            let cl = state_a[S_BOLD];
            if cl != cur_bold {
                cur_font = font_of(base, cl);
                cur_bold = cl;
            }
            if ch == 0x0a || cur_font == 0 {
                continue;
            }
            let h = draw_glyph(base, cur_font, ch, &state_a, pen_x, line_y, &mut pen_x);
            if !(line_max_h >= h) {
                line_max_h = h;
            }
        }

        if !(line_max_h >= 1.0) && cur_font != 0 {
            line_max_h = fr(font_glyph(cur_font, 0x20).v_size as f64);
        }
        line_y = fr(line_max_h + rf(base + G_VSPACING) + line_y);
        state_a = state_b;
    }

    gc_pop(base);
}
