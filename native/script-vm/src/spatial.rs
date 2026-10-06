//! Render.dll's time-varying spatial light functions on BSP light maps
//! (docs/static-lighting.md "Spatially dynamic effects"): Searchlight
//! 0x10b03770, Rotor 0x10b03ae0, SlowWave 0x10b03de0, FastWave 0x10b040b0,
//! Shock 0x10b043a0, Disco 0x10b046f0 and Interference 0x10b04c80 (effect
//! table 0x10b2a0f0 rows with IsSpatialDynamic), plus Shell 0x10b05740.
//! CloudCast 0x10b04380 only forwards to the normal body 0x10b03360.
//!
//! Precision. These run inside DrawWorld, after URender::PreRender set the
//! x87 precision control to 24 bits (docs/bsp-occlusion.md "Precision"), so
//! every FADD/FSUB/FMUL/FDIV rounds its exact result once to a 24-bit
//! significand (nearest-even). Values here stay far inside binary32's
//! normal range, where that is IEEE binary32 arithmetic for two float
//! operands: plain f32 ops. An operand with more bits (a double constant,
//! FILD of a large int, FPATAN's extended result) is held exactly as an f64
//! (or a double-double) and the product or sum is rounded with `mul24` /
//! `add24`, which repair the one case where the f64 rounding can mislead:
//! an f64 result exactly on a 24-bit midpoint.
//!
//! Transcendental. Core appAtan2 (0x10123280) is `fld Y; fld X; fpatan`: the
//! extended (64-bit) atan2, which these bodies then multiply by 4, 6 or 11
//! at 24 bits. `atan_k` models FPATAN as the correctly rounded atan2; the
//! fast path is an f64 atan2 whose error is far inside the band where the
//! 24-bit rounding is certain, and a double-double atan2 (about 2^-100)
//! decides the rest. Only when the double-double value sits on a 24-bit
//! midpoint within 2^-60 could FPATAN's own last-bit rounding matter
//! (`AMBIGUOUS` counts those). validate-light-spatial compares the model
//! with FPATAN measured on x87 hardware.
//!
//! The light-manager tables (square root 0x10b3e1b8, normal falloff
//! 0x10b34a6c) are uploaded by the host from dynamic-lighting.mjs; GMath's
//! sine table is the crate's SINE.

pub(crate) const PARAM_WORDS: usize = 28;
// Parameter words of one call (`light_spatial`).
const P_EFFECT: usize = 0;
const P_MIN_U: usize = 1;
const P_MAX_U: usize = 2;
const P_MIN_V: usize = 3;
const P_MAX_V: usize = 4;
const P_START: usize = 5; // 3 float bits, then U step (8..10), V step (11..13)
const P_LOCATION: usize = 14; // 3 float bits
const P_RRADIUS: usize = 17;
const P_RR2: usize = 18;
const P_INCIDENCE: usize = 19;
pub(crate) const P_TIME: usize = 20; // Level.TimeSeconds float bits
const P_PERIOD: usize = 21;
const P_PHASE: usize = 22;
const P_ILLUMINATION: usize = 23; // rectangle-relative bytes, or 0 for 0x7f
const P_OUT: usize = 24; // rectangle-relative spatial bytes
/// The merge kernel's memo (light.rs): the time last computed, and 1 once
/// computed.
pub(crate) const P_DONE_TIME: usize = 25;
pub(crate) const P_DONE: usize = 26;

static mut SQRT: [u32; 2048] = [0; 2048];
static mut NORMAL: [f32; 4096] = [0.0; 4096];
static mut PARAMS: [u32; PARAM_WORDS] = [0; PARAM_WORDS];
/// Atan pairs (Y bits, X bits) recorded into a host buffer of `CAPACITY`
/// pairs while `PAIRS` is nonzero (validation); `PAIR_COUNT` counts every
/// pair, also those past the capacity.
static mut PAIRS: u32 = 0;
static mut CAPACITY: u32 = 0;
static mut PAIR_COUNT: u32 = 0;
/// Atan evaluations decided by the double-double path, and those whose
/// double-double value lay within 2^-60 of a 24-bit midpoint.
static mut FALLBACKS: u32 = 0;
static mut AMBIGUOUS: u32 = 0;
/// Nonzero: every atan takes the double-double path (validation).
static mut SLOW_ONLY: u32 = 0;
static mut DD_OUT: [f64; 2] = [0.0; 2];

