//! APawn::physSwimming (Engine.dll 0x103d3cd0), APawn::Swim (0x103d3850)
//! and APawn::findWaterLine (0x103d3b10) on the pawn's image
//! (docs/rust-core.md, step R3-b B6d). The JavaScript reference is
//! swimming.mjs `physSwimming`, `swim` and `findWaterLine`, whose x87 model
//! (script-vm.mjs `x87*`) is `Ext` here; calcVelocity's buoyant path is
//! fly.rs `calc_velocity`, `stepUp` and `twoWallAdjust` walk.rs's. Each read
//! is an image load where the reference reads the pawn view, each effect the
//! walk loop's (walk_loop.rs `ImagePawn`): the surface prelude, MoveActor
//! through `move_pawn` or its hand-back, HitWall, setPhysics and the
//! physFalling tail through the walk imports, physFlying's through
//! `js_swim_fly`.
//!
//! bWaterZone is read from the zone actor's image: Region.Zone,
//! HeadRegion.Zone, and UModel::PointRegion's zone at a findWaterLine
//! midpoint (zone.rs `point_region`). A zone without an image, or a level
//! without the zone model, asks the view (`js_swim_water`).
//!
//! The pawn is never a PlayerPawn (the actor tick hands those back), so
//! the ZoneVelocity gate is the speed test alone. The reference's
//! positive-timestep boundary is the caller's hand-back, before any effect;
//! findWaterLine's non-convergence raises the reference's error through
//! `js_swim_error`.
use crate::fly::{calc_velocity, FlyFields};
use crate::interp::{live, load32, quiet, receiver_info, HOST};
use crate::pawn_phys::{count, pf, p_at, P_BUOYANCY, P_DESIRED_SPEED, P_HEAD_ZONE, P_WATER_SPEED, P_WATER_ZONE};
use crate::safe_normal;
use crate::walk::{step_up, two_wall_adjust, Hit, PawnOps, StepUp};
use crate::walk_loop::{at as walk_at, zone_model, ImagePawn, W_ACCEL_RATE, W_MASS, W_REGION_ZONE};
use crate::x87::Ext;
use crate::zone::point_region;

// pawn_phys.rs PP_COUNTS rows for physSwimming's branches.
pub(crate) const SW_CALLS: usize = 9;
const SW_HEAD_DAMP: usize = 10;
const SW_ZONE_VELOCITY: usize = 11;
const SW_BLOCKED: usize = 12;
const SW_STEP_UPS: usize = 13;
const SW_WALLS: usize = 14;
const SW_SLIDES: usize = 15;
const SW_TWO_WALLS: usize = 16;
const SW_EXITS: usize = 17;
const SW_WATER_LINES: usize = 18;
const SW_AIR: usize = 19;
const SW_KEEP_Z: usize = 20;
const SW_TO_FALLING: usize = 21;
const SW_RISE: usize = 22;
const SW_FALL_TAILS: usize = 23;
const SW_FLY_TAILS: usize = 24;
const SW_WATER_FALLBACKS: usize = 25;

#[link(wasm_import_module = "env")]
extern "C" {
    /// The view's `regionWater` (0), `headWater` (1) or `waterAt([x, y, z])`
    /// (2), for a zone without an image or a level without the zone model.
    fn js_swim_water(depth: u32, which: u32, x: f64, y: f64, z: f64) -> u32;
    /// `pawn.flying(remaining, iterations)`: flying.mjs `physFlying`.
    fn js_swim_fly(depth: u32, remaining: f64, iterations: i32);
    /// swimming.mjs's findWaterLine boundary (it throws).
    fn js_swim_error(depth: u32);
}

const ONE_BITS: u32 = 0x3f80_0000;
const HALF_BITS: u32 = 0x3f00_0000;

