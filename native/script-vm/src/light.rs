//! The per-frame class 1 light-map merge (docs/static-lighting.md "Rust
//! kernel"): the byte work of src/runtime/static-lighting.mjs
//! `animateLightMap`, which is the reference (its inputs and modulation are
//! oracle-checked by validate-light-animation). The GlobalLighting constants,
//! the memo and the choice of light maps stay in JavaScript;
//! src/runtime/light-animation-kernel.mjs copies a light map's static bytes,
//! texels and cached spatial bytes into a block of this instance's memory, and
//! validate-light-animation-rust compares the two every frame.
//!
//! A light map is a header of u32 words (laid out by
//! light-animation-kernel.mjs, whose admission guarantees every rectangle
//! lies inside the map and every buffer has the length indexed here):
//! width, the union rectangle (minU, maxU, minV, maxV), the light count, the
//! static bytes and texels addresses, then per light its rectangle, spatial
//! bytes, colour tables (red, green, blue: 3·256 bytes) and modulation table
//! (64 K bytes, or 0 for an unmodulated light) and the address of its
//! spatial.rs parameter record (0 unless its effect is spatially dynamic:
//! those bytes are recomputed for each new Level.TimeSeconds before the
//! merge, as SetupForSurf reruns the spatial function on every per-frame
//! rebuild). No statics: the interpreter instance shares this module's
//! reserved region (build.rs).

const H_WIDTH: usize = 0;
const H_MIN_U: usize = 1;
const H_MAX_U: usize = 2;
const H_MIN_V: usize = 3;
const H_MAX_V: usize = 4;
const H_COUNT: usize = 5;
const H_BASE: usize = 6;
const H_TEXELS: usize = 7;
const HEADER: usize = 8;
// Light words.
const L_MIN_U: usize = 0;
const L_MAX_U: usize = 1;
const L_MIN_V: usize = 2;
const L_MAX_V: usize = 3;
const L_SPATIAL: usize = 4;
const L_TABLES: usize = 5;
const L_MODULATION: usize = 6;
const L_PARAMS: usize = 7;
const LIGHT_WORDS: usize = 8;

unsafe fn bytes<'a>(at: u32, len: usize) -> &'a mut [u8] {
    core::slice::from_raw_parts_mut(at as usize as *mut u8, len)
}

/// One light's saturating merge over its rectangle: each spatial byte,
/// through the modulation table at `(index & 0xff) << 8 | byte` when the
/// light has one and the byte is not 0 (`index` counts every rectangle
/// texel from 0), then, unless 0, each channel's colour-table entry added to
/// the texel and held at 127.
#[inline(always)]
fn merge_light(texels: &mut [u8], width: usize, l: &[u32], spatial: &[u8], tables: &[u8; 768], modulation: Option<&[u8; 65536]>) {
    let (min_u, max_u) = (l[L_MIN_U] as usize, l[L_MAX_U] as usize);
    let (min_v, max_v) = (l[L_MIN_V] as usize, l[L_MAX_V] as usize);
    let rw = max_u - min_u;
    // Fixed-size tables: every index below is in bounds by its type.
    let red: &[u8; 256] = tables[0..256].try_into().unwrap();
    let green: &[u8; 256] = tables[256..512].try_into().unwrap();
    let blue: &[u8; 256] = tables[512..768].try_into().unwrap();
    let mut index = 0usize;
    for v in min_v..max_v {
        let source = &spatial[(v - min_v) * rw..(v - min_v + 1) * rw];
        let row = &mut texels[(v * width + min_u) * 3..(v * width + max_u) * 3];
        for (texel, &spatial) in row.chunks_exact_mut(3).zip(source.iter()) {
            let mut byte = spatial as usize;
            if let Some(table) = modulation {
                if byte != 0 {
                    byte = table[(index & 0xff) << 8 | byte] as usize;
                }
            }
            index += 1;
            if byte == 0 {
                continue;
            }
            let r = texel[0] as u32 + red[byte] as u32;
            let g = texel[1] as u32 + green[byte] as u32;
            let b = texel[2] as u32 + blue[byte] as u32;
            texel[0] = if r < 127 { r as u8 } else { 127 };
            texel[1] = if g < 127 { g as u8 } else { 127 };
            texel[2] = if b < 127 { b as u8 } else { 127 };
        }
    }
}

