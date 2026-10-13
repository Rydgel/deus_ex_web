//! The Rust script core (docs/rust-core.md, step R2b). This first part is
//! the x87 operator kernel: Core's float, vector and rotator operator bodies
//! that the JavaScript VM (src/runtime/script-vm.mjs, `native`) computes with
//! its BigInt x87 model. Each export transcribes one case of that function,
//! step for step; the case comments there hold the native evidence.
//!
//! Values cross as float32 bit patterns (u32) and int32 words, never as
//! floats, so NaN payloads and signed zeros are exact. Three-component
//! results are written to `RESULT`.
#![no_std]

mod hash;
mod move_actor;
mod move_pawn;
mod decal;
mod dispatch;
mod interp;
mod level;
mod fire;
mod fall;
mod fly;
mod light;
mod spatial;
mod fog;
mod gc;
mod lipsync;
mod loco;
mod natives;
mod percep;
mod render;
mod meshlight;
mod occlude;
mod p24;
mod setup;
mod tracker;
mod particles;
mod pawn_phys;
mod swim;
mod sptick;
mod tick;
mod trace;
mod walk;
mod walk_loop;
mod zone;
mod x87;
use x87::{Ext, INDEFINITE};

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

static mut RESULT: [u32; 3] = [0; 3];
// Core FGlobalMath's float32 sine table (src/runtime/coords.mjs,
// rotationSineTable), uploaded by the host: its values come from the same
// double sine the JavaScript model uses.
static mut SINE: [u32; 0x4000] = [0; 0x4000];

#[no_mangle]
pub extern "C" fn result_ptr() -> *const u32 {
    core::ptr::addr_of!(RESULT) as *const u32
}
#[no_mangle]
pub extern "C" fn sine_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(SINE) as *mut u32
}

fn out3(values: [u32; 3]) {
    unsafe { *core::ptr::addr_of_mut!(RESULT) = values };
}
fn outi3(values: [i32; 3]) {
    out3([values[0] as u32, values[1] as u32, values[2] as u32]);
}
fn load3(x: u32, y: u32, z: u32) -> [Ext; 3] {
    [Ext::load(x), Ext::load(y), Ext::load(z)]
}
pub(crate) fn rotator_sin(angle: i32) -> u32 {
    unsafe { (*core::ptr::addr_of!(SINE))[((angle >> 2) & 0x3fff) as usize] }
}
const ONE: u32 = 0x3f80_0000;

/// DivideEqual_IntFloat (160): the int result (also the out value).
#[no_mangle]
pub extern "C" fn op_divide_equal_int_float(a: i32, b: u32) -> i32 {
    let divisor = Ext::load(b);
    if divisor.nan() || (!divisor.inf() && divisor.sig == 0) {
        return 0;
    }
    Ext::load_i32(a).div(divisor).ftol()
}

/// Percent_FloatFloat (173).
#[no_mangle]
pub extern "C" fn op_percent(a: u32, b: u32) -> u32 {
    let x = Ext::load(a);
    let y = Ext::load(b);
    if x.nan() || y.nan() {
        return x.add(y).store();
    }
    if y.sig == 0 || x.inf() || y.inf() {
        return INDEFINITE;
    }
    // Finite nonzero operands: the exact fmod, always a float32.
    let r = f32::from_bits(a) as f64 % f32::from_bits(b) as f64;
    if r == 0.0 { 0 } else { (r as f32).to_bits() }
}

/// Sqrt (193).
#[no_mangle]
pub extern "C" fn op_sqrt(a: u32) -> u32 {
    let d = Ext::load(a);
    if d.nan() {
        d.quiet().store()
    } else if d.negative() && (d.inf() || d.sig != 0) {
        INDEFINITE
    } else {
        d.sqrt().store()
    }
}

/// Square (194).
#[no_mangle]
pub extern "C" fn op_square(a: u32) -> u32 {
    let d = Ext::load(a);
    d.mul(d).store()
}

/// Dot_VectorVector (219): px + (py + pz), one store.
#[no_mangle]
pub extern "C" fn op_dot(a0: u32, a1: u32, a2: u32, b0: u32, b1: u32, b2: u32) -> u32 {
    let px = Ext::load(a0).mul(Ext::load(b0));
    let py = Ext::load(a1).mul(Ext::load(b1));
    let pz = Ext::load(a2).mul(Ext::load(b2));
    px.add(py.add(pz)).store()
}

/// MultiplyEqual_VectorFloat (221).
#[no_mangle]
pub extern "C" fn op_multiply_equal_vector_float(a0: u32, a1: u32, a2: u32, b: u32) {
    let s = Ext::load(b);
    let a = load3(a0, a1, a2);
    out3([a[0].mul(s).store(), a[1].mul(s).store(), a[2].mul(s).store()]);
}

