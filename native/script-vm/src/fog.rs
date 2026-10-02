//! Render.dll volumetric fog maps (docs/volumetric-fog.md): SetupForSurf's
//! per-light fog loop 0x10b073bb-0x10b07c44 on the exact x87 model. The
//! Rust counterpart of src/runtime/volumetric-fog.mjs `fogMap`, which matches
//! the original (validate-volumetric-fog.mjs); validate-volumetric-fog-rust
//! compares the two. JavaScript prepares the per-light constants and colour
//! tables (`volumetricLight`) and the camera-space grid; this loop is the
//! per-texel work.
use crate::x87::Ext;

const MAX_LIGHTS: usize = 32;
const MAX_TEXELS: usize = 1 << 16;
/// Per light: location x, y, z; R²; 1/R; 1/R²; |L|²; brightness; inside.
const LIGHT_WORDS: usize = 9;

static mut SQRT: [u32; 2048] = [0; 2048];
static mut LIGHTS: [u32; MAX_LIGHTS * LIGHT_WORDS] = [0; MAX_LIGHTS * LIGHT_WORDS];
static mut TABLES: [u8; MAX_LIGHTS * 1024] = [0; MAX_LIGHTS * 1024];
/// Camera-space grid: base, U step, V step (float bits).
static mut GRID: [u32; 9] = [0; 9];
static mut OUT: [u8; MAX_TEXELS * 4] = [0; MAX_TEXELS * 4];
/// The early-out flag 0x10b4ea00, persisting across surfaces like the
/// original global.
static mut MISS: u32 = 0;

const F_ZERO: u32 = 0;
const F_ONE: u32 = 0x3f80_0000;
const F_THREE: u32 = 0x4040_0000;
const F_255: u32 = 0x437f_0000;

fn ld(bits: u32) -> Ext {
    Ext::load(bits)
}
fn sub(a: Ext, b: Ext) -> Ext {
    a.add(b.neg())
}
/// FCOM's C0: below or unordered.
fn below(a: Ext, b: Ext) -> bool {
    a.compare(b).0
}
fn greater(a: Ext, b: Ext) -> bool {
    let (c0, c3) = a.compare(b);
    !c0 && !c3
}
/// The light manager's table square root (dynamic-lighting.mjs tableSqrt).
fn table_sqrt(bits: u32) -> u32 {
    unsafe { (*core::ptr::addr_of!(SQRT))[((bits >> 13) & 0x7ff) as usize].wrapping_add((bits & 0x7f00_0000) >> 1) }
}
/// FISTP of a stored float under round-to-nearest-even (values 0..255 here;
/// dynamic-lighting.mjs fistp).
fn fistp(bits: u32) -> i32 {
    let v = f32::from_bits(bits) as f64;
    let t = v as i64 as f64;
    let floor = if t > v { t - 1.0 } else { t };
    let fraction = v - floor;
    let floor = floor as i32;
    if fraction > 0.5 || (fraction == 0.5 && floor & 1 != 0) {
        floor + 1
    } else {
        floor
    }
}

/// One texel's colour-table index, or -1 for a later light's skip.
fn texel_index(light: &[u32], px: u32, py: u32, pz: u32, first: bool, miss: &mut u32) -> i32 {
    let none = if first { 0 } else { -1 };
    let (lx, ly, lz) = (light[0], light[1], light[2]);
    let (radius_sq, inv_r, inv_r2, distance_sq, brightness, inside) =
        (light[3], light[4], light[5], light[6], light[7], light[8]);
    let dot = ld(pz).mul(ld(lz)).add(ld(py).mul(ld(ly))).add(ld(px).mul(ld(lx))).store();
    if inside == 0 && dot >= 0x8000_0000 {
        return none;
    }
    let pp = ld(px).mul(ld(px)).add(ld(pz).mul(ld(pz))).add(ld(py).mul(ld(py)));
    let dd = ld(dot).mul(ld(dot));
    if *miss != 0 && greater(sub(pp.mul(ld(distance_sq)), dd), pp.mul(ld(radius_sq))) {
        return none;
    }
    let h2 = sub(ld(distance_sq), dd.div(pp)).store();
    if below(ld(radius_sq), ld(h2)) {
        *miss = 1;
        return none;
    }
    *miss = 0;
    let length = table_sqrt(pp.store());
    let t = ld(dot).div(ld(length)).store();
    let w = table_sqrt(sub(ld(radius_sq), ld(h2)).store());
    let mut s = sub(ld(t), ld(length)).store();
    let neg_w = w ^ 0x8000_0000;
    let mut clamped = false;
    let far;
    if greater(ld(t), ld(w)) {
        if below(ld(s), ld(neg_w)) {
            s = neg_w;
            clamped = true;
        }
        far = w;
    } else {
        if below(ld(s), ld(neg_w)) {
            s = neg_w;
        }
        far = t;
    }
    if !below(ld(s), ld(far)) {
        return none;
    }
    let hn = ld(h2).mul(ld(inv_r2)).store();
    let a = ld(far).mul(ld(inv_r));
    let c = sub(ld(F_THREE), ld(hn).mul(ld(F_THREE)));
    let mut v = if clamped {
        let p = sub(c, a.mul(a)).mul(a).mul(ld(brightness));
        p.add(p)
    } else {
        let b = ld(s).mul(ld(inv_r));
        let outer = a.mul(sub(c, a.mul(a)));
        sub(outer, sub(c, b.mul(b)).mul(b)).mul(ld(brightness))
    };
    if below(v, ld(F_ZERO)) {
        return none;
    }
    if v.store() >= F_ONE {
        v = ld(F_ONE);
    }
    if first {
        return fistp(v.mul(ld(F_255)).store());
    }
    let vf = v.store();
    if vf == 0 {
        return -1;
    }
    fistp(ld(vf).mul(ld(F_255)).store())
}

