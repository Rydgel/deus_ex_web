//! APawn::physWalking's dry path on the pawn's image (docs/rust-core.md,
//! step R3-b B5). The JavaScript reference is walking.mjs `walking`,
//! reached from `runScriptPawnPhysics` (script-pawn-physics.mjs), with
//! steps.mjs `stepUp` and velocity.mjs `groundVelocity`, whose Rust
//! transcriptions are walk.rs (B3). Each read the reference makes through
//! the pawn view is an image load here (the walk field table, host
//! walk-loop-kernel.mjs); each effect is one import at the reference's
//! point: the surface prelude, the line checks, HitWall, the Falling and
//! MayFall events, SetSupportBase, setPhysics, FarMoveActor, and the
//! physFalling, startSwimming and Falling-event physFlying tail calls. MoveActor is `move_pawn`
//! (B4), called directly; where it hands a call back, the JavaScript
//! `pawn.move` runs it through the import.
//!
//! Arithmetic follows the reference: doubles in the same order, `f` at every
//! Math.fround, `sqrt` for Math.sqrt, `js_hypot` for Math.hypot, `js_min` for
//! Math.min.
use crate::interp::{live, load32, load8, quiet, receiver_info, HOST};
use crate::move_actor::store;
use crate::move_pawn::{move_pawn, mp_io, MP_DONE};
use crate::trace::{abs, f, js_max, js_min, sqrt};
use crate::walk::{ground_velocity, js_hypot, safe_normal, step_up, Hit, PawnOps, StepUp, V3};
use crate::fly::{above, dot as x87dot, l, loads};
use crate::x87::Ext;
use crate::zone::point_region;

#[inline(always)]
fn bits32(v: f64) -> u32 { (v as f32).to_bits() }

const HANDBACK: u32 = 0;
const DONE: u32 = 1;

// The walk field table (walk-loop-kernel.mjs WALK_FIELDS): [offset, mask].
const W_GROUND_SPEED: usize = 0;
pub(crate) const W_ACCEL_RATE: usize = 1;
const W_MAX_STEP_HEIGHT: usize = 2;
const W_CAN_JUMP: usize = 3;
const W_IS_WALKING: usize = 4;
pub(crate) const W_MOVE_TIMER: usize = 5;
const W_HIT_SLOPED_WALL: usize = 6;
const W_IS_PLAYER: usize = 7;
pub(crate) const W_MASS: usize = 8;
const W_VELOCITY: usize = 9;
const W_ACCELERATION: usize = 10;
const W_OLD_LOCATION: usize = 11;
pub(crate) const W_PHYSICS: usize = 12;
const W_BASE: usize = 13;
pub(crate) const W_REGION_ZONE: usize = 14;
const W_LOCATION: usize = 15;
const W_RADIUS: usize = 16;
const W_HEIGHT: usize = 17;
const W_MOTION: usize = 18;
// The zone actor's fields, offsets in its image.
const W_ZONE_GRAVITY: usize = 19;
const W_ZONE_VELOCITY: usize = 20;
const W_ZONE_FRICTION: usize = 21;
// physFlying's (fly.rs).
const W_ZONE_FLUID_FRICTION: usize = 22;
// Pawn.DesiredSpeed: a non-PlayerPawn's calcVelocity scales MaxSpeed by it (appended: the pawn fields' own
// range ends at W_MOTION; walk-loop-kernel.mjs PAWN_ROWS names this row too).
const W_DESIRED_SPEED: usize = 23;
const W_COUNT: usize = 24;

static mut WFIELDS: [[u32; 2]; W_COUNT] = [[0; 2]; W_COUNT];
// WL_IO: a line check's answer [time, nx, ny, nz, actor handle], and the
// zone fallback's answers.
static mut WL_IO: [f64; 8] = [0.0; 8];
// WL_STATE: [0] the zone model address (0: none), [1] the world actor's
// handle, then running counts the host differences around a call
// (walk-loop-kernel.mjs COUNTERS): [2] MoveActor bodies entered directly,
// [3] the sloped-wall re-probe, [4] the floor nudge (distance < 1.9), [5]
// the friction slide, [6] the bCanJump=false retreat, [7] stepUp entries.
static mut WL_STATE: [u32; 8] = [0; 8];
#[inline(always)]
fn count(i: usize) {
    unsafe { let s = core::ptr::addr_of_mut!(WL_STATE); (*s)[i] = (*s)[i].wrapping_add(1); }
}

