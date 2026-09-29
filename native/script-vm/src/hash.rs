//! The collision hash and ULevel's line checks (docs/rust-core.md, step
//! R3-b), transcribed from their JavaScript bodies, which stay the reference
//! and carry the native evidence:
//!
//! * the hash's buckets, registration, removal and candidate order
//!   (src/runtime/collision-hash.mjs, docs/collision-hash.md), in its
//!   seed-independent 0..255 domain (the only one the level queries use);
//! * the line-query cells (`collisionHashLineBounds`, with X's 64-bit x87
//!   expansion);
//! * the cylinder primitive (primitive-collision.mjs `primitiveLineHit`);
//! * MultiLineCheck's world clip, mover backoff, 64-hit cap and the bundled
//!   CRT qsort (multiline.mjs);
//! * SingleLineCheck's walk of the sorted hits (line-filter.mjs), whose
//!   per-candidate test stays JavaScript.
//!
//! Arithmetic follows trace.rs: the JavaScript's doubles in the same order,
//! `f` where it calls Math.fround, `sqrt`/`js_min`/`js_max` for Math.sqrt,
//! Math.min and Math.max. `x ** 2` is `x * x` (fdlibm pow's y == 2 case;
//! scripts/validate-collision-kernel.mjs checks V8 agrees).
//!
//! Live actor state is never cached here. The three imports are the
//! JavaScript reads the reference makes at the same points
//! (src/runtime/collision-kernel.mjs): a candidate's cylinder or brush
//! (`valuesOf(actor)` and its Location, CollisionRadius, CollisionHeight or
//! model and ToWorld), `isMover(actor)` per joined actor hit, and the whole
//! SingleLineCheck filter body per examined hit (owner chain, class, the
//! live collision bits). Imports may throw; the host restores the shadow
//! stack and the `querying`/`busy` words.
//!
//! Hash memory (arena ranges the host allocates and grows between calls; a
//! `Header` addresses them):
//!   keys/heads  open-addressed cell table: packed tag -> first link
//!   links       per link: registration id and next link (per-cell LIFO)
//!   stamps      per registration id: the last query that visited it
//!   scratch     per registration id: one actor hit (a query's collected
//!               primitive hits, before the join)
//! Registration ids are the host's (dense, reused after removal).

use core::ptr::addr_of_mut;
use crate::trace::{self, abs, f, js_max, js_min, pow2, sqrt, TraceHit};

const NONE: u32 = u32::MAX;
const EMPTY: u32 = u32::MAX;
/// The actor id of MultiLineCheck's world hit.
const WORLD: u32 = u32::MAX;

const ANSWERED: i32 = 0;
const FALLBACK: i32 = 2;

// Hit kinds: the JavaScript result shapes (collision-kernel.mjs `hitObject`).
const WORLD_RAY: u32 = 0;
const WORLD_EXTENT: u32 = 1;
const CYLINDER: u32 = 2;
const BRUSH_RAY: u32 = 3;
const BRUSH_EXTENT: u32 = 4;

// lc_candidate's answer: CAND holds the cylinder (Location, radius, height),
// or CAND[5] the brush model's address and OWNER its ToWorld (owned).
const C_CYLINDER: i32 = 0;
const C_BRUSH_OWNED: i32 = 1;
const C_BRUSH: i32 = 2;

extern "C" {
    fn lc_candidate(id: u32) -> i32;
    fn lc_mover(id: u32) -> i32;
    fn lc_accept(id: u32) -> i32;
}

#[repr(C)]
struct Header {
    keys: u32,
    heads: u32,
    table_cap: u32,
    table_used: u32,
    link_reg: u32,
    link_next: u32,
    link_cap: u32,
    link_top: u32,
    link_free: u32,
    links_live: u32,
    stamps: u32,
    reg_cap: u32,
    stamp: u32,
    querying: u32,
    busy: u32,
    scratch: u32,
    /// lc_scan's cache epoch, and the per-registration cache.
    epoch: u32,
    cache: u32,
    _pad: [u32; 2],
}
const _: () = assert!(core::mem::size_of::<Header>() == 80);

#[derive(Clone, Copy)]
#[repr(C)]
struct Hit {
    time: f64,
    location: [f64; 3],
    normal: [f64; 3],
    node: f64,
    actor: u32,
    kind: u32,
    penetrating: u32,
    _pad: u32,
}
const _: () = assert!(core::mem::size_of::<Hit>() == 80);
const NO_HIT: Hit = Hit { time: 0.0, location: [0.0; 3], normal: [0.0; 3], node: 0.0, actor: 0, kind: 0, penetrating: 0, _pad: 0 };

/// A candidate's geometry, written by lc_candidate.
static mut CAND: [f64; 8] = [0.0; 8];
/// A query's answer: [count, accepted index], then `count` records of
/// RECORD f64s (time, location, normal, node, penetrating, actor, kind).
const RECORD: usize = 11;
static mut ANSWER: [f64; 2 + RECORD * 64] = [0.0; 2 + RECORD * 64];
/// Validator scratch (scripts/validate-collision-kernel.mjs).
static mut TEST: [f64; 2 + RECORD * 256] = [0.0; 2 + RECORD * 256];

#[no_mangle]
pub extern "C" fn lc_cand_ptr() -> *mut f64 {
    addr_of_mut!(CAND) as *mut f64
}
#[no_mangle]
pub extern "C" fn lc_answer_ptr() -> *mut f64 {
    addr_of_mut!(ANSWER) as *mut f64
}
#[no_mangle]
pub extern "C" fn lc_test_ptr() -> *mut f64 {
    addr_of_mut!(TEST) as *mut f64
}

#[inline(always)]
unsafe fn at(ptr: u32, i: u32) -> *mut u32 {
    (ptr as usize as *mut u32).add(i as usize)
}
#[inline(always)]
fn slot0(tag: u32, cap: u32) -> u32 {
    tag.wrapping_mul(0x9e37_79b1) >> (cap.leading_zeros() + 1)
}
#[inline(always)]
fn tag(x: i32, y: i32, z: i32) -> u32 {
    (((z << 8) + y) << 8) as u32 + x as u32
}

