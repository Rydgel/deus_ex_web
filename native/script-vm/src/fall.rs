//! AActor::performPhysics for a non-Pawn actor in PHYS_Falling (Engine.dll
//! 0x103c9770 -> physFalling 0x103d0a50 with the source not a Pawn), on the
//! actor's image (docs/rust-core.md, step R3-b B6c). The JavaScript
//! references are actor-physics.mjs `performActorPhysics` and falling.mjs
//! `falling(host, seconds, 0, {nonPawn: true, hitWallEvent})` over the
//! field-backed host script-actor-physics.mjs `runSpawnedActorFalling`
//! builds; they run whenever the host (actor-physics-kernel.mjs) declines.
//!
//! Each read the reference makes through its host is an image load here
//! (the fall field table, the move table for Location and bDeleteMe, the
//! zone actor's image for Region.Zone's fields); each effect is one import
//! at the reference's point: HitWall through processDecorationHitWall, the
//! bBounce branch's HitWall event, processLanded (decorationLanded or
//! actorLanded), and the performPhysics tail (physicsRotation and
//! PostTouch) when the actor needs it. MoveActor is `move_source` (B4's
//! body with the non-Pawn CheckEncroachment test), or the JavaScript
//! `playerMove` where it hands a call back.
//!
//! Arithmetic follows the reference: doubles in the same order, `f` at
//! every Math.fround, and the 80-bit model (x87.rs `Ext`) where falling.mjs
//! uses script-vm.mjs's `x87*` (the water and bBobbing integrations, the
//! apex subdivision, the time refund).
//!
//! `perform_projectile` is the same for PHYS_Projectile (physProjectile,
//! 0x103d4600; the reference is projectile.mjs `projectile` over
//! script-actor-physics.mjs `runActorProjectile`): the host, the field table,
//! the move and the tail are the falling body's; the HitWall event is
//! `js_fall_bounce`'s, a bounce that left the actor falling hands the
//! remaining time to the JavaScript physFalling (`js_fall_falling`).
use crate::interp::{live, load32, load8, quiet, receiver_info, HOST};
use crate::move_actor::{address, flag, store};
use crate::move_pawn::{move_source, mp_io, MP_DONE};
use crate::phys_refund_time;
use crate::trace::{f, js_min};
use crate::walk::{safe_normal, two_wall_adjust, V3};
use crate::x87::Ext;

// The fall field table (actor-physics-kernel.mjs FALL_FIELDS): [offset,
// mask]. Rows 10..14 are the zone actor's fields, 15 Decoration's
// bBobbing, 16 and 17 Region's Zone and ZoneNumber members.
const FF_VELOCITY: usize = 0;
const FF_ACCELERATION: usize = 1;
const FF_OLD_LOCATION: usize = 2;
const FF_PHYSICS: usize = 3;
const FF_JUST_TELEPORTED: usize = 4;
const FF_BOUNCE: usize = 5;
const FF_MASS: usize = 6;
const FF_BUOYANCY: usize = 7;
const FF_ROTATION_RATE: usize = 8;
const FF_PENDING_TOUCH: usize = 9;
const FF_ZONE_GRAVITY: usize = 10;
const FF_ZONE_VELOCITY: usize = 11;
const FF_ZONE_TERMINAL_VELOCITY: usize = 12;
const FF_ZONE_FLUID_FRICTION: usize = 13;
const FF_WATER_ZONE: usize = 14;
// Decoration's bBobbing (written for Decoration classes only).
const FF_BOBBING: usize = 15;
const FF_REGION_ZONE: usize = 16;
// Projectile.MaxSpeed (physProjectile's clamp, for an engine.projectile only).
const FF_MAX_SPEED: usize = 17;
// Region.ZoneNumber (18) is the host's, read in js_fall_begin.
const FF_COUNT: usize = 19;
// The move table's rows (move-actor-kernel.mjs MOVE_FIELDS).
const M_DELETE_ME: usize = 6;
const M_LOCATION: usize = 9;

