//! Original GetFrame vertex loops; see docs/lodmesh-wasm.md for native evidence.
//! No floating arithmetic substitutes for x87: all intermediates round to a
//! 64-bit significand, with explicit f32 stores at the original instructions.
use std::cell::RefCell;

#[derive(Clone, Copy)]
struct Ext {
    sig: u64,
    exp: i32,
    sign: u32,
    special: u32, // zero = finite; otherwise the original f32 infinity/NaN bits
}

impl Ext {
    fn zero(sign: u32) -> Self {
        Self {
            sig: 0,
            exp: 0,
            sign,
            special: 0,
        }
    }

    fn load(bits: u32) -> Self {
        let sign = bits & 0x80000000;
        let e = (bits >> 23) & 255;
        let m = bits & 0x7fffff;
        if e == 255 {
            return Self {
                special: bits,
                ..Self::zero(sign)
            };
        }
        let sig = if e == 0 { m } else { m | 0x800000 };
        Self::normalized(
            sig as u128,
            if e == 0 { -149 } else { e as i32 - 150 },
            sign,
        )
    }

    fn normalized(mut sig: u128, mut exp: i32, sign: u32) -> Self {
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
        Self {
            sig: sig as u64,
            exp,
            sign,
            special: 0,
        }
    }

    fn nan(self) -> bool {
        self.special & 0x7fffff != 0
    }
    fn inf(self) -> bool {
        self.special & 0x7fffffff == 0x7f800000
    }
    fn quiet(self) -> Self {
        Self::load(self.special | 0x400000)
    }
    fn neg(mut self) -> Self {
        // FSUB does not invert a NaN payload's sign.
        if !self.nan() {
            self.sign ^= 0x80000000;
            if self.inf() {
                self.special ^= 0x80000000;
            }
        }
        self
    }
    fn nan_pair(self, other: Self) -> Self {
        if !self.nan() {
            return other.quiet();
        }
        if !other.nan() {
            return self.quiet();
        }
        let a = self.special & 0x7fffff;
        let b = other.special & 0x7fffff;
        if b > a || (a == b && other.sign == 0) {
            other.quiet()
        } else {
            self.quiet()
        }
    }

    fn add(self, other: Self) -> Self {
        if self.nan() || other.nan() {
            return self.nan_pair(other);
        }
        if self.inf() || other.inf() {
            return if self.inf() && other.inf() && self.sign != other.sign {
                Self::load(0xffc00000)
            } else if self.inf() {
                self
            } else {
                other
            };
        }
        if self.sig == 0 {
            return if other.sig == 0 {
                Self::zero(self.sign & other.sign)
            } else {
                other
            };
        }
        if other.sig == 0 {
            return self;
        }
        let (a, b) = if (self.exp, self.sig) >= (other.exp, other.sig) {
            (self, other)
        } else {
            (other, self)
        };
        // Three guard bits plus a jammed low bit preserve nearest-even after
        // alignment. Cancellation at equal/adjacent exponents is exact; larger
        // exponent gaps cannot cancel the guard/round region.
        let left = (a.sig as u128) << 3;
        let right = shift_jam((b.sig as u128) << 3, (a.exp - b.exp) as u32);
        let sum = if a.sign == b.sign {
            left + right
        } else {
            left - right
        };
        Self::normalized(
            sum,
            a.exp - 3,
            if sum == 0 {
                self.sign & other.sign
            } else {
                a.sign
            },
        )
    }
    fn sub(self, other: Self) -> Self {
        self.add(other.neg())
    }

    fn mul(self, other: Self) -> Self {
        if self.nan() || other.nan() {
            return self.nan_pair(other);
        }
        let sign = self.sign ^ other.sign;
        if self.inf() || other.inf() {
            let finite = if self.inf() { other } else { self };
            return Self::load(if !finite.inf() && finite.sig == 0 {
                0xffc00000
            } else {
                sign | 0x7f800000
            });
        }
        Self::normalized(
            self.sig as u128 * other.sig as u128,
            self.exp + other.exp,
            sign,
        )
    }