/// The cell's slot, or NONE.
unsafe fn find(h: &Header, key: u32) -> u32 {
    let mask = h.table_cap - 1;
    let mut i = slot0(key, h.table_cap);
    loop {
        let k = *at(h.keys, i);
        if k == key {
            return i;
        }
        if k == EMPTY {
            return NONE;
        }
        i = (i + 1) & mask;
    }
}
/// The cell's slot, inserted empty if new. The host keeps the table at most
/// half full.
unsafe fn find_or_insert(h: &mut Header, key: u32) -> u32 {
    let mask = h.table_cap - 1;
    let mut i = slot0(key, h.table_cap);
    loop {
        let k = *at(h.keys, i);
        if k == key {
            return i;
        }
        if k == EMPTY {
            *at(h.keys, i) = key;
            *at(h.heads, i) = NONE;
            h.table_used += 1;
            return i;
        }
        i = (i + 1) & mask;
    }
}

/// A fresh header for arrays the host allocated (keys and heads `table_cap`
/// words, links `link_cap` words each, stamps and scratch `reg_cap` entries).
#[no_mangle]
pub unsafe extern "C" fn hash_init(h: u32, keys: u32, heads: u32, table_cap: u32, link_reg: u32, link_next: u32,
    link_cap: u32, stamps: u32, scratch: u32, cache: u32, reg_cap: u32) {
    let hd = &mut *(h as usize as *mut Header);
    *hd = Header { keys, heads, table_cap, table_used: 0, link_reg, link_next, link_cap, link_top: 0, link_free: NONE,
        links_live: 0, stamps, reg_cap, stamp: 0, querying: 0, busy: 0, scratch, epoch: 0, cache, _pad: [0; 2] };
    for i in 0..table_cap {
        *at(keys, i) = EMPTY;
    }
    for i in 0..reg_cap {
        *at(stamps, i) = 0;
    }
    clear_cache(cache, 0, reg_cap);
}
/// Cache entries [from, to) hold no epoch.
unsafe fn clear_cache(cache: u32, from: u32, to: u32) {
    for i in from..to {
        let c = (cache as usize as *mut Cached).add(i as usize);
        (*c).cylinder = 0;
        (*c).mover = 0;
        (*c).accept = 0;
    }
}

/// Move the cell table to larger arrays: the occupied cells are reinserted,
/// each keeping its list (a cell whose list emptied is dropped).
#[no_mangle]
pub unsafe extern "C" fn hash_rehash(h: u32, keys: u32, heads: u32, table_cap: u32) {
    let hd = &mut *(h as usize as *mut Header);
    let (old_keys, old_heads, old_cap) = (hd.keys, hd.heads, hd.table_cap);
    for i in 0..table_cap {
        *at(keys, i) = EMPTY;
    }
    hd.keys = keys;
    hd.heads = heads;
    hd.table_cap = table_cap;
    hd.table_used = 0;
    for i in 0..old_cap {
        let key = *at(old_keys, i);
        let head = *at(old_heads, i);
        if key != EMPTY && head != NONE {
            let slot = find_or_insert(hd, key);
            *at(hd.heads, slot) = head;
        }
    }
}

/// Move the links to larger arrays.
#[no_mangle]
pub unsafe extern "C" fn hash_links(h: u32, link_reg: u32, link_next: u32, link_cap: u32) {
    let hd = &mut *(h as usize as *mut Header);
    for i in 0..hd.link_top {
        *at(link_reg, i) = *at(hd.link_reg, i);
        *at(link_next, i) = *at(hd.link_next, i);
    }
    hd.link_reg = link_reg;
    hd.link_next = link_next;
    hd.link_cap = link_cap;
}

/// Move the per-registration arrays to larger ones (the scratch holds
/// nothing between queries; the scan cache starts empty).
#[no_mangle]
pub unsafe extern "C" fn hash_regs(h: u32, stamps: u32, scratch: u32, cache: u32, reg_cap: u32) {
    let hd = &mut *(h as usize as *mut Header);
    for i in 0..reg_cap {
        *at(stamps, i) = if i < hd.reg_cap { *at(hd.stamps, i) } else { 0 };
    }
    clear_cache(cache, 0, reg_cap);
    hd.stamps = stamps;
    hd.scratch = scratch;
    hd.cache = cache;
    hd.reg_cap = reg_cap;
}

/// AddActor's bucket writes (collision-hash.mjs `addActor`): X outer, Y,
/// Z inner, each cell's list gains `id` at its head.
#[no_mangle]
pub unsafe extern "C" fn hash_add(h: u32, id: u32, x0: i32, y0: i32, z0: i32, x1: i32, y1: i32, z1: i32) {
    let hd = &mut *(h as usize as *mut Header);
    for x in x0..=x1 {
        for y in y0..=y1 {
            for z in z0..=z1 {
                let slot = find_or_insert(hd, tag(x, y, z));
                let link = if hd.link_free != NONE {
                    let l = hd.link_free;
                    hd.link_free = *at(hd.link_next, l);
                    l
                } else {
                    let l = hd.link_top;
                    hd.link_top += 1;
                    l
                };
                *at(hd.link_reg, link) = id;
                *at(hd.link_next, link) = *at(hd.heads, slot);
                *at(hd.heads, slot) = link;
                hd.links_live += 1;
            }
        }
    }
}

/// RemoveActor's bucket writes (collision-hash.mjs `removeActor`): every
/// link of `id` in each cell is unlinked; the others keep their order.
#[no_mangle]
pub unsafe extern "C" fn hash_remove(h: u32, id: u32, x0: i32, y0: i32, z0: i32, x1: i32, y1: i32, z1: i32) {
    let hd = &mut *(h as usize as *mut Header);
    for x in x0..=x1 {
        for y in y0..=y1 {
            for z in z0..=z1 {
                let slot = find(hd, tag(x, y, z));
                if slot == NONE {
                    continue;
                }
                let mut previous = NONE;
                let mut link = *at(hd.heads, slot);
                while link != NONE {
                    let next = *at(hd.link_next, link);
                    if *at(hd.link_reg, link) == id {
                        if previous != NONE {
                            *at(hd.link_next, previous) = next;
                        } else {
                            *at(hd.heads, slot) = next;
                        }
                        *at(hd.link_next, link) = hd.link_free;
                        hd.link_free = link;
                        hd.links_live -= 1;
                    } else {
                        previous = link;
                    }
                    link = next;
                }
            }
        }
    }
}

/// A new query stamp; on wraparound every stamp is cleared.
unsafe fn next_stamp(hd: &mut Header) -> u32 {
    hd.stamp = hd.stamp.wrapping_add(1);
    if hd.stamp == 0 {
        for i in 0..hd.reg_cap {
            *at(hd.stamps, i) = 0;
        }
        hd.stamp = 1;
    }
    hd.stamp
}

