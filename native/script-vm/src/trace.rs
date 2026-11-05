//! BSP model traces (docs/rust-core.md, step R3-a): the zero-extent ray
//! traversal of src/runtime/ray.mjs (`traceRayFast`) and the nonzero-extent
//! box trace of src/runtime/extent-trace.mjs (`traceExtent`), transcribed
//! operation for operation. The JavaScript bodies stay the reference and
//! carry the native evidence (docs/fitting.md, docs/extent-trace.md);
//! scripts/validate-trace-kernel.mjs compares the two.
//!
//! Arithmetic: the JavaScript computes in f64 and rounds with Math.fround at
//! the recovered float32 stores. Here every intermediate is an f64 in the
//! same order and grouping, and `f` is `as f32 as f64`, so every value is the
//! same IEEE value, NaN and signed zeros included. Rust neither reassociates
//! nor contracts floating-point operations. Math.sqrt, Math.min and Math.max
//! are `sqrt`, `js_min` and `js_max` below (the Wasm instructions are not
//! reachable from stable Rust).
//!
//! Model data (written once per model object by src/runtime/trace-kernel.mjs,
//! addressed by pointer so the same code can run on a runtime's arena): a
//! `Header`, then one 64-byte `Node` per BSP node, then the leaf-hull words.
//! Node links and hull offsets the JavaScript would not accept as an index
//! are stored as -2, which every range check here rejects.
//!
//! Status: MISS (the JavaScript returns null), HIT (the result is in `OUT`),
//! or FALLBACK: a case the JavaScript throws on (an invalid link, a cyclic
//! tree, a malformed hull) or that exceeds a scratch stack here. The host then
//! runs the JavaScript body, which throws or answers.

use core::ptr::{addr_of, addr_of_mut};

pub(crate) const MISS: i32 = 0;
pub(crate) const HIT: i32 = 1;
pub(crate) const FALLBACK: i32 = 2;

#[repr(C)]
struct Header {
    count: u32,
    root_outside: u32,
    words: u32,
    word_count: u32,
    _pad: [u32; 4],
}

#[repr(C)]
struct Node {
    plane: [f64; 4],
    front: i32,
    back: i32,
    flags: i32,
    bound: i32,
    verts: u32,
    _pad: [u32; 3],
}

const HEADER_SIZE: usize = 32;
const _: () = assert!(core::mem::size_of::<Header>() == HEADER_SIZE);
const _: () = assert!(core::mem::size_of::<Node>() == 64);

/// ABrush.ToWorld's origin then X/Y/Z axes, written by the host for an owned
/// (brush) model.
static mut OWNER: [f64; 12] = [0.0; 12];
/// time, normal[3], location[3], node, penetrating.
static mut OUT: [f64; 9] = [0.0; 9];

const RAY_CAP: usize = 2048;
#[derive(Clone, Copy)]
#[repr(C)]
struct RayEntry {
    index: i32,
    boundary: i32,
    outside: u32,
    _pad: u32,
    from: [f64; 3],
    to: [f64; 3],
}
static mut RAY_STACK: [RayEntry; RAY_CAP] =
    [RayEntry { index: 0, boundary: 0, outside: 0, _pad: 0, from: [0.0; 3], to: [0.0; 3] }; RAY_CAP];

const EXTENT_CAP: usize = 4096;
#[derive(Clone, Copy)]
#[repr(C)]
struct ExtentEntry {
    index: i32,
    parent: i32,
    outside: u32,
}
static mut EXTENT_STACK: [ExtentEntry; EXTENT_CAP] = [ExtentEntry { index: 0, parent: 0, outside: 0 }; EXTENT_CAP];

/// The native hull's 64-plane capacity (extent-trace.mjs `leaf`).
static mut HULL: [[f64; 4]; 64] = [[0.0; 4]; 64];

/// Set the owned model's ToWorld (the host's `setOwner`, for hash.rs's mover memo).
pub(crate) fn set_owner(coords: &[f64; 12]) {
    unsafe { *addr_of_mut!(OWNER) = *coords };
}
#[no_mangle]
pub extern "C" fn trace_owner_ptr() -> *mut f64 {
    addr_of_mut!(OWNER) as *mut f64
}
#[no_mangle]
pub extern "C" fn trace_out_ptr() -> *const f64 {
    addr_of!(OUT) as *const f64
}
/// `sqrt` and `stored_support` for scripts/validate-trace-kernel.mjs, which
/// compares them with Math.sqrt and extent-trace.mjs storedSupport.
#[no_mangle]
pub extern "C" fn trace_test_sqrt(x: f64) -> f64 {
    sqrt(x)
}
#[no_mangle]
pub extern "C" fn trace_test_stored_support(p0: f64, p1: f64, p2: f64, e0: f64, e1: f64, e2: f64) -> f64 {
    stored_support(&[p0, p1, p2], &[e0, e1, e2])
}

