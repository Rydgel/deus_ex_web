//! Original GetFrame vertex loops and DrawLodMesh lighting; see
//! docs/lodmesh-wasm.md for native evidence. Both run inside the render pass,
//! under x87 precision control 24 (docs/render-pass-precision.md): every
//! operation rounds to a 24-bit significand, which for float and int16
//! operands is one binary32 operation; the `Ext` model with `round24` covers
//! the operands binary32 cannot (non-finite values, results outside its
//! normal range).
use std::cell::RefCell;

mod lod;

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

    /// The register value under precision control 24: the significand
    /// rounded to 24 bits, nearest-even, the exponent kept. After an add,
    /// subtract or multiply of 24-bit operands (64 >= 2*24 + 2) this is the
    /// PC 24 result.
    fn round24(self) -> Self {
        if self.special != 0 || self.sig == 0 {
            return self;
        }
        Self::normalized(round_right(self.sig as u128, 40), self.exp + 40, self.sign)
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
// light_mesh_job's per-call scratch: light records and per-vertex diffuse bytes.
type LightScratch = (Vec<[f32; 7]>, Vec<Option<[u32; 3]>>);
thread_local! { static LIGHT_SCRATCH: RefCell<LightScratch> = const { RefCell::new((Vec::new(), Vec::new())) }; }
thread_local! { static LIGHT_TABLES: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) }; }
thread_local! { static LIGHT_MESHES: RefCell<Vec<Option<Vec<u32>>>> = const { RefCell::new(Vec::new()) }; }

const SQRT_WORDS: usize = 2048;
const RSQRT_EXPONENT_WORDS: usize = 512;
const RSQRT_MANTISSA_WORDS: usize = 1024;
const LIGHT_TABLE_WORDS: usize = SQRT_WORDS + RSQRT_EXPONENT_WORDS + RSQRT_MANTISSA_WORDS;

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

/// Copy the original renderer's validated square-root and reciprocal-root
/// table bits from WORK into kernel-owned storage.  JavaScript generates these
/// once with the same table builders used by its reference path.
#[no_mangle]
pub extern "C" fn init_lighting() {
    WORK.with_borrow(|work| {
        assert!(work.len() >= LIGHT_TABLE_WORDS);
        LIGHT_TABLES.with_borrow_mut(|tables| {
            tables.clear();
            tables.extend_from_slice(&work[..LIGHT_TABLE_WORDS]);
        });
    });
}

fn table_sqrt(value: f32, tables: &[u32]) -> f32 {
    let bits = value.to_bits();
    let entry = tables[((bits >> 13) & 0x7ff) as usize];
    f32::from_bits(entry.wrapping_add((bits & 0x7f000000) >> 1))
}

fn table_rsqrt(value: f32, tables: &[u32]) -> f32 {
    let bits = value.to_bits();
    let exponent = f32::from_bits(tables[SQRT_WORDS + (bits >> 23) as usize]);
    let mantissa =
        f32::from_bits(tables[SQRT_WORDS + RSQRT_EXPONENT_WORDS + ((bits >> 13) & 0x3ff) as usize]);
    mantissa * exponent
}

fn nearest_even(value: f32) -> i64 {
    if !value.is_finite() {
        return 0;
    }
    let value = value as f64;
    let floor = value.floor();
    let fraction = value - floor;
    if fraction < 0.5 {
        floor as i64
    } else if fraction > 0.5 || (floor as i64) & 1 != 0 {
        floor as i64 + 1
    } else {
        floor as i64
    }
}

fn diffuse_channel(value: f32) -> f32 {
    let inverse = (1.0f64 / 255.0) as f32;
    let scale = (255.0f64 * inverse as f64) as f32;
    let input = (value as f64 * scale as f64 * 255.0) as f32;
    (nearest_even(input) as u32 & 255) as f32 / 255.0
}

/// TransformPointBy at the render pass's 24 bits, the order of
/// ComputeFromActor's camera-space location (0x10b06035-0x10b06095) and
/// mesh-lighting-view.mjs `toCamera`: `(d.x·A.x + d.y·A.y) + d.z·A.z` with
/// d = P − Origin, each operation one binary32 rounding.
fn camera_component(point: [f32; 3], origin: [f32; 3], axis: [f32; 3]) -> f32 {
    let dx = point[0] - origin[0];
    let dy = point[1] - origin[1];
    let dz = point[2] - origin[2];
    (dx * axis[0] + dy * axis[1]) + dz * axis[2]
}