#[no_mangle]
pub extern "C" fn spatial_sqrt_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(SQRT) as *mut u32
}
#[no_mangle]
pub extern "C" fn spatial_normal_ptr() -> *mut f32 {
    core::ptr::addr_of_mut!(NORMAL) as *mut f32
}
#[no_mangle]
pub extern "C" fn spatial_params_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(PARAMS) as *mut u32
}
#[no_mangle]
pub extern "C" fn spatial_pair_count() -> u32 {
    unsafe { PAIR_COUNT }
}
/// Record atan pairs into `buffer` (`capacity` pairs of two u64), or stop
/// with 0.
#[no_mangle]
pub extern "C" fn spatial_collect(buffer: u32, capacity: u32) {
    unsafe {
        PAIRS = buffer;
        CAPACITY = capacity;
        PAIR_COUNT = 0;
    }
}
#[no_mangle]
pub extern "C" fn spatial_fallbacks() -> u32 {
    unsafe { FALLBACKS }
}
#[no_mangle]
pub extern "C" fn spatial_ambiguous() -> u32 {
    unsafe { AMBIGUOUS }
}
#[no_mangle]
pub extern "C" fn spatial_reset_counts() {
    unsafe {
        FALLBACKS = 0;
        AMBIGUOUS = 0;
    }
}
#[no_mangle]
pub extern "C" fn spatial_set_slow_only(on: u32) {
    unsafe { SLOW_ONLY = on }
}
#[no_mangle]
pub extern "C" fn spatial_dd_ptr() -> *const f64 {
    core::ptr::addr_of!(DD_OUT) as *const f64
}

// ---------------------------------------------------------------------------
// 24-bit precision control on exact f64 operands.

/// Round an f64 to a 24-bit significand, nearest-even, keeping its exponent
/// (the x87's PC24 rounding; zeros, infinities and NaN pass).
#[inline(always)]
fn r24(x: f64) -> f64 {
    let b = x.to_bits();
    let e = (b >> 52) & 0x7ff;
    if e == 0 || e == 0x7ff {
        return x;
    }
    let rem = b & 0x1fff_ffff;
    let mut r = b - rem;
    if rem > 0x1000_0000 || (rem == 0x1000_0000 && r & 0x2000_0000 != 0) {
        r += 0x2000_0000;
    }
    f64::from_bits(r)
}
#[inline(always)]
fn midpoint24(x: f64) -> bool {
    x.to_bits() & 0x1fff_ffff == 0x1000_0000 && (x.to_bits() >> 52) & 0x7ff != 0
}
/// `x` moved one f64 unit toward +∞ (`up`) or −∞, then rounded: the
/// 24-bit result of an exact value just above or below the midpoint `x`.
#[inline(never)]
fn r24_directed(x: f64, up: bool) -> f64 {
    let b = x.to_bits();
    let toward_magnitude = up == (x > 0.0);
    r24(f64::from_bits(if toward_magnitude { b + 1 } else { b - 1 }))
}
#[inline(always)]
fn split(a: f64) -> (f64, f64) {
    let c = 134_217_729.0 * a;
    let h = c - (c - a);
    (h, a - h)
}
#[inline(always)]
fn two_prod(a: f64, b: f64) -> (f64, f64) {
    let p = a * b;
    let (ah, al) = split(a);
    let (bh, bl) = split(b);
    (p, ((ah * bh - p) + ah * bl + al * bh) + al * bl)
}
#[inline(always)]
fn two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    let bb = s - a;
    (s, (a - (s - bb)) + (b - bb))
}
#[inline(always)]
fn quick_two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    (s, b - (s - a))
}
/// FMUL at 24 bits of two exact f64 operands.
#[inline(always)]
fn mul24(a: f64, b: f64) -> f64 {
    let p = a * b;
    if midpoint24(p) {
        let e = two_prod(a, b).1;
        if e != 0.0 {
            return r24_directed(p, e > 0.0);
        }
    }
    r24(p)
}
/// FADD at 24 bits of two exact f64 operands.
#[inline(always)]
fn add24(a: f64, b: f64) -> f64 {
    let s = a + b;
    if midpoint24(s) {
        let e = two_sum(a, b).1;
        if e != 0.0 {
            return r24_directed(s, e > 0.0);
        }
    }
    r24(s)
}
/// FST m32 of a 24-bit value (binary32 range: an ordinary conversion).
#[inline(always)]
fn st32(x: f64) -> f32 {
    x as f32
}
const TWO_52: f64 = 4_503_599_627_370_496.0;
/// FISTP m32 under round-to-nearest-even; out of range or NaN is the
/// integer indefinite 0x80000000.
#[inline(always)]
fn fistp(x: f64) -> i32 {
    let r = if x.abs() < TWO_52 {
        if x >= 0.0 {
            (x + TWO_52) - TWO_52
        } else {
            (x - TWO_52) + TWO_52
        }
    } else {
        x
    };
    if r >= -2_147_483_648.0 && r <= 2_147_483_647.0 {
        r as i32
    } else {
        i32::MIN
    }
}
/// msvcrt `_ftol`: FISTP m64 under truncation, the low 32 bits (0 for the
/// 64-bit indefinite: NaN or beyond ±2^63).
#[inline(always)]
fn ftol(x: f64) -> i32 {
    if x.abs() < 9_223_372_036_854_775_808.0 {
        (x as i64) as i32
    } else {
        0
    }
}
/// The light manager's table square root (dynamic-lighting.mjs tableSqrt).
#[inline(always)]
fn table_sqrt(bits: u32) -> f32 {
    f32::from_bits(unsafe { (*core::ptr::addr_of!(SQRT))[((bits >> 13) & 0x7ff) as usize] }.wrapping_add((bits & 0x7f00_0000) >> 1))
}
#[inline(always)]
fn normal(index: i32) -> f64 {
    unsafe { (*core::ptr::addr_of!(NORMAL))[index as usize & 0xfff] as f64 }
}
/// GMath.TrigFLOAT at (angle >> 2) & 0x3fff (FRotator sine).
#[inline(always)]
fn sine(angle: i32) -> f64 {
    f32::from_bits(crate::rotator_sin(angle)) as f64
}
/// The cosine entry these bodies read: (0x4000 − angle) >> 2.
#[inline(always)]
fn cosine(angle: i32) -> f64 {
    sine(0x4000i32.wrapping_sub(angle))
}