static mut FFIELDS: [[u32; 2]; FF_COUNT] = [[0; 2]; FF_COUNT];
// FALL_IO: a handed-back move's answer [time, nx, ny, nz, actor handle],
// or the zone fallback's [gravity 3, velocity 3, terminal, friction, water].
static mut FALL_IO: [f64; 9] = [0.0; 9];
// FALL_STATE: [0] the source is a Decoration, [1] an engine.projectile (js_fall_begin writes them).
static mut FALL_STATE: [u32; 2] = [0; 2];
// Counts for the differential (actor-physics-kernel.mjs RUST_COUNTS).
static mut FALL_COUNTS: [u32; 24] = [0; 24];
const C_CALLS: usize = 0;
const C_SUBSTEPS: usize = 1;
const C_WATER: usize = 2;
const C_BOBBING: usize = 3;
const C_APEX: usize = 4;
const C_BLOCKED: usize = 5;
const C_BOUNCES: usize = 6;
const C_LANDINGS: usize = 7;
const C_WALLS: usize = 8;
const C_SLIDES: usize = 9;
const C_TWO_WALLS: usize = 10;
const C_TERMINAL: usize = 11;
const C_DELETED: usize = 12;
const C_TAILS: usize = 13;
const C_MOVE_HANDBACKS: usize = 14;
const C_ZONE_FALLBACKS: usize = 15;
const C_PROJECTILES: usize = 16;
const C_PROJ_ITERATIONS: usize = 17;
const C_PROJ_HITS: usize = 18;
const C_PROJ_FALLS: usize = 19;
const C_PROJ_CLAMPS: usize = 20;
const C_PROJ_BOUNCES: usize = 21;
const C_PROJ_WATER: usize = 22;
#[inline(always)]
fn count(i: usize) {
    unsafe { let c = core::ptr::addr_of_mut!(FALL_COUNTS); (*c)[i] = (*c)[i].wrapping_add(1); }
}

#[no_mangle]
pub extern "C" fn fall_fields_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(FFIELDS) as *mut u32
}
#[no_mangle]
pub extern "C" fn fall_io_ptr() -> *mut f64 {
    core::ptr::addr_of_mut!(FALL_IO) as *mut f64
}
#[no_mangle]
pub extern "C" fn fall_state_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(FALL_STATE) as *mut u32
}
#[no_mangle]
pub extern "C" fn fall_counts_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(FALL_COUNTS) as *mut u32
}

#[link(wasm_import_module = "env")]
extern "C" {
    fn js_fall_begin(ctx: u32, physics: u32) -> i32;
    fn js_fall_move(depth: u32, dx: f64, dy: f64, dz: f64);
    fn js_fall_hit_wall(depth: u32, nx: f64, ny: f64, nz: f64, actor: u32);
    fn js_fall_bounce(depth: u32, nx: f64, ny: f64, nz: f64, actor: u32);
    fn js_fall_landed(depth: u32, time: f64, nx: f64, ny: f64, nz: f64, actor: u32);
    fn js_fall_blocked(depth: u32, actor: u32);
    fn js_fall_zone(depth: u32);
    fn js_fall_error(depth: u32, code: u32);
    fn js_fall_tail(depth: u32, dt: f64);
    fn js_fall_end(ctx: u32, depth: u32);
    fn js_fall_falling(depth: u32, remaining: f64, iterations: u32);
}
// js_fall_error codes (actor-physics-kernel.mjs ERRORS).
const E_NO_ZONE: u32 = 1;
const E_IMAGE: u32 = 2;

#[inline(always)]
fn ff(i: usize) -> [u32; 2] { unsafe { (*core::ptr::addr_of!(FFIELDS))[i] } }
#[inline(always)]
fn at(base: u32, i: usize) -> u32 { base + ff(i)[0] }
#[inline(always)]
fn bit(base: u32, i: usize) -> bool { load32(at(base, i)) & ff(i)[1] != 0 }
#[inline(always)]
fn io(i: usize) -> f64 { unsafe { (*core::ptr::addr_of!(FALL_IO))[i] } }

