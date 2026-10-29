//! The x87 tails of five JavaScript callers, off the BigInt model (docs/live-heap.md
//! "Cut: x87 math in Rust"): each export transcribes one JavaScript function step
//! for step on `Ext`, and the JavaScript function stays as the reference (it runs
//! where the kernel is not loaded). scripts/validate-x87-callers-kernel.mjs compares
//! them over random and special float32 words.
//!
//! * `phys_interpolation_velocity`: actor-physics.mjs `interpolationVelocity`
//!   (PHYS_Interpolating and PHYS_MovingBrush velocities, 0x103c9801..0x103c9b9a).
//! * `fcoords_axes_out`: script-pawn-locomotion.mjs `fcoordsAxes` (Core
//!   FCoords::FCoords(FRotator) 0x1011b690), whose Rust form percep.rs already holds.
//! * `los_*`: script-pawn-perception.mjs `losWorker`'s and `nearPath`'s sums and
//!   products (Engine 0x103beb50).
//! * `rider_*`: move-riders.mjs `moveActorRiders`' per-rider arithmetic
//!   (Engine 0x103998a0..0x10399bb0).
//!
//! Values cross as float32 words; three-component results are written to the
//! module's RESULT (`out3`), the twelve words of FCoords to FCOORDS.

use crate::x87::Ext;
use crate::{out3, rotator_sin, safe_normal};

const ONE: u32 = 0x3f80_0000;

fn ld(bits: u32) -> Ext {
    Ext::load(bits)
}
fn sub(a: Ext, b: Ext) -> Ext {
    a.add(b.neg())
}
/// `(a0*b0 + a1*b1) + a2*b2`, left on the stack (the JavaScript `dot3` of
/// script-pawn-perception.mjs, no store).
fn dot_ext(a: [u32; 3], b: [u32; 3]) -> Ext {
    ld(a[0]).mul(ld(b[0])).add(ld(a[1]).mul(ld(b[1]))).add(ld(a[2]).mul(ld(b[2])))
}
/// The same with a stack operand and one float store (script-pawn-locomotion.mjs
/// and move-riders.mjs `dot3`).
fn dot3(t: [Ext; 3], r: [u32; 3]) -> u32 {
    t[0].mul(ld(r[0])).add(t[1].mul(ld(r[1]))).add(t[2].mul(ld(r[2]))).store()
}

// ---- actor-physics.mjs interpolationVelocity ----------------------------------------

/// X/Y differences and the reciprocal are float32 stores; Z keeps both extended
/// (docs/script-pawn-physics.md; actor-physics.mjs `interpolationVelocity`).
#[no_mangle]
pub extern "C" fn phys_interpolation_velocity(l0: u32, l1: u32, l2: u32, o0: u32, o1: u32, o2: u32, seconds: u32) {
    let difference = |l: u32, o: u32| ld(l).add(ld(o).neg());
    let reciprocal = ld(ONE).div(ld(seconds));
    let stored = ld(reciprocal.store());
    let d = [difference(l0, o0), difference(l1, o1), difference(l2, o2)];
    out3([
        ld(d[0].store()).mul(stored).store(),
        ld(d[1].store()).mul(stored).store(),
        d[2].mul(reciprocal).store(),
    ]);
}

// ---- script-pawn-locomotion.mjs fcoordsAxes -----------------------------------------

static mut FCOORDS: [u32; 12] = [0; 12];
#[no_mangle]
pub extern "C" fn fcoords_ptr() -> *const u32 {
    core::ptr::addr_of!(FCOORDS) as *const u32
}
/// FCoords(FRotator(pitch, yaw, roll)): Origin, XAxis, YAxis, ZAxis as twelve
/// float32 words at FCOORDS.
#[no_mangle]
pub extern "C" fn fcoords_axes_out(pitch: i32, yaw: i32, roll: i32) {
    let fields = crate::percep::fcoords_axes([pitch, yaw, roll]);
    unsafe {
        let out = &mut *core::ptr::addr_of_mut!(FCOORDS);
        for (i, field) in fields.iter().enumerate() {
            for (k, v) in field.iter().enumerate() {
                out[i * 3 + k] = (*v as f32).to_bits();
            }
        }
    }
}

// ---- script-pawn-perception.mjs losWorker -------------------------------------------

/// `st(magsq3(v))`: (x*x + y*y) + z*z, one float store.
#[no_mangle]
pub extern "C" fn los_magsq3(x: u32, y: u32, z: u32) -> u32 {
    ld(x).mul(ld(x)).add(ld(y).mul(ld(y))).add(ld(z).mul(ld(z))).store()
}

