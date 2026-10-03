//! Render.dll volumetric fog maps (docs/volumetric-fog.md): SetupForSurf's
//! per-light fog loop 0x10b073bb-0x10b07c44 on the exact x87 model. The
//! Rust counterpart of src/runtime/volumetric-fog.mjs `fogMap`, which matches
//! the original (validate-volumetric-fog.mjs); validate-volumetric-fog-rust
//! compares the two. JavaScript prepares the per-light constants and colour
//! tables (`volumetricLight`) and the camera-space grid; this loop is the
//! per-texel work.
use crate::x87::Ext;

const MAX_LIGHTS: usize = 32;
const MAX_TEXELS: usize = 1 << 16;
/// Per light: location x, y, z; R²; 1/R; 1/R²; |L|²; brightness; inside.
const LIGHT_WORDS: usize = 9;

static mut SQRT: [u32; 2048] = [0; 2048];
static mut LIGHTS: [u32; MAX_LIGHTS * LIGHT_WORDS] = [0; MAX_LIGHTS * LIGHT_WORDS];
static mut TABLES: [u8; MAX_LIGHTS * 1024] = [0; MAX_LIGHTS * 1024];
/// Camera-space grid: base, U step, V step (float bits).
static mut GRID: [u32; 9] = [0; 9];
static mut OUT: [u8; MAX_TEXELS * 4] = [0; MAX_TEXELS * 4];
/// The early-out flag 0x10b4ea00, persisting across surfaces like the
/// original global.
static mut MISS: u32 = 0;
/// Nonzero: every texel on the Ext model (`fog_set_exact`, FOG_EXACT=1).
static mut EXACT: u32 = 0;
/// Texels the fast path left to the Ext model (`fog_fallbacks`).
static mut FALLBACKS: u32 = 0;

const F_ZERO: u32 = 0;
const F_ONE: u32 = 0x3f80_0000;
const F_THREE: u32 = 0x4040_0000;
const F_255: u32 = 0x437f_0000;

fn ld(bits: u32) -> Ext {
    Ext::load(bits)
}
fn sub(a: Ext, b: Ext) -> Ext {
    a.add(b.neg())
}
/// FCOM's C0: below or unordered.
fn below(a: Ext, b: Ext) -> bool {
    a.compare(b).0
}
fn greater(a: Ext, b: Ext) -> bool {
    let (c0, c3) = a.compare(b);
    !c0 && !c3
}
/// The light manager's table square root (dynamic-lighting.mjs tableSqrt).
fn table_sqrt(bits: u32) -> u32 {
    unsafe { (*core::ptr::addr_of!(SQRT))[((bits >> 13) & 0x7ff) as usize].wrapping_add((bits & 0x7f00_0000) >> 1) }
}
/// FISTP of a stored float under round-to-nearest-even (values 0..255 here;
/// dynamic-lighting.mjs fistp).
fn fistp(bits: u32) -> i32 {
    let v = f32::from_bits(bits) as f64;
    let t = v as i64 as f64;
    let floor = if t > v { t - 1.0 } else { t };
    let fraction = v - floor;
    let floor = floor as i32;
    if fraction > 0.5 || (fraction == 0.5 && floor & 1 != 0) {
        floor + 1
    } else {
        floor
    }
}

