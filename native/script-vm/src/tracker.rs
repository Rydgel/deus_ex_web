//! Engine's moving brush tracker, FMovingBrushTracker (UnDynBsp.cpp;
//! docs/brush-tracker.md): every mover's brush polygons filtered into the
//! level BSP the occlusion port (occlude.rs) walks, on the same node, vertex
//! and point memory.
//!
//! Engine.dll 0c3a8b18…20b4 and Core.dll 8bf3039e…e7e4; addresses below are
//! theirs. The constructor (0x1037ac40) AddBrushes (0x1037b5c0) every mover
//! in Level.Actors order and runs Update(NULL); Update (0x1037a400) takes the
//! moved test, MarkForUpdate (0x1037c4f0), RemoveActorNodes (0x1037c6d0),
//! then per listed mover ABrush::BuildCoords (0x1032f9e0, Core's FCoords
//! operators), FPoly::Transform (0x10387360) with SafeNormal (0x10144be0),
//! FSphere (0x10144960) and UModel::PrecomputeSphereFilter (0x103f6460),
//! and FilterPoly (0x1037c0c0) with SplitWithPlaneFast (0x10386ad0),
//! SplitInHalf (0x10386f70) and AddNode (0x1037bb00, AllocPoint
//! 0x1037cff0). Flush (0x1037a290), SurfIsDynamic (0x1037ac10) and the
//! destructor (0x1037b0b0) complete the interface.
//!
//! Arithmetic follows the x87 at the caller's precision control: Update
//! from URender::SetupDynamics runs inside DrawWorld at PC24 (binary32 per
//! operation, `P24`); the constructor's Update(NULL) runs at the game
//! thread's control word, which is not measured: the default is PC64
//! (0x037f, `Ext`), the oracle's assumption (docs/brush-tracker.md
//! "Precision"). Every x87 operation and float store is in the
//! instructions' order; Core's FCoords operators keep their unstored
//! intermediates on the stack.
//!
//! The host allocates every block at the sizes the tracker can reach
//! (pools sized as the constructor grows them, points to the vertex pool's
//! bound) and fills the header; the arrays' Num and Max follow FArray's
//! growth (Num + 3*Num/8 + 32) so the reference's reports compare.
//!
//! Not covered (explicit): GUndo (editor) paths, GError on a non-mover
//! brush, the 65536-node cap beyond the host's pool, PF_SpecialLit movers
//! (implemented, never reached in shipped content).

use crate::occlude::set_model;
use crate::x87::Ext;
use core::ptr::{addr_of, addr_of_mut};

// ---- header (host-filled; counters kept here) --------------------------------

pub(crate) const H_NODES: usize = 0;
const H_NODES_NUM: usize = 1;
const H_NODES_MAX: usize = 2;
const H_TOP: usize = 3;
const H_VERTS: usize = 4;
const H_VERTS_NUM: usize = 5;
const H_VERTS_MAX: usize = 6;
const H_VTOP: usize = 7;
const H_POINTS: usize = 8;
const H_POINTS_NUM: usize = 9;
const H_POINTS_MAX: usize = 10;
const H_PTOP: usize = 11;
const H_FIRST_POINT: usize = 12;
const H_POINTS_CAP: usize = 13;
const H_VECTORS: usize = 14;
const H_VECTORS_NUM: usize = 15;
const H_VECTORS_MAX: usize = 16;
const H_VECTORS_TOP: usize = 17;
const H_VECTORS_CAP: usize = 18;
const H_SURFS: usize = 19;
const H_SURFS_NUM: usize = 20;
const H_SURFS_MAX: usize = 21;
pub(crate) const H_SURFS_TOP: usize = 22;
const H_DSURFS: usize = 23;
const H_SURFS_CAP: usize = 24;
const H_MOVERS: usize = 25;
const H_MOVER_COUNT: usize = 26;
const H_NODEMAPS: usize = 27;
const H_NODEMAPS_NUM: usize = 28;
const H_NODEMAPS_MAX: usize = 29;
const H_OWNERS: usize = 30;
const H_OWNERS_NUM: usize = 31;
const H_OWNERS_MAX: usize = 32;
const H_HELPER: usize = 33;
const H_HELPER_NUM: usize = 34;
const H_HELPER_MAX: usize = 35;
const H_NODE_CURSOR: usize = 36;
const H_VERT_CURSOR: usize = 37;
const H_FREE_HEAD: usize = 38;
const H_CURRENT: usize = 39;
const H_NORMAL: usize = 40;
const H_LIST_STALE: usize = 43;
const H_SCRATCH: usize = 44;
const H_SCRATCH_BYTES: usize = 45;
const H_NODES_CAP: usize = 46;
const H_VERTS_CAP: usize = 47;
pub(crate) const H_LIVE: usize = 48;
const H_STATUS: usize = 49;
const H_HELPER_CAP: usize = 50;
const H_WORDS: usize = 56;

/// Header words; 49 is the last call's status (0 ok, 1 a block was too
/// small, 2 the scratch arena overflowed).
static mut HEADER: [u32; H_WORDS] = [0; H_WORDS];

#[no_mangle]
pub extern "C" fn trk_header_ptr() -> *mut u32 {
    addr_of_mut!(HEADER) as *mut u32
}
#[inline(always)]
fn h(i: usize) -> u32 {
    unsafe { (*addr_of!(HEADER))[i] }
}
#[inline(always)]
fn set_h(i: usize, v: u32) {
    unsafe { (*addr_of_mut!(HEADER))[i] = v }
}
/// The tracker exists (Level->BrushTracker): occlude.rs's SurfIsDynamic.
pub(crate) fn surf_is_dynamic(i_surf: i32) -> bool {
    h(H_LIVE) != 0 && i_surf >= h(H_SURFS_TOP) as i32
}

// ---- raw memory ------------------------------------------------------------------

#[inline(always)]
fn rd(a: u32) -> u32 {
    unsafe { core::ptr::read(a as *const u32) }
}
#[inline(always)]
fn wr(a: u32, v: u32) {
    unsafe { core::ptr::write(a as *mut u32, v) }
}
#[inline(always)]
fn rd8(a: u32) -> u8 {
    unsafe { core::ptr::read(a as *const u8) }
}
#[inline(always)]
fn wr8(a: u32, v: u8) {
    unsafe { core::ptr::write(a as *mut u8, v) }
}
fn zero(a: u32, words: u32) {
    for k in 0..words {
        wr(a + 4 * k, 0);
    }
}

// ---- the x87 at the caller's precision ---------------------------------------------

/// One x87 value at a precision control: arithmetic rounds to the
/// register's significand, `st` is FSTP m32, `st64` FSTP m64 then FLD, `cmp`
/// FCOM's (C0, C3) with both set when unordered.
pub(crate) trait Fp: Copy {
    fn ld(bits: u32) -> Self;
    fn ldc(c: f64) -> Self;
    fn add(self, o: Self) -> Self;
    fn sub(self, o: Self) -> Self;
    fn mul(self, o: Self) -> Self;
    fn div(self, o: Self) -> Self;
    fn sqrt(self) -> Self;
    fn neg(self) -> Self;
    fn st(self) -> u32;
    fn st64(self) -> Self;
    fn cmp(self, o: Self) -> (bool, bool);
}

impl Fp for Ext {
    fn ld(bits: u32) -> Self {
        Ext::load(bits)
    }
    fn ldc(c: f64) -> Self {
        Ext::load_f64(c)
    }
    fn add(self, o: Self) -> Self {
        Ext::add(self, o)
    }
    fn sub(self, o: Self) -> Self {
        Ext::add(self, o.neg())
    }
    fn mul(self, o: Self) -> Self {
        Ext::mul(self, o)
    }
    fn div(self, o: Self) -> Self {
        Ext::div(self, o)
    }
    fn sqrt(self) -> Self {
        Ext::sqrt(self)
    }
    fn neg(self) -> Self {
        Ext::neg(self)
    }
    fn st(self) -> u32 {
        self.store()
    }
    fn st64(self) -> Self {
        self.store_double()
    }
    fn cmp(self, o: Self) -> (bool, bool) {
        self.compare(o)
    }
}

/// Precision control 24: a result is its exact value rounded once to a
/// 24-bit significand (binary32 for the normal-range values here). A value
/// is a binary32 result or a double constant loaded by FLD m64 (exact).
#[derive(Clone, Copy)]
pub(crate) struct P24(f64);