/// DivideEqual_VectorFloat (222): the 80-bit reciprocal, then products.
#[no_mangle]
pub extern "C" fn op_divide_equal_vector_float(a0: u32, a1: u32, a2: u32, b: u32) {
    let d = Ext::load(b);
    let r = if d.nan() {
        d.quiet()
    } else if d.inf() {
        Ext::zero(d.sign)
    } else if d.sig == 0 {
        Ext::load(d.sign | 0x7f80_0000)
    } else {
        Ext::load(ONE).div(d)
    };
    let a = load3(a0, a1, a2);
    out3([a[0].mul(r).store(), a[1].mul(r).store(), a[2].mul(r).store()]);
}

/// SubtractEqual_VectorVector (224).
#[no_mangle]
pub extern "C" fn op_subtract_equal_vector_vector(a0: u32, a1: u32, a2: u32, b0: u32, b1: u32, b2: u32) {
    let a = load3(a0, a1, a2);
    let b = load3(b0, b1, b2);
    out3([a[0].add(b[0].neg()).store(), a[1].add(b[1].neg()).store(), a[2].add(b[2].neg()).store()]);
}

/// VSize (225, Core 0x10138d10) on the x87 model: (z*z + y*y) + x*x, the
/// sum passed to appSqrt as a double (FSTP m64), FSQRT, one float store; a
/// NaN sum returns quieted. The interpreter takes it at precision control
/// 24 (render-precision.mjs); its game-thread form is the double one.
pub(crate) fn vector_size(v: [u32; 3]) -> u32 {
    let [x, y, z] = load3(v[0], v[1], v[2]);
    let s = z.mul(z).add(y.mul(y)).add(x.mul(x));
    if s.nan() {
        return s.quiet().store();
    }
    s.store_double().sqrt().store()
}
#[no_mangle]
pub extern "C" fn op_vector_size(x: u32, y: u32, z: u32) -> u32 {
    vector_size([x, y, z])
}

/// FVector::SafeNormal (Normal, 226).
pub(crate) fn safe_normal(v: [u32; 3]) -> [u32; 3] {
    let [x, y, z] = load3(v[0], v[1], v[2]);
    let s = x.mul(x).add(y.mul(y)).add(z.mul(z));
    if s.nan() || s.below_1em8() {
        return [0, 0, 0];
    }
    let r = if s.inf() { Ext::zero(0) } else { Ext::load(ONE).div(s.store_double().sqrt()) };
    [x.mul(r).store(), y.mul(r).store(), z.mul(r).store()]
}
#[no_mangle]
pub extern "C" fn op_normal(x: u32, y: u32, z: u32) {
    out3(safe_normal([x, y, z]));
}

/// Smerp (248): A + (B-A)*(3*Alpha^2 - 2*Alpha^3), one store.
#[no_mangle]
pub extern "C" fn op_smerp(alpha: u32, a: u32, b: u32) -> u32 {
    let al = Ext::load(alpha);
    let aa = Ext::load(a);
    let bb = Ext::load(b);
    let p = al.mul(al);
    let cube = al.mul(p);
    let s = p.mul(Ext::load_i32(3)).add(cube.add(cube).neg());
    s.mul(bb.add(aa.neg())).add(aa).store()
}

/// Rotate_VectorRotator (276).
#[no_mangle]
pub extern "C" fn op_rotate(x: u32, y: u32, z: u32, pitch: i32, yaw: i32, roll: i32) {
    fn dot(t: [Ext; 3], r: [u32; 3]) -> u32 {
        t[0].mul(Ext::load(r[0])).add(t[1].mul(Ext::load(r[1]))).add(t[2].mul(Ext::load(r[2]))).store()
    }
    let neg = |bits: u32| bits ^ 0x8000_0000;
    let (sy, cy) = (rotator_sin(yaw), rotator_sin(yaw.wrapping_add(0x4000)));
    let (sp, cp) = (rotator_sin(pitch), rotator_sin(pitch.wrapping_add(0x4000)));
    let (sr, cr) = (rotator_sin(roll), rotator_sin(roll.wrapping_add(0x4000)));
    let rotations: [[[u32; 3]; 4]; 3] = [
        [[0, 0, 0], [cy, sy, 0], [neg(sy), cy, 0], [0, 0, ONE]],
        [[0, 0, 0], [cp, 0, sp], [0, ONE, 0], [neg(sp), 0, cp]],
        [[0, 0, 0], [ONE, 0, 0], [0, cr, neg(sr)], [0, sr, cr]],
    ];
    let mut m: [[u32; 3]; 4] = [[0, 0, 0], [ONE, 0, 0], [0, ONE, 0], [0, 0, ONE]];
    for r in rotations.iter() {
        let mut next = [[0u32; 3]; 4];
        for (i, row) in m.iter().enumerate() {
            let t = if i != 0 {
                load3(row[0], row[1], row[2])
            } else {
                [
                    Ext::load(row[0]).add(Ext::load(r[0][0]).neg()),
                    Ext::load(row[1]).add(Ext::load(r[0][1]).neg()),
                    Ext::load(row[2]).add(Ext::load(r[0][2]).neg()),
                ]
            };
            next[i] = [dot(t, r[1]), dot(t, r[2]), dot(t, r[3])];
        }
        m = next;
    }
    let v = load3(x, y, z);
    out3([dot(v, m[1]), dot(v, m[2]), dot(v, m[3])]);
}