#[inline(always)]
fn l(bits: u32) -> Ext { Ext::load(bits) }
#[inline(always)]
fn bits(v: f64) -> u32 { (v as f32).to_bits() }
#[inline(always)]
fn num(bits: u32) -> f64 { f32::from_bits(bits) as f64 }
#[inline(always)]
fn sub(a: Ext, b: Ext) -> Ext { a.add(b.neg()) }
#[inline(always)]
fn fl(v: f32) -> Ext { l(v.to_bits()) }
/// FCOM's C0: below or unordered.
#[inline(always)]
fn below(a: Ext, b: Ext) -> bool { a.compare(b).0 }
/// Neither below nor equal nor unordered.
#[inline(always)]
fn above(a: Ext, b: Ext) -> bool { let (c0, c3) = a.compare(b); !c0 && !c3 }
/// `fcomp 0.0; test ah,0x40` (C3): equal or unordered reads as zero.
#[inline(always)]
fn zero_component(bits: u32) -> bool { l(bits).compare(Ext::zero(0)).1 }
/// `sameVector`: every component compares equal or unordered.
fn same_vector(a: [u32; 3], b: [u32; 3]) -> bool { (0..3).all(|i| l(a[i]).compare(l(b[i])).1) }
/// appSqrt(double): the extended root of the double, a NaN quieted.
fn sqrt_double(v: Ext) -> Ext { if v.nan() { v.quiet() } else { v.store_double().sqrt() } }
/// (x*x + y*y) + z*z over extended components.
fn squares(v: [Ext; 3]) -> Ext { v[0].mul(v[0]).add(v[1].mul(v[1])).add(v[2].mul(v[2])) }
fn differences(a: [u32; 3], b: [u32; 3]) -> [Ext; 3] { [sub(l(a[0]), l(b[0])), sub(l(a[1]), l(b[1])), sub(l(a[2]), l(b[2]))] }
fn loads(v: [u32; 3]) -> [Ext; 3] { [l(v[0]), l(v[1]), l(v[2])] }

/// `water(zone)`: false for no zone, the zone image's bWaterZone bit, or
/// None for a zone without an image.
fn zone_water(zone: u32) -> Option<bool> {
    if zone == 0 { return Some(false); }
    let info = receiver_info(zone);
    if info & HOST != 0 { return None; }
    let [offset, mask] = pf(P_WATER_ZONE);
    Some(load32((info & !3) + offset) & mask != 0)
}

impl ImagePawn {
    fn water_fallback(&self, which: u32, p: [f64; 3]) -> bool {
        count(SW_WATER_FALLBACKS);
        unsafe { js_swim_water(self.depth, which, p[0], p[1], p[2]) != 0 }
    }
    /// `pawn.regionWater`: Region.Zone's bWaterZone.
    fn region_water(&self) -> bool {
        zone_water(live(load32(walk_at(self.base, W_REGION_ZONE)))).unwrap_or_else(|| self.water_fallback(0, [0.0; 3]))
    }
    /// `pawn.headWater`: HeadRegion.Zone's bWaterZone.
    fn head_water(&self) -> bool {
        zone_water(live(load32(p_at(self.base, P_HEAD_ZONE)))).unwrap_or_else(|| self.water_fallback(1, [0.0; 3]))
    }
    /// `pawn.waterAt(point)`: the PointRegion zone's bWaterZone.
    fn water_at(&self, point: [u32; 3]) -> bool {
        let p = point.map(num);
        let model = zone_model();
        let zone = if model == 0 { None } else { point_region(model, p).and_then(|r| zone_water(live(r.zone))) };
        zone.unwrap_or_else(|| self.water_fallback(2, p))
    }
}

/// moveInto: MoveActor, keeping the caller's Hit where the native's early
/// return leaves it (every |Delta| component below the double 1e-4).
fn move_into(p: &mut ImagePawn, delta: [u32; 3], hit: Hit) -> Hit {
    let result = ImagePawn::move_by(p, delta.map(num));
    let small = Ext::load_f64(0.0001);
    if delta.iter().all(|c| below(l(c & 0x7fff_ffff), small)) { hit } else { result }
}

/// findWaterLine(Start, End): End, or None after the reference's
/// non-convergence error.
fn find_water_line(p: &mut ImagePawn, mut start: [u32; 3], mut end: [u32; 3]) -> Option<[u32; 3]> {
    let half = l(HALF_BITS);
    loop {
        if below(squares(differences(end, start)), Ext::load_f64(1.0)) { return Some(end); }
        let sum_z = l(start[2]).add(l(end[2]));
        let sum_y = l(start[1]).add(l(end[1])).store();
        let sum_x = l(start[0]).add(l(end[0])).store();
        let mid = [l(sum_x).mul(half).store(), l(sum_y).mul(half).store(), sum_z.mul(half).store()];
        count(SW_WATER_LINES);
        let to_start = p.water_at(mid) != p.region_water();
        let kept = if to_start { start } else { end };
        // `mid.every((c, i) => c === kept[i])`: float equality.
        if (0..3).all(|i| num(mid[i]) == num(kept[i])) {
            unsafe { js_swim_error(p.depth) };
            return None;
        }
        if to_start { start = mid; } else { end = mid; }
    }
}