/// Level->Model as the moving brush tracker holds it (trace-kernel.mjs
/// `tracked`, docs/brush-tracker.md "Collision"): the host copies the node
/// block raw (Engine's 64-byte FBspNode records, as bsp-occlusion.mjs
/// lineModel reads them: Plane +0, iBack +32, iFront +36, iCollisionBound
/// +44, NumVertices +54, NodeFlags +55) to `base + HEADER_SIZE` and the
/// LeafHulls words to `words`; this writes the header and converts each
/// record in place to a `Node`, with traceModelLayout's rules: the float
/// plane widened, a link -1 or in range kept (else -2), NodeFlags as an
/// int, a hull offset -1 or below `word_count` kept (else -2), and
/// whether the node has vertices.
#[no_mangle]
pub extern "C" fn trace_import_bsp(base: u32, count: u32, root_outside: u32, words: u32, word_count: u32) {
    unsafe {
        let h = base as usize as *mut Header;
        (*h).count = count;
        (*h).root_outside = (root_outside != 0) as u32;
        (*h).words = words;
        (*h).word_count = word_count;
        (*h)._pad = [0; 4];
        let link = |v: i32| if v == -1 || (v >= 0 && (v as u32) < count) { v } else { -2 };
        for i in 0..count as usize {
            let at = (base as usize + HEADER_SIZE + 64 * i) as *mut u8;
            let plane = [
                (at as *const f32).read(),
                (at.add(4) as *const f32).read(),
                (at.add(8) as *const f32).read(),
                (at.add(12) as *const f32).read(),
            ];
            let back = (at.add(32) as *const i32).read();
            let front = (at.add(36) as *const i32).read();
            let bound = (at.add(44) as *const i32).read();
            let vertices = *at.add(54);
            let flags = *at.add(55);
            (at as *mut Node).write(Node {
                plane: [plane[0] as f64, plane[1] as f64, plane[2] as f64, plane[3] as f64],
                front: link(front),
                back: link(back),
                flags: flags as i32,
                bound: if bound == -1 || (bound >= 0 && (bound as u32) < word_count) { bound } else { -2 },
                verts: (vertices > 0) as u32,
                _pad: [0; 3],
            });
        }
    }
}

#[inline(always)]
pub(crate) fn f(x: f64) -> f64 {
    x as f32 as f64
}
#[inline(always)]
pub(crate) fn abs(x: f64) -> f64 {
    f64::from_bits(x.to_bits() & !(1u64 << 63))
}
/// Math.min: NaN if either is NaN; -0 below +0.
pub(crate) fn js_min(a: f64, b: f64) -> f64 {
    if a != a || b != b {
        f64::NAN
    } else if a < b {
        a
    } else if b < a {
        b
    } else if a.is_sign_negative() {
        a
    } else {
        b
    }
}
/// Math.max: NaN if either is NaN; +0 above -0.
pub(crate) fn js_max(a: f64, b: f64) -> f64 {
    if a != a || b != b {
        f64::NAN
    } else if a > b {
        a
    } else if b > a {
        b
    } else if a.is_sign_negative() {
        b
    } else {
        a
    }
}
/// Math.sqrt, correctly rounded. x = S * 2^(e-52) with S in [2^52, 2^54)
/// and e even, so the root is q * 2^(e/2-52) with q = RN(sqrt(S * 2^52)),
/// q in [2^52, 2^53]. A reciprocal-root Newton estimate gives q within a few
/// units; the integer residual d = S * 2^52 - q^2 then decides exactly: q is
/// the rounded root iff -q < d <= q (the root is never halfway). |d| stays
/// far below 2^63, so it is exact from the low 64 bits of both terms.
pub fn sqrt(x: f64) -> f64 {
    if !(x > 0.0) || x == f64::INFINITY {
        return if x == 0.0 || x == f64::INFINITY { x } else { f64::NAN };
    }
    let bits = x.to_bits();
    let biased = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1u64 << 52) - 1);
    let (mut s, mut e) = if biased != 0 {
        (fraction | (1u64 << 52), biased - 1023)
    } else {
        let shift = fraction.leading_zeros() as i32 - 11;
        (fraction << shift, -1022 - shift)
    };
    if e & 1 != 0 {
        s <<= 1;
        e -= 1;
    }
    // m = S * 2^-52 in [1, 4), exact.
    let m = s as f64 * pow2(-52);
    let mut r = f64::from_bits(0x5fe6_eb50_c7b5_37a9 - (m.to_bits() >> 1));
    for _ in 0..4 {
        r = r * (1.5 - 0.5 * m * r * r);
    }
    let low = s << 52;
    let mut q = (m * r * pow2(52)) as u64;
    loop {
        let d = low.wrapping_sub(q.wrapping_mul(q)) as i64;
        if d > q as i64 {
            q += 1;
        } else if d <= -(q as i64) {
            q -= 1;
        } else {
            break;
        }
    }
    q as f64 * pow2(e / 2 - 52)
}

