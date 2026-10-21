//! URender::DrawLodMesh's distance LOD (Render.dll 607f1077…;
//! docs/script-lodmesh-lod.md), the port of src/runtime/lodmesh-lod.mjs:
//! the selection 0x10b0eb52..0x10b0ed53, the post-frame morph
//! 0x10b0ee34..0x10b0ef6e and the corner selection 0x10b0fc6f..0x10b0fe60
//! (full resolution 0x10b10123..0x10b101e8).
//!
//! Precision control 24 (docs/render-pass-precision.md): values are f64
//! holding 24-bit significands with the x87's wide exponent; `r24` rounds an
//! operation of two such values (the double result's rounding is innocuous,
//! 53 >= 2·24 + 2), `r24_prod`/`r24_sum` an operation with a double constant
//! (the exact result rounded once), and `as f32` stores a float.
use crate::WORK;
use std::cell::RefCell;

const MIN_NORMAL: f64 = 1.1754943508222875e-38; // 2^-126
const MAX_F32: f64 = 3.4028234663852886e38;

/// A finite double rounded to a 24-bit significand, nearest-even, with the
/// x87's exponent range (x87-pc24.mjs `r24`).
fn r24(x: f64) -> f64 {
    let a = x.abs();
    if (MIN_NORMAL..=MAX_F32).contains(&a) {
        return x as f32 as f64;
    }
    if x == 0.0 || !x.is_finite() || a < f64::MIN_POSITIVE {
        return x;
    }
    // An exact power of two scales the value into binary32's range.
    let k = ((a.to_bits() >> 52) as i32) - 1023;
    let scale = f64::from_bits(((1023 - k) as u64) << 52);
    (x * scale) as f32 as f64 / scale
}

/// r24 of the exact value s + e (s the double nearest it, |e| at most half
/// an ulp of s): r24(s) unless s is a 24-bit rounding midpoint.
fn r24_split(s: f64, e: f64) -> f64 {
    let r = r24(s);
    if e == 0.0 || r == s || !s.is_finite() {
        return r;
    }
    let other = 2.0 * s - r;
    if other == r || r24(other) != other {
        return r;
    }
    if e > 0.0 {
        r.max(other)
    } else {
        r.min(other)
    }
}

/// The exact sum of two doubles rounded once to 24 bits (TwoSum).
pub(crate) fn r24_sum(a: f64, b: f64) -> f64 {
    let s = a + b;
    let t = s - a;
    let e = (a - (s - t)) + (b - t);
    r24_split(s, e)
}

/// The exact product of two doubles rounded once to 24 bits (Dekker).
fn r24_prod(a: f64, b: f64) -> f64 {
    let p = a * b;
    if !p.is_finite() || p == 0.0 {
        return r24(p);
    }
    let split = |x: f64| {
        let c = 134_217_729.0 * x;
        let h = c - (c - x);
        (h, x - h)
    };
    let ((ah, al), (bh, bl)) = (split(a), split(b));
    let e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
    r24_split(p, e)
}

/// FISTP under round-to-nearest: nearest-even, or the integer indefinite.
fn fistp(x: f64) -> i32 {
    if !x.is_finite() {
        return i32::MIN;
    }
    let lo = x.floor();
    let fraction = x - lo;
    let result = if fraction < 0.5 {
        lo
    } else if fraction > 0.5 || (lo as i64) & 1 != 0 {
        lo + 1.0
    } else {
        lo
    };
    if result >= i32::MIN as f64 && result <= i32::MAX as f64 {
        result as i32
    } else {
        i32::MIN
    }
}

fn float(word: u32) -> f64 {
    f32::from_bits(word) as f64
}
fn store(value: f64) -> u32 {
    (value as f32).to_bits()
}

/// The selection's word layout in WORK (see `lod_select`).
pub const SELECT_IN: usize = 30;
pub const SELECT_OUT: usize = 8;

