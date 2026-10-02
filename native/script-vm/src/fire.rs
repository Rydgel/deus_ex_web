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

// Fire texture header words.
const F_U_BITS: usize = 0;
const F_U_SIZE: usize = 2;
const F_V_SIZE: usize = 3;
const F_U_MASK: usize = 4;
const F_V_MASK: usize = 5;
const F_GLOBAL_PHASE: usize = 6;
const F_AUX_PHASE: usize = 7;
const F_FX_FREQUENCY: usize = 8;
const F_B_RISING: usize = 9;
const F_SPARKS_LIMIT: usize = 10;
const F_ACTIVE: usize = 11;
const F_STAR_STATUS: usize = 12;
const F_GLOBALS: usize = 13;
const F_SPARKS: usize = 14;
const F_SPARKS_LENGTH: usize = 15;
const F_RENDER_TABLE: usize = 16;
const F_PIXELS: usize = 17;
const F_SCRATCH: usize = 18;
const FIRE_WORDS: usize = 19;

/// A fire texture during RedrawSparks: the sparks (8 bytes each: Type Heat
/// X Y A B C D), the P8 pixels and the header's scalars.
struct Fire<'a> {
    g: &'a mut Globals,
    sp: &'a mut [u8],
    px: &'a mut [u8],
    bits: u32,
    um: i32,
    vm: i32,
    active: i32,
    limit: i32,
    phase: i32,
}

const HEAT: usize = 1;
const X: usize = 2;
const Y: usize = 3;
const A: usize = 4;
const B: usize = 5;
const C: usize = 6;
const D: usize = 7;

fn signed(value: u8) -> i32 {
    value as i8 as i32
}

