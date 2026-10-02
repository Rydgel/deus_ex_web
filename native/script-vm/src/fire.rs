//! Fire.dll procedural textures (docs/fire-texture.md "Rust kernel"): the
//! per-tick work of src/runtime/fire-texture.mjs, which is the reference and
//! matches the original (validate-native-fire-texture). Load and PostLoad
//! stay in JavaScript; src/runtime/fire-texture-kernel.mjs copies a loaded
//! texture into a block of this instance's memory above the module's statics
//! and stack, and validate-fire-texture-rust compares the two after every
//! tick.
//!
//! A texture is a header of u32 words (scalars and the addresses of its
//! buffers, laid out by fire-texture-kernel.mjs); the module state every
//! fractal texture shares (the sine tables and the generator) is a `Globals`
//! block. No statics: the interpreter instance shares this module's reserved
//! region (build.rs).
//!
//! The JavaScript body's typed-array semantics are part of the contract: a
//! write past a buffer's end is dropped and a read past it gives 0 (and fails
//! every comparison), so every unmasked `(Y << UBits) + X` access is checked
//! here instead of trapping.

/// The module tables (fireTables) and the lagged-XOR generator.
#[repr(C)]
pub struct Globals {
    sine: [u8; 256],
    clamped: [u8; 256],
    signed: [u8; 256],
    random: [u32; 128],
    index: u32,
}

/// fireRandom: read the dword 0x80 bytes ahead, step the index by 4 and XOR
/// the read value into the new slot.
#[inline(always)]
fn rand(g: &mut Globals) -> u32 {
    let index = g.index;
    let read = ((index.wrapping_add(0x80) & 0xfc) >> 2) as usize;
    let next = index.wrapping_add(4) & 0xfc;
    let value = g.random[read];
    g.index = next;
    g.random[(next >> 2) as usize] ^= value;
    value
}

// Wet texture header words.
const W_U_BITS: usize = 0;
const W_U_SIZE: usize = 2;
const W_V_SIZE: usize = 3;
const W_U_MASK: usize = 4;
const W_V_MASK: usize = 5;
const W_GLOBAL_PHASE: usize = 6;
const W_WAVE_PARITY: usize = 7;
const W_NUM_DROPS: usize = 8;
const W_HAS_SOURCE: usize = 9;
const W_GLOBALS: usize = 10;
const W_DROPS: usize = 11;
const W_FIELDS: usize = 12;
const W_RENDER_TABLE: usize = 13;
const W_WAVE_TABLE: usize = 14;
const W_PIXELS: usize = 15;
const W_SOURCE: usize = 16;
const WET_WORDS: usize = 17;

unsafe fn bytes<'a>(at: u32, len: usize) -> &'a mut [u8] {
    core::slice::from_raw_parts_mut(at as usize as *mut u8, len)
}

/// A typed-array store: dropped past the end.
#[inline(always)]
fn put(buffer: &mut [u8], at: usize, value: u8) {
    if let Some(cell) = buffer.get_mut(at) {
        *cell = value;
    }
}

