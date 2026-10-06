//! FDynamicSprite::Setup (Render.dll 0x10b23910..0x10b23d9c): an actor's
//! integer screen rectangle [X1, X2) x [Y1, Y2) and its depth Z, which
//! SetupDynamics' FDynamicSprite constructor (0x10b233c0, occlude.rs
//! `setup_sprites`) turns into the chunk OccludeBsp filters
//! (docs/bsp-occlusion.md "Setup").
//!
//! Setup runs inside DrawWorld, under URender::PreRender's
//! appEnableFastMath(1) (precision control 24): each x87 add, subtract,
//! multiply and divide rounds to a 24-bit significand, which for the finite,
//! normal-range values here is binary32 arithmetic in the instructions'
//! order (as in occlude.rs). Its callees run at that precision too: Engine
//! UMesh::GetRenderBoundingBox (0x103a6850) with UMesh::GetAnimSeq
//! (0x1031c000) and Core's FBox::operator+= (0x101196a0),
//! FCoords::operator/=(FRotator) (0x1011b690), FCoords::Transpose
//! (0x1011a140) and FBox::TransformBy (0x101198f0); Render
//! URender::BoundVisible (0x10b162e0, occlude.rs `bound_visible_box`) and
//! URender::Project (0x10b20750); Core appCeil (0x10123300: msvcrt `ceil`
//! on the double, then `_ftol`).
//!
//! The host packs one candidate per actor SetupDynamics constructs a sprite
//! for (and per render-iterator item), in that order; `occ_setup` writes each
//! one's result and appends the accepted rectangles to occ_run's sprite list
//! (MODEL words 17 and 18), so the dynamics see exactly the constructor's
//! successes in order. GetAnimSeq's FName match is the host's: a candidate
//! carries the matched sequence's StartFrame and NumFrames.
//!
//! Not covered (explicit): the orthographic RendMaps 13-15 (Setup's depth
//! test and Project's orthographic branches) and SHOW_ActorIcons (0x20);
//! Play's viewer has RendMap 5 and ShowFlags 0x480c. Values outside
//! binary32's normal range, as in occlude.rs.

use crate::occlude::{bound_visible_box, ff, fistp, frame, model, set_model, View};

// Candidate words (CW per candidate).
const C_KEY: u32 = 0;
/// Actor.DrawType (+0x164).
const C_DRAWTYPE: u32 = 1;
/// The mesh record's address; 0 when Actor.Mesh (+0x174) is None, 1 when it
/// is set but the host has no record for it.
const C_MESH: u32 = 2;
/// Actor.Texture (+0x16c): 0 None, 1 with its USize/VSize below, 2 set but
/// its sizes are not known to the host.
const C_TEXTURE: u32 = 3;
const C_USIZE: u32 = 4;
const C_VSIZE: u32 = 5;
const C_LOCATION: u32 = 6;
const C_ROTATION: u32 = 9;
const C_DRAWSCALE: u32 = 12;
const C_PREPIVOT: u32 = 13;
/// bParticles (+0x194 & 4).
const C_PARTICLES: u32 = 16;
/// Whether GetAnimSeq(AnimSequence) found a sequence (0 NULL, 1 found),
/// then its StartFrame and NumFrames.
const C_SEQ: u32 = 17;
const C_SEQ_START: u32 = 18;
const C_SEQ_FRAMES: u32 = 19;
const C_ANIMFRAME: u32 = 20;
/// Bit 0: SetupDynamics does not construct this actor's sprite in a root
/// frame (Recursion 0): the excluded actor OccludeFrame passes (0x10b1a161:
/// the ViewTarget, else the view actor, unless bBehindView) and the
/// ViewTarget (0x10b22e3c..0x10b22e57, Recursion 0 and not bBehindView).
/// A child frame passes no excluded actor and skips no ViewTarget.
const C_FLAGS: u32 = 21;
pub(crate) const CW: u32 = 22;

// Mesh record words: BoundingBox (+0x28: Min, Max, IsValid), Scale (+0x100),
// Origin (+0x10c), RotOrigin (+0x118), then BoundingBoxes (+0xa8): the
// address of its 7-word boxes and their count.
const M_BOX: u32 = 0;
const M_SCALE: u32 = 7;
const M_ORIGIN: u32 = 10;
const M_ROTORIGIN: u32 = 13;
const M_BOXES: u32 = 16;
const M_BOX_COUNT: u32 = 17;

