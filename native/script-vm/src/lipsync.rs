//! Galaxy.dll's lip-sync analysis (UGalaxyAudioSubsystem::Update's block at
//! 0x1060a0da..0x1060a268, docs/lip-sync.md): a 1024-sample window of the
//! speech being mixed, Galaxy's radix-2 FFT, |real| per bin and the
//! classifier that picks APawn.nextPhoneme. Every x87 step is transcribed on
//! the 80-bit model (x87.rs, control word 0x037f); the FFT's fsin/fcos are
//! the hardware results measured by tools/galaxy-fft-twiddle-probe.c.
//! Compared with the original in Unicorn by scripts/validate-galaxy-lipsync.mjs.
//!
//! Only the streamed 16-bit path is translated: speech is MP3 (record format
//! 0x4024), so the window comes from the voice's decode ring at the mixer
//! position. The host writes the 1024 samples there (little-endian int16,
//! zero past the ring end; `available` counts the samples before it).

use crate::x87::Ext;

const N: usize = 1024;
static mut INPUT: [u8; N * 2] = [0; N * 2];
static mut WINDOW: [u32; N] = [0; N];
static mut REAL: [u32; N] = [0; N];
static mut IMAG: [u32; N] = [0; N];

/// Per stage m = 2..1024: float32 sin(-2d), float32 sin(-d), and the 80-bit
/// cos(-2d), cos(-d) (significand, sign/exponent), d = float(2pi_f / m).
/// Measured on a real x87 (CrossOver/Rosetta, control word 0x037f) by
/// tools/galaxy-fft-twiddle-probe.c.
const TWIDDLES: [(u32, u32, (u64, u16), (u64, u16)); 10] = [
    (0xb43bbd2e, 0x33bbbd2e, (0xfffffffffffbb291, 0x3ffe), (0xfffffffffffeeca4, 0xbffe)),
    (0x33bbbd2e, 0xbf800000, (0xfffffffffffeeca4, 0xbffe), (0xbbbd2e7b967fef2c, 0xbfe6)),
    (0xbf800000, 0xbf3504f3, (0xbbbd2e7b967fef2c, 0xbfe6), (0xb504f2f199acc1f3, 0x3ffe)),
    (0xbf3504f3, 0xbec3ef16, (0xb504f2f199acc1f3, 0x3ffe), (0xec835e679e5c3ac4, 0x3ffe)),
    (0xbec3ef16, 0xbe47c5c2, (0xec835e679e5c3ac4, 0x3ffe), (0xfb14be7b26dcd10f, 0x3ffe)),
    (0xbe47c5c2, 0xbdc8bd36, (0xfb14be7b26dcd10f, 0x3ffe), (0xfec46d1d62bc0fad, 0x3ffe)),
    (0xbdc8bd36, 0xbd48fb30, (0xfec46d1d62bc0fad, 0x3ffe), (0xffb10f1b81b9ee38, 0x3ffe)),
    (0xbd48fb30, 0xbcc90ab0, (0xffb10f1b81b9ee38, 0x3ffe), (0xffec430413fa79dd, 0x3ffe)),
    (0xbcc90ab0, 0xbc490e90, (0xffec430413fa79dd, 0x3ffe), (0xfffb10b4d7fb4900, 0x3ffe)),
    (0xbc490e90, 0xbbc90f88, (0xfffb10b4d7fb4900, 0x3ffe), (0xfffec42c732dac90, 0x3ffe)),
];

const F_1024: u32 = 0x4480_0000; // 1024.0f (0x1063d60c)
const F_INV_1024: u32 = 0x3a80_0000; // 0.0009765625f (0x1063d608)
const F_32767: u32 = 0x46ff_fe00; // 32767.0f (0x1063d61c)
const F_65536: u32 = 0x4780_0000; // 65536.0f (0x1063d618)
const F_INV_32768: u32 = 0x3800_0000; // 3.0517578125e-5f (0x1063d614)
const F_ZERO: u32 = 0; // 0.0f (0x1063d528)
const F_ONE: u32 = 0x3f80_0000; // 1.0f (0x1063c108)
const F_PEAK_INIT: u32 = 0xc7c3_4f80; // -99999.0f (0x1063d684)
const F_300: u32 = 0x4396_0000; // 300.0f (0x10649040)
const F_PEAK_MIN: u32 = 0x40a0_0000; // 5.0f (0x1063d674)
// Frequency thresholds (0x1063d670..0x1063d65c) and their letters' table
// indices into "AEFMOTUX" (0x10649084).
const BANDS: [(u32, usize); 5] = [(0x44fa_0000, 5), (0x44bb_8000, 2), (0x4416_0000, 0), (0x43c8_0000, 4), (0x437a_0000, 6)];
const F_1000: u32 = 0x447a_0000;
const LETTERS: [u16; 8] = [b'A' as u16, b'E' as u16, b'F' as u16, b'M' as u16, b'O' as u16, b'T' as u16, b'U' as u16, b'X' as u16];