/// The registrations a query over the cells visits, in its order (each
/// once, at its first link in X/Y/Z cell and list order): the order of the
/// reference's primitive callbacks (actorLineCheck, actorPointCheck,
/// actorEncroachmentCheck). Writes ids to `out`; returns the count.
#[no_mangle]
pub unsafe extern "C" fn hash_candidates(h: u32, x0: i32, y0: i32, z0: i32, x1: i32, y1: i32, z1: i32, out: u32) -> u32 {
    let hd = &mut *(h as usize as *mut Header);
    let stamp = next_stamp(hd);
    let mut n = 0;
    for x in x0..=x1 {
        for y in y0..=y1 {
            for z in z0..=z1 {
                let slot = find(hd, tag(x, y, z));
                if slot == NONE {
                    continue;
                }
                let mut link = *at(hd.heads, slot);
                while link != NONE {
                    let id = *at(hd.link_reg, link);
                    if *at(hd.stamps, id) != stamp {
                        *at(hd.stamps, id) = stamp;
                        *at(out, n) = id;
                        n += 1;
                    }
                    link = *at(hd.link_next, link);
                }
            }
        }
    }
    n
}

// ---------------------------------------------------------------------------
// Line-query cells: collision-hash.mjs collisionHashLineBounds.

/// Math.floor.
fn floor(v: f64) -> f64 {
    if !(abs(v) < 4_503_599_627_370_496.0) {
        return v;
    }
    let t = v as i64 as f64;
    let t = if t > v { t - 1.0 } else { t };
    // Math.floor(-0) is -0; a negative input rounding to zero cannot occur.
    if t == 0.0 && v.is_sign_negative() { -0.0 } else { t }
}
/// collision-hash.mjs `nearestEven`.
fn nearest_even(value: f64) -> f64 {
    let floor = floor(value);
    if value - floor < 0.5 {
        floor
    } else if value - floor > 0.5 {
        floor + 1.0
    } else {
        floor + if floor % 2.0 != 0.0 { 1.0 } else { 0.0 }
    }
}
/// collision-hash.mjs `roundedCell`: FISTP's integer indefinite outside
/// int32, then the 0..16383 clamp.
fn rounded_cell(scaled: f64) -> i32 {
    let mut rounded = nearest_even(scaled);
    if !(rounded - rounded == 0.0) || rounded < -2147483648.0 || rounded > 2147483647.0 {
        rounded = -2147483648.0;
    }
    js_max(0.0, js_min(16383.0, rounded)) as i32
}
/// collision-hash.mjs `cell`.
fn cell(value: f64) -> i32 {
    rounded_cell(f((value + 32768.0) / 256.0))
}

/// A signed dyadic `(-1)^neg * n * 2^e` (collision-hash.mjs `binary` pairs).
#[derive(Clone, Copy)]
struct Signed {
    neg: bool,
    n: u128,
    e: i32,
}
fn bit_length(n: u128) -> i32 {
    // `n.toString(2).length`: zero has one digit.
    if n == 0 { 1 } else { 128 - n.leading_zeros() as i32 }
}
/// collision-hash.mjs `binary`: a float32's significand and exponent.
fn binary(v: f64) -> Signed {
    let w = (v as f32).to_bits();
    let exponent = (w >> 23) & 255;
    Signed {
        neg: w >> 31 != 0,
        n: ((w & 0x7f_ffff) | if exponent != 0 { 0x80_0000 } else { 0 }) as u128,
        e: if exponent != 0 { exponent as i32 - 150 } else { -149 },
    }
}
/// collision-hash.mjs `roundedBinary`: nearest-even to `precision`
/// significant bits.
fn rounded_binary(a: Signed, precision: i32) -> Signed {
    let shift = bit_length(a.n) - precision;
    if shift <= 0 {
        return a;
    }
    let unit = 1u128 << shift;
    let half = unit >> 1;
    let mut kept = a.n >> shift;
    let remainder = a.n & (unit - 1);
    if remainder > half || (remainder == half && kept & 1 == 1) {
        kept += 1;
    }
    Signed { neg: a.neg, n: kept, e: a.e + shift }
}
/// collision-hash.mjs `addBinary`: the exact sum rounded to 64 significant
/// bits. The JavaScript's BigInt sum is exact at any exponent distance; here
/// both operands are aligned in a 126-bit window topped by the larger, and
/// bits of the smaller below it are jammed into its lowest bit. That bit
/// lies at least 60 places under the rounding position, so the rounded sum
/// (and whether it is a tie) is the exact sum's.
fn add_binary(a: Signed, b: Signed) -> Signed {
    if a.n == 0 {
        return rounded_binary(b, 64);
    }
    if b.n == 0 {
        return rounded_binary(a, 64);
    }
    let top = core::cmp::max(a.e + bit_length(a.n) - 1, b.e + bit_length(b.n) - 1);
    let base = top - 125;
    let align = |d: Signed| -> u128 {
        let shift = d.e - base;
        if shift >= 0 {
            d.n << shift
        } else if -shift >= 128 {
            1
        } else {
            let k = -shift;
            (d.n >> k) | (d.n & ((1u128 << k) - 1) != 0) as u128
        }
    };
    let (x, y) = (align(a), align(b));
    let (neg, n) = if a.neg == b.neg {
        (a.neg, x + y)
    } else if x >= y {
        (a.neg, x - y)
    } else {
        (b.neg, y - x)
    };
    if n == 0 {
        return Signed { neg: false, n: 0, e: base };
    }
    rounded_binary(Signed { neg, n, e: base }, 64)
}
/// `Error-free TwoSum`: the double sum when exact, else NaN.
fn exact_sum(a: f64, b: f64) -> f64 {
    let s = a + b;
    let bb = s - a;
    if (a - (s - bb)) + (b - bb) == 0.0 { s } else { f64::NAN }
}
/// collision-hash.mjs `expandedXCell`: X's two x87 adds keep a 64-bit
/// significand until the float store of (sum / 256).
fn expanded_x_cell(coordinate: f64, extent: f64, sign: f64) -> i32 {
    let sum = exact_sum(exact_sum(coordinate, sign * extent), 32768.0);
    if abs(sum) >= pow2(-100) && abs(sum) < pow2(100) {
        return rounded_cell(f(sum / 256.0));
    }
    let mut amount = binary(extent);
    if sign < 0.0 {
        amount.neg = !amount.neg;
    }
    let expanded = add_binary(add_binary(binary(coordinate), amount), binary(32768.0));
    let stored = rounded_binary(Signed { e: expanded.e - 8, ..expanded }, 24);
    let n = stored.n as f64;
    rounded_cell(f(if stored.neg && stored.n != 0 { -n } else { n } * pow2(stored.e)))
}