/// One texel's colour-table index, or -1 for a later light's skip.
fn texel_index(light: &[u32], px: u32, py: u32, pz: u32, first: bool, miss: &mut u32) -> i32 {
    let none = if first { 0 } else { -1 };
    let (lx, ly, lz) = (light[0], light[1], light[2]);
    let (radius_sq, inv_r, inv_r2, distance_sq, brightness, inside) =
        (light[3], light[4], light[5], light[6], light[7], light[8]);
    let dot = ld(pz).mul(ld(lz)).add(ld(py).mul(ld(ly))).add(ld(px).mul(ld(lx))).store();
    if inside == 0 && dot >= 0x8000_0000 {
        return none;
    }
    let pp = ld(px).mul(ld(px)).add(ld(pz).mul(ld(pz))).add(ld(py).mul(ld(py)));
    let dd = ld(dot).mul(ld(dot));
    if *miss != 0 && greater(sub(pp.mul(ld(distance_sq)), dd), pp.mul(ld(radius_sq))) {
        return none;
    }
    let h2 = sub(ld(distance_sq), dd.div(pp)).store();
    if below(ld(radius_sq), ld(h2)) {
        *miss = 1;
        return none;
    }
    *miss = 0;
    let length = table_sqrt(pp.store());
    let t = ld(dot).div(ld(length)).store();
    let w = table_sqrt(sub(ld(radius_sq), ld(h2)).store());
    let mut s = sub(ld(t), ld(length)).store();
    let neg_w = w ^ 0x8000_0000;
    let mut clamped = false;
    let far;
    if greater(ld(t), ld(w)) {
        if below(ld(s), ld(neg_w)) {
            s = neg_w;
            clamped = true;
        }
        far = w;
    } else {
        if below(ld(s), ld(neg_w)) {
            s = neg_w;
        }
        far = t;
    }
    if !below(ld(s), ld(far)) {
        return none;
    }
    let hn = ld(h2).mul(ld(inv_r2)).store();
    let a = ld(far).mul(ld(inv_r));
    let c = sub(ld(F_THREE), ld(hn).mul(ld(F_THREE)));
    let mut v = if clamped {
        let p = sub(c, a.mul(a)).mul(a).mul(ld(brightness));
        p.add(p)
    } else {
        let b = ld(s).mul(ld(inv_r));
        let outer = a.mul(sub(c, a.mul(a)));
        sub(outer, sub(c, b.mul(b)).mul(b)).mul(ld(brightness))
    };
    if below(v, ld(F_ZERO)) {
        return none;
    }
    if v.store() >= F_ONE {
        v = ld(F_ONE);
    }
    if first {
        return fistp(v.mul(ld(F_255)).store());
    }
    let vf = v.store();
    if vf == 0 {
        return -1;
    }
    fistp(ld(vf).mul(ld(F_255)).store())
}

// The certain-rounding fast path (docs/volumetric-fog.md "Fast path"; the
// pattern of x87-fast.mjs and lodmesh-kernel's pose_double). `texel_index`
// on the Ext model is the reference. `texel_fast` evaluates the same
// operations in f64 and returns a result only where it is already the Ext
// result; otherwise None, and the caller reruns the texel on Ext with the
// same incoming flag (the fast path never writes the flag itself).
//
// - Every Ext value approximates a real R computed from exact inputs (the
//   stored f32s). The f64 value v and the Ext value both lie within the
//   stated bound E of R, so they lie within E of each other: an FST is taken
//   only when every real within E of v rounds to one normal f32
//   (`certain_f32`), and a comparison of unstored values only when its margin
//   exceeds E.
// - E is Higham's gamma_n bound on the absolute-value expression: |fl(e) - e|
//   <= n*u*|e|abs (to first order) for n roundings on the deepest path, u =
//   2^-53 for f64 and 2^-64 for Ext. Each bound below is at least 1.5 times
//   that sum, which also covers the second-order terms and the f64 rounding
//   of the bound and of the magnitudes themselves. Cancellation (dot ~ 0,
//   h2 ~ 0, a short chord) shows as a value small against its magnitude
//   and falls back.
// - Products of two f32s (and of an f32 and 3 or 255) are exact in f64 and
//   in Ext (at most 48 bits). Rust contracts nothing into FMA.
// - An f32 operation whose operands are stored f32s is computed natively:
//   a product rounds the exact product once, as Ext's FST does. For a
//   quotient or a difference the Ext value is the exact result rounded to
//   64 bits, which changes it only where it lies more than 2^-49 (relative)
//   from every f32 midpoint, so FST gives the correctly rounded f32 of the
//   native operation (double rounding is innocuous, 64 >= 2*24 + 2). A
//   difference of two f32s is exact in 64 bits unless their exponents differ
//   by more than 40, and then lies within 2^-39 of the larger operand, an
//   f32; a quotient a/b is never a midpoint m (a = m*b would make the odd
//   25-bit significand of m divide a's 24-bit one) and |a - m*b| is at least
//   one unit of the coarser of a and m*b, so |a/b - m| > 2^-49 |m|. These
//   results must still be normal and finite, or the texel falls back.
// - Comparisons between stored, finite f32s are exact natively; the Ext
//   compare quirks (unordered, an infinity pair) need non-finite operands,
//   which are excluded: the light's eight float words are checked once per
//   light and the texel position per texel.
// - Every fast decision is `margin > bound` or `certain_f32`, false on NaN.
// - TINY (2^-1000) in each bound covers f64 subnormal roundings (each below
//   2^-1074), which a relative bound does not.
const U: f64 = 1.0 / 9_007_199_254_740_992.0; // 2^-53
const TINY: f64 = 9.332636185032189e-302; // 2^-1000
/// store(v) >= 1.0 exactly when v >= 1 - 2^-25: the midpoint between
/// 1 - 2^-24 and 1.0 rounds to the even 1.0.
const CLAMP: f64 = 1.0 - 1.0 / 33_554_432.0;

