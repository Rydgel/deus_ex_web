//! The 80-bit x87 stack model of Core's float and vector operators, the
//! integer form of `x87*` in src/runtime/script-vm.mjs (docs/rust-core.md).
//!
//! A finite value is `(-1)^sign * sig * 2^exp` with `sig` normalized to 64
//! bits (bit 63 set) or zero. `special` holds the float32 bits of an infinity
//! or NaN, so a NaN keeps its payload as the JavaScript model's `{nan}` does.
//! Every operation rounds once to a 64-bit significand, nearest-even, as the
//! JavaScript model's BigInt arithmetic does; the two are compared by
//! scripts/validate-script-vm-x87.mjs.
//!
//! Since 2026-11-06 the arithmetic runs on u64 limbs (docs/firefox-60fps-plan.md "Combat tick"): a widening multiply without
//! `__multi3`, the quotient from a 128/64 division (Hacker's Delight `divlu`) without `u128_div_rem`, the square root from a seed
//! of the high word's 32-bit root. x87_ref.rs keeps the u128 bodies they replace: `--features x87_ref` runs them, `--features
//! selftest` compares both over generated operands (scripts/validate-x87-fast.mjs). A significand that is not normalized (bit 63
//! clear; lipsync.rs builds such values from an 80-bit memory word) takes the reference body.

use crate::x87_ref;

pub const INDEFINITE: u32 = 0xffc0_0000;

/// The x87 precision control the arithmetic rounds to: 64 bits on the game
/// thread, 24 inside URender::PreRender..PostRender, where the host runs
/// the render events' UnrealScript (docs/render-pass-precision.md
/// "UnrealScript in the render pass"). FADD, FSUB, FMUL, FDIV and FSQRT
/// round their exact result once to this width; loads, stores, compares and
/// FTOL are unaffected. Each instance of the module (the interpreter's, the
/// JavaScript VM's operator kernel) has its own, set by `set_x87_precision`.
static mut PRECISION: u32 = 64;

pub fn precision() -> u32 {
    unsafe { PRECISION }
}