#[no_mangle]
pub extern "C" fn walk_fields_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(WFIELDS) as *mut u32
}
#[no_mangle]
pub extern "C" fn walk_loop_io_ptr() -> *mut f64 {
    core::ptr::addr_of_mut!(WL_IO) as *mut f64
}
#[no_mangle]
pub extern "C" fn walk_loop_state_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(WL_STATE) as *mut u32
}

#[link(wasm_import_module = "env")]
extern "C" {
    fn js_walk_prelude(depth: u32, dt: f64, iterations: i32) -> u32;
    fn js_walk_line(depth: u32, sx: f64, sy: f64, sz: f64, ex: f64, ey: f64, ez: f64,
                    rx: f64, ry: f64, rz: f64, flags: u32);
    fn js_walk_move(depth: u32, dx: f64, dy: f64, dz: f64);
    fn js_walk_hit_wall(depth: u32, time: f64, nx: f64, ny: f64, nz: f64, actor: u32);
    fn js_walk_pushable(depth: u32, actor: u32) -> u32;
    fn js_walk_actor_mass(depth: u32, actor: u32) -> f64;
    fn js_walk_falling_event(depth: u32);
    fn js_walk_may_fall(depth: u32);
    fn js_walk_set_support_base(depth: u32, actor: u32);
    fn js_walk_set_physics(depth: u32, next: u32);
    fn js_walk_far_move(depth: u32, x: f64, y: f64, z: f64);
    fn js_walk_falling(depth: u32, remaining: f64, iterations: i32);
    fn js_walk_swim(depth: u32, step: f64, remaining: f64, iterations: i32);
    fn js_walk_fly(depth: u32, remaining: f64, iterations: i32);
    fn js_walk_zone_vec(depth: u32, which: u32);
    fn js_walk_zone_float(depth: u32, which: u32) -> f64;
    fn js_walk_error(depth: u32, code: u32);
}

#[inline(always)]
fn wf(i: usize) -> [u32; 2] { unsafe { (*core::ptr::addr_of!(WFIELDS))[i] } }
#[inline(always)]
pub(crate) fn at(base: u32, i: usize) -> u32 { base + wf(i)[0] }
#[inline(always)]
fn bit(base: u32, i: usize) -> bool { load32(at(base, i)) & wf(i)[1] != 0 }
#[inline(always)]
fn set_bit(base: u32, i: usize, on: bool) {
    let a = at(base, i);
    let word = load32(a);
    store(a, if on { word | wf(i)[1] } else { word & !wf(i)[1] });
}
#[inline(always)]
fn float(base: u32, i: usize) -> f64 { f32::from_bits(load32(at(base, i))) as f64 }
#[inline(always)]
fn set_float(base: u32, i: usize, v: f64) { store(at(base, i), (v as f32).to_bits()); }
#[inline(always)]
fn vec(base: u32, i: usize) -> V3 {
    let a = at(base, i);
    [f32::from_bits(load32(a)) as f64, f32::from_bits(load32(a + 4)) as f64, f32::from_bits(load32(a + 8)) as f64]
}
#[inline(always)]
fn set_vec(base: u32, i: usize, v: V3) {
    let a = at(base, i);
    store(a, (v[0] as f32).to_bits()); store(a + 4, (v[1] as f32).to_bits()); store(a + 8, (v[2] as f32).to_bits());
}
#[inline(always)]
fn io(i: usize) -> f64 { unsafe { (*core::ptr::addr_of!(WL_IO))[i] } }
#[inline(always)]
fn state(i: usize) -> u32 { unsafe { (*core::ptr::addr_of!(WL_STATE))[i] } }
/// The level's zone model (zone.rs), or 0 without one.
pub(crate) fn zone_model() -> u32 { state(0) }

