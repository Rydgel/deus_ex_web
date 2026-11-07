//! Moving-light composition and the light atlas conversion in the Rust core
//! (docs/firefox-60fps-plan.md "Moving lights (2026-11-07)"): the per-texel
//! work of src/viewer/moving-lights.mjs `addDirect` (the saturating add of one
//! class 2 light's colour onto a light map's float texels, Render.dll
//! SetupForSurf's merge 0x10b03040 as docs/dynamic-lighting.md recovered it) and
//! of src/viewer/light-atlas.mjs `update` (the float to byte conversion with the
//! one-texel padding). Both JavaScript bodies stay as the references
//! (`?movingCompose=js`); `?movingCompose=verify` runs both and compares every
//! float and byte.
//!
//! Arithmetic, step for step as the references have it:
//! * A texel channel is a float32. The reference reads it as a double, adds the
//!   colour's amount (a double: the colour table entry over 255) and stores
//!   `Math.min(127 / 255, sum)` back through the float32 array, which rounds the
//!   double to nearest even. Here: `((p as f64) + amount).min(MAX) as f32`.
//! * The amount of spatial byte `b` for a channel with colour step `s` is
//!   `Math.min(127, (b * s) >> 16) / 255`: the product is an exact double, `>>`
//!   takes it as an int32 (wrapping) and shifts arithmetically.
//! * A modulated light (TorchWaver, FireWaver, WateryShimmer) maps each nonzero
//!   spatial byte through the frame's table at `(index & 255) << 8 | byte`,
//!   `index` counting every texel of the contribution's rectangle from 0. The
//!   entries are filled when first asked, with light.rs `modulation_entry`
//!   (the createLightFrame table's entry).
//! * The atlas byte of a float32 sample `s` is
//!   `Math.round(Math.max(0, Math.min(1, s)) * 255)`. For a double in [0, 255]
//!   with at most 32 significant bits (a float32 times 255) the sum with 0.5 is
//!   exact, so `floor(v + 0.5)` is `Math.round(v)`; NaN stores 0, as a
//!   Uint8Array does. `moving_convert` exposes the conversion so the host can
//!   compare it with the reference over all 2^32 float32 bit patterns.
//!
//! JavaScript lays out the jobs and the blocks they point to (all addresses are
//! in this instance's memory, in blocks from the script-VM kernel's allocator;
//! src/runtime/moving-compose-kernel.mjs). No statics: the module's reserved
//! region is nearly full (build.rs).

use crate::light::modulation_entry;

const JOB_WORDS: usize = 16;
const J_WIDTH: usize = 0;
const J_HEIGHT: usize = 1;
/// Address of the float32 band: light map rows `J_V0..J_V1`, `J_WIDTH` texels of
/// three channels each. It holds the static texels on entry and the composed
/// ones on return.
const J_BAND: usize = 2;
const J_V0: usize = 3;
const J_V1: usize = 4;
const J_CONTRIBS: usize = 5;
const J_COUNT: usize = 6;
/// The atlas rectangle in light map texels, as light-atlas.mjs `update` takes
/// it (int32: -1 and `width`/`height` are the padding).
const J_LEFT: usize = 7;
const J_RIGHT: usize = 8;
const J_TOP: usize = 9;
const J_BOTTOM: usize = 10;
/// Address of the packed RGBA output (0: none).
const J_PACKED: usize = 11;
/// Out: the texels written (the sum over the contributions of the texels whose
/// byte, after modulation, was not 0).
const J_WRITTEN: usize = 12;

const CONTRIB_WORDS: usize = 8;
const C_MIN_U: usize = 0;
const C_MAX_U: usize = 1;
const C_MIN_V: usize = 2;
const C_MAX_V: usize = 3;
const C_SPATIAL: usize = 4;
/// Index of the light's colour in the frame's amounts.
const C_COLOUR: usize = 5;
/// 0: unmodulated; 1..=3: the effect whose table the byte goes through.
const C_EFFECT: usize = 6;

/// A modulation table block: the effect's 256 factors (doubles), then the
/// bytes that say which entries are filled, then the entries.
pub const MOD_FACTORS: usize = 0;
pub const MOD_VALID: usize = 2048;
pub const MOD_VALUE: usize = 2048 + 65536;
pub const MOD_BYTES: usize = 2048 + 2 * 65536;

const MAX: f64 = 127.0 / 255.0;