// ---------------------------------------------------------------------------
// FPATAN.

const ATAN_TABLE: [(u64, u64); 65] = [
    (0x0000000000000000, 0x0000000000000000),
    (0x3f8fff555bbb729b, 0xbc2220c39d4dff50),
    (0x3f9ffd55bba97625, 0xbc35ec431444912c),
    (0x3fa7fb818430da2a, 0xbc086ef8f794f105),
    (0x3faff55bb72cfdea, 0xbc3c934d86d23f1d),
    (0x3fb3f59f0e7c559d, 0x3c5ac4ce285df847),
    (0x3fb7ee182602f10f, 0xbc5cfb654c0c3d98),
    (0x3fbbe39ebe6f07c3, 0x3c5f7b8f29a05987),
    (0x3fbfd5ba9aac2f6e, 0xbc4cd37686760c17),
    (0x3fc1e1fafb043727, 0xbc4b485914dacf8c),
    (0x3fc3d6eee8c6626c, 0x3c661a3b0ce9281b),
    (0x3fc5c9811e3ec26a, 0xbc5054ab2c010f3d),
    (0x3fc7b97b4bce5b02, 0x3c5347b0b4f881ca),
    (0x3fc9a6a8e96c8626, 0x3c4cf601e7b4348e),
    (0x3fcb90d7529260a2, 0x3c217b10d2e0e5ab),
    (0x3fcd77d5df205736, 0x3c6c648d1534597e),
    (0x3fcf5b75f92c80dd, 0x3c68ab6e3cf7afbd),
    (0x3fd09dc597d86362, 0x3c762e47390cb865),
    (0x3fd18bf5a30bf178, 0x3c630ca4748b1bf9),
    (0x3fd278372057ef46, 0xbc7077cdd36dfc81),
    (0x3fd362773707ebcc, 0xbc6963a544b672d8),
    (0x3fd44aa436c2af0a, 0xbc75d5e43c55b3ba),
    (0x3fd530ad9951cd4a, 0xbc62566480884082),
    (0x3fd614840309cfe2, 0xbc7a725715711f00),
    (0x3fd6f61941e4def1, 0xbc7c63aae6f6e918),
    (0x3fd7d5604b63b3f7, 0x3c769c885c2b249a),
    (0x3fd8b24d394a1b25, 0x3c7b6d0ba3748fa8),
    (0x3fd98cd5454d6b18, 0x3c79e6c988fd0a77),
    (0x3fda64eec3cc23fd, 0xbc724dec1b50b7ff),
    (0x3fdb3a911da65c6c, 0x3c7ae187b1ca5040),
    (0x3fdc0db4c94ec9f0, 0xbc7cc1ce70934c34),
    (0x3fdcde53432c1351, 0xbc7a2cfa4418f1ad),
    (0x3fddac670561bb4f, 0x3c7a2b7f222f65e2),
    (0x3fde77eb7f175a34, 0x3c70e53dc1bf3435),
    (0x3fdf40dd0b541418, 0xbc6a3992dc382a23),
    (0x3fe0039c73c1a40c, 0xbc8b32c949c9d593),
    (0x3fe0657e94db30d0, 0xbc7d5b495f6349e6),
    (0x3fe0c6145b5b43da, 0x3c5974fa13b5404f),
    (0x3fe1255d9bfbd2a9, 0xbc52bdaee1c0ee35),
    (0x3fe1835a88be7c13, 0x3c8c621cec00c301),
    (0x3fe1e00babdefeb4, 0xbc5928df287a668f),
    (0x3fe23b71e2cc9e6a, 0x3c6c421c9f38224e),
    (0x3fe2958e59308e31, 0xbc709e73b0c6c087),
    (0x3fe2ee628406cbca, 0x3c8c5d5e9ff0cf8d),
    (0x3fe345f01cce37bb, 0x3c81021137c71102),
    (0x3fe39c391cd4171a, 0xbc82304331d8bf46),
    (0x3fe3f13fb89e96f4, 0x3c7ecf8b492644f0),
    (0x3fe445065b795b56, 0xbc7f76d0163f79c8),
    (0x3fe4978fa3269ee1, 0x3c72419a87f2a458),
    (0x3fe4e8de5bb6ec04, 0x3c84a33dbeb3796c),
    (0x3fe538f57b89061f, 0xbc81bb74abda520c),
    (0x3fe587d81f732fbb, 0xbc75e5c9d8c5a950),
    (0x3fe5d58987169b18, 0x3c60028e4bc5e7ca),
    (0x3fe6220d115d7b8e, 0xbc62b785350ee8c1),
    (0x3fe66d663923e087, 0xbc76ea6febe8bbba),
    (0x3fe6b798920b3d99, 0xbc8a80386188c50e),
    (0x3fe700a7c5784634, 0xbc78c34d25aadef6),
    (0x3fe748978fba8e0f, 0x3c47b2a6165884a1),
    (0x3fe78f6bbd5d315e, 0x3c8406a089803740),
    (0x3fe7d528289fa093, 0x3c8560821e2f3aa9),
    (0x3fe819d0b7158a4d, 0xbc7bf76229d3b917),
    (0x3fe85d69576cc2c5, 0x3c66b66e7fc8b8c3),
    (0x3fe89ff5ff57f1f8, 0xbc855b9a5e177a1b),
    (0x3fe8e17aa99cc05e, 0xbc7ec182ab042f61),
    (0x3fe921fb54442d18, 0x3c81a62633145c07),
];
const PI_HI: u64 = 0x400921fb54442d18;
const PI_LO: u64 = 0x3ca1a62633145c07;
const PI_2_HI: u64 = 0x3ff921fb54442d18;
const PI_2_LO: u64 = 0x3c91a62633145c07;