fn ext80((sig, se): (u64, u16)) -> Ext {
    if sig == 0 {
        return Ext::zero(((se >> 15) as u32) << 31);
    }
    Ext { sig, exp: (se & 0x7fff) as i32 - 16383 - 63, sign: ((se >> 15) as u32) << 31, special: 0 }
}
fn abs(v: Ext) -> Ext {
    let mut v = v;
    v.sign = 0;
    if v.special != 0 {
        v.special &= 0x7fff_ffff;
    }
    v
}
/// FCOMP/FCOM + `test ah, 0x41` + jne: below, equal or unordered.
fn not_above(a: Ext, b: Ext) -> bool {
    let (c0, c3) = a.compare(b);
    c0 || c3
}

/// 0x10609180 for 16-bit samples: w[i] = s * (1 - |i - 1024| / 1024) / 32768,
/// the stored 32-bit sample first lowered by 65536 above 32767.
fn fill_window(input: &[u8; N * 2], available: usize, window: &mut [u32; N]) {
    for i in 0..N {
        let stored = if i < available {
            let v = (input[2 * i + 1] as i32) << 8 | input[2 * i] as i32;
            Ext::load_i32(v).store()
        } else {
            0
        };
        let stored = if not_above(Ext::load(stored), Ext::load(F_32767)) {
            stored
        } else {
            Ext::load(stored).add(Ext::load(F_65536).neg()).store()
        };
        // fild qword i; fsub 1024f; fmul 1/1024f; fabs; fsubr 1.0 (double)
        let ramp = abs(Ext::load_i32(i as i32).add(Ext::load(F_1024).neg()).mul(Ext::load(F_INV_1024)));
        let factor = Ext::load_f64(1.0).add(ramp.neg());
        window[i] = Ext::load(stored).mul(Ext::load(F_INV_32768)).mul(factor).store();
    }
}

/// 0x10609310: bit-reversed copy (imaginary zeroed), then per stage the
/// twiddle recurrence w = 2 cos(-d), ar0 = w*ar1 - ar2 (stored float and
/// carried as the next ar1), ai0 = w*ai1 - ai2 (stored float as the next ai1,
/// used unrounded in the products).
fn fft(window: &[u32; N], real: &mut [u32; N], imag: &mut [u32; N]) {
    for (i, value) in window.iter().enumerate() {
        let mut r = 0usize;
        let mut c = i;
        for _ in 0..10 {
            r = (r << 1) | (c & 1);
            c >>= 1;
        }
        real[r] = *value;
        imag[r] = 0;
    }
    let mut half = 1usize;
    let mut m = 2usize;
    let mut stage = 0usize;
    while m <= N {
        let (sm2, sm1, cm2, cm1) = TWIDDLES[stage];
        let (cm2, cm1) = (ext80(cm2), ext80(cm1));
        let w = cm1.add(cm1);
        let mut block = 0usize;
        while block < N {
            let mut ar2 = cm2.store();
            let mut ar1 = cm1;
            let mut ai2 = sm2;
            let mut ai1 = sm1;
            for t in 0..half {
                let k = block + t;
                let j = k + half;
                let ar0 = w.mul(ar1).add(Ext::load(ar2).neg()).store();
                ar2 = ar1.store();
                let ai0 = w.mul(Ext::load(ai1)).add(Ext::load(ai2).neg());
                ai2 = ai1;
                ai1 = ai0.store();
                let (rj, ij) = (Ext::load(real[j]), Ext::load(imag[j]));
                let tr = Ext::load(ar0).mul(rj).add(ai0.mul(ij).neg()).store();
                let ti = ai0.mul(rj).add(Ext::load(ar0).mul(ij));
                let (rk, ik) = (Ext::load(real[k]), Ext::load(imag[k]));
                real[j] = rk.add(Ext::load(tr).neg()).store();
                imag[j] = ik.add(ti.neg()).store();
                real[k] = Ext::load(tr).add(rk).store();
                imag[k] = ti.add(ik).store();
                ar1 = Ext::load(ar0);
            }
            block += m;
        }
        half = m;
        m <<= 1;
        stage += 1;
    }
}