struct Model {
    nodes: *const Node,
    count: u32,
    root_outside: bool,
    words: *const i32,
    word_count: u32,
}

unsafe fn model(ptr: u32) -> Model {
    let h = &*(ptr as usize as *const Header);
    Model {
        nodes: (ptr as usize + HEADER_SIZE) as *const Node,
        count: h.count,
        root_outside: h.root_outside != 0,
        words: h.words as usize as *const i32,
        word_count: h.word_count,
    }
}
impl Model {
    #[inline(always)]
    fn valid(&self, index: i32) -> bool {
        index >= 0 && (index as u32) < self.count
    }
    #[inline(always)]
    unsafe fn node(&self, index: i32) -> &Node {
        &*self.nodes.add(index as usize)
    }
    /// `nodes.length * 8 + 8`, the cyclic-tree guard.
    fn visit_limit(&self) -> u64 {
        self.count as u64 * 8 + 8
    }
}

/// The owner rows (ToWorld X/Y/Z axes) and the transformed origin:
/// ray.mjs `transformVector(ownerCoords.slice(0, 3), rows)` and
/// extent-trace.mjs `rows.map(row => f(xyz(ownerCoords, row)))`, the same
/// X+Y+Z sum.
unsafe fn owner() -> ([[f64; 3]; 3], [f64; 3]) {
    let c = &*addr_of!(OWNER);
    let rows = [[c[3], c[4], c[5]], [c[6], c[7], c[8]], [c[9], c[10], c[11]]];
    let o = [c[0], c[1], c[2]];
    let origin = [
        f(o[0] * rows[0][0] + o[1] * rows[0][1] + o[2] * rows[0][2]),
        f(o[0] * rows[1][0] + o[1] * rows[1][1] + o[2] * rows[1][2]),
        f(o[0] * rows[2][0] + o[1] * rows[2][1] + o[2] * rows[2][2]),
    ];
    (rows, origin)
}

unsafe fn out(time: f64, normal: [f64; 3], location: [f64; 3], node: i32, penetrating: bool) {
    *addr_of_mut!(OUT) = [
        time, normal[0], normal[1], normal[2], location[0], location[1], location[2], node as f64,
        if penetrating { 1.0 } else { 0.0 },
    ];
}

// ---------------------------------------------------------------------------
// Zero-extent ray: ray.mjs traceRayFast.

/// traceRay(model, start, end, extraNodeFlags, ownerCoords). The host passes
/// the raw start/end components (`f` is applied here, as the JavaScript does)
/// and ToInt32(extraNodeFlags); `owned` says OWNER holds ownerCoords.
#[no_mangle]
pub extern "C" fn trace_ray(
    ptr: u32, sx: f64, sy: f64, sz: f64, ex: f64, ey: f64, ez: f64, extra: i32, owned: i32,
) -> i32 {
    unsafe { ray(&model(ptr), [f(sx), f(sy), f(sz)], [f(ex), f(ey), f(ez)], extra, owned != 0) }
}