type Dd = (f64, f64);
#[inline(always)]
fn dd_add(a: Dd, b: Dd) -> Dd {
    let (s, e) = two_sum(a.0, b.0);
    let (t, f) = two_sum(a.1, b.1);
    let (s, e) = quick_two_sum(s, e + t);
    quick_two_sum(s, e + f)
}
#[inline(always)]
fn dd_neg(a: Dd) -> Dd {
    (-a.0, -a.1)
}
#[inline(always)]
fn dd_mul(a: Dd, b: Dd) -> Dd {
    let (p, e) = two_prod(a.0, b.0);
    quick_two_sum(p, e + (a.0 * b.1 + a.1 * b.0))
}
fn dd_div(a: Dd, b: Dd) -> Dd {
    let q1 = a.0 / b.0;
    let r = dd_add(a, dd_neg(dd_mul(b, (q1, 0.0))));
    let q2 = r.0 / b.0;
    let r = dd_add(r, dd_neg(dd_mul(b, (q2, 0.0))));
    let q3 = r.0 / b.0;
    let (q1, q2) = quick_two_sum(q1, q2);
    dd_add((q1, q2), (q3, 0.0))
}

/// atan2(y, x) in f64 (error a few units in the last place): the reduced
/// ratio t ≤ 1, t = k/64 + u-step through atan(k/64) and the odd series of
/// u ≤ 1/128, then the octant.
fn atan2_fast(y: f64, x: f64) -> f64 {
    let (ay, ax) = (y.abs(), x.abs());
    let swap = ay > ax;
    let t = if swap { ax / ay } else { ay / ax };
    let k = (t * 64.0 + 0.5) as usize;
    let c = k as f64 * 0.015625;
    let u = (t - c) / (1.0 + t * c);
    let u2 = u * u;
    let series = u * (1.0 - u2 * (1.0 / 3.0 - u2 * (0.2 - u2 * (1.0 / 7.0 - u2 * (1.0 / 9.0 - u2 * (1.0 / 11.0))))));
    let (hi, lo) = ATAN_TABLE[k];
    let mut r = f64::from_bits(hi) + (f64::from_bits(lo) + series);
    if swap {
        r = f64::from_bits(PI_2_HI) - r + f64::from_bits(PI_2_LO);
    }
    if x.is_sign_negative() {
        r = f64::from_bits(PI_HI) - r + f64::from_bits(PI_LO);
    }
    if y.is_sign_negative() {
        -r
    } else {
        r
    }
}