#[inline(always)]
fn add(a: V3, b: V3) -> V3 { [f(a[0] + b[0]), f(a[1] + b[1]), f(a[2] + b[2])] }
#[inline(always)]
fn sub(a: V3, b: V3) -> V3 { [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])] }
#[inline(always)]
fn scale(a: V3, s: f64) -> V3 { [f(a[0] * s), f(a[1] * s), f(a[2] * s)] }
#[inline(always)]
fn dot(a: V3, b: V3) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
/// walking.mjs `sloped`: `h.time<1&&h.normal[2]>.01&&h.normal[2]<.7`.
#[inline(always)]
fn sloped(h: &Hit) -> bool { h.time < 1.0 && h.normal[2] > 0.01 && h.normal[2] < 0.7 }

/// The pawn view over the image: the reads and writes walking.mjs and
/// stepUp make, at the same points (and physFlying's, fly.rs).
pub(crate) struct ImagePawn {
    pub(crate) depth: u32,
    pub(crate) base: u32,
}

/// A float32 cell's bits as its JavaScript read yields them: getFloat32
/// quiets a signaling NaN.
#[inline(always)]
fn bits3(base: u32, i: usize) -> [u32; 3] {
    let a = at(base, i);
    [quiet(load32(a)), quiet(load32(a + 4)), quiet(load32(a + 8))]
}
#[inline(always)]
fn set_bits3(base: u32, i: usize, v: [u32; 3]) {
    let a = at(base, i);
    store(a, v[0]); store(a + 4, v[1]); store(a + 8, v[2]);
}