impl Fire<'_> {
    fn rand(&mut self) -> u32 {
        rand(self.g)
    }
    fn rand_byte(&mut self) -> i32 {
        (rand(self.g) & 255) as i32
    }
    fn get(&self, s: usize, k: usize) -> i32 {
        self.sp[s + k] as i32
    }
    fn set(&mut self, s: usize, k: usize, value: i32) {
        self.sp[s + k] = value as u8;
    }
    /// Mip-0 offset `(Y << UBits) + X`, unmasked as the cases index.
    fn at(&self, x: i32, y: i32) -> usize {
        (y.wrapping_shl(self.bits) + x) as usize
    }
    fn put(&mut self, p: usize, value: i32) {
        put(self.px, p, value as u8);
    }
    fn draw_heat(&mut self, s: usize) {
        let p = self.at(self.get(s, X), self.get(s, Y));
        self.put(p, self.get(s, HEAT));
    }
    /// killSpark: the last active spark moves into this slot.
    fn kill(&mut self, i: usize) {
        self.active -= 1;
        let from = self.active as usize * 8;
        self.sp.copy_within(from..from + 8, i * 8);
    }
    /// A new temporary at ActiveSparkNum (the caller checked the limit):
    /// its base offset.
    fn emit(&mut self) -> usize {
        let n = self.active as usize;
        self.active += 1;
        n * 8
    }
    fn room(&self) -> bool {
        self.active < self.limit
    }
    /// The step of a coordinate toward a signed rate when (rand & 0x7f) is
    /// below its magnitude, wrapping by `mask`.
    fn step(&mut self, s: usize, k: usize, rate: i32, mask: i32) {
        let r = (self.rand() & 0x7f) as i32;
        if rate < 0 {
            if r < -rate {
                self.set(s, k, ((self.get(s, k) - 1) & 255) & mask);
            }
        } else if r < rate {
            self.set(s, k, ((self.get(s, k) + 1) & 255) & mask);
        }
    }
    /// walk: X by signed A, then Y by signed B; returns B as loaded.
    fn walk(&mut self, s: usize) -> i32 {
        let (um, vm) = (self.um, self.vm);
        self.step(s, X, signed(self.sp[s + A]), um);
        let b = signed(self.sp[s + B]);
        self.step(s, Y, b, vm);
        b
    }
    fn walk_by(&mut self, s: usize, dx: i32, dy: i32) {
        let (um, vm) = (self.um, self.vm);
        self.step(s, X, dx, um);
        self.step(s, Y, dy, vm);
    }
    /// wander: an odd draw moves X by (rand & 15) - 7, then Y the same.
    fn wander(&mut self, s: usize) {
        if self.rand() & 1 != 0 {
            let v = ((self.rand() & 0xf) as i32 + self.get(s, X) - 7) & 255;
            self.set(s, X, v & self.um);
        }
        if self.rand() & 1 != 0 {
            let v = ((self.rand() & 0xf) as i32 + self.get(s, Y) - 7) & 255;
            self.set(s, Y, v & self.vm);
        }
    }
    /// jitter: X += (r1 & 7) - (r2 & 7), then Y the same.
    fn jitter(&mut self, s: usize) {
        let a = (self.rand() & 7) as i32;
        let b = (self.rand() & 7) as i32;
        self.set(s, X, ((a - b + self.get(s, X)) & 255) & self.um);
        let a = (self.rand() & 7) as i32;
        let b = (self.rand() & 7) as i32;
        self.set(s, Y, ((a - b + self.get(s, Y)) & 255) & self.vm);
    }
    /// drift: X toward A's sign when (rand & 0x7f) < |A|; Y up two rows.
    fn drift(&mut self, s: usize) {
        let a = signed(self.sp[s + A]);
        let r = (self.rand() & 0x7f) as i32;
        if if a < 0 { r < -a } else { r < a } {
            self.set(s, X, ((self.get(s, X) + if a < 0 { -1 } else { 1 }) & 255) & self.um);
        }
        self.set(s, Y, ((self.get(s, Y) - 2) & 255) & self.vm);
    }
    /// A random cell within 0..31 of the spark (X then Y).
    fn near(&mut self, s: usize, d: usize) {
        let x = ((self.rand() & 0x1f) as i32 + self.get(s, X)) & 255;
        self.set(d, X, x & self.um);
        let y = ((self.rand() & 0x1f) as i32 + self.get(s, Y)) & 255;
        self.set(d, Y, y & self.vm);
    }
    /// A random cell within C of the spark (rand·C >> 8 each way).
    fn within(&mut self, s: usize, d: usize) {
        let x = (self.get(s, X) + ((self.rand_byte() * self.get(s, C)) >> 8)) & 255;
        self.set(d, X, x & self.um);
        let y = (self.get(s, Y) + ((self.rand_byte() * self.get(s, C)) >> 8)) & 255;
        self.set(d, Y, y & self.vm);
    }

    /// drawFlashRamp (0x105022f0).
    fn flash(&mut self, x0: i32, y0: i32, xd0: i32, yd0: i32, color1: i32, color2: i32) {
        let (mut x, mut y, mut xd, mut yd, mut c1, mut c2) = (x0, y0, xd0, yd0, color1, color2);
        let flip = (yd & 1 != 0 && 2 * yd >= xd) || (xd & 1 != 0 && 2 * yd < xd);
        if flip {
            x = (x + if xd & 1 != 0 { -xd } else { xd }) & 255;
            y = (y + if yd & 1 != 0 { -yd } else { yd }) & 255;
            xd ^= 1;
            yd ^= 1;
            core::mem::swap(&mut c1, &mut c2);
        }
        let n = xd.max(yd) | 1;
        let mut jag = [0i32; 256];
        let mut sum = 0;
        for cell in jag.iter_mut().take(n as usize) {
            *cell = self.rand_byte();
            sum += *cell;
        }
        let (y_step, y_signed) = if yd & 1 != 0 { (-1, -yd) } else { (1, yd) };
        let (x_step, x_signed) = if xd & 1 != 0 { (-1, -xd) } else { (1, xd) };
        let color_step = ((c2 - c1) << 23) / n;
        let mut color = c1 << 23;
        if xd >= yd {
            let increment = ((y_signed << 6) - sum) / n;
            let mut acc = y << 6;
            for &jagged in jag.iter().take(xd as usize) {
                acc = acc.wrapping_add(jagged + increment);
                let p = ((((acc >> 6) & self.vm).wrapping_shl(self.bits)) + (x & self.um)) as usize;
                x = (x + x_step) & 255;
                color = color.wrapping_add(color_step);
                self.put(p, color >> 23);
            }
        } else {
            let increment = ((x_signed << 6) - sum) / n;
            let mut acc = x << 6;
            for &jagged in jag.iter().take(yd as usize) {
                acc = acc.wrapping_add(jagged + increment);
                let p = (((y & self.vm).wrapping_shl(self.bits)) + ((acc >> 6) & self.um)) as usize;
                y = (y + y_step) & 255;
                color = color.wrapping_add(color_step);
                self.put(p, color >> 23);
            }
        }
    }

    /// The jump table at 0x10505874: spark `i` of type `ty`.
    fn spark(&mut self, i: usize, ty: u8) {
        let s = i * 8;
        let (um, vm) = (self.um, self.vm);
        match ty {
            // Burn: a random byte at the spark.
            0x00 => {
                let p = self.at(self.get(s, X), self.get(s, Y));
                let r = self.rand_byte();
                self.put(p, r);
            }
            // Sparkle: Heat at (X + A·r1>>8, Y + B·r2>>8), masked.
            0x01 => {
                let x = self.get(s, X) + ((self.get(s, A) * self.rand_byte()) >> 8);
                let y = self.get(s, Y) + ((self.get(s, B) * self.rand_byte()) >> 8);
                let p = self.at(x & um, y & vm);
                self.put(p, self.get(s, HEAT));
            }
            // Pulse: Heat at the spark, then Heat += D.
            0x02 => {
                self.draw_heat(s);
                self.set(s, HEAT, self.get(s, HEAT) + self.get(s, D));
            }
            // Signal: Heat above C draws; Heat += D, a carry draws anew.
            0x03 => {
                let heat = self.get(s, HEAT);
                if heat > self.get(s, C) {
                    let p = self.at(self.get(s, X), self.get(s, Y));
                    self.put(p, heat);
                }
                let next = (heat + self.get(s, D)) & 255;
                self.set(s, HEAT, next);
                if next < self.get(s, D) {
                    let r = self.rand_byte();
                    self.set(s, HEAT, r);
                }
            }
            // Blaze: a 0x20 with random A and B.
            0x04 => {
                if !self.room() || self.rand_byte() >= 0x80 {
                    return;
                }
                let d = self.emit();
                for k in [0, HEAT, X, Y] {
                    self.sp[d + k] = if k == 0 { 0x20 } else { self.sp[s + k] };
                }
                let a = self.rand_byte();
                self.set(d, A, a);
                let b = self.rand_byte();
                self.set(d, B, b);
                self.sp[d + C] = self.sp[s + C];
                self.sp[d + D] = self.sp[s + D];
            }
            // OzHasSpoken: a 0x21 rising (B 0x81, D 2), random sideways A.
            0x05 => {
                if !self.room() || self.rand_byte() >= 0x80 {
                    return;
                }
                let d = self.emit();
                for k in [0, HEAT, X, Y] {
                    self.sp[d + k] = if k == 0 { 0x21 } else { self.sp[s + k] };
                }
                let a = (self.rand() & 0x7f) as i32 - 0x3f;
                self.set(d, A, a);
                self.sp[d + B] = 0x81;
                self.sp[d + D] = 2;
            }
            // Cone: a 0x22 (B 0, C 0x32), random sideways A.
            0x06 => {
                if !self.room() || self.rand_byte() >= 0x40 {
                    return;
                }
                let d = self.emit();
                for k in [0, HEAT, X, Y] {
                    self.sp[d + k] = if k == 0 { 0x22 } else { self.sp[s + k] };
                }
                let a = (self.rand() & 0x7f) as i32 - 0x3f;
                self.set(d, A, a);
                self.sp[d + B] = 0;
                self.sp[d + C] = 0x32;
            }
            // BlazeRight / BlazeLeft: a 0x22 thrown up (B 0xe3) sideways.
            0x07 | 0x08 => {
                if !self.room() || self.rand_byte() >= 0x40 {
                    return;
                }
                let d = self.emit();
                for k in [0, HEAT, X, Y] {
                    self.sp[d + k] = if k == 0 { 0x22 } else { self.sp[s + k] };
                }
                let base = if ty == 0x07 { 0x3f } else { 0x80 };
                let a = (self.rand() & 0x3f) as i32 + base;
                self.set(d, A, a);
                self.sp[d + B] = 0xe3;
                self.sp[d + C] = self.sp[s + C];
            }
            // Cylinder: min(sin(A+64)+Heat, 255) at (X + sin(A)·B>>8, Y).
            0x09 => {
                let a = self.get(s, A) as usize;
                let color = (self.g.sine[(a + 0x40) & 255] as i32 + self.get(s, HEAT)).min(255);
                let x = ((self.get(s, X) + ((self.g.sine[a] as i32 * self.get(s, B)) >> 8)) & 255) & um;
                let p = self.at(x, self.get(s, Y));
                self.put(p, color);
                self.set(s, A, a as i32 + self.get(s, D));
            }
            // Cylinder3D: the front half of the Cylinder only.
            0x0a => {
                let a = self.get(s, A) as usize;
                let k = (a + 0x40) & 255;
                if k < 0x80 {
                    let color = (self.g.sine[k] as i32 + self.get(s, HEAT)).min(255);
                    let x = ((self.get(s, X) + ((self.g.sine[a] as i32 * self.get(s, B)) >> 8)) & 255) & um;
                    let p = self.at(x, self.get(s, Y));
                    self.put(p, color);
                }
                self.set(s, A, self.get(s, A) + self.get(s, D));
            }
            // Lissajous: sineClamped(A+64) at the two sine offsets.
            0x0b => {
                let (heat, a, b) = (self.get(s, HEAT), self.get(s, A) as usize, self.get(s, B) as usize);
                let y = ((self.get(s, Y) + ((self.g.sine[b] as i32 * heat) >> 8)) & 255) & vm;
                let x = ((self.get(s, X) + ((self.g.sine[a] as i32 * heat) >> 8)) & 255) & um;
                let p = self.at(x, y);
                self.put(p, self.g.clamped[(a + 0x40) & 255] as i32);
                self.set(s, A, self.get(s, A) + self.get(s, C));
                self.set(s, B, self.get(s, B) + self.get(s, D));
            }
            // Jugglers: min(sin(A+64)+Heat, 255) at (X, Y + sin(A)·B>>8).
            0x0c => {
                let a = self.get(s, A) as usize;
                let color = (self.g.sine[(a + 0x40) & 255] as i32 + self.get(s, HEAT)).min(255);
                let y = ((self.get(s, Y) + ((self.g.sine[a] as i32 * self.get(s, B)) >> 8)) & 255) & vm;
                let p = self.at(self.get(s, X), y);
                self.put(p, color);
                self.set(s, A, a as i32 + self.get(s, D));
            }
            // Emit / Fountain: a 0x21 / 0x2a copying Heat, X, Y, A, B, D.
            0x0d | 0x0e => {
                if !self.room() || self.rand_byte() >= 0x40 {
                    return;
                }
                let d = self.emit();
                self.sp[d] = if ty == 0x0d { 0x21 } else { 0x2a };
                for k in [HEAT, X, Y, A, B, D] {
                    self.sp[d + k] = self.sp[s + k];
                }
            }
            // Flocks: a 0x27 within 0..31 heading A; A += C; jitter.
            0x0f => {
                if self.room() {
                    let d = self.emit();
                    self.sp[d] = 0x27;
                    self.near(s, d);
                    self.sp[d + B] = self.sp[s + A];
                    self.sp[d + A] = 0;
                    self.sp[d + C] = self.sp[s + B];
                    self.sp[d + D] = self.sp[s + D];
                    self.sp[d + HEAT] = self.sp[s + HEAT];
                    self.set(s, A, self.get(s, A) + self.get(s, C));
                }
                self.jitter(s);
            }
            // Eels: a draw under 0x14 emits a 0x26 within 0..31; wander.
            0x10 => {
                if self.rand_byte() < 0x14 && self.room() {
                    let d = self.emit();
                    self.sp[d + HEAT] = self.sp[s + HEAT];
                    self.sp[d] = 0x26;
                    self.near(s, d);
                    let a = self.rand_byte();
                    self.set(d, A, a);
                    let b = self.rand_byte();
                    self.set(d, B, b);
                    self.sp[d + C] = self.sp[s + C];
                }
                self.wander(s);
            }
            // Organic: a draw under 0x80 emits a 0x23 within C.
            0x11 => {
                if !self.room() || self.rand_byte() >= 0x80 {
                    return;
                }
                let d = self.emit();
                self.sp[d] = 0x23;
                self.within(s, d);
                let a = self.rand().wrapping_sub(0x7f) as i32;
                self.set(d, A, a);
                self.sp[d + B] = 0x81;
                self.sp[d + C] = 0xff;
            }
            // WanderOrganic / RandomCloud: a 0x23 / 0x24 within 0..31; wander.
            0x12 | 0x13 => {
                if self.room() {
                    let d = self.emit();
                    self.sp[d] = if ty == 0x12 { 0x23 } else { 0x24 };
                    self.near(s, d);
                    if ty == 0x12 {
                        let a = self.rand().wrapping_sub(0x7f) as i32;
                        self.set(d, A, a);
                        self.sp[d + C] = 0xff;
                    } else {
                        let a = (self.rand() & 0x1f) as i32 - 0xf;
                        self.set(d, A, a);
                        self.sp[d + C] = 0;
                    }
                    self.sp[d + B] = 0x81;
                }
                self.wander(s);
            }
            // CustomCloud: a 0x25 within 0..31 with A, B and C = D; jitter.
            0x14 => {
                if self.room() {
                    let d = self.emit();
                    self.sp[d] = 0x25;
                    self.near(s, d);
                    self.sp[d + A] = self.sp[s + A];
                    self.sp[d + B] = self.sp[s + B];
                    self.sp[d + C] = self.sp[s + D];
                }
                self.jitter(s);
            }
            // LocalCloud: a 0x25 within C with A, B and C = D.
            0x15 => {
                if !self.room() {
                    return;
                }
                let d = self.emit();
                self.sp[d] = 0x25;
                self.within(s, d);
                self.sp[d + A] = self.sp[s + A];
                self.sp[d + B] = self.sp[s + B];
                self.sp[d + C] = self.sp[s + D];
            }
            // Stars: B at the spark (PostDrawSparks does the rest).
            0x16 => {
                let p = self.at(self.get(s, X), self.get(s, Y));
                self.put(p, self.get(s, B));
            }
            // Line / RampLightning.
            0x17 | 0x18 => {
                let heat = self.get(s, HEAT);
                if heat == 0 {
                    return;
                }
                if self.get(s, C) > 0 {
                    self.set(s, C, self.get(s, C) - 1);
                    let shift = if ty == 0x17 { 0 } else { 3 };
                    let (x, y, a, b) = (self.get(s, X), self.get(s, Y), self.get(s, A), self.get(s, B));
                    self.flash(x, y, a, b, heat, heat >> shift);
                    return;
                }
                if self.rand_byte() < self.get(s, D) {
                    return;
                }
                let c = (self.rand().wrapping_add(1) & 255) as i32 & 5;
                self.set(s, C, c);
            }
            // SphereLightning: a ray of length C at a random angle.
            0x19 => {
                if self.rand_byte() < self.get(s, D) {
                    return;
                }
                let a = self.rand_byte() as usize;
                let (radius, heat) = (self.get(s, C), self.get(s, HEAT));
                let half = radius >> 1;
                let dx = ((self.g.sine[a] as i32 * radius) >> 8) - half;
                let dy = ((self.g.sine[(a + 0x40) & 255] as i32 * radius) >> 8) - half;
                let encode = |v: i32| (if v > 0 { v & !1 } else { (-v) | 1 }) & 255;
                let (x, y) = (self.get(s, X), self.get(s, Y));
                self.flash(x, y, encode(dx), encode(dy), heat, heat >> 2);
            }
            // Wheel: a 0x27 at the spark heading A; then A += C.
            0x1a => {
                if self.room() {
                    let d = self.emit();
                    self.sp[d] = 0x27;
                    self.sp[d + X] = self.sp[s + X];
                    self.sp[d + Y] = self.sp[s + Y];
                    self.sp[d + B] = self.sp[s + A];
                    self.sp[d + A] = 0;
                    self.sp[d + C] = self.sp[s + B];
                    self.sp[d + D] = self.sp[s + D];
                    self.sp[d + HEAT] = self.sp[s + HEAT];
                }
                self.set(s, A, self.get(s, A) + self.get(s, C));
            }
            // Gametes: a draw under 0x14 emits a 0x2b within 0..31; wander.
            0x1b => {
                if self.rand_byte() < 0x14 && self.room() {
                    let d = self.emit();
                    self.sp[d] = 0x2b;
                    self.sp[d + HEAT] = self.sp[s + HEAT];
                    self.near(s, d);
                    let a = self.rand_byte();
                    self.set(d, A, a);
                    self.sp[d + C] = self.sp[s + C];
                    let dd = self.rand_byte();
                    self.set(d, D, dd);
                }
                self.wander(s);
            }
            // Sprinkler: a 0x28 copying the spark (D 2); then A += D.
            0x1c => {
                if self.room() {
                    let d = self.emit();
                    self.sp[d] = 0x28;
                    for k in [X, Y, HEAT, A, B, C] {
                        self.sp[d + k] = self.sp[s + k];
                    }
                    self.sp[d + D] = 2;
                }
                self.set(s, A, self.get(s, A) + self.get(s, D));
            }
            // 0x1d: sineClamped(A+64) at (X + sin(A)·Heat>>8, Y); A += C.
            0x1d => {
                let a = self.get(s, A) as usize;
                let x = ((self.get(s, X) + ((self.g.sine[a] as i32 * self.get(s, HEAT)) >> 8)) & 255) & um;
                let p = self.at(x, self.get(s, Y));
                self.put(p, self.g.clamped[(a + 0x40) & 255] as i32);
                self.set(s, A, a as i32 + self.get(s, C));
            }
            // 0x1e: sineClamped(B+64) at (X, Y + sin(B)·Heat>>8); B += D.
            0x1e => {
                let b = self.get(s, B) as usize;
                let y = ((self.get(s, Y) + ((self.g.sine[b] as i32 * self.get(s, HEAT)) >> 8)) & 255) & vm;
                let p = self.at(self.get(s, X), y);
                self.put(p, self.g.clamped[(b + 0x40) & 255] as i32);
                self.set(s, B, b as i32 + self.get(s, D));
            }
            // Temporary 0x20: Heat -= 5, dying on the borrow.
            0x20 => {
                self.set(s, HEAT, self.get(s, HEAT) + 0xfb);
                if self.get(s, HEAT) >= 0xfb {
                    return self.kill(i);
                }
                self.draw_heat(s);
                self.walk(s);
            }
            // Temporary 0x21: Heat -= D, dying at or below D.
            0x21 => {
                self.set(s, HEAT, self.get(s, HEAT) - self.get(s, D));
                if self.get(s, HEAT) <= self.get(s, D) {
                    return self.kill(i);
                }
                self.draw_heat(s);
                self.walk(s);
            }
            // Temporary 0x22: C counts down; draws, walks and falls.
            0x22 => {
                self.set(s, C, self.get(s, C) - 1);
                if self.get(s, C) == 0 {
                    return self.kill(i);
                }
                self.draw_heat(s);
                let b = self.walk(s);
                if b < 0x7a {
                    self.set(s, B, b + 3);
                }
            }
            // Temporary 0x23 / 0x24: C -= 3 / += 4; draws C and drifts.
            0x23 | 0x24 => {
                let c = (if ty == 0x23 { self.get(s, C) - 3 } else { self.get(s, C) + 4 }) & 255;
                self.set(s, C, c);
                if if ty == 0x23 { c <= 0xbe } else { c >= 0xfa } {
                    return self.kill(i);
                }
                let p = self.at(self.get(s, X), self.get(s, Y));
                self.put(p, c);
                self.drift(s);
            }
            // Temporary 0x25: C += 4, dying at 0xfa or above; draws C, walks.
            0x25 => {
                let c = (self.get(s, C) + 4) & 255;
                self.set(s, C, c);
                if c >= 0xfa {
                    return self.kill(i);
                }
                let p = self.at(self.get(s, X), self.get(s, Y));
                self.put(p, c);
                self.walk(s);
            }
            // Temporary 0x26: C counts down to death; draws Heat, walks.
            0x26 => {
                self.set(s, C, self.get(s, C) - 1);
                if self.get(s, C) == 0xff {
                    return self.kill(i);
                }
                self.draw_heat(s);
                self.walk(s);
            }
            // Temporary 0x27: steered by the sine+0x80 table at B; the A/B
            // word advances by D·16.
            0x27 => {
                self.set(s, C, self.get(s, C) - 1);
                if self.get(s, C) == 0xff {
                    return self.kill(i);
                }
                self.draw_heat(s);
                let b = self.get(s, B) as usize;
                let dy = signed(self.g.signed[b]);
                let dx = signed(self.g.signed[(b + 0x40) & 255]);
                let word = ((self.get(s, A) | self.get(s, B) << 8) + (self.get(s, D) << 4)) & 0xffff;
                self.set(s, A, word);
                self.set(s, B, word >> 8);
                self.walk_by(s, dx, dy);
            }
            // Temporary 0x28: X by sin(A+64)+0x80, Y by B; A += D.
            0x28 => {
                self.set(s, C, self.get(s, C) - 1);
                if self.get(s, C) == 0xff {
                    return self.kill(i);
                }
                self.draw_heat(s);
                let a = self.get(s, A);
                let dx = signed(self.g.sine[((a + 0x40) & 255) as usize].wrapping_add(0x80));
                let dy = signed(self.sp[s + B]);
                self.set(s, A, self.get(s, D) + a);
                self.walk_by(s, dx, dy);
            }
            // Temporary 0x29: Heat -= C, dying at 0xfa or above.
            0x29 => {
                self.set(s, HEAT, self.get(s, HEAT) - self.get(s, C));
                if self.get(s, HEAT) >= 0xfa {
                    return self.kill(i);
                }
                self.draw_heat(s);
                self.walk(s);
            }
            // Temporary 0x2a: Heat -= D, dying at or below 0x32; falls on odd
            // GlobalPhase.
            0x2a => {
                self.set(s, HEAT, self.get(s, HEAT) - self.get(s, D));
                if self.get(s, HEAT) <= 0x32 {
                    return self.kill(i);
                }
                self.draw_heat(s);
                let b = self.walk(s);
                if self.phase & 1 != 0 && b < 0x7c {
                    self.set(s, B, b + 3);
                }
            }
            // Temporary 0x2b: A += 7 folds into a triangle that, with D,
            // picks sine steps.
            0x2b => {
                self.set(s, C, self.get(s, C) - 1);
                if self.get(s, C) == 0xff {
                    return self.kill(i);
                }
                self.draw_heat(s);
                self.set(s, A, self.get(s, A) + 7);
                let mut fold = self.get(s, A) & 0x7f;
                if fold > 0x3f {
                    fold = 0x7f - fold;
                }
                let angle = ((self.get(s, D) + fold) & 255) as usize;
                let dy = signed(self.g.sine[(angle + 0x40) & 255].wrapping_sub(0x7f));
                let dx = signed(self.g.sine[angle].wrapping_sub(0x7f));
                self.walk_by(s, dx, dy);
            }
            // 0x1f and above 0x2b: the loop's continue.
            _ => {}
        }
    }
}