/// A float32 cell as its JavaScript read yields it (getFloat32 quiets a
/// signaling NaN), as bits and as the number.
#[inline(always)]
fn cell_bits(a: u32) -> u32 { quiet(load32(a)) }
#[inline(always)]
fn num(bits: u32) -> f64 { f32::from_bits(bits) as f64 }
#[inline(always)]
fn bits(v: f64) -> u32 { (v as f32).to_bits() }
#[inline(always)]
fn read3(a: u32) -> [u32; 3] { [cell_bits(a), cell_bits(a + 4), cell_bits(a + 8)] }
#[inline(always)]
fn write3(a: u32, v: [u32; 3]) { store(a, v[0]); store(a + 4, v[1]); store(a + 8, v[2]); }
#[inline(always)]
fn nums(v: [u32; 3]) -> V3 { [num(v[0]), num(v[1]), num(v[2])] }
#[inline(always)]
fn bits3(v: V3) -> [u32; 3] { [bits(v[0]), bits(v[1]), bits(v[2])] }

#[inline(always)]
fn add(a: V3, b: V3) -> V3 { [f(a[0] + b[0]), f(a[1] + b[1]), f(a[2] + b[2])] }
#[inline(always)]
fn sub(a: V3, b: V3) -> V3 { [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])] }
#[inline(always)]
fn scale(a: V3, s: f64) -> V3 { [f(a[0] * s), f(a[1] * s), f(a[2] * s)] }
#[inline(always)]
fn dot(a: V3, b: V3) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }

#[inline(always)]
fn l(bits: u32) -> Ext { Ext::load(bits) }
#[inline(always)]
fn sub87(a: Ext, b: Ext) -> Ext { a.add(b.neg()) }
const ONE_BITS: u32 = 0x3f80_0000;
const HALF_BITS: u32 = 0x3f00_0000;
/// x87cmp's 'lt': below and ordered.
#[inline(always)]
fn lt(a: Ext, b: Ext) -> bool { let (c0, c3) = a.compare(b); c0 && !c3 }
/// x87cmp's 'gt': neither below nor equal nor unordered.
#[inline(always)]
fn gt(a: Ext, b: Ext) -> bool { let (c0, c3) = a.compare(b); !c0 && !c3 }

fn same_image(handle: u32, base: u32) -> bool {
    let info = receiver_info(handle);
    info & HOST == 0 && info & !15 == base
}

/// A move's answer as the reference's adapter returns it:
/// `{time: Math.fround(result.time), normal: result.hit?.normal ?? [0,0,0],
/// actor}` (the normal is not rounded).
struct FallHit {
    time: f64,
    normal: V3,
    actor: u32,
}

/// The reference's host over the image: the fields `runSpawnedActorFalling`
/// defines, read and written where `falling` touches them.
struct Faller {
    depth: u32,
    handle: u32,
    base: u32,
    decoration: bool,
}