/// Set the precision control (24 or 64) and return the previous one.
#[no_mangle]
pub extern "C" fn set_x87_precision(bits: u32) -> u32 {
    unsafe {
        let previous = PRECISION;
        PRECISION = if bits == 24 { 24 } else { 64 };
        previous
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Ext {
    pub sig: u64,
    pub exp: i32,
    pub sign: u32,
    pub special: u32,
}

impl Ext {
    pub const fn zero(sign: u32) -> Self {
        Self { sig: 0, exp: 0, sign, special: 0 }
    }

    /// FLD m32.
    pub fn load(bits: u32) -> Self {
        let sign = bits & 0x8000_0000;
        let e = (bits >> 23) & 255;
        let m = bits & 0x7f_ffff;
        if e == 255 {
            return Self { special: bits, ..Self::zero(sign) };
        }
        let sig = if e == 0 { m } else { m | 0x80_0000 };
        Self::normalized(sig as u128, if e == 0 { -149 } else { e as i32 - 150 }, sign)
    }

    /// FLD m64 of a finite double (an embedded constant): exact.
    pub fn load_f64(value: f64) -> Self {
        let bits = value.to_bits();
        let sign = ((bits >> 63) as u32) << 31;
        let e = ((bits >> 52) & 0x7ff) as i32;
        let m = bits & ((1u64 << 52) - 1);
        if e == 0 {
            Self::normalized(m as u128, -1074, sign)
        } else {
            Self::normalized((m | (1u64 << 52)) as u128, e - 1075, sign)
        }
    }

    /// FILD m32: an exact integer.
    pub fn load_i32(value: i32) -> Self {
        let sign = if value < 0 { 0x8000_0000 } else { 0 };
        Self::normalized(value.unsigned_abs() as u128, 0, sign)
    }

    pub fn normalized(sig: u128, exp: i32, sign: u32) -> Self {
        if cfg!(feature = "x87_ref") {
            return x87_ref::normalized(sig, exp, sign);
        }
        norm_hl((sig >> 64) as u64, sig as u64, exp, sign)
    }

    /// An arithmetic result: the exact (or sticky-jammed) `hi:lo * 2^exp` rounded once to the precision control's width,
    /// nearest-even, then held normalized to 64 bits.
    #[inline(always)]
    fn rounded(hi: u64, lo: u64, exp: i32, sign: u32) -> Self {
        if cfg!(feature = "x87_ref") || precision() == 24 {
            return x87_ref::rounded(((hi as u128) << 64) | lo as u128, exp, sign);
        }
        norm_hl(hi, lo, exp, sign)
    }

    pub fn nan(self) -> bool {
        self.special & 0x7f_ffff != 0 && self.special & 0x7f80_0000 == 0x7f80_0000
    }
    pub fn inf(self) -> bool {
        self.special & 0x7fff_ffff == 0x7f80_0000
    }
    pub fn negative(self) -> bool {
        self.sign != 0
    }
    pub fn quiet(self) -> Self {
        Self::load(self.special | 0x40_0000)
    }
    /// FSUB's operand negation: a NaN keeps its own sign and payload.
    pub fn neg(mut self) -> Self {
        if !self.nan() {
            self.sign ^= 0x8000_0000;
            if self.inf() {
                self.special ^= 0x8000_0000;
            }
        }
        self
    }

    pub fn add(self, other: Self) -> Self {
        if cfg!(feature = "x87_ref") || (self.special | other.special) != 0 {
            return x87_ref::add(self, other);
        }
        if self.sig == 0 {
            return if other.sig == 0 { Self::zero(self.sign & other.sign) } else { other };
        }
        if other.sig == 0 {
            return self;
        }
        let (a, b) = if (self.exp, self.sig) >= (other.exp, other.sig) { (self, other) } else { (other, self) };
        // Three guard bits plus a jammed low bit preserve nearest-even after
        // alignment; a larger exponent gap cannot cancel into the guard bits.
        let left = (a.sig as u128) << 3;
        // x87_ref::shift_jam((b.sig << 3), d) without the 128-bit variable shifts: up to 3 places of gap are an exact left shift; a larger gap
        // shifts the significand right by d - 3 and jams the bits that fall off into the low bit (all of them, once d - 3 reaches 64).
        let d = (a.exp - b.exp) as u32;
        let right = if d <= 3 {
            (b.sig as u128) << (3 - d)
        } else if d - 3 < 64 {
            let s = d - 3;
            ((b.sig >> s) | u64::from(b.sig << (64 - s) != 0)) as u128
        } else {
            1
        };
        let sum = if a.sign == b.sign { left + right } else { left - right };
        Self::rounded((sum >> 64) as u64, sum as u64, a.exp - 3, if sum == 0 { self.sign & other.sign } else { a.sign })
    }

    pub fn mul(self, other: Self) -> Self {
        if cfg!(feature = "x87_ref") || (self.special | other.special) != 0 {
            return x87_ref::mul(self, other);
        }
        let sign = self.sign ^ other.sign;
        if self.sig == 0 || other.sig == 0 {
            return Self::zero(sign);
        }
        let (hi, lo) = mul_wide(self.sig, other.sig);
        Self::rounded(hi, lo, self.exp + other.exp, sign)
    }

    /// FDIV: 0/0 and inf/inf are the indefinite, x/0 a signed infinity and
    /// x/inf a signed zero; a finite quotient is correctly rounded.
    pub fn div(self, other: Self) -> Self {
        if cfg!(feature = "x87_ref") || (self.special | other.special) != 0 || self.sig == 0 || other.sig == 0 {
            return x87_ref::div(self, other);
        }
        if (self.sig & other.sig) >> 63 == 0 {
            return x87_ref::div_finite(self, other);
        }
        let sign = self.sign ^ other.sign;
        // num = self.sig << 64, den = other.sig, both normalized: q = num / den has 64 or 65 bits.
        let (a, d) = (self.sig, other.sig);
        let (top, r1) = if a >= d { (1u64, a - d) } else { (0u64, a) };
        let (q0, rem) = divlu(r1, 0, d);
        // Two more quotient bits from the remainder give the round bit in either case; the rest of the remainder is sticky.
        let r4 = (rem as u128) << 2;
        let d1 = d as u128;
        let (extra, left) = if r4 >= 3 * d1 {
            (3u64, r4 - 3 * d1)
        } else if r4 >= 2 * d1 {
            (2, r4 - 2 * d1)
        } else if r4 >= d1 {
            (1, r4 - d1)
        } else {
            (0, r4)
        };
        let lo = (q0 << 3) | (extra << 1) | u64::from(left != 0);
        let hi = (top << 3) | (q0 >> 61);
        Self::rounded(hi, lo, self.exp - other.exp - 67, sign)
    }

    /// FCOM's (C0, C3) as script-pawn-locomotion.mjs `x87compare` models
    /// them: both set when unordered; an infinity pair is never below.
    pub fn compare(self, other: Self) -> (bool, bool) {
        if self.nan() || other.nan() {
            return (true, true);
        }
        if self.inf() || other.inf() {
            if self.inf() && other.inf() {
                return (false, self.sign == other.sign);
            }
            return if self.inf() { (self.sign != 0, false) } else { (other.sign == 0, false) };
        }
        let m: i32 = if self.sig == 0 && other.sig == 0 {
            0
        } else if self.sig == 0 {
            if other.sign != 0 { 1 } else { -1 }
        } else if other.sig == 0 {
            if self.sign != 0 { -1 } else { 1 }
        } else if self.sign != other.sign {
            if self.sign != 0 { -1 } else { 1 }
        } else {
            let o = (self.exp, self.sig).cmp(&(other.exp, other.sig)) as i32;
            if self.sign != 0 { -o } else { o }
        };
        (m < 0, m == 0)
    }

    /// x87recip (script-vm.mjs): 1/x of a finite nonzero x, correctly
    /// rounded, the dividend's FLD1.
    pub fn recip(self) -> Self {
        Self::normalized(1u128 << 63, -63, 0).div(self)
    }

    /// FSQRT of a finite nonnegative value or +inf; a zero keeps its sign.
    pub fn sqrt(self) -> Self {
        if cfg!(feature = "x87_ref") || self.special != 0 || self.sig >> 63 == 0 {
            return x87_ref::sqrt(self);
        }
        let mut sig = self.sig as u128;
        let mut exp = self.exp;
        if exp & 1 != 0 {
            sig <<= 1;
            exp -= 1;
        }
        let width = 128 - sig.leading_zeros() as i32;
        let shift = if width & 1 != 0 { 127 - width } else { 128 - width };
        let n2 = sig << shift;
        let mut q = isqrt(n2);
        if precision() == 24 {
            // The floor root (64 bits) with a sticky bit, rounded once.
            let sticky = u128::from(q * q != n2);
            return x87_ref::rounded((q << 1) | sticky, exp / 2 - shift / 2 - 1, 0);
        }
        // The root is never exactly halfway: q + 1 wins iff n2 - q^2 > q.
        if n2 - q * q > q {
            q += 1;
        }
        Self::normalized(q, exp / 2 - shift / 2, 0)
    }

    /// FST/FSTP m32: nearest-even to 24 bits with denormal and overflow
    /// boundaries.
    pub fn store(self) -> u32 {
        if cfg!(feature = "x87_ref") {
            return x87_ref::store(self);
        }
        if self.special != 0 {
            return self.special;
        }
        if self.sig == 0 {
            return self.sign;
        }
        let mut e = self.exp + 63;
        if e > 127 {
            return self.sign | 0x7f80_0000;
        }
        if e >= -126 {
            let (q, rem) = (self.sig >> 40, self.sig & ((1 << 40) - 1));
            let mut sig = (q + u64::from(rem > 1 << 39 || (rem == 1 << 39 && q & 1 != 0))) as u32;
            if sig >= 1 << 24 {
                sig >>= 1;
                e += 1;
            }
            if e > 127 {
                return self.sign | 0x7f80_0000;
            }
            self.sign | (((e + 127) as u32) << 23) | (sig - (1 << 23))
        } else {
            self.sign | round_right(self.sig as u128, (-149 - self.exp) as u32) as u32
        }
    }
    pub fn stored(self) -> Self {
        Self::load(self.store())
    }

    /// The register value under precision control 24 (the render pass,
    /// docs/render-pass-precision.md): the significand rounded to 24 bits,
    /// nearest-even, the exponent kept. Applied to the 64-bit result of an
    /// add, multiply, divide or square root of 24-bit operands it gives the
    /// PC 24 result (64 >= 2*24 + 2).
    pub fn round24(self) -> Self {
        if self.special != 0 || self.sig == 0 {
            return self;
        }
        Self::normalized(round_right(self.sig as u128, 40), self.exp + 40, self.sign)
    }

    /// FSTL m64 kept in the model: the significand rounded to 53 bits.
    pub fn store_double(self) -> Self {
        if self.special != 0 || self.sig == 0 {
            return self;
        }
        if cfg!(feature = "x87_ref") {
            return x87_ref::store_double(self);
        }
        let (q, rem) = (self.sig >> 11, self.sig & 0x7ff);
        let q = q + u64::from(rem > 0x400 || (rem == 0x400 && q & 1 != 0));
        // q is at most 2^53, so the normalization is an exact left shift (a tiny unnormalized significand can round to zero).
        if q == 0 {
            return Self::zero(self.sign);
        }
        let shift = q.leading_zeros();
        Self { sig: q << shift, exp: self.exp + 11 - shift as i32, sign: self.sign, special: 0 }
    }

    /// The shipped MSVCRT _ftol: truncate toward zero to int64 and keep the
    /// low DWORD; a NaN, an infinity or an int64 overflow stores the integer
    /// indefinite, whose low DWORD is 0.
    pub fn ftol(self) -> i32 {
        if self.special != 0 || self.sig == 0 {
            return 0;
        }
        let magnitude: u128 = if self.exp >= 0 {
            if self.exp > 1 {
                return 0;
            }
            (self.sig as u128) << self.exp
        } else if self.exp <= -64 {
            0
        } else {
            (self.sig >> (-self.exp) as u32) as u128
        };
        let value: i128 = if self.sign != 0 { -(magnitude as i128) } else { magnitude as i128 };
        if value > i64::MAX as i128 || value < i64::MIN as i128 {
            return 0;
        }
        value as i64 as i32
    }

    /// SafeNormal's FCOMP against the embedded double 1e-08: true on
    /// less-than or unordered.
    pub fn below_1em8(self) -> bool {
        const TINY: u128 = 0x15_798e_e230_8c3a; // 1e-08 = TINY * 2^-79
        if self.nan() {
            return true;
        }
        if self.inf() {
            return self.sign != 0;
        }
        if self.sig == 0 || self.sign != 0 {
            return true;
        }
        let shift = self.exp + 79;
        if shift >= 0 {
            // sig >= 2^63, so any shift above 53 already exceeds TINY.
            shift < 64 && ((self.sig as u128) << shift) < TINY
        } else if -shift >= 75 {
            true
        } else {
            (self.sig as u128) < (TINY << (-shift) as u32)
        }
    }
}

/// `hi:lo` (a 128-bit magnitude) times 2^exp rounded once to a 64-bit significand, nearest-even, or left-shifted to 64 bits:
/// x87_ref::normalized on limbs.
#[inline(always)]
fn norm_hl(hi: u64, lo: u64, exp: i32, sign: u32) -> Ext {
    if hi == 0 {
        if lo == 0 {
            return Ext::zero(sign);
        }
        let s = lo.leading_zeros();
        return Ext { sig: lo << s, exp: exp - s as i32, sign, special: 0 };
    }
    // The value is 64 + (64 - lz) bits wide: shift = 64 - lz bits are dropped, `rem` is them left-aligned in a word.
    let lz = hi.leading_zeros();
    let (mut q, rem) = if lz == 0 { (hi, lo) } else { ((hi << lz) | (lo >> (64 - lz)), lo << lz) };
    let mut e = exp + (64 - lz) as i32;
    if rem > 1 << 63 || (rem == 1 << 63 && q & 1 != 0) {
        q = q.wrapping_add(1);
        if q == 0 {
            q = 1 << 63;
            e += 1;
        }
    }
    Ext { sig: q, exp: e, sign, special: 0 }
}

/// The 128-bit product of two words: (high, low).
#[inline(always)]
fn mul_wide(a: u64, b: u64) -> (u64, u64) {
    let (a0, a1) = (a & 0xffff_ffff, a >> 32);
    let (b0, b1) = (b & 0xffff_ffff, b >> 32);
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 32) + (p01 & 0xffff_ffff) + (p10 & 0xffff_ffff);
    (p11 + (p01 >> 32) + (p10 >> 32) + (mid >> 32), (p00 & 0xffff_ffff) | (mid << 32))
}

/// floor(u1:u0 / v) and the remainder, for v >= 2^63 and u1 < v (Hacker's Delight `divlu` with a zero shift: two 64/32 digit steps,
/// each corrected by at most two).
#[inline(always)]
fn divlu(u1: u64, u0: u64, v: u64) -> (u64, u64) {
    const B: u64 = 1 << 32;
    let (vn1, vn0) = (v >> 32, v & 0xffff_ffff);
    let (un1, un0) = (u0 >> 32, u0 & 0xffff_ffff);
    let mut q1 = u1 / vn1;
    let mut rhat = u1 - q1 * vn1;
    while q1 >= B || q1 * vn0 > (rhat << 32) + un1 {
        q1 -= 1;
        rhat += vn1;
        if rhat >= B {
            break;
        }
    }
    let un21 = (u1 << 32).wrapping_add(un1).wrapping_sub(q1.wrapping_mul(v));
    let mut q0 = un21 / vn1;
    rhat = un21 - q0 * vn1;
    while q0 >= B || q0 * vn0 > (rhat << 32) + un0 {
        q0 -= 1;
        rhat += vn1;
        if rhat >= B {
            break;
        }
    }
    ((q1 << 32) | q0, (un21 << 32).wrapping_add(un0).wrapping_sub(q0.wrapping_mul(v)))
}

/// floor(sqrt(n)) for n below 2^128. An n of at least 2^126 (the shapes `sqrt` makes) starts from the high word's 32-bit root
/// and takes Newton steps from above, each a 128/64 division; any other n, and a step the division cannot take, the reference loop.
fn isqrt(n: u128) -> u128 {
    let hi = (n >> 64) as u64;
    if cfg!(feature = "x87_ref") || hi < 1 << 62 {
        return x87_ref::isqrt(n);
    }
    // s = floor(sqrt(hi)), 32 bits; the root r of n satisfies s * 2^32 <= r < (s + 1) * 2^32, so (s + 1) * 2^32 is above it.
    let (mut res, mut bit, mut rest) = (0u64, 1u64 << 62, hi);
    while bit != 0 {
        if rest >= res + bit {
            rest -= res + bit;
            res = (res >> 1) + bit;
        } else {
            res >>= 1;
        }
        bit >>= 2;
    }
    let mut x: u128 = (res as u128 + 1) << 32;
    loop {
        // n / x with x >= r >= 2^63: the 128/64 division needs hi < x; x = 2^64 divides by shifting.
        let quotient = if x >> 64 != 0 {
            hi as u128
        } else if hi >= x as u64 {
            return x87_ref::isqrt(n);
        } else {
            divlu(hi, n as u64, x as u64).0 as u128
        };
        let y = (x + quotient) >> 1;
        if y >= x {
            return x;
        }
        x = y;
    }
}

pub fn round_right(value: u128, shift: u32) -> u128 {
    x87_ref::round_right(value, shift)
}