/// collisionHashLineBounds over already-stored start/end/extent:
/// [min x, y, z, max x, y, z].
fn line_cells(s: [f64; 3], e: [f64; 3], x: [f64; 3]) -> [i32; 6] {
    [
        expanded_x_cell(js_min(s[0], e[0]), x[0], -1.0),
        cell(f(js_min(s[1], e[1]) - x[1])),
        cell(f(js_min(s[2], e[2]) - x[2])),
        expanded_x_cell(js_max(s[0], e[0]), x[0], 1.0),
        cell(f(js_max(s[1], e[1]) + x[1])),
        cell(f(js_max(s[2], e[2]) + x[2])),
    ]
}

/// createCollisionHash's `check` in its seed-independent mode: false where
/// it throws (a cell above 255, or more than the default 1,000,000 cells).
fn cells_supported(c: &[i32; 6]) -> bool {
    if c.iter().any(|&v| v > 255) {
        return false;
    }
    let span = |a: i32, b: i32| js_max(0.0, (b - a + 1) as f64);
    span(c[0], c[3]) * span(c[1], c[4]) * span(c[2], c[5]) <= 1_000_000.0
}

// ---------------------------------------------------------------------------
// The cylinder: primitive-collision.mjs primitiveLineHit.

/// steps.mjs safeNormal.
fn safe_normal(v: [f64; 3]) -> [f64; 3] {
    let v = [f(v[0]), f(v[1]), f(v[2])];
    let squared = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if squared < 1e-8 {
        return [0.0; 3];
    }
    let s = 1.0 / sqrt(squared);
    [f(v[0] * s), f(v[1] * s), f(v[2] * s)]
}

fn primitive_line_hit(location: [f64; 3], radius: f64, height: f64, start: [f64; 3], end: [f64; 3], extent: [f64; 3]) -> Option<Hit> {
    let (sx, sy, sz) = (f(start[0]), f(start[1]), f(start[2]));
    let (tx, ty, tz) = (f(end[0]), f(end[1]), f(end[2]));
    let (lx, ly, lz) = (f(location[0]), f(location[1]), f(location[2]));
    let (r, z) = (f(radius), f(height));
    let rx = f(r + f(extent[0]));
    let ry = f(r + f(extent[1]));
    let rz = f(z + f(extent[2]));
    let top = f(lz + rz);
    let bottom = f(lz - rz);
    let (mut hi, mut lo) = (lx + rx, lx - rx);
    if sx > hi && tx > hi || sx < lo && tx < lo {
        return None;
    }
    hi = ly + ry;
    lo = ly - ry;
    if sy > hi && ty > hi || sy < lo && ty < lo {
        return None;
    }
    if sz > top && tz > top || sz < bottom && tz < bottom {
        return None;
    }
    let (mut enter, mut exit) = (0.0, 1.0);
    let (mut nx, mut ny, mut nz) = (0.0, 0.0, 0.0);
    if sz > top && tz < top {
        enter = f((top - sz) / (tz - sz));
        nz = 1.0;
    } else if sz < top && tz > top {
        exit = f((top - sz) / (tz - sz));
    }
    if sz < bottom && tz > bottom {
        let a = (bottom - sz) / (tz - sz);
        if a > enter {
            enter = f(a);
            nx = 0.0;
            ny = 0.0;
            nz = -1.0;
        }
    } else if sz > bottom && tz < bottom {
        exit = f(js_min(exit, (bottom - sz) / (tz - sz)));
    }
    if enter >= exit {
        return None;
    }
    let (dx, dy, x, y) = (tx - sx, ty - sy, sx - lx, sy - ly);
    let aa = f(dx * dx + dy * dy);
    let bb = f(2.0 * (dx * x + dy * y));
    let cc = f(x * x + y * y - rx * rx);
    let dd = f(bb * bb - 4.0 * cc * aa);
    if cc < 1.0 && sz > bottom && sz < top {
        if f(dx) * x + f(dy) * y >= -0.1 {
            return None;
        }
        return Some(Hit { time: 0.0, location: [sx, sy, sz], normal: safe_normal([f(x), f(y), 0.0]), kind: CYLINDER, ..NO_HIT });
    }
    if dd < 0.0 {
        return None;
    }
    if aa < 1e-8 {
        if cc > 0.0 {
            return None;
        }
    } else {
        let root = sqrt(dd);
        let inv = 0.5 / aa;
        exit = f(js_min(exit, (root - bb) * inv));
        let a = -(root + bb) * inv;
        if a > enter {
            enter = f(a);
            let px = f(f(f(f(dx) * a) + sx) - lx);
            let py = f(f(f(f(dy) * a) + sy) - ly);
            let sq = px * px + py * py;
            if sq >= 1e-8 {
                let length = sqrt(sq);
                nx = f(px / length);
                ny = f(py / length);
                nz = f(0.0 / length);
            } else {
                nx = px;
                ny = py;
                nz = 0.0;
            }
        }
        if enter >= exit {
            return None;
        }
    }
    let time = js_max(0.0, js_min(1.0, enter - 0.001));
    Some(Hit {
        time: f(time),
        location: [f(sx + f(f(dx) * time)), f(sy + f(f(dy) * time)), f(sz + f(tz - sz) * time)],
        normal: [nx, ny, nz],
        kind: CYLINDER,
        ..NO_HIT
    })
}

// ---------------------------------------------------------------------------
// MultiLineCheck: multiline.mjs.

/// multiline.mjs `compare`: x87's unordered comparison takes `<`'s branch.
#[inline(always)]
fn compare(a: f64, b: f64) -> i32 {
    if a < b || a != a || b != b {
        -1
    } else if a > b {
        1
    } else {
        0
    }
}