/// atan2(y, x) as a double-double (about 2^-100 relative), same reduction.
fn atan2_dd(y: f64, x: f64) -> Dd {
    let (ay, ax) = (y.abs(), x.abs());
    let swap = ay > ax;
    let t = if swap { dd_div((ax, 0.0), (ay, 0.0)) } else { dd_div((ay, 0.0), (ax, 0.0)) };
    let k = (t.0 * 64.0 + 0.5) as usize;
    let c = k as f64 * 0.015625;
    let num = dd_add(t, (-c, 0.0));
    let den = dd_add((1.0, 0.0), dd_mul(t, (c, 0.0)));
    let u = dd_div(num, den);
    let u2 = dd_mul(u, u);
    // 1/(2n+1) − u²·(...), n from 12 down to 0: truncation below (1/128)^26.
    let mut s: Dd = dd_div((1.0, 0.0), (25.0, 0.0));
    let mut n = 12;
    while n > 0 {
        n -= 1;
        s = dd_add(dd_div((1.0, 0.0), ((2 * n + 1) as f64, 0.0)), dd_neg(dd_mul(u2, s)));
    }
    let (hi, lo) = ATAN_TABLE[k];
    let mut r = dd_add((f64::from_bits(hi), f64::from_bits(lo)), dd_mul(u, s));
    if swap {
        r = dd_add((f64::from_bits(PI_2_HI), f64::from_bits(PI_2_LO)), dd_neg(r));
    }
    if x.is_sign_negative() {
        r = dd_add((f64::from_bits(PI_HI), f64::from_bits(PI_LO)), dd_neg(r));
    }
    if y.is_sign_negative() {
        dd_neg(r)
    } else {
        r
    }
}

/// FPATAN(Y = y, X = x)'s value for the zero operands (Intel's table):
/// ±0 or ±π for Y = ±0 (X = −0 or negative takes π), ±π/2 for X = ±0.
fn atan2_zero(y: f64, x: f64) -> Option<Dd> {
    let pi = (f64::from_bits(PI_HI), f64::from_bits(PI_LO));
    let half = (f64::from_bits(PI_2_HI), f64::from_bits(PI_2_LO));
    let r = if y == 0.0 {
        if x.is_sign_negative() {
            pi
        } else {
            (0.0, 0.0)
        }
    } else if x == 0.0 {
        half
    } else {
        return None;
    };
    Some(if y.is_sign_negative() { dd_neg(r) } else { r })
}

/// A double-double rounded to 24 bits: only an f64 high part exactly on a
/// midpoint lets the low part decide.
fn round24_dd(v: Dd) -> f64 {
    if midpoint24(v.0) {
        if v.1 == 0.0 || v.1.abs() < v.0.abs() * 8.673617379884035e-19 {
            unsafe { AMBIGUOUS += 1 };
        }
        if v.1 != 0.0 {
            return r24_directed(v.0, v.1 > 0.0);
        }
    }
    r24(v.0)
}

/// The 24-bit product `k · FPATAN(y, x)` (FPATAN through Core appAtan2,
/// then FMUL m64 at PC24).
#[inline(never)]
fn atan_k(y: f64, x: f64, k: f64) -> f64 {
    unsafe {
        if PAIRS != 0 {
            if PAIR_COUNT < CAPACITY {
                let at = (PAIRS as usize + PAIR_COUNT as usize * 16) as *mut u64;
                *at = y.to_bits();
                *at.add(1) = x.to_bits();
            }
            PAIR_COUNT += 1;
        }
    }
    if let Some(z) = atan2_zero(y, x) {
        return round24_dd(dd_mul(z, (k, 0.0)));
    }
    if unsafe { SLOW_ONLY } == 0 {
        let v = atan2_fast(y, x) * k;
        let low = (v.to_bits() & 0x1fff_ffff) as i64;
        // A relative band of 2^-39 around each midpoint: the fast value's
        // error (a few 2^-53) cannot cross a midpoint from outside it.
        if (low - 0x1000_0000).abs() > 0x2000 {
            return r24(v);
        }
    }
    unsafe { FALLBACKS += 1 };
    round24_dd(dd_mul(atan2_dd(y, x), (k, 0.0)))
}

/// Validation: atan2's double-double value into DD_OUT.
#[no_mangle]
pub extern "C" fn spatial_atan_dd(y: f64, x: f64) {
    let r = atan2_zero(y, x).unwrap_or_else(|| atan2_dd(y, x));
    unsafe { *core::ptr::addr_of_mut!(DD_OUT) = [r.0, r.1] };
}
/// Validation: `atan_k` (the 24-bit product as f64).
#[no_mangle]
pub extern "C" fn spatial_atan_k(y: f64, x: f64, k: f64) -> f64 {
    atan_k(y, x, k)
}

