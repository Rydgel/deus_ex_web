//! The 80-bit x87 stack model of Core's float and vector operators, the
//! integer form of `x87*` in src/runtime/script-vm.mjs (docs/rust-core.md).
//!
//! A finite value is `(-1)^sign * sig * 2^exp` with `sig` normalized to 64
//! bits (bit 63 set) or zero. `special` holds the float32 bits of an infinity
//! or NaN, so a NaN keeps its payload as the JavaScript model's `{nan}` does.
//! Every operation rounds once to a 64-bit significand, nearest-even, as the
//! JavaScript model's BigInt arithmetic does; the two are compared by
//! scripts/validate-script-vm-x87.mjs.

pub const INDEFINITE: u32 = 0xffc0_0000;

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

    pub fn normalized(mut sig: u128, mut exp: i32, sign: u32) -> Self {
        if sig == 0 {
            return Self::zero(sign);
        }
        let width = 128 - sig.leading_zeros();
        if width > 64 {
            let shift = width - 64;
            sig = round_right(sig, shift);
            exp += shift as i32;
            if sig >= 1u128 << 64 {
                sig >>= 1;
                exp += 1;
            }
        } else {
            let shift = 64 - width;
            sig <<= shift;
            exp -= shift as i32;
        }
        Self { sig: sig as u64, exp, sign, special: 0 }
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
    /// A NaN operand pair: the larger significand wins, the positive payload
    /// on a tie; a lone NaN quiets.
    fn nan_pair(self, other: Self) -> Self {
        if !self.nan() {
            return other.quiet();
        }
        if !other.nan() {
            return self.quiet();
        }
        let a = self.special & 0x7f_ffff;
        let b = other.special & 0x7f_ffff;
        if b > a || (a == b && other.special >> 31 == 0) {
            other.quiet()
        } else {
            self.quiet()
        }
    }

    pub fn add(self, other: Self) -> Self {
        if self.nan() || other.nan() {
            return self.nan_pair(other);
        }
        if self.inf() || other.inf() {
            return if self.inf() && other.inf() && self.sign != other.sign {
                Self::load(INDEFINITE)
            } else if self.inf() {
                self
            } else {
                other
            };
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
        let right = shift_jam((b.sig as u128) << 3, (a.exp - b.exp) as u32);
        let sum = if a.sign == b.sign { left + right } else { left - right };
        Self::normalized(sum, a.exp - 3, if sum == 0 { self.sign & other.sign } else { a.sign })
    }

    pub fn mul(self, other: Self) -> Self {
        if self.nan() || other.nan() {
            return self.nan_pair(other);
        }
        let sign = self.sign ^ other.sign;
        if self.inf() || other.inf() {
            let finite = if self.inf() { other } else { self };
            return Self::load(if !finite.inf() && finite.sig == 0 { INDEFINITE } else { sign | 0x7f80_0000 });
        }
        Self::normalized(self.sig as u128 * other.sig as u128, self.exp + other.exp, sign)
    }

    /// FDIV: 0/0 and inf/inf are the indefinite, x/0 a signed infinity and
    /// x/inf a signed zero; a finite quotient is correctly rounded.
    pub fn div(self, other: Self) -> Self {
        if self.nan() || other.nan() {
            return self.nan_pair(other);
        }
        let sign = self.sign ^ other.sign;
        if self.inf() || other.inf() {
            if self.inf() && other.inf() {
                return Self::load(INDEFINITE);
            }
            return if self.inf() { Self::load(sign | 0x7f80_0000) } else { Self::zero(sign) };
        }
        if other.sig == 0 {
            return if self.sig == 0 { Self::load(INDEFINITE) } else { Self::load(sign | 0x7f80_0000) };
        }
        if self.sig == 0 {
            return Self::zero(sign);
        }
        let num = (self.sig as u128) << 64;
        let den = other.sig as u128;
        let q = num / den;
        // q has 64 or 65 bits. Two more quotient bits from the remainder give
        // the round bit in either case; the rest of the remainder is sticky.
        let rem = (num % den) << 2;
        let extra = rem / den;
        let sticky = u128::from(rem % den != 0);
        Self::normalized((q << 3) | (extra << 1) | sticky, self.exp - other.exp - 67, sign)
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
        if self.inf() {
            return Self::load(0x7f80_0000);
        }
        if self.sig == 0 {
            return self;
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
        // The root is never exactly halfway: q + 1 wins iff n2 - q^2 > q.
        if n2 - q * q > q {
            q += 1;
        }
        Self::normalized(q, exp / 2 - shift / 2, 0)
    }

    /// FST/FSTP m32: nearest-even to 24 bits with denormal and overflow
    /// boundaries.
    pub fn store(self) -> u32 {
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
            let mut sig = round_right(self.sig as u128, 40) as u32;
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

    /// FSTL m64 kept in the model: the significand rounded to 53 bits.
    pub fn store_double(self) -> Self {
        if self.special != 0 || self.sig == 0 {
            return self;
        }
        Self::normalized(round_right(self.sig as u128, 11), self.exp + 11, self.sign)
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

fn shift_jam(value: u128, shift: u32) -> u128 {
    if shift == 0 {
        value
    } else if shift >= 128 {
        u128::from(value != 0)
    } else {
        (value >> shift) | u128::from(value & ((1u128 << shift) - 1) != 0)
    }
}

pub fn round_right(value: u128, shift: u32) -> u128 {
    if shift == 0 {
        return value;
    }
    if shift > 128 {
        return 0;
    }
    if shift == 128 {
        return u128::from(value > 1u128 << 127);
    }
    let q = value >> shift;
    let rem = value & ((1u128 << shift) - 1);
    let half = 1u128 << (shift - 1);
    q + u128::from(rem > half || (rem == half && q & 1 != 0))
}

/// floor(sqrt(n)) for n below 2^128.
fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let width = 128 - n.leading_zeros();
    let mut x: u128 = 1u128 << ((width + 1) >> 1).min(64);
    loop {
        let y = (x + n / x) >> 1;
        if y >= x {
            return x;
        }
        x = y;
    }
}
