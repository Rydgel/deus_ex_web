//! Original GetFrame vertex loops; see docs/lodmesh-wasm.md for native evidence.
//! No floating arithmetic substitutes for x87: all intermediates round to a
//! 64-bit significand, with explicit f32 stores at the original instructions.
use std::cell::RefCell;

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

fn camera_component(point: [f32; 3], origin: [f32; 3], axis: [f32; 3]) -> f32 {
    let dx = point[0] as f64 - origin[0] as f64;
    let dy = point[1] as f64 - origin[1] as f64;
    let dz = point[2] as f64 - origin[2] as f64;
    (dx * axis[0] as f64 + dy * axis[1] as f64 + dz * axis[2] as f64) as f32
}

// `!(x > 0.0)` deliberately treats NaN like a non-positive factor.
#[allow(clippy::too_many_arguments, clippy::neg_cmp_op_on_partial_ord)]
fn light_vertex(
    lights: &[[f32; 7]],
    point: [f32; 3],
    plane: [f32; 4],
    flags: u32,
    ambient: [f32; 3],
    scale_glow: f32,
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
        let p2 = (px as f64 * px as f64 + py as f64 * py as f64 + pz as f64 * pz as f64) as f32;
        for &[lx, ly, lz, rradius, cr, cg, cb] in lights {
            let dz = (lz as f64 - pz as f64) as f32;
            let dy = (ly as f64 - py as f64) as f32;
            let dxe = lx as f64 - px as f64;
            let dx = dxe as f32;
            let dist2 = (dxe * dx as f64 + dy as f64 * dy as f64 + dz as f64 * dz as f64) as f32;
            let dist = table_sqrt(dist2, tables);
            // amount = total * factor below; total is >= 0, +inf or NaN, so a
            // factor that is not positive leaves amount > 0 false.
            let factor = 1.0 - dist as f64 * rradius as f64;
            if !(factor > 0.0) {
                continue;
            }
            let c = (dy as f64 * ny as f64 + dz as f64 * nz as f64 + dx as f64 * nx as f64)
                / dist as f64
                + 1.0;
            let mut diffuse = (c * c - 1.5) as f32;
            if diffuse < 0.0 {
                diffuse = 0.0;
            }
            let plane2 = (2.0
                * (lz as f64 * nz as f64 + ly as f64 * ny as f64 + lx as f64 * nx as f64
                    - nw as f64)) as f32;
            let rx = (lx as f64 - (nx as f64 * plane2 as f64) as f32 as f64) as f32;
            let ry = (ly as f64 - (ny as f64 * plane2 as f64) as f32 as f64) as f32;
            let rz = (lz as f64 - (nz as f64 * plane2 as f64) as f32 as f64) as f32;
            let specular =
                rx as f64 * px as f64 + rz as f64 * pz as f64 + ry as f64 * py as f64 - p2 as f64;
            let total = if specular > 0.0 {
                specular * specular * 6.0 / (dist2 as f64 * p2 as f64) + diffuse as f64
            } else {
                diffuse as f64
            };
            let amount = total * factor;
            if amount > 0.0 {
                r = (amount * cr as f64 + r as f64) as f32;
                g = ((amount * cg as f64) as f32 as f64 + g as f64) as f32;
                b = ((amount * cb as f64) as f32 as f64 + b as f64) as f32;
            }
        }
    }
    let scale = scale_glow as f64 * 1.4;
    let finish = |value: f64| if value > 1.0 { 1.0 } else { value as f32 };
    [
        finish(r as f64 * scale + ambient[0] as f64),
        finish(g as f64 * scale + ambient[1] as f64),
        finish(b as f64 * scale + ambient[2] as f64),
    ]
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
        let ax = p2[0] as f64 - p0[0] as f64;
        let ay = p2[1] as f64 - p0[1] as f64;
        let az = p2[2] as f64 - p0[2] as f64;
        let bz = (p0[2] as f64 - p1[2] as f64) as f32;
        let by = (p0[1] as f64 - p1[1] as f64) as f32;
        let bx = p0[0] as f64 - p1[0] as f64;
        let nz = (bx * ay - by as f64 * ax) as f32;
        let ny = (bz as f64 * ax - bx * az) as f32;
        let nx = (by as f64 * az - bz as f64 * ay) as f32;
        let length = (nx as f64 * nx as f64
            + ny as f64 * ny as f64
            + nz as f64 * nz as f64
            + NORMAL_EPSILON as f64) as f32;
        let scale = table_rsqrt(length, tables);
        let face = [nx * scale, ny * scale, nz * scale];
        for vertex in vertices {
            for axis in 0..3 {
                let old = f32::from_bits(work[normals_at + vertex * 3 + axis]);
                work[normals_at + vertex * 3 + axis] =
                    ((face[axis] as f64 + old as f64) as f32).to_bits();
            }
        }
        let face_flags = faces[at + 3];
        let dot = face[0] as f64 * p0[0] as f64
            + face[1] as f64 * p0[1] as f64
            + face[2] as f64 * p0[2] as f64;
        if face_flags & 1 == 0 && (face_flags & 0x100 != 0 || dot < 0.0) {
            work[drawn_at + i] = 1;
            for vertex in vertices {
                work[lit_at + vertex] = 1;
            }
        }
    }

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
        let length = (normal[0] as f64 * normal[0] as f64
            + normal[1] as f64 * normal[1] as f64
            + normal[2] as f64 * normal[2] as f64
            + NORMAL_EPSILON as f64) as f32;
        let scale = table_rsqrt(length, tables);
        let extended = normal.map(|value| scale as f64 * value as f64);
        let plane = [
            extended[0] as f32,
            extended[1] as f32,
            extended[2] as f32,
            (point[0] as f64 * extended[0]
                + point[1] as f64 * extended[1]
                + point[2] as f64 * extended[2]) as f32,
        ];
        let light = light_vertex(&lights, point, plane, flags, ambient, scale_glow, tables);
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