/// 0x10608d70: "X" unless the mean of bins 0..n plus one exceeds 0.2 and
/// the first maximum among bins 0..511 exceeds 5.0; then the band of
/// ftol(index) * rate / 1024.
/// 0 when n (300 Hz in bins) leaves the 1024 bins: the original then reads
/// past the array, which only a rate below 300 reaches.
fn classify(real: &[u32; N], rate: i32) -> u16 {
    let rate_f = Ext::load_i32(rate).store();
    let n = Ext::load(F_300).mul(Ext::load(F_1024)).div(Ext::load(rate_f)).ftol();
    if n < 0 || n as usize >= N {
        return 0;
    }
    let mut sum = Ext::load(F_ZERO);
    for bin in real.iter().take(n as usize + 1) {
        sum = sum.add(Ext::load(*bin));
    }
    let mean = sum.div(Ext::load_i32(n)).add(Ext::load(F_ONE));
    if not_above(mean, Ext::load_f64(0.2)) {
        return LETTERS[7];
    }
    let mut peak = Ext::load(F_PEAK_INIT);
    let mut index = 0u32;
    for (k, bin) in real.iter().take(N / 2).enumerate() {
        let (below, _) = peak.compare(Ext::load(*bin));
        if below {
            peak = Ext::load(*bin);
            index = Ext::load_i32(k as i32).store();
        }
    }
    if not_above(peak, Ext::load(F_PEAK_MIN)) {
        return LETTERS[7];
    }
    // FST keeps the product on the stack: the first band compares it
    // unrounded, the others reload the stored float.
    let product = Ext::load_i32(Ext::load(index).ftol()).mul(Ext::load(rate_f)).mul(Ext::load(F_INV_1024));
    let frequency = product.store();
    for (band, (threshold, letter)) in BANDS.iter().enumerate() {
        let value = if band == 0 { product } else { Ext::load(frequency) };
        if !not_above(value, Ext::load(*threshold)) {
            return LETTERS[*letter];
        }
    }
    LETTERS[if not_above(Ext::load(frequency), Ext::load(F_1000)) { 1 } else { 3 }]
}

#[no_mangle]
pub extern "C" fn lipsync_input_ptr() -> *mut u8 {
    core::ptr::addr_of_mut!(INPUT) as *mut u8
}
#[no_mangle]
pub extern "C" fn lipsync_window_ptr() -> *const u32 {
    core::ptr::addr_of!(WINDOW) as *const u32
}
#[no_mangle]
pub extern "C" fn lipsync_real_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(REAL) as *mut u32
}
/// The classifier alone over the bins at REAL (validation of its edges).
#[no_mangle]
pub extern "C" fn lipsync_classify(rate: i32) -> u32 {
    unsafe { classify(&*core::ptr::addr_of!(REAL), rate) as u32 }
}
#[no_mangle]
pub extern "C" fn lipsync_imag_ptr() -> *const u32 {
    core::ptr::addr_of!(IMAG) as *const u32
}

/// The phoneme letter (UTF-16 code unit) for the samples at INPUT.
#[no_mangle]
pub extern "C" fn lipsync_analyze(available: u32, rate: i32) -> u32 {
    unsafe {
        let input = &*core::ptr::addr_of!(INPUT);
        let window = &mut *core::ptr::addr_of_mut!(WINDOW);
        let real = &mut *core::ptr::addr_of_mut!(REAL);
        let imag = &mut *core::ptr::addr_of_mut!(IMAG);
        fill_window(input, (available as usize).min(N), window);
        fft(window, real, imag);
        // 0x1060a1be: fld; fabs; fstp over all 1024 bins.
        for bin in real.iter_mut() {
            *bin = abs(Ext::load(*bin)).store();
        }
        classify(real, rate) as u32
    }
}
