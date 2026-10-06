//! Galaxy's effects reverb, translated from Galaxy.dll (GOTY, preferred base
//! 0x10600000); docs/galaxy-music/reverb.md is the address-anchored contract:
//!
//! - glxSetSampleReverb 0x106113d0 (the SSE row: the hook [0x10688288] =
//!   0x10622d33, the context [0x10688284] (re)allocated to 0x60188 bytes);
//! - the SSE setup 0x106109f0 (x87, game thread): the context cleared, the
//!   output gain, the low-pass coefficient from FCOS, the six delay taps and
//!   their gains, up to the output-type test 0x10610e8d. DX's output type
//!   [0x1069817a] is 0 (no EAX), so the setup returns there; the six-tap loop
//!   0x10610e2a before it only writes glxSampleReverb.Time (+8) of the
//!   library's copy, which nothing but the EAX branch reads (not modelled);
//! - the SSE kernel 0x10622d33, the renderer's effects hook on (d04 dry, d0c
//!   send): three two-lane allpass/low-pass stages over 0x4000-frame stereo
//!   lines, float32 under MXCSR 0x1f80 (Rust f32 is IEEE binary32 with the
//!   same rounding and denormals, and never fuses a multiply-add).
//!
//! x87: precision control 64 (the 80-bit model ext.rs; the game thread's
//! control word is the project's open FPUSETUP question, as for music). FCOS
//! is a transcendental: `fcos` is the correctly rounded cosine (a 100-bit
//! fixed-point Taylor sum). The host's x87 FCOS differs from it by one unit
//! in the last place at 5820 of the 44101 inputs the subsystem can produce
//! (CutoffHz 0..44100 at 44100 Hz), but its one consumer, the float32
//! low-pass coefficient k (and 1 - k), is equal at every one of them: the
//! original setup run natively on real x87 against this model, exhaustively
//! (scripts/validate-galaxy-reverb.mjs, scripts/native-galaxy-reverb-hw.c).
//! So the model is exact for the setup's output, not for FCOS itself.
use super::*;
use crate::ext::Ext;

pub const REVERB_BLOCK: usize = 0x6c; // sizeof(glxReverb)
pub const REVERB_CTX: usize = 0x60188; // the SSE engine's context
const LINES: [usize; 3] = [0xc8, 0x200c8, 0x40108];
const LINE_MASK: u32 = 0x3fff;

// Faults.
pub const UNSUPPORTED_REVERB_COS: u32 = 0x140; // a cosine whose rounding the model cannot decide (none among the reachable inputs)
// Test-only translation mutants (validate-galaxy-effects.mjs, validate-galaxy-reverb.mjs).
pub const MUTANT_REVERB_NO_CROSSFEED: u32 = 305; // the kernel without shufps xmm0, xmm0, 1
pub const MUTANT_REVERB_LOWPASS_SWAP: u32 = 306; // the line read weighted by 1 - k and the state by k
pub const UNSUPPORTED_REVERB_UNINIT: u32 = 0x141; // the setup refused a block on a fresh context: the kernel would read uninitialised heap

pub(crate) struct Reverb {
    /// [0x10688288] set (the SSE kernel installed).
    pub hook: bool,
    /// [0x10688284]: the context, empty when freed.
    pub ctx: Vec<u8>,
    /// The library's copy glxSampleReverb (0x10688220), as the setter copies it.
    pub global: [u8; REVERB_BLOCK],
    /// The host's argument buffer for galaxy_set_sample_reverb.
    pub block: [u8; REVERB_BLOCK],
    /// Calls of the setter, installs and frees (host status).
    pub calls: u32,
}

impl Reverb {
    pub(crate) fn new() -> Self {
        Reverb { hook: false, ctx: Vec::new(), global: [0; REVERB_BLOCK], block: [0; REVERB_BLOCK], calls: 0 }
    }
}