// ---------------------------------------------------------------------------
// The bodies.

const TWO_PI: f64 = 6.283185307179586; // 0x10b2a6f0
const EIGHT_PI: f64 = 25.132741228718345; // pushed at 0x10b0395c
const PI: f64 = 3.141592653589793; // 0x10b2a6d0
const THREE_PI: f64 = 9.42477796076938; // 0x10b2a6c0
const NEG_INV_TWO_PI: f64 = -0.15915494309189535; // 0x10b2a6b0
const PHASE_SCALE: f64 = 0.09817477042468103; // 0x10b2a700 (π/32)

/// The rectangle walk every body shares: the row start
/// `(minV·V + start) + minU·U` from stored floats, per row the stored
/// displacement from the light, per texel the U step added to it; the
/// illumination byte (0 skips the texel, writing 0) and `texel(dx, dy, dz,
/// illumination)` for the others.
#[inline(always)]
fn walk<F: FnMut(f32, f32, f32, u32) -> u8>(p: &[u32; PARAM_WORDS], illumination: Option<&[u8]>, out: &mut [u8], mut texel: F) {
    let w = |i: usize| f32::from_bits(p[i]);
    let (min_u, max_u, min_v, max_v) = (p[P_MIN_U] as i32, p[P_MAX_U] as i32, p[P_MIN_V] as i32, p[P_MAX_V] as i32);
    let (sx, sy, sz) = (w(P_START), w(P_START + 1), w(P_START + 2));
    let (ux, uy, uz) = (w(P_START + 3), w(P_START + 4), w(P_START + 5));
    let (vx, vy, vz) = (w(P_START + 6), w(P_START + 7), w(P_START + 8));
    let (lx, ly, lz) = (w(P_LOCATION), w(P_LOCATION + 1), w(P_LOCATION + 2));
    let (fu, fv) = (min_u as f32, min_v as f32);
    let mut row_x = (fv * vx + sx) + fu * ux;
    let mut row_y = (fv * vy + sy) + fu * uy;
    let mut row_z = (fv * vz + sz) + fu * uz;
    let rw = (max_u - min_u).max(0) as usize;
    let mut at = 0usize;
    for _ in min_v..max_v {
        let (mut dx, mut dy, mut dz) = (row_x - lx, row_y - ly, row_z - lz);
        for _ in 0..rw {
            let b = match illumination {
                Some(bytes) => bytes[at] as u32,
                None => 0x7f,
            };
            out[at] = if b != 0 { texel(dx, dy, dz, b) } else { 0 };
            at += 1;
            dx += ux;
            dy += uy;
            dz += uz;
        }
        row_x += vx;
        row_y += vy;
        row_z += vz;
    }
}

/// The falloff index FISTP(float(sum · rr2)) and its 4096 bound.
#[inline(always)]
fn falloff(sum: f32, rr2: f32) -> Option<i32> {
    let index = fistp((sum * rr2) as f64);
    if (index as u32) < 0x1000 {
        Some(index)
    } else {
        None
    }
}
/// The spatial byte: FISTP(float − 0.5)'s low byte.
#[inline(always)]
fn byte_of(value: f32) -> u8 {
    fistp(add24(value as f64, -0.5)) as u8
}

/// Searchlight 0x10b03770.
fn searchlight(p: &[u32; PARAM_WORDS], illumination: Option<&[u8]>, out: &mut [u8]) {
    let (rr2, incidence) = (f32::from_bits(p[P_RR2]) as f64, f32::from_bits(p[P_INCIDENCE]) as f64);
    let time = f32::from_bits(p[P_TIME]) as f64;
    let period = p[P_PERIOD] & 255;
    // 0x10b03788-0x10b037ff: TimeSeconds·35/LightPeriod (0 without a
    // period), plus LightPhase·π/32 and 2π, stored as a float.
    let t = if period != 0 { r24(mul24(time, 35.0) / period as f64) } else { 0.0 };
    let phase = mul24((p[P_PHASE] & 255) as f64, PHASE_SCALE);
    let x = st32(add24(add24(phase, t), TWO_PI)) as f64;
    walk(p, illumination, out, |dx, dy, dz, b| {
        let dy2 = dy * dy;
        let dx2 = dx * dx;
        let index = match falloff(dz * dz + dy2 + dx2, rr2 as f32) {
            Some(i) => i,
            None => return 0,
        };
        // appAtan2(dx, dy)·4 + x as a double, appFmod by 8π.
        let r = add24(atan_k(dx as f64, dy as f64, 4.0), x);
        let m = r % EIGHT_PI;
        let m32 = st32(m) as f64;
        if m < PI || !(m32 <= THREE_PI) {
            return 0;
        }
        let k = ftol(mul24(m32 * 65536.0, NEG_INV_TWO_PI));
        let mut s = add24(cosine(k), 1.0) * 0.5;
        let q = mul24((dy2 + dx2) as f64, 6e-05);
        if q < 1.0 {
            s = mul24(s, q);
        }
        let v = mul24(mul24(mul24(b as f64, normal(index)), s), incidence);
        byte_of(st32(v))
    });
}