impl Faller {
    fn location(&self) -> u32 { address(self.base, M_LOCATION) }
    fn position_bits(&self) -> [u32; 3] { read3(self.location()) }
    fn position(&self) -> V3 { nums(self.position_bits()) }
    fn velocity_bits(&self) -> [u32; 3] { read3(at(self.base, FF_VELOCITY)) }
    fn velocity(&self) -> V3 { nums(self.velocity_bits()) }
    fn set_velocity(&self, v: V3) { write3(at(self.base, FF_VELOCITY), bits3(v)); }
    fn set_velocity_bits(&self, v: [u32; 3]) { write3(at(self.base, FF_VELOCITY), v); }
    fn acceleration_bits(&self) -> [u32; 3] { read3(at(self.base, FF_ACCELERATION)) }
    fn set_acceleration_bits(&self, v: [u32; 3]) { write3(at(self.base, FF_ACCELERATION), v); }
    fn physics(&self) -> u32 { load8(at(self.base, FF_PHYSICS)) as u32 }
    fn just_teleported(&self) -> bool { bit(self.base, FF_JUST_TELEPORTED) }
    fn clear_just_teleported(&self) {
        let a = at(self.base, FF_JUST_TELEPORTED);
        store(a, load32(a) & !ff(FF_JUST_TELEPORTED)[1]);
    }
    fn bouncing(&self) -> bool { bit(self.base, FF_BOUNCE) }
    fn deleted(&self) -> bool { flag(self.base, M_DELETE_ME) }
    fn bobbing(&self) -> bool { self.decoration && bit(self.base, FF_BOBBING) }
    /// `regionZone()`'s image base: Region.Zone, or the reference's error
    /// for none; 0 for a zone without an image (its fields then come from
    /// JavaScript).
    fn zone_base(&self) -> u32 {
        let zone = live(load32(at(self.base, FF_REGION_ZONE)));
        if zone == 0 {
            unsafe { js_fall_error(self.depth, E_NO_ZONE) };
            return 0;
        }
        let info = receiver_info(zone);
        if info & HOST != 0 { 0 } else { info & !3 }
    }
    fn zone_fallback(&self) {
        count(C_ZONE_FALLBACKS);
        unsafe { js_fall_zone(self.depth) };
    }
    /// ZoneGravity or ZoneVelocity as float bits.
    fn zone_vec(&self, row: usize) -> [u32; 3] {
        let zone = self.zone_base();
        if zone != 0 { return read3(at(zone, row)); }
        self.zone_fallback();
        let o = if row == FF_ZONE_GRAVITY { 0 } else { 3 };
        [bits(io(o)), bits(io(o + 1)), bits(io(o + 2))]
    }
    fn zone_float_bits(&self, row: usize) -> u32 {
        let zone = self.zone_base();
        if zone != 0 { return cell_bits(at(zone, row)); }
        self.zone_fallback();
        bits(io(if row == FF_ZONE_TERMINAL_VELOCITY { 6 } else { 7 }))
    }
    fn water(&self) -> bool {
        let zone = self.zone_base();
        if zone != 0 { return bit(zone, FF_WATER_ZONE); }
        self.zone_fallback();
        io(8) != 0.0
    }
    /// `pawn.move(delta)`: `move_source` on this image, or the reference's
    /// adapter where it hands the call back.
    fn move_by(&self, delta: V3) -> FallHit {
        let code = move_source(self.depth, self.base, delta[0] as f32, delta[1] as f32, delta[2] as f32,
            0, 0, 0, 0, 0, true);
        if code != MP_DONE {
            count(C_MOVE_HANDBACKS);
            unsafe { js_fall_move(self.depth, delta[0], delta[1], delta[2]) };
            return FallHit { time: f(io(0)), normal: [io(1), io(2), io(3)], actor: io(4) as u32 };
        }
        let m = mp_io();
        if m[1] as i32 >= 0 {
            FallHit { time: f(m[0]), normal: [m[9], m[10], m[11]], actor: m[12] as u32 }
        } else {
            FallHit { time: f(m[0]), normal: [0.0; 3], actor: 0 }
        }
    }
    /// After an import that may run script: the image is the one this
    /// call reads (destroyed actors keep theirs until the purge).
    fn check_image(&self) {
        if !same_image(self.handle, self.base) { unsafe { js_fall_error(self.depth, E_IMAGE) }; }
    }
    fn hit_wall(&self, hit: &FallHit) {
        count(C_WALLS);
        unsafe { js_fall_hit_wall(self.depth, hit.normal[0], hit.normal[1], hit.normal[2], hit.actor) };
        self.check_image();
    }
    fn landed(&self, hit: &FallHit) {
        count(C_LANDINGS);
        unsafe { js_fall_landed(self.depth, hit.time, hit.normal[0], hit.normal[1], hit.normal[2], hit.actor) };
    }
}

