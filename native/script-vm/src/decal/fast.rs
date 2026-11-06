//! Exact fast paths for FindSurface (0x103e9090) and GatherNodes
//! (0x103e9340): the same decisions as `find_surface` and `gather_nodes` in
//! decal.rs, which stay as the reference (`DECAL_FAST=off`) and run beside
//! these in `verify`.
//!
//! What the two functions decide from their floating-point arithmetic is
//! only signs. FindSurface keeps `side = d2 - d1` per polygon vertex and
//! compares it, and the previous vertex's `side` stored as an f32, with zero;
//! GatherNodes compares each clipped point's stored distance with zero (its
//! f32 value goes nowhere else). Two things are exact here.
//!
//! 1. **The per-edge plane is a pure function of three vectors.** The cross
//!    product `cx, cy, cz` of an edge with the surface normal and its dot
//!    product with the vertex (`d1`, stored as `w` in GatherNodes) depend on
//!    the vertex, the previous vertex and the normal alone: nine f32 words.
//!    They are computed by the reference's own x87 expressions and kept in a
//!    direct-mapped table keyed on those nine words (a hit means the words
//!    are equal, so the result is the one the expressions give; a model that
//!    changes under the tracker simply misses).
//! 2. **A sign is decided in f64 when it is far from zero.** Let `Y` be the
//!    exact real value of the expression and `Q` the sum of the magnitudes of
//!    its terms. Every product of two f32 values is exact in f64 (48 bits),
//!    and `cx` and `d1` are rounded to f64 once when the table entry is made.
//!    The f64 evaluation `X` of the same sum has `|X - Y| <= 4 * 2^-53 * Q`
//!    (each of at most six operations, and the two roundings of `cx` and
//!    `d1`, contributes at most 2^-53 of one term). The x87 evaluation at
//!    64-bit precision has `|S - Y| <= 3.01 * 2^-64 * Q` (three roundings of
//!    at most 2^-64 relative each, FSUB and FADD alike; a sum's rounding
//!    never flips its sign and the model's exponent range is unbounded).
//!    When `|X| > 2^-44 * Q` the two errors together stay under `|Y|`, so
//!    `sign(S) = sign(Y) = sign(X)`. A magnitude of at least 1e-30 also keeps
//!    the f32 store (`prev_side`, the distances) from underflowing to zero
//!    or denormal, so the stored value has the same sign as `S`. Everything
//!    else (a NaN or infinity anywhere, a result near zero, a value outside
//!    the table's exponent window) falls back to the reference expression.
//!
//! The table and the filter apply at 64-bit precision control only; at 24
//! (the render pass) the reference runs. `verify` recomputes every table hit
//! and every filtered sign with the x87 expressions and reports a difference
//! as FAULT_VERIFY.

use super::*;

/// IO[16]: 0 runs these, 1 the reference alone, 2 both with a comparison.
const IO_MODE: usize = 16;
const MODE_FAST: u32 = 0;
const MODE_REF: u32 = 1;
const MODE_VERIFY: u32 = 2;

/// A fast path and the reference disagreed (verify mode).
pub(super) const FAULT_VERIFY: u32 = 8;

const BELOW: i8 = -1;
const EQUAL: i8 = 0;
const ABOVE: i8 = 1;

/// FCOM against zero: `below` also holds for unordered, `above` is strict.
fn class(x: Ext) -> i8 {
    let (c0, c3) = x.compare(Ext::zero(0));
    if c0 {
        BELOW
    } else if c3 {
        EQUAL
    } else {
        ABOVE
    }
}

/// The path this call takes: 0 fast, 1 reference, 2 verify.
static mut MODE: u32 = MODE_FAST;
/// Hits and misses of the edge table, and the signs the filter could not
/// decide, for the telemetry words.
static mut STAT: [u32; 4] = [0; 4];

