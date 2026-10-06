//! Render.dll volumetric fog maps (docs/volumetric-fog.md): SetupForSurf's
//! per-light fog loop 0x10b073bb-0x10b07c44 at the render pass's precision
//! control 24 (docs/render-pass-precision.md). The Rust counterpart of
//! src/runtime/volumetric-fog.mjs `fogMap`; validate-volumetric-fog.mjs
//! compares both with the original at control word 0x007f. JavaScript
//! prepares the per-light constants and colour tables (`volumetricLight`)
//! and the camera-space grid; this loop is the per-texel work.
use crate::p24;
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
/// Nonzero: every texel on `Exact`, the Ext model rounded to 24 bits
/// (`fog_set_exact`, FOG_EXACT=1).
static mut EXACT: u32 = 0;
/// Texels with a non-finite input, run on `Exact` (`fog_fallbacks`).
static mut FALLBACKS: u32 = 0;
/// Texels `Single` handed to `Wide` (`fog_reruns`, diagnostics).
static mut RERUNS: u32 = 0;

const F_ZERO: u32 = 0;
const F_ONE: u32 = 0x3f80_0000;
const F_THREE: u32 = 0x4040_0000;
const F_255: u32 = 0x437f_0000;

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

/// An x87 register under precision control 24: every arithmetic result is
/// rounded to a 24-bit significand with the x87's exponent range. Every
/// operand here is a loaded f32, one of the constants 0, 1, 3 and 255, or
/// an earlier result, so all are 24-bit values. Three models:
/// - `Single`: native f32 arithmetic, which is the PC 24 result while no
///   product or quotient leaves binary32's normal range (a sum of floats
///   whose exact value is subnormal is exact, so sums need no test). A
///   product or quotient at or below 2^-126 (binary32 rounds just below it
///   on a coarser grid than PC 24) that is not an exact zero sets `bad`
///   and the texel reruns on `Wide`; overflow is excluded by the input
///   bounds `single_light`/`single_texel` check (the largest intermediate
///   is then below 2^126).
/// - `Wide`: an f64 rounded with p24.rs's `r24`, exact for finite operands.
/// - `Exact`: the Ext model rounded to 24 bits after each operation, which
///   also carries the x87's NaN and infinity rules (non-finite inputs).
trait Reg: Copy {
    fn ld(bits: u32) -> Self;
    fn add(self, other: Self) -> Self;
    fn sub(self, other: Self) -> Self;
    fn mul(self, other: Self, bad: &mut bool) -> Self;
    fn div(self, other: Self, bad: &mut bool) -> Self;
    /// FST/FSTP m32.
    fn st(self) -> u32;
    /// FCOM's C0: below or unordered.
    fn below(self, other: Self) -> bool;
    /// Neither below, equal nor unordered.
    fn greater(self, other: Self) -> bool;
}

#[derive(Clone, Copy)]
struct Single(f32);
const MIN_NORMAL: f32 = f32::MIN_POSITIVE;
impl Reg for Single {
    #[inline(always)]
    fn ld(bits: u32) -> Self {
        Single(f32::from_bits(bits))
    }
    #[inline(always)]
    fn add(self, o: Self) -> Self {
        Single(self.0 + o.0)
    }
    #[inline(always)]
    fn sub(self, o: Self) -> Self {
        Single(self.0 - o.0)
    }
    #[inline(always)]
    fn mul(self, o: Self, bad: &mut bool) -> Self {
        let r = self.0 * o.0;
        // Branch-free; an exact zero product (a zero operand) also reruns.
        *bad |= r.abs() <= MIN_NORMAL;
        Single(r)
    }
    #[inline(always)]
    fn div(self, o: Self, bad: &mut bool) -> Self {
        let r = self.0 / o.0;
        *bad |= r.abs() <= MIN_NORMAL;
        Single(r)
    }
    #[inline(always)]
    fn st(self) -> u32 {
        self.0.to_bits()
    }
    #[inline(always)]
    fn below(self, o: Self) -> bool {
        !(self.0 >= o.0)
    }
    #[inline(always)]
    fn greater(self, o: Self) -> bool {
        self.0 > o.0
    }
}
/// `Single` cannot overflow for a light whose words are within these bounds
/// (|L| <= 2^30, R² and |L|² <= 2^62, 1/R and 1/R² <= 1, brightness <= 2^8)
/// and a texel within |P| <= 2^30: dot and pp stay below 2^62, dd, pp·|L|²
/// and pp·R² below 2^124, the chord terms below 2^107 (far <= w <= 2^32).
#[inline(always)]
fn single_light(light: &[u32]) -> bool {
    let w = |i: usize| f32::from_bits(light[i]).abs();
    let (l30, l62) = (1073741824.0f32, 4.611686e18f32);
    w(0) <= l30 && w(1) <= l30 && w(2) <= l30 && w(3) <= l62 && w(6) <= l62 && w(4) <= 1.0 && w(5) <= 1.0 && w(7) <= 256.0
}
#[inline(always)]
fn single_texel(px: f32, py: f32, pz: f32) -> bool {
    let l30 = 1073741824.0f32;
    px.abs() <= l30 && py.abs() <= l30 && pz.abs() <= l30
}

