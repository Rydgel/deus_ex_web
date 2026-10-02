//! Exact x87 arithmetic for the one floating-point loop the module player
//! depends on: glxInit's equal-power pan table (0x1060e246..0x1060e283):
//!
//! ```text
//! for i in 0..0x8000: fild dword i; fmul qword [0x1063ec38] (1/32767);
//!                     fsqrt; fmul qword [0x1063ec30] (32767.0); call _ftol
//! ```
//!
//! Every operation rounds to the precision-control width (PC 24, 53 or 64
//! bits, round to nearest even) and _ftol truncates. This is computed with
//! integer mantissas, never with host floats (docs/galaxy-music/sequencer.md
//! §10). Validated against Unicorn, which honours PC (0x037f, 0x027f, 0x007f),
//! by scripts/validate-galaxy-music-sequencer.mjs. Which PC Galaxy's init runs
//! under in the game is open (the D3D FPUSETUP question).

/// 1/32767 as stored at 0x1063ec38 (`80 00 40 00 20 00 00 3f`).
const INV_32767: u64 = 0x3f00_0020_0040_0080;
/// 32767.0 as stored at 0x1063ec30.
const F_32767: u64 = 0x40df_ffc0_0000_0000;

/// A positive finite value m * 2^e.
#[derive(Clone, Copy)]
struct Value {
    m: u128,
    e: i32,
}

fn bits(m: u128) -> u32 {
    128 - m.leading_zeros()
}

/// Round to `p` significant bits, nearest even; `sticky` = nonzero bits
/// below m's last bit (m must then carry more than p bits).
fn round(v: Value, p: u32, sticky: bool) -> Value {
    let n = bits(v.m);
    if n <= p {
        assert!(!sticky, "x87 model: sticky bits without guard bits");
        return v;
    }
    let shift = n - p;
    let kept = v.m >> shift;
    let rest = v.m & ((1u128 << shift) - 1);
    let half = 1u128 << (shift - 1);
    let up = rest > half || (rest == half && (sticky || kept & 1 == 1));
    let m = kept + up as u128;
    Value { m, e: v.e + shift as i32 }
}

fn from_f64(bits_: u64) -> Value {
    let exp = ((bits_ >> 52) & 0x7ff) as i32;
    let frac = (bits_ & ((1 << 52) - 1)) as u128;
    Value { m: frac | (1 << 52), e: exp - 1075 }
}

fn mul(a: Value, b: Value, p: u32) -> Value {
    round(Value { m: a.m * b.m, e: a.e + b.e }, p, false)
}

/// fsqrt rounded to p bits: digit-by-digit root with p + 2 bits and a sticky remainder.
fn sqrt(a: Value, p: u32) -> Value {
    let (mut m, mut e) = (a.m, a.e);
    if e & 1 != 0 {
        m <<= 1;
        e -= 1;
    }
    let pairs_m = (bits(m) + 1) / 2;
    let extra = (p + 2).saturating_sub(pairs_m);
    let (mut root, mut rem) = (0u128, 0u128);
    for i in (0..pairs_m + extra).rev() {
        let two = if i >= extra { (m >> (2 * (i - extra))) & 3 } else { 0 };
        rem = (rem << 2) | two;
        let trial = (root << 2) | 1;
        if rem >= trial {
            rem -= trial;
            root = (root << 1) | 1;
        } else {
            root <<= 1;
        }
    }
    round(Value { m: root, e: e / 2 - extra as i32 }, p, rem != 0)
}

/// _ftol of a positive value: truncation toward zero.
fn trunc(v: Value) -> i32 {
    if v.e >= 0 {
        (v.m << v.e) as i32
    } else if v.e <= -128 {
        0
    } else {
        (v.m >> (-v.e)) as i32
    }
}

/// glxInit's table [0x10698390] under precision control `pc` (24, 53 or 64).
pub(crate) fn pan_table(pc: u32) -> Vec<i16> {
    let k = from_f64(INV_32767);
    let c = from_f64(F_32767);
    let mut out = vec![0i16; 0x8000];
    for i in 1..0x8000u32 {
        let x = mul(Value { m: i as u128, e: 0 }, k, pc);
        let s = sqrt(x, pc);
        out[i as usize] = trunc(mul(s, c, pc)) as i16;
    }
    out
}
