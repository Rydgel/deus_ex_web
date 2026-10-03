//! APawn::physFlying (Engine.dll 0x103d3040) and calcVelocity's accelerating
//! path on the pawn's image (docs/rust-core.md, step R3-b B6b). The
//! JavaScript reference is flying.mjs `physFlying` and `calcVelocity`, whose
//! x87 model (script-vm.mjs `x87*`) is `Ext` here (x87.rs, validated against
//! it by validate-script-vm-x87); `stepUp` and `twoWallAdjust` are walk.rs's
//! transcriptions of steps.mjs. Each read is an image load where the
//! reference reads the pawn view, each effect the walk loop's (walk_loop.rs
//! `ImagePawn`): MoveActor through `move_pawn` or its hand-back, HitWall
//! through the import.
//!
//! The pawn is never a PlayerPawn (the actor tick hands those back) and the
//! level is standalone (NetMode 0), so calcVelocity's walking clamp and
//! network boundary do not apply, and the ZoneVelocity gate is the speed
//! test alone. The reference's two boundaries (a nonpositive timestep, a
//! colliding pawn in zone 0) are returned before any effect: the caller
//! runs the JavaScript body, which raises them.
use crate::pawn_phys::count;
use crate::safe_normal;
use crate::walk::{step_up, two_wall_adjust, PawnOps, StepUp};
use crate::walk_loop::ImagePawn;
use crate::x87::Ext;

const ONE_BITS: u32 = 0x3f80_0000;

/// x87 load of a float32 value's bits.
#[inline(always)]
fn l(bits: u32) -> Ext {
    Ext::load(bits)
}
#[inline(always)]
fn bits(v: f64) -> u32 {
    (v as f32).to_bits()
}
#[inline(always)]
fn num(bits: u32) -> f64 {
    f32::from_bits(bits) as f64
}
#[inline(always)]
fn sub(a: Ext, b: Ext) -> Ext {
    a.add(b.neg())
}
fn dot(a: [Ext; 3], b: [Ext; 3]) -> Ext {
    a[0].mul(b[0]).add(a[1].mul(b[1])).add(a[2].mul(b[2]))
}
fn loads(v: [u32; 3]) -> [Ext; 3] {
    [l(v[0]), l(v[1]), l(v[2])]
}
/// FCOM's C0: below or unordered.
#[inline(always)]
fn below(a: Ext, b: Ext) -> bool {
    a.compare(b).0
}
/// Neither below nor equal nor unordered.
#[inline(always)]
fn above(a: Ext, b: Ext) -> bool {
    let (c0, c3) = a.compare(b);
    !c0 && !c3
}
/// `fcomp 0.0; test ah,0x40` (C3): equal or unordered reads as zero.
#[inline(always)]
fn zero_component(bits: u32) -> bool {
    l(bits).compare(Ext::zero(0)).1
}

/// The pawn reads calcVelocity and physFlying make beyond the walk loop's
/// image pawn: AirSpeed, DesiredSpeed and AccelRate (float bits, read
/// before calcVelocity's first write; none of them is written here).
pub(crate) struct FlyFields {
    pub air_speed: u32,
    pub desired_speed: u32,
    pub accel_rate: u32,
}

/// calcVelocity(pawn, {direction, dt, maxSpeed, friction, fluid: 1, brake:
/// 0, buoyant}) for a non-PlayerPawn: Acceleration and Velocity written.
/// `buoyant` is physSwimming's (Buoyancy, Mass) float bits, None for
/// physFlying's `buoyant: 0`.
pub(crate) fn calc_velocity(p: &ImagePawn, direction: [u32; 3], dt: u32, max_speed: u32, friction: u32, desired_speed: u32,
    accel_rate: u32, buoyant: Option<(u32, u32)>) {
    let step = dt;
    let raw_friction = friction;
    // 0x103cd7bb: FILD bFluid (1); FCOM Friction -> the larger.
    let friction_used = if below(Ext::load_i32(1), l(raw_friction)) { raw_friction } else { 1.0f32.to_bits() };
    let velocity = p.velocity_bits();
    let mut acceleration = p.acceleration_bits();
    let speed = dot(loads(velocity), loads(velocity)).store_double().sqrt().store();
    let rate = l(accel_rate);
    let accel_squared = dot(loads(acceleration), loads(acceleration));
    if below(rate.mul(rate), accel_squared) {
        acceleration = direction.map(|c| l(c).mul(rate).store());
    }
    p.set_acceleration_bits(acceleration);
    // V = V - ((V - d*speed)*dt)*F, one store per operator.
    let toward = direction.map(|c| l(c).mul(l(speed)).store());
    let mut v = velocity;
    let mut scaled = [0u32; 3];
    for i in 0..3 {
        scaled[i] = l(l(sub(l(v[i]), l(toward[i])).store()).mul(l(step)).store()).mul(l(friction_used)).store();
    }
    for i in 0..3 {
        v[i] = sub(l(v[i]), l(scaled[i])).store();
    }
    // V = f(V * (1 - bFluid*dt*Friction)) + f(A*dt).
    let accel_step = acceleration.map(|c| l(step).mul(l(c)).store());
    let decay = sub(l(ONE_BITS), Ext::load_i32(1).mul(l(step)).mul(l(raw_friction)));
    for i in 0..3 {
        v[i] = l(accel_step[i]).add(l(decay.mul(l(v[i])).store())).store();
    }
    // 0x103cdf05: a non-PlayerPawn's MaxSpeed *= DesiredSpeed.
    let max = l(max_speed).mul(l(desired_speed)).store();
    if let Some((buoyancy, mass)) = buoyant {
        // 0x103cdf33: V += (ZoneGravity*dt) * f(1 - Buoyancy/Mass).
        let gravity_step = p.gravity().map(|g| l(step).mul(l(bits(g))).store());
        let lift = sub(Ext::load_f64(1.0), l(buoyancy).div(l(mass))).store();
        for i in 0..3 {
            v[i] = l(l(lift).mul(l(gravity_step[i])).store()).add(l(v[i])).store();
        }
    }
    let size_squared = dot(loads(v), loads(v)).store();
    if below(l(max).mul(l(max)), l(size_squared)) {
        v = safe_normal(v).map(|c| l(max).mul(l(c)).store());
    }
    p.set_velocity_bits(v);
}

