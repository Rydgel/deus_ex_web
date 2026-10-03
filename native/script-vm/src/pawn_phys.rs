//! APawn::performPhysics (Engine.dll 0x103c9a70) for a walking or flying
//! pawn on its image (docs/rust-core.md, steps R3-b B6a and B6b). The JavaScript reference is
//! script-pawn-physics.mjs `runScriptPawnPhysics`, which the actor tick's
//! physics callback reaches (actor-tick-kernel.mjs `js_tick_physics` ->
//! ScriptRuntime.processActorPhysics). It stays the reference: the host
//! (pawn-physics-kernel.mjs) declines a call it cannot prove equal, and the
//! tick then takes the callback as before.
//!
//! The body for Physics = PHYS_Walking or PHYS_Flying, in the reference's
//! order:
//! * `pawn.walking(delta, 0)`: the walk loop (walk_loop.rs) on this pawn's
//!   contexts, or the JavaScript `walking` body where the loop hands the
//!   call back (`js_pawn_walk`); or `pawn.flying(delta, 0)`: physFlying
//!   (fly.rs) over the same contexts, or the JavaScript body where the
//!   reference raises a boundary (`js_pawn_fly`);
//! * the physicsRotation gate (0x103c9b9e): Physics is not PHYS_Spider, and
//!   Rotation differs from DesiredRotation or RotationRate.Roll > 0 (a
//!   PlayerPawn never reaches this body: the tick hands it back);
//! * physicsRotation (0x103c9f30): the motion word's bFixedRotationDir
//!   cleared and bRotateToDesired set, Yaw stepped toward DesiredRotation.Yaw
//!   by trunc(RotationRate.Yaw * dt), Pitch toward 0 (Walking or Falling)
//!   or DesiredRotation.Pitch by trunc(dt * 32768), clamped to
//!   ±RotationRate.Pitch, then MoveActor with a zero delta and the new
//!   rotation when it changed (`move_pawn`, or the JavaScript move through
//!   `js_pawn_rotate` where it hands the call back);
//! * MoveTimer -= dt, AvgPhysicsTime = old * 0.8 + dt * 0.2 on the x87
//!   stack (lib.rs `phys_avg_time`);
//! * a PendingTouch target runs the reference's PostTouch tail in
//!   JavaScript (`js_pawn_tail` stage 2).
//!
//! The walk and the rotation's MoveActor run script (events, touches, zone
//! changes). After each, the pawn's receiver info is read again: when its
//! image is no longer the one the call started on, the rest of the body
//! runs in JavaScript from that point (`js_pawn_tail` stage 0 or 1), where
//! its reads raise the reference's errors.
//!
//! Arithmetic follows the reference: `Math.trunc` of the double products,
//! fixToward's integer steps, the double MoveTimer subtraction with one
//! Math.fround.
use crate::interp::{load32, load8, quiet, receiver_info, HOST};
use crate::move_actor::{address, store};
use crate::move_pawn::{move_pawn, MP_DONE};
use crate::fly::{phys_flying, FlyFields};
use crate::walk_loop::{at as walk_at, walk_loop, ImagePawn, W_ACCEL_RATE, W_MOVE_TIMER, W_PHYSICS};

// The pawn physics field table (pawn-physics-kernel.mjs PHYS_FIELDS):
// [offset, bool mask].
const P_DESIRED_ROTATION: usize = 0;
const P_ROTATION_RATE: usize = 1;
const P_AVG_PHYSICS_TIME: usize = 2;
const P_PENDING_TOUCH: usize = 3;
const P_FIXED_ROTATION_DIR: usize = 4;
const P_ROTATE_TO_DESIRED: usize = 5;
const P_AIR_SPEED: usize = 6;
const P_DESIRED_SPEED: usize = 7;
// Region.ZoneNumber: the Region cell's member.
const P_ZONE_NUMBER: usize = 8;
const P_COUNT: usize = 9;
// The move field table's bCollideWorld and Rotation rows
// (move-actor-kernel.mjs MOVE_FIELDS).
const M_COLLIDE_WORLD: usize = 3;
const M_ROTATION: usize = 10;

