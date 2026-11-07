//! The reference bodies of x87.rs's add, multiply, divide, square root and normalization (docs/firefox-60fps-plan.md "Combat tick"):
//! the u128 integer forms the module shipped with until 2026-11-06, which scripts/validate-script-vm-x87.mjs, the native operator
//! validators and every state digest were checked against. x87.rs now runs the same arithmetic on u64 limbs (a widening multiply
//! without `__multi3`, a 128/64 division without `u128_div_rem`, a square root seeded by a 32-bit root); these bodies stay, unchanged,
//! to say what the new ones must return:
//!
//! * `--features x87_ref` makes every `Ext` operation run them (the A/B build, `?x87=ref` / `X87=ref` load that module);
//! * `--features selftest` exports `x87_fast_selftest`, which compares the two over generated operands (scripts/validate-x87-fast.mjs).
//!
//! In the shipped module nothing reaches this file except the fast bodies' own fallbacks for an `Ext` whose significand is not
//! normalized (lipsync.rs builds such values from an 80-bit memory word) and the precision-control-24 rounding.

use crate::x87::{precision, Ext, INDEFINITE};

/// `Ext::normalized`: `sig * 2^exp` rounded once to a 64-bit significand, nearest-even (or left-shifted to 64 bits).
pub fn normalized(mut sig: u128, mut exp: i32, sign: u32) -> Ext {
    if sig == 0 {
        return Ext::zero(sign);
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
    Ext { sig: sig as u64, exp, sign, special: 0 }
}

/// An arithmetic result: the exact (or sticky-jammed) `sig·2^exp` rounded once to the precision control's width, nearest-even, then
/// held normalized to 64 bits.
pub fn rounded(sig: u128, exp: i32, sign: u32) -> Ext {
    if precision() == 24 && sig != 0 {
        let width = 128 - sig.leading_zeros();
        if width > 24 {
            let shift = width - 24;
            return normalized(round_right(sig, shift), exp + shift as i32, sign);
        }
    }
    normalized(sig, exp, sign)
}

pub fn add(this: Ext, other: Ext) -> Ext {
    if this.nan() || other.nan() {
        return nan_pair(this, other);
    }
    if this.inf() || other.inf() {
        return if this.inf() && other.inf() && this.sign != other.sign {
            Ext::load(INDEFINITE)
        } else if this.inf() {
            this
        } else {
            other
        };
    }
    if this.sig == 0 {
        return if other.sig == 0 { Ext::zero(this.sign & other.sign) } else { other };
    }
    if other.sig == 0 {
        return this;
    }
    let (a, b) = if (this.exp, this.sig) >= (other.exp, other.sig) { (this, other) } else { (other, this) };
    // Three guard bits plus a jammed low bit preserve nearest-even after
    // alignment; a larger exponent gap cannot cancel into the guard bits.
    let left = (a.sig as u128) << 3;
    let right = shift_jam((b.sig as u128) << 3, (a.exp - b.exp) as u32);
    let sum = if a.sign == b.sign { left + right } else { left - right };
    rounded(sum, a.exp - 3, if sum == 0 { this.sign & other.sign } else { a.sign })
}

pub fn mul(this: Ext, other: Ext) -> Ext {
    if this.nan() || other.nan() {
        return nan_pair(this, other);
    }
    let sign = this.sign ^ other.sign;
    if this.inf() || other.inf() {
        let finite = if this.inf() { other } else { this };
        return Ext::load(if !finite.inf() && finite.sig == 0 { INDEFINITE } else { sign | 0x7f80_0000 });
    }
    rounded(this.sig as u128 * other.sig as u128, this.exp + other.exp, sign)
}

/// FDIV: 0/0 and inf/inf are the indefinite, x/0 a signed infinity and x/inf a signed zero; a finite quotient is correctly rounded.
pub fn div(this: Ext, other: Ext) -> Ext {
    if this.nan() || other.nan() {
        return nan_pair(this, other);
    }
    let sign = this.sign ^ other.sign;
    if this.inf() || other.inf() {
        if this.inf() && other.inf() {
            return Ext::load(INDEFINITE);
        }
        return if this.inf() { Ext::load(sign | 0x7f80_0000) } else { Ext::zero(sign) };
    }
    if other.sig == 0 {
        return if this.sig == 0 { Ext::load(INDEFINITE) } else { Ext::load(sign | 0x7f80_0000) };
    }
    if this.sig == 0 {
        return Ext::zero(sign);
    }
    div_finite(this, other)
}

/// The finite, nonzero quotient of `div`.
pub fn div_finite(this: Ext, other: Ext) -> Ext {
    let sign = this.sign ^ other.sign;
    let num = (this.sig as u128) << 64;
    let den = other.sig as u128;
    let q = num / den;
    // q has 64 or 65 bits. Two more quotient bits from the remainder give
    // the round bit in either case; the rest of the remainder is sticky.
    let rem = (num % den) << 2;
    let extra = rem / den;
    let sticky = u128::from(rem % den != 0);
    rounded((q << 3) | (extra << 1) | sticky, this.exp - other.exp - 67, sign)
}

/// FSQRT of a finite nonnegative value or +inf; a zero keeps its sign.
pub fn sqrt(this: Ext) -> Ext {
    if this.inf() {
        return Ext::load(0x7f80_0000);
    }
    if this.sig == 0 {
        return this;
    }
    sqrt_finite(this)
}

/// The finite, nonzero root of `sqrt`.
pub fn sqrt_finite(this: Ext) -> Ext {
    let mut sig = this.sig as u128;
    let mut exp = this.exp;
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
        return rounded((q << 1) | sticky, exp / 2 - shift / 2 - 1, 0);
    }
    // The root is never exactly halfway: q + 1 wins iff n2 - q^2 > q.
    if n2 - q * q > q {
        q += 1;
    }
    normalized(q, exp / 2 - shift / 2, 0)
}