/// The amounts of `count` colours: for colour `i` (steps `red, green, blue` as
/// int32 words) channel `c` and spatial byte `b`, `amounts[i * 768 + c * 256 + b]`
/// is `Math.min(127, (b * step) >> 16) / 255`.
#[no_mangle]
pub extern "C" fn moving_colours(out: u32, steps: u32, count: u32) {
    let count = count as usize;
    let steps = unsafe { core::slice::from_raw_parts(steps as usize as *const i32, count * 3) };
    let out = unsafe { core::slice::from_raw_parts_mut(out as usize as *mut f64, count * 768) };
    for (table, &step) in out.chunks_exact_mut(256).zip(steps.iter()) {
        for (byte, amount) in table.iter_mut().enumerate() {
            let entry = ((byte as i64 * step as i64) as i32) >> 16;
            *amount = (if entry < 127 { entry } else { 127 }) as f64 / 255.0;
        }
    }
}

/// One float32 texel channel as the atlas stores it.
#[inline(always)]
fn convert(sample: f32) -> u32 {
    let v = if sample > 1.0 { 1.0 } else if sample > 0.0 { sample as f64 } else { 0.0 };
    (v * 255.0 + 0.5) as u32
}

/// One texel's three channels as an RGBA word.
#[inline(always)]
fn texel(source: &[f32], c: usize) -> u32 {
    convert(source[c * 3]) | convert(source[c * 3 + 1]) << 8 | convert(source[c * 3 + 2]) << 16 | 0xff00_0000
}

/// `n` texels of float channels into RGBA words: four texels at a time on wasm simd128, with the same operations as `convert` (the
/// clamp by comparison, the product and the sum in doubles, truncation of a positive double).
fn convert_row(source: &[f32], dst: &mut [u32]) {
    #[cfg(target_arch = "wasm32")]
    let done = unsafe { convert_blocks(source, dst) };
    #[cfg(not(target_arch = "wasm32"))]
    let done = 0;
    for i in done..dst.len() {
        dst[i] = texel(source, i);
    }
}

/// The texels `convert_row` does four at a time; returns how many.
#[cfg(target_arch = "wasm32")]
#[target_feature(enable = "simd128")]
unsafe fn convert_blocks(source: &[f32], dst: &mut [u32]) -> usize {
    use core::arch::wasm32::*;
    let (one, zero) = (f32x4_splat(1.0), f32x4_splat(0.0));
    let (scale, half) = (f64x2_splat(255.0), f64x2_splat(0.5));
    let alpha = u8x16_splat(255);
    // Four channels, each `if x > 1 {1} else if x > 0 {x} else {0}` (NaN gives 0), as `floor(255 * v + 0.5)` in four integer lanes.
    #[inline(always)]
    unsafe fn four(x: v128, one: v128, zero: v128, scale: v128, half: v128) -> v128 {
        use core::arch::wasm32::*;
        let v = v128_and(v128_bitselect(one, x, f32x4_gt(x, one)), f32x4_gt(x, zero));
        let low = i32x4_trunc_sat_f64x2_zero(f64x2_add(f64x2_mul(f64x2_promote_low_f32x4(v), scale), half));
        let high = i32x4_trunc_sat_f64x2_zero(f64x2_add(f64x2_mul(f64x2_promote_low_f32x4(i32x4_shuffle::<2, 3, 0, 1>(v, v)), scale), half));
        i32x4_shuffle::<0, 1, 4, 5>(low, high)
    }
    let blocks = dst.len() / 4;
    for b in 0..blocks {
        let s = source.as_ptr().add(b * 12) as *const v128;
        let a = four(v128_load(s), one, zero, scale, half);
        let c = four(v128_load(s.add(1)), one, zero, scale, half);
        let d = four(v128_load(s.add(2)), one, zero, scale, half);
        let bytes = u8x16_narrow_i16x8(i16x8_narrow_i32x4(a, c), i16x8_narrow_i32x4(d, d));
        let rgba = i8x16_shuffle::<0, 1, 2, 16, 3, 4, 5, 16, 6, 7, 8, 16, 9, 10, 11, 16>(bytes, alpha);
        v128_store(dst.as_mut_ptr().add(b * 4) as *mut v128, rgba);
    }
    blocks * 4
}

/// Validation: the conversion of `count` float32 bit patterns from `input`
/// into bytes at `out`.
#[no_mangle]
pub extern "C" fn moving_convert(input: u32, count: u32, out: u32) {
    let input = unsafe { core::slice::from_raw_parts(input as usize as *const u32, count as usize) };
    let out = unsafe { core::slice::from_raw_parts_mut(out as usize as *mut u8, count as usize) };
    for (byte, &bits) in out.iter_mut().zip(input.iter()) {
        *byte = convert(f32::from_bits(bits)) as u8;
    }
}