/// TwoSum: s + e == a + b exactly.
fn two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    let bb = s - a;
    (s, (a - (s - bb)) + (b - bb))
}
/// The binary32 nearest to s + e (|e| below half an ulp of s), ties to even.
fn round24(s: f64, e: f64) -> f64 {
    let r = s as f32;
    if e == 0.0 || !s.is_finite() || r as f64 == s {
        return r as f64;
    }
    let b = r.to_bits();
    let rd = r as f64;
    let other = if rd > s {
        if r > 0.0 { f32::from_bits(b - 1) } else if r < 0.0 { f32::from_bits(b + 1) } else { f32::from_bits(0x8000_0001) }
    } else if r > 0.0 {
        f32::from_bits(b + 1)
    } else if r < 0.0 {
        f32::from_bits(b - 1)
    } else {
        f32::from_bits(1)
    };
    if s != (rd + other as f64) * 0.5 {
        return rd;
    }
    // s is a binary32 tie: the exact value lies on the side of e.
    if (e > 0.0) == (other as f64 > rd) { other as f64 } else { rd }
}
fn is_f32(x: f64) -> bool {
    (x as f32) as f64 == x || x.is_nan()
}
/// Veltkamp split: hi + lo == x, each with at most 26 significant bits.
fn split(x: f64) -> (f64, f64) {
    let c = 134217729.0 * x; // 2^27 + 1
    let hi = c - (c - x);
    (hi, x - hi)
}
/// a / b rounded once to a 24-bit significand (normal range), for a double
/// operand (FDIV of a binary32 value by a double such as Core appTan's
/// result): the double quotient decides unless it is a binary32 midpoint,
/// where the sign of a - mid * b, computed exactly, does.
fn div24(a: f64, b: f64) -> f64 {
    let q = a / b;
    let r = q as f32;
    if !q.is_finite() || r as f64 == q {
        return r as f64;
    }
    let rd = r as f64;
    let bits = r.to_bits();
    let other = if (rd > q) == (r > 0.0) { f32::from_bits(bits - 1) } else { f32::from_bits(bits + 1) } as f64;
    let mid = (rd + other) * 0.5;
    if q != mid {
        return rd;
    }
    // mid * b exactly as p + e (Dekker), then the sign of a - p - e.
    let p = mid * b;
    let ((mh, ml), (bh, bl)) = (split(mid), split(b));
    let e = ((mh * bh - p) + mh * bl + ml * bh) + ml * bl;
    let residual = (a - p) - e; // a and p agree to within a factor of two: a - p is exact
    let above = if b > 0.0 { residual > 0.0 } else { residual < 0.0 }; // the true quotient is above mid
    if residual == 0.0 {
        // An exact tie: round to even.
        return if bits & 1 == 0 { rd } else { other };
    }
    if above == (other > rd) { other } else { rd }
}

impl Fp for P24 {
    fn ld(bits: u32) -> Self {
        P24(f32::from_bits(bits) as f64)
    }
    fn ldc(c: f64) -> Self {
        P24(c)
    }
    fn add(self, o: Self) -> Self {
        let (s, e) = two_sum(self.0, o.0);
        P24(round24(s, e))
    }
    fn sub(self, o: Self) -> Self {
        self.add(o.neg())
    }
    fn mul(self, o: Self) -> Self {
        if is_f32(self.0) && is_f32(o.0) {
            // A product of two 24-bit significands is exact in binary64.
            return P24(round24(self.0 * o.0, 0.0));
        }
        // A binary32 value times a double constant: split the constant.
        let (a, c) = if is_f32(self.0) { (self.0, o.0) } else { (o.0, self.0) };
        let hi = (c as f32) as f64;
        let lo = c - hi;
        let (s, e) = two_sum(a * hi, a * lo);
        P24(round24(s, e))
    }
    fn div(self, o: Self) -> Self {
        if is_f32(self.0) && is_f32(o.0) {
            return P24(((self.0 as f32) / (o.0 as f32)) as f64);
        }
        P24(div24(self.0, o.0))
    }
    fn sqrt(self) -> Self {
        // The 64-bit root rounded to 24 bits: a square root of a binary32
        // value is never within 2^-64 of a 24-bit tie unless it is exact.
        P24(f32::from_bits(Ext::load((self.0 as f32).to_bits()).sqrt().store()) as f64)
    }
    fn neg(self) -> Self {
        P24(-self.0)
    }
    fn st(self) -> u32 {
        (self.0 as f32).to_bits()
    }
    fn st64(self) -> Self {
        self
    }
    fn cmp(self, o: Self) -> (bool, bool) {
        if self.0.is_nan() || o.0.is_nan() {
            return (true, true);
        }
        (self.0 < o.0, self.0 == o.0)
    }
}

fn lt<F: Fp>(a: F, b: F) -> bool {
    a.cmp(b).0
}

// ---- Core's FCoords -----------------------------------------------------------------

/// An FCoords as float bits: Origin, XAxis, YAxis, ZAxis.
type Coords = [[u32; 3]; 4];
const ONE: u32 = 0x3f80_0000;
const UNIT: Coords = [[0, 0, 0], [ONE, 0, 0], [0, ONE, 0], [0, 0, ONE]];