// Result words (OW per candidate): status, X1, Y1, X2, Y2, Z bits, then the
// sprite path's ScreenX, ScreenY and Persp bits (0 on the mesh path).
pub(crate) const OW: u32 = 9;
/// Setup returned 0.
const REJECTED: u32 = 0;
/// Setup returned 1.
const ACCEPTED: u32 = 1;
/// The host lacks the mesh record or the texture's sizes: not evaluated.
const UNKNOWN: u32 = 3;
/// A frame box index the original would read outside BoundingBoxes, or a
/// sequence with no frames (idiv by zero): unsupported.
const UNSUPPORTED: u32 = 4;
/// Not constructed in this frame (C_FLAGS bit 0 in a root frame).
const NOT_CONSTRUCTED: u32 = 5;

#[inline(always)]
fn rd(address: u32) -> u32 {
    unsafe { core::ptr::read(address as *const u32) }
}
#[inline(always)]
fn wr(address: u32, value: u32) {
    unsafe { core::ptr::write(address as *mut u32, value) }
}
#[inline(always)]
fn rf(address: u32) -> f32 {
    f32::from_bits(rd(address))
}
fn rf3(address: u32) -> [f32; 3] {
    [rf(address), rf(address + 4), rf(address + 8)]
}
fn sin(angle: i32) -> f32 {
    f32::from_bits(crate::rotator_sin(angle))
}
fn cos(angle: i32) -> f32 {
    sin(angle.wrapping_add(0x4000))
}
/// ((v.x*a.x + v.y*a.y) + v.z*a.z), the order of FVector | FVector, the
/// coords passes and the TransformBy rows.
#[inline(always)]
fn dot(v: [f32; 3], a: [f32; 3]) -> f32 {
    (v[0] * a[0] + v[1] * a[1]) + v[2] * a[2]
}

/// MSVC `_ftol`: truncation to int64, the low dword (the int64 indefinite,
/// 0x8000000000000000, for NaN and out-of-range values: low dword 0).
fn ftol(x: f64) -> i32 {
    if !(x > -9223372036854775808.0 && x < 9223372036854775808.0) {
        return 0;
    }
    (x as i64) as i32
}

/// The exact ceiling of a float32 value as a double (msvcrt `ceil`;
/// finite results are integers, which binary64 holds exactly here).
fn ceil(x: f32) -> f64 {
    let bits = x.to_bits();
    let exponent = ((bits >> 23) & 0xff) as i32 - 127;
    if exponent >= 23 {
        return x as f64; // already an integer, or NaN/infinity
    }
    if exponent < 0 {
        // |x| < 1: -0.x gives -0, +0.x gives 1, zeros stay.
        if bits & 0x7fff_ffff == 0 {
            return x as f64;
        }
        return if bits >> 31 != 0 { -0.0 } else { 1.0 };
    }
    let fraction = 0x007f_ffff_u32 >> exponent;
    if bits & fraction == 0 {
        return x as f64;
    }
    let truncated = f32::from_bits(bits & !fraction) as f64;
    if bits >> 31 != 0 { truncated } else { truncated + 1.0 }
}

/// appCeil(f) then Setup's `fild; fstp dword; fld; fistp` round trip.
fn ceil_round_trip(x: f32) -> i32 {
    fistp(ftol(ceil(x)) as f32)
}

/// A float32 value plus a double constant, rounded once to a 24-bit
/// significand (`fadd qword` at precision control 24): the binary64 sum
/// with its exact error (TwoSum) decides a binary32 tie.
fn add_double(a: f32, b: f64) -> f32 {
    let a = a as f64;
    let s = a + b;
    let bb = s - a;
    let err = (a - (s - bb)) + (b - bb);
    let r = s as f32;
    if err == 0.0 || !s.is_finite() {
        return r;
    }
    let rd64 = r as f64;
    if rd64 == s {
        return r; // |err| is far below half a binary32 unit
    }
    // The binary32 neighbour on the other side of s.
    let other = if rd64 > s { next_toward_zero_or_down(r) } else { next_up(r) };
    let mid = (rd64 + other as f64) * 0.5;
    if s != mid {
        return r;
    }
    // s is a tie: the exact sum lies on the side of its error.
    if (err > 0.0) == (other as f64 > rd64) { other } else { r }
}
fn next_up(x: f32) -> f32 {
    let b = x.to_bits();
    if x == 0.0 {
        return f32::from_bits(1);
    }
    f32::from_bits(if b >> 31 == 0 { b + 1 } else { b - 1 })
}
fn next_toward_zero_or_down(x: f32) -> f32 {
    let b = x.to_bits();
    if x == 0.0 {
        return f32::from_bits(0x8000_0001);
    }
    f32::from_bits(if b >> 31 == 0 { b - 1 } else { b + 1 })
}