/// The 24-bit rounding of the exact product of a float and a double
/// (precision control 24 with a double operand, such as ScaleGlow·1.4):
/// Dekker's two-product, then the f32 rounding with the error deciding a
/// rounding midpoint (x87-pc24.mjs r24prod). Finite normal-range results.
fn r24_product(a: f32, b: f64) -> f32 {
    let a = a as f64;
    let p = a * b;
    let split = |x: f64| {
        let c = 134_217_729.0 * x;
        let h = c - (c - x);
        (h, x - h)
    };
    let ((ah, al), (bh, bl)) = (split(a), split(b));
    let e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
    let r = p as f32 as f64;
    if e == 0.0 || r == p || !p.is_finite() {
        return r as f32;
    }
    let other = 2.0 * p - r;
    if other == r || other as f32 as f64 != other {
        return r as f32;
    }
    (if e > 0.0 { r.max(other) } else { r.min(other) }) as f32
}

/// FLightManager::Light (0x10b027f0) at the render pass's precision control
/// 24 (mesh-lighting.mjs `lightVertex`): every operation is one binary32
/// operation; `glow` is ScaleGlow·1.4 rounded once from the exact product.
// `!(x > 0.0)` deliberately treats NaN like a non-positive factor.
#[allow(clippy::too_many_arguments, clippy::neg_cmp_op_on_partial_ord)]
fn light_vertex(
    lights: &[[f32; 7]],
    point: [f32; 3],
    plane: [f32; 4],
    flags: u32,
    ambient: [f32; 3],
    glow: f32,
    tables: &[u32],
) -> [f32; 3] {
    let [px, py, pz] = point;
    let [nx, ny, nz, nw] = plane;
    let (mut r, mut g, mut b) = if flags & 0x400000 != 0 {
        (0.5f32, 0.5f32, 0.5f32)
    } else {
        (0.0f32, 0.0f32, 0.0f32)
    };
    if flags & 0x400000 == 0 {
        let p2 = (px * px + py * py) + pz * pz;
        for &[lx, ly, lz, rradius, cr, cg, cb] in lights {
            let dz = lz - pz;
            let dy = ly - py;
            let dx = lx - px;
            let dist2 = (dx * dx + dy * dy) + dz * dz;
            let dist = table_sqrt(dist2, tables);
            // amount = total * factor below; total is >= 0, +inf or NaN, so a
            // factor that is not positive leaves amount > 0 false.
            let factor = 1.0 - dist * rradius;
            if !(factor > 0.0) {
                continue;
            }
            let c = ((dy * ny + dz * nz) + dx * nx) / dist + 1.0;
            let mut diffuse = c * c - 1.5;
            if !(diffuse >= 0.0) {
                diffuse = 0.0;
            }
            let plane_dot = ((lz * nz + ly * ny) + lx * nx) - nw;
            let s2 = plane_dot + plane_dot;
            let rx = lx - s2 * nx;
            let ry = ly - s2 * ny;
            let rz = lz - s2 * nz;
            let specular = ((rx * px + rz * pz) + ry * py) - p2;
            let total = if specular > 0.0 { (specular * specular * 6.0) / (dist2 * p2) + diffuse } else { diffuse };
            let amount = total * factor;
            if amount > 0.0 {
                r = amount * cr + r;
                g = amount * cg + g;
                b = amount * cb + b;
            }
        }
    }
    let finish = |value: f32| if value > 1.0 { 1.0 } else { value };
    [finish(r * glow + ambient[0]), finish(g * glow + ambient[1]), finish(glow * b + ambient[2])]
}

/// Upload immutable DrawLodMesh face indices and flags from the start of WORK.
/// Actor previews retain the returned handle for their lifetime, so the hot
/// path only crosses the Wasm boundary with posed points and dynamic lights.
#[no_mangle]
pub extern "C" fn upload_light_mesh(face_count: usize) -> u32 {
    WORK.with_borrow(|work| {
        let words = face_count.checked_mul(4).expect("face topology overflow");
        assert!(words <= work.len());
        let faces = work[..words].to_vec();
        LIGHT_MESHES.with_borrow_mut(|meshes| {
            if let Some(handle) = meshes.iter().position(Option::is_none) {
                meshes[handle] = Some(faces);
                handle as u32
            } else {
                let handle = meshes.len();
                meshes.push(Some(faces));
                handle as u32
            }
        })
    })
}