pub(super) fn begin() {
    unsafe {
        let mode = io(IO_MODE);
        // The reference answers at any precision but 64.
        MODE = if mode > MODE_VERIFY || crate::x87::precision() != 64 { MODE_REF } else { mode };
    }
}
fn mode() -> u32 {
    unsafe { MODE }
}
fn stat(i: usize) {
    unsafe { (*addr_of_mut!(STAT))[i] += 1 }
}
/// Table hits, misses, undecided vertex signs, undecided distance signs
/// since the module was instantiated.
#[no_mangle]
pub extern "C" fn decal_fast_stats(i: u32) -> u32 {
    unsafe { (*addr_of!(STAT)).get(i as usize).copied().unwrap_or(0) }
}

// ---- the edge table ----------------------------------------------------------

/// Entries of the table every instance has before the host gives it a larger one (decal_fast_table).
const SMALL: usize = 256;

#[derive(Clone, Copy)]
#[repr(C)]
struct Entry {
    key: [u32; 9],
    valid: bool,
    /// find_surface's cx and d1 rounded to f64 are usable.
    sure_find: bool,
    /// cxf and w are finite.
    sure_gather: bool,
    cy: u32,
    cz: u32,
    cxf: u32,
    w: u32,
    cx_d: f64,
    d1_d: f64,
}

const EMPTY: Entry = Entry {
    key: [0; 9],
    valid: false,
    sure_find: false,
    sure_gather: false,
    cy: 0,
    cz: 0,
    cxf: 0,
    w: 0,
    cx_d: 0.0,
    d1_d: 0.0,
};

static mut SMALL_TABLE: [Entry; SMALL] = [EMPTY; SMALL];
/// The host's table (zeroed memory of `entries` Entry records, a power of two) and its index mask.
static mut BIG: usize = 0;
static mut BIG_MASK: usize = 0;

/// Bytes of one table entry, for the host to size the table.
#[no_mangle]
pub extern "C" fn decal_fast_entry_bytes() -> u32 {
    core::mem::size_of::<Entry>() as u32
}

/// Use `entries` (a power of two) zeroed entries at `at` instead of the small static table. The memory must stay
/// allocated and untouched by the host for the instance's life.
#[no_mangle]
pub extern "C" fn decal_fast_table(at: u32, entries: u32) {
    unsafe {
        if at == 0 || entries == 0 || entries & (entries - 1) != 0 || at % core::mem::align_of::<Entry>() as u32 != 0 {
            BIG = 0;
            BIG_MASK = 0;
        } else {
            BIG = at as usize;
            BIG_MASK = entries as usize - 1;
        }
    }
}

unsafe fn slot(i: u32) -> &'static mut Entry {
    if BIG != 0 {
        &mut *(BIG as *mut Entry).add(i as usize & BIG_MASK)
    } else {
        &mut (*addr_of_mut!(SMALL_TABLE))[i as usize & (SMALL - 1)]
    }
}

fn f(bits: u32) -> f64 {
    f32::from_bits(bits) as f64
}

/// An Ext as the nearest f64 (sig as f64 rounds to nearest even; the power
/// of two is exact), or None outside the window the filter's error bound
/// assumes, for a NaN or an infinity.
fn ext_f64(x: Ext) -> Option<f64> {
    if x.special != 0 {
        return None;
    }
    if x.sig == 0 {
        return Some(0.0);
    }
    if x.exp < -250 || x.exp > 150 {
        return None;
    }
    let scale = f64::from_bits(((x.exp + 1023) as u64) << 52);
    let v = x.sig as f64 * scale;
    Some(if x.sign != 0 { -v } else { v })
}

/// The reference's per-edge values (decal.rs find_surface and
/// gather_nodes, the same expressions): cy and cz stored, cx and d1 not.
fn edge_ref(cur: V, prev: V, n: V) -> (u32, u32, Ext, Ext) {
    let ez = sub(ld(cur[2]), ld(prev[2]));
    let ey = sub(ld(cur[1]), ld(prev[1]));
    let ex = sub(ld(cur[0]), ld(prev[0]));
    let cz = sub(ey.mul(ld(n[0])), ex.mul(ld(n[1]))).store();
    let cy = sub(ex.mul(ld(n[2])), ez.mul(ld(n[0]))).store();
    let cx = sub(ez.mul(ld(n[1])), ey.mul(ld(n[2])));
    let d1 = ld(cur[1]).mul(ld(cy)).add(ld(cur[2]).mul(ld(cz))).add(ld(cur[0]).mul(cx));
    (cy, cz, cx, d1)
}