/// waterRedrawDrops (0x10506410). `field` is SourceFields, `d` the 2048-byte
/// drops array.
fn water_redraw_drops(h: &mut [u32], g: &mut Globals, field: &mut [u8], d: &mut [u8]) {
    let bits = h[W_U_BITS];
    let hum = (h[W_U_MASK] as i32 >> 1) & 255;
    let hvm = (h[W_V_MASK] as i32 >> 1) & 255;
    let hw = (h[W_U_SIZE] / 2) as usize;
    h[W_GLOBAL_PHASE] = (h[W_GLOBAL_PHASE] as i32).wrapping_add(1) as u32;
    // Drops past the 256 the array holds read as type `undefined`: no case.
    let count = (h[W_NUM_DROPS] as i32).clamp(0, 256) as usize;
    let at = |cx: i32, cy: i32| ((cy << bits) + cx) as usize;
    for i in 0..count {
        let o = i * 8;
        let (ty, x, y) = (d[o], d[o + 2] as i32, d[o + 3] as i32);
        let p = at(x, y);
        let n = (d[o + 7] >> 1) as i32;
        let pair = |field: &mut [u8], q: usize, value: u8| {
            put(field, q, value);
            put(field, q + hw, value);
        };
        let tap = |field: &mut [u8], q: usize, depth: u8| {
            put(field, q, depth);
            put(field, q + hw, !depth);
        };
        let phase = |d: &mut [u8]| {
            d[o + 1] = d[o + 1].wrapping_add(d[o + 7]);
            d[o + 1]
        };
        let osc = |d: &mut [u8], g: &Globals| {
            d[o + 1] = d[o + 1].wrapping_add(d[o + 6]);
            g.sine[d[o + 1] as usize]
        };
        // The line shapes: n + 1 cells from (X, Y) along a direction.
        let line = |field: &mut [u8], value: u8, dx: i32, dy: i32| {
            for k in 0..=n {
                if dy == 0 {
                    pair(field, at((x + k) & hum, y), value);
                } else {
                    let cx = if dx == 0 { x } else { (x + dx * k) & hum };
                    pair(field, at(cx, (y + k) & hvm), value);
                }
            }
        };
        // WhirlyThing / BigWhirly: angle B:A stepped by D:C (or back).
        let whirl = |field: &mut [u8], d: &mut [u8], g: &Globals, sign: i32, shift: u32| {
            let angle = (((d[o + 5] as i32) << 8 | d[o + 4] as i32)
                + sign * ((d[o + 7] as i32) << 8 | d[o + 6] as i32))
                & 0xffff;
            d[o + 4] = angle as u8;
            d[o + 5] = (angle >> 8) as u8;
            let b = (angle >> 8) as usize;
            let cx = (((g.sine[b] >> shift) as i32) + x) & hum;
            let cy = (((g.sine[(b + 0x40) & 255] >> shift) as i32) + y) & hvm;
            pair(field, at(cx, cy), d[o + 1]);
        };
        match ty {
            0x00 => pair(field, p, d[o + 7]),
            0x01 => {
                let k = phase(d) as usize;
                pair(field, p, g.sine[k]);
            }
            0x02 => {
                let k = phase(d) as usize;
                pair(field, p, (g.sine[k] >> 1) + 0x40);
            }
            0x03 => {
                let k = phase(d) as usize;
                pair(field, p, g.sine[k].max(0x80));
            }
            0x04 => {
                let a = (rand(g) & 3) as i32;
                d[o + 2] = (((rand(g) & 3) as i32 - a + x) & hum) as u8;
                let b = (rand(g) & 3) as i32;
                d[o + 3] = (((rand(g) & 3) as i32 - b + y) & hvm) as u8;
                put(field, p, 0xb9);
                put(field, p + hw, 0x47);
            }
            0x05 => {
                let first = rand(g) as u8;
                put(field, p, first);
                let second = rand(g) as u8;
                put(field, p + hw, second);
            }
            0x06 => whirl(field, d, g, 1, 4),
            0x07 => whirl(field, d, g, 1, 3),
            0x40 => whirl(field, d, g, -1, 4),
            0x41 => whirl(field, d, g, -1, 3),
            0x08 => line(field, d[o + 1], 1, 0),
            0x09 => line(field, d[o + 1], 0, 1),
            0x0a => line(field, d[o + 1], -1, 1),
            0x0b => line(field, d[o + 1], 1, 1),
            0x0c => {
                let v = osc(d, g);
                line(field, v, 1, 0);
            }
            0x0d => {
                let v = osc(d, g);
                line(field, v, 0, 1);
            }
            0x0e => {
                let v = osc(d, g);
                line(field, v, -1, 1);
            }
            0x0f => {
                let v = osc(d, g);
                line(field, v, 1, 1);
            }
            0x10 => {
                if rand(g) & 0xf != 0 {
                    continue;
                }
                let r = d[o + 7] as i32;
                let cy = ((((rand(g) & 255) as i32 * r) >> 8) + y) & hvm;
                let cx = ((((rand(g) & 255) as i32 * r) >> 8) + x) & hum;
                tap(field, at(cx, cy), d[o + 1]);
            }
            0x11 => {
                for j in 0..n {
                    for k in 0..n {
                        pair(field, at((x + k) & hum, (y + j) & hvm), d[o + 1]);
                    }
                }
            }
            0x12 => {
                d[o + 4] = d[o + 4].wrapping_add(d[o + 7]);
                if d[o + 4] <= d[o + 7] {
                    tap(field, p, d[o + 1]);
                }
            }
            0x13 => {
                d[o + 4] = d[o + 4].wrapping_add(d[o + 7]);
                if d[o + 4] <= d[o + 7] {
                    d[o + 4] = rand(g) as u8;
                    tap(field, p, d[o + 1]);
                }
            }
            _ => {}
        }
    }
}