/// multiline.mjs `sortLineHits`: MSVCRT qsort (0x7802543d) on Time, with its
/// unstable ties, eight-entry cutoff and 44-byte partition comparison.
fn sort(hits: &mut [Hit]) {
    let n = hits.len() as i32;
    if n < 2 {
        return;
    }
    // Pending ranges are disjoint and hold two or more entries each.
    let mut storage = core::mem::MaybeUninit::<[(i32, i32); 128]>::uninit();
    let pending = storage.as_mut_ptr() as *mut (i32, i32);
    unsafe { pending.write((0, n - 1)) };
    let mut depth = 1;
    let t = |hits: &[Hit], i: i32| hits[i as usize].time;
    while depth != 0 {
        depth -= 1;
        let (low, high) = unsafe { *pending.add(depth) };
        let count = high - low + 1;
        if count < 2 {
            continue;
        }
        if count <= 8 {
            let mut end = high;
            while end > low {
                let mut maximum = low;
                for i in low + 1..=end {
                    if compare(t(hits, i), t(hits, maximum)) > 0 {
                        maximum = i;
                    }
                }
                hits.swap(maximum as usize, end as usize);
                end -= 1;
            }
            continue;
        }
        hits.swap(low as usize, (low + (count >> 1)) as usize);
        let (mut forward, mut backward) = (low, high + 1);
        loop {
            loop {
                forward += 1;
                if !(forward <= high && compare(t(hits, forward), t(hits, low)) <= 0) {
                    break;
                }
            }
            loop {
                backward -= 1;
                if !(backward > low && compare(t(hits, backward), t(hits, low)) >= 0) {
                    break;
                }
            }
            if backward < forward {
                break;
            }
            hits.swap(forward as usize, backward as usize);
        }
        hits.swap(low as usize, backward as usize);
        let (left, right) = ((low, backward - 1), (forward, high));
        let mut push = |range: (i32, i32)| {
            if range.0 < range.1 {
                unsafe { pending.add(depth).write(range) };
                depth += 1;
            }
        };
        if (backward - low) * 44 - 1 < (high - forward) * 44 {
            push(right);
            push(left);
        } else {
            push(left);
            push(right);
        }
    }
}

/// MultiLineCheck's world block: the world hit's actor, the clip factor and
/// the shortened end, and whether only movers join.
struct World {
    hit: Hit,
    factor: f64,
    only_movers: bool,
}
fn world_clip(world: &TraceHit, kind: u32, start: [f64; 3], end: &mut [f64; 3]) -> World {
    let w = Hit {
        time: world.time,
        location: world.location,
        normal: world.normal,
        node: world.node,
        actor: WORLD,
        kind,
        penetrating: world.penetrating as u32,
        _pad: 0,
    };
    let difference = [w.location[0] - start[0], w.location[1] - start[1], w.location[2] - start[2]];
    let d = sqrt(difference[0] * difference[0] + difference[1] * difference[1] + difference[2] * difference[2]);
    let factor = f(js_min(1.0, (d + 5.0) * w.time / (d + f(0.0001))));
    *end = [
        f(start[0] + f(f(end[0] - start[0]) * factor)),
        f(start[1] + f(f(end[1] - start[1]) * factor)),
        f(start[2] + (end[2] - start[2]) * factor),
    ];
    World { hit: w, factor, only_movers: w.time < 0.01 && d < 30.0 }
}

/// MultiLineCheck's join of the actor hits, in the reverse of their
/// collection order (the hash's final reversal), onto `hits` (which holds
/// the world hit, if any): the 64-hit cap, the movers-only rule, the mover
/// backoff and the clip factor. `mover` is isMover(actor).
/// `hits` has room for 64; the first `count` are set.
unsafe fn join(hits: *mut Hit, mut count: usize, actor_hits: *const Hit, n: usize, world: Option<&World>,
    start: [f64; 3], end: [f64; 3], mut mover: impl FnMut(u32) -> bool) -> usize {
    let factor = world.map_or(1.0, |w| w.factor);
    let only_movers = world.map_or(false, |w| w.only_movers);
    let mut i = n;
    while i != 0 {
        i -= 1;
        if count >= 64 {
            break;
        }
        let mut a = unsafe { *actor_hits.add(i) };
        let is_mover = mover(a.actor);
        if only_movers && !is_mover {
            continue;
        }
        if let Some(w) = world {
            let w = &w.hit;
            if is_mover && a.normal[0] == w.normal[0] && a.normal[1] == w.normal[1] && a.normal[2] == w.normal[2] {
                let separation = [a.location[0] - w.location[0], a.location[1] - w.location[1], a.location[2] - w.location[2]];
                if separation[0] * separation[0] + separation[1] * separation[1] + separation[2] * separation[2] < 4.0 {
                    let raw_x = end[0] - start[0];
                    let delta = [f(end[0] - start[0]), f(end[1] - start[1]), f(end[2] - start[2])];
                    // X is retained across its store for the first squared product.
                    let length = sqrt(raw_x * delta[0] + delta[1] * delta[1] + delta[2] * delta[2]);
                    let reciprocal = 1.0 / length;
                    let backoff = [f((reciprocal * delta[0]) * 2.0), f(f(reciprocal * delta[1]) * 2.0), f(f(reciprocal * delta[2]) * 2.0)];
                    a.location = [f(w.location[0] - backoff[0]), f(w.location[1] - backoff[1]), f(w.location[2] - backoff[2])];
                    let distance = [f(a.location[0] - start[0]), f(a.location[1] - start[1]), f(a.location[2] - start[2])];
                    a.time = f(sqrt(distance[2] * distance[2] + distance[1] * distance[1] + distance[0] * distance[0]) / f(length));
                }
            }
        }
        a.time = f(factor * a.time);
        hits.add(count).write(a);
        count += 1;
    }
    count
}

fn finite(v: &[f64; 3]) -> bool {
    v[0] - v[0] == 0.0 && v[1] - v[1] == 0.0 && v[2] - v[2] == 0.0
}
fn zero(v: &[f64; 3]) -> bool {
    v[0] == 0.0 && v[1] == 0.0 && v[2] == 0.0
}

/// level-queries.mjs `modelLineCheck` on a model at `ptr`: the ray for a
/// zero extent, else the box trace (a negative extent is a hand-back, where
/// traceExtent throws).
unsafe fn model_line_check(ptr: u32, start: [f64; 3], end: [f64; 3], extent: [f64; 3], extra: i32, owned: bool) -> Result<Option<(TraceHit, bool)>, ()> {
    if zero(&extent) {
        return Ok(trace::ray_hit(ptr, start, end, extra, owned)?.map(|h| (h, true)));
    }
    if extent[0] < 0.0 || extent[1] < 0.0 || extent[2] < 0.0 {
        return Err(());
    }
    Ok(trace::extent_hit(ptr, start, end, extent, owned)?.map(|h| (h, false)))
}

/// One query in flight: the hash, the level BSP (0: no world actor), and,
/// inside a walking-surface scan, the scan's cache epoch.
struct Query {
    hp: *mut Header,
    world: u32,
    /// Nonzero inside lc_scan: every import answer below is cached per
    /// registration for the rest of the call. Its imports only read (the
    /// reference's getters), so a repeated read would give the same answer.
    epoch: u32,
    /// The world hit's filter answer within a scan: 0 unknown, 1 no, 2 yes.
    world_accept: u32,
}