/// FVector::TransformVectorBy (Core 0x10119e40): ((v.x*A.x + v.y*A.y) +
/// v.z*A.z) per axis A, each output stored.
fn tvb<F: Fp>(v: [F; 3], c: &Coords) -> [u32; 3] {
    let mut out = [0; 3];
    for k in 0..3 {
        let a = c[1 + k];
        out[k] = v[0].mul(F::ld(a[0])).add(v[1].mul(F::ld(a[1]))).add(v[2].mul(F::ld(a[2]))).st();
    }
    out
}
fn ld3<F: Fp>(v: [u32; 3]) -> [F; 3] {
    [F::ld(v[0]), F::ld(v[1]), F::ld(v[2])]
}
/// FCoords::operator*=(FCoords) (0x1011a710): the origin through
/// TransformPointBy (the subtraction kept on the stack), the axes through
/// TransformVectorBy.
fn compose<F: Fp>(c: &mut Coords, m: &Coords) {
    let o = c[0];
    let d = [F::ld(o[0]).sub(F::ld(m[0][0])), F::ld(o[1]).sub(F::ld(m[0][1])), F::ld(o[2]).sub(F::ld(m[0][2]))];
    c[0] = tvb(d, m);
    for k in 1..4 {
        c[k] = tvb(ld3::<F>(c[k]), m);
    }
}
fn sin(angle: i32) -> u32 {
    crate::rotator_sin(angle)
}
fn cos(angle: i32) -> u32 {
    crate::rotator_sin(angle.wrapping_add(0x4000))
}
const fn neg(b: u32) -> u32 {
    b ^ 0x8000_0000
}
/// FCoords::operator*=(FRotator) (0x1011ac80): yaw, pitch, roll.
fn mul_rotator<F: Fp>(c: &mut Coords, r: [i32; 3]) {
    let (p, y, l) = (r[0], r[1], r[2]);
    compose::<F>(c, &[[0; 3], [cos(y), sin(y), 0], [neg(sin(y)), cos(y), 0], [0, 0, ONE]]);
    compose::<F>(c, &[[0; 3], [cos(p), 0, sin(p)], [0, ONE, 0], [neg(sin(p)), 0, cos(p)]]);
    compose::<F>(c, &[[0; 3], [ONE, 0, 0], [0, cos(l), neg(sin(l))], [0, sin(l), cos(l)]]);
}
/// FCoords::operator/=(FRotator) (0x1011b690): roll, pitch, yaw inverted.
fn div_rotator<F: Fp>(c: &mut Coords, r: [i32; 3]) {
    let (p, y, l) = (r[0], r[1], r[2]);
    compose::<F>(c, &[[0; 3], [ONE, 0, 0], [0, cos(l), sin(l)], [0, neg(sin(l)), cos(l)]]);
    compose::<F>(c, &[[0; 3], [cos(p), 0, neg(sin(p))], [0, ONE, 0], [sin(p), 0, cos(p)]]);
    compose::<F>(c, &[[0; 3], [cos(y), neg(sin(y)), 0], [sin(y), cos(y), 0], [0, 0, ONE]]);
}
/// FScale words: Scale (3 float bits), SheerRate bits, SheerAxis.
type Scale = [u32; 5];
/// ShearSnap on the stack (0x1011c0b5..0x1011c148): the snapped rate.
fn shear_snap<F: Fp>(rate: u32) -> F {
    let r = F::ld(rate);
    if lt(r, F::ldc(-0.65)) {
        return r.add(F::ldc(0.15));
    }
    let (l, e) = r.cmp(F::ldc(0.65));
    if !(l || e) {
        return r.sub(F::ldc(0.15));
    }
    if lt(r, F::ldc(-0.55)) {
        return F::ld(0xbf00_0000);
    }
    let (l, e) = r.cmp(F::ldc(0.55));
    if !(l || e) {
        return F::ld(0x3f00_0000);
    }
    if lt(r, F::ldc(-0.05)) {
        return r.add(F::ldc(0.05));
    }
    let (l, e) = r.cmp(F::ldc(0.05));
    if !(l || e) {
        return r.sub(F::ldc(0.05));
    }
    F::ld(0)
}
/// The shear matrix: UnitCoords with the snapped rate at SheerAxis 1..6
/// (X.y, X.z, Y.x, Y.z, Z.x, Z.y), negated for the inverse.
fn shear_coords<F: Fp>(s: &Scale, negate: bool) -> Coords {
    let mut m = UNIT;
    let v = shear_snap::<F>(s[3]);
    let bits = (if negate { v.neg() } else { v }).st();
    let slot = match s[4] {
        1 => Some((1, 1)),
        2 => Some((1, 2)),
        3 => Some((2, 0)),
        4 => Some((2, 2)),
        5 => Some((3, 0)),
        6 => Some((3, 1)),
        _ => None,
    };
    if let Some((a, k)) = slot {
        m[a][k] = bits;
    }
    m
}
/// FCoords::operator*=(FScale) (0x1011c0a0): the shear, then the axes
/// times the scale and the origin divided by it.
fn mul_scale<F: Fp>(c: &mut Coords, s: &Scale) {
    let m = shear_coords::<F>(s, false);
    compose::<F>(c, &m);
    for a in 1..4 {
        for k in 0..3 {
            c[a][k] = F::ld(c[a][k]).mul(F::ld(s[k])).st();
        }
    }
    for k in 0..3 {
        c[0][k] = F::ld(c[0][k]).div(F::ld(s[k])).st();
    }
}
/// FCoords::operator/=(FScale) (0x1011c860): the axes divided by the
/// scale, the origin times it, then the inverse shear.
fn div_scale<F: Fp>(c: &mut Coords, s: &Scale) {
    for a in 1..4 {
        for k in 0..3 {
            c[a][k] = F::ld(c[a][k]).div(F::ld(s[k])).st();
        }
    }
    for k in 0..3 {
        c[0][k] = F::ld(s[k]).mul(F::ld(c[0][k])).st();
    }
    let m = shear_coords::<F>(s, true);
    compose::<F>(c, &m);
}
/// sgn((Z*Y)*X) of a scale (FScale::Orientation 0x10118880 and the inline
/// copy in BuildCoords): 1 above zero, -1 below or unordered, 0 at zero.
fn orientation<F: Fp>(s: &Scale) -> i32 {
    let p = F::ld(s[2]).mul(F::ld(s[1])).mul(F::ld(s[0]));
    let (l, e) = p.cmp(F::ld(0));
    if !(l || e) {
        1
    } else if l {
        -1
    } else {
        0
    }
}

// ---- movers and polygons -------------------------------------------------------------

// Mover record words (MV per mover).
const MV: u32 = 40;
const M_TAG: u32 = 0;
const M_FLAGS: u32 = 1;
const M_LOCATION: u32 = 2;
const M_ROTATION: u32 = 5;
const M_PREPIVOT: u32 = 8;
const M_MAINSCALE: u32 = 11;
const M_POSTSCALE: u32 = 16;
const M_SAVEDPOS: u32 = 21;
const M_SAVEDROT: u32 = 24;
const M_MOVERLINK: u32 = 27;
const M_POLYS: u32 = 28;
const M_POLY_COUNT: u32 = 29;
const M_SPECIALLIT: u32 = 30;
const ASSIMILATED: u32 = 0x100;

fn mover(i: u32) -> u32 {
    h(H_MOVERS) + 4 * MV * i
}
fn mw(m: u32, k: u32) -> u32 {
    rd(m + 4 * k)
}
fn set_mw(m: u32, k: u32, v: u32) {
    wr(m + 4 * k, v)
}
fn scale_of(m: u32, at: u32) -> Scale {
    [mw(m, at), mw(m, at + 1), mw(m, at + 2), mw(m, at + 3), mw(m, at + 4)]
}

// FPoly words (FP per polygon; a source polygon adds TEXKEY..).
const FP: u32 = 68;
const P_BASE: u32 = 0;
const P_NORMAL: u32 = 3;
const P_TEXU: u32 = 6;
const P_TEXV: u32 = 9;
const P_VERT: u32 = 12;
const P_FLAGS: u32 = 60;
const P_NUMV: u32 = 61;
const P_ILINK: u32 = 62;
const P_IBRUSHPOLY: u32 = 63;
const P_TEXKEY: u32 = 64;
const P_PAN: u32 = 65;
const P_TEXFLAGS: u32 = 66;


fn pv(p: u32, k: u32) -> [u32; 3] {
    let a = p + 4 * k;
    [rd(a), rd(a + 4), rd(a + 8)]
}
fn set_pv(p: u32, k: u32, v: [u32; 3]) {
    let a = p + 4 * k;
    wr(a, v[0]);
    wr(a + 4, v[1]);
    wr(a + 8, v[2]);
}
fn numv(p: u32) -> u32 {
    rd(p + 4 * P_NUMV)
}

// ---- the GMem scratch arena ----------------------------------------------------------

static mut SCRATCH_TOP: u32 = 0;
fn scratch_mark() -> u32 {
    unsafe { *addr_of!(SCRATCH_TOP) }
}
fn scratch_release(mark: u32) {
    unsafe { *addr_of_mut!(SCRATCH_TOP) = mark }
}
/// new(GMem) FPoly: contents left as they were (the original does not
/// zero them; the fields read are always written first).
fn new_poly() -> u32 {
    unsafe {
        let top = *addr_of!(SCRATCH_TOP);
        if top + 4 * FP > h(H_SCRATCH) + h(H_SCRATCH_BYTES) {
            set_h(H_STATUS, 2);
            return h(H_SCRATCH);
        }
        *addr_of_mut!(SCRATCH_TOP) = top + 4 * FP;
        top
    }
}

// ---- model arrays ----------------------------------------------------------------------

fn node(i: u32) -> u32 {
    h(H_NODES) + 64 * i
}
const N_PLANE: u32 = 0;
const N_ZONEMASK: u32 = 16;
const N_VERTPOOL: u32 = 24;
const N_SURF: u32 = 28;
const N_BACK: u32 = 32;
const N_FRONT: u32 = 36;
const N_PLANE_LINK: u32 = 40;
const N_COLLISION: u32 = 44;
const N_RENDER: u32 = 48;
const N_ZONE: u32 = 52;
const N_NUMV: u32 = 54;
const N_FLAGS: u32 = 55;
const N_LEAF: u32 = 56;
fn nd(n: u32, off: u32) -> u32 {
    rd(n + off)
}
fn nflags(n: u32) -> u8 {
    rd8(n + N_FLAGS)
}
fn set_nflags(n: u32, v: u8) {
    wr8(n + N_FLAGS, v)
}
fn is_csg(n: u32) -> bool {
    rd8(n + N_NUMV) > 0 && nflags(n) & 0x21 == 0
}
fn child_outside(n: u32, child: u32, outside: bool) -> bool {
    if child != 0 { outside || is_csg(n) } else { outside && !is_csg(n) }
}

/// FArray::Add's growth: Num + 3*Num/8 + 32 when Num passes Max.
fn grow(num_at: usize, max_at: usize, count: u32) -> u32 {
    let old = h(num_at);
    let num = old + count;
    set_h(num_at, num);
    if num > h(max_at) {
        set_h(max_at, num + 3 * num / 8 + 32);
    }
    old
}

