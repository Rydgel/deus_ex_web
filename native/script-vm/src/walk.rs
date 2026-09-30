//! Pawn walking kernels (docs/rust-core.md, R3-b stage B3). Each function
//! transcribes its JavaScript body (the reference) step for step: the same
//! double intermediates in the same order, `f` (`as f32`) at every
//! `Math.fround`, and the same comparisons, so NaN and signed zeros follow
//! the JavaScript. The JavaScript bodies carry the native evidence:
//! * `js_hypot`: V8's Math.hypot (builtins/math.tq MathHypot).
//! * `safe_normal`, `two_wall_adjust`, `step_projection`, `step_up`:
//!   src/runtime/steps.mjs (Core FVector::SafeNormal 0x10144be0, AActor
//!   TwoWallAdjust 0x10323770, APawn stepUp 0x103ce4a0).
//! * `ground_velocity`: src/runtime/velocity.mjs (APawn calcVelocity
//!   0x103cd7a0, physWalking's call).
//!
//! `step_up` reaches the world only through `PawnOps`, in the order the
//! JavaScript reads the pawn view: the hosted harness (`walk_step_up`)
//! implements it with one import per view access, and a later stage
//! implements it on the pawn's image.
use crate::trace::{abs, f, js_max, sqrt};

pub(crate) type V3 = [f64; 3];