unsafe fn ray(m: &Model, s: [f64; 3], e: [f64; 3], extra: i32, owned: bool) -> i32 {
    let (sx, sy, sz) = (s[0], s[1], s[2]);
    let (ex, ey, ez) = (e[0], e[1], e[2]);
    let (rows, origin) = if owned { owner() } else { ([[0.0; 3]; 3], [0.0; 3]) };
    // ownedPlane: the normal through the rows (Z+Y+X sums, stored), the
    // offset left unrounded.
    let owned_plane = |p: &[f64; 4]| -> [f64; 4] {
        let n = [
            f(p[2] * rows[0][2] + p[1] * rows[0][1] + p[0] * rows[0][0]),
            f(p[2] * rows[1][2] + p[1] * rows[1][1] + p[0] * rows[1][0]),
            f(p[2] * rows[2][2] + p[1] * rows[2][1] + p[0] * rows[2][0]),
        ];
        [n[0], n[1], n[2], p[3] - (origin[2] * n[2] + origin[1] * n[1] + origin[0] * n[0])]
    };
    let stack = addr_of_mut!(RAY_STACK) as *mut RayEntry;
    let mut depth = 0usize;
    let mut reached_outside = false;
    let mut visits = 0u64;
    let mask = (extra & !0x10) | 0x21;
    let limit = m.visit_limit();
    *stack = RayEntry { index: 0, boundary: 0, outside: m.root_outside as u32, _pad: 0, from: s, to: e };
    depth += 1;
    let mut hit = false;
    let (mut hx, mut hy, mut hz, mut hit_node) = (0.0, 0.0, 0.0, 0i32);
    while depth != 0 {
        depth -= 1;
        let entry = *stack.add(depth);
        let (mut index, boundary) = (entry.index, entry.boundary);
        let mut outside = entry.outside != 0;
        let (fx, fy, fz) = (entry.from[0], entry.from[1], entry.from[2]);
        let (mut tx, mut ty, mut tz) = (entry.to[0], entry.to[1], entry.to[2]);
        while index != -1 {
            visits += 1;
            if visits > limit || !m.valid(index) {
                return FALLBACK;
            }
            let node = m.node(index);
            let solid = node.verts != 0 && node.flags & mask == 0;
            let (a, b);
            if !owned {
                let p = &node.plane;
                a = f(fz * p[2] + fx * p[0] + fy * p[1] - p[3]);
                b = f(tz * p[2] + tx * p[0] + ty * p[1] - p[3]);
            } else {
                let p = owned_plane(&node.plane);
                a = f(fz * p[2] + fy * p[1] + fx * p[0] - p[3]);
                b = f(tz * p[2] + ty * p[1] + tx * p[0] - p[3]);
            }
            if a > -0.001 && b > -0.001 {
                outside = outside || solid;
                index = node.front;
            } else if a < 0.001 && b < 0.001 {
                outside = outside && !solid;
                index = node.back;
            } else {
                // IsCsg (0x103f68b0) keeps extra bit 0x10.
                let crossing_solid = node.verts != 0 && node.flags & (extra | 0x21) == 0;
                let fraction = a / (b - a);
                let mx = f(fx + f(f(fx - tx) * fraction));
                let my = f(fy + f(f(fy - ty) * fraction));
                let mz = f(fz + f(f(fz - tz) * fraction));
                let front_first = a > 0.0;
                if depth == RAY_CAP {
                    return FALLBACK;
                }
                *stack.add(depth) = RayEntry {
                    index: if front_first { node.back } else { node.front },
                    boundary: index,
                    outside: (if front_first { outside && !crossing_solid } else { outside || crossing_solid }) as u32,
                    _pad: 0,
                    from: [mx, my, mz],
                    to: [tx, ty, tz],
                };
                depth += 1;
                index = if front_first { node.front } else { node.back };
                outside = if front_first { outside || crossing_solid } else { outside && !crossing_solid };
                tx = mx;
                ty = my;
                tz = mz;
            }
        }
        if outside {
            reached_outside = true;
        } else if reached_outside || extra & 0x10 == 0 {
            hit = true;
            hx = fx;
            hy = fy;
            hz = fz;
            hit_node = boundary;
            break;
        }
    }
    if !hit {
        return MISS;
    }
    let dx = f(ex - sx);
    let dy = f(ey - sy);
    let dz = f(ez - sz);
    let squared = f(dx * dx + dy * dy + dz * dz);
    let projection = (hx - sx) * dx + (hy - sy) * dy + (hz - sz) * dz;
    let backed_off = f(projection / squared) - 0.5 / sqrt(squared);
    // Lower clamp on less-than or unordered (0x103f3db8).
    let time = if !(backed_off >= 0.0) { 0.0 } else if backed_off < 1.0 { backed_off } else { 1.0 };
    let location = [f(sx + f(dx * time)), f(sy + f(dy * time)), f(sz + f(dz * time))];
    let plane = &m.node(hit_node).plane;
    let mut normal = [plane[0], plane[1], plane[2]];
    if owned {
        normal = transform_vector(normal, &rows);
    // Facing test: fcomp + `test ah, 1` is C0, which an unordered value (a NaN ray) sets too (docs/fitting.md "NaN in FindSpot").
    } else if !(-dz * normal[2] - dy * normal[1] - dx * normal[0] >= 0.0) {
        normal = [-normal[0], -normal[1], -normal[2]];
    }
    out(f(time), normal, location, hit_node, hx == sx && hy == sy && hz == sz);
    HIT
}