fn point(p: u32) -> u32 {
    h(H_POINTS) + 12 * p
}
fn vector(v: u32) -> u32 {
    h(H_VECTORS) + 12 * v
}
fn vert(v: u32) -> u32 {
    h(H_VERTS) + 8 * v
}
// Dynamic surf records (DS words per dynamic surf): FBspSurf's fields.
const DS: u32 = 16;
const S_TEXKEY: u32 = 0;
const S_FLAGS: u32 = 1;
const S_PBASE: u32 = 2;
const S_VNORMAL: u32 = 3;
const S_VTEXU: u32 = 4;
const S_VTEXV: u32 = 5;
const S_LIGHTMAP: u32 = 6;
const S_BRUSHPOLY: u32 = 7;
const S_PAN: u32 = 8;
const S_ACTOR: u32 = 9;
fn dsurf(s: u32) -> u32 {
    h(H_DSURFS) + 4 * DS * (s - h(H_SURFS_TOP))
}
fn nodemap(i: u32) -> u32 {
    h(H_NODEMAPS) + 8 * (i - h(H_TOP))
}
fn owner(v: u32) -> u32 {
    h(H_OWNERS) + 4 * (v - h(H_VTOP))
}
fn helper(p: u32) -> u32 {
    h(H_HELPER) + 4 * (p - h(H_FIRST_POINT))
}

/// The occlusion model's counts (occlude.rs MODEL words).
fn sync_model() {
    set_model(1, h(H_NODES_NUM));
    set_model(3, h(H_VERTS_NUM));
    set_model(5, h(H_POINTS_NUM));
    set_model(7, h(H_SURFS_NUM));
}

// ---- construction --------------------------------------------------------------------

/// AddBrush (0x1037b5c0) for mover `i`.
fn add_brush(i: u32) {
    let m = mover(i);
    set_mw(m, M_MOVERLINK, u32::MAX);
    for k in 0..3 {
        set_mw(m, M_SAVEDPOS + k, 0xbf80_0000);
    }
    set_mw(m, M_SAVEDROT, 123);
    set_mw(m, M_SAVEDROT + 1, 456);
    set_mw(m, M_SAVEDROT + 2, 789);
    set_mw(m, M_FLAGS, mw(m, M_FLAGS) & !ASSIMILATED);
    for k in 0..mw(m, M_POLY_COUNT) {
        let p = mw(m, M_POLYS) + 4 * FP * k;
        let s = grow(H_SURFS_NUM, H_SURFS_MAX, 1);
        let ds = dsurf(s);
        zero(ds, DS);
        let vn = grow(H_VECTORS_NUM, H_VECTORS_MAX, 1);
        let vu = grow(H_VECTORS_NUM, H_VECTORS_MAX, 1);
        let vv = grow(H_VECTORS_NUM, H_VECTORS_MAX, 1);
        for v in [vn, vu, vv] {
            zero(vector(v), 3);
        }
        let pb = grow(H_POINTS_NUM, H_POINTS_MAX, 1);
        zero(point(pb), 3);
        let mut flags = rd(p + 4 * P_FLAGS) & 0x3cff_ffff;
        if mw(m, M_SPECIALLIT) != 0 {
            flags |= 0x0010_0000;
        }
        for (k2, v) in [
            (S_TEXKEY, rd(p + 4 * P_TEXKEY)),
            (S_FLAGS, flags),
            (S_PBASE, pb),
            (S_VNORMAL, vn),
            (S_VTEXU, vu),
            (S_VTEXV, vv),
            (S_LIGHTMAP, rd(p + 4 * P_IBRUSHPOLY)),
            (S_BRUSHPOLY, k),
            (S_PAN, rd(p + 4 * P_PAN)),
            (S_ACTOR, mw(m, M_TAG)),
        ] {
            wr(ds + 4 * k2, v);
        }
        // The occlusion's surf words: PolyFlags and the texture's.
        wr(h(H_SURFS) + 8 * s, flags);
        wr(h(H_SURFS) + 8 * s + 4, rd(p + 4 * P_TEXFLAGS));
        wr(p + 4 * P_ILINK, s);
    }
}

/// GNewBrushTracker's constructor (0x1037ac40), then Update(NULL) at
/// `pc64` (the game thread's precision; see the module notes).
#[no_mangle]
pub extern "C" fn trk_construct(pc64: u32) -> u32 {
    set_h(H_STATUS, 0);
    set_h(H_SURFS_TOP, h(H_SURFS_NUM));
    set_h(H_VECTORS_TOP, h(H_VECTORS_NUM));
    set_h(H_PTOP, h(H_POINTS_NUM));
    set_h(H_TOP, h(H_NODES_NUM));
    set_h(H_VTOP, h(H_VERTS_NUM));
    set_h(H_FREE_HEAD, u32::MAX);
    set_h(H_HELPER_NUM, 0);
    set_h(H_HELPER_MAX, 0);
    set_h(H_LIVE, 1);
    let polys: u32 = (0..h(H_MOVER_COUNT)).map(|i| mw(mover(i), M_POLY_COUNT)).sum();
    if h(H_SURFS_NUM) + polys > h(H_SURFS_CAP) || h(H_VECTORS_NUM) + 3 * polys > h(H_VECTORS_CAP) {
        set_h(H_STATUS, 1);
        return 1;
    }
    for i in 0..h(H_MOVER_COUNT) {
        add_brush(i);
    }
    set_h(H_FIRST_POINT, h(H_POINTS_NUM));
    // Vectors.Shrink(); Surfs.Shrink().
    set_h(H_VECTORS_MAX, h(H_VECTORS_NUM));
    set_h(H_SURFS_MAX, h(H_SURFS_NUM));
    // GrowNodes / GrowVerts: min(2*Num + 512, Max), zero-filled, then Shrink.
    let nodes = h(H_NODES_NUM);
    let new_nodes = (2 * nodes + 0x200).min(0x10000);
    let verts = h(H_VERTS_NUM);
    let new_verts = 2 * verts + 0x200;
    if new_nodes > h(H_NODES_CAP) || new_verts > h(H_VERTS_CAP)
        || h(H_FIRST_POINT) + (new_verts - verts) > h(H_POINTS_CAP)
        || new_verts - verts > h(H_HELPER_CAP)
    {
        set_h(H_STATUS, 1);
        return 1;
    }
    for i in nodes..new_nodes {
        zero(node(i), 16);
    }
    for v in verts..new_verts {
        wr(vert(v), 0);
        wr(vert(v) + 4, 0);
    }
    set_h(H_NODES_NUM, new_nodes);
    set_h(H_NODES_MAX, new_nodes);
    set_h(H_VERTS_NUM, new_verts);
    set_h(H_VERTS_MAX, new_verts);
    set_h(H_NODE_CURSOR, nodes);
    set_h(H_VERT_CURSOR, verts);
    // NodeMaps and VertOwners: exactly the pools' dynamic parts, zeroed.
    let maps = new_nodes - h(H_TOP);
    zero(h(H_NODEMAPS), 2 * maps);
    set_h(H_NODEMAPS_NUM, maps);
    set_h(H_NODEMAPS_MAX, maps);
    let owners = new_verts - h(H_VTOP);
    zero(h(H_OWNERS), owners);
    set_h(H_OWNERS_NUM, owners);
    set_h(H_OWNERS_MAX, owners);
    sync_model();
    update(-1, pc64 != 0);
    sync_model();
    h(H_STATUS)
}

// ---- Update ------------------------------------------------------------------------------

/// The update list ({mover, next}, LIFO); entries index LIST.
static mut LIST: [[i32; 2]; 4096] = [[0; 2]; 4096];
static mut LIST_HEAD: i32 = -1;
static mut LIST_LEN: usize = 0;

fn push(i: u32) {
    unsafe {
        let n = *addr_of!(LIST_LEN);
        if n >= 4096 {
            set_h(H_STATUS, 1);
            return;
        }
        (*addr_of_mut!(LIST))[n] = [i as i32, *addr_of!(LIST_HEAD)];
        *addr_of_mut!(LIST_HEAD) = n as i32;
        *addr_of_mut!(LIST_LEN) = n + 1;
    }
}
fn entry(e: i32) -> [i32; 2] {
    unsafe { (*addr_of!(LIST))[e as usize] }
}
/// bAssimilated, pushed, SavedPos = Location, SavedRot = Rotation.
fn assimilate(i: u32) {
    let m = mover(i);
    set_mw(m, M_FLAGS, mw(m, M_FLAGS) | ASSIMILATED);
    push(i);
    for k in 0..3 {
        set_mw(m, M_SAVEDPOS + k, mw(m, M_LOCATION + k));
        set_mw(m, M_SAVEDROT + k, mw(m, M_ROTATION + k));
    }
}
fn mover_of_tag(tag: u32) -> Option<u32> {
    (0..h(H_MOVER_COUNT)).find(|&i| mw(mover(i), M_TAG) == tag)
}