#[derive(Clone, Copy)]
struct Box {
    min: [f32; 3],
    max: [f32; 3],
    valid: bool,
}
fn load_box(address: u32) -> Box {
    Box { min: rf3(address), max: rf3(address + 12), valid: rd(address + 24) & 0xff != 0 }
}

/// FBox::operator+=(const FBox&) (Core 0x101196a0): with both boxes valid,
/// Min = (this <= other or unordered) ? this : other and Max = (this <
/// other or unordered) ? other : this; otherwise the other box is copied,
/// IsValid included.
fn union(a: Box, b: Box) -> Box {
    if !(a.valid && b.valid) {
        return b;
    }
    let mut r = a;
    for i in 0..3 {
        r.min[i] = if a.min[i] > b.min[i] { b.min[i] } else { a.min[i] };
        r.max[i] = if a.max[i] >= b.max[i] { a.max[i] } else { b.max[i] };
    }
    r
}

/// FCoords::operator/=(FRotator) on the axes: the roll, pitch and yaw
/// passes of ComputeRenderCoords' view coordinates (occlude.rs
/// `view_coords`), here at precision 24.
fn rotate(axes: [[f32; 3]; 3], rotation: [i32; 3]) -> [[f32; 3]; 3] {
    let (pitch, yaw, roll) = (rotation[0], rotation[1], rotation[2]);
    let passes = [
        [[1.0, 0.0, 0.0], [0.0, cos(roll), sin(roll)], [0.0, -sin(roll), cos(roll)]],
        [[cos(pitch), 0.0, -sin(pitch)], [0.0, 1.0, 0.0], [sin(pitch), 0.0, cos(pitch)]],
        [[cos(yaw), -sin(yaw), 0.0], [sin(yaw), cos(yaw), 0.0], [0.0, 0.0, 1.0]],
    ];
    let mut out = axes;
    for rows in &passes {
        for axis in out.iter_mut() {
            let v = *axis;
            *axis = [dot(v, rows[0]), dot(v, rows[1]), dot(v, rows[2])];
        }
    }
    out
}

/// UMesh::GetRenderBoundingBox(Owner, Exact) (Engine 0x103a6850): None when
/// the original would read past BoundingBoxes or divide by zero.
fn render_bounding_box(mesh: u32, c: u32) -> Option<Box> {
    let mut source = load_box(mesh + 4 * M_BOX);
    let frames = rd(c + 4 * C_SEQ_FRAMES) as i32;
    let anim_frame = rf(c + 4 * C_ANIMFRAME);
    // GetAnimSeq found the sequence and AnimFrame >= 0 (0x103a6898).
    if rd(c + 4 * C_SEQ) != 0 && anim_frame >= 0.0 {
        let start = rd(c + 4 * C_SEQ_START) as i32;
        // fadd qword 1.0, fimul NumFrames, fstp; fsub 0.5f, fistp.
        let phase = (anim_frame + 1.0) * frames as f32;
        let index = fistp(phase - 0.5);
        // idiv by zero, or the INT_MIN / -1 overflow: a fault there.
        if frames == 0 || frames == -1 && (index == i32::MIN || index == i32::MAX) {
            return None;
        }
        let first = (index.wrapping_rem(frames)).wrapping_add(start);
        let second = (index.wrapping_add(1).wrapping_rem(frames)).wrapping_add(start);
        let count = rd(mesh + 4 * M_BOX_COUNT) as i32;
        if first < 0 || first >= count || second < 0 || second >= count {
            return None;
        }
        let boxes = rd(mesh + 4 * M_BOXES);
        source = union(load_box(boxes + 28 * first as u32), load_box(boxes + 28 * second as u32));
    }
    let factor = if rd(c + 4 * C_PARTICLES) != 0 { 1.5 } else { rf(c + 4 * C_DRAWSCALE) };
    let scale = rf3(mesh + 4 * M_SCALE);
    let origin = rf3(mesh + 4 * M_ORIGIN);
    let scaled = [factor * scale[0], factor * scale[1], factor * scale[2]];
    // Max: X and Y are stored products, Z keeps both factors on the stack
    // (the same at precision 24); Min through Core's FVector constructor.
    let mut min = [0.0_f32; 3];
    let mut max = [0.0_f32; 3];
    for i in 0..3 {
        max[i] = scaled[i] * (source.max[i] - origin[i]) + 1.0;
        min[i] = scaled[i] * (source.min[i] - origin[i]) - 1.0;
    }
    // GMath.UnitCoords /= RotOrigin, then /= Owner->Rotation.
    let rot_origin = [
        rd(mesh + 4 * M_ROTORIGIN) as i32,
        rd(mesh + 4 * M_ROTORIGIN + 4) as i32,
        rd(mesh + 4 * M_ROTORIGIN + 8) as i32,
    ];
    let rotation = [
        rd(c + 4 * C_ROTATION) as i32,
        rd(c + 4 * C_ROTATION + 4) as i32,
        rd(c + 4 * C_ROTATION + 8) as i32,
    ];
    let unit = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let axes = rotate(rotate(unit, rot_origin), rotation);
    let location = rf3(c + 4 * C_LOCATION);
    let pivot = rf3(c + 4 * C_PREPIVOT);
    let o = [location[0] + pivot[0], pivot[1] + location[1], pivot[2] + location[2]];
    // Transpose: the axes' columns, and the origin -(O | X, O | Y, O | Z).
    let rows = [
        [axes[0][0], axes[1][0], axes[2][0]],
        [axes[0][1], axes[1][1], axes[2][1]],
        [axes[0][2], axes[1][2], axes[2][2]],
    ];
    let t_origin = [-dot(o, axes[0]), -dot(o, axes[1]), -dot(o, axes[2])];
    // TransformBy: the eight corners, X outermost, Z innermost.
    let mut out = Box { min: [0.0; 3], max: [0.0; 3], valid: true };
    let mut first_corner = true;
    for x in 0..2 {
        for y in 0..2 {
            for z in 0..2 {
                let p = [if x == 0 { min[0] } else { max[0] }, if y == 0 { min[1] } else { max[1] },
                    if z == 0 { min[2] } else { max[2] }];
                let local = [p[0] - t_origin[0], p[1] - t_origin[1], p[2] - t_origin[2]];
                let q = [dot(local, rows[0]), dot(local, rows[1]), dot(local, rows[2])];
                if first_corner {
                    out.min = q;
                    out.max = q;
                    first_corner = false;
                    continue;
                }
                for i in 0..3 {
                    if out.min[i] > q[i] {
                        out.min[i] = q[i];
                    }
                    if out.max[i] < q[i] || out.max[i].is_nan() || q[i].is_nan() {
                        out.max[i] = q[i];
                    }
                }
            }
        }
    }
    Some(out)
}

