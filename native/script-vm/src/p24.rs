//! x87 precision control 24 for render-pass kernels
//! (docs/render-pass-precision.md).
//!
//! URender::PreRender sets PC 24 (`appEnableFastMath(1)`, control word
//! 0x007f) until PostRender. Under it every FADD, FSUB, FMUL, FDIV and FSQRT
//! rounds its result to a 24-bit significand while the register keeps the
//! x87's 15-bit exponent; loads are exact and FST rounds to binary32.
//!
//! A register value is held as an f64 with at most 24 significant bits.
//! `r24` rounds an f64 into that set: in binary32's normal range it is the
//! f32 conversion; outside it, the same 24-bit rounding with the wide
//! exponent (no overflow or denormalization before an FST). The f64
//! add, subtract, multiply, divide or square root of two such values,
//! followed by `r24`, is the PC 24 result: the f64 rounding is innocuous
//! before the 24-bit one (53 >= 2*24 + 2). That needs the f64 result to be
//! normal; values from f32 stores cannot reach f64's subnormal range in a
//! few operations, and `r24` leaves such a value unrounded (not modelled).
//! NaN operands follow f64 rules, not the x87's (callers keep non-finite
//! inputs on the Ext model, `Ext::round24`).

/// 2^-126, binary32's smallest normal magnitude.
pub const MIN_NORMAL: f64 = 1.1754943508222875e-38;
/// binary32's largest finite magnitude.
pub const MAX_F32: f64 = 3.4028234663852886e38;

/// Round to a 24-bit significand, nearest-even, keeping the exponent.
#[inline(always)]
pub fn r24(x: f64) -> f64 {
    let a = x.abs();
    if a >= MIN_NORMAL && a <= MAX_F32 {
        x as f32 as f64
    } else {
        r24_wide(x)
    }
}

#[cold]
#[inline(never)]
fn r24_wide(x: f64) -> f64 {
    let bits = x.to_bits();
    let e = ((bits >> 52) & 0x7ff) as i64;
    if x == 0.0 || e == 0x7ff || e == 0 {
        return x; // zero, infinity, NaN, f64 subnormal (see the module note)
    }
    // x = m * 2^k with m in [1, 2): scale m into range exactly, round, scale back.
    let k = e - 1023;
    let down = f64::from_bits(((1023 - k) as u64) << 52);
    let up = f64::from_bits(((1023 + k) as u64) << 52);
    ((x * down) as f32 as f64) * up
}

/// FST m32 of a register value: binary32 with its range (overflow to an
/// infinity, denormal results rounded once more), as the x87 stores.
#[inline(always)]
pub fn st(x: f64) -> u32 {
    (x as f32).to_bits()
}

/// FLD m32.
#[inline(always)]
pub fn ld(bits: u32) -> f64 {
    f32::from_bits(bits) as f64
}

#[inline(always)]
pub fn add(a: f64, b: f64) -> f64 {
    r24(a + b)
}
#[inline(always)]
pub fn sub(a: f64, b: f64) -> f64 {
    r24(a - b)
}
#[inline(always)]
pub fn mul(a: f64, b: f64) -> f64 {
    r24(a * b)
}
#[inline(always)]
pub fn div(a: f64, b: f64) -> f64 {
    r24(a / b)
}

/// The PC 24 sum of two finite f64 values of any precision (a register
/// value plus a double constant, or an FILD'd int wider than 24 bits): the
/// exact sum (TwoSum) rounded once to 24 bits, the sign of the error
/// deciding a rounding midpoint (x87-pc24.mjs `r24sum`).
pub fn sum_exact(a: f64, b: f64) -> f64 {
    let s = a + b;
    let t = s - a;
    let e = (a - (s - t)) + (b - t);
    let r = r24(s);
    if e == 0.0 || r == s || !s.is_finite() {
        return r;
    }
    let other = 2.0 * s - r;
    if other == r || r24(other) != other {
        return r;
    }
    if e > 0.0 {
        r.max(other)
    } else {
        r.min(other)
    }
}