#[no_mangle]
pub extern "C" fn fog_sqrt_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(SQRT) as *mut u32
}
#[no_mangle]
pub extern "C" fn fog_lights_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(LIGHTS) as *mut u32
}
#[no_mangle]
pub extern "C" fn fog_tables_ptr() -> *mut u8 {
    core::ptr::addr_of_mut!(TABLES) as *mut u8
}
#[no_mangle]
pub extern "C" fn fog_grid_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(GRID) as *mut u32
}
#[no_mangle]
pub extern "C" fn fog_out_ptr() -> *const u8 {
    core::ptr::addr_of!(OUT) as *const u8
}
#[no_mangle]
pub extern "C" fn fog_miss() -> u32 {
    unsafe { MISS }
}
#[no_mangle]
pub extern "C" fn fog_set_miss(value: u32) {
    unsafe { MISS = value }
}

/// The fog loop for `count` lights already in depth order: BGRA texels at
/// OUT in rows of `width`. Returns 0 when the surface or light count is
/// larger than the static buffers.
#[no_mangle]
pub extern "C" fn fog_map(width: u32, height: u32, count: u32) -> u32 {
    let (width, height, count) = (width as usize, height as usize, count as usize);
    if width * height > MAX_TEXELS || count > MAX_LIGHTS || count == 0 {
        return 0;
    }
    unsafe {
        let lights = &*core::ptr::addr_of!(LIGHTS);
        let tables = &*core::ptr::addr_of!(TABLES);
        let grid = &*core::ptr::addr_of!(GRID);
        let out = &mut *core::ptr::addr_of_mut!(OUT);
        let mut miss = MISS;
        let attenuation = |a: usize, v: usize| ((127 - a) * v / 127) as u8;
        for (k, light) in lights.chunks(LIGHT_WORDS).take(count).enumerate() {
            let first = k == 0;
            let table = &tables[k * 1024..k * 1024 + 1024];
            let (mut rx, mut ry, mut rz) = (f32::from_bits(grid[0]), f32::from_bits(grid[1]), f32::from_bits(grid[2]));
            let (ux, uy, uz) = (f32::from_bits(grid[3]), f32::from_bits(grid[4]), f32::from_bits(grid[5]));
            let (vx, vy, vz) = (f32::from_bits(grid[6]), f32::from_bits(grid[7]), f32::from_bits(grid[8]));
            for v in 0..height {
                let (mut px, mut py, mut pz) = (rx, ry, rz);
                for u in 0..width {
                    let index = texel_index(light, px.to_bits(), py.to_bits(), pz.to_bits(), first, &mut miss);
                    let at = (v * width + u) * 4;
                    if first {
                        let i = index as usize * 4;
                        out[at..at + 4].copy_from_slice(&table[i..i + 4]);
                    } else if index >= 0 {
                        let i = index as usize * 4;
                        let alpha = table[i + 3] as usize;
                        for c in 0..3 {
                            out[at + c] = (attenuation(alpha, out[at + c] as usize) as u32 + table[i + c] as u32).min(127) as u8;
                        }
                        out[at + 3] = (out[at + 3] as u32 + alpha as u32).min(127) as u8;
                    }
                    px = ux + px;
                    py = uy + py;
                    pz = pz + uz;
                }
                rx = vx + rx;
                ry = ry + vy;
                rz = rz + vz;
            }
        }
        MISS = miss;
    }
    1
}