/// Per registration, a scan's cached import answers (the arena's `cache`
/// range, `reg_cap` entries).
#[derive(Clone, Copy)]
#[repr(C)]
struct Cached {
    cylinder: u32,
    mover: u32,
    is_mover: u32,
    accept: u32,
    accepted: u32,
    _pad: [u32; 3],
    geometry: [f64; 5],
    _pad2: [f64; 1],
}
const _: () = assert!(core::mem::size_of::<Cached>() == 80);

impl Query {
    /// The registration's cache entry (read from the header at each use: an
    /// import may have moved the range, whose old copy the host keeps until
    /// the call returns).
    unsafe fn cached(&self, id: u32) -> *mut Cached {
        (core::ptr::read_volatile(addr_of_mut!((*self.hp).cache)) as usize as *mut Cached).add(id as usize)
    }
    /// lc_candidate, or a cylinder cached earlier in this scan. Returns the
    /// kind and the geometry (a brush's model address in [5]).
    unsafe fn candidate(&self, id: u32) -> (i32, [f64; 6]) {
        if self.epoch != 0 {
            let c = self.cached(id);
            if (*c).cylinder == self.epoch {
                let g = (*c).geometry;
                return (C_CYLINDER, [g[0], g[1], g[2], g[3], g[4], 0.0]);
            }
        }
        let kind = lc_candidate(id);
        let cand = addr_of_mut!(CAND) as *const f64;
        let geometry = [*cand, *cand.add(1), *cand.add(2), *cand.add(3), *cand.add(4), *cand.add(5)];
        // A brush's ToWorld is in OWNER for this trace only: brushes are
        // read again at every visit.
        if self.epoch != 0 && kind == C_CYLINDER {
            let c = self.cached(id);
            (*c).cylinder = self.epoch;
            (*c).geometry = [geometry[0], geometry[1], geometry[2], geometry[3], geometry[4]];
        }
        (kind, geometry)
    }
    unsafe fn mover(&self, id: u32) -> bool {
        if self.epoch != 0 {
            let c = self.cached(id);
            if (*c).mover == self.epoch {
                return (*c).is_mover != 0;
            }
        }
        let is_mover = lc_mover(id) != 0;
        if self.epoch != 0 {
            let c = self.cached(id);
            (*c).mover = self.epoch;
            (*c).is_mover = is_mover as u32;
        }
        is_mover
    }
    unsafe fn accept(&mut self, id: u32) -> bool {
        if id == WORLD {
            if self.world_accept == 0 || self.epoch == 0 {
                self.world_accept = if lc_accept(id) != 0 { 2 } else { 1 };
            }
            return self.world_accept == 2;
        }
        if self.epoch != 0 {
            let c = self.cached(id);
            if (*c).accept == self.epoch {
                return (*c).accepted != 0;
            }
        }
        let accepted = lc_accept(id) != 0;
        if self.epoch != 0 {
            let c = self.cached(id);
            (*c).accept = self.epoch;
            (*c).accepted = accepted as u32;
        }
        accepted
    }
}

/// The hash's actor query (actorLineCheck with level-queries.mjs's
/// primitive callback): each visited registration's primitive, hits
/// collected into the scratch in visit order. Err is a hand-back.
unsafe fn actor_hits(q: &Query, start: [f64; 3], end: [f64; 3], extent: [f64; 3], extra: i32) -> Result<usize, ()> {
    let hp = q.hp;
    // vector(): the (shortened) end must still be finite.
    if !finite(&end) {
        return Err(());
    }
    let c = line_cells(start, end, extent);
    if !cells_supported(&c) {
        return Err(());
    }
    let stamp = next_stamp(&mut *hp);
    // While `querying` is set the host refuses every hash change, so the
    // table, links and stamps stay put across the imports; the header is
    // still only reached through `hp` (no reference lives across an import).
    let hd = &*hp;
    let scratch = hd.scratch as usize as *mut Hit;
    let mut n = 0;
    set_flag(addr_of_mut!((*hp).querying), 1);
    for x in c[0]..=c[3] {
        for y in c[1]..=c[4] {
            for z in c[2]..=c[5] {
                let slot = find(hd, tag(x, y, z));
                if slot == NONE {
                    continue;
                }
                let mut link = *at(hd.heads, slot);
                while link != NONE {
                    let id = *at(hd.link_reg, link);
                    link = *at(hd.link_next, link);
                    if *at(hd.stamps, id) == stamp {
                        continue;
                    }
                    *at(hd.stamps, id) = stamp;
                    let (kind, g) = q.candidate(id);
                    let hit = match kind {
                        C_CYLINDER => primitive_line_hit([g[0], g[1], g[2]], g[3], g[4], start, end, extent),
                        C_BRUSH_OWNED | C_BRUSH => {
                            match model_line_check(g[5] as u32, start, end, extent, extra, kind == C_BRUSH_OWNED) {
                                Err(()) => {
                                    set_flag(addr_of_mut!((*hp).querying), 0);
                                    return Err(());
                                }
                                Ok(None) => None,
                                Ok(Some((t, ray))) => Some(Hit {
                                    time: t.time,
                                    location: t.location,
                                    normal: t.normal,
                                    node: t.node,
                                    kind: if ray { BRUSH_RAY } else { BRUSH_EXTENT },
                                    penetrating: t.penetrating as u32,
                                    ..NO_HIT
                                }),
                            }
                        }
                        _ => {
                            set_flag(addr_of_mut!((*hp).querying), 0);
                            return Err(());
                        }
                    };
                    if let Some(mut hit) = hit {
                        hit.actor = id;
                        *scratch.add(n) = hit;
                        n += 1;
                    }
                }
            }
        }
    }
    set_flag(addr_of_mut!((*hp).querying), 0);
    Ok(n)
}

/// The `querying` and `busy` words, which the host reads and writes during
/// the imports.
#[inline(always)]
unsafe fn set_flag(word: *mut u32, value: u32) {
    core::ptr::write_volatile(word, value);
}
#[inline(always)]
unsafe fn flag(word: *mut u32) -> u32 {
    core::ptr::read_volatile(word)
}

unsafe fn write_record(out: *mut f64, h: &Hit) {
    let values = [
        h.time, h.location[0], h.location[1], h.location[2], h.normal[0], h.normal[1], h.normal[2], h.node,
        h.penetrating as f64, if h.actor == WORLD { -1.0 } else { h.actor as f64 }, h.kind as f64,
    ];
    for (i, v) in values.iter().enumerate() {
        *out.add(i) = *v;
    }
}

