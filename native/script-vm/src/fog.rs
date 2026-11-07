//! Render.dll volumetric fog maps (docs/volumetric-fog.md): SetupForSurf's
//! per-light fog loop 0x10b073bb-0x10b07c44 at the render pass's precision
//! control 24 (docs/render-pass-precision.md). The Rust counterpart of
//! src/runtime/volumetric-fog.mjs `fogMap`; validate-volumetric-fog.mjs
//! compares both with the original at control word 0x007f. JavaScript
//! prepares the per-light constants and colour tables (`volumetricLight`)
//! and the camera-space grid; this loop is the per-texel work.
//!
//! Two loops answer `fog_map` with the same bytes: `walk`, the reference (one
//! texel at a time per light, the translation of the original's loop), and
//! `walk_blocks` (2026-11-07), which makes the light-independent terms once per
//! surface and classifies four texels at a time on wasm simd128 with the same
//! IEEE binary32 operations; `fog_verify` runs both and compares them.
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
/// 16-byte aligned, so that the host reads the map through 32-bit views.
#[repr(C, align(16))]
struct Aligned<const N: usize>([u8; N]);
static mut OUT: Aligned<{ MAX_TEXELS * 4 }> = Aligned([0; MAX_TEXELS * 4]);
#[inline(always)]
unsafe fn out_bytes() -> &'static mut [u8] {
    &mut (*core::ptr::addr_of_mut!(OUT)).0
}
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
    let (radius_sq, distance_sq, inside) = (light[3], light[6], light[8]);
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
    texel_tail(light, dot, pp, h2, first, bad)
}

/// The rest of a texel that passed the miss test (the chord, from
/// `length = table_sqrt(PP)` on): `dot` and `h2` as stored, `pp` the register.
#[inline(always)]
fn texel_tail<R: Reg>(light: &[u32], dot: u32, pp: R, h2: u32, first: bool, bad: &mut bool) -> i32 {
    let ld = R::ld;
    let none = if first { 0 } else { -1 };
    let (radius_sq, inv_r, inv_r2, brightness) = (light[3], light[4], light[5], light[7]);
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

/// Which loop answers `fog_map` outside `Exact`: 0 the reference loop (`walk`, one texel at a time per
/// light), 1 the block loop (`walk_blocks`: the same arithmetic on four texels at once, the light-independent
/// terms made once per surface). Both give the same bytes and the same final flag (fog_verify).
static mut PATH: u32 = 1;
/// Surfaces `walk_blocks` answered, surfaces it declined (larger than its scratch, or a first colour table
/// whose entry 0 is not zero), blocks it handed to the scalar body, blocks it classified.
static mut BLOCK_STATS: [u32; 4] = [0; 4];

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
        } else if PATH == 0 || !walk_blocks(width, height, count) {
            walk::<MODE_FAST>(width, height, count);
        }
    }
    1
}

/// 0: the reference loop answers `fog_map`; anything else: the block loop.
#[no_mangle]
pub extern "C" fn fog_set_path(path: u32) {
    unsafe { PATH = path }
}
/// `walk_blocks` counters since the last `fog_reset_block_stats`: surfaces, declined, scalar blocks, blocks.
#[no_mangle]
pub extern "C" fn fog_block_stat(which: u32) -> u32 {
    unsafe { BLOCK_STATS[(which & 3) as usize] }
}
#[no_mangle]
pub extern "C" fn fog_reset_block_stats() {
    unsafe { BLOCK_STATS = [0; 4] }
}