/// DrawLodMesh's selection on WORK[0..30], results in WORK[30..38]:
/// in  0 ModelVerts, 1 LODStrength bits, 2 CollapsePointThus.Num,
///     3 MeshScaleMax, 4 LODMinVerts, 5 LODMorph, 6 LODZDisplace,
///     7..11 URender +40 +44 +48 (int) +4c, 11..14 Actor.Location,
///     14 DrawScale, 15 LODBias, 16..28 FCoords (Origin, X, Y, Z),
///     28 FSceneNode +b8 (FX), 29 the stored appTan float;
/// out 0 detail bits, 1 requested count, 2 LOD flag, 3 morph flag,
///     4..7 the transformed Location, 7 status (1: no integer count).
#[no_mangle]
#[allow(clippy::neg_cmp_op_on_partial_ord)]
pub extern "C" fn lod_select() {
    WORK.with_borrow_mut(|work| {
        assert!(work.len() >= SELECT_IN + SELECT_OUT);
        let (input, out) = work.split_at_mut(SELECT_IN);
        let n = input[0] as i32;
        out[..SELECT_OUT].fill(0);
        out[0] = (n as f32).to_bits();
        out[1] = n as u32;
        if input[1] == 0 || input[2] == 0 {
            return;
        }
        out[2] = 1;
        let mode = input[9] as i32;
        out[3] = u32::from(mode & 1 != 0 && float(input[5]) > 0.0);
        let tan = if mode >= 3 { 1.0 } else { float(input[29]) };
        let complexity = r24(r24_prod(n as f64, 0.003f32 as f64) + 0.25) as f32 as f64;
        let screen = r24_sum(r24_prod(float(input[28]), 0.0010937499999999999), 0.3) as f32 as f64;
        let c: [f64; 12] = std::array::from_fn(|i| float(input[16 + i]));
        let d: [f64; 3] = std::array::from_fn(|i| r24(float(input[11 + i]) - c[i]));
        let axis = |row: usize| store(r24(r24(r24(d[0] * c[row]) + r24(d[1] * c[row + 1])) + r24(d[2] * c[row + 2])));
        out[4] = axis(3);
        out[5] = axis(6);
        out[6] = axis(9);
        let mut depth = r24(float(out[6]) - float(input[6]));
        if !(1.0 < depth) && !depth.is_nan() {
            depth = 1.0;
        }
        let mut den = r24(float(input[8]) * float(input[7]));
        den = r24(den * float(input[1]));
        den = r24(depth * den);
        den = r24(den * complexity);
        den = r24(den * tan);
        let mut num = r24(float(input[3]) * float(input[14]));
        num = r24(num * float(input[15]));
        num = r24(num * screen);
        num = r24(num * 430.0);
        let mut ratio = r24(num / den);
        if mode == 0 {
            let fix = float(input[10]);
            ratio = if fix == 0.0 || fix.is_nan() { 1.0 } else { fix };
        }
        let scaled = r24_prod(ratio, n as f64);
        let minimum = input[4] as i32;
        let detail = if (minimum as f64) < scaled || scaled.is_nan() { scaled as f32 } else { minimum as f32 };
        out[0] = detail.to_bits();
        let rounded = fistp(detail as f64);
        if rounded == i32::MIN {
            out[7] = 1;
            return;
        }
        out[1] = rounded.min(n) as u32;
    });
}

struct LodMesh {
    collapse_points: Vec<u32>,
    face_level: Vec<u32>,
    faces: Vec<u32>,
    collapse_wedges: Vec<u32>,
    wedges: Vec<u32>,
}
thread_local! { static LOD_MESHES: RefCell<Vec<Option<LodMesh>>> = const { RefCell::new(Vec::new()) }; }

/// Upload a mesh's LOD arrays from WORK, one word per element:
/// CollapsePointThus (`points`), FaceLevel (`faces`), three wedges per face,
/// CollapseWedgeThus (`wedges`) and the Wedges dwords (`wedges`).
#[no_mangle]
pub extern "C" fn upload_lod_mesh(points: usize, faces: usize, wedges: usize) -> u32 {
    WORK.with_borrow(|work| {
        let mut at = 0;
        let mut take = |count: usize| {
            let slice = work[at..at + count].to_vec();
            at += count;
            slice
        };
        let mesh = LodMesh {
            collapse_points: take(points),
            face_level: take(faces),
            faces: take(faces * 3),
            collapse_wedges: take(wedges),
            wedges: take(wedges),
        };
        LOD_MESHES.with_borrow_mut(|meshes| {
            if let Some(handle) = meshes.iter().position(Option::is_none) {
                meshes[handle] = Some(mesh);
                handle as u32
            } else {
                meshes.push(Some(mesh));
                (meshes.len() - 1) as u32
            }
        })
    })
}

#[no_mangle]
pub extern "C" fn release_lod_mesh(handle: u32) {
    LOD_MESHES.with_borrow_mut(|meshes| {
        if let Some(mesh) = meshes.get_mut(handle as usize) {
            *mesh = None;
        }
    });
}