/// `st(x87mul(s, s))` with `s = x87mul(a, b)` kept extended: the squared,
/// scaled visibility of the flat and FOV caps.
#[no_mangle]
pub extern "C" fn los_square_product(a: u32, b: u32) -> u32 {
    let s = ld(a).mul(ld(b));
    s.mul(s).store()
}

/// The FOV path's Stimulus (0x103bec11..): dot = forward . SafeNormal(delta) kept
/// extended; t = dot - PeripheralVision; (t * (0.8 if t > 0 else 0.17)) + 0.2,
/// one float store. `fwd` is the Rotation's X axis.
#[no_mangle]
pub extern "C" fn los_stimulus(d0: u32, d1: u32, d2: u32, f0: u32, f1: u32, f2: u32, peripheral: u32) -> u32 {
    let unit = safe_normal([d0, d1, d2]);
    let t = sub(dot_ext([f0, f1, f2], unit), ld(peripheral));
    // x87compare(t, ZERO): C0 below, C3 equal, both when unordered.
    let (below, equal) = t.compare(Ext::zero(0));
    let k = Ext::load_f64(if below || equal { 0.17 } else { 0.8 });
    t.mul(k).add(Ext::load_f64(0.2)).store()
}

/// The FOV path's distance (0x103bee1f..): dzScaled = float(|dz| / divisor);
/// (distSq + dzScaled^2) / Stimulus^2, one float store.
#[no_mangle]
pub extern "C" fn los_scaled(dist_sq: u32, dz_abs: u32, divisor: u32, stimulus: u32) -> u32 {
    let dz_scaled = ld(ld(dz_abs).div(ld(divisor)).store());
    ld(dist_sq).add(dz_scaled.mul(dz_scaled)).div(ld(stimulus).mul(ld(stimulus))).store()
}

// ---- move-riders.mjs moveActorRiders -------------------------------------------------

/// FCoords::operator*=(FRotator) of GMath.UnitCoords for the yaw-only reduced rotation
/// (0x1011ac80; move-riders.mjs `unitCoordsTimesYaw`): the X, Y and Z axes' words.
fn unit_coords_times_yaw(yaw: i32) -> [[u32; 3]; 3] {
    let (s, c) = (rotator_sin(yaw), rotator_sin(yaw.wrapping_add(0x4000)));
    let axes: [[u32; 3]; 4] = [[0, 0, 0], [c, s, 0], [s ^ 0x8000_0000, c, 0], [0, 0, ONE]];
    let unit: [[u32; 3]; 4] = [[0, 0, 0], [ONE, 0, 0], [0, ONE, 0], [0, 0, ONE]];
    // Field 0, the origin, is TransformPointBy of (0, 0, 0): the caller reads the three axes only.
    let mut fields = [[0u32; 3]; 3];
    for (i, v) in unit.iter().enumerate().skip(1) {
        let t = [ld(v[0]), ld(v[1]), ld(v[2])];
        fields[i - 1] = [dot3(t, axes[1]), dot3(t, axes[2]), dot3(t, axes[3])];
    }
    fields
}

/// A rider's RotMotion (0x10399939..0x10399a27): v = Actor.Location - Other.Location
/// (float stores); t = v transformed by UnitCoords *= ReducedRotation; v - t
/// (float stores).
#[no_mangle]
pub extern "C" fn rider_rot_motion(a0: u32, a1: u32, a2: u32, o0: u32, o1: u32, o2: u32, reduced_yaw: i32) {
    let v = [sub(ld(a0), ld(o0)).store(), sub(ld(a1), ld(o1)).store(), sub(ld(a2), ld(o2)).store()];
    let coords = unit_coords_times_yaw(reduced_yaw);
    let tv = [ld(v[0]), ld(v[1]), ld(v[2])];
    out3([
        sub(ld(v[0]), ld(dot3(tv, coords[0]))).store(),
        sub(ld(v[1]), ld(dot3(tv, coords[1]))).store(),
        sub(ld(v[2]), ld(dot3(tv, coords[2]))).store(),
    ]);
}

/// A rider's delta (0x10399ad1): FinalDelta + RotMotion, three float adds.
#[no_mangle]
pub extern "C" fn rider_delta(f0: u32, f1: u32, f2: u32, r0: u32, r1: u32, r2: u32) {
    out3([ld(f0).add(ld(r0)).store(), ld(f1).add(ld(r1)).store(), ld(f2).add(ld(r2)).store()]);
}