fn make(key: [u32; 9]) -> Entry {
    let (cy, cz, cx, d1) = edge_ref([key[0], key[1], key[2]], [key[3], key[4], key[5]], [key[6], key[7], key[8]]);
    let (cxf, w) = (cx.store(), d1.store());
    let (cx_d, d1_d) = (ext_f64(cx), ext_f64(d1));
    let finite = |b: u32| f32::from_bits(b).is_finite();
    Entry {
        key,
        valid: true,
        sure_find: cx_d.is_some() && d1_d.is_some() && finite(cy) && finite(cz),
        sure_gather: finite(cy) && finite(cz) && finite(cxf) && finite(w),
        cy,
        cz,
        cxf,
        w,
        cx_d: cx_d.unwrap_or(0.0),
        d1_d: d1_d.unwrap_or(0.0),
    }
}

/// The entry for the edge `prev -> cur` of a polygon on normal `n`; `index`
/// (the vertex's place in the vertex pool) picks its slot.
unsafe fn edge(cur: V, prev: V, n: V, index: u32) -> &'static Entry {
    let key = [cur[0], cur[1], cur[2], prev[0], prev[1], prev[2], n[0], n[1], n[2]];
    let e = slot(index);
    if e.valid && e.key == key {
        stat(0);
        if mode() == MODE_VERIFY {
            let fresh = make(key);
            if fresh.cy != e.cy || fresh.cz != e.cz || fresh.cxf != e.cxf || fresh.w != e.w
                || fresh.cx_d.to_bits() != e.cx_d.to_bits() || fresh.d1_d.to_bits() != e.d1_d.to_bits()
                || fresh.sure_find != e.sure_find || fresh.sure_gather != e.sure_gather {
                VERIFY_FAILED = true;
            }
        }
        return e;
    }
    stat(1);
    *e = make(key);
    e
}

static mut VERIFY_FAILED: bool = false;

/// The sign tests below decide when the f64 value is this far from zero
/// relative to the magnitude of its terms (2^-44; the error bound is
/// 4 * 2^-53 + 3.01 * 2^-64 of it) and above the f32 underflow range.
const MARGIN: f64 = 1.0 / 17592186044416.0;
const FLOOR: f64 = 1e-30;

fn decided(x: f64, q: f64) -> Option<i8> {
    let a = x.abs();
    // Comparisons with NaN are false: a NaN or an infinity never decides.
    if a > q * MARGIN && a > FLOOR && q.is_finite() {
        Some(if x > 0.0 { ABOVE } else { BELOW })
    } else {
        None
    }
}

// ---- FindSurface ---------------------------------------------------------------

/// FindSurface's `side` of point `p` against the edge `prev -> cur`: the
/// class of the value and of its f32 store (`prev_side` of the next vertex).
fn side_ref(cur: V, prev: V, n: V, p: V) -> (i8, i8) {
    let (cy, cz, cx, d1) = edge_ref(cur, prev, n);
    let d2 = ld(p[1]).mul(ld(cy)).add(ld(p[2]).mul(ld(cz))).add(ld(p[0]).mul(cx));
    let side = sub(d2, d1);
    (class(side), class(side.stored()))
}

unsafe fn side(e: &Entry, cur: V, prev: V, n: V, p: V) -> (i8, i8) {
    if e.sure_find {
        let t1 = f(p[1]) * f(e.cy);
        let t2 = f(p[2]) * f(e.cz);
        let t3 = f(p[0]) * e.cx_d;
        let x = ((t1 + t2) + t3) - e.d1_d;
        let q = t1.abs() + t2.abs() + t3.abs() + e.d1_d.abs();
        if let Some(c) = decided(x, q) {
            if mode() == MODE_VERIFY && side_ref(cur, prev, n, p) != (c, c) {
                VERIFY_FAILED = true;
            }
            return (c, c);
        }
    }
    stat(2);
    side_ref(cur, prev, n, p)
}