    fn store(self) -> u32 {
        if self.special != 0 {
            return self.special;
        }
        if self.sig == 0 {
            return self.sign;
        }
        let mut e = self.exp + 63;
        if e > 127 {
            return self.sign | 0x7f800000;
        }
        if e >= -126 {
            let mut sig = round_right(self.sig as u128, 40) as u32;
            if sig >= 1 << 24 {
                sig >>= 1;
                e += 1;
            }
            if e > 127 {
                return self.sign | 0x7f800000;
            }
            self.sign | (((e + 127) as u32) << 23) | (sig - (1 << 23))
        } else {
            self.sign | round_right(self.sig as u128, (-149 - self.exp) as u32) as u32
        }
    }
    fn stored(self) -> Self {
        Self::load(self.store())
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

fn round_right(value: u128, shift: u32) -> u128 {
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

thread_local! { static WORK: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) }; }

/// Scratch ABI (u32 words): matrix[12], origin[3], reserved[1], three packed
/// i16 frames (2*count each), cache (3*count), output (stride/4*count).
/// JS refreshes memory views after reserve; no callbacks/reentry during pose.
#[no_mangle]
pub extern "C" fn reserve(words: usize) -> *mut u32 {
    WORK.with_borrow_mut(|work| {
        if work.len() < words {
            work.resize(words, 0);
        }
        work.as_mut_ptr()
    })
}

fn vertex(work: &[u32], at: usize, axis: usize) -> u32 {
    let packed = work[at + axis / 2];
    (((packed >> ((axis % 2) * 16)) as i16) as f32).to_bits()
}

#[no_mangle]
pub extern "C" fn pose(count: usize, stride: usize, alpha: u32, tween: u32, blend: u32) {
    WORK.with_borrow_mut(|work| {
        assert!(stride >= 3 && tween <= 1 && blend <= 1);
        let first = 16;
        let second = first + count * 2;
        let base_frame = second + count * 2;
        let cache = base_frame + count * 2;
        let output = cache + count * 3;
        assert!(output + count * stride <= work.len());
        let matrix: [Ext; 12] = std::array::from_fn(|i| Ext::load(work[i]));
        let origin: [Ext; 3] = std::array::from_fn(|i| Ext::load(work[12 + i]));
        let interpolate = f32::from_bits(alpha) > 0.0;
        let alpha = Ext::load(alpha);
        for i in 0..count {
            let vector: [Ext; 3] = std::array::from_fn(|axis| {
                let at = cache + i * 3 + axis;
                let a = if tween != 0 {
                    work[at]
                } else {
                    vertex(work, first + i * 2, axis)
                };
                let value = if interpolate {
                    let a = Ext::load(a);
                    let mut delta = Ext::load(vertex(work, second + i * 2, axis)).sub(a);
                    if axis != 0 {
                        delta = delta.stored();
                    }
                    let mut product = delta.mul(alpha);
                    if axis != 0 {
                        product = product.stored();
                    }
                    product.add(a).store()
                } else {
                    a
                };
                work[at] = value;
                let reference = if blend != 0 {
                    Ext::load(vertex(work, base_frame + i * 2, axis))
                } else {
                    origin[axis]
                };
                let component = Ext::load(value).sub(reference).stored();
                if blend != 0 {
                    component
                } else {
                    component.sub(matrix[axis])
                }
            });
            for axis in 0..3 {
                let row = 3 + axis * 3;
                let result = vector[0]
                    .mul(matrix[row])
                    .add(vector[1].mul(matrix[row + 1]))
                    .add(vector[2].mul(matrix[row + 2]))
                    .store();
                let at = output + i * stride + axis;
                work[at] = if blend != 0 {
                    Ext::load(result).add(Ext::load(work[at])).store()
                } else {
                    result
                };
            }
        }
    });
}