/// An exact dyadic value `m * 2^e`, kept with at most 62 significant bits.
/// x87 rounds a result to its 64-bit significand only when the exact value
/// needs more bits; below 62 bits every x87 add/sub/mul is therefore exact,
/// and a plain integer operation reproduces it. `neg_zero` carries the sign
/// of an exact zero (IEEE round-to-nearest rules, as `Ext`).
#[derive(Clone, Copy)]
struct Exact {
    m: i64,
    e: i32,
    neg_zero: bool,
}

const EXACT_BITS: u32 = 62;

impl Exact {
    #[inline(always)]
    fn load(bits: u32) -> Option<Self> {
        let exponent = (bits >> 23) & 255;
        if exponent == 255 {
            return None;
        }
        let mantissa = (bits & 0x7fffff) as i64;
        let (m, e) = if exponent == 0 {
            (mantissa, -149)
        } else {
            (mantissa | 0x800000, exponent as i32 - 150)
        };
        let negative = bits & 0x80000000 != 0;
        Some(Self::trimmed(if negative { -m } else { m }, e, negative))
    }

    /// Drops trailing zero bits; None when more than EXACT_BITS remain.
    #[inline(always)]
    fn fitted(m: i64, e: i32, neg_zero: bool) -> Option<Self> {
        if m == 0 {
            return Some(Self { m, e: 0, neg_zero });
        }
        let value = Self::trimmed(m, e, neg_zero);
        if 64 - value.m.unsigned_abs().leading_zeros() > EXACT_BITS {
            None
        } else {
            Some(value)
        }
    }

    #[inline(always)]
    fn trimmed(m: i64, e: i32, neg_zero: bool) -> Self {
        if m == 0 {
            return Self { m, e: 0, neg_zero };
        }
        let zeros = m.trailing_zeros();
        Self {
            m: m >> zeros,
            e: e + zeros as i32,
            neg_zero: false,
        }
    }

    #[inline(always)]
    fn width(self) -> u32 {
        64 - self.m.unsigned_abs().leading_zeros()
    }

    #[inline(always)]
    fn negative(self) -> bool {
        if self.m == 0 {
            self.neg_zero
        } else {
            self.m < 0
        }
    }

    #[inline(always)]
    fn neg(self) -> Self {
        Self {
            m: -self.m,
            e: self.e,
            neg_zero: self.m == 0 && !self.neg_zero,
        }
    }

    /// Exact FADD; an exact zero is -0 only when both operands are -0.
    #[inline(always)]
    fn add(self, other: Self) -> Option<Self> {
        if self.m == 0 && other.m == 0 {
            return Some(Self {
                m: 0,
                e: 0,
                neg_zero: self.neg_zero && other.neg_zero,
            });
        }
        if self.m == 0 {
            return Some(other);
        }
        if other.m == 0 {
            return Some(self);
        }
        let (high, low) = if self.e >= other.e {
            (self, other)
        } else {
            (other, self)
        };
        let shift = (high.e - low.e) as u32;
        if high.width() + shift > EXACT_BITS {
            return None;
        }
        Self::fitted((high.m << shift) + low.m, low.e, false)
    }