/// calculateWater (0x105059c0) and applyWetTexture (0x10505a10) in one pass.
///
/// In place: the JavaScript body reads a copy of the fields taken before the
/// pass, but a pass writes only the cells of its own parity's rows and reads,
/// besides each cell's own value before its one write, only rows of the
/// other parity, so the live buffer gives the same values.
///
/// Fused: the pass writes every pixel of a power-of-two texture exactly once
/// (each cell its 2×2 block, the even pass's shifted half a cell up and left
/// with wrapping), and applyWetTexture then turns each refraction offset into
/// `src[(offset + x) & (USize - 1)]` in byte arithmetic on the same row
/// (`y << UBits` there, `y · USize` here), so the pixel takes that source byte
/// directly.
fn calculate_water(h: &mut [u32], field: &mut [u8], rt: &[u8], wt: &[u8], pixels: &mut [u8], src: &[u8]) {
    let parity = (h[W_WAVE_PARITY] + 1) & 255;
    h[W_WAVE_PARITY] = parity;
    let odd = (parity & 1) as i32;
    let w = h[W_U_SIZE] as i32;
    let v_size = h[W_V_SIZE] as i32;
    let hw = w >> 1;
    let rows = (v_size >> 1) * 2;
    // Offsets here are at most a few cells, so one correction wraps them.
    let wrap = |i: i32, n: i32| if i < 0 { i + n } else if i >= n { i - n } else { i };
    // The JavaScript body's s(x) = S[x + a] - S[x + b] and corners x + lo,
    // x + hi (odd: a 1, b -1, lo 0, hi 1; even: a 0, b -2, lo -1, hi 0) all
    // fall in the window x + e - 2 .. x + e, carried along the row.
    let e = odd;
    let mask = ((w - 1) & 255) as usize;
    let mut r = odd;
    while r < rows {
        let north = (wrap(r - 1, rows) * hw) as usize;
        let south = (wrap(r + 1, rows) * hw) as usize;
        let row = (r * hw) as usize;
        let y = r >> 1;
        let top = if odd != 0 { 2 * y } else { 2 * y - 1 };
        let top_row = (wrap(top, v_size) * w) as usize;
        let bottom_row = (wrap(top + 1, v_size) * w) as usize;
        let cell = |base: usize, i: i32| field[base + wrap(i, hw) as usize] as i32;
        let (mut s0, mut s1) = (cell(south, e - 2), cell(south, e - 1));
        let (mut n0, mut n1) = (cell(north, e - 2), cell(north, e - 1));
        // s(-1) and h(-1), the left neighbours at x = 0.
        let mut s_prev = s1 - cell(south, e - 3);
        let mut h_prev = (s_prev + n1 - cell(north, e - 3)) >> 1;
        for x in 0..hw {
            let next = wrap(x + e, hw) as usize;
            let (s2, n2) = (field[south + next] as i32, field[north + next] as i32);
            let sx = s2 - s0;
            let hx = (sx + n2 - n0) >> 1;
            let at = row + x as usize;
            field[at] = wt[(n1 + n2 + s1 + s2 - 2 * field[at] as i32 + 0x200) as usize];
            let px = if odd != 0 { 2 * x } else if x == 0 { w - 1 } else { 2 * x - 1 };
            let px1 = if px == w - 1 { 0 } else { px + 1 } as usize;
            let px = px as usize;
            let refract = |base: usize, p: usize, offset: i32| src[base + ((rt[(offset + 0x200) as usize] as usize + p) & mask)];
            pixels[bottom_row + px] = refract(bottom_row, px, sx + s_prev);
            pixels[bottom_row + px1] = refract(bottom_row, px1, 2 * sx);
            pixels[top_row + px] = refract(top_row, px, hx + h_prev);
            pixels[top_row + px1] = refract(top_row, px1, 2 * hx);
            (s0, s1, n0, n1, s_prev, h_prev) = (s1, s2, n1, n2, sx, hx);
        }
        r += 2;
    }
}

/// wetConstantTimeTick (0x10509840) for the texture whose header is at
/// `header`: WaterRedrawDrops, then CalculateWater with ApplyWetTexture. fire-texture-kernel.mjs admits only power-of-two textures whose
/// buffers have the sizes the JavaScript body indexes.
#[no_mangle]
pub extern "C" fn fire_wet_tick(header: u32) {
    let h = unsafe { core::slice::from_raw_parts_mut(header as usize as *mut u32, WET_WORDS) };
    let (u_size, v_size) = (h[W_U_SIZE] as i32, h[W_V_SIZE] as i32);
    if h[W_HAS_SOURCE] == 0 || u_size < 8 || v_size < 8 {
        return;
    }
    let n = (u_size * v_size) as usize;
    unsafe {
        let g = &mut *(h[W_GLOBALS] as usize as *mut Globals);
        let field = bytes(h[W_FIELDS], n / 2);
        let drops = bytes(h[W_DROPS], 2048);
        water_redraw_drops(h, g, field, drops);
        let rt = bytes(h[W_RENDER_TABLE], 1028);
        let wt = bytes(h[W_WAVE_TABLE], 1536);
        let pixels = bytes(h[W_PIXELS], n);
        calculate_water(h, field, rt, wt, pixels, bytes(h[W_SOURCE], n));
    }
}

/// The viewer's upload (procedural-textures.mjs `upload`): each P8 index
/// through the 1024-byte palette (zero past a short palette's end) to RGBA
/// with alpha 255.
#[no_mangle]
pub extern "C" fn fire_expand(pixels: u32, count: u32, palette: u32, rgba: u32) {
    let count = count as usize;
    unsafe {
        let palette = bytes(palette, 1024);
        let mut lut = [0u32; 256];
        for (i, entry) in lut.iter_mut().enumerate() {
            let c = &palette[i * 4..i * 4 + 3];
            *entry = c[0] as u32 | (c[1] as u32) << 8 | (c[2] as u32) << 16 | 0xff00_0000;
        }
        let pixels = bytes(pixels, count);
        let out = core::slice::from_raw_parts_mut(rgba as usize as *mut u32, count);
        for (cell, &index) in out.iter_mut().zip(pixels.iter()) {
            *cell = lut[index as usize];
        }
    }
}