/// ray.mjs transformVector: X+Y+Z sums per row, stored.
fn transform_vector(v: [f64; 3], rows: &[[f64; 3]; 3]) -> [f64; 3] {
    [
        f(v[0] * rows[0][0] + v[1] * rows[0][1] + v[2] * rows[0][2]),
        f(v[0] * rows[1][0] + v[1] * rows[1][1] + v[2] * rows[1][2]),
        f(v[0] * rows[2][0] + v[1] * rows[2][1] + v[2] * rows[2][2]),
    ]
}

// ---------------------------------------------------------------------------
// Nonzero extent: extent-trace.mjs traceExtent.

/// extent-trace.mjs `dot`: Z+Y+X.
#[inline(always)]
fn dot(a: &[f64], b: &[f64]) -> f64 {
    a[2] * b[2] + a[1] * b[1] + a[0] * b[0]
}
/// extent-trace.mjs `xyz`: X+Y+Z.
#[inline(always)]
fn xyz(a: &[f64], b: &[f64]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline(always)]
fn cross(a: &[f64], b: &[f64]) -> [f64; 3] {
    [f(a[1] * b[2] - a[2] * b[1]), f(a[2] * b[0] - a[0] * b[2]), f(a[0] * b[1] - a[1] * b[0])]
}
fn normalized(v: [f64; 3]) -> [f64; 3] {
    let inverse = 1.0 / sqrt(xyz(&v, &v));
    [f(v[0] * inverse), f(v[1] * inverse), f(v[2] * inverse)]
}
/// extent-trace.mjs `support`: |Z| + |Y| + |X| products.
#[inline(always)]
fn support(p: &[f64], e: &[f64; 3]) -> f64 {
    abs(p[2] * e[2]) + abs(p[1] * e[1]) + abs(p[0] * e[0])
}

/// JavaScript `2 ** k` for an integer k.
pub(crate) fn pow2(k: i32) -> f64 {
    if k > 1023 {
        f64::INFINITY
    } else if k >= -1022 {
        f64::from_bits(((k + 1023) as u64) << 52)
    } else if k >= -1074 {
        f64::from_bits(1u64 << (k + 1074))
    } else {
        0.0
    }
}
/// `Math.floor(Math.log2(value))` for a positive finite double: its binary
/// exponent. (Math.log2 is exact at powers of two; only a value within a few
/// double units below a power of two could floor differently, and such a
/// value is never a float32 midpoint, which is all the caller tests.)
fn floor_log2(value: f64) -> i32 {
    let bits = value.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    if exponent != 0 {
        exponent - 1023
    } else {
        63 - (bits & ((1u64 << 52) - 1)).leading_zeros() as i32 - 1074
    }
}

/// A nonnegative dyadic value `n * 2^e` (extent-trace.mjs storedSupport's
/// BigInt pairs; n stays below 2^66).
#[derive(Clone, Copy)]
struct Dyadic {
    n: u128,
    e: i32,
}
fn bit_length(n: u128) -> i32 {
    128 - n.leading_zeros() as i32
}
/// storedSupport `round`: nearest-even to `bits` significant bits.
fn round(a: Dyadic, bits: i32) -> Dyadic {
    let shift = bit_length(a.n) - bits;
    if shift <= 0 {
        return a;
    }
    let unit = 1u128 << shift;
    let half = unit >> 1;
    let mut n = a.n >> shift;
    let r = a.n & (unit - 1);
    if r > half || (r == half && n & 1 == 1) {
        n += 1;
    }
    Dyadic { n, e: a.e + shift }
}
/// storedSupport `add`: the exact sum rounded to 64 bits. Both operands are
/// aligned in a 122-bit window whose top holds the larger; bits shifted out
/// below it lie far under the rounding position and only make the remainder
/// nonzero (sticky).
fn add(a: Dyadic, b: Dyadic) -> Dyadic {
    if a.n == 0 {
        return round(b, 64);
    }
    if b.n == 0 {
        return round(a, 64);
    }
    let top = core::cmp::max(a.e + bit_length(a.n) - 1, b.e + bit_length(b.n) - 1);
    let base = top - 120;
    let mut sticky = false;
    let mut align = |d: Dyadic| -> u128 {
        let shift = d.e - base;
        if shift >= 0 {
            d.n << shift
        } else if -shift >= 128 {
            sticky |= d.n != 0;
            0
        } else {
            let k = -shift;
            sticky |= d.n & ((1u128 << k) - 1) != 0;
            d.n >> k
        }
    };
    let sum = align(a) + align(b);
    let shift = bit_length(sum) - 64;
    let unit = 1u128 << shift;
    let half = unit >> 1;
    let mut n = sum >> shift;
    let r = sum & (unit - 1);
    if r > half || (r == half && (sticky || n & 1 == 1)) {
        n += 1;
    }
    Dyadic { n, e: base + shift }
}
/// storedSupport `binary`: |v| stored as float32, as significand and exponent.
fn binary(v: f64) -> Dyadic {
    let w = (abs(v) as f32).to_bits();
    let exponent = (w >> 23) & 255;
    Dyadic {
        n: ((w & 0x7f_ffff) | if exponent != 0 { 0x80_0000 } else { 0 }) as u128,
        e: if exponent != 0 { exponent as i32 - 150 } else { -149 },
    }
}
/// extent-trace.mjs storedSupport: Support103f6590's Z/Y/X sum with a 64-bit
/// x87 significand, decided exactly only at a float32 midpoint.
fn stored_support(p: &[f64], e: &[f64; 3]) -> f64 {
    let value = support(p, e);
    let stored = f(value);
    if value == stored || value != value || abs(value - stored) != pow2(floor_log2(value) - 24) {
        return stored;
    }
    let product = |i: usize| {
        let a = binary(p[i]);
        let b = binary(e[i]);
        Dyadic { n: a.n * b.n, e: a.e + b.e }
    };
    let result = round(add(add(product(2), product(1)), product(0)), 24);
    f(result.n as f64 * pow2(result.e))
}