#[inline(always)]
fn fv(a: V3) -> V3 {
    [f(a[0]), f(a[1]), f(a[2])]
}
/// `a.map(v => f(v * s))`
#[inline(always)]
fn scale(a: V3, s: f64) -> V3 {
    [f(a[0] * s), f(a[1] * s), f(a[2] * s)]
}
#[inline(always)]
fn add(a: V3, b: V3) -> V3 {
    [f(a[0] + b[0]), f(a[1] + b[1]), f(a[2] + b[2])]
}
#[inline(always)]
fn sub(a: V3, b: V3) -> V3 {
    [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])]
}
/// `a[0] * b[0] + a[1] * b[1] + a[2] * b[2]`, left to right.
#[inline(always)]
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// V8's Math.hypot for two arguments: the larger magnitude normalizes both,
/// a Kahan sum adds the squares, and the root is scaled back. Infinity wins
/// over NaN; all-zero is +0.
pub(crate) fn js_hypot(a: f64, b: f64) -> f64 {
    let mut nan = false;
    let mut max = 0.0f64;
    let mut values = [0.0f64; 2];
    for (i, value) in [a, b].into_iter().enumerate() {
        if value != value {
            nan = true;
        } else {
            let magnitude = abs(value);
            values[i] = magnitude;
            if magnitude > max {
                max = magnitude;
            }
        }
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    let mut compensation = 0.0f64;
    for value in values {
        let n = value / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sqrt(sum) * max
}

/// Core FVector::SafeNormal (steps.mjs `safeNormal`).
pub(crate) fn safe_normal(vector: V3) -> V3 {
    let v = fv(vector);
    let squared = dot(v, v);
    if squared < 1e-8 {
        [0.0; 3]
    } else {
        scale(v, 1.0 / sqrt(squared))
    }
}

/// AActor::TwoWallAdjust (steps.mjs `twoWallAdjust`).
pub(crate) fn two_wall_adjust(desired: V3, delta: V3, normal: V3, old_normal: V3, time: f64) -> V3 {
    let d = fv(desired);
    let v = fv(delta);
    let n = fv(normal);
    let old = fv(old_normal);
    let time = f(time);
    if dot(n, old) <= 0.0 {
        let crease = safe_normal([
            f(n[1] * old[2] - n[2] * old[1]),
            f(n[2] * old[0] - n[0] * old[2]),
            f(n[0] * old[1] - n[1] * old[0]),
        ]);
        let result = scale(crease, dot(v, crease) * (1.0 - time));
        return if dot(d, result) < 0.0 { scale(result, -1.0) } else { result };
    }
    let into = dot(v, n);
    let remaining = f(1.0 - time);
    let result = scale(
        [f(v[0] - n[0] * into), f(v[1] - f(n[1] * into)), f(v[2] - f(n[2] * into))],
        remaining,
    );
    if dot(d, result) <= 0.0 {
        [0.0; 3]
    } else {
        result
    }
}

/// steps.mjs `stepProjection`: the projected delta and the forward-progress
/// dot, with X kept unrounded for the dot.
fn step_projection(delta: V3, normal: V3, time: f64) -> (V3, f64) {
    let into = dot(delta, normal);
    let remaining = 1.0 - time;
    let x = (delta[0] - normal[0] * into) * remaining;
    let y = f(f(delta[1] - f(normal[1] * into)) * remaining);
    let z = f(f(delta[2] - f(normal[2] * into)) * remaining);
    ([f(x), y, z], delta[0] * x + delta[1] * y + delta[2] * z)
}

/// APawn calcVelocity's physWalking path (velocity.mjs `groundVelocity`):
/// (velocity, acceleration), or None where the JavaScript throws (a
/// timestep outside (0, 0.4]).
pub(crate) fn ground_velocity(
    velocity: V3,
    acceleration: V3,
    direction: V3,
    dt: f64,
    max_speed: f64,
    accel_rate: f64,
    friction: f64,
    walking: bool,
) -> Option<(V3, V3)> {
    let mut v = fv(velocity);
    let mut a = fv(acceleration);
    let original = v;
    let d = fv(direction);
    let dt = f(dt);
    let max_speed = f(max_speed);
    let accel_rate = f(accel_rate);
    let friction = js_max(0.0, f(friction));
    if !(dt > 0.0) || dt > f(0.4) {
        return None;
    }
    if a[0] == 0.0 && a[1] == 0.0 && a[2] == 0.0 {
        let mut remaining = dt;
        let mut average = [0.0f64; 3];
        let mut brake = |v: &mut V3, step: f64| {
            *v = sub(*v, scale(scale(scale(*v, 2.0), step), friction));
            if dot(original, *v) > 0.0 {
                average = add(average, scale(scale(*v, step), 1.0 / dt));
            }
        };
        while remaining > 0.03 {
            brake(&mut v, f(0.03));
            remaining = f(remaining - 0.03);
        }
        brake(&mut v, remaining);
        v = average;
        if dot(original, v) < 0.0 || dot(v, v) < 100.0 {
            v = [0.0; 3];
        }
    } else {
        let speed = f(sqrt(dot(v, v)));
        let limit = accel_rate * accel_rate * if walking { 0.09 } else { 1.0 };
        if dot(a, a) > limit {
            a = if walking { scale(scale(d, accel_rate), f(0.3)) } else { scale(d, accel_rate) };
        }
        v = sub(v, scale(scale(sub(v, scale(d, speed)), dt), friction));
    }
    v = add(v, scale(a, dt));
    let speed_squared = f(dot(v, v));
    if walking && speed_squared > max_speed * max_speed * 0.09 {
        let speed = f(sqrt(dot(v, v)));
        let limited = f(js_max(speed * (1.0 - 2.0 * friction * dt), f(max_speed * f(0.3))));
        v = scale(scale(v, 1.0 / speed), limited);
    } else if speed_squared > max_speed * max_speed {
        v = scale(scale(v, 1.0 / sqrt(dot(v, v))), max_speed);
    }
    Some((v, a))
}

/// A move's result as stepUp reads it: the time, the normal and the hit
/// actor (a host id; 0 for none). `id` names the host's result object.
#[derive(Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct Hit {
    pub time: f64,
    pub normal: V3,
    pub actor: u32,
    pub id: u32,
}

/// The pawn view accesses stepUp makes, in its order. An access that the
/// JavaScript makes through a getter is one call here.
pub(crate) trait PawnOps {
    fn max_step_height(&mut self) -> f64;
    fn move_by(&mut self, delta: V3) -> Hit;
    fn hit_wall(&mut self, hit: &Hit);
    fn physics(&mut self) -> i32;
    fn is_player(&mut self) -> bool;
    /// `hit.actor?.pushableDecoration`
    fn pushable(&mut self, hit: &Hit) -> bool;
    fn set_just_teleported(&mut self);
    fn mass(&mut self) -> f64;
    /// `hit.actor.mass`
    fn actor_mass(&mut self, hit: &Hit) -> f64;
    fn velocity(&mut self) -> V3;
    fn set_velocity(&mut self, velocity: V3);
}

/// stepUp's outcome: its hit, or the recursion budget error.
pub(crate) enum StepUp {
    Hit(Hit),
    Budget,
}

/// APawn stepUp (steps.mjs `stepUp`).
pub(crate) fn step_up<P: PawnOps>(pawn: &mut P, gravity_direction: V3, desired_direction: V3, delta: V3) -> StepUp {
    let gravity = fv(gravity_direction);
    let desired = fv(desired_direction);
    let down = scale(gravity, f(pawn.max_step_height()));
    let mut calls = 0u32;
    match step(pawn, &mut calls, down, desired, fv(delta)) {
        Some(hit) => StepUp::Hit(hit),
        None => StepUp::Budget,
    }
}

fn step<P: PawnOps>(pawn: &mut P, calls: &mut u32, down: V3, desired: V3, mut remaining: V3) -> Option<Hit> {
    *calls += 1;
    if *calls > 1024 {
        return None;
    }
    pawn.move_by(scale(down, -1.0));
    let mut hit = pawn.move_by(remaining);
    if hit.time < 1.0 {
        if pawn.is_player() && pawn.pushable(&hit) && dot(desired, hit.normal) < -0.9 {
            pawn.set_just_teleported();
            let mass = f(pawn.mass());
            let other_mass = f(pawn.actor_mass(&hit));
            let velocity = fv(pawn.velocity());
            pawn.set_velocity(scale(velocity, mass / (other_mass + mass)));
            pawn.hit_wall(&hit);
            if pawn.physics() == 2 {
                return Some(hit);
            }
        } else if abs(hit.normal[2]) < 0.2 && dot(remaining, remaining) * hit.time > 144.0 {
            hit = step(pawn, calls, down, desired, scale(remaining, f(1.0 - hit.time)))?;
            if pawn.physics() == 2 {
                return Some(hit);
            }
        } else {
            pawn.hit_wall(&hit);
            let old_normal = hit.normal;
            let (projected, progress) = step_projection(remaining, hit.normal, hit.time);
            if progress >= 0.0 {
                remaining = projected;
                hit = pawn.move_by(remaining);
                if hit.time < 1.0 {
                    pawn.hit_wall(&hit);
                    if pawn.physics() == 2 {
                        return Some(hit);
                    }
                    remaining = two_wall_adjust(desired, remaining, hit.normal, old_normal, hit.time);
                    // The reference stores this result in `hit`, which the
                    // move below replaces unread.
                    pawn.move_by(remaining);
                }
            }
        }
    }
    hit = pawn.move_by(down);
    if hit.time < 1.0 && hit.normal[2] < 0.5 {
        let (projected, progress) = step_projection(down, hit.normal, hit.time);
        if progress >= 0.0 {
            hit = pawn.move_by(projected);
        }
    }
    Some(hit)
}

// ---- Hosted harness --------------------------------------------------------
// WALK_IO carries a call's inputs and outputs as doubles; the hosted pawn's
// imports read and write it too (walk-kernel.mjs documents each layout).

static mut WALK_IO: [f64; 32] = [0.0; 32];

#[no_mangle]
pub extern "C" fn walk_io_ptr() -> *mut f64 {
    core::ptr::addr_of_mut!(WALK_IO) as *mut f64
}
#[inline(always)]
fn io(i: usize) -> f64 {
    unsafe { (*core::ptr::addr_of!(WALK_IO))[i] }
}
#[inline(always)]
fn set_io(i: usize, value: f64) {
    unsafe { (*core::ptr::addr_of_mut!(WALK_IO))[i] = value };
}
fn io3(at: usize) -> V3 {
    [io(at), io(at + 1), io(at + 2)]
}
fn set_io3(at: usize, v: V3) {
    for i in 0..3 {
        set_io(at + i, v[i]);
    }
}

#[no_mangle]
pub extern "C" fn walk_hypot(a: f64, b: f64) -> f64 {
    js_hypot(a, b)
}
/// safeNormal: IO[0..3] in, IO[0..3] out.
#[no_mangle]
pub extern "C" fn walk_safe_normal() {
    set_io3(0, safe_normal(io3(0)));
}
/// twoWallAdjust: desired IO[0..3], delta [3..6], normal [6..9], oldNormal
/// [9..12], time [12]; the result in [0..3].
#[no_mangle]
pub extern "C" fn walk_two_wall_adjust() {
    set_io3(0, two_wall_adjust(io3(0), io3(3), io3(6), io3(9), io(12)));
}
/// groundVelocity: velocity IO[0..3], acceleration [3..6], direction [6..9],
/// dt [9], maxSpeed [10], accelRate [11], friction [12], walking [13] (0 or
/// 1); velocity out in [0..3], acceleration in [3..6]. Returns 0 where the
/// JavaScript throws.
#[no_mangle]
pub extern "C" fn walk_ground_velocity() -> u32 {
    match ground_velocity(io3(0), io3(3), io3(6), io(9), io(10), io(11), io(12), io(13) != 0.0) {
        Some((velocity, acceleration)) => {
            set_io3(0, velocity);
            set_io3(3, acceleration);
            1
        }
        None => 0,
    }
}

#[link(wasm_import_module = "env")]
extern "C" {
    fn walk_max_step_height() -> f64;
    /// `pawn.move(IO[0..3])`: writes time IO[0], normal [1..4], actor [4] and
    /// the result's id [5].
    fn walk_move();
    fn walk_hit_wall(id: u32);
    fn walk_physics() -> i32;
    fn walk_is_player() -> i32;
    fn walk_pushable(id: u32) -> i32;
    fn walk_set_just_teleported();
    fn walk_mass() -> f64;
    fn walk_actor_mass(id: u32) -> f64;
    /// `pawn.velocity` into IO[0..3].
    fn walk_velocity();
    /// `pawn.velocity = IO[0..3]`.
    fn walk_set_velocity();
}

struct HostedPawn;
impl PawnOps for HostedPawn {
    fn max_step_height(&mut self) -> f64 {
        unsafe { walk_max_step_height() }
    }
    fn move_by(&mut self, delta: V3) -> Hit {
        set_io3(0, delta);
        unsafe { walk_move() };
        Hit { time: io(0), normal: io3(1), actor: io(4) as u32, id: io(5) as u32 }
    }
    fn hit_wall(&mut self, hit: &Hit) {
        unsafe { walk_hit_wall(hit.id) }
    }
    fn physics(&mut self) -> i32 {
        unsafe { walk_physics() }
    }
    fn is_player(&mut self) -> bool {
        unsafe { walk_is_player() != 0 }
    }
    fn pushable(&mut self, hit: &Hit) -> bool {
        unsafe { walk_pushable(hit.id) != 0 }
    }
    fn set_just_teleported(&mut self) {
        unsafe { walk_set_just_teleported() }
    }
    fn mass(&mut self) -> f64 {
        unsafe { walk_mass() }
    }
    fn actor_mass(&mut self, hit: &Hit) -> f64 {
        unsafe { walk_actor_mass(hit.id) }
    }
    fn velocity(&mut self) -> V3 {
        unsafe { walk_velocity() };
        io3(0)
    }
    fn set_velocity(&mut self, velocity: V3) {
        set_io3(0, velocity);
        unsafe { walk_set_velocity() }
    }
}

/// stepUp on the hosted pawn: gravity IO[0..3], desired [3..6], delta
/// [6..9]. Returns the final hit's id, or 0 for the recursion budget error.
#[no_mangle]
pub extern "C" fn walk_step_up() -> u32 {
    let (gravity, desired, delta) = (io3(0), io3(3), io3(6));
    match step_up(&mut HostedPawn, gravity, desired, delta) {
        StepUp::Hit(hit) => hit.id,
        StepUp::Budget => 0,
    }
}