/// falling.mjs `waterVelocity` (0x103d125a).
fn water_velocity(p: &Faller, old: [u32; 3], step: u32, gravity: [u32; 3], acceleration: [u32; 3]) -> [u32; 3] {
    let mass = l(cell_bits(at(p.base, FF_MASS)));
    let one = l(ONE_BITS);
    // `x87cmp(ONE_F, mass)` 'lt' or 'un' (C0) keeps Mass.
    let divisor = if one.compare(mass).0 { mass } else { one };
    let lift = sub87(Ext::load_f64(1.0), l(cell_bits(at(p.base, FF_BUOYANCY))).div(divisor));
    let half = l(HALF_BITS);
    let mut term = [0u32; 3];
    for i in 0..3 {
        let t1 = lift.mul(l(gravity[i])).store();
        let t2 = l(t1).add(l(acceleration[i])).store();
        let t3 = l(t2).mul(half).store();
        term[i] = l(t3).mul(l(step)).store();
    }
    let friction = l(step).mul(l(p.zone_float_bits(FF_ZONE_FLUID_FRICTION)));
    let k = sub87(one, friction.add(friction));
    let mut out = [0u32; 3];
    for i in 0..3 {
        out[i] = l(term[i]).add(l(k.mul(l(old[i])).store())).store();
    }
    out
}

/// falling.mjs `bobbingVelocity` (0x103d0f75, apex 0x103d1558).
fn bobbing_velocity(old: [u32; 3], step: u32, gravity: [u32; 3], acceleration: [u32; 3], apex: bool) -> [u32; 3] {
    let half = l(HALF_BITS);
    let mut out = [0u32; 3];
    for i in 0..2 {
        let t1 = l(gravity[i]).mul(half).store();
        let t2 = l(t1).add(l(acceleration[i])).store();
        let t3 = l(t2).mul(half).store();
        let t4 = l(t3).mul(l(step)).store();
        out[i] = l(t4).add(l(old[i])).store();
    }
    let z = l(gravity[2]).mul(half).add(l(acceleration[2])).mul(half).mul(l(step));
    out[2] = (if apex { l(z.store()) } else { z }).add(l(old[2])).store();
    out
}

/// The `integrate(apex)` closure: Acceleration and ZoneGravity re-read,
/// then the water, bBobbing or dry integration.
fn integrate(p: &Faller, old: [u32; 3], step: f64, apex: bool) -> [u32; 3] {
    let acceleration = p.acceleration_bits();
    let gravity = p.zone_vec(FF_ZONE_GRAVITY);
    if p.water() {
        count(C_WATER);
        return water_velocity(p, old, bits(step), gravity, acceleration);
    }
    if p.bobbing() {
        count(C_BOBBING);
        return bobbing_velocity(old, bits(step), gravity, acceleration, apex);
    }
    // `add(oldVelocity, scale(scale(add(acceleration, gravity), .5), step))`
    let sum = add(nums(acceleration), nums(gravity));
    bits3(add(nums(old), scale(scale(sum, 0.5), step)))
}