/// Validation only: the block loop and then the reference loop from the same incoming flag. Returns the number of
/// differing bytes of the two maps, plus one if the final flags differ, plus 0x1000_0000 if the block loop
/// declined the surface (then nothing was compared). A map of more than `FAST_TEXELS` texels is compared by two
/// 32-bit hash lanes over its words (a difference counts one). OUT and the flag end as the reference loop leaves them (the same
/// as the block loop's when nothing differs).
#[no_mangle]
pub extern "C" fn fog_verify(width: u32, height: u32, count: u32) -> u32 {
    let (width, height, count) = (width as usize, height as usize, count as usize);
    if width * height > MAX_TEXELS || count > MAX_LIGHTS || count == 0 {
        return 0x1000_0000;
    }
    unsafe {
        let start = MISS;
        if !walk_blocks(width, height, count) {
            return 0x1000_0000;
        }
        let out = out_bytes();
        let (flag, bytes) = (MISS, width * height * 4);
        let small = width * height <= FAST_TEXELS;
        let kept_hash = hash_words(&out[..bytes]);
        if small {
            let kept = &mut *core::ptr::addr_of_mut!(OUT_KEPT);
            kept[..bytes].copy_from_slice(&out[..bytes]);
        }
        MISS = start;
        walk::<MODE_FAST>(width, height, count);
        let mut differ = u32::from(MISS != flag);
        if small {
            let kept = &*core::ptr::addr_of!(OUT_KEPT);
            for i in 0..bytes {
                differ += u32::from(out[i] != kept[i]);
            }
        } else {
            differ += u32::from(hash_words(&out[..bytes]) != kept_hash);
        }
        MISS = flag;
        differ
    }
}