/// FST/FSTP m32: the float32 word (x87.rs `store`, whose normal-range rounding now runs on one word; the denormal branch is unchanged).
pub fn store(this: Ext) -> u32 {
    if this.special != 0 {
        return this.special;
    }
    if this.sig == 0 {
        return this.sign;
    }
    let mut e = this.exp + 63;
    if e > 127 {
        return this.sign | 0x7f80_0000;
    }
    if e >= -126 {
        let mut sig = round_right(this.sig as u128, 40) as u32;
        if sig >= 1 << 24 {
            sig >>= 1;
            e += 1;
        }
        if e > 127 {
            return this.sign | 0x7f80_0000;
        }
        this.sign | (((e + 127) as u32) << 23) | (sig - (1 << 23))
    } else {
        this.sign | round_right(this.sig as u128, (-149 - this.exp) as u32) as u32
    }
}

/// FSTL m64 kept in the model: the significand rounded to 53 bits.
pub fn store_double(this: Ext) -> Ext {
    if this.special != 0 || this.sig == 0 {
        return this;
    }
    normalized(round_right(this.sig as u128, 11), this.exp + 11, this.sign)
}

/// A NaN operand pair: the larger significand wins, the positive payload on a tie; a lone NaN quiets.
pub fn nan_pair(this: Ext, other: Ext) -> Ext {
    if !this.nan() {
        return other.quiet();
    }
    if !other.nan() {
        return this.quiet();
    }
    let a = this.special & 0x7f_ffff;
    let b = other.special & 0x7f_ffff;
    if b > a || (a == b && other.special >> 31 == 0) {
        other.quiet()
    } else {
        this.quiet()
    }
}