/// `falling(host, seconds, 0, {nonPawn: true, hitWallEvent})` after the
/// zone-0 test (the caller's).
fn falling(p: &Faller, seconds: f64) {
    let dt = f(seconds);
    let mut iterations = 0;
    let saved_acceleration = p.acceleration_bits();
    // `pawn.position=pawn.position.map(f); pawn.velocity=...; pawn.acceleration=[...saved]`.
    write3(p.location(), p.position_bits());
    p.set_velocity_bits(p.velocity_bits());
    p.set_acceleration_bits(saved_acceleration);
    let mut remaining = dt;
    let mut apex_split = false;
    let mut bounces = 0;
    while remaining > 0.0 && iterations < 8 {
        iterations += 1;
        count(C_SUBSTEPS);
        let mut step = if remaining > 0.1 { f(js_min(remaining * 0.5, f(0.1))) } else { remaining };
        let origin_bits = p.position_bits();
        let origin = nums(origin_bits);
        let old_bits = p.velocity_bits();
        let mut old_velocity = nums(old_bits);
        // 0x103d0ee2: OldLocation = Location, bJustTeleported cleared.
        write3(at(p.base, FF_OLD_LOCATION), origin_bits);
        p.clear_just_teleported();
        remaining = f(remaining - step);
        p.set_velocity_bits(integrate(p, old_bits, step, false));
        let vz = p.velocity()[2];
        if !apex_split && (old_velocity[2] > 0.0) != (vz > 0.0) && old_velocity[2].abs() > 5.0 && vz.abs() > 5.0 {
            apex_split = true;
            let zero = Ext::zero(0);
            let magnitude = |v: f64| { let x = l(bits(v)); if lt(x, zero) { x.neg() } else { x } };
            let ratio = magnitude(old_velocity[2]).div(magnitude(vz).add(magnitude(old_velocity[2])));
            let first = ratio.mul(l(bits(step)));
            let d015 = Ext::load_f64(0.015);
            if gt(first, d015) {
                let second = sub87(l(ONE_BITS), ratio).mul(l(bits(step)));
                if gt(second, d015) {
                    count(C_APEX);
                    step = num(first.store());
                    remaining = num(second.add(l(bits(remaining))).store());
                    p.set_velocity_bits(integrate(p, old_bits, step, true));
                }
            }
        } else {
            apex_split = false;
        }
        // 0x103d1bb9: ZoneVelocity per substep, reused at its end.
        let zone_velocity = nums(p.zone_vec(FF_ZONE_VELOCITY));
        let delta = scale(add(p.velocity(), zone_velocity), step);
        let mut hit = p.move_by(delta);
        if !same_image(p.handle, p.base) {
            unsafe { js_fall_error(p.depth, E_IMAGE) };
            return;
        }
        if p.deleted() { count(C_DELETED); return; }
        let blocked = hit.time < 1.0;
        if blocked {
            count(C_BLOCKED);
            // 0x103d1d1c-0x103d1d7b: a Decoration blocked by a PlayerPawn
            // lowers numLandings (falling.mjs `blockedBy`).
            if p.decoration {
                unsafe { js_fall_blocked(p.depth, hit.actor) };
                p.check_image();
            }
            if p.bouncing() {
                count(C_BOUNCES);
                unsafe { js_fall_bounce(p.depth, hit.normal[0], hit.normal[1], hit.normal[2], hit.actor) };
                p.check_image();
                if p.physics() == 0 { return; }
                if bounces < 2 { remaining = num(phys_refund_time(bits(remaining), bits(hit.time), bits(step))); }
                bounces += 1;
            } else if hit.normal[2] > 0.7 {
                // The refund is processLanded's RemainingTime, which its
                // non-Pawn branches never read.
                let _remaining = num(phys_refund_time(bits(remaining), bits(hit.time), bits(step)));
                if !p.just_teleported() && hit.time > 0.1 && hit.time * step > f(0.003) {
                    p.set_velocity(scale(sub(p.position(), origin), 1.0 / (hit.time * step)));
                }
                p.landed(&hit);
                return;
            } else {
                p.hit_wall(&hit);
                let old_normal = hit.normal;
                let mut slide = scale(sub(delta, scale(hit.normal, dot(delta, hit.normal))), 1.0 - hit.time);
                if dot(slide, delta) >= 0.0 {
                    count(C_SLIDES);
                    hit = p.move_by(slide);
                    p.check_image();
                    if hit.time < 1.0 {
                        if hit.normal[2] > 0.7 { p.landed(&hit); return; }
                        p.hit_wall(&hit);
                        count(C_TWO_WALLS);
                        slide = two_wall_adjust(safe_normal(delta), slide, hit.normal, old_normal, hit.time);
                        let ditch = old_normal[2] > 0.0 && hit.normal[2] > 0.0 && slide[2] == 0.0 &&
                            dot(old_normal, hit.normal) < 0.0;
                        hit = p.move_by(slide);
                        p.check_image();
                        if ditch || hit.normal[2] > 0.7 { p.landed(&hit); return; }
                    }
                }
                let traveled = scale(sub(p.position(), origin), 1.0 / step);
                old_velocity[0] = traveled[0];
                old_velocity[1] = traveled[1];
            }
        }
        // 0x103d22ce: bBounce and bJustTeleported re-read after the events.
        if blocked && p.bouncing() { continue; }
        if !p.just_teleported() {
            p.set_velocity(sub(scale(sub(p.position(), origin), 1.0 / step), zone_velocity));
            if p.velocity()[2] < old_velocity[2] || old_velocity[2] >= 0.0 {
                p.set_velocity(sub(scale(p.velocity(), 2.0), old_velocity));
            }
            let v = p.velocity();
            let terminal = f(num(p.zone_float_bits(FF_ZONE_TERMINAL_VELOCITY)));
            if f(dot(v, v)) > terminal * terminal {
                count(C_TERMINAL);
                p.set_velocity(scale(safe_normal(v), terminal));
            }
        }
    }
    p.set_acceleration_bits(saved_acceleration);
}