pub(super) unsafe fn find_surface(m: &Model, mut node: i32, p: V) -> Result<i32, u32> {
    let mut guard = 0u32;
    'chain: loop {
        if node == -1 {
            return Ok(-1);
        }
        guard += 1;
        if guard > m.node_count + 1 {
            return Err(FAULT_MODEL);
        }
        let nd = m.node(node)?;
        if nd.count == 0 {
            node = nd.plane;
            continue;
        }
        let n = m.vector(m.surf(nd.surf)?.normal)?;
        let mut prev = m.vert_point(nd.pool + nd.count - 1)?;
        let mut prev_class = EQUAL;
        for k in 0..nd.count {
            let cur = m.vert_point(nd.pool + k)?;
            let e = edge(cur, prev, n, nd.pool + k);
            let (now, stored) = side(e, cur, prev, n, p);
            if (now == BELOW && prev_class == ABOVE) || (now == ABOVE && prev_class == BELOW) {
                node = nd.plane;
                continue 'chain;
            }
            prev_class = stored;
            prev = cur;
        }
        return Ok(nd.surf as i32);
    }
}

// ---- GatherNodes -----------------------------------------------------------------

/// The reference's stored distance class of point `q` to the edge plane.
fn dist_ref(e: &Entry, q: V) -> i8 {
    let plane = ld(e.cz).mul(ld(q[2])).add(ld(e.cy).mul(ld(q[1]))).add(ld(e.cxf).mul(ld(q[0])));
    class(ld(sub(plane, ld(e.w)).store()))
}

unsafe fn dist(e: &Entry, q: V) -> i8 {
    if e.sure_gather {
        let t1 = f(e.cz) * f(q[2]);
        let t2 = f(e.cy) * f(q[1]);
        let t3 = f(e.cxf) * f(q[0]);
        let w = f(e.w);
        let x = ((t1 + t2) + t3) - w;
        let c = t1.abs() + t2.abs() + t3.abs() + w.abs();
        if let Some(c) = decided(x, c) {
            if mode() == MODE_VERIFY && dist_ref(e, q) != c {
                VERIFY_FAILED = true;
            }
            return c;
        }
    }
    stat(3);
    dist_ref(e, q)
}

pub(super) unsafe fn gather_nodes(m: &Model, surf: &Surf, verts: &[V; 4], out: &mut [u32; MAX_NODES]) -> Result<usize, u32> {
    let n = m.vector(surf.normal)?;
    let mut found = 0usize;
    for i in 0..surf.node_count {
        let index = m.surf_node(surf.nodes + i)?;
        let nd = m.node(index)?;
        if nd.count == 0 {
            continue;
        }
        let mut buf: [V; 25] = [[0; 3]; 25];
        let mut cls: [i8; 25] = [EQUAL; 25];
        buf[..4].copy_from_slice(verts);
        let mut count = 4usize;
        let mut prev = m.vert_point(nd.pool + nd.count - 1)?;
        let mut rejected = false;
        for k in 0..nd.count {
            let cur = m.vert_point(nd.pool + k)?;
            let e = edge(cur, prev, n, nd.pool + k);
            for j in 0..count {
                cls[j] = dist(e, buf[j]);
            }
            let mut j = 0usize;
            while j < count {
                let nx = (j + 1) % count;
                let crossing = if cls[j] != ABOVE {
                    cls[j] == BELOW && cls[nx] == ABOVE
                } else {
                    cls[nx] == BELOW || (cls[j] == BELOW && cls[nx] == ABOVE)
                };
                if crossing {
                    let a = buf[j];
                    let b = buf[nx];
                    let plane = |p: V| ld(e.cz).mul(ld(p[2])).add(ld(e.cy).mul(ld(p[1]))).add(ld(e.cxf).mul(ld(p[0])));
                    let dz = sub(ld(b[2]), ld(a[2]));
                    let dzf = dz.store();
                    let dy = sub(ld(b[1]), ld(a[1])).store();
                    let dx = sub(ld(b[0]), ld(a[0])).store();
                    let num = sub(ld(e.w), plane(a));
                    let den = ld(e.cy).mul(ld(dy)).add(ld(e.cz).mul(ld(dzf))).add(ld(dx).mul(ld(e.cxf)));
                    let t = num.div(den).store();
                    let step = [ld(dx).mul(ld(t)).store(), ld(dy).mul(ld(t)).store(), dz.mul(ld(t)).store()];
                    let fresh = vadd(step, a);
                    let mut s = count;
                    while s > j + 1 {
                        buf[s] = buf[s - 1];
                        cls[s] = cls[s - 1];
                        s -= 1;
                    }
                    buf[j + 1] = fresh;
                    cls[j + 1] = EQUAL;
                    count += 1;
                    if count >= 24 {
                        return Err(FAULT_CLIP_ASSERT);
                    }
                    j += 1;
                }
                j += 1;
            }
            let mut j = 0usize;
            while j < count {
                if cls[j] == BELOW {
                    for s in j..count - 1 {
                        buf[s] = buf[s + 1];
                        cls[s] = cls[s + 1];
                    }
                    count -= 1;
                } else {
                    j += 1;
                }
            }
            if count == 0 {
                rejected = true;
                break;
            }
            prev = cur;
        }
        if !rejected {
            if found == MAX_NODES {
                return Err(FAULT_NODES);
            }
            out[found] = index as u32;
            found += 1;
        }
    }
    Ok(found)
}