#[no_mangle]
pub extern "C" fn release_light_mesh(handle: u32) {
    LIGHT_MESHES.with_borrow_mut(|meshes| {
        if let Some(mesh) = meshes.get_mut(handle as usize) {
            *mesh = None;
        }
    });
}

#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn light_mesh_job(
    work: &mut [u32],
    tables: &[u32],
    faces: &[u32],
    vertex_count: usize,
    light_count: usize,
    flags: u32,
    origin: [f32; 3],
    axes: [[f32; 3]; 3],
    mirror: f32,
    ambient: [f32; 3],
    scale_glow: f32,
    unlit: [f32; 3],
    points_at: usize,
    lights_at: usize,
    scratch_at: usize,
    colors_at: usize,
) {
    const NORMAL_EPSILON: f32 = f32::from_bits(0x3a83126f);
    let face_count = faces.len() / 4;
    let camera_at = scratch_at;
    let normals_at = camera_at + vertex_count * 3;
    let lit_at = normals_at + vertex_count * 3;
    let drawn_at = lit_at + vertex_count;
    let vertex_light_at = drawn_at + face_count;
    assert!(vertex_light_at + vertex_count * 3 <= work.len());
    assert!(colors_at + face_count * 9 <= work.len());

    for i in 0..vertex_count {
        let point = std::array::from_fn(|axis| f32::from_bits(work[points_at + i * 3 + axis]));
        for axis in 0..3 {
            work[camera_at + i * 3 + axis] = camera_component(point, origin, axes[axis]).to_bits();
            work[normals_at + i * 3 + axis] = 0;
            work[vertex_light_at + i * 3 + axis] = 0;
        }
        work[lit_at + i] = 0;
    }
    for i in 0..face_count {
        work[drawn_at + i] = 0;
        let at = i * 4;
        let vertices = [
            faces[at] as usize,
            faces[at + 1] as usize,
            faces[at + 2] as usize,
        ];
        assert!(vertices.iter().all(|&vertex| vertex < vertex_count));
        let point = |vertex: usize| -> [f32; 3] {
            std::array::from_fn(|axis| f32::from_bits(work[camera_at + vertex * 3 + axis]))
        };
        let p0 = point(vertices[0]);
        let p1 = point(vertices[1]);
        let p2 = point(vertices[2]);
        // DrawLodMesh 0x10b0fe60-0x10b0ff85 at 24 bits (accumulateFaceNormal).
        let ax = p2[0] - p0[0];
        let ay = p2[1] - p0[1];
        let az = p2[2] - p0[2];
        let bz = p0[2] - p1[2];
        let by = p0[1] - p1[1];
        let bx = p0[0] - p1[0];
        let nz = bx * ay - by * ax;
        let ny = bz * ax - bx * az;
        let nx = by * az - bz * ay;
        let length = ((nx * nx + ny * ny) + nz * nz) + NORMAL_EPSILON;
        let scale = table_rsqrt(length, tables);
        let face = [nx * scale, ny * scale, nz * scale];
        for vertex in vertices {
            for axis in 0..3 {
                let old = f32::from_bits(work[normals_at + vertex * 3 + axis]);
                work[normals_at + vertex * 3 + axis] = (face[axis] + old).to_bits();
            }
        }
        let face_flags = faces[at + 3];
        // The back-face dot (0x10b0ffa3-0x10b0ffbb): (x + z) + y at 24 bits,
        // times Frame.Mirror (+0x20: 1.0 in the root frame, -1.0 in an
        // odd-depth mirror frame).
        let dot = ((face[0] * p0[0] + face[2] * p0[2]) + face[1] * p0[1]) * mirror;
        if face_flags & 1 == 0 && (face_flags & 0x100 != 0 || dot < 0.0) {
            work[drawn_at + i] = 1;
            for vertex in vertices {
                work[lit_at + vertex] = 1;
            }
        }
    }

    let glow = r24_product(scale_glow, 1.4);
    // Each light's seven words, read once for all vertices, into reused
    // scratch (a call allocates only when a mesh outgrows it).
    let (mut lights, mut converted) = LIGHT_SCRATCH.with_borrow_mut(|scratch| {
        (
            std::mem::take(&mut scratch.0),
            std::mem::take(&mut scratch.1),
        )
    });
    lights.clear();
    lights.extend(
        (0..light_count)
            .map(|light| std::array::from_fn(|k| f32::from_bits(work[lights_at + light * 7 + k]))),
    );
    for i in 0..vertex_count {
        if work[lit_at + i] == 0 {
            continue;
        }
        let point: [f32; 3] =
            std::array::from_fn(|axis| f32::from_bits(work[camera_at + i * 3 + axis]));
        let normal: [f32; 3] =
            std::array::from_fn(|axis| f32::from_bits(work[normals_at + i * 3 + axis]));
        // DrawLodMesh 0x10b10863-0x10b1090f at 24 bits (vertexNormalPlane).
        let length = ((normal[0] * normal[0] + normal[1] * normal[1]) + normal[2] * normal[2]) + NORMAL_EPSILON;
        let scale = table_rsqrt(length, tables);
        let n = normal.map(|value| scale * value);
        let plane = [n[0], n[1], n[2], (point[0] * n[0] + point[1] * n[1]) + point[2] * n[2]];
        let light = light_vertex(&lights, point, plane, flags, ambient, glow, tables);
        for axis in 0..3 {
            work[vertex_light_at + i * 3 + axis] = light[axis].to_bits();
        }
    }

    // A vertex's diffuse bytes depend only on its current light words, so
    // they are converted once and reused by every corner that shares the
    // vertex; an unlit overwrite below makes the vertex convert again.
    converted.clear();
    converted.resize(vertex_count, None);
    for i in 0..face_count {
        let at = i * 4;
        let vertices = [
            faces[at] as usize,
            faces[at + 1] as usize,
            faces[at + 2] as usize,
        ];
        let face_flags = faces[at + 3] | flags;
        if work[drawn_at + i] != 0 && face_flags & 0x400000 != 0 {
            for vertex in vertices {
                for axis in 0..3 {
                    work[vertex_light_at + vertex * 3 + axis] = unlit[axis].to_bits();
                }
                converted[vertex] = None;
            }
        }
        for (corner, vertex) in vertices.into_iter().enumerate() {
            let output = colors_at + i * 9 + corner * 3;
            if face_flags & 0x40 != 0 || work[lit_at + vertex] == 0 {
                work[output..output + 3].fill(1.0f32.to_bits());
            } else {
                let colors = *converted[vertex].get_or_insert_with(|| {
                    std::array::from_fn(|axis| {
                        let value = f32::from_bits(work[vertex_light_at + vertex * 3 + axis]);
                        diffuse_channel(value).to_bits()
                    })
                });
                work[output..output + 3].copy_from_slice(&colors);
            }
        }
    }
    LIGHT_SCRATCH.with_borrow_mut(|scratch| *scratch = (lights, converted));
}