/// Rotor 0x10b03ae0.
fn rotor(p: &[u32; PARAM_WORDS], illumination: Option<&[u8]>, out: &mut [u8]) {
    let (rr2, incidence) = (f32::from_bits(p[P_RR2]), f32::from_bits(p[P_INCIDENCE]) as f64);
    let spin = mul24(f32::from_bits(p[P_TIME]) as f64, 3.5);
    walk(p, illumination, out, |dx, dy, dz, b| {
        let dy2 = dy * dy;
        let dx2 = dx * dx;
        let index = match falloff(dz * dz + dy2 + dx2, rr2) {
            Some(i) => i,
            None => return 0,
        };
        let angle = add24(atan_k(dx as f64, dy as f64, 6.0), spin);
        let k = ftol(mul24(angle * 65536.0, NEG_INV_TWO_PI));
        let mut s = add24(cosine(k), 1.0) * 0.5;
        let q = mul24((dy2 + dx2) as f64, 0.0001);
        if q < 1.0 {
            s = add24(mul24(s, q), add24(1.0, -q));
        }
        let v = mul24(mul24(mul24(b as f64, normal(index)), s), incidence);
        byte_of(st32(v))
    });
}

/// SlowWave 0x10b03de0 (`shift` 0, scale 1024) and FastWave 0x10b040b0
/// (`shift` 2, scale 2048).
fn wave(p: &[u32; PARAM_WORDS], illumination: Option<&[u8]>, out: &mut [u8], shift: u32, scale: f64) {
    let (rr2, incidence) = (f32::from_bits(p[P_RR2]), f32::from_bits(p[P_INCIDENCE]) as f64);
    let t35 = mul24(f32::from_bits(p[P_TIME]) as f64, 35.0);
    walk(p, illumination, out, |dx, dy, dz, b| {
        let sum = (dy * dy + dz * dz) + dx * dx;
        let index = match falloff(sum, rr2) {
            Some(i) => i,
            None => return 0,
        };
        let distance = ftol(table_sqrt(sum.to_bits()) as f64) >> shift;
        let k = ftol(add24(distance as f64, -t35) * scale);
        let s = add24(mul24(sine(k), 0.3), 0.7);
        let v = mul24(mul24(mul24(s, normal(index)), b as f64), incidence);
        byte_of(st32(v))
    });
}

/// Shock 0x10b043a0.
fn shock(p: &[u32; PARAM_WORDS], illumination: Option<&[u8]>, out: &mut [u8]) {
    let (rr2, incidence) = (f32::from_bits(p[P_RR2]), f32::from_bits(p[P_INCIDENCE]) as f64);
    let t = mul24(f32::from_bits(p[P_TIME]) as f64, 4000.0);
    let factor = |angle: f64| add24(mul24(angle, 0.1), 0.9);
    walk(p, illumination, out, |dx, dy, dz, b| {
        let sum = (dy * dy + dz * dz) + dx * dx;
        let index = match falloff(sum, rr2) {
            Some(i) => i,
            None => return 0,
        };
        let d = ftol(table_sqrt(sum.to_bits()) as f64 * 8.0);
        let k1 = ftol(add24(d as f64, t) * -16.0);
        let a = factor(cosine(k1));
        let k2 = ftol(add24(d.wrapping_mul(2) as f64, -t) * 16.0);
        let ab = mul24(a, factor(sine(k2)));
        let k3 = ftol(add24((d >> 1) as f64, -t) * 16.0);
        let abc = mul24(ab, factor(sine(k3)));
        let v = mul24(mul24(mul24(abc, normal(index)), b as f64), incidence);
        byte_of(st32(v))
    });
}