/// physFlying(pawn, dt, 0). Returns false, before any effect, where the
/// reference raises a boundary.
pub(crate) fn phys_flying(p: &mut ImagePawn, seconds: f64, fields: &FlyFields, collide_world: bool, zone_number: u32) -> bool {
    let dt = bits(seconds);
    if !(num(dt) > 0.0) || (collide_world && zone_number == 0) {
        return false;
    }
    count(3);
    let acceleration = p.acceleration_bits();
    let direction = if acceleration.iter().all(|c| zero_component(*c)) { acceleration } else { safe_normal(acceleration) };
    calc_velocity(p, direction, dt, fields.air_speed, p.fluid_friction_bits(), fields.desired_speed, fields.accel_rate, None);
    let position = p.position_bits();
    p.set_old_location_bits(position);
    ImagePawn::set_just_teleported(p, false);
    // 0x103d318f: |ZoneVelocity|^2 > 90000 adds ZoneVelocity.
    let zone_velocity = p.zone_velocity().map(bits);
    let zone = if above(dot(loads(zone_velocity), loads(zone_velocity)), l(90000.0f32.to_bits())) { zone_velocity } else { [0; 3] };
    let velocity = p.velocity_bits();
    // X/Y sums are stored before *dt; the Z sum stays extended.
    let sum_x = l(zone[0]).add(l(velocity[0])).store();
    let sum_y = l(zone[1]).add(l(velocity[1])).store();
    let sum_z = l(zone[2]).add(l(velocity[2]));
    let delta = [l(sum_x).mul(l(dt)).store(), l(sum_y).mul(l(dt)).store(), sum_z.mul(l(dt)).store()];
    let one = Ext::load_f64(1.0);
    let mut hit = p.move_by(delta.map(num));
    if below(l(bits(hit.time)), one) {
        count(4);
        // 0x103d3306: GravDir.Z is +1 only when ZoneGravity.Z > 0.
        let gravity_z: i32 = if above(l(bits(p.gravity()[2])), Ext::zero(0)) { 1 } else { -1 };
        let desired = safe_normal(delta);
        let velocity_direction = safe_normal(p.velocity_bits());
        let up_down = l(velocity_direction[2]).mul(l((gravity_z as f32).to_bits()));
        let mut normal_z = l(bits(hit.normal[2]));
        if below(normal_z, Ext::zero(0)) {
            normal_z = normal_z.neg();
        }
        if below(normal_z, Ext::load_f64(0.2)) && below(up_down, Ext::load_f64(0.5)) && above(up_down, Ext::load_f64(-0.2)) {
            count(5);
            let remaining = sub(one, l(bits(hit.time))).store();
            let step_delta = delta.map(|c| l(c).mul(l(remaining)).store());
            let step_z = p.position_bits()[2];
            if let StepUp::Budget = step_up(p, [0.0, 0.0, gravity_z as f64], desired.map(num), step_delta.map(num)) {
                p.step_budget_error();
                return true;
            }
            let mut old = p.old_location_bits();
            old[2] = sub(l(old[2]), l(step_z)).add(l(p.position_bits()[2])).store();
            p.set_old_location_bits(old);
        } else {
            count(6);
            p.hit_wall(&hit);
            let normal = hit.normal.map(bits);
            let old_normal = normal;
            let into = dot(loads(normal), loads(delta));
            let z = sub(l(delta[2]), l(into.mul(l(normal[2])).store())).store();
            let y = sub(l(delta[1]), l(l(normal[1]).mul(into).store())).store();
            let x = sub(l(delta[0]), into.mul(l(normal[0])));
            let remaining = sub(one, l(bits(hit.time)));
            let slide_x = x.mul(remaining);
            let slide = [slide_x.store(), l(y).mul(remaining).store(), l(z).mul(remaining).store()];
            let progress = l(delta[2]).mul(l(slide[2])).add(l(delta[1]).mul(l(slide[1]))).add(slide_x.mul(l(delta[0])));
            if !below(progress, Ext::zero(0)) {
                count(7);
                hit = p.move_by(slide.map(num));
                if below(l(bits(hit.time)), one) {
                    count(8);
                    p.hit_wall(&hit);
                    let adjust = two_wall_adjust(desired.map(num), slide.map(num), hit.normal, old_normal.map(num), hit.time);
                    p.move_by(adjust);
                }
            }
        }
    }
    if !p.just_teleported() {
        // X stays extended into the reciprocal product; Y/Z are stored first
        // and multiply the float-stored reciprocal.
        let position = p.position_bits();
        let old = p.old_location_bits();
        let dx = sub(l(position[0]), l(old[0]));
        let dy = sub(l(position[1]), l(old[1])).store();
        let dz = sub(l(position[2]), l(old[2])).store();
        let reciprocal = one.div(l(dt));
        let stored = reciprocal.store();
        p.set_velocity_bits([reciprocal.mul(dx).store(), l(dy).mul(l(stored)).store(), l(dz).mul(l(stored)).store()]);
    }
    true
}