/// One row of the fire stencil, `out[x] = T[a[x-1] + a[x] + a[x+1] + b[x]]`
/// with the columns wrapping (the edges apart, so the interior carries no
/// wrap test).
#[inline(always)]
fn fire_row(out: &mut [u8], a: &[u8], b: &[u8], rt: &[u8; 1028]) {
    let w = out.len();
    let tap = |l: u8, c: u8, r: u8, d: u8| rt[l as usize + c as usize + r as usize + d as usize];
    out[0] = tap(a[w - 1], a[0], a[1], b[0]);
    for ((cell, window), &d) in out[1..w - 1].iter_mut().zip(a.windows(3)).zip(&b[1..w - 1]) {
        *cell = tap(window[0], window[1], window[2], d);
    }
    out[w - 1] = tap(a[w - 2], a[w - 1], a[0], b[w - 1]);
}

/// fireUpdateRising (0x10515cf0): in place, top row down, the last two rows
/// reading the first two as they were (`scratch`, 2·width bytes).
fn fire_update_rising(pixels: &mut [u8], rt: &[u8; 1028], w: usize, h: usize, scratch: &mut [u8]) {
    scratch[..2 * w].copy_from_slice(&pixels[..2 * w]);
    let top: &[u8] = scratch;
    for y in 0..h {
        let (head, tail) = pixels.split_at_mut((y + 1) * w);
        let below = if y + 1 < h { &tail[..w] } else { &top[(y + 1 - h) * w..(y + 2 - h) * w] };
        let below2 = if y + 2 < h { &tail[w..2 * w] } else { &top[(y + 2 - h) * w..(y + 3 - h) * w] };
        fire_row(&mut head[y * w..], below, below2, rt);
    }
}