/// Two independent 32-bit lanes over a byte slice's words (validation only).
fn hash_words(bytes: &[u8]) -> (u32, u32) {
    let (mut a, mut b) = (0x811c_9dc5u32, 0x9e37_79b9u32);
    for word in bytes.chunks_exact(4) {
        let x = u32::from_le_bytes([word[0], word[1], word[2], word[3]]);
        a = (a ^ x).wrapping_mul(16_777_619);
        b = (b.wrapping_add(x) ^ (b >> 15)).wrapping_mul(0x85eb_ca6b);
    }
    (a, b)
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

/// One texel's colour-table index through the register models (non-CHECK modes): `Single` while its inputs
/// are inside its bounds, `Wide` for a texel (or rerun) it cannot hold, `Exact` for a non-finite input.
#[inline(always)]
fn dispatch<const MODE: u8>(
    light: &[u32], light_finite: bool, light_single: bool, p: (f32, f32, f32), first: bool, miss: &mut u32,
    fallbacks: &mut u32,
) -> i32 {
    let (bx, by, bz) = (p.0.to_bits(), p.1.to_bits(), p.2.to_bits());
    let wide = MODE != MODE_EXACT && light_finite && finite(bx) && finite(by) && finite(bz);
    let single = wide && light_single && single_texel(p.0, p.1, p.2);
    let mut bad = false;
    if single {
        let incoming = *miss;
        let index = texel_index::<Single>(light, bx, by, bz, first, miss, &mut bad);
        if bad {
            unsafe { RERUNS = RERUNS.wrapping_add(1) };
            *miss = incoming;
            texel_index::<Wide>(light, bx, by, bz, first, miss, &mut bad)
        } else {
            index
        }
    } else if wide {
        texel_index::<Wide>(light, bx, by, bz, first, miss, &mut bad)
    } else {
        *fallbacks += u32::from(MODE != MODE_EXACT);
        texel_index::<Exact>(light, bx, by, bz, first, miss, &mut bad)
    }
}

/// `dispatch` out of line, for the block loop's scalar paths (blocks with a texel outside `Single`'s bounds, a light outside them):
/// one copy of the three register models for all of them.
#[inline(never)]
fn dispatch_fast(
    light: &[u32], light_finite: bool, light_single: bool, p: (f32, f32, f32), first: bool, miss: &mut u32, fallbacks: &mut u32,
) -> i32 {
    dispatch::<MODE_FAST>(light, light_finite, light_single, p, first, miss, fallbacks)
}

/// A texel's colour-table index into the map: the first light writes its table entry, later lights blend
/// theirs over what is there (-1: nothing).
#[inline(always)]
fn put(out: &mut [u8], at: usize, table: &[u8], index: i32, first: bool) {
    let attenuation = |a: usize, v: usize| ((127 - a) * v / 127) as u8;
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
}

/// Texels the block loop holds: its scratch is four f32 arrays of this length (a multiple of four).
const FAST_TEXELS: usize = 8192;
/// The surface's camera-space texel positions and PP = (Px² + Pz²) + Py², made once per surface and padded to a
/// whole block with copies of the last texel.
static mut PX: [f32; FAST_TEXELS] = [0.0; FAST_TEXELS];
static mut PY: [f32; FAST_TEXELS] = [0.0; FAST_TEXELS];
static mut PZ: [f32; FAST_TEXELS] = [0.0; FAST_TEXELS];
static mut PP: [f32; FAST_TEXELS] = [0.0; FAST_TEXELS];
/// Per block of four texels: 1 when the four are finite, within |P| <= 2^30 and have no square at or below
/// binary32's smallest normal (the bounds `Single` holds); a block without it goes to the scalar body.
static mut BLOCK_OK: [u8; FAST_TEXELS / 4] = [0; FAST_TEXELS / 4];
/// `fog_verify`'s copy of the block loop's map.
static mut OUT_KEPT: [u8; FAST_TEXELS * 4] = [0; FAST_TEXELS * 4];

/// Texels of the map before the band the scratch holds (the scratch holds whole rows of a surface larger than itself, a band at a time).
static mut BAND_BASE: usize = 0;
/// A surface larger than the scratch is run in bands of whole rows; at most this many.
const MAX_BANDS: usize = 32;

/// The block loop: the reference loop's arithmetic with its light-independent terms made once per surface and
/// four texels classified at a time (wasm simd128; the same IEEE binary32 operations, so the same bits). A
/// texel is `A` (the light is behind the ray: no change), a miss (`h² > R²`: the flag becomes 1) or a hit that
/// runs the chord on the scalar tail; the early-out flag follows the texels in order (`A` leaves it, a miss
/// sets it, a hit clears it, and a hit the quick test drops while the flag is set leaves it). A block with a
/// product or quotient at binary32's smallest normal or below, or with a texel outside `Single`'s bounds, runs
/// the reference body on its texels. The map starts clear: the first light writes `table[0]` (all zero) for
/// every texel it does not hit, so only its hits are written. A surface larger than the scratch is done in
/// bands of whole rows, each light running its bands in order (the lattice of a band is made again for each
/// light, from the row starts kept once). Returns false, with nothing changed, for a surface wider than the
/// scratch or with more bands than `MAX_BANDS`, or a first table whose entry 0 is not zero.
unsafe fn walk_blocks(width: usize, height: usize, count: usize) -> bool {
    let n = width * height;
    let tables = &*core::ptr::addr_of!(TABLES);
    let rows = (FAST_TEXELS / width.max(1)).max(1).min(height);
    let bands = (height + rows - 1) / rows;
    if width > FAST_TEXELS || bands > MAX_BANDS || tables[..4] != [0; 4] {
        BLOCK_STATS[1] = BLOCK_STATS[1].wrapping_add(1);
        return false;
    }
    let lights = &*core::ptr::addr_of!(LIGHTS);
    let grid = &*core::ptr::addr_of!(GRID);
    let out = out_bytes();
    let (vx, vy, vz) = (f32::from_bits(grid[6]), f32::from_bits(grid[7]), f32::from_bits(grid[8]));
    // The row starts of each band: the base plus the V step added once per row, as the reference loop does.
    let mut starts = [(0.0f32, 0.0f32, 0.0f32); MAX_BANDS];
    {
        let (mut rx, mut ry, mut rz) = (f32::from_bits(grid[0]), f32::from_bits(grid[1]), f32::from_bits(grid[2]));
        for band in 0..bands {
            starts[band] = (rx, ry, rz);
            for _ in 0..rows.min(height - band * rows) {
                rx = vx + rx;
                ry = ry + vy;
                rz = rz + vz;
            }
        }
    }
    out[..n * 4].fill(0);
    let mut miss = MISS;
    let mut fallbacks = 0u32;
    if bands == 1 {
        fill_band(starts[0], width, height);
    }
    for (k, light) in lights.chunks(LIGHT_WORDS).take(count).enumerate() {
        let first = k == 0;
        let table = &tables[k * 1024..k * 1024 + 1024];
        let light_finite = light[..8].iter().all(|&w| finite(w));
        let light_single = light_finite && single_light(light);
        for band in 0..bands {
            let band_rows = rows.min(height - band * rows);
            if bands > 1 {
                fill_band(starts[band], width, band_rows);
            }
            BAND_BASE = band * rows * width;
            let texels = band_rows * width;
            if light_single {
                light_blocks(light, table, first, texels, &mut miss, &mut fallbacks);
            } else {
                scalar_light(light, table, first, light_finite, texels, &mut miss, &mut fallbacks);
            }
        }
    }
    BAND_BASE = 0;
    MISS = miss;
    FALLBACKS = FALLBACKS.wrapping_add(fallbacks);
    BLOCK_STATS[0] = BLOCK_STATS[0].wrapping_add(1);
    true
}

/// The scratch for `rows` whole rows from the row start `start`: the lattice by the reference loop's additions,
/// PP, the padding of the last block and the block flags.
unsafe fn fill_band(start: (f32, f32, f32), width: usize, rows: usize) {
    let grid = &*core::ptr::addr_of!(GRID);
    let (px, py, pz, pp) = (
        &mut *core::ptr::addr_of_mut!(PX),
        &mut *core::ptr::addr_of_mut!(PY),
        &mut *core::ptr::addr_of_mut!(PZ),
        &mut *core::ptr::addr_of_mut!(PP),
    );
    let ok = &mut *core::ptr::addr_of_mut!(BLOCK_OK);
    let (mut rx, mut ry, mut rz) = start;
    let (ux, uy, uz) = (f32::from_bits(grid[3]), f32::from_bits(grid[4]), f32::from_bits(grid[5]));
    let (vx, vy, vz) = (f32::from_bits(grid[6]), f32::from_bits(grid[7]), f32::from_bits(grid[8]));
    let mut at = 0;
    for _ in 0..rows {
        let (mut x, mut y, mut z) = (rx, ry, rz);
        for _ in 0..width {
            px[at] = x;
            py[at] = y;
            pz[at] = z;
            at += 1;
            x = ux + x;
            y = uy + y;
            z = z + uz;
        }
        rx = vx + rx;
        ry = ry + vy;
        rz = rz + vz;
    }
    let n = at;
    let padded = (n + 3) / 4 * 4;
    for i in n..padded {
        px[i] = px[n - 1];
        py[i] = py[n - 1];
        pz[i] = pz[n - 1];
    }
    for b in 0..padded / 4 {
        let mut good = true;
        for i in b * 4..b * 4 + 4 {
            let (x, y, z) = (px[i], py[i], pz[i]);
            let (a, c, d) = (x * x, z * z, y * y);
            pp[i] = (a + c) + d;
            good &= single_texel(x, y, z) && a.abs() > f32::MIN_POSITIVE && c.abs() > f32::MIN_POSITIVE && d.abs() > f32::MIN_POSITIVE;
        }
        ok[b] = good as u8;
    }
}

/// A light outside `Single`'s bounds over the `n` texels of the scratch: the reference body on each.
unsafe fn scalar_light(light: &[u32], table: &[u8], first: bool, light_finite: bool, n: usize, miss: &mut u32, fallbacks: &mut u32) {
    let (px, py, pz) = (&*core::ptr::addr_of!(PX), &*core::ptr::addr_of!(PY), &*core::ptr::addr_of!(PZ));
    let out = &mut out_bytes()[BAND_BASE * 4..];
    for i in 0..n {
        let index = dispatch_fast(light, light_finite, false, (px[i], py[i], pz[i]), first, miss, fallbacks);
        put(out, i * 4, table, index, first);
    }
}

/// The reference body on texels `from..to` of the scratch, for a light inside `Single`'s bounds.
#[inline(always)]
unsafe fn scalar_texels(light: &[u32], table: &[u8], first: bool, from: usize, to: usize, miss: &mut u32, fallbacks: &mut u32) {
    let (px, py, pz) = (&*core::ptr::addr_of!(PX), &*core::ptr::addr_of!(PY), &*core::ptr::addr_of!(PZ));
    let out = &mut out_bytes()[BAND_BASE * 4..];
    for i in from..to {
        let index = dispatch_fast(light, true, true, (px[i], py[i], pz[i]), first, miss, fallbacks);
        put(out, i * 4, table, index, first);
    }
}

#[inline(never)]
fn texel_index_wide(light: &[u32], px: u32, py: u32, pz: u32, first: bool, miss: &mut u32, bad: &mut bool) -> i32 {
    texel_index::<Wide>(light, px, py, pz, first, miss, bad)
}

/// A hit (the light not behind texel `i`, and `h² <= R²`), from the classification's stored `dot` and `h2`: the quick
/// test while the flag is set, then the chord on `Single`. A product at or below the smallest normal reruns the
/// whole texel through the reference body from the flag it came in with.
#[inline(always)]
unsafe fn hit(light: &[u32], table: &[u8], first: bool, i: usize, dot: u32, h2: u32, miss: &mut u32) {
    let (px, py, pz, pp) = (
        &*core::ptr::addr_of!(PX),
        &*core::ptr::addr_of!(PY),
        &*core::ptr::addr_of!(PZ),
        &*core::ptr::addr_of!(PP),
    );
    let out = &mut out_bytes()[BAND_BASE * 4..];
    let incoming = *miss;
    let mut bad = false;
    if incoming != 0 {
        // The quick test (Render.dll's second miss test while the flag is set): PP·|L|² − dot² > PP·R² drops the texel
        // and leaves the flag set.
        let (d, q) = (Single::ld(dot), Single(pp[i]));
        let quick = q.mul(Single::ld(light[6]), &mut bad).sub(d.mul(d, &mut bad)).greater(q.mul(Single::ld(light[3]), &mut bad));
        if !bad && quick {
            return;
        }
    }
    let mut index = 0;
    if !bad {
        *miss = 0;
        index = texel_tail::<Single>(light, dot, Single(pp[i]), h2, first, &mut bad);
    }
    if bad {
        RERUNS = RERUNS.wrapping_add(1);
        *miss = incoming;
        let mut again = false;
        index = texel_index_wide(light, px[i].to_bits(), py[i].to_bits(), pz[i].to_bits(), first, miss, &mut again);
    }
    put(out, i * 4, table, index, first);
}

#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn light_blocks(light: &[u32], table: &[u8], first: bool, n: usize, miss: &mut u32, fallbacks: &mut u32) {
    use core::arch::wasm32::*;
    let w = |i: usize| f32::from_bits(light[i]);
    let (lx, ly, lz, rsq, dsq) = (f32x4_splat(w(0)), f32x4_splat(w(1)), f32x4_splat(w(2)), f32x4_splat(w(3)), f32x4_splat(w(6)));
    let inside = light[8] != 0;
    let tiny = f32x4_splat(f32::MIN_POSITIVE);
    let (px, py, pz, pp) = (
        core::ptr::addr_of!(PX) as *const f32,
        core::ptr::addr_of!(PY) as *const f32,
        core::ptr::addr_of!(PZ) as *const f32,
        core::ptr::addr_of!(PP) as *const f32,
    );
    let ok = &*core::ptr::addr_of!(BLOCK_OK);
    let blocks = (n + 3) / 4;
    let mut scalar = 0u32;
    for b in 0..blocks {
        let i = b * 4;
        // The lanes of the block that are texels (the last block of a surface may be short; its other lanes copy the last texel).
        let valid: u32 = if i + 4 <= n { 0xf } else { (1u32 << (n - i)) - 1 };
        if ok[b] == 0 {
            scalar += 1;
            scalar_texels(light, table, first, i, n.min(i + 4), miss, fallbacks);
            continue;
        }
        let (x, y, z) = (
            v128_load(px.add(i) as *const v128),
            v128_load(py.add(i) as *const v128),
            v128_load(pz.add(i) as *const v128),
        );
        let (t1, t2, t3) = (f32x4_mul(z, lz), f32x4_mul(y, ly), f32x4_mul(x, lx));
        let dot = f32x4_add(f32x4_add(t1, t2), t3);
        // The products of the dot are formed for every texel, the light behind it or not.
        let smallest = f32x4_min(f32x4_min(f32x4_abs(t1), f32x4_abs(t2)), f32x4_abs(t3));
        if i32x4_bitmask(f32x4_le(smallest, tiny)) as u32 & valid != 0 {
            scalar += 1;
            scalar_texels(light, table, first, i, n.min(i + 4), miss, fallbacks);
            continue;
        }
        let behind = if inside { i32x4_splat(0) } else { i32x4_shr(dot, 31) };
        let behind_m = (i32x4_bitmask(behind) as u32 | !valid) & 0xf;
        if behind_m == 0xf {
            continue;
        }
        let q = v128_load(pp.add(i) as *const v128);
        let dd = f32x4_mul(dot, dot);
        let ratio = f32x4_div(dd, q);
        // The rest only for a texel the light is not behind.
        let smallest = f32x4_min(f32x4_abs(dd), f32x4_abs(ratio));
        if i32x4_bitmask(f32x4_le(smallest, tiny)) as u32 & !behind_m & 0xf != 0 {
            scalar += 1;
            scalar_texels(light, table, first, i, n.min(i + 4), miss, fallbacks);
            continue;
        }
        let h2 = f32x4_sub(dsq, ratio);
        let missed_m = i32x4_bitmask(v128_not(f32x4_ge(rsq, h2))) as u32;
        let seen = !behind_m & 0xf;
        let hits = seen & !missed_m;
        if hits == 0 {
            // Every texel the light is not behind is a miss, and the last of them leaves the flag set.
            if seen != 0 {
                *miss = 1;
            }
            continue;
        }
        let (mut dots, mut h2s) = ([0u32; 4], [0u32; 4]);
        v128_store(dots.as_mut_ptr() as *mut v128, dot);
        v128_store(h2s.as_mut_ptr() as *mut v128, h2);
        for j in 0..4 {
            let bit = 1 << j;
            if seen & bit == 0 {
                continue;
            }
            if missed_m & bit != 0 {
                *miss = 1;
                continue;
            }
            hit(light, table, first, i + j, dots[j], h2s[j], miss);
        }
    }
    BLOCK_STATS[2] = BLOCK_STATS[2].wrapping_add(scalar);
    BLOCK_STATS[3] = BLOCK_STATS[3].wrapping_add(blocks as u32);
}

/// Off wasm32 (host builds of the crate): the reference body on every texel.
#[cfg(not(target_arch = "wasm32"))]
unsafe fn light_blocks(light: &[u32], table: &[u8], first: bool, n: usize, miss: &mut u32, fallbacks: &mut u32) {
    scalar_texels(light, table, first, 0, n, miss, fallbacks);
}

unsafe fn walk<const MODE: u8>(width: usize, height: usize, count: usize) -> u32 {
    let lights = &*core::ptr::addr_of!(LIGHTS);
    let tables = &*core::ptr::addr_of!(TABLES);
    let grid = &*core::ptr::addr_of!(GRID);
    let out = out_bytes();
    let mut miss = MISS;
    let (mut fallbacks, mut mismatches) = (0u32, 0u32);
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
                } else {
                    dispatch::<MODE>(light, light_finite, light_single, (px, py, pz), first, &mut miss, &mut fallbacks)
                };
                put(out, (v * width + u) * 4, table, index, first);
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