/// Update(Actor) (0x1037a400) for mover `actor` (-1: NULL) at `pc64`.
#[no_mangle]
pub extern "C" fn trk_update(actor: i32, pc64: u32) -> u32 {
    if h(H_LIVE) == 0 {
        return 0;
    }
    set_h(H_STATUS, 0);
    update(actor, pc64 != 0);
    sync_model();
    h(H_STATUS)
}

fn update(actor: i32, pc64: bool) {
    unsafe {
        *addr_of_mut!(LIST_HEAD) = -1;
        *addr_of_mut!(LIST_LEN) = 0;
    }
    if actor < 0 {
        for i in 0..h(H_MOVER_COUNT) {
            if mw(mover(i), M_FLAGS) & ASSIMILATED == 0 {
                assimilate(i);
            }
        }
    } else {
        let m = mover(actor as u32);
        let mut moved = false;
        for k in 0..3 {
            let (a, b) = (f32::from_bits(mw(m, M_SAVEDPOS + k)), f32::from_bits(mw(m, M_LOCATION + k)));
            // FCOMP's C3: equal, or unordered.
            if !(a == b || a.is_nan() || b.is_nan()) {
                moved = true;
            }
        }
        for k in 0..3 {
            if mw(m, M_SAVEDROT + k) != mw(m, M_ROTATION + k) {
                moved = true;
            }
        }
        if moved && mw(m, M_FLAGS) & ASSIMILATED == 0 {
            assimilate(actor as u32);
        }
    }
    // MarkForUpdate along every listed mover's chain; entries it pushes go
    // ahead of the head and are not walked here (0x1037a613).
    let mut e = unsafe { *addr_of!(LIST_HEAD) };
    while e != -1 {
        let [i, next] = entry(e);
        let mut n = mw(mover(i as u32), M_MOVERLINK) as i32;
        while n != -1 {
            mark_for_update(n as u32);
            n = nd(node(n as u32), N_RENDER) as i32;
        }
        e = next;
    }
    let head = unsafe { *addr_of!(LIST_HEAD) };
    let mut e = head;
    while e != -1 {
        let [i, next] = entry(e);
        remove_actor_nodes(i as u32);
        e = next;
    }
    let mut e = head;
    while e != -1 {
        let [i, next] = entry(e);
        if pc64 { rebuild::<Ext>(i as u32) } else { rebuild::<P24>(i as u32) }
        e = next;
    }
    set_h(H_LIST_STALE, (head != -1) as u32);
}

/// MarkForUpdate (0x1037c4f0).
fn mark_for_update(i: u32) {
    let n = node(i);
    if nflags(n) & 0x20 != 0 {
        return;
    }
    set_nflags(n, nflags(n) | 0x20);
    for off in [N_FRONT, N_BACK, N_PLANE_LINK] {
        let c = nd(n, off) as i32;
        if c != -1 {
            mark_for_update(c as u32);
        }
    }
    if i < h(H_TOP) {
        return;
    }
    let tag = rd(nodemap(i));
    if tag != 0 {
        if let Some(j) = mover_of_tag(tag) {
            if mw(mover(j), M_FLAGS) & ASSIMILATED == 0 {
                assimilate(j);
            }
        }
    }
}

/// RemoveActorNodes (0x1037c6d0); Flush's body.
fn remove_actor_nodes(i: u32) {
    let m = mover(i);
    let mut link = mw(m, M_MOVERLINK) as i32;
    while link != -1 {
        let ni = link as u32;
        let n = node(ni);
        let parent = node(rd(nodemap(ni) + 4));
        if nd(parent, N_FRONT) == ni {
            wr(parent + N_FRONT, u32::MAX);
        } else if nd(parent, N_BACK) == ni {
            wr(parent + N_BACK, u32::MAX);
        } else if nd(parent, N_PLANE_LINK) == ni {
            wr(parent + N_PLANE_LINK, u32::MAX);
        }
        let count = rd8(n + N_NUMV) as u32;
        let pool = nd(n, N_VERTPOOL);
        for k in 0..count {
            let p = rd(vert(pool + k));
            wr(helper(p), h(H_FREE_HEAD));
            set_h(H_FREE_HEAD, p);
        }
        for k in 0..count {
            wr(owner(pool + k), 0);
        }
        wr(nodemap(ni), 0);
        wr(nodemap(ni) + 4, 0);
        link = nd(n, N_RENDER) as i32;
    }
    set_mw(m, M_MOVERLINK, u32::MAX);
}

/// FPoly::Transform (0x10387360) on `p` with the BuildCoords pair.
fn transform<F: Fp>(p: u32, point_xform: &Coords, vector_xform: &Coords, prepivot: [u32; 3], location: [u32; 3],
    orientation: u32) {
    set_pv(p, P_TEXU, tvb(ld3::<F>(pv(p, P_TEXU)), vector_xform));
    set_pv(p, P_TEXV, tvb(ld3::<F>(pv(p, P_TEXV)), vector_xform));
    let place = |v: [u32; 3]| -> [u32; 3] {
        let d = [
            F::ld(v[0]).sub(F::ld(prepivot[0])).st(),
            F::ld(v[1]).sub(F::ld(prepivot[1])).st(),
            F::ld(v[2]).sub(F::ld(prepivot[2])).st(),
        ];
        let t = tvb(ld3::<F>(d), point_xform);
        [
            F::ld(t[0]).add(F::ld(location[0])).st(),
            F::ld(t[1]).add(F::ld(location[1])).st(),
            F::ld(t[2]).add(F::ld(location[2])).st(),
        ]
    };
    set_pv(p, P_BASE, place(pv(p, P_BASE)));
    let n = numv(p);
    for k in 0..n {
        set_pv(p, P_VERT + 3 * k, place(pv(p, P_VERT + 3 * k)));
    }
    // Orientation < 0.0 (double, unordered counts): reverse the vertices.
    if lt(F::ld(orientation), F::ldc(0.0)) {
        let half = (n as i32 / 2) as u32;
        for k in 0..half {
            let a = pv(p, P_VERT + 3 * k);
            let b = pv(p, P_VERT + 3 * (n - 1 - k));
            set_pv(p, P_VERT + 3 * k, b);
            set_pv(p, P_VERT + 3 * (n - 1 - k), a);
        }
    }
    let normal = tvb(ld3::<F>(pv(p, P_NORMAL)), vector_xform);
    set_pv(p, P_NORMAL, safe_normal::<F>(normal));
}

/// FVector::SafeNormal (Core 0x10144be0).
fn safe_normal<F: Fp>(v: [u32; 3]) -> [u32; 3] {
    let [x, y, z] = ld3::<F>(v);
    let s = x.mul(x).add(y.mul(y)).add(z.mul(z));
    if lt(s, F::ldc(1e-8)) {
        return [0, 0, 0];
    }
    let k = F::ldc(1.0).div(s.st64().sqrt());
    [k.mul(x).st(), k.mul(y).st(), k.mul(z).st()]
}