/// Bulk DrawLodMesh face-normal, culling and vertex-light pass. Static face
/// topology is selected by `mesh_handle` and never recopied per frame.
#[no_mangle]
pub extern "C" fn light_mesh(
    mesh_handle: u32,
    vertex_count: usize,
    light_count: usize,
    flags: u32,
) {
    LIGHT_MESHES.with_borrow(|meshes| {
        let faces = meshes
            .get(mesh_handle as usize)
            .and_then(Option::as_deref)
            .expect("invalid mesh-lighting handle");
        let face_count = faces.len() / 4;
        LIGHT_TABLES.with_borrow(|tables| {
            assert_eq!(tables.len(), LIGHT_TABLE_WORDS);
            WORK.with_borrow_mut(|work| {
                let points_at = 20;
                let lights_at = points_at + vertex_count * 3;
                let scratch_at = lights_at + light_count * 7;
                let colors_at = scratch_at + vertex_count * 10 + face_count;
                let origin = [0, 1, 2].map(|i| f32::from_bits(work[i]));
                let axes = std::array::from_fn(|axis| {
                    std::array::from_fn(|component| f32::from_bits(work[4 + axis * 3 + component]))
                });
                // Word 3: the frame's Mirror (the lighting frame is the
                // child frame's when the actor is drawn in a mirror).
                let mirror = f32::from_bits(work[3]);
                let ambient = [13, 14, 15].map(|i| f32::from_bits(work[i]));
                let scale_glow = f32::from_bits(work[16]);
                let unlit = [17, 18, 19].map(|i| f32::from_bits(work[i]));
                light_mesh_job(
                    work,
                    tables,
                    faces,
                    vertex_count,
                    light_count,
                    flags,
                    origin,
                    axes,
                    mirror,
                    ambient,
                    scale_glow,
                    unlit,
                    points_at,
                    lights_at,
                    scratch_at,
                    colors_at,
                );
            });
        });
    });
}