/// ULevel::MultiLineCheck (multiline.mjs `multiLineCheck` over
/// level-queries.mjs's `join`): the world trace and clip, the hash query,
/// the join and the qsort, into `hits` (room for 64). Returns the count, or
/// Err to hand the query back. The inputs are the raw JavaScript numbers.
unsafe fn multi_line(q: &Query, start: [f64; 3], end: [f64; 3], extent: [f64; 3], extra: i32, check_actors: bool,
    hits: *mut Hit) -> Result<usize, ()> {
    let start = [f(start[0]), f(start[1]), f(start[2])];
    let mut end = [f(end[0]), f(end[1]), f(end[2])];
    let extent = [f(extent[0]), f(extent[1]), f(extent[2])];
    if !finite(&start) || !finite(&end) || !finite(&extent) {
        return Err(());
    }
    let mut count = 0;
    let mut clip = None;
    if q.world != 0 {
        if let Some((t, ray)) = model_line_check(q.world, start, end, extent, extra & 0xff, false)? {
            let w = world_clip(&t, if ray { WORLD_RAY } else { WORLD_EXTENT }, start, &mut end);
            hits.write(w.hit);
            count = 1;
            clip = Some(w);
        }
    }
    if check_actors {
        let n = actor_hits(q, start, end, extent, extra & 255)?;
        // The scratch as it is now: an isMover callback may register actors
        // and so move it, and the host keeps the old range until this returns.
        let scratch = core::ptr::read_volatile(addr_of_mut!((*q.hp).scratch)) as usize as *const Hit;
        count = join(hits, count, scratch, n, clip.as_ref(), start, end, |id| q.mover(id));
    }
    sort(core::slice::from_raw_parts_mut(hits, count));
    Ok(count)
}

/// ULevel::SingleLineCheck (line-filter.mjs): the first of the sorted hits
/// the filter (lc_accept) takes, as its index, or `count`.
unsafe fn single_line(q: &mut Query, hits: *const Hit, count: usize) -> usize {
    for i in 0..count {
        if q.accept((*hits.add(i)).actor) {
            return i;
        }
    }
    count
}

/// The busy word's claim for one call; nested or query-time calls hand back.
unsafe fn claim(h: u32) -> Option<*mut Header> {
    let hp = h as usize as *mut Header;
    if flag(addr_of_mut!((*hp).busy)) != 0 || flag(addr_of_mut!((*hp).querying)) != 0 {
        return None;
    }
    set_flag(addr_of_mut!((*hp).busy), 1);
    Some(hp)
}

/// ULevel::MultiLineCheck (multi) or SingleLineCheck (single) through the
/// hash `h`, on the level BSP at `world` (0: no world actor). The inputs are
/// the raw JavaScript numbers; `flags`' filter runs in lc_accept. ANSWER
/// receives the hits in sorted order (multi) or, from SingleLineCheck's
/// accepted hit on, the rest of that list (count 0 when none is accepted).
/// FALLBACK hands the whole query back: the reference would throw or fall
/// back itself there, or this call is nested inside another query.
#[no_mangle]
pub unsafe extern "C" fn lc_line(h: u32, world: u32, sx: f64, sy: f64, sz: f64, ex: f64, ey: f64, ez: f64,
    xx: f64, xy: f64, xz: f64, extra: i32, check_actors: i32, single: i32) -> i32 {
    let Some(hp) = claim(h) else { return FALLBACK };
    let mut q = Query { hp, world, epoch: 0, world_accept: 0 };
    // The joined hits: at most 64, written before they are read.
    let mut storage = core::mem::MaybeUninit::<[Hit; 64]>::uninit();
    let hits = storage.as_mut_ptr() as *mut Hit;
    let count = match multi_line(&q, [sx, sy, sz], [ex, ey, ez], [xx, xy, xz], extra, check_actors != 0, hits) {
        Ok(count) => count,
        Err(()) => {
            set_flag(addr_of_mut!((*hp).busy), 0);
            return FALLBACK;
        }
    };
    let first = if single != 0 { single_line(&mut q, hits, count) } else { 0 };
    let answer = addr_of_mut!(ANSWER) as *mut f64;
    *answer = (count - first) as f64;
    *answer.add(1) = first as f64;
    for i in first..count {
        write_record(answer.add(2 + RECORD * (i - first)), &*hits.add(i));
    }
    set_flag(addr_of_mut!((*hp).busy), 0);
    ANSWERED
}

/// A scan answer record: the accepted hit, or a miss (actor -2: the
/// lineCheck result's time 1, no actor, zero vectors).
unsafe fn write_single(out: *mut f64, hits: *const Hit, count: usize, accepted: usize) {
    if accepted == count {
        write_record(out, &Hit { time: 1.0, actor: 0, ..NO_HIT });
        *out.add(9) = -2.0;
    } else {
        write_record(out, &*hits.add(accepted));
    }
}