#[derive(Clone, Copy)]
struct Wide(f64);
impl Reg for Wide {
    #[inline(always)]
    fn ld(bits: u32) -> Self {
        Wide(p24::ld(bits))
    }
    #[inline(always)]
    fn add(self, o: Self) -> Self {
        Wide(p24::add(self.0, o.0))
    }
    #[inline(always)]
    fn sub(self, o: Self) -> Self {
        Wide(p24::sub(self.0, o.0))
    }
    #[inline(always)]
    fn mul(self, o: Self, _: &mut bool) -> Self {
        Wide(p24::mul(self.0, o.0))
    }
    #[inline(always)]
    fn div(self, o: Self, _: &mut bool) -> Self {
        Wide(p24::div(self.0, o.0))
    }
    #[inline(always)]
    fn st(self) -> u32 {
        p24::st(self.0)
    }
    #[inline(always)]
    fn below(self, o: Self) -> bool {
        !(self.0 >= o.0)
    }
    #[inline(always)]
    fn greater(self, o: Self) -> bool {
        self.0 > o.0
    }
}

#[derive(Clone, Copy)]
struct Exact(Ext);
impl Reg for Exact {
    fn ld(bits: u32) -> Self {
        Exact(Ext::load(bits))
    }
    fn add(self, o: Self) -> Self {
        Exact(self.0.add(o.0).round24())
    }
    fn sub(self, o: Self) -> Self {
        Exact(self.0.add(o.0.neg()).round24())
    }
    fn mul(self, o: Self, _: &mut bool) -> Self {
        Exact(self.0.mul(o.0).round24())
    }
    fn div(self, o: Self, _: &mut bool) -> Self {
        Exact(self.0.div(o.0).round24())
    }
    fn st(self) -> u32 {
        self.0.store()
    }
    fn below(self, o: Self) -> bool {
        self.0.compare(o.0).0
    }
    fn greater(self, o: Self) -> bool {
        let (c0, c3) = self.0.compare(o.0);
        !c0 && !c3
    }
}

/// One texel's colour-table index, or -1 for a later light's skip
/// (0x10b075dc-0x10b07824 / 0x10b078f3-0x10b07b07).
#[inline(always)]
fn texel_index<R: Reg>(light: &[u32], px: u32, py: u32, pz: u32, first: bool, miss: &mut u32, bad: &mut bool) -> i32 {
    let ld = R::ld;
    let none = if first { 0 } else { -1 };
    let (lx, ly, lz) = (light[0], light[1], light[2]);
    let (radius_sq, inv_r, inv_r2, distance_sq, brightness, inside) =
        (light[3], light[4], light[5], light[6], light[7], light[8]);
    let dot = ld(pz).mul(ld(lz), bad).add(ld(py).mul(ld(ly), bad)).add(ld(px).mul(ld(lx), bad)).st();
    if inside == 0 && dot >= 0x8000_0000 {
        return none;
    }
    let pp = ld(px).mul(ld(px), bad).add(ld(pz).mul(ld(pz), bad)).add(ld(py).mul(ld(py), bad));
    let dd = ld(dot).mul(ld(dot), bad);
    if *miss != 0 && pp.mul(ld(distance_sq), bad).sub(dd).greater(pp.mul(ld(radius_sq), bad)) {
        return none;
    }
    let h2 = ld(distance_sq).sub(dd.div(pp, bad)).st();
    if ld(radius_sq).below(ld(h2)) {
        *miss = 1;
        return none;
    }
    *miss = 0;
    let length = table_sqrt(pp.st());
    let t = ld(dot).div(ld(length), bad).st();
    let w = table_sqrt(ld(radius_sq).sub(ld(h2)).st());
    let mut s = ld(t).sub(ld(length)).st();
    let neg_w = w ^ 0x8000_0000;
    let mut clamped = false;
    let far;
    if ld(t).greater(ld(w)) {
        if ld(s).below(ld(neg_w)) {
            s = neg_w;
            clamped = true;
        }
        far = w;
    } else {
        if ld(s).below(ld(neg_w)) {
            s = neg_w;
        }
        far = t;
    }
    if !ld(s).below(ld(far)) {
        return none;
    }
    let hn = ld(h2).mul(ld(inv_r2), bad).st();
    let a = ld(far).mul(ld(inv_r), bad);
    let c = ld(F_THREE).sub(ld(hn).mul(ld(F_THREE), bad));
    let mut v = if clamped {
        let p = c.sub(a.mul(a, bad)).mul(a, bad).mul(ld(brightness), bad);
        p.add(p)
    } else {
        let b = ld(s).mul(ld(inv_r), bad);
        let outer = a.mul(c.sub(a.mul(a, bad)), bad);
        outer.sub(c.sub(b.mul(b, bad)).mul(b, bad)).mul(ld(brightness), bad)
    };
    if v.below(ld(F_ZERO)) {
        return none;
    }
    // A -0 passes the test above, stores as 0x80000000 and clamps to 1.0.
    if v.st() >= F_ONE {
        v = ld(F_ONE);
    }
    if first {
        return fistp(v.mul(ld(F_255), bad).st());
    }
    let vf = v.st();
    if vf == 0 {
        return -1;
    }
    fistp(ld(vf).mul(ld(F_255), bad).st())
}