fn vertex(work: &[u32], at: usize, axis: usize) -> u32 {
    let packed = work[at + axis / 2];
    (((packed >> ((axis % 2) * 16)) as i16) as f32).to_bits()
}

/// Word offsets of one `pose` call's scratch layout and its pass kind.
struct PoseLayout {
    first: usize,
    second: usize,
    base_frame: usize,
    cache: usize,
    output: usize,
    stride: usize,
    tween: bool,
    blend: bool,
}

/// A binary32 product as precision control 24 computes it: exact unless the
/// result left binary32's normal range (`bad`: an underflow, a nonzero
/// product at or below 2^-126 where the x87 keeps a normal 24-bit value, or
/// an overflow the x87's exponent would hold).
#[inline(always)]
fn mul24(a: f32, b: f32, bad: &mut bool) -> f32 {
    let r = a * b;
    *bad |= !r.is_finite() || (r.abs() <= f32::MIN_POSITIVE && a != 0.0 && b != 0.0);
    r
}

/// A binary32 sum: the exact sum of two 24-bit values in binary32's normal or
/// subnormal range is representable when it is below 2^-126, so only an
/// overflow can differ from precision control 24.
#[inline(always)]
fn add24(a: f32, b: f32, bad: &mut bool) -> f32 {
    let r = a + b;
    *bad |= !r.is_finite();
    r
}

/// One vertex of `pose` in binary32, GetFrame's loop at the render pass's
/// precision control 24 (docs/render-pass-precision.md): every operand is a
/// float or an int16 word, so each x87 operation is one binary32 operation.
/// Returns the cache words and output words, or None when an operand is not
/// finite or a result left binary32's range; `pose_ext24` then runs it.
#[inline(always)]
fn pose_single(
    work: &[u32],
    layout: &PoseLayout,
    i: usize,
    interpolate: bool,
    alpha: f32,
    matrix: &[f32; 12],
    origin: &[f32; 3],
) -> Option<([u32; 3], [u32; 3])> {
    let mut bad = false;
    let mut values = [0u32; 3];
    let mut vector = [0f32; 3];
    for axis in 0..3 {
        let a_bits = if layout.tween {
            work[layout.cache + i * 3 + axis]
        } else {
            vertex(work, layout.first + i * 2, axis)
        };
        let a = f32::from_bits(a_bits);
        if !a.is_finite() {
            return None;
        }
        let value = if interpolate {
            let b = f32::from_bits(vertex(work, layout.second + i * 2, axis));
            let delta = add24(b, -a, &mut bad);
            add24(mul24(delta, alpha, &mut bad), a, &mut bad).to_bits()
        } else {
            a_bits
        };
        values[axis] = value;
        let reference = if layout.blend {
            f32::from_bits(vertex(work, layout.base_frame + i * 2, axis))
        } else {
            origin[axis]
        };
        let component = add24(f32::from_bits(value), -reference, &mut bad);
        vector[axis] = if layout.blend { component } else { add24(component, -matrix[axis], &mut bad) };
    }
    let mut output = [0u32; 3];
    for axis in 0..3 {
        let row = 3 + axis * 3;
        let sum = add24(
            add24(mul24(vector[0], matrix[row], &mut bad), mul24(vector[1], matrix[row + 1], &mut bad), &mut bad),
            mul24(vector[2], matrix[row + 2], &mut bad),
            &mut bad,
        );
        output[axis] = if layout.blend {
            let previous = f32::from_bits(work[layout.output + i * layout.stride + axis]);
            if !previous.is_finite() {
                return None;
            }
            add24(sum, previous, &mut bad).to_bits()
        } else {
            sum.to_bits()
        };
    }
    if bad {
        None
    } else {
        Some((values, output))
    }
}