/// The f32 FST stores when every real within `bound` of `value` rounds,
/// nearest-even, to that one normal f32 (x87-fast.mjs unambiguousF32). None
/// for zero, subnormal, top-binade or non-finite results.
#[inline(always)]
pub(crate) fn certain_f32(value: f64, bound: f64) -> Option<u32> {
    let f = value as f32;
    let bits = f.to_bits();
    let e = (bits >> 23) & 0xff;
    if e == 0 || e >= 254 {
        return None;
    }
    // The spacing above |f|, 2^(e-150); below a power of two it halves.
    let up = f64::from_bits((e as u64 + 873) << 52);
    let down = if bits & 0x7f_ffff == 0 { up * 0.5 } else { up };
    let (magnitude, target) = (value.abs(), f.abs() as f64);
    // The midpoints are exact in f64, and rounding is monotone, so the
    // rounded sides decide these strict comparisons as the exact ones would.
    if magnitude - bound > target - down * 0.5 && magnitude + bound < target + up * 0.5 {
        Some(bits)
    } else {
        None
    }
}
#[inline(always)]
fn normal(f: f32) -> bool {
    let e = (f.to_bits() >> 23) & 0xff;
    e != 0 && e != 255
}
#[inline(always)]
fn finite(bits: u32) -> bool {
    bits & 0x7f80_0000 != 0x7f80_0000
}

/// One light's words as f64 / f32, or None when any float word is not
/// finite (that light then runs on Ext).
struct FastLight {
    lx: f64,
    ly: f64,
    lz: f64,
    radius_sq: f32,
    inv_r: f64,
    inv_r2: f32,
    distance_sq: f64,
    brightness: f64,
    inside: bool,
}
impl FastLight {
    fn new(light: &[u32]) -> Option<Self> {
        if !light[..8].iter().all(|&w| finite(w)) {
            return None;
        }
        let g = |i: usize| f32::from_bits(light[i]) as f64;
        Some(Self {
            lx: g(0),
            ly: g(1),
            lz: g(2),
            radius_sq: f32::from_bits(light[3]),
            inv_r: g(4),
            inv_r2: f32::from_bits(light[5]),
            distance_sq: g(6),
            brightness: g(7),
            inside: light[8] != 0,
        })
    }
}