static mut PFIELDS: [[u32; 2]; P_COUNT] = [[0; 2]; P_COUNT];
/// Running counts for the host's PAWN_PHYSICS_STATS: [0] physicsRotation
/// entered, [1] its MoveActor completed here, [2] PostTouch tails; physFlying's
/// branches (fly.rs): [3] calls, [4] blocked moves, [5] stepUp, [6] HitWall
/// and the slide's progress test, [7] the slide move, [8] TwoWallAdjust.
static mut PP_COUNTS: [u32; 9] = [0; 9];
#[inline(always)]
pub(crate) fn count(i: usize) {
    unsafe { let c = core::ptr::addr_of_mut!(PP_COUNTS); (*c)[i] = (*c)[i].wrapping_add(1); }
}
#[no_mangle]
pub extern "C" fn pawn_phys_counts_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(PP_COUNTS) as *mut u32
}

#[no_mangle]
pub extern "C" fn pawn_phys_fields_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(PFIELDS) as *mut u32
}

#[link(wasm_import_module = "env")]
extern "C" {
    /// The host's admission and the walk's contexts: the depth, or -1 for
    /// the physics callback.
    fn js_pawn_begin(ctx: u32) -> i32;
    /// walking.mjs `walking(pawn, dt, 0)`, where the walk loop handed back.
    fn js_pawn_walk(depth: u32, dt: f64);
    /// flying.mjs `physFlying(pawn, dt, 0)`, where the reference raises a
    /// boundary.
    fn js_pawn_fly(depth: u32, dt: f64);
    /// The view's `moveActor([0,0,0], [pitch, yaw, 0])`.
    fn js_pawn_rotate(depth: u32, pitch: f64, yaw: f64);
    /// The reference's body from stage 0 (the rotation gate), 1 (MoveTimer)
    /// or 2 (the PostTouch tail).
    fn js_pawn_tail(depth: u32, stage: u32, dt: f64);
    /// The contexts popped, then the tick's T_STATE as after a callback.
    fn js_pawn_end(ctx: u32, depth: u32);
}

#[inline(always)]
fn pf(i: usize) -> [u32; 2] { unsafe { (*core::ptr::addr_of!(PFIELDS))[i] } }
#[inline(always)]
fn p_at(base: u32, i: usize) -> u32 { base + pf(i)[0] }
#[inline(always)]
fn rotator(at: u32) -> [i32; 3] {
    [load32(at) as i32, load32(at + 4) as i32, load32(at + 8) as i32]
}
/// Whether `handle`'s fields are still read from the image at `base`.
#[inline(always)]
fn same_image(handle: u32, base: u32) -> bool {
    let info = receiver_info(handle);
    info & HOST == 0 && info & !15 == base
}

/// script-pawn-physics.mjs `fixToward`: the shorter arc from `current` to
/// `target`, at most |delta|, 16-bit masked. `delta` is a Math.trunc result.
fn fix_toward(current: i64, target: i64, delta: f64) -> i64 {
    let current = current & 0xffff;
    let target = target & 0xffff;
    if delta == 0.0 {
        return current;
    }
    let step = if delta < 0.0 { -delta } else { delta } as i64;
    let forward = (target - current) & 0xffff;
    if forward < 0x8000 {
        return (current + step.min(forward)) & 0xffff;
    }
    (current - step.min((current - target) & 0xffff)) & 0xffff
}