    #[inline(always)]
    fn sub(self, other: Self) -> Option<Self> {
        self.add(other.neg())
    }

    /// Exact FMUL; a zero product takes the operands' sign parity.
    #[inline(always)]
    fn mul(self, other: Self) -> Option<Self> {
        if self.m == 0 || other.m == 0 {
            return Some(Self {
                m: 0,
                e: 0,
                neg_zero: self.negative() != other.negative(),
            });
        }
        if self.width() + other.width() > EXACT_BITS {
            return None;
        }
        Self::fitted(self.m * other.m, self.e + other.e, false)
    }

    /// FST to f32, round to nearest even. None where `Ext::store` takes its
    /// subnormal/overflow branches; those vertices use the `Ext` path.
    #[inline(always)]
    fn store(self) -> Option<u32> {
        if self.m == 0 {
            return Some(if self.neg_zero { 0x80000000 } else { 0 });
        }
        let sign = if self.m < 0 { 0x80000000u32 } else { 0 };
        let magnitude = self.m.unsigned_abs();
        let width = self.width() as i32;
        let mut exponent = width - 1 + self.e;
        let mut significand = if width > 24 {
            let shift = (width - 24) as u32;
            let kept = magnitude >> shift;
            let rest = magnitude & ((1u64 << shift) - 1);
            let half = 1u64 << (shift - 1);
            kept + u64::from(rest > half || (rest == half && kept & 1 != 0))
        } else {
            magnitude << (24 - width) as u32
        };
        if significand == 1 << 24 {
            significand >>= 1;
            exponent += 1;
        }
        if !(-126..=127).contains(&exponent) {
            return None;
        }
        Some(sign | (((exponent + 127) as u32) << 23) | (significand as u32 - (1 << 23)))
    }

    #[inline(always)]
    fn stored(self) -> Option<Self> {
        Self::load(self.store()?)
    }
}

/// Error bound factor for `pose_double`: 32 units of 2^-53 per unit of term
/// magnitude. The f64 evaluation of each store's expression and the x87
/// evaluation (64-bit roundings) of the same expression on the same f32
/// operands each stay within a few units of 2^-53 of the exact value.
const DOUBLE_BOUND: f64 = 1.0 / (1u64 << 48) as f64;

/// The f32 store of an x87 value known to lie within `bound` of `value`: the
/// f32 that every real in [value - bound, value + bound] rounds to (nearest
/// even), or None when that interval reaches a rounding midpoint or the
/// result is subnormal, overflowing or non-finite. A zero bound means the
/// value is exact (all its terms were zero), so its IEEE result is the store.
#[inline(always)]
fn certain_f32(value: f64, bound: f64) -> Option<u32> {
    let rounded = value as f32;
    if bound == 0.0 && value.is_finite() {
        return Some(rounded.to_bits());
    }
    if !(rounded != 0.0 && rounded.is_finite()) {
        return None;
    }
    let bits = rounded.to_bits();
    let exponent = (bits >> 23) & 255;
    if exponent == 0 || exponent >= 254 {
        return None;
    }
    // Spacing above |rounded| is 2^(e - 150); it halves below a power of two.
    let up = f64::from_bits(((exponent as u64) + 873) << 52);
    let down = if bits & 0x7fffff == 0 { up * 0.5 } else { up };
    let magnitude = value.abs();
    let target = (rounded as f64).abs();
    if magnitude - bound > target - down * 0.5 && magnitude + bound < target + up * 0.5 {
        Some(bits)
    } else {
        None
    }
}

/// The f32 store of x + y for f32 operands x and y. When error-free TwoSum
/// shows the f64 sum is exact, the x87 sum is the same exact value (its 64-bit
/// rounding is an identity) and the store rounds it once, zeros and their
/// signs included (same IEEE rules). Otherwise the certainty test decides.
#[inline(always)]
fn certain_sum(x: f64, y: f64) -> Option<u32> {
    let sum = x + y;
    let part = sum - x;
    if (x - (sum - part)) + (y - part) == 0.0 && sum.is_finite() {
        return Some((sum as f32).to_bits());
    }
    certain_f32(sum, (x.abs() + y.abs()) * DOUBLE_BOUND)
}

