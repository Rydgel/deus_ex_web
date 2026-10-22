//! UModel::GetCollisionBoundingBox of an owned brush (Engine.dll 0x103f0e70,
//! docs/brush-bounds.md) over ABrush::ToWorld (0x1030f310, docs/fitting.md): the
//! world box of a mover's brush model at a pose, the query box of
//! ActorEncroachmentCheck, the hash registration box and the mover finish box.
//! Step 2 of docs/rotating-brushes.md "Cost": a spinning mover asks for it once per
//! tick, and the JavaScript body (src/runtime/brush-bounds.mjs, kept as the
//! reference) spent its time in BigInt x87 emulation.
//!
//! Two parts, each a transcription of its JavaScript body:
//!  * `brushToWorld` (src/runtime/coords.mjs): float32 stores between steps
//!    and the intermediate sums in binary64 exactly as the JavaScript computes
//!    them (the products of two float32 values are exact in a double; the sums
//!    round once per addition, left to right, no fused multiply-add);
//!  * `nativePoint` (src/runtime/brush-bounds.mjs): the corner expression is
//!    kept in the x87's 64-bit significand (`Ext`, the crate's model, here at
//!    precision control 64) and stored once to float32.
//!
//! The host writes the pose into `BOUNDS_IN` (25 doubles) and the Core sine
//! table once (`sine_ptr`, lib.rs); `brush_bounds` writes `BOUNDS_OUT` (min xyz,
//! max xyz) and returns 1, or 0 when the JavaScript must answer: a non-finite
//! value, a zero scale, a result in the float32 subnormal range or underflowing
//! to zero. Those are the inputs the JavaScript throws on or rounds twice on.
//!
//! BOUNDS_IN: Location[3], Rotation[3] (int32), PostScale scale[3], shearRate,
//! shearAxis, MainScale scale[3], shearRate, shearAxis, PrePivot[3],
//! model min[3], model max[3].

use crate::x87::Ext;
use core::ptr::{addr_of, addr_of_mut};

static mut BOUNDS_IN: [f64; 25] = [0.0; 25];
static mut BOUNDS_OUT: [f64; 6] = [0.0; 6];

#[no_mangle]
pub extern "C" fn bounds_in_ptr() -> *mut f64 {
    addr_of_mut!(BOUNDS_IN) as *mut f64
}
#[no_mangle]
pub extern "C" fn bounds_out_ptr() -> *const f64 {
    addr_of!(BOUNDS_OUT) as *const f64
}

/// Math.fround.
fn f(x: f64) -> f64 {
    (x as f32) as f64
}

/// Origin, then the X, Y and Z axes.
type Coords = [[f64; 3]; 4];

const IDENTITY: Coords = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

/// Original ShearSnap, Engine 0x1030f240 / Core inline at 0x1011c0b5.
fn shear_snap(rate: f64) -> f64 {
    let rate = f(rate);
    f(if rate < -0.65 {
        rate + 0.15
    } else if rate > 0.65 {
        rate - 0.15
    } else if rate < -0.55 {
        -0.5
    } else if rate > 0.55 {
        0.5
    } else if rate < -0.05 {
        rate + 0.05
    } else if rate > 0.05 {
        rate - 0.05
    } else {
        0.0
    })
}

/// coords.mjs transformVector: each output component is the vector dotted with
/// one row of `b`, summed left to right in binary64 and stored to float32.
fn transform_vector(v: [f64; 3], rows: [[f64; 3]; 3]) -> [f64; 3] {
    let mut out = [0.0; 3];
    for j in 0..3 {
        out[j] = f(v[0] * rows[j][0] + v[1] * rows[j][1] + v[2] * rows[j][2]);
    }
    out
}

/// coords.mjs compose: TransformPointBy keeps the origin subtraction in
/// binary64, the three axes use TransformVectorBy.
fn compose(a: &Coords, b: &Coords) -> Coords {
    let rows = [b[1], b[2], b[3]];
    let origin = [a[0][0] - b[0][0], a[0][1] - b[0][1], a[0][2] - b[0][2]];
    [transform_vector(origin, rows), transform_vector(a[1], rows), transform_vector(a[2], rows), transform_vector(a[3], rows)]
}

/// coords.mjs applyScale over a `{scale, shearRate, shearAxis}`; None where the
/// JavaScript throws (a zero or non-finite scale).
fn apply_scale(coords: &Coords, scale: [f64; 3], shear_rate: f64, shear_axis: f64) -> Option<Coords> {
    let scale = [f(scale[0]), f(scale[1]), f(scale[2])];
    if scale.iter().any(|v| !v.is_finite() || *v == 0.0) {
        return None;
    }
    let mut shear = IDENTITY;
    const ENTRIES: [(usize, usize); 6] = [(1, 1), (1, 2), (2, 0), (2, 2), (3, 0), (3, 1)];
    if shear_axis >= 1.0 && shear_axis <= 6.0 && shear_axis == (shear_axis as u32) as f64 {
        let (row, col) = ENTRIES[shear_axis as usize - 1];
        shear[row][col] = shear_snap(shear_rate);
    }
    let result = compose(coords, &shear);
    let mut out = [[0.0; 3]; 4];
    for i in 0..3 {
        out[0][i] = f(result[0][i] / scale[i]);
        for r in 1..4 {
            out[r][i] = f(result[r][i] * scale[i]);
        }
    }
    Some(out)
}