/// Swim(Delta, Hit): (airTime, Hit).
fn swim(p: &mut ImagePawn, delta: [u32; 3], hit: Hit) -> Option<(u32, Hit)> {
    let start = p.position_bits();
    let mut air = 0u32;
    let mut hit = move_into(p, delta, hit);
    if !p.region_water() {
        count(SW_EXITS);
        let location = p.position_bits();
        let end = find_water_line(p, start, location)?;
        if !same_vector(end, location) {
            count(SW_AIR);
            let outside = sqrt_double(squares(differences(end, location))).store();
            let [dx, dy, dz] = loads(delta);
            let length = sqrt_double(dy.mul(dy).add(dz.mul(dz)).add(dx.mul(dx)));
            air = l(outside).div(length).store();
            let back = differences(end, location).map(|c| c.store());
            hit = move_into(p, back, hit);
        }
    }
    Some((air, hit))
}

/// physSwimming's slide (0x103d40e5..0x103d4183): the slide and whether it
/// goes forward. Its dot sums (N.Y*D.Y + N.X*D.X) + D.Z*N.Z.
fn slide_along(delta: [u32; 3], normal: [u32; 3], time: f64) -> ([u32; 3], bool) {
    let into = l(normal[1]).mul(l(delta[1])).add(l(normal[0]).mul(l(delta[0]))).add(l(delta[2]).mul(l(normal[2])));
    let z = sub(l(delta[2]), l(into.mul(l(normal[2])).store())).store();
    let y = sub(l(delta[1]), l(l(normal[1]).mul(into).store())).store();
    let x = sub(l(delta[0]), into.mul(l(normal[0])));
    let remaining = sub(Ext::load_f64(1.0), l(bits(time)));
    let slide_x = x.mul(remaining);
    let slide = [slide_x.store(), l(y).mul(remaining).store(), l(z).mul(remaining).store()];
    let progress = l(delta[2]).mul(l(slide[2])).add(l(delta[1]).mul(l(slide[1]))).add(slide_x.mul(l(delta[0])));
    (slide, !below(progress, Ext::zero(0)))
}