// ---- the dispatch the attach calls ------------------------------------------------

pub(super) unsafe fn find(m: &Model, node: i32, p: V) -> Result<i32, u32> {
    match mode() {
        MODE_REF => super::find_surface(m, node, p),
        MODE_FAST => find_surface(m, node, p),
        _ => {
            VERIFY_FAILED = false;
            let fast = find_surface(m, node, p);
            let reference = super::find_surface(m, node, p);
            if VERIFY_FAILED || fast != reference {
                return Err(FAULT_VERIFY);
            }
            reference
        }
    }
}

pub(super) unsafe fn gather(m: &Model, surf: &Surf, verts: &[V; 4], out: &mut [u32; MAX_NODES]) -> Result<usize, u32> {
    match mode() {
        MODE_REF => super::gather_nodes(m, surf, verts, out),
        MODE_FAST => gather_nodes(m, surf, verts, out),
        _ => {
            VERIFY_FAILED = false;
            let mut other = [0u32; MAX_NODES];
            let fast = gather_nodes(m, surf, verts, &mut other);
            let reference = super::gather_nodes(m, surf, verts, out);
            if VERIFY_FAILED || fast != reference || (reference.is_ok() && other[..reference.unwrap()] != out[..reference.unwrap()]) {
                return Err(FAULT_VERIFY);
            }
            reference
        }
    }
}