/// The post-frame range on WORK: ordinary vertex `i`'s floats at
/// `positions + i·stride` (x, y, z words) and its alpha at `alphas + i·alpha_stride`.
/// `flags` bit 0 the LOD flag, bit 1 the morph flag. Returns the final flags
/// in bits 0..2 and the morph start above them (start << 2).
#[no_mangle]
#[allow(clippy::too_many_arguments, clippy::neg_cmp_op_on_partial_ord)]
pub extern "C" fn lod_morph(
    handle: u32,
    model_verts: i32,
    lod_morph_bits: u32,
    detail_bits: u32,
    flags: u32,
    count: i32,
    positions: usize,
    stride: usize,
    alphas: usize,
    alpha_stride: usize,
) -> u32 {
    let mut active = flags & 1 != 0;
    let mut morph = flags & 2 != 0;
    let mut start = 0i32;
    if morph {
        let lod_morph = float(lod_morph_bits);
        let detail = float(detail_bits);
        start = fistp(r24(r24(1.0 - lod_morph) * detail) as f32 as f64);
        if start >= count {
            morph = false;
        } else {
            let inverse = r24(1.0 / r24(detail * lod_morph));
            LOD_MESHES.with_borrow(|meshes| {
                let mesh = meshes.get(handle as usize).and_then(Option::as_ref).expect("invalid LOD mesh handle");
                WORK.with_borrow_mut(|work| {
                    let mut i = count - 1;
                    while i > start {
                        let mut alpha = r24((i - start) as f64 * inverse);
                        if !(1.0 > alpha) {
                            alpha = 1.0;
                        }
                        let at = alphas + i as usize * alpha_stride;
                        let target = mesh.collapse_points[i as usize] as usize;
                        if target == 0 {
                            work[at] = 0;
                        } else {
                            let v = positions + i as usize * stride;
                            let t = positions + target * stride;
                            let dx = r24(float(work[t]) - float(work[v]));
                            let dy = r24(float(work[t + 1]) - float(work[v + 1])) as f32 as f64;
                            let dz = r24(float(work[t + 2]) - float(work[v + 2])) as f32 as f64;
                            let px = r24(dx * alpha);
                            let py = r24(dy * alpha) as f32 as f64;
                            let pz = r24(dz * alpha) as f32 as f64;
                            work[v] = store(r24(px + float(work[v])));
                            work[v + 1] = store(r24(py + float(work[v + 1])));
                            work[v + 2] = store(r24(pz + float(work[v + 2])));
                            work[at] = store(alpha);
                        }
                        i -= 1;
                    }
                });
            });
        }
    }
    if !morph && count >= model_verts {
        active = false;
    }
    u32::from(active) | (u32::from(morph) << 1) | ((start as u32) << 2)
}

/// The corner selection on WORK: `flags` bit 0 the LOD flag, bit 1 morph;
/// alphas as in `lod_morph`. Writes three ordinary vertex words per face at
/// `faces_out` (0xffffffff three times for a face above the count) and the
/// packed wedge dwords at `scratch` (Wedges.Num words, cleared here).
/// Returns 0, or 1 when a wedge never collapses below the count.
#[no_mangle]
pub extern "C" fn lod_corners(
    handle: u32,
    flags: u32,
    start: i32,
    count: i32,
    alphas: usize,
    alpha_stride: usize,
    faces_out: usize,
    scratch: usize,
) -> u32 {
    LOD_MESHES.with_borrow(|meshes| {
        let mesh = meshes.get(handle as usize).and_then(Option::as_ref).expect("invalid LOD mesh handle");
        WORK.with_borrow_mut(|work| {
            let face_count = mesh.face_level.len();
            let wedge_count = mesh.wedges.len();
            work[scratch..scratch + wedge_count].fill(0);
            if flags & 1 == 0 {
                for i in 0..face_count {
                    for j in 0..3 {
                        let w = mesh.faces[i * 3 + j] as usize;
                        let packed = mesh.wedges[w];
                        work[scratch + w] = packed;
                        work[faces_out + i * 3 + j] = packed & 0xffff;
                    }
                }
                return 0;
            }
            if count <= 0 {
                return 1;
            }
            let morph = flags & 2 != 0;
            for i in 0..face_count {
                let out = faces_out + i * 3;
                if mesh.face_level[i] as i32 > count {
                    work[out..out + 3].fill(u32::MAX);
                    continue;
                }
                for j in 0..3 {
                    let w = mesh.faces[i * 3 + j] as usize;
                    let mut packed = work[scratch + w];
                    if packed == 0 {
                        let mut at = w;
                        packed = mesh.wedges[at];
                        let mut steps = 0;
                        while (packed & 0xffff) as i32 >= count {
                            at = mesh.collapse_wedges[at] as usize;
                            packed = mesh.wedges[at];
                            steps += 1;
                            if steps > wedge_count {
                                return 1;
                            }
                        }
                        let vertex = packed & 0xffff;
                        if morph && vertex as i32 > start {
                            let alpha = work[alphas + vertex as usize * alpha_stride];
                            let next = mesh.collapse_wedges[at] as usize;
                            if alpha != 0 && next != at {
                                let other = mesh.wedges[next];
                                let (u, v) = ((packed >> 16) & 255, packed >> 24);
                                let (nu, nv) = ((other >> 16) & 255, other >> 24);
                                if u != nu || v != nv {
                                    let a = float(alpha);
                                    let lerp = |from: u32, to: u32| {
                                        let value = r24(r24((to as f64 - from as f64) * a) + from as f64) as f32 as f64;
                                        (fistp(value) as u32) & 255
                                    };
                                    packed = vertex | (lerp(u, nu) << 16) | (lerp(v, nv) << 24);
                                }
                            }
                        }
                        work[scratch + w] = packed;
                    }
                    work[out + j] = packed & 0xffff;
                }
            }
            0
        })
    })
}