fn f32_at(b: &[u8], o: usize) -> f32 {
    f32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn put_f32(b: &mut [u8], o: usize, v: f32) {
    b[o..o + 4].copy_from_slice(&v.to_le_bytes());
}

// ---- FCOS ---------------------------------------------------------------------------

/// floor(a * b / 2^100) for nonnegative Q100 values below 2^120.
fn mul_q100(a: u128, b: u128) -> u128 {
    let (ah, al) = (a >> 64, a & u64::MAX as u128);
    let (bh, bl) = (b >> 64, b & u64::MAX as u128);
    let high = ah * bh;
    let mid = ah * bl + al * bh;
    let low = al * bl;
    (high << 28) + (mid >> 36) + (((mid & ((1u128 << 36) - 1)) + (low >> 64)) >> 36)
}

/// cos(x) in Q100 (error below 2^-92) for a finite x with |x| < 8.
fn cos_q100(x: Ext) -> Option<i128> {
    if x.sig == 0 {
        return Some(1i128 << 100);
    }
    let shift = x.exp + 100;
    if !(0..=56).contains(&shift) {
        return None;
    }
    let xq = (x.sig as u128) << shift;
    let x2 = mul_q100(xq, xq);
    let (mut sum, mut term) = (1i128 << 100, 1u128 << 100);
    for n in 1u128..200 {
        term = mul_q100(term, x2) / ((2 * n - 1) * (2 * n));
        if term == 0 {
            return Some(sum);
        }
        if n & 1 == 1 { sum -= term as i128 } else { sum += term as i128 }
    }
    None
}

/// cos(x) correctly rounded to the 64-bit significand (see the module
/// comment for how it stands for FCOS).
pub(crate) fn fcos(x: Ext) -> Result<Ext, u32> {
    if x.special != 0 {
        return Err(UNSUPPORTED_REVERB_COS);
    }
    let c = cos_q100(x).ok_or(UNSUPPORTED_REVERB_COS)?;
    let (mag, sign) = (c.unsigned_abs(), if c < 0 { 0x8000_0000 } else { 0 });
    // Correct rounding from an approximation within 2^-92: refuse when it lies
    // that close to a rounding midpoint of the 64-bit significand.
    let width = 128 - mag.leading_zeros();
    if width > 64 {
        let drop = width - 64;
        let rem = mag & ((1u128 << drop) - 1);
        let half = 1u128 << (drop - 1);
        if drop < 12 || rem.abs_diff(half) < 1 << 9 {
            return Err(UNSUPPORTED_REVERB_COS);
        }
    }
    Ok(Ext::normalized(mag, -100, sign))
}

/// x = f32(HFDamp) · f32 6.282 / (int)rate, as 0x10610a9c..0x10610ab6 form it.
pub(crate) fn cos_input(hf_damp: u32, rate: u32) -> Ext {
    Ext::load(hf_damp).mul(Ext::load(0x40c9_0625)).div(Ext::load_i32(rate as i32))
}

impl Library {
    // ---- glxSetSampleReverb and the SSE setup ----------------------------------------

    /// glxSetSampleReverb 0x106113d0(&block) with the block in `self.reverb.block`
    /// (`present` false: a NULL argument). A Volume (+0xc) of 0.0 (FCOMP C3:
    /// equal or unordered) frees the context and clears the hook.
    pub fn glx_set_sample_reverb(&mut self, present: bool) -> Result<u32, u32> {
        self.reverb.calls = self.reverb.calls.wrapping_add(1);
        let block = self.reverb.block;
        let volume = Ext::load(get32(&block, 0xc));
        if !present || volume.compare(Ext::load_f64(0.0)).1 {
            self.reverb.hook = false;
            self.reverb.ctx = Vec::new();
            return Ok(0);
        }
        // 0x106113ff..0x10611417: Data (+0x64) = the old context, then the copy.
        let mut global = block;
        put32(&mut global, 0x64, if self.reverb.ctx.is_empty() { 0 } else { 1 });
        self.reverb.global = global;
        let [mmx, sse, _] = self.player.cpu;
        if mmx == 0 || sse == 0 {
            // The 3DNow / MMX engines (0x106220e7, 0x1062135b) or none: not the reference path.
            return Err(UNSUPPORTED_KERNEL);
        }
        self.reverb.hook = true;
        let fresh = self.reverb.ctx.is_empty();
        if fresh {
            self.reverb.ctx = vec![0; REVERB_CTX]; // malloc (realloc keeps the old bytes)
        }
        let mut ctx = std::mem::take(&mut self.reverb.ctx);
        let result = reverb_setup(&mut ctx, &self.reverb.global, self.player.rate);
        self.reverb.ctx = ctx;
        match result {
            Ok(0x11) if fresh => Err(UNSUPPORTED_REVERB_UNINIT),
            Ok(_) => Ok(0),
            Err(e) => Err(e),
        }
    }

    // ---- the SSE kernel (the effects hook) ----------------------------------------

    /// The effects reverb hook [0x10688288](ctx [0x10688284], d04, d0c, k, 0):
    /// the SSE kernel 0x10622d33 over the first `k` frames of the buses.
    pub(crate) fn reverb_hook(&mut self, k: i32) -> Result<(), u32> {
        if !self.reverb.hook || self.reverb.ctx.is_empty() {
            return Ok(());
        }
        let buses = &mut self.player.mixer.buses;
        let (dry, send) = (BUS_FLOATS, 3 * BUS_FLOATS); // d04, d0c
        if k as usize > BUS_FLOATS / 2 {
            return Err(UNSUPPORTED_BUS_WRITE);
        }
        let mutant = self.mutant;
        reverb_kernel_mutant(&mut self.reverb.ctx, buses, dry, send, k as u32, mutant);
        Ok(())
    }
}

/// The SSE setup 0x106109f0(ctx, reverb) up to the output-type test, for an
/// output type of 0 (returns 0, or 0x11 for a block it refuses).
pub(crate) fn reverb_setup(ctx: &mut [u8], r: &[u8; REVERB_BLOCK], rate: u32) -> Result<u32, u32> {
    let one_f = Ext::load(0x3f80_0000);
    let one_d = Ext::load_f64(1.0);
    let volume = Ext::load(get32(r, 0xc));
    // Volume below -1.0f (C0, also unordered) or not at most 1.0f (neither C0 nor C3).
    let (below, _) = volume.compare(Ext::load(0xbf80_0000));
    if below {
        return Ok(0x11);
    }
    let (below, equal) = volume.compare(one_f);
    if !below && !equal {
        return Ok(0x11);
    }
    // FILD qword rate; FCOMP m32 HFDamp: C0 (rate below HFDamp, or unordered) refuses.
    let (below, _) = Ext::load_i32(rate as i32).compare(Ext::load(get32(r, 0x10)));
    if below {
        return Ok(0x11);
    }
    ctx[..REVERB_CTX].fill(0);
    put32(ctx, 0xc4, 0x3f80_0000);
    put32(ctx, 0xc0, 0x3f80_0000);
    let vol = volume.store();
    put32(ctx, 0xbc, vol);
    put32(ctx, 0xb8, vol);
    // The low-pass coefficient (0x10610a9c..0x10610ad9).
    let c = fcos(cos_input(get32(r, 0x10), rate))?;
    let a = one_d.add(c.neg());
    let t = a.add(Ext::load(0x4000_0000)).mul(a);
    let k = t.sqrt().add(a.neg()).store();
    let one_minus_k = one_f.add(Ext::load(k).neg()).store();
    let rate_x = Ext::load_i32(rate as i32);
    for i in 0..6 {
        let mut time = get32(r, 0x34 + 8 * i);
        let gain = get32(r, 0x38 + 8 * i);
        let mut g = one_f.add(Ext::load(gain).neg());
        if Ext::load(time).compare(Ext::load_f64(0.0)).1 {
            time = 0x3a83_126f; // 0.001f
        }
        if g.compare(one_d).1 {
            g = Ext::load(0x3f7f_be77); // 0.999f
        }
        let samples = rate_x.mul(Ext::load(time)).ftol();
        put32(ctx, 0x08 + 4 * i, samples.wrapping_neg() as u32);
        put32(ctx, 0x20 + 4 * i, g.neg().store());
        put32(ctx, 0x38 + 4 * i, g.store());
        put32(ctx, 0x50 + 4 * i, one_f.add(g.mul(g).neg()).store());
        put32(ctx, 0x68 + 4 * i, k);
        put32(ctx, 0x80 + 4 * i, one_minus_k);
    }
    Ok(0)
}

/// The SSE kernel 0x10622d33(ctx, dry, send, count, 0) on `buses` (floats)
/// with the dry and send buses at float offsets `dry` and `send`.
pub(crate) fn reverb_kernel(ctx: &mut [u8], buses: &mut [f32], dry: usize, send: usize, count: u32) {
    reverb_kernel_mutant(ctx, buses, dry, send, count, 0)
}

fn reverb_kernel_mutant(ctx: &mut [u8], buses: &mut [f32], dry: usize, send: usize, count: u32, mutant: u32) {
    let pair = |o: usize| [f32_at(ctx, o), f32_at(ctx, o + 4)];
    let mut pos = get32(ctx, 4);
    let mut x0 = pair(0xb0);
    let mut state = [pair(0x98), pair(0xa0), pair(0xa8)];
    let half = [0.5f32, 0.5f32]; // [0x1064d300]
    let gain = pair(0xb8);
    let coef: [[[f32; 2]; 5]; 3] = [0, 1, 2].map(|l| [pair(0x20 + 8 * l), pair(0x80 + 8 * l), pair(0x68 + 8 * l),
        pair(0x38 + 8 * l), pair(0x50 + 8 * l)]);
    let taps: [[u32; 2]; 3] = [0, 1, 2].map(|l| [get32(ctx, 0x08 + 8 * l), get32(ctx, 0x0c + 8 * l)]);
    for f in 0..count as usize {
        if mutant != MUTANT_REVERB_NO_CROSSFEED {
            x0 = [x0[1], x0[0]]; // shufps xmm0, xmm0, 1
        }
        let s = [buses[send + 2 * f], buses[send + 2 * f + 1]];
        x0 = [(x0[0] + s[0]) * half[0], (x0[1] + s[1]) * half[1]];
        for l in 0..3 {
            let [a, mut b, mut c, d, e] = coef[l];
            if mutant == MUTANT_REVERB_LOWPASS_SWAP {
                std::mem::swap(&mut b, &mut c);
            }
            let x1 = x0;
            x0 = [x0[0] * a[0], x0[1] * a[1]];
            let lp = [state[l][0] * b[0], state[l][1] * b[1]];
            let at_l = LINES[l] + 8 * (taps[l][0].wrapping_add(pos) & LINE_MASK) as usize;
            let at_r = LINES[l] + 8 * (taps[l][1].wrapping_add(pos) & LINE_MASK) as usize + 4;
            let line = [f32_at(ctx, at_l), f32_at(ctx, at_r)];
            let x3 = [line[0] * c[0] + lp[0], line[1] * c[1] + lp[1]];
            state[l] = x3;
            let w = [x1[0] + x3[0] * d[0], x1[1] + x3[1] * d[1]];
            let at = LINES[l] + 8 * pos as usize;
            put_f32(ctx, at, w[0]);
            put_f32(ctx, at + 4, w[1]);
            x0 = [x0[0] + line[0] * e[0], x0[1] + line[1] * e[1]];
        }
        buses[dry + 2 * f] += x0[0] * gain[0];
        buses[dry + 2 * f + 1] += x0[1] * gain[1];
        pos = pos.wrapping_add(1) & LINE_MASK;
    }
    put32(ctx, 4, pos);
    for (o, v) in [(0xb0, x0), (0x98, state[0]), (0xa0, state[1]), (0xa8, state[2])] {
        put_f32(ctx, o, v[0]);
        put_f32(ctx, o + 4, v[1]);
    }
}

// ---- Wasm exports -------------------------------------------------------------

fn with_library<R>(f: impl FnOnce(&mut Library) -> R) -> R {
    LIBRARY.with(|l| f(&mut l.borrow_mut()))
}

/// The 0x6c-byte glxReverb argument of galaxy_set_sample_reverb.
#[no_mangle]
pub extern "C" fn galaxy_reverb_block() -> *mut u8 {
    with_library(|l| l.reverb.block.as_mut_ptr())
}

/// glxSetSampleReverb(&block); a fault sets galaxy_fault and returns 0x11.
#[no_mangle]
pub extern "C" fn galaxy_set_sample_reverb() -> u32 {
    with_library(|l| match l.glx_set_sample_reverb(true) {
        Ok(v) => v,
        Err(e) => {
            l.player.fault = e;
            0x11
        }
    })
}

/// Whether the hook is set (bit 0), a context exists (bit 1), the setter calls (bits 8..).
#[no_mangle]
pub extern "C" fn galaxy_reverb_state() -> u32 {
    with_library(|l| l.reverb.hook as u32 | (!l.reverb.ctx.is_empty() as u32) << 1 | l.reverb.calls << 8)
}

// Validator-only exports.

/// The context (REVERB_CTX bytes), created zeroed when absent.
#[no_mangle]
pub extern "C" fn galaxy_reverb_ctx() -> *mut u8 {
    with_library(|l| {
        if l.reverb.ctx.is_empty() {
            l.reverb.ctx = vec![0; REVERB_CTX];
        }
        l.reverb.ctx.as_mut_ptr()
    })
}

/// The setup alone on the context with the block; its result, or a fault | 0x10000.
#[no_mangle]
pub extern "C" fn galaxy_reverb_setup() -> u32 {
    with_library(|l| {
        if l.reverb.ctx.is_empty() {
            l.reverb.ctx = vec![0; REVERB_CTX];
        }
        let block = l.reverb.block;
        let rate = l.player.rate;
        match reverb_setup(&mut l.reverb.ctx, &block, rate) {
            Ok(v) => v,
            Err(e) => 0x10000 | e,
        }
    })
}

/// The kernel on the context over `count` frames of d04 (dry) and d0c (send).
#[no_mangle]
pub extern "C" fn galaxy_reverb_kernel(count: u32) {
    with_library(|l| {
        if l.reverb.ctx.is_empty() {
            l.reverb.ctx = vec![0; REVERB_CTX];
        }
        let n = count.min((BUS_FLOATS / 2) as u32);
        reverb_kernel(&mut l.reverb.ctx, &mut l.player.mixer.buses, BUS_FLOATS, 3 * BUS_FLOATS, n);
    })
}

/// The model's FCOS input and result for HFDamp `hf_damp` (f32 bits) at the
/// library's rate: x (10 bytes), cos (10 bytes, 0 on a fault), the fault.
#[no_mangle]
pub extern "C" fn galaxy_reverb_cos(hf_damp: u32) -> *const u8 {
    thread_local! { static OUT: RefCell<[u8; 24]> = const { RefCell::new([0; 24]) }; }
    let rate = with_library(|l| l.player.rate);
    let x = cos_input(hf_damp, rate);
    let (c, fault) = match fcos(x) {
        Ok(c) => (c, 0),
        Err(e) => (Ext::zero(0), e),
    };
    OUT.with(|o| {
        let mut o = o.borrow_mut();
        let ext = |v: Ext| {
            let mut b = [0u8; 10];
            b[..8].copy_from_slice(&v.sig.to_le_bytes());
            let e: u16 = if v.sig == 0 { 0 } else { (v.exp + 63 + 16383) as u16 };
            b[8..].copy_from_slice(&(e | if v.sign != 0 { 0x8000 } else { 0 }).to_le_bytes());
            b
        };
        o[..10].copy_from_slice(&ext(x));
        o[10..20].copy_from_slice(&ext(c));
        o[20..24].copy_from_slice(&fault.to_le_bytes());
        o.as_ptr()
    })
}