/// One contribution onto the band; returns the texels written.
#[inline(always)]
unsafe fn merge(band: &mut [f32], width: usize, v0: usize, c: &[u32], amounts: &[f64], mods: u32) -> u32 {
    let (min_u, max_u, min_v, max_v) = (c[C_MIN_U] as usize, c[C_MAX_U] as usize, c[C_MIN_V] as usize, c[C_MAX_V] as usize);
    let rw = max_u - min_u;
    let spatial = core::slice::from_raw_parts(c[C_SPATIAL] as usize as *const u8, rw * (max_v - min_v));
    let colour = &amounts[c[C_COLOUR] as usize * 768..][..768];
    let (red, green, blue) = (&colour[0..256], &colour[256..512], &colour[512..768]);
    let effect = c[C_EFFECT] as usize;
    let table = if effect == 0 { 0 } else { mods as usize + (effect - 1) * MOD_BYTES };
    let mut written = 0u32;
    let mut index = 0usize;
    for v in min_v..max_v {
        let source = &spatial[(v - min_v) * rw..][..rw];
        let row = &mut band[((v - v0) * width + min_u) * 3..][..rw * 3];
        for (texel, &s) in row.chunks_exact_mut(3).zip(source.iter()) {
            let mut byte = s as usize;
            if table != 0 && byte != 0 {
                let at = (index & 255) << 8 | byte;
                let valid = (table + MOD_VALID + at) as *mut u8;
                let value = (table + MOD_VALUE + at) as *mut u8;
                if *valid == 0 {
                    let factor = *((table + MOD_FACTORS + (index & 255) * 8) as *const f64);
                    *value = modulation_entry(factor, byte);
                    *valid = 1;
                }
                byte = *value as usize;
            }
            index += 1;
            if byte == 0 {
                continue;
            }
            written += 1;
            texel[0] = ((texel[0] as f64) + red[byte]).min(MAX) as f32;
            texel[1] = ((texel[1] as f64) + green[byte]).min(MAX) as f32;
            texel[2] = ((texel[2] as f64) + blue[byte]).min(MAX) as f32;
        }
    }
    written
}

/// Compose `count` jobs (JOB_WORDS words each at `jobs`): every contribution in
/// order onto the job's band, then the atlas rectangle's bytes into the packed
/// output.
#[no_mangle]
pub extern "C" fn moving_compose(jobs: u32, count: u32, amounts: u32, mods: u32, colours: u32) {
    let amounts = unsafe { core::slice::from_raw_parts(amounts as usize as *const f64, colours as usize * 768) };
    for j in 0..count as usize {
        unsafe {
            let job = core::slice::from_raw_parts_mut((jobs as usize + j * JOB_WORDS * 4) as *mut u32, JOB_WORDS);
            let (width, height) = (job[J_WIDTH] as usize, job[J_HEIGHT] as usize);
            let (v0, v1) = (job[J_V0] as usize, job[J_V1] as usize);
            let band = core::slice::from_raw_parts_mut(job[J_BAND] as usize as *mut f32, (v1 - v0) * width * 3);
            let contributions = core::slice::from_raw_parts(job[J_CONTRIBS] as usize as *const u32, job[J_COUNT] as usize * CONTRIB_WORDS);
            let mut written = 0u32;
            for c in contributions.chunks_exact(CONTRIB_WORDS) {
                written += merge(band, width, v0, c, amounts, mods);
            }
            job[J_WRITTEN] = written;
            if job[J_PACKED] != 0 {
                let (left, right, top, bottom) = (job[J_LEFT] as i32, job[J_RIGHT] as i32, job[J_TOP] as i32, job[J_BOTTOM] as i32);
                let pw = (right - left + 1) as usize;
                let out = core::slice::from_raw_parts_mut(job[J_PACKED] as usize as *mut u32, pw * (bottom - top + 1) as usize);
                let w = width as i32;
                // The columns of the light map the rectangle reads (the interior); the padding column on either side repeats the edge.
                let (lo, hi) = (if left < 0 { 0 } else { left }, if right >= w { w - 1 } else { right });
                for (r, row) in (top..=bottom).enumerate() {
                    let source_row = if row < 0 { 0 } else if row >= height as i32 { height - 1 } else { row as usize };
                    let source = &band[(source_row - v0) * width * 3..][..width * 3];
                    let dst = &mut out[r * pw..][..pw];
                    let mut at = 0;
                    if left < 0 {
                        dst[0] = texel(source, 0);
                        at = 1;
                    }
                    let n = (hi - lo + 1) as usize;
                    convert_row(&source[lo as usize * 3..][..n * 3], &mut dst[at..][..n]);
                    if right >= w {
                        dst[pw - 1] = texel(source, width - 1);
                    }
                }
            }
        }
    }
}