impl ImagePawn {
    pub(crate) fn velocity_bits(&self) -> [u32; 3] { bits3(self.base, W_VELOCITY) }
    pub(crate) fn set_velocity_bits(&self, v: [u32; 3]) { set_bits3(self.base, W_VELOCITY, v); }
    pub(crate) fn acceleration_bits(&self) -> [u32; 3] { bits3(self.base, W_ACCELERATION) }
    pub(crate) fn set_acceleration_bits(&self, v: [u32; 3]) { set_bits3(self.base, W_ACCELERATION, v); }
    pub(crate) fn position_bits(&self) -> [u32; 3] { bits3(self.base, W_LOCATION) }
    pub(crate) fn old_location_bits(&self) -> [u32; 3] { bits3(self.base, W_OLD_LOCATION) }
    pub(crate) fn set_old_location_bits(&self, v: [u32; 3]) { set_bits3(self.base, W_OLD_LOCATION, v); }
    /// `f(zone().ZoneFluidFriction ?? 1.2)`'s bits.
    pub(crate) fn fluid_friction_bits(&self) -> u32 { (self.zone_float(W_ZONE_FLUID_FRICTION) as f32).to_bits() }
    /// steps.mjs's `Original stepUp recursion budget exceeded`.
    pub(crate) fn step_budget_error(&self) { unsafe { js_walk_error(self.depth, E_STEP_BUDGET) }; }
    pub(crate) fn physics(&self) -> i32 { load8(at(self.base, W_PHYSICS)) as i32 }
    /// `pawn.walkingPrelude(dt, iterations)`: true when it ended the call.
    pub(crate) fn prelude(&self, dt: f64, iterations: i32) -> bool { unsafe { js_walk_prelude(self.depth, dt, iterations) != 0 } }
    /// `pawn.setPhysics(next)`.
    pub(crate) fn set_physics(&self, next: u32) { unsafe { js_walk_set_physics(self.depth, next) }; }
    /// `pawn.falling(remaining, iterations)`.
    pub(crate) fn falling(&self, remaining: f64, iterations: i32) { unsafe { js_walk_falling(self.depth, remaining, iterations) }; }
    fn position(&self) -> V3 { vec(self.base, W_LOCATION) }
    fn velocity(&self) -> V3 { vec(self.base, W_VELOCITY) }
    fn set_velocity(&self, v: V3) { set_vec(self.base, W_VELOCITY, v); }
    fn acceleration(&self) -> V3 { vec(self.base, W_ACCELERATION) }
    fn set_acceleration(&self, v: V3) { set_vec(self.base, W_ACCELERATION, v); }
    fn base_actor(&self) -> u32 { live(load32(at(self.base, W_BASE))) }
    pub(crate) fn just_teleported(&self) -> bool { bit(self.base, W_MOTION) }
    pub(crate) fn set_just_teleported(&self, on: bool) { set_bit(self.base, W_MOTION, on); }
    fn hit_sloped_wall(&self) -> bool { bit(self.base, W_HIT_SLOPED_WALL) }
    fn set_hit_sloped_wall(&self, on: bool) { set_bit(self.base, W_HIT_SLOPED_WALL, on); }
    /// `pawn.region.zone ?? level.pointRegion(pawn.position).zone`, then the
    /// zone actor's image base, or 0 when it has none (the field then comes
    /// from JavaScript).
    fn zone_base(&self) -> u32 {
        let mut zone = live(load32(at(self.base, W_REGION_ZONE)));
        if zone == 0 {
            let model = state(0);
            if model == 0 { return 0; }
            let p = self.position();
            match point_region(model, p) {
                Some(r) => zone = live(r.zone),
                None => return 0,
            }
        }
        if zone == 0 { return 0; }
        let info = receiver_info(zone);
        if info & HOST != 0 { 0 } else { info & !3 }
    }
    pub(crate) fn zone_vec(&self, which: usize) -> V3 {
        let zone = self.zone_base();
        if zone != 0 { return vec(zone, which); }
        unsafe { js_walk_zone_vec(self.depth, which as u32) };
        [f(io(0)), f(io(1)), f(io(2))]
    }
    fn zone_float(&self, which: usize) -> f64 {
        let zone = self.zone_base();
        if zone != 0 { return float(zone, which); }
        f(unsafe { js_walk_zone_float(self.depth, which as u32) })
    }
    pub(crate) fn gravity(&self) -> V3 { self.zone_vec(W_ZONE_GRAVITY) }
    pub(crate) fn zone_velocity(&self) -> V3 { self.zone_vec(W_ZONE_VELOCITY) }
    fn friction(&self) -> f64 { self.zone_float(W_ZONE_FRICTION) }
    /// `pawn.lineCheck(s, e, extent, flags, 0)`.
    fn line(&self, s: V3, e: V3, extent: V3, flags: u32) -> Hit {
        unsafe { js_walk_line(self.depth, s[0], s[1], s[2], e[0], e[1], e[2], extent[0], extent[1], extent[2], flags) };
        Hit { time: io(0), normal: [io(1), io(2), io(3)], actor: io(4) as u32, id: 0 }
    }
    /// `pawn.move(delta)`: `move_pawn` on this image, or the JavaScript
    /// `pawn.move` where it hands the call back. The result is the view's
    /// `{time: f(time), normal: normal.map(f), actor}`.
    pub(crate) fn move_by(&self, delta: V3) -> Hit {
        count(2);
        let code = move_pawn(self.depth, self.base, delta[0] as f32, delta[1] as f32, delta[2] as f32, 0, 0, 0, 0, 0);
        if code != MP_DONE {
            unsafe { js_walk_move(self.depth, delta[0], delta[1], delta[2]) };
            return Hit { time: f(io(0)), normal: [f(io(1)), f(io(2)), f(io(3))], actor: io(4) as u32, id: 0 };
        }
        let m = mp_io();
        let (time, hit) = (m[0], m[1] as i32);
        if hit >= 0 {
            Hit { time: f(time), normal: [f(m[9]), f(m[10]), f(m[11])], actor: m[12] as u32, id: 0 }
        } else {
            Hit { time: f(time), normal: [0.0; 3], actor: 0, id: 0 }
        }
    }
}

impl PawnOps for ImagePawn {
    fn max_step_height(&mut self) -> f64 { float(self.base, W_MAX_STEP_HEIGHT) }
    fn move_by(&mut self, delta: V3) -> Hit { ImagePawn::move_by(self, delta) }
    fn hit_wall(&mut self, hit: &Hit) {
        unsafe { js_walk_hit_wall(self.depth, hit.time, hit.normal[0], hit.normal[1], hit.normal[2], hit.actor) };
    }
    fn physics(&mut self) -> i32 { ImagePawn::physics(self) }
    fn is_player(&mut self) -> bool { bit(self.base, W_IS_PLAYER) }
    fn pushable(&mut self, hit: &Hit) -> bool { hit.actor != 0 && unsafe { js_walk_pushable(self.depth, hit.actor) } != 0 }
    fn set_just_teleported(&mut self) { ImagePawn::set_just_teleported(self, true); }
    fn mass(&mut self) -> f64 { float(self.base, W_MASS) }
    fn actor_mass(&mut self, hit: &Hit) -> f64 { unsafe { js_walk_actor_mass(self.depth, hit.actor) } }
    fn velocity(&mut self) -> V3 { ImagePawn::velocity(self) }
    fn set_velocity(&mut self, velocity: V3) { ImagePawn::set_velocity(self, velocity); }
}