/// `texel_index` where its result is certain: Some((index, flag after)), or
/// None to rerun the texel on Ext. Same operations, same early-exit order.
#[inline(always)]
fn texel_fast(l: &FastLight, px: f32, py: f32, pz: f32, first: bool, miss: u32) -> Option<(i32, u32)> {
    if !(px.is_finite() && py.is_finite() && pz.is_finite()) {
        return None;
    }
    let none = if first { 0 } else { -1 };
    let (x, y, z) = (px as f64, py as f64, pz as f64);
    // dot = st((pz*lz + py*ly) + px*lx): exact products, 2 roundings (4u).
    let (tz, ty, tx) = (z * l.lz, y * l.ly, x * l.lx);
    let dot = certain_f32((tz + ty) + tx, 4.0 * U * ((tz.abs() + ty.abs()) + tx.abs()) + TINY)?;
    if !l.inside && dot >= 0x8000_0000 {
        return Some((none, miss));
    }
    let dotf = f32::from_bits(dot);
    let dot64 = dotf as f64;
    // pp = (px^2 + pz^2) + py^2, unstored: 2 roundings over nonnegative
    // terms, so |pp - P| <= 2u'*pp in either model (u' its unit).
    let pp = (x * x + z * z) + y * y;
    let dd = dot64 * dot64; // exact
    if !(pp > 0.0) {
        return None;
    }
    if miss != 0 {
        // pp*distance_sq - dd > pp*radius_sq: 4 roundings on the left
        // (pp's two, the product, the difference), 3 on the right (8u).
        let pd = pp * l.distance_sq;
        let pr = pp * l.radius_sq as f64;
        let bound = 8.0 * U * ((pd.abs() + dd) + pr.abs()) + TINY;
        let margin = (pd - dd) - pr;
        if margin > bound {
            return Some((none, miss));
        }
        if !(margin < -bound) {
            return None;
        }
    }
    // h2 = st(distance_sq - dd/pp): pp's 2 roundings, the quotient and the
    // difference, 4 on |distance_sq| + dd/pp (8u).
    let q = dd / pp;
    let h2 = certain_f32(l.distance_sq - q, 8.0 * U * (l.distance_sq.abs() + q) + TINY)?;
    let h2f = f32::from_bits(h2);
    if !(l.radius_sq >= h2f) {
        return Some((none, 1));
    }
    // From here the flag is 0.
    let length = f32::from_bits(table_sqrt(certain_f32(pp, 4.0 * U * pp + TINY)?));
    let t = dotf / length;
    let wsq = l.radius_sq - h2f;
    if !(normal(length) && normal(t) && normal(wsq)) {
        return None;
    }
    let w = f32::from_bits(table_sqrt(wsq.to_bits()));
    let mut s = t - length;
    if !(normal(w) && normal(s)) {
        return None;
    }
    let neg_w = -w;
    let mut clamped = false;
    let far;
    if t > w {
        if s < neg_w {
            s = neg_w;
            clamped = true;
        }
        far = w;
    } else {
        if s < neg_w {
            s = neg_w;
        }
        far = t;
    }
    if !(s < far) {
        return Some((none, 0));
    }
    let hn = h2f * l.inv_r2; // st(h2*inv_r2): one rounding of an exact product
    if !hn.is_finite() {
        return None;
    }
    // The chord value: a = far/R, b = s/R exact; c = 3 - 3hn one rounding.
    // Unclamped v = (a(c - a^2) - (c - b^2)b)*brightness, clamped
    // v = 2((c - a^2)a*brightness), the doubling exact: at most 5 roundings
    // on the deepest path (8u on the absolute-value expression).
    let a = far as f64 * l.inv_r;
    let h3 = hn as f64 * 3.0;
    let c = 3.0 - h3;
    let c_abs = 3.0 + h3.abs();
    let aa = a * a;
    let (v, v_abs) = if clamped {
        let p = (c - aa) * a * l.brightness;
        (p + p, 2.0 * ((c_abs + aa) * a.abs() * l.brightness.abs()))
    } else {
        let b = s as f64 * l.inv_r;
        let bb = b * b;
        let outer = a * (c - aa);
        let inner = (c - bb) * b;
        ((outer - inner) * l.brightness, (a.abs() * (c_abs + aa) + (c_abs + bb) * b.abs()) * l.brightness.abs())
    };
    let bound = 8.0 * U * v_abs + TINY;
    // below(v, 0) needs a certain nonzero sign: a -0 passes it and then
    // stores as 0x80000000, which clamps to 1.0.
    if !(v > bound) {
        return if v < -bound { Some((none, 0)) } else { None };
    }
    if v - bound > CLAMP {
        return Some((255, 0)); // v = 1.0: fistp(st(255)) either way
    }
    if !(v + bound < CLAMP) {
        return None;
    }
    let scaled = if first {
        // st(v*255) of the unstored v: one more rounding (10u on 255|v|abs).
        certain_f32(v * 255.0, 10.0 * U * 255.0 * v_abs + TINY)?
    } else {
        // vf = st(v) is a nonzero normal here; st(vf*255) rounds an exact
        // product once.
        (f32::from_bits(certain_f32(v, bound)?) * 255.0).to_bits()
    };
    Some((fistp(scaled), 0))
}

#[no_mangle]
pub extern "C" fn fog_sqrt_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(SQRT) as *mut u32
}
#[no_mangle]
pub extern "C" fn fog_lights_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(LIGHTS) as *mut u32
}
#[no_mangle]
pub extern "C" fn fog_tables_ptr() -> *mut u8 {
    core::ptr::addr_of_mut!(TABLES) as *mut u8
}
#[no_mangle]
pub extern "C" fn fog_grid_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(GRID) as *mut u32
}
#[no_mangle]
pub extern "C" fn fog_out_ptr() -> *const u8 {
    core::ptr::addr_of!(OUT) as *const u8
}
#[no_mangle]
pub extern "C" fn fog_miss() -> u32 {
    unsafe { MISS }
}
#[no_mangle]
pub extern "C" fn fog_set_miss(value: u32) {
    unsafe { MISS = value }
}
/// Nonzero: run every texel on the Ext model (A/B and differential tests).
#[no_mangle]
pub extern "C" fn fog_set_exact(value: u32) {
    unsafe { EXACT = value }
}
/// Texels left to the Ext model by the fast path since the last reset.
#[no_mangle]
pub extern "C" fn fog_fallbacks() -> u32 {
    unsafe { FALLBACKS }
}
#[no_mangle]
pub extern "C" fn fog_reset_fallbacks() {
    unsafe { FALLBACKS = 0 }
}

const MODE_FAST: u8 = 0;
const MODE_EXACT: u8 = 1;
const MODE_CHECK: u8 = 2;