/// The actor tick's physics call for a non-Pawn in PHYS_Falling: whether
/// it ran here (false: the callback runs the whole call, nothing done).
pub(crate) fn perform(ctx: u32, handle: u32, base: u32, dt: f64) -> bool {
    // The reference's boundaries stay its own: a timestep outside (0, 0.4]
    // (falling's error) here; Region.ZoneNumber 0 (FellOutOfWorld) and a
    // static or immovable source (the map host's `playerMove` never tests
    // those) in js_fall_begin, which writes the tables first.
    if !(f(dt) > 0.0) || f(dt) > f(0.4) { return false; }
    let depth = unsafe { js_fall_begin(ctx, 2) };
    if depth < 0 { return false; }
    let depth = depth as u32;
    count(C_CALLS);
    let p = Faller { depth, handle, base, decoration: unsafe { (*core::ptr::addr_of!(FALL_STATE))[0] } != 0 };
    falling(&p, dt);
    // performActorPhysics's tail: physicsRotation for a nonzero
    // RotationRate component, then PendingTouch's PostTouch.
    let tail = !same_image(handle, base) || {
        let rate = at(base, FF_ROTATION_RATE);
        (0..3).any(|i| load32(rate + 4 * i) & 0xffff != 0) || live(load32(at(base, FF_PENDING_TOUCH))) != 0
    };
    if tail {
        count(C_TAILS);
        unsafe { js_fall_tail(depth, dt) };
    }
    unsafe { js_fall_end(ctx, depth) };
    true
}