/// Multiply_RotatorFloat (287) and Multiply_FloatRotator (288).
#[no_mangle]
pub extern "C" fn op_multiply_rotator_float(p: i32, y: i32, r: i32, scale: u32) {
    let s = Ext::load(scale);
    outi3([Ext::load_i32(p).mul(s).ftol(), Ext::load_i32(y).mul(s).ftol(), Ext::load_i32(r).mul(s).ftol()]);
}

/// Multiply_VectorVector (296).
#[no_mangle]
pub extern "C" fn op_multiply_vector_vector(a0: u32, a1: u32, a2: u32, b0: u32, b1: u32, b2: u32) {
    let a = load3(a0, a1, a2);
    let b = load3(b0, b1, b2);
    out3([a[0].mul(b[0]).store(), a[1].mul(b[1]).store(), a[2].mul(b[2]).store()]);
}

/// MultiplyEqual_VectorVector (297): arg1 * arg0 per component.
#[no_mangle]
pub extern "C" fn op_multiply_equal_vector_vector(a0: u32, a1: u32, a2: u32, b0: u32, b1: u32, b2: u32) {
    let a = load3(a0, a1, a2);
    let b = load3(b0, b1, b2);
    out3([b[0].mul(a[0]).store(), b[1].mul(a[1]).store(), b[2].mul(a[2]).store()]);
}

/// MirrorVectorByNormal (300).
#[no_mangle]
pub extern "C" fn op_mirror_vector_by_normal(a0: u32, a1: u32, a2: u32, b0: u32, b1: u32, b2: u32) {
    let n = safe_normal([b0, b1, b2]);
    let [nx, ny, nz] = load3(n[0], n[1], n[2]);
    let [vx, vy, vz] = load3(a0, a1, a2);
    let two_x = nx.add(nx);
    let two_y = ny.add(ny).stored();
    let two_z = nz.add(nz).stored();
    let dot = vy.mul(ny).add(vz.mul(nz)).add(vx.mul(nx)).stored();
    let prod_x = two_x.mul(dot);
    let prod_y = two_y.mul(dot).stored();
    let prod_z = two_z.mul(dot).stored();
    out3([vx.add(prod_x.neg()).store(), vy.add(prod_y.neg()).store(), vz.add(prod_z.neg()).store()]);
}

/// FLD m64 of a finite binary64 constant (script-vm.mjs `x87double`).
pub(crate) fn load_double(v: f64) -> Ext {
    let bits = v.to_bits();
    let e = ((bits >> 52) & 0x7ff) as i32;
    let m = bits & ((1u64 << 52) - 1);
    let sign = ((bits >> 32) as u32) & 0x8000_0000;
    let sig = if e == 0 { m } else { m | (1u64 << 52) };
    Ext::normalized(sig as u128, if e == 0 { -1074 } else { e - 1075 }, sign)
}

/// APawn::performPhysics's AvgPhysicsTime (script-pawn-physics.mjs,
/// 0x103c9c37..0x103c9c4e): old * 0.8 + dt * 0.2 with both products and
/// their sum on the x87 stack, then one float store.
#[no_mangle]
pub extern "C" fn phys_avg_time(avg: u32, dt: u32) -> u32 {
    Ext::load(avg).mul(load_double(0.8)).add(Ext::load(dt).mul(load_double(0.2))).store()
}

/// physFalling's time refund (falling.mjs `refundTime`, 0x103d1de0 and
/// 0x103d1e0e): RemainingTime + TimeTick * (1.0 - Hit.Time), one store.
#[no_mangle]
pub extern "C" fn phys_refund_time(remaining: u32, time: u32, step: u32) -> u32 {
    Ext::load_i32(1).add(Ext::load(time).neg()).mul(Ext::load(step)).add(Ext::load(remaining)).store()
}