/// The fog loop for `count` lights already in depth order: BGRA texels at
/// OUT in rows of `width`. Returns 0 when the surface or light count is
/// larger than the static buffers.
#[no_mangle]
pub extern "C" fn fog_map(width: u32, height: u32, count: u32) -> u32 {
    let (width, height, count) = (width as usize, height as usize, count as usize);
    if width * height > MAX_TEXELS || count > MAX_LIGHTS || count == 0 {
        return 0;
    }
    unsafe {
        if EXACT != 0 {
            walk::<MODE_EXACT>(width, height, count);
        } else {
            walk::<MODE_FAST>(width, height, count);
        }
    }
    1
}

/// Validation only: the fog loop on Ext, with the fast path also run on every
/// texel from the same incoming flag. Returns the texels where the fast path
/// gave a result that differs from Ext's index or flag (u32::MAX for a
/// surface too large); its fallbacks count in `fog_fallbacks`. OUT and the
/// flag end as `fog_map` on Ext leaves them, so equal results on every texel
/// make the whole flag sequence equal.
#[no_mangle]
pub extern "C" fn fog_check(width: u32, height: u32, count: u32) -> u32 {
    let (width, height, count) = (width as usize, height as usize, count as usize);
    if width * height > MAX_TEXELS || count > MAX_LIGHTS || count == 0 {
        return u32::MAX;
    }
    unsafe { walk::<MODE_CHECK>(width, height, count) }
}

unsafe fn walk<const MODE: u8>(width: usize, height: usize, count: usize) -> u32 {
    let lights = &*core::ptr::addr_of!(LIGHTS);
    let tables = &*core::ptr::addr_of!(TABLES);
    let grid = &*core::ptr::addr_of!(GRID);
    let out = &mut *core::ptr::addr_of_mut!(OUT);
    let mut miss = MISS;
    let (mut fallbacks, mut mismatches) = (0u32, 0u32);
    let attenuation = |a: usize, v: usize| ((127 - a) * v / 127) as u8;
    for (k, light) in lights.chunks(LIGHT_WORDS).take(count).enumerate() {
        let first = k == 0;
        let fast = if MODE == MODE_EXACT { None } else { FastLight::new(light) };
        let table = &tables[k * 1024..k * 1024 + 1024];
        let (mut rx, mut ry, mut rz) = (f32::from_bits(grid[0]), f32::from_bits(grid[1]), f32::from_bits(grid[2]));
        let (ux, uy, uz) = (f32::from_bits(grid[3]), f32::from_bits(grid[4]), f32::from_bits(grid[5]));
        let (vx, vy, vz) = (f32::from_bits(grid[6]), f32::from_bits(grid[7]), f32::from_bits(grid[8]));
        for v in 0..height {
            let (mut px, mut py, mut pz) = (rx, ry, rz);
            for u in 0..width {
                let index = if MODE == MODE_CHECK {
                    let incoming = miss;
                    let exact = texel_index(light, px.to_bits(), py.to_bits(), pz.to_bits(), first, &mut miss);
                    match fast.as_ref().and_then(|l| texel_fast(l, px, py, pz, first, incoming)) {
                        Some(result) => mismatches += u32::from(result != (exact, miss)),
                        None => fallbacks += 1,
                    }
                    exact
                } else {
                    match fast.as_ref().and_then(|l| texel_fast(l, px, py, pz, first, miss)) {
                        Some((index, flag)) => {
                            miss = flag;
                            index
                        }
                        None => {
                            fallbacks += u32::from(MODE != MODE_EXACT);
                            texel_index(light, px.to_bits(), py.to_bits(), pz.to_bits(), first, &mut miss)
                        }
                    }
                };
                let at = (v * width + u) * 4;
                if first {
                    let i = index as usize * 4;
                    out[at..at + 4].copy_from_slice(&table[i..i + 4]);
                } else if index >= 0 {
                    let i = index as usize * 4;
                    let alpha = table[i + 3] as usize;
                    for c in 0..3 {
                        out[at + c] = (attenuation(alpha, out[at + c] as usize) as u32 + table[i + c] as u32).min(127) as u8;
                    }
                    out[at + 3] = (out[at + 3] as u32 + alpha as u32).min(127) as u8;
                }
                px = ux + px;
                py = uy + py;
                pz = pz + uz;
            }
            rx = vx + rx;
            ry = ry + vy;
            rz = rz + vz;
        }
    }
    MISS = miss;
    FALLBACKS = FALLBACKS.wrapping_add(fallbacks);
    mismatches
}