/// The frame's view for BoundVisible and Project.
fn view() -> View {
    View {
        origin: [ff(0), ff(1), ff(2)],
        axes: [[ff(3), ff(4), ff(5)], [ff(6), ff(7), ff(8)], [ff(9), ff(10), ff(11)]],
        prj: [ff(21), ff(22), ff(23), ff(24)],
        proj_z: ff(20),
        fx15: ff(14),
        fy15: ff(15),
    }
}

/// Setup's depth (0x10b239b9 / 0x10b23b24): ((L.z-O.z)*Z.z + (L.y-O.y)*Z.y)
/// + (L.x-O.x)*Z.x.
fn depth(location: [f32; 3], view: &View) -> f32 {
    let o = view.origin;
    let z = view.axes[2];
    ((location[2] - o[2]) * z[2] + (location[1] - o[1]) * z[1]) + (location[0] - o[0]) * z[0]
}

/// URender::Project (0x10b20750), perspective: ScreenX, ScreenY, Persp, or
/// None when the depth is not above 1.
fn project(location: [f32; 3], view: &View, fx2: f32, fy2: f32) -> (f32, f32, f32, bool) {
    let o = view.origin;
    let d = [location[0] - o[0], location[1] - o[1], location[2] - o[2]];
    let t = [dot(d, view.axes[0]), dot(d, view.axes[1]), dot(d, view.axes[2])];
    let mut z = t[2];
    // |T.z| < 0.01 (double): T.z + 0.02 (double).
    let magnitude = if t[2] < 0.0 || t[2].is_nan() { -t[2] } else { t[2] };
    if !((magnitude as f64) >= 0.01) {
        z = add_double(t[2], 0.02);
    }
    let rz = view.proj_z / z;
    let sx = t[0] * rz + fx2;
    let sy = t[1] * rz + fy2;
    (sx, sy, rz, z > 1.0)
}

/// Setup's sprite clamps for one axis (X: 0x10b23c19..0x10b23c9a, Y:
/// 0x10b23d02..0x10b23d84).
fn clamp_axis(mut a: i32, mut b: i32, size: i32) -> (i32, i32) {
    if a > b {
        core::mem::swap(&mut a, &mut b);
    }
    if a < 0 {
        a = 0;
        if b < 0 {
            b = 0;
        }
    }
    if b > size {
        b = size;
        if a > size {
            a = size;
        }
    }
    (a, b)
}