/// projectile.mjs `projectile(host, seconds, 0, services)` after the zone-0
/// test (the caller's): AActor::physProjectile (0x103d4600). `maxspeed` is
/// set for an engine.projectile, whose MaxSpeed clamps the velocity.
fn projectile(p: &Faller, seconds: f64, maxspeed: bool) {
    // actor.oldPosition = [...actor.position]; actor.justTeleported = false.
    write3(at(p.base, FF_OLD_LOCATION), p.position_bits());
    p.clear_just_teleported();
    let dt = l(bits(seconds));
    let one = l(ONE_BITS);
    let mut remaining = num(dt.store());
    let mut bounces = 0;
    let mut iterations = 0u32;
    while remaining > 0.0 && iterations < 8 {
        iterations += 1;
        count(C_PROJ_ITERATIONS);
        if p.water() {
            count(C_PROJ_WATER);
            // 0x103d46f5: 1 - (ZoneFluidFriction * remaining) * 0.2, stored to
            // a float32 temporary; Z multiplies the register, X and Y the
            // temporary.
            let friction = l(p.zone_float_bits(FF_ZONE_FLUID_FRICTION));
            let factor = sub87(one, friction.mul(l(bits(remaining))).mul(Ext::load_f64(0.2)));
            let stored = l(factor.store());
            let v = p.velocity_bits();
            p.set_velocity_bits([stored.mul(l(v[0])).store(), stored.mul(l(v[1])).store(), factor.mul(l(v[2])).store()]);
        }
        // 0x103d4749: Velocity += Acceleration * remaining, the X and Y
        // products stored to float32 temporaries, the Z product kept.
        {
            let t = l(bits(remaining));
            let a = p.acceleration_bits();
            let pz = t.mul(l(a[2]));
            let py = l(t.mul(l(a[1])).store());
            let px = l(t.mul(l(a[0])).store());
            let v = p.velocity_bits();
            p.set_velocity_bits([px.add(l(v[0])).store(), py.add(l(v[1])).store(), pz.add(l(v[2])).store()]);
        }
        let time_tick = remaining;
        remaining = 0.0;
        if maxspeed {
            // 0x103d47d5: MaxSpeed^2 < (X*X + Y*Y) + Z*Z in 80-bit (C0: below
            // or unordered) clamps to SafeNormal * MaxSpeed.
            let v = p.velocity_bits();
            let m = l(cell_bits(at(p.base, FF_MAX_SPEED)));
            let (vx, vy, vz) = (l(v[0]), l(v[1]), l(v[2]));
            let sum = vx.mul(vx).add(vy.mul(vy)).add(vz.mul(vz));
            if m.mul(m).compare(sum).0 {
                count(C_PROJ_CLAMPS);
                p.set_velocity_bits(crate::safe_normal(v).map(|c| m.mul(l(c)).store()));
            }
        }
        // 0x103d4853: the move is Velocity * DeltaTime (the call's argument,
        // not this iteration's remaining time), one float32 store each.
        let v = p.velocity_bits();
        let delta = nums([dt.mul(l(v[0])).store(), dt.mul(l(v[1])).store(), dt.mul(l(v[2])).store()]);
        let hit = p.move_by(delta);
        if !same_image(p.handle, p.base) {
            unsafe { js_fall_error(p.depth, E_IMAGE) };
            return;
        }
        let time = l(bits(hit.time));
        // x87cmp(time, ONE) 'lt' or 'un' is C0.
        if !time.compare(one).0 || p.deleted() || p.just_teleported() { continue; }
        count(C_PROJ_HITS);
        unsafe { js_fall_bounce(p.depth, hit.normal[0], hit.normal[1], hit.normal[2], hit.actor) };
        p.check_image();
        if !p.bouncing() { continue; }
        count(C_PROJ_BOUNCES);
        if bounces < 2 { remaining = num(sub87(one, time).mul(l(bits(time_tick))).store()); }
        bounces += 1;
        if p.physics() == 2 {
            count(C_PROJ_FALLS);
            unsafe { js_fall_falling(p.depth, remaining, iterations) };
            p.check_image();
        }
    }
    if p.bouncing() || p.just_teleported() { return; }
    // 0x103d49ab: Velocity = (Location - OldLocation) * (1 / DeltaTime). The Y
    // and Z differences and the reciprocal are stored to float32; X
    // multiplies both registers.
    let position = p.position_bits();
    let old = read3(at(p.base, FF_OLD_LOCATION));
    let dx = sub87(l(position[0]), l(old[0]));
    let dy = l(sub87(l(position[1]), l(old[1])).store());
    let dz = l(sub87(l(position[2]), l(old[2])).store());
    let reciprocal = one.div(dt);
    let stored = l(reciprocal.store());
    p.set_velocity_bits([reciprocal.mul(dx).store(), dy.mul(stored).store(), dz.mul(stored).store()]);
}

/// The actor tick's physics call for a non-Pawn in PHYS_Projectile (whether
/// it ran here; false: the callback runs the whole call, nothing done).
pub(crate) fn perform_projectile(ctx: u32, handle: u32, base: u32, dt: f64) -> bool {
    let depth = unsafe { js_fall_begin(ctx, 6) };
    if depth < 0 { return false; }
    let depth = depth as u32;
    count(C_PROJECTILES);
    let maxspeed = unsafe { (*core::ptr::addr_of!(FALL_STATE))[1] } != 0;
    let p = Faller { depth, handle, base, decoration: false };
    projectile(&p, dt, maxspeed);
    // performActorPhysics's tail, as the falling body's.
    let tail = !same_image(handle, base) || {
        let rate = at(base, FF_ROTATION_RATE);
        (0..3).any(|i| load32(rate + 4 * i) & 0xffff != 0) || live(load32(at(base, FF_PENDING_TOUCH))) != 0
    };
    if tail {
        count(C_TAILS);
        unsafe { js_fall_tail(depth, dt) };
    }
    unsafe { js_fall_end(ctx, depth) };
    true
}