/// Update's per-mover rebuild (0x1037a66e..).
fn rebuild<F: Fp>(i: u32) {
    let m = mover(i);
    set_mw(m, M_FLAGS, mw(m, M_FLAGS) & !ASSIMILATED);
    set_h(H_CURRENT, mw(m, M_TAG));
    let mark = scratch_mark();
    // ABrush::BuildCoords(&Coords, NULL) (0x1032f9e0).
    let main = scale_of(m, M_MAINSCALE);
    let post = scale_of(m, M_POSTSCALE);
    let rotation = [mw(m, M_ROTATION) as i32, mw(m, M_ROTATION + 1) as i32, mw(m, M_ROTATION + 2) as i32];
    let mut point_xform = UNIT;
    mul_scale::<F>(&mut point_xform, &post);
    mul_rotator::<F>(&mut point_xform, rotation);
    mul_scale::<F>(&mut point_xform, &main);
    let mut v = UNIT;
    div_scale::<F>(&mut v, &main);
    div_rotator::<F>(&mut v, rotation);
    div_scale::<F>(&mut v, &post);
    let o = tvb(ld3::<F>(v[0]), &v);
    let vector_xform: Coords = [
        [neg(o[0]), neg(o[1]), neg(o[2])],
        [v[1][0], v[2][0], v[3][0]],
        [v[1][1], v[2][1], v[3][1]],
        [v[1][2], v[2][2], v[3][2]],
    ];
    let sign = orientation::<F>(&main);
    // fild sign; fmul PostScale.Orientation(); fstp float.
    let orient = F::ldc(sign as f64).mul(F::ldc(orientation::<F>(&post) as f64)).st();
    let prepivot = [mw(m, M_PREPIVOT), mw(m, M_PREPIVOT + 1), mw(m, M_PREPIVOT + 2)];
    let location = [mw(m, M_LOCATION), mw(m, M_LOCATION + 1), mw(m, M_LOCATION + 2)];
    let count = mw(m, M_POLY_COUNT);
    let copies = scratch_mark();
    for k in 0..count {
        let c = new_poly();
        let src = mw(m, M_POLYS) + 4 * FP * k;
        for w in 0..FP {
            wr(c + 4 * w, rd(src + 4 * w));
        }
        transform::<F>(c, &point_xform, &vector_xform, prepivot, location, orient);
    }
    // FSphere over every transformed vertex (Core 0x10144960, FBox 0x10144ab0).
    let sphere = sphere::<F>(copies, count);
    precompute_sphere_filter::<F>(sphere);
    // The mover's node chain: MoverLink, then each node's iRenderBound.
    let mut tail = m + 4 * M_MOVERLINK;
    for k in 0..count {
        let p = copies + 4 * FP * k;
        let s = rd(p + 4 * P_ILINK);
        let ds = dsurf(s);
        let normal = pv(p, P_NORMAL);
        for c in 0..3 {
            set_h(H_NORMAL + c, normal[c]);
        }
        let base = pv(p, P_BASE);
        for c in 0..3 {
            wr(point(rd(ds + 4 * S_PBASE)) + 4 * c as u32, base[c]);
            wr(vector(rd(ds + 4 * S_VNORMAL)) + 4 * c as u32, normal[c]);
            wr(vector(rd(ds + 4 * S_VTEXU)) + 4 * c as u32, rd(p + 4 * (P_TEXU + c as u32)));
            wr(vector(rd(ds + 4 * S_VTEXV)) + 4 * c as u32, rd(p + 4 * (P_TEXV + c as u32)));
        }
        if h(H_NODES_NUM) > 0 {
            filter_poly::<F>(s, 0, -1, p, true, &mut tail);
        }
    }
    wr(tail, u32::MAX);
    let mut link = mw(m, M_MOVERLINK) as i32;
    while link != -1 {
        let n = node(link as u32);
        set_nflags(n, nflags(n) & !0x20);
        link = nd(n, N_RENDER) as i32;
    }
    scratch_release(mark);
}

/// FSphere(Points, n): FBox's min and max, the center from the halved
/// sums, the largest squared distance, then sqrt(W) * 1.001.
fn sphere<F: Fp>(copies: u32, count: u32) -> [u32; 4] {
    let mut first = true;
    let mut min = [0u32; 3];
    let mut max = [0u32; 3];
    for k in 0..count {
        let p = copies + 4 * FP * k;
        for v in 0..numv(p) {
            let q = pv(p, P_VERT + 3 * v);
            if first {
                min = q;
                max = q;
                first = false;
                continue;
            }
            for c in 0..3 {
                let (l, e) = F::ld(min[c]).cmp(F::ld(q[c]));
                if !(l || e) {
                    min[c] = q[c];
                }
                if F::ld(max[c]).cmp(F::ld(q[c])).0 {
                    max[c] = q[c];
                }
            }
        }
    }
    if first {
        return [0; 4];
    }
    let half = F::ld(0x3f00_0000);
    let sz = F::ld(min[2]).add(F::ld(max[2]));
    let sy = F::ld(min[1]).add(F::ld(max[1])).st();
    let sx = F::ld(min[0]).add(F::ld(max[0])).st();
    let center = [F::ld(sx).mul(half).st(), F::ld(sy).mul(half).st(), sz.mul(half).st()];
    let mut w = 0u32;
    for k in 0..count {
        let p = copies + 4 * FP * k;
        for v in 0..numv(p) {
            let q = pv(p, P_VERT + 3 * v);
            let dx = F::ld(center[0]).sub(F::ld(q[0]));
            let dy = F::ld(center[1]).sub(F::ld(q[1]));
            let dz = F::ld(center[2]).sub(F::ld(q[2]));
            let d2 = dy.mul(dy).add(dx.mul(dx)).add(dz.mul(dz));
            let (l, e) = d2.cmp(F::ld(w));
            if !(l || e) {
                w = d2.st();
            }
        }
    }
    // fst qword keeps st0: fmul qword 1.001 on the unstored root.
    let root = F::ld(w).st64().sqrt();
    [center[0], center[1], center[2], root.mul(F::ldc(1.001)).st()]
}

/// UModel::PrecomputeSphereFilter (0x103f6460, helper 0x103f63a0).
fn precompute_sphere_filter<F: Fp>(s: [u32; 4]) {
    if h(H_NODES_NUM) == 0 {
        return;
    }
    let mut i = 0i32;
    loop {
        let n = node(i as u32);
        set_nflags(n, nflags(n) & 0x3f);
        let d = F::ld(nd(n, 8)).mul(F::ld(s[2])).add(F::ld(nd(n, 4)).mul(F::ld(s[1])))
            .add(F::ld(s[0]).mul(F::ld(nd(n, 0)))).sub(F::ld(nd(n, 12)));
        if lt(d, F::ld(s[3]).neg()) {
            set_nflags(n, nflags(n) | 0x80);
            i = nd(n, N_BACK) as i32;
        } else {
            let (l, e) = d.cmp(F::ld(s[3]));
            if !(l || e) {
                set_nflags(n, nflags(n) | 0x40);
            } else {
                let b = nd(n, N_BACK) as i32;
                if b != -1 {
                    sphere_filter_helper::<F>(b, s);
                }
            }
            i = nd(n, N_FRONT) as i32;
        }
        if i == -1 {
            break;
        }
    }
}
fn sphere_filter_helper<F: Fp>(start: i32, s: [u32; 4]) {
    let mut i = start;
    loop {
        let n = node(i as u32);
        set_nflags(n, nflags(n) & 0x3f);
        let d = F::ld(nd(n, 4)).mul(F::ld(s[1])).add(F::ld(nd(n, 8)).mul(F::ld(s[2])))
            .add(F::ld(nd(n, 0)).mul(F::ld(s[0]))).sub(F::ld(nd(n, 12)));
        if lt(d, F::ld(s[3]).neg()) {
            set_nflags(n, nflags(n) | 0x80);
            i = nd(n, N_BACK) as i32;
        } else {
            let (l, e) = d.cmp(F::ld(s[3]));
            if !(l || e) {
                set_nflags(n, nflags(n) | 0x40);
            } else {
                let b = nd(n, N_BACK) as i32;
                if b != -1 {
                    sphere_filter_helper::<F>(b, s);
                }
            }
            i = nd(n, N_FRONT) as i32;
        }
        if i == -1 {
            break;
        }
    }
}

// SplitWithPlaneFast results.
const SP_COPLANAR: u32 = 0;
const SP_FRONT: u32 = 1;
const SP_BACK: u32 = 2;
const SP_SPLIT: u32 = 3;