/// FDynamicSprite::Setup on candidate `c`; writes the result words to `r`.
fn setup(c: u32, r: u32, view: &View) -> u32 {
    let (width, height) = (frame(12) as i32, frame(13) as i32);
    let (fx2, fy2) = (ff(16), ff(17));
    for k in 0..OW {
        wr(r + 4 * k, 0);
    }
    let location = rf3(c + 4 * C_LOCATION);
    let draw_type = rd(c + 4 * C_DRAWTYPE) & 0xff;
    if draw_type == 1 || draw_type == 7 {
        // The sprite path (0x10b23ada).
        match rd(c + 4 * C_TEXTURE) {
            0 => return REJECTED,
            1 => {}
            _ => return UNKNOWN,
        }
        let z = depth(location, view);
        wr(r + 20, z.to_bits());
        if z < 0.0 || z.is_nan() {
            return REJECTED;
        }
        let (sx, sy, persp, ok) = project(location, view, fx2, fy2);
        wr(r + 24, sx.to_bits());
        wr(r + 28, sy.to_bits());
        wr(r + 32, persp.to_bits());
        if !ok {
            return REJECTED;
        }
        let draw_scale = rf(c + 4 * C_DRAWSCALE);
        let usize = rd(c + 4 * C_USIZE) as i32 as f32;
        let hw = ((usize * draw_scale) * persp) * 0.5;
        let (x1, x2) = clamp_axis(ceil_round_trip(sx - hw), ceil_round_trip(hw + sx), width);
        wr(r + 4, x1 as u32);
        wr(r + 12, x2 as u32);
        if x2 <= 0 || x1 >= width - 1 {
            return REJECTED;
        }
        let vsize = rd(c + 4 * C_VSIZE) as i32 as f32;
        let hv = ((vsize * draw_scale) * persp) * 0.5;
        let (y1, y2) = clamp_axis(ceil_round_trip(sy - hv), ceil_round_trip(hv + sy), height);
        wr(r + 8, y1 as u32);
        wr(r + 16, y2 as u32);
        if y2 <= 0 || y1 >= height || y1 >= y2 {
            return REJECTED;
        }
        return ACCEPTED;
    }
    // The mesh path (0x10b239a3): DT_Mesh with a Mesh.
    let mesh = rd(c + 4 * C_MESH);
    if draw_type != 2 || mesh == 0 {
        return REJECTED;
    }
    let z = depth(location, view);
    wr(r + 20, z.to_bits());
    if z < 0.0 || z.is_nan() {
        return REJECTED;
    }
    if mesh == 1 {
        return UNKNOWN;
    }
    let Some(b) = render_bounding_box(mesh, c) else {
        return UNSUPPORTED;
    };
    let Some(s) = bound_visible_box(b.min, b.max, view, width, height, fx2, fy2) else {
        return REJECTED;
    };
    // The clamped FScreenBounds floats, back through _ftol.
    let (x1, y1, x2, y2) = (s[0].max(0), s[1].max(0), s[2].min(width), s[3].min(height));
    wr(r + 4, x1 as u32);
    wr(r + 8, y1 as u32);
    wr(r + 12, x2 as u32);
    wr(r + 16, y2 as u32);
    if y1 < y2 { ACCEPTED } else { REJECTED }
}

/// Setup for `count` candidates at `candidates` (CW words each) on the
/// frame words (a root frame skips the candidates C_FLAGS excludes): results
/// to `out` (OW words each); the accepted ones, in
/// order, become occ_run's sprite list (MODEL 17, 6 words each: key, X1, Y1,
/// X2, Y2, Z bits), whose capacity the host keeps at least `count`. Returns
/// the number accepted.
#[no_mangle]
pub extern "C" fn occ_setup(candidates: u32, count: u32, out: u32) -> u32 {
    let view = view();
    let list = model(17);
    let mut accepted = 0;
    let root = frame(43) == 0;
    for i in 0..count {
        let c = candidates + 4 * CW * i;
        let r = out + 4 * OW * i;
        if root && rd(c + 4 * C_FLAGS) & 1 != 0 {
            wr(r, NOT_CONSTRUCTED);
            continue;
        }
        let status = setup(c, r, &view);
        wr(r, status);
        if status == ACCEPTED && list != 0 {
            let s = list + 24 * accepted;
            wr(s, rd(c + 4 * C_KEY));
            for k in 1..6 {
                wr(s + 4 * k, rd(r + 4 * k));
            }
            accepted += 1;
        }
    }
    set_model(18, accepted);
    accepted
}