/// animateLightMap after its memo test: each spatially dynamic light's
/// bytes are recomputed when `time` (Level.TimeSeconds float bits) differs
/// from the time they hold, the union rectangle's texels are saved to
/// `before` and reset from the static bytes, every light is merged in
/// order, and the union is compared with the saved bytes. Returns 1 when a
/// byte changed (the reference returns the union), 0 otherwise.
#[no_mangle]
pub extern "C" fn light_merge(header: u32, before: u32, time: u32) -> u32 {
    unsafe {
        let h = core::slice::from_raw_parts(header as usize as *const u32, HEADER);
        let width = h[H_WIDTH] as usize;
        let (min_u, max_u) = (h[H_MIN_U] as usize, h[H_MAX_U] as usize);
        let (min_v, max_v) = (h[H_MIN_V] as usize, h[H_MAX_V] as usize);
        let count = h[H_COUNT] as usize;
        let end = ((max_v - 1) * width + max_u) * 3;
        let base = bytes(h[H_BASE], end);
        let texels = bytes(h[H_TEXELS], end);
        let row_bytes = (max_u - min_u) * 3;
        let saved = bytes(before, row_bytes * (max_v - min_v));
        for (v, keep) in (min_v..max_v).zip(saved.chunks_exact_mut(row_bytes)) {
            let row = (v * width + min_u) * 3;
            keep.copy_from_slice(&texels[row..row + row_bytes]);
            texels[row..row + row_bytes].copy_from_slice(&base[row..row + row_bytes]);
        }
        let lights = core::slice::from_raw_parts((header as usize + HEADER * 4) as *const u32, count * LIGHT_WORDS);
        for l in lights.chunks_exact(LIGHT_WORDS) {
            if l[L_PARAMS] != 0 {
                let params = &mut *(l[L_PARAMS] as usize as *mut [u32; crate::spatial::PARAM_WORDS]);
                if params[crate::spatial::P_DONE] == 0 || params[crate::spatial::P_DONE_TIME] != time {
                    params[crate::spatial::P_TIME] = time;
                    crate::spatial::run(params);
                    params[crate::spatial::P_DONE_TIME] = time;
                    params[crate::spatial::P_DONE] = 1;
                }
            }
        }
        for l in lights.chunks_exact(LIGHT_WORDS) {
            let area = (l[L_MAX_U] - l[L_MIN_U]) as usize * (l[L_MAX_V] - l[L_MIN_V]) as usize;
            let spatial = bytes(l[L_SPATIAL], area);
            let tables = &*(l[L_TABLES] as usize as *const [u8; 768]);
            let modulation = if l[L_MODULATION] != 0 { Some(&*(l[L_MODULATION] as usize as *const [u8; 65536])) } else { None };
            merge_light(texels, width, l, spatial, tables, modulation);
        }
        for (v, keep) in (min_v..max_v).zip(saved.chunks_exact(row_bytes)) {
            let row = (v * width + min_u) * 3;
            if texels[row..row + row_bytes] != *keep {
                return 1;
            }
        }
        0
    }
}

/// createLightFrame's colour tables for one light (`constants.tables`):
/// entry `byte` of a channel is `Math.min(127, (byte·step) >> 16)` stored
/// through a Uint8Array. The host passes only integer steps in int32, where
/// the double product is exact and ToInt32 keeps its low 32 bits.
#[no_mangle]
pub extern "C" fn light_colour_tables(out: u32, red: i32, green: i32, blue: i32) {
    let out = unsafe { bytes(out, 768) };
    for (table, step) in out.chunks_exact_mut(256).zip([red, green, blue]) {
        for (byte, entry) in table.iter_mut().enumerate() {
            let value = ((byte as i64 * step as i64) as i32) >> 16;
            *entry = if value < 127 { value as u8 } else { 127 };
        }
    }
}

const TWO_52: f64 = 4_503_599_627_370_496.0;
const TWO_62: f64 = 4_611_686_018_427_387_904.0;

/// createLightFrame's modulation table from one effect's 256 merge factors
/// (doubles): entry `i << 8 | byte` is `fistp(f(factor[i]·byte) − 0.5) & 255`.
/// The product is a double rounded once to float. dynamic-lighting.mjs
/// `fistp` is floor, then up past a fraction of 0.5 and on an exact half to
/// the even neighbour; a double of magnitude 2^52 or more is an integer (its
/// own floor, fraction 0), and ±Infinity and NaN pass through. `& 255` is
/// ToInt32's low byte: 0 for ±Infinity, NaN and every double of magnitude
/// 2^62 or more (a multiple of 2^10).
#[no_mangle]
pub extern "C" fn light_modulation(factors: u32, out: u32) {
    let factors = unsafe { core::slice::from_raw_parts(factors as usize as *const f64, 256) };
    let out = unsafe { bytes(out, 65536) };
    for (row, &factor) in out.chunks_exact_mut(256).zip(factors.iter()) {
        for (byte, entry) in row.iter_mut().enumerate() {
            let product = (factor * byte as f64) as f32 as f64 - 0.5;
            *entry = if product.abs() < TWO_52 {
                // Below 2^52 the nearest-even sum with ±2^52 lands on the
                // integer grid, so this is `fistp` (ties to even) exactly.
                let rounded = if product >= 0.0 { (product + TWO_52) - TWO_52 } else { (product - TWO_52) + TWO_52 };
                (rounded as i64 & 255) as u8
            } else if product.abs() < TWO_62 {
                (product as i64 & 255) as u8
            } else {
                0
            };
        }
    }
}