// js_walk_error codes (walk-loop-kernel.mjs ERRORS); 1 is the timestep
// error, which is a hand-back here instead. Code 2 (the former non-dry
// physics stop) is retired: physWalking continues for any Physics but
// Swimming.
const E_STEP_BUDGET: u32 = 3;
const E_GROUND_VELOCITY: u32 = 4;

/// `walking(pawn, seconds, iterations)` on the pawn whose image is at
/// `base`. Returns DONE, or HANDBACK before any effect (the JavaScript body
/// then runs the whole call).
#[no_mangle]
pub extern "C" fn walk_loop(depth: u32, base: u32, seconds: f32, mut iterations: i32) -> u32 {
    let pawn = ImagePawn { depth, base };
    let mut p = ImagePawn { depth, base };
    let dt = f(seconds as f64);
    // `if(!(dt>0)||dt>f(.4))throw Error('Walking requires timestep in (0,0.4]')`
    if !(dt > 0.0) || dt > f(0.4) { return HANDBACK; }
    if unsafe { js_walk_prelude(depth, dt, iterations) } != 0 { return DONE; }
    // `pawn.velocity=pawn.velocity.map(f);pawn.acceleration=...;pawn.position=...`:
    // float32 cells written back unchanged.
    let velocity = pawn.velocity();
    pawn.set_velocity(velocity);
    let acceleration = pawn.acceleration();
    pawn.set_acceleration(acceleration);
    let position = pawn.position();
    set_vec(base, W_LOCATION, position);
    pawn.set_acceleration([acceleration[0], acceleration[1], 0.0]);
    pawn.set_velocity([velocity[0], velocity[1], 0.0]);
    // groundVelocity over the view's reads, in the reference's order.
    let velocity = pawn.velocity();
    let acceleration = pawn.acceleration();
    let direction = safe_normal(acceleration);
    let max_speed = float(base, W_GROUND_SPEED);
    let accel_rate = float(base, W_ACCEL_RATE);
    let friction = pawn.friction();
    let walking = bit(base, W_IS_WALKING);
    // The Rust pawn physics runs script pawns only (the host declines a PlayerPawn): calcVelocity's class tests
    // (0x103cd7e2, 0x103cdf05) take the non-PlayerPawn side.
    let desired_speed = float(base, W_DESIRED_SPEED);
    let (v, a) = match ground_velocity(velocity, acceleration, direction, dt, max_speed, accel_rate, friction, walking, false, desired_speed) {
        Some(r) => r,
        None => { unsafe { js_walk_error(depth, E_GROUND_VELOCITY) }; return DONE; }
    };
    pawn.set_velocity(v);
    pawn.set_acceleration(a);
    // physWalking's two class reads beyond calcVelocity's (walking.mjs): this is the non-PlayerPawn side. The ZoneVelocity term
    // enters the desired move only when |ZoneVelocity|^2 > 90000 (0x103ca697..0x103ca6f1), and a remaining time over 0.05 s is
    // cut into steps only when (|desired|*remaining)^2 > 400 (0x103ca873..0x103ca8fa); both are x87 tests (fly.rs helpers).
    let zone_velocity = pawn.zone_velocity();
    let zone_bits = [bits32(zone_velocity[0]), bits32(zone_velocity[1]), bits32(zone_velocity[2])];
    let mut desired = if above(x87dot(loads(zone_bits), loads(zone_bits)), l(90000.0f32.to_bits())) {
        add(pawn.velocity(), scale(scale(zone_velocity, 25.0), dt))
    } else {
        pawn.velocity()
    };
    desired[2] = 0.0;
    let desired_bits = [bits32(desired[0]), bits32(desired[1]), bits32(desired[2])];
    let gravity = [0.0, 0.0, if pawn.gravity()[2] > 0.0 { 1.0 } else { -1.0 }];
    let floor_delta = scale(gravity, f(f(float(base, W_MAX_STEP_HEIGHT)) + 2.0));
    let extent = [f(float(base, W_RADIUS)), f(float(base, W_RADIUS)), f(float(base, W_HEIGHT))];
    let old = pawn.position();
    set_vec(base, W_OLD_LOCATION, old);
    pawn.set_just_teleported(false);
    let mut remaining = dt;
    let mut may_fall_called = false;
    while remaining > 0.0 && iterations < 8 {
        iterations += 1;
        let cut = remaining > 0.05 && {
            let r: Ext = l(bits32(remaining));
            above(x87dot(loads(desired_bits), loads(desired_bits)).mul(r).mul(r), l(400.0f32.to_bits()))
        };
        let step = if cut { f(js_min(remaining * 0.5, f(0.05))) } else { remaining };
        remaining = f(remaining - step);
        let mut delta = scale(desired, step);
        let original_delta = delta;
        let origin = pawn.position();
        let stopped = delta.iter().all(|v| abs(*v) < 0.0001);
        if stopped {
            remaining = 0.0;
            pawn.set_hit_sloped_wall(false);
        } else {
            let used_slope = pawn.hit_sloped_wall();
            if used_slope {
                count(3);
                let size = sqrt(dot(delta, delta));
                let direction = scale(delta, 1.0 / size);
                let mut h = pawn.line(pawn.position(), add(pawn.position(), scale(direction, js_max(size + 4.0, 30.0))), extent, 6);
                pawn.set_hit_sloped_wall(sloped(&h));
                if pawn.hit_sloped_wall() {
                    let n = safe_normal([h.normal[0], h.normal[1], 0.0]);
                    delta = sub(delta, scale(n, dot(n, delta)));
                } else {
                    let pos = pawn.position();
                    let start = [pos[0], pos[1], f(pos[2] - extent[2] + f(float(base, W_MAX_STEP_HEIGHT)) + 4.0)];
                    let dirs = [direction,
                        safe_normal([f(direction[0] + direction[1]), f(direction[1] - direction[0]), direction[2]]),
                        safe_normal([f(direction[0] - direction[1]), f(direction[0] + direction[1]), direction[2]])];
                    for dir in dirs.iter() {
                        h = pawn.line(start, add(start, scale(*dir, 100.0)), [0.0; 3], 6);
                        pawn.set_hit_sloped_wall(sloped(&h));
                        if pawn.hit_sloped_wall() { break; }
                    }
                }
            }
            let mut hit = pawn.move_by(delta);
            if !used_slope { pawn.set_hit_sloped_wall(sloped(&hit)); }
            if hit.time < 1.0 {
                count(7);
                hit = match step_up(&mut p, gravity, safe_normal(delta), scale(delta, f(1.0 - hit.time))) {
                    StepUp::Hit(h) => h,
                    StepUp::Budget => { unsafe { js_walk_error(depth, E_STEP_BUDGET) }; return DONE; }
                };
                if pawn.physics() == 2 {
                    let pos = pawn.position();
                    let moved = js_hypot(pos[0] - origin[0], pos[1] - origin[1]);
                    remaining = f(remaining + step * (1.0 - js_min(1.0, moved / f(sqrt(dot(original_delta, original_delta))))));
                    unsafe { js_walk_falling_event(depth) };
                    // 0x103cb30a: one Physics read after the event; a
                    // Flying pawn takes walking.mjs `flyFrom` (0x103cb343).
                    let after = pawn.physics();
                    if after == 2 {
                        if remaining > 0.01 { unsafe { js_walk_falling(depth, remaining, iterations) }; }
                    } else if after == 4 {
                        unsafe { js_walk_fly(depth, remaining, iterations) };
                    }
                    return DONE;
                }
            }
            // 0x103cb3fd: only PHYS_Swimming leaves here; any other Physics
            // a script event set during the move continues the body
            // (0x103cb466 always jumps on to the floor probe 0x103cb562).
            if pawn.physics() == 3 { unsafe { js_walk_swim(depth, step, remaining, iterations) }; return DONE; }
        }
        if stopped {
            let pos = pawn.position();
            let start = [pos[0], pos[1], f(pos[2] - extent[2])];
            let h = pawn.line(start, [start[0], start[1], f(pos[2] - extent[2] - 20.0)], [0.0; 3], 6);
            let distance = h.time * 20.0;
            // `h.actor===pawn.base`: a miss's null actor equals a None Base.
            if h.actor == pawn.base_actor() && distance >= 4.1 && distance <= 4.6 { continue; }
        }
        let pos = pawn.position();
        let mut hit = pawn.line(pos, add(pos, floor_delta), extent, 0x17);
        let distance = f((f(float(base, W_MAX_STEP_HEIGHT)) + 2.0) * hit.time);
        if hit.time < 1.0 && (hit.actor != pawn.base_actor() || distance > 2.4) {
            hit = pawn.move_by(floor_delta);
            if hit.actor != pawn.base_actor() { unsafe { js_walk_set_support_base(depth, hit.actor) }; }
            if pawn.physics() == 3 { unsafe { js_walk_swim(depth, step, remaining, iterations) }; return DONE; }
        } else if distance < 1.9 {
            count(4);
            let normal = hit.normal;
            let moved = pawn.move_by([0.0, 0.0, f(2.1 - distance)]);
            hit = Hit { time: 0.0, normal, actor: moved.actor, id: 0 };
        }
        if hit.time < 1.0 && hit.normal[2] >= 0.7 {
            if hit.normal[2] < 1.0 && hit.normal[2] * f(pawn.friction()) < 3.3 {
                count(5);
                let friction = f(pawn.friction());
                let g = scale(scale(scale(pawn.gravity(), dt), 1.0 / (2.0 * js_max(friction, 0.5))), dt);
                let into = dot(g, hit.normal);
                let slide = sub(g, scale(hit.normal, into));
                if dot(slide, g) >= 0.0 { pawn.move_by(slide); }
                if pawn.physics() == 3 { unsafe { js_walk_swim(depth, step, remaining, iterations) }; return DONE; }
            }
            continue;
        }
        if bit(base, W_CAN_JUMP) && !may_fall_called {
            may_fall_called = true;
            unsafe { js_walk_may_fall(depth) };
        }
        if !bit(base, W_CAN_JUMP) {
            count(6);
            pawn.set_velocity([0.0; 3]);
            pawn.set_acceleration([0.0; 3]);
            unsafe { js_walk_far_move(depth, old[0], old[1], old[2]) };
            set_float(base, W_MOVE_TIMER, -1.0);
            return DONE;
        }
        if hit.time < 1.0 { pawn.set_hit_sloped_wall(true); }
        let size = f(sqrt(dot(original_delta, original_delta)));
        let pos = pawn.position();
        remaining = if size == 0.0 { 0.0 } else {
            f(remaining + (1.0 - js_min(1.0, js_hypot(pos[0] - origin[0], pos[1] - origin[1]) / size)) * step)
        };
        let v = pawn.velocity();
        pawn.set_velocity([v[0], v[1], 0.0]);
        unsafe { js_walk_falling_event(depth) };
        if pawn.physics() == 1 { unsafe { js_walk_set_physics(depth, 2) }; }
        if pawn.physics() == 2 {
            let vz = pawn.velocity()[2];
            if !pawn.just_teleported() && dt > remaining {
                let inv = f(1.0 / (dt - remaining));
                pawn.set_velocity(scale(sub(pawn.position(), old), inv));
            }
            let v = pawn.velocity();
            pawn.set_velocity([v[0], v[1], vz]);
            if remaining > 0.01 { unsafe { js_walk_falling(depth, remaining, iterations) }; }
            return DONE;
        }
        pawn.move_by(scale(desired, remaining));
        remaining = 0.0;
    }
    if !pawn.just_teleported() {
        let inv = 1.0 / dt;
        let pos = pawn.position();
        pawn.set_velocity([f((pos[0] - old[0]) * inv), f(f(pos[1] - old[1]) * f(inv)), f(f(pos[2] - old[2]) * f(inv))]);
    }
    let v = pawn.velocity();
    pawn.set_velocity([v[0], v[1], 0.0]);
    DONE
}