/// walking-surface.mjs `walkingSurfacePrelude`'s queries in one call, for a
/// pawn whose lineCheck is this level's (flags 6, source the pawn) and whose
/// textureForHit is the world surface table `table` (one byte per BSP node
/// of the traced level: bit 0 when the node's texture stops the scan, its
/// outerName null or 'Ladder'; bit 1 when the prelude takes the ladder
/// branch on it, where the floor is not queried; actor hits have no
/// texture). The 4 x 9 scan segments from `start` to (end x, end y, start
/// z + 0, 4, .. 32) run until one stops it, then, unless the last one's
/// texture takes the ladder branch, the floor segment. ANSWER: [index of the
/// last scan segment run, whether the floor was queried], the last scan
/// record, then the floor's. FALLBACK as lc_line.
#[no_mangle]
pub unsafe extern "C" fn lc_scan(h: u32, world: u32, table: u32, sx: f64, sy: f64, sz: f64,
    x0: f64, y0: f64, x1: f64, y1: f64, x2: f64, y2: f64, x3: f64, y3: f64, px: f64, py: f64, pz: f64, fz: f64) -> i32 {
    let Some(hp) = claim(h) else { return FALLBACK };
    let hd = &mut *hp;
    hd.epoch = hd.epoch.wrapping_add(1);
    if hd.epoch == 0 {
        for i in 0..hd.reg_cap {
            let c = (hd.cache as usize as *mut Cached).add(i as usize);
            (*c).cylinder = 0;
            (*c).mover = 0;
            (*c).accept = 0;
        }
        hd.epoch = 1;
    }
    let mut q = Query { hp, world, epoch: hd.epoch, world_accept: 0 };
    let mut storage = core::mem::MaybeUninit::<[Hit; 64]>::uninit();
    let hits = storage.as_mut_ptr() as *mut Hit;
    let answer = addr_of_mut!(ANSWER) as *mut f64;
    let start = [f(sx), f(sy), f(sz)];
    let ends = [[x0, y0], [x1, y1], [x2, y2], [x3, y3]];
    let zero = [0.0; 3];
    let mut index = 0;
    let mut ladder = false;
    'scan: for (d, e) in ends.iter().enumerate() {
        let mut z = 0.0;
        while z <= 32.0 {
            let count = match multi_line(&q, start, [e[0], e[1], f(start[2] + z)], zero, 0, true, hits) {
                Ok(count) => count,
                Err(()) => {
                    set_flag(addr_of_mut!((*hp).busy), 0);
                    return FALLBACK;
                }
            };
            let accepted = single_line(&mut q, hits, count);
            write_single(answer.add(2), hits, count, accepted);
            index = d * 9 + (z as usize >> 2);
            ladder = false;
            if accepted != count {
                let hit = &*hits.add(accepted);
                if hit.actor == WORLD {
                    let texture = *(table as usize as *const u8).add(hit.node as usize);
                    ladder = texture & 2 != 0;
                    if texture & 1 != 0 {
                        break 'scan;
                    }
                }
            }
            z += 4.0;
        }
    }
    if !ladder {
        let count = match multi_line(&q, [px, py, pz], [px, py, fz], zero, 0, true, hits) {
            Ok(count) => count,
            Err(()) => {
                set_flag(addr_of_mut!((*hp).busy), 0);
                return FALLBACK;
            }
        };
        let accepted = single_line(&mut q, hits, count);
        write_single(answer.add(2 + RECORD), hits, count, accepted);
    }
    *answer = index as f64;
    *answer.add(1) = (!ladder) as i32 as f64;
    set_flag(addr_of_mut!((*hp).busy), 0);
    ANSWERED
}

// ---------------------------------------------------------------------------
// Validator entries (scripts/validate-collision-kernel.mjs): the pieces
// above on supplied inputs, through TEST.

/// line_cells, into TEST[0..6].
#[no_mangle]
pub unsafe extern "C" fn lc_test_cells(sx: f64, sy: f64, sz: f64, ex: f64, ey: f64, ez: f64, xx: f64, xy: f64, xz: f64) {
    let c = line_cells([sx, sy, sz], [ex, ey, ez], [xx, xy, xz]);
    let t = addr_of_mut!(TEST) as *mut f64;
    for i in 0..6 {
        *t.add(i) = c[i] as f64;
    }
    *t.add(6) = cells_supported(&c) as i32 as f64;
}
/// cell(value) (collisionHashCell's conversion).
#[no_mangle]
pub extern "C" fn lc_test_cell(value: f64) -> i32 {
    cell(value)
}
/// primitive_line_hit: 1 and a record in TEST[2..], or 0.
#[no_mangle]
pub unsafe extern "C" fn lc_test_primitive(lx: f64, ly: f64, lz: f64, r: f64, h: f64, sx: f64, sy: f64, sz: f64,
    ex: f64, ey: f64, ez: f64, xx: f64, xy: f64, xz: f64) -> i32 {
    match primitive_line_hit([lx, ly, lz], r, h, [sx, sy, sz], [ex, ey, ez], [xx, xy, xz]) {
        Some(hit) => {
            write_record((addr_of_mut!(TEST) as *mut f64).add(2), &hit);
            1
        }
        None => 0,
    }
}
/// sort over TEST's `n` records (their `actor` fields carry the caller's
/// indices).
#[no_mangle]
pub unsafe extern "C" fn lc_test_sort(n: u32) {
    let t = addr_of_mut!(TEST) as *mut f64;
    let mut hits = [NO_HIT; 256];
    let n = (n as usize).min(256);
    for (i, hit) in hits[..n].iter_mut().enumerate() {
        hit.time = *t.add(2 + RECORD * i);
        hit.actor = i as u32;
    }
    sort(&mut hits[..n]);
    for (i, hit) in hits[..n].iter().enumerate() {
        *t.add(2 + RECORD * i) = hit.actor as f64;
    }
}
/// world_clip + join + sort over supplied hits: TEST[2..] holds the world
/// hit (if `world`), then `n` actor hits in collection order, each record's
/// `penetrating` field the isMover answer. Writes the joined, sorted records
/// back from TEST[2..]; returns their count.
#[no_mangle]
pub unsafe extern "C" fn lc_test_join(world: i32, n: u32, sx: f64, sy: f64, sz: f64, ex: f64, ey: f64, ez: f64) -> u32 {
    let t = addr_of_mut!(TEST) as *mut f64;
    let read = |i: usize| -> Hit {
        let r = t.add(2 + RECORD * i);
        Hit {
            time: *r,
            location: [*r.add(1), *r.add(2), *r.add(3)],
            normal: [*r.add(4), *r.add(5), *r.add(6)],
            node: *r.add(7),
            penetrating: *r.add(8) as u32,
            actor: if *r.add(9) < 0.0 { WORLD } else { *r.add(9) as u32 },
            kind: *r.add(10) as u32,
            _pad: 0,
        }
    };
    let start = [f(sx), f(sy), f(sz)];
    let mut end = [f(ex), f(ey), f(ez)];
    let mut hits = [NO_HIT; 64];
    let mut count = 0;
    let mut clip = None;
    let offset = if world != 0 { 1 } else { 0 };
    if world != 0 {
        let w = read(0);
        let trace_hit = TraceHit { time: w.time, normal: w.normal, location: w.location, node: w.node, penetrating: w.penetrating != 0 };
        let c = world_clip(&trace_hit, w.kind, start, &mut end);
        hits[0] = c.hit;
        count = 1;
        clip = Some(c);
    }
    let mut actors = [NO_HIT; 192];
    let n = (n as usize).min(192);
    let mut movers = [false; 192];
    for i in 0..n {
        actors[i] = read(offset + i);
        movers[i] = actors[i].penetrating != 0;
        actors[i].actor = i as u32;
    }
    count = join(hits.as_mut_ptr(), count, actors.as_ptr(), n, clip.as_ref(), start, end, |id| movers[id as usize]);
    sort(&mut hits[..count]);
    for (i, hit) in hits[..count].iter().enumerate() {
        write_record(t.add(2 + RECORD * i), hit);
    }
    count as u32
}