/// FPoly::SplitWithPlaneFast (0x10386ad0) of `p` by `plane` (float bits).
fn split_with_plane_fast<F: Fp>(p: u32, plane: [u32; 4], front: u32, back: u32) -> u32 {
    let n = numv(p);
    if n as i32 <= 0 {
        return SP_COPLANAR;
    }
    let (px, py, pz, pw) = (F::ld(plane[0]), F::ld(plane[1]), F::ld(plane[2]), F::ld(plane[3]));
    let mut status = [0u8; 16];
    let (mut any_front, mut any_back) = (false, false);
    for k in 0..n {
        let v = pv(p, P_VERT + 3 * k);
        let d = pz.mul(F::ld(v[2])).add(px.mul(F::ld(v[0]))).add(py.mul(F::ld(v[1]))).sub(pw);
        if lt(d, F::ldc(0.0)) {
            status[k as usize] = 1;
            if lt(d, F::ldc(-0.25)) {
                any_back = true;
            }
        } else {
            status[k as usize] = 0;
            let (l, e) = d.cmp(F::ldc(0.25));
            if !(l || e) {
                any_front = true;
            }
        }
    }
    if !any_front {
        return if any_back { SP_BACK } else { SP_COPLANAR };
    }
    if !any_back {
        return SP_FRONT;
    }
    let (mut nf, mut nb) = (0u32, 0u32);
    let mut prev = pv(p, P_VERT + 3 * (n - 1));
    let mut prev_status = status[(n - 1) as usize];
    for k in 0..n {
        let cur = pv(p, P_VERT + 3 * k);
        let st = status[k as usize];
        if st != prev_status {
            let dx = F::ld(cur[0]).sub(F::ld(prev[0]));
            let dxs = dx.st();
            let dy = F::ld(cur[1]).sub(F::ld(prev[1])).st();
            let dz = F::ld(cur[2]).sub(F::ld(prev[2])).st();
            let num = pw.sub(px.mul(F::ld(prev[0])).add(pz.mul(F::ld(prev[2]))).add(py.mul(F::ld(prev[1]))));
            let den = pz.mul(F::ld(dz)).add(py.mul(F::ld(dy))).add(F::ld(dxs).mul(px));
            let t = num.div(den).st();
            let ix = dx.mul(F::ld(t)).add(F::ld(prev[0])).st();
            let ty = F::ld(dy).mul(F::ld(t)).st();
            let tz = F::ld(dz).mul(F::ld(t)).st();
            let iy = F::ld(ty).add(F::ld(prev[1])).st();
            let iz = F::ld(tz).add(F::ld(prev[2])).st();
            let i = [ix, iy, iz];
            set_pv(back, P_VERT + 3 * nb, i);
            nb += 1;
            set_pv(front, P_VERT + 3 * nf, i);
            nf += 1;
            if prev_status == 0 {
                set_pv(back, P_VERT + 3 * nb, cur);
                nb += 1;
            } else {
                set_pv(front, P_VERT + 3 * nf, cur);
                nf += 1;
            }
        } else if st == 0 {
            set_pv(front, P_VERT + 3 * nf, cur);
            nf += 1;
        } else {
            set_pv(back, P_VERT + 3 * nb, cur);
            nb += 1;
        }
        prev = cur;
        prev_status = st;
    }
    for (q, count) in [(front, nf), (back, nb)] {
        wr(q + 4 * P_NUMV, count);
        set_pv(q, P_BASE, pv(p, P_BASE));
        set_pv(q, P_NORMAL, pv(p, P_NORMAL));
        wr(q + 4 * P_FLAGS, rd(p + 4 * P_FLAGS));
    }
    SP_SPLIT
}

/// FPoly::SplitInHalf (0x10386f70): `other` takes the second half.
fn split_in_half(p: u32, other: u32) {
    let n = numv(p);
    let m = (n as i32 / 2) as u32;
    for w in 0..FP {
        wr(other + 4 * w, rd(p + 4 * w));
    }
    let on = n - m + 1;
    wr(other + 4 * P_NUMV, on);
    wr(p + 4 * P_NUMV, m + 1);
    for k in 0..on - 1 {
        set_pv(other, P_VERT + 3 * k, pv(p, P_VERT + 3 * (k + m)));
    }
    set_pv(other, P_VERT + 3 * (on - 1), pv(p, P_VERT));
    // PF_EdCut.
    wr(p + 4 * P_FLAGS, rd(p + 4 * P_FLAGS) | 0x8000_0000);
    wr(other + 4 * P_FLAGS, rd(other + 4 * P_FLAGS) | 0x8000_0000);
}

/// FilterPoly (0x1037c0c0).
fn filter_poly<F: Fp>(s: u32, mut i_node: u32, mut coplanar: i32, mut poly: u32, mut outside: bool, tail: &mut u32) {
    let mut front = new_poly();
    let mut back = new_poly();
    loop {
        let mut n = node(i_node);
        if numv(poly) >= 14 {
            let half = new_poly();
            front = half;
            split_in_half(poly, half);
            filter_poly::<F>(s, i_node, coplanar, half, outside, tail);
        }
        let go_front: bool;
        if nflags(n) & 0x40 != 0 {
            go_front = true;
        } else if nflags(n) & 0x80 != 0 {
            go_front = false;
        } else {
            let plane = [nd(n, 0), nd(n, 4), nd(n, 8), nd(n, 12)];
            match split_with_plane_fast::<F>(poly, plane, front, back) {
                SP_FRONT => go_front = true,
                SP_BACK => go_front = false,
                SP_COPLANAR => {
                    let t = [h(H_NORMAL), h(H_NORMAL + 1), h(H_NORMAL + 2)];
                    let d = F::ld(t[2]).mul(F::ld(plane[2])).add(F::ld(t[1]).mul(F::ld(plane[1])))
                        .add(F::ld(plane[0]).mul(F::ld(t[0])));
                    if !lt(d, F::ldc(0.0)) {
                        coplanar = i_node as i32;
                    }
                    go_front = true;
                }
                _ => {
                    let f = nd(n, N_FRONT) as i32;
                    if f != -1 {
                        filter_poly::<F>(s, f as u32, coplanar, front, child_outside(n, 1, outside), tail);
                    } else if child_outside(n, 1, outside) {
                        add_node::<F>(s, i_node, coplanar, 1, front, tail);
                    }
                    poly = back;
                    back = new_poly();
                    n = node(i_node);
                    go_front = false;
                }
            }
        }
        if go_front {
            outside = child_outside(n, 1, outside);
            let f = nd(n, N_FRONT) as i32;
            if f == -1 {
                if outside {
                    add_node::<F>(s, i_node, coplanar, 1, poly, tail);
                }
                return;
            }
            i_node = f as u32;
        } else {
            outside = child_outside(n, 0, outside);
            let b = nd(n, N_BACK) as i32;
            if b == -1 {
                if outside {
                    add_node::<F>(s, i_node, coplanar, 0, poly, tail);
                }
                return;
            }
            i_node = b as u32;
        }
    }
}

/// AllocPoint (0x1037cff0).
fn alloc_point() -> u32 {
    let head = h(H_FREE_HEAD);
    let p = if head != u32::MAX {
        set_h(H_FREE_HEAD, rd(helper(head)));
        head
    } else {
        if h(H_POINTS_NUM) >= h(H_POINTS_CAP) || h(H_HELPER_NUM) >= h(H_HELPER_CAP) {
            set_h(H_STATUS, 1);
            return h(H_POINTS_NUM) - 1;
        }
        let p = grow(H_POINTS_NUM, H_POINTS_MAX, 1);
        zero(point(p), 3);
        let k = grow(H_HELPER_NUM, H_HELPER_MAX, 1);
        wr(h(H_HELPER) + 4 * k, 0);
        p
    };
    wr(helper(p), h(H_CURRENT));
    p
}