/// extent-trace.mjs `intersect`: the point and unit direction of two planes'
/// line.
fn intersect(a: &[f64; 4], b: &[f64; 4]) -> ([f64; 3], [f64; 3]) {
    let direction = cross(a, b);
    let square = xyz(&direction, &direction);
    if square < 1e-6 {
        return ([0.0; 3], [0.0; 3]);
    }
    let first = cross(&direction, a);
    let second = cross(b, &direction);
    let inverse = f(1.0 / square);
    let point = [
        f(f(f(first[0] * b[3]) + f(second[0] * a[3])) * inverse),
        f(f(f(first[1] * b[3]) + f(second[1] * a[3])) * inverse),
        f((first[2] * b[3] + second[2] * a[3]) * inverse),
    ];
    (point, normalized(direction))
}

struct Extent {
    start: [f64; 3],
    end: [f64; 3],
    extent: [f64; 3],
    owned: bool,
    rows: [[f64; 3]; 3],
    origin: [f64; 3],
    /// hit: rawTime, normal, node.
    hit: bool,
    raw_time: f64,
    normal: [f64; 3],
    node: i32,
}

impl Extent {
    /// extent-trace.mjs `transformed`: traversal planes use Z/Y/X dots,
    /// TransformPlaneByOrtho (hull) Y/Z/X; both offsets are stored.
    fn transformed(&self, p: &[f64; 4], hull: bool) -> [f64; 4] {
        if !self.owned {
            return *p;
        }
        let r = &self.rows;
        let o = &self.origin;
        let n = if hull {
            [
                f(r[0][1] * p[1] + r[0][2] * p[2] + r[0][0] * p[0]),
                f(r[1][1] * p[1] + r[1][2] * p[2] + r[1][0] * p[0]),
                f(r[2][1] * p[1] + r[2][2] * p[2] + r[2][0] * p[0]),
            ]
        } else {
            [f(dot(&r[0], p)), f(dot(&r[1], p)), f(dot(&r[2], p))]
        };
        let w = f(p[3] - if hull { o[1] * n[1] + o[2] * n[2] + o[0] * n[0] } else { dot(o, &n) });
        [n[0], n[1], n[2], w]
    }