fn sin_of(angle: i32) -> f64 {
    f32::from_bits(crate::rotator_sin(angle)) as f64
}

/// coords.mjs brushToWorld.
fn brush_to_world(i: &[f64; 25]) -> Option<Coords> {
    let mut coords = IDENTITY;
    for k in 0..3 {
        coords[0][k] = f(0.0 - f(i[k]));
    }
    coords = apply_scale(&coords, [i[6], i[7], i[8]], i[9], i[10])?;
    let (pitch, yaw, roll) = (i[3] as i32, i[4] as i32, i[5] as i32);
    let (sy, cy) = (sin_of(yaw), sin_of(yaw.wrapping_add(0x4000)));
    let (sp, cp) = (sin_of(pitch), sin_of(pitch.wrapping_add(0x4000)));
    let (sr, cr) = (sin_of(roll), sin_of(roll.wrapping_add(0x4000)));
    coords = compose(&coords, &[[0.0, 0.0, 0.0], [cy, sy, 0.0], [-sy, cy, 0.0], [0.0, 0.0, 1.0]]);
    coords = compose(&coords, &[[0.0, 0.0, 0.0], [cp, 0.0, sp], [0.0, 1.0, 0.0], [-sp, 0.0, cp]]);
    coords = compose(&coords, &[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, cr, -sr], [0.0, sr, cr]]);
    coords = apply_scale(&coords, [i[11], i[12], i[13]], i[14], i[15])?;
    for k in 0..3 {
        coords[0][k] = f(coords[0][k] - -f(i[16 + k]));
    }
    Some(coords)
}

fn bits(x: f64) -> u32 {
    (x as f32).to_bits()
}

/// brush-bounds.mjs nativePoint: `delta = corner - origin` (64-bit significand),
/// then the three axis dot products as `(d0*a0 + d1*a1) + d2*a2`, each product
/// and sum rounded to 64 bits, stored once to float32. None where the
/// JavaScript's double rounding or signed zero could differ (a nonzero value in
/// the float32 subnormal range or below).
fn native_point(corner: [f64; 3], c: &Coords) -> Option<[f64; 3]> {
    let mut delta = [Ext::zero(0); 3];
    for k in 0..3 {
        delta[k] = Ext::load(bits(corner[k])).add(Ext::load(bits(c[0][k])).neg());
    }
    let mut out = [0.0; 3];
    for axis in 0..3 {
        let row = &c[axis + 1];
        let p0 = delta[0].mul(Ext::load(bits(row[0])));
        let p1 = delta[1].mul(Ext::load(bits(row[1])));
        let p2 = delta[2].mul(Ext::load(bits(row[2])));
        let value = p0.add(p1).add(p2);
        if value.sig == 0 {
            out[axis] = 0.0;
            continue;
        }
        let word = value.store();
        if (word >> 23) & 0xff == 0 {
            return None;
        }
        out[axis] = f32::from_bits(word) as f64;
    }
    Some(out)
}

/// The world box of the brush at the pose in BOUNDS_IN: 1 with BOUNDS_OUT
/// written, 0 for the JavaScript to answer.
#[no_mangle]
pub extern "C" fn brush_bounds() -> u32 {
    let input = unsafe { *addr_of!(BOUNDS_IN) };
    let ok = (|| {
        if input.iter().any(|v| !v.is_finite()) {
            return None;
        }
        let coords = brush_to_world(&input)?;
        // Nothing the corner expression reads may be non-finite (the JavaScript throws).
        if coords.iter().flatten().any(|v| !(*v as f32).is_finite()) {
            return None;
        }
        let (lo, hi) = ([input[19], input[20], input[21]], [input[22], input[23], input[24]]);
        if lo.iter().chain(hi.iter()).any(|v| !(*v as f32).is_finite()) {
            return None;
        }
        let mut min = [0.0; 3];
        let mut max = [0.0; 3];
        for n in 0..8 {
            let corner = [if n & 4 != 0 { hi[0] } else { lo[0] }, if n & 2 != 0 { hi[1] } else { lo[1] }, if n & 1 != 0 { hi[2] } else { lo[2] }];
            let point = native_point(corner, &coords)?;
            if n == 0 {
                min = point;
                max = point;
            } else {
                for k in 0..3 {
                    if point[k] < min[k] {
                        min[k] = point[k];
                    }
                    if point[k] > max[k] {
                        max[k] = point[k];
                    }
                }
            }
        }
        Some((min, max))
    })();
    match ok {
        Some((min, max)) => {
            unsafe { *addr_of_mut!(BOUNDS_OUT) = [min[0], min[1], min[2], max[0], max[1], max[2]] };
            1
        }
        None => 0,
    }
}