/// fireUpdateStill (0x10515f30): each row from its old values and the old
/// row below, the last row reading the first as it was (`scratch`: the
/// first row, then the current row's copy).
fn fire_update_still(pixels: &mut [u8], rt: &[u8; 1028], w: usize, h: usize, scratch: &mut [u8]) {
    let (first, row) = scratch.split_at_mut(w);
    first.copy_from_slice(&pixels[..w]);
    let row = &mut row[..w];
    for y in 0..h {
        let base = y * w;
        row.copy_from_slice(&pixels[base..base + w]);
        let (head, tail) = pixels.split_at_mut(base + w);
        let below: &[u8] = if y + 1 < h { &tail[..w] } else { first };
        fire_row(&mut head[base..], row, below, rt);
    }
}

/// fireConstantTimeTick (0x10507ff0) for the texture whose header is at
/// `header`: RedrawSparks, the fire update, PostDrawSparks.
#[no_mangle]
pub extern "C" fn fire_tick(header: u32) {
    let h = unsafe { core::slice::from_raw_parts_mut(header as usize as *mut u32, FIRE_WORDS) };
    let (w, v) = (h[F_U_SIZE] as i32, h[F_V_SIZE] as i32);
    if w < 8 || v < 8 {
        return;
    }
    let (w, v) = (w as usize, v as usize);
    unsafe {
        let mut fire = Fire {
            g: &mut *(h[F_GLOBALS] as usize as *mut Globals),
            sp: bytes(h[F_SPARKS], h[F_SPARKS_LENGTH] as usize),
            px: bytes(h[F_PIXELS], w * v),
            bits: h[F_U_BITS],
            um: h[F_U_MASK] as i32,
            vm: h[F_V_MASK] as i32,
            active: h[F_ACTIVE] as i32,
            limit: h[F_SPARKS_LIMIT] as i32,
            phase: (h[F_GLOBAL_PHASE] as i32).wrapping_add(1),
        };
        // RedrawSparks (0x105025b0): AuxPhase += FX_Frequency, GlobalPhase++,
        // then each active spark, re-reading the count (a killed spark's
        // replacement waits for the next tick).
        h[F_AUX_PHASE] = (h[F_AUX_PHASE].wrapping_add(h[F_FX_FREQUENCY])) & 255;
        h[F_GLOBAL_PHASE] = fire.phase as u32;
        let mut i = 0;
        while (i as i32) < fire.active {
            let ty = fire.sp[i * 8];
            fire.spark(i, ty);
            i += 1;
        }
        h[F_ACTIVE] = fire.active as u32;
        let (sparks, active, bits) = (fire.sp, fire.active, fire.bits);
        let pixels = fire.px;
        let rt = &*(h[F_RENDER_TABLE] as usize as *const [u8; 1028]);
        let scratch = bytes(h[F_SCRATCH], 2 * w);
        if h[F_B_RISING] & 1 != 0 {
            fire_update_rising(pixels, rt, w, v, scratch);
        } else {
            fire_update_still(pixels, rt, w, v, scratch);
        }
        // PostDrawSparks (0x10505930): a Stars spark keeps the pixel under
        // it in B and, below 0x26, writes its A there (a pixel past the
        // buffer reads 0 and is not written).
        if h[F_STAR_STATUS] != 0 {
            let mut found = false;
            for s in (0..active.max(0) as usize).map(|i| i * 8) {
                if sparks[s] != 0x16 {
                    continue;
                }
                found = true;
                let p = ((sparks[s + Y] as u32).wrapping_shl(bits) + sparks[s + X] as u32) as usize;
                match pixels.get(p).copied() {
                    Some(pixel) => {
                        sparks[s + B] = pixel;
                        if pixel < 0x26 {
                            pixels[p] = sparks[s + A];
                        }
                    }
                    None => sparks[s + B] = 0,
                }
            }
            if !found {
                h[F_STAR_STATUS] = 0;
            }
        }
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