    /// extent-trace.mjs `leaf`: clip the segment against one solid leaf's
    /// hull. Returns false for FALLBACK.
    unsafe fn leaf(&mut self, m: &Model, index: i32) -> bool {
        let bound = m.node(index).bound;
        if bound == -1 {
            return true;
        }
        if bound < 0 || bound as u32 >= m.word_count {
            return false;
        }
        let words = m.words;
        let hull = addr_of_mut!(HULL) as *mut [f64; 4];
        let mut count = 0usize;
        let mut cursor = bound as u32;
        loop {
            if cursor >= m.word_count {
                return false;
            }
            let word = *words.add(cursor as usize);
            if word == -1 {
                break;
            }
            if count == 64 {
                return false;
            }
            cursor += 1;
            let node = word & !0x4000_0000;
            if !m.valid(node) {
                return false;
            }
            let mut p = self.transformed(&m.node(node).plane, true);
            if word & 0x4000_0000 != 0 {
                p = [-p[0], -p[1], -p[2], -p[3]];
            }
            *hull.add(count) = p;
            count += 1;
        }
        if cursor + 7 > m.word_count {
            return false;
        }
        let mut bounds = [0.0f64; 6];
        for (i, b) in bounds.iter_mut().enumerate() {
            let v = f32::from_bits(*words.add((cursor + 1) as usize + i) as u32) as f64;
            if v - v != 0.0 {
                return false;
            }
            *b = v;
        }
        let mut clip = Clip {
            enter: -1.0,
            leave: if self.hit { self.raw_time } else { 2.0 },
            normal: [0.0; 3],
        };
        let planes = core::slice::from_raw_parts(hull as *const [f64; 4], count);
        for p in planes {
            if !clip.clip(self, p) {
                return true;
            }
        }
        if !self.owned {
            let [x, y, z, xx, yy, zz] = bounds;
            let sides = [
                [0.0, 0.0, -1.0, f(0.1 - z)],
                [0.0, 0.0, 1.0, f(zz + 0.1)],
                [-1.0, 0.0, 0.0, f(0.1 - x)],
                [1.0, 0.0, 0.0, f(xx - 0.1)],
                [0.0, -1.0, 0.0, f(0.1 - y)],
                [0.0, 1.0, 0.0, f(yy - 0.1)],
            ];
            for p in &sides {
                if !clip.clip(self, p) {
                    return true;
                }
            }
        }
        for i in 0..count {
            for j in 0..i {
                for axis in 0..3 {
                    let a = &planes[i];
                    let b = &planes[j];
                    if !(a[axis] < 0.0 && b[axis] > 0.0 || a[axis] > 0.0 && b[axis] < 0.0) {
                        continue;
                    }
                    let mut unit = [0.0f64; 3];
                    unit[axis] = 1.0;
                    if !(dot(&cross(&unit, a), &cross(&unit, b)) > 0.001) {
                        continue;
                    }
                    let (point, direction) = intersect(a, b);
                    let mut n = normalized(cross(&unit, &direction));
                    if dot(a, &n) < 0.0 {
                        n = [f(n[0] * -1.0), f(n[1] * -1.0), f(n[2] * -1.0)];
                    }
                    let p = [n[0], n[1], n[2], f(point[1] * n[1] + point[2] * n[2] + point[0] * n[0])];
                    if !clip.clip(self, &p) {
                        return true;
                    }
                }
            }
        }
        if clip.enter > -1.0 && clip.enter < clip.leave && clip.leave > 0.0 {
            self.hit = true;
            self.raw_time = clip.enter;
            self.normal = clip.normal;
            self.node = index;
        }
        true
    }
}

struct Clip {
    enter: f64,
    leave: f64,
    normal: [f64; 3],
}
impl Clip {
    /// extent-trace.mjs `clip`.
    #[inline(always)]
    fn clip(&mut self, t: &Extent, p: &[f64; 4]) -> bool {
        let push = stored_support(p, &t.extent);
        let a = f(dot(&t.start, p) - p[3]);
        let b = f(dot(&t.end, p) - p[3]);
        let mut numerator = a - push;
        if a > b && numerator >= -push && numerator < 0.0 {
            numerator = 0.0;
        }
        let denominator = f(a - b);
        let time = numerator / denominator;
        if denominator < -1e-5 {
            if time < self.leave {
                self.leave = f(time);
            }
        } else if denominator > 1e-5 {
            if time > self.enter {
                self.enter = f(time);
                self.normal = [p[0], p[1], p[2]];
            }
        } else if a > push && b > push {
            return false;
        }
        self.enter < self.leave
    }
}

/// traceExtent(model, start, end, extent, ownerCoords). The host has checked
/// the vectors (three finite numbers each; extent nonzero and nonnegative
/// after rounding) and passes them rounded; `owned` says OWNER holds
/// ownerCoords.
#[no_mangle]
pub extern "C" fn trace_extent(
    ptr: u32, sx: f64, sy: f64, sz: f64, ex: f64, ey: f64, ez: f64, xx: f64, xy: f64, xz: f64, owned: i32,
) -> i32 {
    unsafe {
        let m = model(ptr);
        let (rows, origin) = if owned != 0 { owner() } else { ([[0.0; 3]; 3], [0.0; 3]) };
        let mut t = Extent {
            start: [f(sx), f(sy), f(sz)],
            end: [f(ex), f(ey), f(ez)],
            extent: [f(xx), f(xy), f(xz)],
            owned: owned != 0,
            rows,
            origin,
            hit: false,
            raw_time: 0.0,
            normal: [0.0; 3],
            node: 0,
        };
        extent(&m, &mut t)
    }
}