/// The f32 FST stores when every real within `bound` of `value` rounds,
/// nearest-even, to that one normal f32 (x87-fast.mjs unambiguousF32). None
/// for zero, subnormal, top-binade or non-finite results. Used by level.rs
/// (the 64-bit fog loop's certified fast path, which this helper served,
/// went with the move to precision control 24).
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
fn finite(bits: u32) -> bool {
    bits & 0x7f80_0000 != 0x7f80_0000
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
/// Nonzero: run every texel on `Exact` (A/B and differential tests).
#[no_mangle]
pub extern "C" fn fog_set_exact(value: u32) {
    unsafe { EXACT = value }
}
/// Texels run on `Exact` for a non-finite input since the last reset.
#[no_mangle]
pub extern "C" fn fog_fallbacks() -> u32 {
    unsafe { FALLBACKS }
}
#[no_mangle]
pub extern "C" fn fog_reset_fallbacks() {
    unsafe {
        FALLBACKS = 0;
        RERUNS = 0;
    }
}
/// Texels `Single` reran on `Wide` since the last reset.
#[no_mangle]
pub extern "C" fn fog_reruns() -> u32 {
    unsafe { RERUNS }
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

/// Validation only: the fog loop on `Exact`, with `Wide` also run on every
/// finite texel from the same incoming flag. Returns the texels where the
/// two differ in index or flag (u32::MAX for a surface too large); texels
/// with a non-finite input count in `fog_fallbacks`. OUT and the flag end
/// as `fog_map` on `Exact` leaves them.
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
        let light_finite = light[..8].iter().all(|&w| finite(w));
        let light_single = light_finite && single_light(light);
        let table = &tables[k * 1024..k * 1024 + 1024];
        let (mut rx, mut ry, mut rz) = (f32::from_bits(grid[0]), f32::from_bits(grid[1]), f32::from_bits(grid[2]));
        let (ux, uy, uz) = (f32::from_bits(grid[3]), f32::from_bits(grid[4]), f32::from_bits(grid[5]));
        let (vx, vy, vz) = (f32::from_bits(grid[6]), f32::from_bits(grid[7]), f32::from_bits(grid[8]));
        for v in 0..height {
            let (mut px, mut py, mut pz) = (rx, ry, rz);
            for u in 0..width {
                let (bx, by, bz) = (px.to_bits(), py.to_bits(), pz.to_bits());
                let wide = MODE != MODE_EXACT && light_finite && finite(bx) && finite(by) && finite(bz);
                let single = wide && light_single && single_texel(px, py, pz);
                let mut bad = false;
                let index = if MODE == MODE_CHECK {
                    // Exact is the reference; Wide and Single (where they
                    // apply) must give its index and flag.
                    let incoming = miss;
                    let exact = texel_index::<Exact>(light, bx, by, bz, first, &mut miss, &mut bad);
                    if wide {
                        let mut flag = incoming;
                        let index = texel_index::<Wide>(light, bx, by, bz, first, &mut flag, &mut bad);
                        mismatches += u32::from((index, flag) != (exact, miss));
                        if single {
                            let mut flag = incoming;
                            let index = texel_index::<Single>(light, bx, by, bz, first, &mut flag, &mut bad);
                            mismatches += u32::from(!bad && (index, flag) != (exact, miss));
                        }
                    } else {
                        fallbacks += 1;
                    }
                    exact
                } else if single {
                    let incoming = miss;
                    let index = texel_index::<Single>(light, bx, by, bz, first, &mut miss, &mut bad);
                    if bad {
                        RERUNS = RERUNS.wrapping_add(1);
                        miss = incoming;
                        texel_index::<Wide>(light, bx, by, bz, first, &mut miss, &mut bad)
                    } else {
                        index
                    }
                } else if wide {
                    texel_index::<Wide>(light, bx, by, bz, first, &mut miss, &mut bad)
                } else {
                    fallbacks += u32::from(MODE != MODE_EXACT);
                    texel_index::<Exact>(light, bx, by, bz, first, &mut miss, &mut bad)
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
                // The grid steps are f32 stores of f32 sums (exact at any
                // precision control).
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