pub fn shift_jam(value: u128, shift: u32) -> u128 {
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
pub fn isqrt(n: u128) -> u128 {
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

/// `cargo build --features selftest`: the limb arithmetic of x87.rs against the bodies above over generated operands, exported as
/// `x87_fast_selftest` (scripts/validate-x87-fast.mjs runs it) and `x87_fast_bench` (timing of both).
#[cfg(feature = "selftest")]
pub mod selftest {
    use super::*;
    use crate::x87::set_x87_precision;

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        /// A 64-bit significand with bit 63 set, of one of several shapes: random, all ones, one bit, a halfway pattern, long runs.
        fn sig(&mut self) -> u64 {
            let r = self.next();
            let s = match self.next() % 10 {
                0 => u64::MAX,
                1 => 1 << 63,
                2 => (1 << 63) | 1,
                3 => (1 << 63) | (1 << (self.next() % 63)),
                4 => u64::MAX << (self.next() % 63),
                5 => (u64::MAX >> (self.next() % 63)) | (1 << 63),
                6 => (r | (1 << 63)) & !((1u64 << (self.next() % 40)) - 1),
                7 => 0x8000_0000_0000_0400 | ((self.next() % 3) << 10),
                _ => r,
            };
            s | (1 << 63)
        }
        fn finite(&mut self) -> Ext {
            let exp = match self.next() % 6 {
                0 => 0,
                1 => (self.next() % 5) as i32 - 2,
                2 => (self.next() % 140) as i32 - 70,
                3 => (self.next() % 400) as i32 - 200,
                4 => (self.next() % 40000) as i32 - 20000,
                _ => (self.next() % 160) as i32 - 80,
            };
            let sign = if self.next() & 1 == 0 { 0 } else { 0x8000_0000 };
            match self.next() % 28 {
                0 => Ext::zero(sign),
                // a significand that is not normalized (lipsync.rs builds these from an 80-bit memory word): every operation takes its reference path
                24 | 25 => Ext { sig: (self.sig() >> (1 + self.next() % 63)) | (self.next() % 2), exp, sign, special: 0 },
                26 => Ext { sig: self.next() >> (self.next() % 64), exp, sign, special: 0 },
                1 => Ext::load(sign | 0x7f80_0000),
                2 => Ext::load(sign | 0x7f80_0000 | (self.next() as u32 & 0x7f_ffff) | 1),
                3 => Ext::load(0xffc0_0000),
                _ => Ext { sig: self.sig(), exp, sign, special: 0 },
            }
        }
        /// A pair whose exponents are close (the cancelling and aligning cases of add).
        fn pair(&mut self) -> (Ext, Ext) {
            let a = self.finite();
            let mut b = self.finite();
            if a.special == 0 && a.sig != 0 && b.special == 0 && b.sig != 0 && self.next() % 3 != 0 {
                b.exp = a.exp - 70 + (self.next() % 140) as i32;
                if self.next() % 4 == 0 {
                    b.sig = a.sig.wrapping_add(self.next() % 5).wrapping_sub(2) | (1 << 63);
                    b.exp = a.exp - (self.next() % 3) as i32;
                }
            }
            (a, b)
        }
    }

    /// IO: [0] cases, [1] mismatches, [2..] the first mismatch (op, a.sig lo, a.sig hi, a.exp, a.sign, a.special, b..., got, want).
    static mut IO: [u32; 48] = [0; 48];
    #[no_mangle]
    pub extern "C" fn x87_selftest_io_ptr() -> *mut u32 {
        core::ptr::addr_of_mut!(IO) as *mut u32
    }

    fn same(x: Ext, y: Ext) -> bool {
        x == y
    }

    unsafe fn record(op: u32, a: Ext, b: Ext, got: Ext, want: Ext) {
        let io = &mut *core::ptr::addr_of_mut!(IO);
        io[1] += 1;
        io[40 + op as usize] += 1;
        if io[1] == 1 {
            io[2] = op;
            let mut at = 3;
            for e in [a, b, got, want] {
                io[at] = e.sig as u32;
                io[at + 1] = (e.sig >> 32) as u32;
                io[at + 2] = e.exp as u32;
                io[at + 3] = e.sign;
                io[at + 4] = e.special;
                at += 5;
            }
        }
    }

    /// Mismatches between Ext's add, mul, div, sqrt and normalized and the reference bodies over `rounds` generated operand pairs at
    /// precision control `precision` (24 or 64); `IO[0]` counts the comparisons made.
    #[no_mangle]
    pub extern "C" fn x87_fast_selftest(seed: u32, rounds: u32, precision: u32) -> u32 {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15 ^ ((seed as u64) << 32 | seed as u64));
        let previous = set_x87_precision(precision);
        unsafe {
            let io = &mut *core::ptr::addr_of_mut!(IO);
            io[0] = 0;
            io[1] = 0;
            for i in 40..48 {
                io[i] = 0;
            }
        }
        for _ in 0..rounds {
            let (a, b) = rng.pair();
            unsafe {
                (*core::ptr::addr_of_mut!(IO))[0] += 7;
                let (got, want) = (a.add(b), add(a, b));
                if !same(got, want) { record(1, a, b, got, want); }
                let (got, want) = (a.mul(b), mul(a, b));
                if !same(got, want) { record(2, a, b, got, want); }
                let (got, want) = (a.div(b), div(a, b));
                if !same(got, want) { record(3, a, b, got, want); }
                let (got, want) = (a.sqrt(), sqrt(a));
                if !same(got, want) { record(4, a, b, got, want); }
                let (got, want) = (a.store(), store(a));
                if got != want { record(6, a, b, Ext { sig: got as u64, ..Ext::zero(0) }, Ext { sig: want as u64, ..Ext::zero(0) }); }
                let (got, want) = (a.store_double(), store_double(a));
                if !same(got, want) { record(7, a, b, got, want); }
                // normalized: a 128-bit magnitude of random width, with the rounding boundaries of every shift
                let width = 1 + (rng.next() % 128) as u32;
                let mut v = if width == 128 { (rng.next() as u128) << 64 | rng.next() as u128 } else { ((rng.next() as u128) << 64 | rng.next() as u128) & ((1u128 << width) - 1) };
                v |= 1u128 << (width - 1);
                match rng.next() % 4 {
                    0 => v &= !((1u128 << (width.saturating_sub(65) as u32)) - 1) | (1u128 << (width - 1)),
                    1 if width > 65 => v = (v & !((1u128 << (width - 64)) - 1)) | (1u128 << (width - 65)),
                    2 if width > 65 => v = (v | ((1u128 << (width - 64)) - 1)) & !(1u128 << (width - 65)),
                    _ => {}
                }
                let exp = (rng.next() % 2000) as i32 - 1000;
                let sign = if rng.next() & 1 == 0 { 0 } else { 0x8000_0000 };
                let (got, want) = (Ext::normalized(v, exp, sign), normalized(v, exp, sign));
                if !same(got, want) { record(5, Ext { sig: v as u64, exp, sign, special: 0 }, Ext { sig: (v >> 64) as u64, exp, sign, special: 0 }, got, want); }
            }
        }
        set_x87_precision(previous);
        unsafe { (*core::ptr::addr_of_mut!(IO))[1] }
    }

    /// Operations a second over generated finite operands: `kind` 0 add, 1 mul, 2 div, 3 sqrt, 4 a dot product's mixed chain; `reference`
    /// 1 runs the reference bodies. Returns a checksum (so the optimizer keeps the work).
    #[no_mangle]
    pub extern "C" fn x87_fast_bench(kind: u32, reference: u32, rounds: u32) -> u32 {
        let mut rng = Rng(0x2545_f491_4f6c_dd1d);
        let mut set = [Ext::zero(0); 256];
        for e in set.iter_mut() {
            *e = Ext { sig: rng.next() | (1 << 63), exp: (rng.next() % 40) as i32 - 20, sign: if rng.next() & 1 == 0 { 0 } else { 0x8000_0000 }, special: 0 };
        }
        let mut acc = Ext::load(0x3f80_0000);
        let mut sum = 0u32;
        for i in 0..rounds as usize {
            let a = set[i & 255];
            let b = set[(i.wrapping_mul(7) + 3) & 255];
            let r = if reference == 0 {
                match kind { 0 => a.add(b), 1 => a.mul(b), 2 => a.div(b), 3 => Ext { sign: 0, ..a }.sqrt(), _ => acc.add(a.mul(b)).store_double() }
            } else {
                match kind { 0 => add(a, b), 1 => mul(a, b), 2 => div(a, b), 3 => sqrt(Ext { sign: 0, ..a }), _ => add(acc, mul(a, b)).store_double() }
            };
            acc = if kind == 4 { r } else { acc };
            sum = sum.wrapping_add(r.sig as u32).wrapping_add(r.exp as u32);
        }
        sum
    }
}