/// Disco 0x10b046f0.
fn disco(p: &[u32; PARAM_WORDS], illumination: Option<&[u8]>, out: &mut [u8]) {
    let (rr2, incidence) = (f32::from_bits(p[P_RR2]), f32::from_bits(p[P_INCIDENCE]) as f64);
    let t = mul24(f32::from_bits(p[P_TIME]) as f64, 5.0);
    let lobe = |angle: f64| {
        let k = ftol(mul24(angle * 65536.0, NEG_INV_TWO_PI));
        add24(cosine(k), 1.0) * 0.5
    };
    walk(p, illumination, out, |dx, dy, dz, b| {
        let dy2 = dy * dy;
        let dx2 = dx * dx;
        let index = match falloff(dz * dz + dy2 + dx2, rr2) {
            Some(i) => i,
            None => return 0,
        };
        let a1 = st32(atan_k(dx as f64, dy as f64, 11.0)) as f64;
        let h = dy2 + dx2;
        let a2 = atan_k(table_sqrt(h.to_bits()) as f64, dz as f64, 11.0);
        let c1 = st32(lobe(add24(a1, t))) as f64;
        let c2 = lobe(add24(a2, t));
        let mut s = add24(add24(c2, c1), -mul24(c2, c1));
        let q = mul24(h as f64, 5e-05);
        if q < 1.0 {
            s = mul24(s, q);
        }
        let v = mul24(mul24(mul24(normal(index), add24(1.0, -s)), b as f64), incidence);
        byte_of(st32(v))
    });
}

/// Interference 0x10b04c80.
fn interference(p: &[u32; PARAM_WORDS], illumination: Option<&[u8]>, out: &mut [u8]) {
    let (rr2, incidence) = (f32::from_bits(p[P_RR2]), f32::from_bits(p[P_INCIDENCE]) as f64);
    let t = mul24(f32::from_bits(p[P_TIME]) as f64, 5.0);
    walk(p, illumination, out, |dx, dy, dz, b| {
        let dy2 = dy * dy;
        let dx2 = dx * dx;
        let index = match falloff(dz * dz + dy2 + dx2, rr2) {
            Some(i) => i,
            None => return 0,
        };
        let h = dy2 + dx2;
        let angle = add24(atan_k(table_sqrt(h.to_bits()) as f64, dz as f64, 11.0), t);
        let k = ftol(mul24(angle * 65536.0, NEG_INV_TWO_PI));
        let s = add24(cosine(k), 1.0) * 0.5;
        let v = mul24(mul24(mul24(s, normal(index)), b as f64), incidence);
        byte_of(st32(v))
    });
}

/// Shell 0x10b05740: a ring at 0.8 < √d²/R < 1, peaking at 0.9; no falloff
/// table or incidence.
fn shell(p: &[u32; PARAM_WORDS], illumination: Option<&[u8]>, out: &mut [u8]) {
    let (rr2, rradius) = (f32::from_bits(p[P_RR2]), f32::from_bits(p[P_RRADIUS]));
    walk(p, illumination, out, |dx, dy, dz, b| {
        let sum = (dy * dy + dz * dz) + dx * dx;
        if falloff(sum, rr2).is_none() {
            return 0;
        }
        let r = table_sqrt(sum.to_bits()) * rradius;
        let r64 = r as f64;
        if !(r64 < 1.0) || !(r64 > 0.8) {
            return 0;
        }
        let mut e = add24(r64, -0.9);
        if e < 0.0 {
            e = -e;
        }
        let v = mul24(add24(1.0, -mul24(e, 10.0)), b as f64);
        byte_of(st32(v))
    });
}

/// Run `effect`'s spatial function over the parameter record at `params`
/// (PARAM_WORDS words: the rectangle, grid, location, constants, time,
/// period, phase, illumination and output addresses). Returns 0 for an
/// effect this module does not hold.
pub(crate) fn run(params: &[u32; PARAM_WORDS]) -> u32 {
    let (min_u, max_u, min_v, max_v) = (params[P_MIN_U] as i32, params[P_MAX_U] as i32, params[P_MIN_V] as i32, params[P_MAX_V] as i32);
    let area = ((max_u - min_u).max(0) * (max_v - min_v).max(0)) as usize;
    let illumination = if params[P_ILLUMINATION] != 0 {
        Some(unsafe { core::slice::from_raw_parts(params[P_ILLUMINATION] as usize as *const u8, area) })
    } else {
        None
    };
    let out = unsafe { core::slice::from_raw_parts_mut(params[P_OUT] as usize as *mut u8, area) };
    match params[P_EFFECT] {
        4 => searchlight(params, illumination, out),
        5 => wave(params, illumination, out, 0, 1024.0),
        6 => wave(params, illumination, out, 2, 2048.0),
        9 => shock(params, illumination, out),
        10 => disco(params, illumination, out),
        14 => shell(params, illumination, out),
        16 => interference(params, illumination, out),
        18 => rotor(params, illumination, out),
        _ => return 0,
    }
    1
}

/// `run` on the record at `params` (an address in this instance's memory).
#[no_mangle]
pub extern "C" fn light_spatial(params: u32) -> u32 {
    let p = unsafe { &*(params as usize as *const [u32; PARAM_WORDS]) };
    run(p)
}