/// APawn::performPhysics for the walking (1) or flying (4) pawn `handle`
/// at `base`: true when the body ran here, false when the physics callback
/// must run it (nothing has happened yet).
pub(crate) fn perform(ctx: u32, handle: u32, base: u32, dt: f64, physics: f64) -> bool {
    // walking.mjs's timestep error stays the reference's.
    if physics == 1.0 && (!(dt > 0.0) || dt > 0.4f32 as f64) {
        return false;
    }
    let depth = unsafe { js_pawn_begin(ctx) };
    if depth < 0 {
        return false;
    }
    let depth = depth as u32;
    if physics == 1.0 {
        if walk_loop(depth, base, dt as f32, 0) == 0 {
            unsafe { js_pawn_walk(depth, dt) };
        }
    } else {
        let mut pawn = ImagePawn { depth, base };
        let fields = FlyFields {
            air_speed: quiet(load32(p_at(base, P_AIR_SPEED))),
            desired_speed: quiet(load32(p_at(base, P_DESIRED_SPEED))),
            accel_rate: quiet(load32(walk_at(base, W_ACCEL_RATE))),
        };
        let collide_world = crate::move_actor::flag(base, M_COLLIDE_WORLD);
        let zone_number = load8(p_at(base, P_ZONE_NUMBER)) as u32;
        if !phys_flying(&mut pawn, dt, &fields, collide_world, zone_number) {
            unsafe { js_pawn_fly(depth, dt) };
        }
    }
    tail(handle, base, depth, dt);
    unsafe { js_pawn_end(ctx, depth) };
    true
}

fn tail(handle: u32, base: u32, depth: u32, dt: f64) {
    if !same_image(handle, base) {
        unsafe { js_pawn_tail(depth, 0, dt) };
        return;
    }
    let physics = load8(walk_at(base, W_PHYSICS)) as i64;
    let rotation = rotator(address(base, M_ROTATION));
    let desired = rotator(p_at(base, P_DESIRED_ROTATION));
    let rate = rotator(p_at(base, P_ROTATION_RATE));
    if physics != 0xa && (rotation != desired || rate[2] > 0) {
        // physicsRotation: `motionFlags = (motionFlags & ~0x20) | 0x40`; the
        // host proved both bools are bits of the one motion word.
        count(0);
        let word = p_at(base, P_ROTATE_TO_DESIRED);
        store(word, (load32(word) & !pf(P_FIXED_ROTATION_DIR)[1]) | pf(P_ROTATE_TO_DESIRED)[1]);
        let yaw = fix_toward(rotation[1] as i64, desired[1] as i64, trunc(rate[1] as f64 * dt));
        // `physics===1||(physics===2&&isA(pawn))`: this is a Pawn.
        let target = if physics == 1 || physics == 2 { 0 } else { desired[0] as i64 };
        let mut pitch = fix_toward(rotation[0] as i64, target, trunc(dt * 32768.0));
        let limit = rate[0] as i64;
        if pitch < 0x8000 {
            if pitch > limit {
                pitch = limit;
            }
        } else {
            let lo = 0x10000 - limit;
            if pitch < lo {
                pitch = lo;
            }
        }
        if pitch != rotation[0] as i64 || yaw != rotation[1] as i64 || rotation[2] != 0 {
            let fits = pitch >= i32::MIN as i64 && pitch <= i32::MAX as i64;
            if fits && move_pawn(depth, base, 0.0, 0.0, 0.0, 1, pitch as i32, yaw as i32, 0, 0) == MP_DONE {
                count(1);
            } else {
                unsafe { js_pawn_rotate(depth, pitch as f64, yaw as f64) };
            }
            if !same_image(handle, base) {
                unsafe { js_pawn_tail(depth, 1, dt) };
                return;
            }
        }
    }
    // `pawn.moveTimer=f(pawn.moveTimer-delta)`.
    let timer = walk_at(base, W_MOVE_TIMER);
    let value = f32::from_bits(quiet(load32(timer))) as f64;
    store(timer, ((value - dt) as f32).to_bits());
    let avg = p_at(base, P_AVG_PHYSICS_TIME);
    store(avg, crate::phys_avg_time(quiet(load32(avg)), (dt as f32).to_bits()));
    if crate::interp::live(load32(p_at(base, P_PENDING_TOUCH))) != 0 {
        count(2);
        unsafe { js_pawn_tail(depth, 2, dt) };
    }
}

/// Math.trunc of a finite double (the products here are below 2^31).
#[inline(always)]
fn trunc(x: f64) -> f64 {
    x as i64 as f64
}