/// One vertex on the `Ext` model with each result rounded to 24 bits
/// (`Ext::round24`): precision control 24 for any operand, NaN and infinity
/// rules included. Writes the cache and output words.
fn pose_ext24(work: &mut [u32], layout: &PoseLayout, i: usize, interpolate: bool, alpha: Ext, matrix: &[Ext; 12], origin: &[Ext; 3]) {
    let vector: [Ext; 3] = std::array::from_fn(|axis| {
        let at = layout.cache + i * 3 + axis;
        let a = if layout.tween { work[at] } else { vertex(work, layout.first + i * 2, axis) };
        let value = if interpolate {
            let a = Ext::load(a);
            let delta = Ext::load(vertex(work, layout.second + i * 2, axis)).sub(a).round24();
            delta.mul(alpha).round24().add(a).round24().store()
        } else {
            a
        };
        work[at] = value;
        let reference = if layout.blend {
            Ext::load(vertex(work, layout.base_frame + i * 2, axis))
        } else {
            origin[axis]
        };
        let component = Ext::load(value).sub(reference).round24().stored();
        if layout.blend {
            component
        } else {
            component.sub(matrix[axis]).round24()
        }
    });
    for axis in 0..3 {
        let row = 3 + axis * 3;
        let result = vector[0]
            .mul(matrix[row])
            .round24()
            .add(vector[1].mul(matrix[row + 1]).round24())
            .round24()
            .add(vector[2].mul(matrix[row + 2]).round24())
            .round24()
            .store();
        let at = layout.output + i * layout.stride + axis;
        work[at] = if layout.blend { Ext::load(result).add(Ext::load(work[at])).round24().store() } else { result };
    }
}

thread_local! { static POSE_COUNTS: std::cell::Cell<[u32; 4]> = const { std::cell::Cell::new([0, 0, 0, 0]) }; }

/// Diagnostics (wrapping counts): 0 the binary32 path, 1 `pose_ext24` for a
/// pass with non-finite matrix, origin or alpha words, 2 `pose_ext24` for a
/// vertex the binary32 path declined, 3 unused.
#[no_mangle]
pub extern "C" fn pose_count(kind: u32) -> u32 {
    POSE_COUNTS.with(|counts| counts.get()[kind.min(3) as usize])
}

fn count_pose(kind: usize) {
    POSE_COUNTS.with(|c| {
        let mut v = c.get();
        v[kind] = v[kind].wrapping_add(1);
        c.set(v);
    });
}

#[no_mangle]
pub extern "C" fn pose(count: usize, stride: usize, alpha: u32, tween: u32, blend: u32) {
    pose_with(count, stride, alpha, tween, blend, true);
}