/// `pose_exact`'s vertex in f64 with a rounding-certainty test at every f32
/// store (`certain_f32`); None hands the vertex to `pose_exact`. The product
/// of two f32 values is exact in both f64 and x87, so its store is direct.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn pose_double(
    work: &[u32],
    layout: &PoseLayout,
    i: usize,
    interpolate: bool,
    alpha: f64,
    matrix: &[f64; 12],
    origin: &[f64; 3],
) -> Option<([u32; 3], [u32; 3])> {
    let mut values = [0u32; 3];
    let mut vector = [0f64; 3];
    let mut vector_error = [0f64; 3];
    for axis in 0..3 {
        let a_bits = if layout.tween {
            work[layout.cache + i * 3 + axis]
        } else {
            vertex(work, layout.first + i * 2, axis)
        };
        let a = f32::from_bits(a_bits) as f64;
        if !a.is_finite() {
            return None;
        }
        let value = if interpolate {
            let b = f32::from_bits(vertex(work, layout.second + i * 2, axis)) as f64;
            if axis != 0 {
                let delta = f32::from_bits(certain_sum(b, -a)?) as f64;
                let product = (delta * alpha) as f32 as f64;
                certain_sum(product, a)?
            } else if b == a {
                // An exact +0 difference and zero product (alpha > 0): x87 and
                // f64 both compute the exact sum +0 + a.
                certain_sum(0.0 * alpha, a)?
            } else {
                let delta = b - a;
                let product = delta * alpha;
                certain_f32(
                    product + a,
                    (product.abs() * 2.0 + a.abs() + (b.abs() + a.abs()) * alpha.abs())
                        * DOUBLE_BOUND,
                )?
            }
        } else {
            a_bits
        };
        values[axis] = value;
        let v = f32::from_bits(value) as f64;
        let reference = if layout.blend {
            f32::from_bits(vertex(work, layout.base_frame + i * 2, axis)) as f64
        } else {
            origin[axis]
        };
        let component = f32::from_bits(certain_sum(v, -reference)?) as f64;
        if layout.blend {
            vector[axis] = component;
        } else {
            vector[axis] = component - matrix[axis];
            vector_error[axis] = (component.abs() + matrix[axis].abs()) * DOUBLE_BOUND;
        }
    }
    let mut output = [0u32; 3];
    for axis in 0..3 {
        let row = 3 + axis * 3;
        let p0 = vector[0] * matrix[row];
        let p1 = vector[1] * matrix[row + 1];
        let p2 = vector[2] * matrix[row + 2];
        let sum = (p0 + p1) + p2;
        let bound = (p0.abs() + p1.abs() + p2.abs()) * DOUBLE_BOUND
            + vector_error[0] * matrix[row].abs()
            + vector_error[1] * matrix[row + 1].abs()
            + vector_error[2] * matrix[row + 2].abs();
        let result = certain_f32(sum, bound)?;
        output[axis] = if layout.blend {
            let r = f32::from_bits(result) as f64;
            let previous = f32::from_bits(work[layout.output + i * layout.stride + axis]) as f64;
            if !previous.is_finite() {
                return None;
            }
            certain_sum(r, previous)?
        } else {
            result
        };
    }
    Some((values, output))
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

/// One vertex of `pose` with `Exact` arithmetic, in the `Ext` loop's
/// operation order and store points, for main, tween and blend passes.
/// Returns the cache words and output words the `Ext` loop would write, or
/// None when any intermediate would exceed EXACT_BITS or leave the normal f32
/// range; the caller then runs `Ext` for this vertex.
#[inline(always)]
fn pose_exact(
    work: &[u32],
    layout: &PoseLayout,
    i: usize,
    interpolate: bool,
    alpha: Exact,
    matrix: &[Exact; 12],
    origin: &[Exact; 3],
) -> Option<([u32; 3], [u32; 3])> {
    let mut values = [0u32; 3];
    let mut vector = [Exact {
        m: 0,
        e: 0,
        neg_zero: false,
    }; 3];
    for axis in 0..3 {
        let a_bits = if layout.tween {
            work[layout.cache + i * 3 + axis]
        } else {
            vertex(work, layout.first + i * 2, axis)
        };
        let value = if interpolate {
            let a = Exact::load(a_bits)?;
            let mut delta = Exact::load(vertex(work, layout.second + i * 2, axis))?.sub(a)?;
            if axis != 0 {
                delta = delta.stored()?;
            }
            let mut product = delta.mul(alpha)?;
            if axis != 0 {
                product = product.stored()?;
            }
            product.add(a)?.store()?
        } else {
            a_bits
        };
        values[axis] = value;
        let reference = if layout.blend {
            Exact::load(vertex(work, layout.base_frame + i * 2, axis))?
        } else {
            origin[axis]
        };
        let component = Exact::load(value)?.sub(reference)?.stored()?;
        vector[axis] = if layout.blend {
            component
        } else {
            component.sub(matrix[axis])?
        };
    }
    let mut output = [0u32; 3];
    for axis in 0..3 {
        let row = 3 + axis * 3;
        let result = vector[0]
            .mul(matrix[row])?
            .add(vector[1].mul(matrix[row + 1])?)?
            .add(vector[2].mul(matrix[row + 2])?)?
            .store()?;
        output[axis] = if layout.blend {
            let previous = work[layout.output + i * layout.stride + axis];
            Exact::load(result)?.add(Exact::load(previous)?)?.store()?
        } else {
            result
        };
    }
    Some((values, output))
}

thread_local! { static POSE_COUNTS: std::cell::Cell<[u32; 4]> = const { std::cell::Cell::new([0, 0, 0, 0]) }; }

/// Diagnostics (wrapping counts): 0 exact integer path, 1 and 2 `Ext`
/// (non-finite operands / exact-width miss), 3 the f64 certain-rounding path.
#[no_mangle]
pub extern "C" fn pose_count(kind: u32) -> u32 {
    POSE_COUNTS.with(|counts| counts.get()[kind.min(3) as usize])
}

#[no_mangle]
pub extern "C" fn pose(count: usize, stride: usize, alpha: u32, tween: u32, blend: u32) {
    pose_with(count, stride, alpha, tween, blend, true);
}

fn pose_with(count: usize, stride: usize, alpha: u32, tween: u32, blend: u32, allow_exact: bool) {
    WORK.with_borrow_mut(|work| {
        assert!(stride >= 3 && tween <= 1 && blend <= 1);
        let first = 16;
        let second = first + count * 2;
        let base_frame = second + count * 2;
        let cache = base_frame + count * 2;
        let output = cache + count * 3;
        assert!(output + count * stride <= work.len());
        let matrix: [Ext; 12] = std::array::from_fn(|i| Ext::load(work[i]));
        let origin: [Ext; 3] = std::array::from_fn(|i| Ext::load(work[12 + i]));
        let interpolate = f32::from_bits(alpha) > 0.0;
        // Finite matrix, origin and alpha admit the exact path; any vertex it
        // cannot represent exactly falls through to the general `Ext` loop.
        let layout = PoseLayout {
            first,
            second,
            base_frame,
            cache,
            output,
            stride,
            tween: tween != 0,
            blend: blend != 0,
        };
        // Finite matrix, origin and alpha words admit the fast paths; loaded
        // into fixed arrays (no allocation, so Wasm memory cannot grow here).
        let load_words = |words: &[u32], into: &mut [Exact]| {
            for (slot, &word) in into.iter_mut().zip(words) {
                *slot = Exact::load(word)?;
            }
            Some(())
        };
        let zero = Exact {
            m: 0,
            e: 0,
            neg_zero: false,
        };
        let (mut exact_matrix, mut exact_origin) = ([zero; 12], [zero; 3]);
        let exact = if allow_exact
            && load_words(&work[..12], &mut exact_matrix).is_some()
            && load_words(&work[12..15], &mut exact_origin).is_some()
        {
            Exact::load(alpha).map(|a| (exact_matrix, exact_origin, a))
        } else {
            None
        };
        let alpha_bits = alpha;
        let alpha = Ext::load(alpha);
        // f64 operands for pose_double (finite whenever `exact` exists).
        let double = exact.as_ref().map(|_| {
            (
                std::array::from_fn::<f64, 12, _>(|i| f32::from_bits(work[i]) as f64),
                std::array::from_fn::<f64, 3, _>(|i| f32::from_bits(work[12 + i]) as f64),
                f32::from_bits(alpha_bits) as f64,
            )
        });
        for i in 0..count {
            if let Some((matrix, origin, alpha)) = &double {
                if let Some((values, posed)) =
                    pose_double(work, &layout, i, interpolate, *alpha, matrix, origin)
                {
                    for axis in 0..3 {
                        work[cache + i * 3 + axis] = values[axis];
                        work[output + i * stride + axis] = posed[axis];
                    }
                    POSE_COUNTS.with(|c| {
                        let mut v = c.get();
                        v[3] = v[3].wrapping_add(1);
                        c.set(v);
                    });
                    continue;
                }
            }
            if let Some((matrix, origin, exact_alpha)) = &exact {
                if let Some((values, posed)) =
                    pose_exact(work, &layout, i, interpolate, *exact_alpha, matrix, origin)
                {
                    for axis in 0..3 {
                        work[cache + i * 3 + axis] = values[axis];
                        work[output + i * stride + axis] = posed[axis];
                    }
                    POSE_COUNTS.with(|c| {
                        let mut v = c.get();
                        v[0] = v[0].wrapping_add(1);
                        c.set(v);
                    });
                    continue;
                }
            }
            // [1]: passes with non-finite operands; [2]: exact width misses.
            let kind = if exact.is_some() { 2 } else { 1 };
            POSE_COUNTS.with(|c| {
                let mut v = c.get();
                v[kind] = v[kind].wrapping_add(1);
                c.set(v);
            });
            let vector: [Ext; 3] = std::array::from_fn(|axis| {
                let at = cache + i * 3 + axis;
                let a = if tween != 0 {
                    work[at]
                } else {
                    vertex(work, first + i * 2, axis)
                };
                let value = if interpolate {
                    let a = Ext::load(a);
                    let mut delta = Ext::load(vertex(work, second + i * 2, axis)).sub(a);
                    if axis != 0 {
                        delta = delta.stored();
                    }
                    let mut product = delta.mul(alpha);
                    if axis != 0 {
                        product = product.stored();
                    }
                    product.add(a).store()
                } else {
                    a
                };
                work[at] = value;
                let reference = if blend != 0 {
                    Ext::load(vertex(work, base_frame + i * 2, axis))
                } else {
                    origin[axis]
                };
                let component = Ext::load(value).sub(reference).stored();
                if blend != 0 {
                    component
                } else {
                    component.sub(matrix[axis])
                }
            });
            for axis in 0..3 {
                let row = 3 + axis * 3;
                let result = vector[0]
                    .mul(matrix[row])
                    .add(vector[1].mul(matrix[row + 1]))
                    .add(vector[2].mul(matrix[row + 2]))
                    .store();
                let at = output + i * stride + axis;
                work[at] = if blend != 0 {
                    Ext::load(result).add(Ext::load(work[at])).store()
                } else {
                    result
                };
            }
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

    /// The exact path must reproduce the `Ext` loop bit for bit: outputs and
    /// the cache words it leaves, over main, tween and blend passes, plain
    /// and interpolated, including zeros, signed zeros and non-finite words.
    #[test]
    fn exact_pose_matches_ext() {
        let mut rng = Rng(0x9e3779b97f4a7c15);
        let (mut vertices, mut covered, mut doubled) = (0u64, 0u64, 0u64);
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
            let (before, before_double) = (pose_count(0), pose_count(3));
            let exact = run(&work, count, stride, alpha.to_bits(), tween, blend, true);
            covered += pose_count(0).wrapping_sub(before) as u64;
            doubled += pose_count(3).wrapping_sub(before_double) as u64;
            assert_eq!(reference, exact, "case {case} tween {tween} blend {blend}");
            vertices += count as u64;
        }
        assert!(vertices > 150_000);
        // The f64, exact-integer and Ext paths must all be exercised.
        assert!(
            doubled > vertices / 4 && covered > 1000 && doubled + covered < vertices,
            "{doubled} f64 + {covered} exact of {vertices}"
        );
        eprintln!("f64 path {doubled}, exact path {covered} of {vertices} vertices");
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
        for exact in [true, false] {
            let rounds = 2000;
            let start = std::time::Instant::now();
            for round in 0..rounds {
                pose_with(
                    count,
                    stride,
                    (0.3f32 + round as f32 * 1e-5).to_bits(),
                    0,
                    0,
                    exact,
                );
            }
            let ns = start.elapsed().as_nanos() as f64 / (rounds * count) as f64;
            eprintln!(
                "exact={exact}: {ns:.1} ns/vertex; counts double {} exact {} ext {}+{}",
                pose_count(3),
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