/// physSwimming(pawn, dt, iterations) for a positive float timestep (the
/// caller hands a nonpositive one back).
pub(crate) fn phys_swimming(p: &mut ImagePawn, seconds: f64, mut iterations: i32) {
    let dt = bits(seconds);
    count(SW_CALLS);
    if p.prelude(num(dt), iterations) { return; }
    let one = Ext::load_f64(1.0);
    if !p.head_water() {
        let mut v = p.velocity_bits();
        if above(l(v[2]), fl(100.0)) {
            count(SW_HEAD_DAMP);
            v[2] = sub(l(ONE_BITS), l(dt)).mul(l(v[2])).store();
            p.set_velocity_bits(v);
        }
    }
    iterations += 1;
    let position = p.position_bits();
    p.set_old_location_bits(position);
    ImagePawn::set_just_teleported(p, false);
    let acceleration = p.acceleration_bits();
    let direction = if acceleration.iter().all(|c| zero_component(*c)) { acceleration } else { safe_normal(acceleration) };
    // calcVelocity's reads, after the prelude's script: WaterSpeed and the
    // zone's fluid friction as its arguments, then AccelRate, DesiredSpeed,
    // ZoneGravity, Buoyancy and Mass.
    let water_speed = quiet(load32(p_at(p.base, P_WATER_SPEED)));
    let friction = p.fluid_friction_bits();
    let fields = FlyFields {
        air_speed: water_speed,
        desired_speed: quiet(load32(p_at(p.base, P_DESIRED_SPEED))),
        accel_rate: quiet(load32(walk_at(p.base, W_ACCEL_RATE))),
    };
    let buoyant = (quiet(load32(p_at(p.base, P_BUOYANCY))), quiet(load32(walk_at(p.base, W_MASS))));
    calc_velocity(p, direction, dt, fields.air_speed, friction, fields.desired_speed, fields.accel_rate, Some(buoyant));
    let mut vel_z = p.velocity_bits()[2];
    // 0x103d3e02: |ZoneVelocity|^2 > 90000 adds ZoneVelocity*25*dt.
    let zv = p.zone_velocity().map(bits);
    let k25 = fl(25.0);
    let zone = if above(squares(loads(zv)), fl(90000.0)) {
        count(SW_ZONE_VELOCITY);
        [l(l(zv[0]).mul(k25).store()).mul(l(dt)).store(), l(l(zv[1]).mul(k25).store()).mul(l(dt)).store(),
            l(zv[2]).mul(k25).mul(l(dt)).store()]
    } else { [0; 3] };
    let velocity = p.velocity_bits();
    let sum_x = l(zone[0]).add(l(velocity[0])).store();
    let sum_y = l(zone[1]).add(l(velocity[1])).store();
    let sum_z = l(zone[2]).add(l(velocity[2]));
    let delta = [l(sum_x).mul(l(dt)).store(), l(sum_y).mul(l(dt)).store(), sum_z.mul(l(dt)).store()];
    let start_hit = Hit { time: 1.0, normal: [0.0; 3], actor: 0, id: 0 };
    let Some((air, mut hit)) = swim(p, delta, start_hit) else { return; };
    let mut remaining = l(air).mul(l(dt)).store();
    if below(l(bits(hit.time)), one) {
        count(SW_BLOCKED);
        let gravity_z: i32 = if above(l(bits(p.gravity()[2])), Ext::zero(0)) { 1 } else { -1 };
        let desired = safe_normal(delta);
        let velocity_direction = safe_normal(p.velocity_bits());
        let up_down = l(velocity_direction[2]).mul(l((gravity_z as f32).to_bits()));
        let mut normal_z = l(bits(hit.normal[2]));
        if below(normal_z, Ext::zero(0)) { normal_z = normal_z.neg(); }
        if below(normal_z, Ext::load_f64(0.2)) && below(up_down, Ext::load_f64(0.5)) && above(up_down, Ext::load_f64(-0.2)) {
            count(SW_STEP_UPS);
            let factor = sub(one, l(bits(hit.time))).store();
            let step_delta = delta.map(|c| l(c).mul(l(factor)).store());
            let step_z = p.position_bits()[2];
            if let StepUp::Budget = step_up(p, [0.0, 0.0, gravity_z as f64], desired.map(num), step_delta.map(num)) {
                p.step_budget_error();
                return;
            }
            let mut old = p.old_location_bits();
            old[2] = sub(l(old[2]), l(step_z)).add(l(p.position_bits()[2])).store();
            p.set_old_location_bits(old);
        } else {
            count(SW_WALLS);
            PawnOps::hit_wall(p, &hit);
            let old_normal = hit.normal.map(bits);
            let (slide, forward) = slide_along(delta, old_normal, hit.time);
            if forward {
                count(SW_SLIDES);
                let Some((air, next)) = swim(p, slide, hit) else { return; };
                hit = next;
                remaining = sub(one, l(bits(hit.time))).mul(l(air)).mul(l(remaining)).store();
                if below(l(bits(hit.time)), one) {
                    count(SW_TWO_WALLS);
                    PawnOps::hit_wall(p, &hit);
                    let adjusted = two_wall_adjust(desired.map(num), slide.map(num), hit.normal, old_normal.map(num), hit.time);
                    let Some((air, next)) = swim(p, adjusted.map(bits), hit) else { return; };
                    hit = next;
                    remaining = sub(one, l(bits(hit.time))).mul(l(air)).mul(l(remaining)).store();
                }
            }
        }
    }
    if !p.just_teleported() && below(l(remaining), l(dt)) {
        let current_z = p.velocity_bits()[2];
        // 'lt' or 'gt': ordered and unequal, C3 clear.
        let keep_z = !l(vel_z).compare(l(current_z)).1;
        if keep_z { count(SW_KEEP_Z); vel_z = current_z; }
        let position = p.position_bits();
        let old = p.old_location_bits();
        let dz = sub(l(position[2]), l(old[2]));
        let dy = sub(l(position[1]), l(old[1])).store();
        let dx = sub(l(position[0]), l(old[0])).store();
        let reciprocal = one.div(sub(l(dt), l(remaining)));
        let stored = reciprocal.store();
        let mut next = [l(stored).mul(l(dx)).store(), l(stored).mul(l(dy)).store(), dz.mul(reciprocal).store()];
        if keep_z { next[2] = vel_z; }
        p.set_velocity_bits(next);
    }
    if !p.region_water() {
        if ImagePawn::physics(p) == 3 { count(SW_TO_FALLING); p.set_physics(2); }
        let mut next = p.velocity_bits();
        if below(l(next[2]), fl(160.0)) && above(l(next[2]), Ext::zero(0)) {
            count(SW_RISE);
            let size2d = sqrt_double(l(next[0]).mul(l(next[0])).add(l(next[1]).mul(l(next[1]))));
            next[2] = size2d.mul(Ext::load_f64(0.4)).add(Ext::load_f64(40.0)).store();
            p.set_velocity_bits(next);
        }
    }
    if above(l(remaining), Ext::load_f64(0.01)) {
        match ImagePawn::physics(p) {
            2 => { count(SW_FALL_TAILS); p.falling(num(remaining), iterations); }
            4 => { count(SW_FLY_TAILS); unsafe { js_swim_fly(p.depth, num(remaining), iterations) }; }
            _ => {}
        }
    }
}