/// AddNode (0x1037bb00).
fn add_node<F: Fp>(s: u32, parent: u32, coplanar: i32, node_type: u32, poly: u32, tail: &mut u32) {
    let ty = node_type;
    let mut link_type = node_type;
    let mut link_parent = parent;
    let mut different = false;
    if coplanar != -1 {
        different = parent != coplanar as u32;
        link_type = 2;
        link_parent = coplanar as u32;
        loop {
            let next = nd(node(link_parent), N_PLANE_LINK) as i32;
            if next == -1 {
                break;
            }
            link_parent = next as u32;
        }
    }
    // Next fit in the node pool: [cursor, Num), then [top, old cursor).
    let top = h(H_TOP);
    let start = h(H_NODE_CURSOR);
    let mut found = false;
    let mut c = start;
    while c < h(H_NODES_NUM) {
        if rd(nodemap(c)) == 0 {
            found = true;
            break;
        }
        c += 1;
        set_h(H_NODE_CURSOR, c);
    }
    if !found {
        set_h(H_NODE_CURSOR, top);
        c = top;
        while c < start {
            if rd(nodemap(c)) == 0 {
                found = true;
                break;
            }
            c += 1;
            set_h(H_NODE_CURSOR, c);
        }
    }
    if !found {
        return;
    }
    let i = h(H_NODE_CURSOR);
    wr(nodemap(i), h(H_CURRENT));
    wr(nodemap(i) + 4, link_parent);
    let n = node(i);
    let p = node(parent);
    let l = node(link_parent);
    wr(n + N_SURF, s);
    wr(n + N_COLLISION, u32::MAX);
    wr(n + N_RENDER, u32::MAX);
    wr(n + N_ZONEMASK, nd(l, N_ZONEMASK));
    wr(n + N_ZONEMASK + 4, nd(l, N_ZONEMASK + 4));
    wr(n + N_FRONT, u32::MAX);
    wr8(n + N_NUMV, numv(poly) as u8);
    wr(n + N_BACK, u32::MAX);
    wr(n + N_PLANE_LINK, u32::MAX);
    // FPlane(Base, Normal): W = (B.y*N.y + B.z*N.z) + B.x*N.x.
    let b = pv(poly, P_BASE);
    let nn = pv(poly, P_NORMAL);
    set_nflags(n, 0x20);
    let w = F::ld(b[1]).mul(F::ld(nn[1])).add(F::ld(b[2]).mul(F::ld(nn[2]))).add(F::ld(b[0]).mul(F::ld(nn[0]))).st();
    wr(n + N_PLANE, nn[0]);
    wr(n + N_PLANE + 4, nn[1]);
    wr(n + N_PLANE + 8, nn[2]);
    wr(n + N_PLANE + 12, w);
    let flags = rd(poly + 4 * P_FLAGS);
    if flags & 8 != 0 {
        set_nflags(n, 0x21);
    }
    if flags & 0x0400_0001 != 0 {
        set_nflags(n, nflags(n) | 4);
    }
    if flags & 2 != 0 {
        set_nflags(n, nflags(n) | 2);
    }
    if coplanar != -1 && !different {
        // Against the chain end: ((L.z*N.z + L.y*N.y) + L.x*N.x) < 0.0.
        let d = F::ld(nd(l, 8)).mul(F::ld(nn[2])).add(F::ld(nd(l, 4)).mul(F::ld(nn[1])))
            .add(F::ld(nd(l, 0)).mul(F::ld(nn[0])));
        let side = lt(d, F::ldc(0.0)) as u32;
        wr8(n + N_ZONE, rd8(l + N_ZONE + side));
        wr(n + N_LEAF, rd(l + N_LEAF + 4 * side));
        wr8(n + N_ZONE + 1, rd8(l + N_ZONE + 1 - side));
        wr(n + N_LEAF + 4, rd(l + N_LEAF + 4 - 4 * side));
    } else {
        let z = rd8(p + N_ZONE + ty);
        let leaf = rd(p + N_LEAF + 4 * ty);
        wr8(n + N_ZONE + 1, z);
        wr8(n + N_ZONE, z);
        wr(n + N_LEAF + 4, leaf);
        wr(n + N_LEAF, leaf);
    }
    // P.ZoneMask |= (1 << iZone[1]) | (1 << iZone[0]) (__allshl: 0 past 63).
    let bit = |z: u8| -> u64 { if z < 64 { 1u64 << z } else { 0 } };
    let mask = bit(rd8(n + N_ZONE + 1)) | bit(rd8(n + N_ZONE));
    wr(p + N_ZONEMASK, nd(p, N_ZONEMASK) | mask as u32);
    wr(p + N_ZONEMASK + 4, nd(p, N_ZONEMASK + 4) | (mask >> 32) as u32);
    // Next-fit vertex run of `count` free slots.
    let count = numv(poly);
    let vtop = h(H_VTOP);
    let old = h(H_VERT_CURSOR);
    let mut pool: i32 = -1;
    let mut run = 0u32;
    let mut c = old;
    let mut done = false;
    while count + c < h(H_VERTS_NUM) {
        if rd(owner(c)) != 0 {
            run = 0;
        } else {
            run += 1;
            if run >= count {
                done = true;
                break;
            }
        }
        c += 1;
        set_h(H_VERT_CURSOR, c);
    }
    if !done {
        set_h(H_VERT_CURSOR, vtop);
        c = vtop;
        run = 0;
        while count + c < old {
            if rd(owner(c)) != 0 {
                run = 0;
            } else {
                run += 1;
                if run >= count {
                    done = true;
                    break;
                }
            }
            c += 1;
            set_h(H_VERT_CURSOR, c);
        }
    }
    if done {
        let last = h(H_VERT_CURSOR);
        for k in 0..run {
            wr(owner(last - k), h(H_CURRENT));
        }
        pool = (last - count + 1) as i32;
    }
    wr(n + N_VERTPOOL, pool as u32);
    if pool == -1 {
        wr(nodemap(i), 0);
        wr(nodemap(i) + 4, 0);
        return;
    }
    for k in 0..count {
        let pt = alloc_point();
        wr(vert(pool as u32 + k), pt);
        wr(vert(pool as u32 + k) + 4, u32::MAX);
        let v = pv(poly, P_VERT + 3 * k);
        wr(point(pt), v[0]);
        wr(point(pt) + 4, v[1]);
        wr(point(pt) + 8, v[2]);
    }
    let child = match link_type {
        0 => N_BACK,
        1 => N_FRONT,
        _ => N_PLANE_LINK,
    };
    wr(l + child, i);
    wr(*tail, i);
    *tail = n + N_RENDER;
}

/// Flush(Actor) (0x1037a290): RemoveActorNodes alone (no MarkForUpdate, no
/// SavedPos change); reached only from the editor.
#[no_mangle]
pub extern "C" fn trk_flush(actor: u32) {
    if h(H_LIVE) == 0 || actor >= h(H_MOVER_COUNT) {
        return;
    }
    remove_actor_nodes(actor);
    sync_model();
}

/// SurfIsDynamic (0x1037ac10).
#[no_mangle]
pub extern "C" fn trk_surf_is_dynamic(i_surf: i32) -> u32 {
    (i_surf >= h(H_SURFS_TOP) as i32) as u32
}

/// FArray::Remove (Core 0x101454f0) of everything past `keep`: with a
/// nonzero count, Max becomes Num when (3*Num < 2*Max or the slack is at
/// least 16 KB) and (the slack is above 64 or Num is 0).
fn remove_tail(num_at: usize, max_at: usize, keep: u32, size: u32) {
    let num = h(num_at);
    if num <= keep {
        return;
    }
    set_h(num_at, keep);
    let max = h(max_at);
    if (3 * keep < 2 * max || (max - keep) * size >= 0x4000) && (max - keep > 0x40 || keep == 0) {
        set_h(max_at, keep);
    }
}

/// The destructor (0x1037b0b0): every array back to its construction Num
/// (FArray::Remove, which may shrink Max), then any static child link past
/// the node count cleared. ZoneMask ORs and sphere-filter bits stay.
#[no_mangle]
pub extern "C" fn trk_destroy() {
    if h(H_LIVE) == 0 {
        return;
    }
    remove_tail(H_SURFS_NUM, H_SURFS_MAX, h(H_SURFS_TOP), 64);
    remove_tail(H_POINTS_NUM, H_POINTS_MAX, h(H_PTOP), 12);
    remove_tail(H_VECTORS_NUM, H_VECTORS_MAX, h(H_VECTORS_TOP), 12);
    remove_tail(H_NODES_NUM, H_NODES_MAX, h(H_TOP), 64);
    remove_tail(H_VERTS_NUM, H_VERTS_MAX, h(H_VTOP), 8);
    let count = h(H_NODES_NUM);
    for i in 0..count {
        let n = node(i);
        for off in [N_FRONT, N_BACK, N_PLANE_LINK] {
            if nd(n, off) as i32 >= count as i32 {
                wr(n + off, u32::MAX);
            }
        }
    }
    for k in [H_NODEMAPS_NUM, H_NODEMAPS_MAX, H_OWNERS_NUM, H_OWNERS_MAX, H_HELPER_NUM, H_HELPER_MAX] {
        set_h(k, 0);
    }
    set_h(H_LIVE, 0);
    sync_model();
}