fn pose_with(count: usize, stride: usize, alpha: u32, tween: u32, blend: u32, allow_single: bool) {
    WORK.with_borrow_mut(|work| {
        assert!(stride >= 3 && tween <= 1 && blend <= 1);
        let first = 16;
        let second = first + count * 2;
        let base_frame = second + count * 2;
        let cache = base_frame + count * 2;
        let output = cache + count * 3;
        assert!(output + count * stride <= work.len());
        let layout = PoseLayout { first, second, base_frame, cache, output, stride, tween: tween != 0, blend: blend != 0 };
        let interpolate = f32::from_bits(alpha) > 0.0;
        let matrix_ext: [Ext; 12] = std::array::from_fn(|i| Ext::load(work[i]));
        let origin_ext: [Ext; 3] = std::array::from_fn(|i| Ext::load(work[12 + i]));
        let alpha_ext = Ext::load(alpha);
        let matrix: [f32; 12] = std::array::from_fn(|i| f32::from_bits(work[i]));
        let origin: [f32; 3] = std::array::from_fn(|i| f32::from_bits(work[12 + i]));
        let alpha = f32::from_bits(alpha);
        let finite = allow_single && alpha.is_finite() && matrix.iter().chain(origin.iter()).all(|v| v.is_finite());
        for i in 0..count {
            if finite {
                if let Some((values, posed)) = pose_single(work, &layout, i, interpolate, alpha, &matrix, &origin) {
                    for axis in 0..3 {
                        work[cache + i * 3 + axis] = values[axis];
                        work[output + i * stride + axis] = posed[axis];
                    }
                    count_pose(0);
                    continue;
                }
            }
            count_pose(if finite { 2 } else { 1 });
            pose_ext24(work, &layout, i, interpolate, alpha_ext, &matrix_ext, &origin_ext);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn unit(&mut self) -> f64 {
            (self.next() >> 11) as f64 / (1u64 << 53) as f64
        }
        fn i16(&mut self, span: i32) -> i16 {
            ((self.next() % (2 * span as u64 + 1)) as i32 - span) as i16
        }
        fn f32(&mut self, scale: f64) -> f32 {
            ((self.unit() - 0.5) * 2.0 * scale) as f32
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn run(
        words: &[u32],
        count: usize,
        stride: usize,
        alpha: u32,
        tween: u32,
        blend: u32,
        exact: bool,
    ) -> Vec<u32> {
        WORK.with_borrow_mut(|work| {
            work.clear();
            work.extend_from_slice(words);
        });
        pose_with(count, stride, alpha, tween, blend, exact);
        WORK.with_borrow(|work| work.clone())
    }

    /// The binary32 path must reproduce the `Ext` model rounded to 24 bits
    /// bit for bit: outputs and the cache words it leaves, over main, tween
    /// and blend passes, plain and interpolated, including zeros, signed
    /// zeros, tiny values and non-finite words.
    #[test]
    fn single_pose_matches_ext24() {
        let mut rng = Rng(0x9e3779b97f4a7c15);
        let (mut vertices, mut single) = (0u64, 0u64);
        for case in 0..6000 {
            let count = 1 + (rng.next() % 64) as usize;
            let stride = 3 + (rng.next() % 2) as usize;
            let (tween, blend) = (
                rng.next().is_multiple_of(3) as u32,
                rng.next().is_multiple_of(3) as u32,
            );
            let first = 16;
            let cache = first + count * 2 * 3;
            let output = cache + count * 3;
            let mut work = vec![0u32; output + count * stride + 4];
            let scale = [1.0, 64.0, 1e4, 3e4][case % 4];
            let span = [2, 300, 4000, 32767][(case / 4) % 4];
            let special = |rng: &mut Rng, typical: f32| -> f32 {
                match rng.next() % 16 {
                    0 => 0.0,
                    1 => -0.0,
                    2 => 1.0,
                    3 => -1.0,
                    4 => rng.f32(1e-6),
                    5 if rng.next().is_multiple_of(64) => f32::NAN,
                    6 if rng.next().is_multiple_of(16) => rng.f32(1e-30),
                    _ => typical,
                }
            };
            for (i, word) in work.iter_mut().enumerate().take(12) {
                let typical = rng.f32(if i < 3 { scale } else { 2.0 });
                *word = special(&mut rng, typical).to_bits();
            }
            for word in &mut work[12..15] {
                let typical = rng.f32(scale / 10.0);
                *word = special(&mut rng, typical).to_bits();
            }
            for i in 0..count * 2 * 3 {
                let a = rng.i16(span) as u16 as u32;
                let b = rng.i16(span) as u16 as u32;
                work[first + i] = a | (b << 16);
            }
            for i in 0..count * 3 {
                let typical = rng.f32(span as f64);
                work[cache + i] = special(&mut rng, typical).to_bits();
            }
            for i in 0..count * stride {
                let typical = rng.f32(scale);
                work[output + i] = special(&mut rng, typical).to_bits();
            }
            let alpha = match rng.next() % 7 {
                0 => 0.0f32,
                1 => 0.5,
                2 => rng.unit() as f32 * 1e-7,
                3 => -0.25,
                _ => rng.unit() as f32,
            };
            let reference = run(&work, count, stride, alpha.to_bits(), tween, blend, false);
            let before = pose_count(0);
            let fast = run(&work, count, stride, alpha.to_bits(), tween, blend, true);
            single += pose_count(0).wrapping_sub(before) as u64;
            assert_eq!(reference, fast, "case {case} tween {tween} blend {blend}");
            vertices += count as u64;
        }
        assert!(vertices > 150_000);
        // Both the binary32 path and the Ext24 fallback must be exercised.
        assert!(single > vertices / 4 && single < vertices, "{single} binary32 of {vertices}");
        eprintln!("binary32 path {single} of {vertices} vertices");
    }
}

#[cfg(test)]
mod bench {
    use super::*;

    /// `cargo test --release -- --ignored --nocapture pose_speed`
    #[test]
    #[ignore]
    fn pose_speed() {
        let count = 800;
        let stride = 3;
        let first = 16;
        let cache = first + count * 2 * 3;
        let output = cache + count * 3;
        let mut words = vec![0u32; output + count * stride];
        let m = [
            -5123.47f32,
            812.25,
            -96.5,
            0.70710677,
            -0.70710677,
            0.0,
            0.70710677,
            0.70710677,
            0.0,
            0.0,
            0.0,
            1.0,
        ];
        for (i, v) in m.iter().enumerate() {
            words[i] = v.to_bits();
        }
        words[12..15].fill(3.25f32.to_bits());
        let mut seed = 12345u32;
        for i in 0..count * 2 * 3 {
            seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
            let a = ((seed >> 16) % 400) as u16 as u32;
            let b = ((seed >> 8) % 400) as u16 as u32;
            words[first + i] = a | (b << 16);
        }
        WORK.with_borrow_mut(|work| *work = words.clone());
        for single in [true, false] {
            let rounds = 2000;
            let start = std::time::Instant::now();
            for round in 0..rounds {
                pose_with(
                    count,
                    stride,
                    (0.3f32 + round as f32 * 1e-5).to_bits(),
                    0,
                    0,
                    single,
                );
            }
            let ns = start.elapsed().as_nanos() as f64 / (rounds * count) as f64;
            eprintln!(
                "single={single}: {ns:.1} ns/vertex; counts binary32 {} ext24 {}+{}",
                pose_count(0),
                pose_count(1),
                pose_count(2)
            );
        }
    }
}

#[cfg(test)]
mod light_bench {
    use super::*;

    /// `LIGHT_TABLES_FILE=... cargo test --release -- --ignored --nocapture light_speed`
    #[test]
    #[ignore]
    fn light_speed() {
        let text = std::fs::read_to_string(std::env::var("LIGHT_TABLES_FILE").unwrap()).unwrap();
        let tables: Vec<u32> = text.split(',').map(|v| v.trim().parse().unwrap()).collect();
        assert_eq!(tables.len(), LIGHT_TABLE_WORDS);
        LIGHT_TABLES.with_borrow_mut(|t| *t = tables.clone());
        let light_count = std::env::var("LIGHTS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(8usize);
        let (vertex_count, face_count) = (800usize, 1500usize);
        let mut seed = 7u32;
        let mut next = || {
            seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
            (seed >> 8) as f32 / (1 << 24) as f32
        };
        let faces: Vec<u32> = (0..face_count)
            .flat_map(|i| {
                let a = (i % vertex_count) as u32;
                [
                    a,
                    ((i * 7 + 1) % vertex_count) as u32,
                    ((i * 13 + 2) % vertex_count) as u32,
                    0,
                ]
            })
            .collect();
        LIGHT_MESHES.with_borrow_mut(|m| {
            m.clear();
            m.push(Some(faces.clone()));
        });
        let points_at = 20;
        let lights_at = points_at + vertex_count * 3;
        let scratch_at = lights_at + light_count * 7;
        let colors_at = scratch_at + vertex_count * 10 + face_count;
        let mut work = vec![0u32; colors_at + face_count * 9 + 16];
        let axes = [[1.0f32, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        for (k, v) in [100.0f32, 50.0, 30.0].iter().enumerate() {
            work[k] = v.to_bits();
        }
        work[3] = 1.0f32.to_bits();
        for a in 0..3 {
            for c in 0..3 {
                work[4 + a * 3 + c] = axes[a][c].to_bits();
            }
        }
        work[13..20].fill(0.1f32.to_bits());
        work[16] = 1.0f32.to_bits();
        for v in 0..vertex_count * 3 {
            work[points_at + v] = ((next() - 0.5) * 60.0 + 300.0).to_bits();
        }
        for l in 0..light_count {
            let at = lights_at + l * 7;
            for k in 0..3 {
                work[at + k] = ((next() - 0.5) * 600.0 + 300.0).to_bits();
            }
            work[at + 3] = (1.0f32 / 800.0).to_bits();
            for k in 4..7 {
                work[at + k] = next().to_bits();
            }
        }
        WORK.with_borrow_mut(|w| *w = work.clone());
        let rounds = 400;
        let start = std::time::Instant::now();
        for _ in 0..rounds {
            light_mesh(0, vertex_count, light_count, 0);
        }
        let ns =
            start.elapsed().as_nanos() as f64 / (rounds * vertex_count * light_count.max(1)) as f64;
        eprintln!(
            "light: {ns:.2} ns per vertex-light ({:.1} us per mesh)",
            ns * (vertex_count * light_count) as f64 / 1000.0
        );
    }
}