/// A model trace's hit, as `result()` in trace-kernel.mjs reads `OUT`.
#[derive(Clone, Copy)]
pub(crate) struct TraceHit {
    pub time: f64,
    pub normal: [f64; 3],
    pub location: [f64; 3],
    pub node: f64,
    pub penetrating: bool,
}

/// The hit `OUT` holds after a HIT, copied out at once (a later trace
/// reuses the static).
unsafe fn out_hit() -> TraceHit {
    let o = &*addr_of!(OUT);
    TraceHit { time: o[0], normal: [o[1], o[2], o[3]], location: [o[4], o[5], o[6]], node: o[7], penetrating: o[8] != 0.0 }
}

/// traceRay for the level queries (hash.rs): `trace_ray`'s body on a model
/// at `ptr`, with rounded inputs. Err is FALLBACK.
pub(crate) unsafe fn ray_hit(ptr: u32, s: [f64; 3], e: [f64; 3], extra: i32, owned: bool) -> Result<Option<TraceHit>, ()> {
    match ray(&model(ptr), [f(s[0]), f(s[1]), f(s[2])], [f(e[0]), f(e[1]), f(e[2])], extra, owned) {
        HIT => Ok(Some(out_hit())),
        MISS => Ok(None),
        _ => Err(()),
    }
}

/// traceExtent for the level queries: `trace_extent`'s body. The caller has
/// checked what trace-kernel.mjs `extent` checks (finite, nonzero and
/// nonnegative extent). Err is FALLBACK.
pub(crate) unsafe fn extent_hit(ptr: u32, s: [f64; 3], e: [f64; 3], x: [f64; 3], owned: bool) -> Result<Option<TraceHit>, ()> {
    match trace_extent(ptr, s[0], s[1], s[2], e[0], e[1], e[2], x[0], x[1], x[2], owned as i32) {
        HIT => Ok(Some(out_hit())),
        MISS => Ok(None),
        _ => Err(()),
    }
}

unsafe fn extent(m: &Model, t: &mut Extent) -> i32 {
    let x = t.extent;
    let pad_extent = [x[0] * f(1.1), f(x[1] * f(1.1)), f(x[2] * f(1.1))];
    let stack = addr_of_mut!(EXTENT_STACK) as *mut ExtentEntry;
    *stack = ExtentEntry { index: 0, parent: 0, outside: m.root_outside as u32 };
    let mut depth = 1usize;
    let mut visits = 0u64;
    let limit = m.visit_limit();
    while depth != 0 {
        depth -= 1;
        let ExtentEntry { index, parent, outside } = *stack.add(depth);
        let outside = outside != 0;
        if index == -1 {
            if !outside && !t.leaf(m, parent) {
                return FALLBACK;
            }
            continue;
        }
        visits += 1;
        if visits > limit || !m.valid(index) {
            return FALLBACK;
        }
        let node = m.node(index);
        let p = t.transformed(&node.plane, false);
        let a = dot(&t.start, &p) - p[3];
        let b = xyz(&t.end, &p) - p[3];
        let pad = support(&p, &pad_extent);
        let visit = [a <= pad || b <= pad, a >= -pad || b >= -pad];
        let near = if a >= b { 1 } else { 0 };
        let solid = node.verts != 0 && node.flags & 0x21 == 0;
        let branches = [
            ExtentEntry { index: node.back, parent: index, outside: (outside && !solid) as u32 },
            ExtentEntry { index: node.front, parent: index, outside: (outside || solid) as u32 },
        ];
        for side in [1 - near, near] {
            if visit[side] {
                if depth == EXTENT_CAP {
                    return FALLBACK;
                }
                *stack.add(depth) = branches[side];
                depth += 1;
            }
        }
    }
    if !t.hit {
        return MISS;
    }
    let (s, e) = (t.start, t.end);
    let delta = [f(e[0] - s[0]), f(e[1] - s[1]), f(e[2] - s[2])];
    let size = f(sqrt(xyz(&delta, &delta)));
    let time = f(js_max(0.0, js_min(1.0, t.raw_time - js_max(f(0.1), f(0.1) / size))));
    if time == 1.0 {
        return MISS;
    }
    let location = [f(s[0] + f(delta[0] * time)), f(s[1] + f(delta[1] * time)), f(s[2] + f(delta[2] * time))];
    out(time, t.normal, location, t.node, t.raw_time <= 0.0);
    HIT
}