/// `cargo build --features selftest`: the filters against the x87
/// expressions over generated cases, exported as `decal_fast_selftest`
/// (scripts/validate-decal-fast.mjs runs it).
#[cfg(feature = "selftest")]
pub mod selftest {
    use super::*;

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn unit(&mut self) -> f64 {
            (self.next() >> 11) as f64 / (1u64 << 53) as f64
        }
        /// A coordinate of one of several shapes: integer, multiple of 1/16
        /// or 1/4, full-mantissa fraction, tiny, huge.
        fn coord(&mut self, scale: f64) -> u32 {
            let v = (self.unit() * 2.0 - 1.0) * scale;
            let v = match self.next() % 6 {
                0 => (v + 0.5) as i64 as f64,
                1 => ((v * 16.0 + 0.5) as i64) as f64 / 16.0,
                2 => v,
                3 => v * 1e-6,
                4 => v * 1e6,
                _ => ((v * 4.0 + 0.5) as i64) as f64 / 4.0,
            };
            (v as f32).to_bits()
        }
        fn vec(&mut self, scale: f64) -> V {
            [self.coord(scale), self.coord(scale), self.coord(scale)]
        }
        fn normal(&mut self) -> V {
            match self.next() % 5 {
                0 => [0, 0, 0x3f80_0000],
                1 => [0x3f80_0000, 0, 0],
                2 => [0, 0xbf80_0000, 0],
                _ => {
                    let v = [self.unit() - 0.5, self.unit() - 0.5, self.unit() - 0.5];
                    let l = trace::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
                    [(v[0] / l) as f32, (v[1] / l) as f32, (v[2] / l) as f32].map(f32::to_bits)
                }
            }
        }
    }

    fn lerp(a: V, b: V, t: f64) -> V {
        let g = |i: usize| (f(a[i]) + (f(b[i]) - f(a[i])) * t) as f32;
        [g(0).to_bits(), g(1).to_bits(), g(2).to_bits()]
    }

    /// Mismatches between the fast signs and the x87 expressions over
    /// `rounds` generated edges and points; IO[0..3] = cases, signs the
    /// filter decided in `side` and in `dist`; the first mismatch's
    /// cur, prev, n, p in IO[8..20].
    #[no_mangle]
    pub extern "C" fn decal_fast_selftest(seed: u32, rounds: u32) -> u32 {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15 ^ ((seed as u64) << 32 | seed as u64));
        let (mut decided_find, mut decided_gather, mut total, mut bad) = (0u32, 0u32, 0u32, 0u32);
        for round in 0..rounds {
            let scale = [100.0, 4096.0, 32768.0, 1.0][(round % 4) as usize];
            let cur = rng.vec(scale);
            let prev = if rng.next() % 8 == 0 { cur } else { rng.vec(scale) };
            let n = rng.normal();
            // Query points: random, on the edge line (exactly or up to f32
            // rounding), at the vertex, a few ulps off the line, near it.
            let p = match rng.next() % 6 {
                0 => rng.vec(scale),
                1 => lerp(prev, cur, rng.unit() * 4.0 - 1.0),
                2 => lerp(prev, cur, (rng.next() % 5) as f64 / 4.0),
                3 => {
                    let mut p = lerp(prev, cur, rng.unit() * 2.0);
                    let i = (rng.next() % 3) as usize;
                    p[i] = p[i].wrapping_add((rng.next() % 9) as u32).wrapping_sub(4);
                    p
                }
                4 => cur,
                _ => {
                    let l = lerp(prev, cur, rng.unit());
                    let d = rng.vec(1e-3);
                    [0, 1, 2].map(|i| ((f(l[i]) + f(d[i])) as f32).to_bits())
                }
            };
            let e = make([cur[0], cur[1], cur[2], prev[0], prev[1], prev[2], n[0], n[1], n[2]]);
            unsafe {
                MODE = MODE_FAST;
                let ok = side(&e, cur, prev, n, p) == side_ref(cur, prev, n, p) && dist(&e, p) == dist_ref(&e, p);
                if !ok {
                    if bad == 0 {
                        for k in 0..3 {
                            set_io(8 + k, cur[k]);
                            set_io(11 + k, prev[k]);
                            set_io(14 + k, n[k]);
                            set_io(17 + k, p[k]);
                        }
                    }
                    bad += 1;
                }
            }
            total += 1;
            if e.sure_find {
                let t1 = f(p[1]) * f(e.cy);
                let t2 = f(p[2]) * f(e.cz);
                let t3 = f(p[0]) * e.cx_d;
                if decided(((t1 + t2) + t3) - e.d1_d, t1.abs() + t2.abs() + t3.abs() + e.d1_d.abs()).is_some() {
                    decided_find += 1;
                }
            }
            if e.sure_gather {
                let t1 = f(e.cz) * f(p[2]);
                let t2 = f(e.cy) * f(p[1]);
                let t3 = f(e.cxf) * f(p[0]);
                let w = f(e.w);
                if decided(((t1 + t2) + t3) - w, t1.abs() + t2.abs() + t3.abs() + w.abs()).is_some() {
                    decided_gather += 1;
                }
            }
        }
        set_io(0, total);
        set_io(1, decided_find);
        set_io(2, decided_gather);
        bad
    }
}
