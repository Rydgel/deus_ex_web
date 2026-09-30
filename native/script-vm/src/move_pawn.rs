//! ULevel::MoveActor for a Pawn source on the pawn's image (docs/rust-core.md,
//! step R3-b B4). The JavaScript references are move-query.mjs `moveQuery`
//! (the translation query and candidate selection) and player-move.mjs
//! `playerMove` (the commit, the based-rider pass, the Bump and Touch
//! events and SetActorZone), reached through the map pawn view's
//! `moveActor` (script-pawn-physics.mjs). Both stay the references: they run
//! whenever the host declines a call or this body hands one back, which
//! happens before any store.
//!
//! Every read of the source is an image load through the move field table
//! (move_actor.rs FIELDS, the host's MOVE_FIELDS); every effect is one
//! import at the point where the reference makes it: the MultiLineCheck
//! query (`js_move_hits`, which also runs the reference's `decorate` on each
//! hit's actor and keeps the hit objects on the host), the per-candidate
//! IsBasedOn and type tests in the reference's order (`js_move_cand`), the
//! `hits.some` test behind `eligibleScanned` (`js_move_eligible`), the
//! rider pass, the hash remove and add, BumpWall or the Bump pair, the Touch
//! pass's tests and BeginTouch, IsOverlapping and EndTouch, and
//! SetActorZone. An import may run script that moves, destroys or
//! re-collides anything, so the source's fields are read again after each
//! one, as the reference reads them.
//!
//! Arithmetic follows the reference: doubles in the same order, `f` at
//! every Math.fround, `sqrt` for Math.sqrt.
use crate::interp::{live, load32, load8};
use crate::move_actor::{address, flag, float, store};
use crate::trace::{abs, f, sqrt};

const HANDBACK: u32 = 0;
const DONE: u32 = 1;
pub(crate) const MP_DONE: u32 = DONE;
const MAX_HITS: usize = 64;
// A hit record the host writes per hit: time, the normal and the actor's
// handle (the world actor's for a world hit).
const HIT_WORDS: usize = 5;

// The move field table's rows (move-actor-kernel.mjs MOVE_FIELDS).
const F_STATIC: usize = 0;
const F_MOVABLE: usize = 1;
const F_COLLIDE_ACTORS: usize = 2;
const F_COLLIDE_WORLD: usize = 3;
const F_BLOCK_ACTORS: usize = 4;
const F_BLOCK_PLAYERS: usize = 5;
const F_STANDING_COUNT: usize = 7;
const F_TOUCHING: usize = 8;
const F_LOCATION: usize = 9;
const F_ROTATION: usize = 10;
const F_RADIUS: usize = 11;
const F_HEIGHT: usize = 12;

// js_move_cand's answer: bit 0 skip (an IsBasedOn test held), else bit 1
// the world actor, bit 2 a moving brush, bit 3 a controlled player or a
// projectile, and the candidate's collision word in bits 8..15.
const C_SKIP: u32 = 1;
const C_WORLD: u32 = 2;
const C_BRUSH: u32 = 4;
const C_PLAYER_OR_PROJECTILE: u32 = 8;

// MP_IO, written at the end of a completed call: [0] the query's time,
// [1] the selected hit's index (or -1), [2] success (0/1), [3..6] the
// query's delta, [6..9] the source's Location after the move, [9..12] the
// selected hit's normal and [12] its actor's handle (0 without a hit).
static mut MP_IO: [f64; 13] = [0.0; 13];

#[no_mangle]
pub extern "C" fn move_pawn_io_ptr() -> *mut f64 {
    core::ptr::addr_of_mut!(MP_IO) as *mut f64
}
/// The last completed call's IO block (the walking loop reads it directly).
#[inline(always)]
pub(crate) fn mp_io() -> &'static [f64; 13] {
    unsafe { &*core::ptr::addr_of!(MP_IO) }
}

#[link(wasm_import_module = "env")]
extern "C" {
    fn js_move_hits(depth: u32, records: *mut f64, sx: f64, sy: f64, sz: f64, ex: f64, ey: f64, ez: f64,
                    rx: f64, ry: f64, rz: f64, check_actors: u32, world: u32) -> i32;
    fn js_move_cand(depth: u32, hit: u32, ignore_bases: u32) -> u32;
    fn js_move_eligible(depth: u32) -> u32;
    fn js_move_riders(depth: u32, dx: f64, dy: f64, dz: f64, pitch: i32, yaw: i32, roll: i32);
    fn js_move_hash(depth: u32, add: u32);
    fn js_move_bump(depth: u32, wall: u32, hit: u32);
    fn js_move_touch_facts(depth: u32, hit: u32) -> u32;
    fn js_move_begin_touch(depth: u32, hit: u32);
    fn js_move_overlap(depth: u32, handle: u32) -> u32;
    fn js_move_end_touch(depth: u32, handle: u32);
    fn js_move_zone(depth: u32);
}

#[inline(always)]
fn vector(at: u32) -> [f64; 3] {
    [float(at) as f64, float(at + 4) as f64, float(at + 8) as f64]
}
#[inline(always)]
fn rotator(at: u32) -> [i32; 3] {
    [load32(at) as i32, load32(at + 4) as i32, load32(at + 8) as i32]
}
#[inline(always)]
fn store_vector(at: u32, v: [f64; 3]) {
    for i in 0..3 { store(at + 4 * i as u32, (v[i] as f32).to_bits()); }
}
#[inline(always)]
fn store_rotator(at: u32, r: [i32; 3]) {
    for i in 0..3 { store(at + 4 * i as u32, r[i] as u32); }
}
/// The reference's `source.flags`: the +0x1dc collision bits the query and
/// the commit test (bProjTarget is never tested there).
#[inline(always)]
fn collision_flags(base: u32) -> u32 {
    (flag(base, F_COLLIDE_ACTORS) as u32) | ((flag(base, F_COLLIDE_WORLD) as u32) << 1) |
        ((flag(base, F_BLOCK_ACTORS) as u32) << 2) | ((flag(base, F_BLOCK_PLAYERS) as u32) << 3)
}
#[inline(always)]
fn standing_count(base: u32) -> u32 {
    load8(address(base, F_STANDING_COUNT)) as u32
}

fn finish(time: f64, hit: i32, success: bool, delta: [f64; 3], position: [f64; 3], records: &[f64]) -> u32 {
    let io = unsafe { &mut *core::ptr::addr_of_mut!(MP_IO) };
    io[0] = time;
    io[1] = hit as f64;
    io[2] = success as u32 as f64;
    io[3] = delta[0]; io[4] = delta[1]; io[5] = delta[2];
    io[6] = position[0]; io[7] = position[1]; io[8] = position[2];
    if hit >= 0 {
        let r = hit as usize * HIT_WORDS;
        io[9] = records[r + 1]; io[10] = records[r + 2]; io[11] = records[r + 3]; io[12] = records[r + 4];
    } else {
        io[9] = 0.0; io[10] = 0.0; io[11] = 0.0; io[12] = 0.0;
    }
    DONE
}

/// `playerMove(source, delta, ops, newRotation)` for the pawn whose image is
/// at `base`. `has_rot` 0 keeps the source's rotation (the reference's
/// `newRotation` null). Returns DONE with MP_IO filled, or HANDBACK before
/// any store.
#[no_mangle]
pub extern "C" fn move_pawn(depth: u32, base: u32, dx: f32, dy: f32, dz: f32, has_rot: u32,
                            pitch: i32, yaw: i32, roll: i32, ignore_bases: u32) -> u32 {
    // `const requested=delta.map(f),rotation=newRotation?[...newRotation]:[...source.rotation]`
    let requested = [dx as f64, dy as f64, dz as f64];
    let location = address(base, F_LOCATION);
    let rotation_at = address(base, F_ROTATION);
    let source_rotation = rotator(rotation_at);
    let rotation = if has_rot != 0 { [pitch, yaw, roll] } else { source_rotation };
    // moveQuery: start, delta and extent as float32; a nonfinite value is
    // the reference's error (before any store).
    let start = vector(location);
    let extent = [f(float(address(base, F_RADIUS)) as f64), f(float(address(base, F_RADIUS)) as f64),
        f(float(address(base, F_HEIGHT)) as f64)];
    for v in start.iter().chain(requested.iter()).chain(extent.iter()) {
        if !v.is_finite() { return HANDBACK; }
    }
    // `if(source.static||source.movable===false)return {success:false,...}`:
    // playerMove returns that query without a store.
    let mut records = [0.0f64; MAX_HITS * HIT_WORDS];
    if flag(base, F_STATIC) || !flag(base, F_MOVABLE) {
        return finish(1.0, -1, false, [0.0; 3], start, &records);
    }
    let tiny = requested.iter().all(|v| abs(*v) < 0.0001);
    let source_flags = collision_flags(base);
    // The query runs only for a non-tiny delta of a colliding source; the
    // reference's `hits` is [] otherwise (the context's may be an earlier
    // call's when the walking loop calls this body directly).
    let queried = !tiny && source_flags & 3 != 0;
    let mut count: usize = 0;
    let mut hit: i32 = -1;
    let mut hit_world = false;
    let mut time = 1.0;
    let mut displacement = [0.0; 3];
    if !tiny {
        let delta = requested;
        let length = sqrt(delta[2] * delta[2] + delta[1] * delta[1] + delta[0] * delta[0]);
        let size = f(length);
        let reciprocal = f(1.0 / length);
        let direction = [f(delta[0] * reciprocal), f(delta[1] * reciprocal), f(delta[2] * reciprocal)];
        let extended = [f(delta[0] + 2.0 * direction[0]), f(delta[1] + 2.0 * direction[1]),
            f(delta[2] + 2.0 * direction[2])];
        displacement = delta;
        if source_flags & 3 != 0 {
            let end = [f(start[0] + extended[0]), f(start[1] + extended[1]), f(start[2] + extended[2])];
            let n = unsafe { js_move_hits(depth, records.as_mut_ptr(), start[0], start[1], start[2],
                end[0], end[1], end[2], extent[0], extent[1], extent[2],
                source_flags & 1, (source_flags >> 1) & 1) };
            if n < 0 || n as usize > MAX_HITS { return HANDBACK; }
            count = n as usize;
            if source_flags & 14 != 0 {
                for i in 0..count {
                    let c = unsafe { js_move_cand(depth, i as u32, ignore_bases) };
                    if c & C_SKIP != 0 { continue; }
                    let other_flags = c >> 8;
                    let blocks = if c & C_WORLD != 0 {
                        source_flags & 2 != 0
                    } else if c & C_BRUSH != 0 {
                        source_flags & 2 != 0 && other_flags & 8 != 0
                    } else {
                        other_flags & 8 != 0 &&
                            source_flags & (if c & C_PLAYER_OR_PROJECTILE != 0 { 8 } else { 4 }) != 0
                    };
                    if blocks { hit = i as i32; hit_world = c & C_WORLD != 0; break; }
                }
            }
        }
        if hit >= 0 {
            time = f(records[hit as usize * HIT_WORDS]);
            if time < 1.0 {
                let distance = (size + 2.0) * time;
                let stored_distance = f(distance);
                if distance <= 2.0 {
                    displacement = [0.0; 3];
                    time = 0.0;
                } else {
                    displacement = [f(f(extended[0] * time) - f(direction[0] * 2.0)),
                        f(f(extended[1] * time) - f(direction[1] * 2.0)),
                        f(f(extended[2] * time) - f(direction[2] * 2.0))];
                    time = f((stored_distance - 2.0) / size);
                }
            }
        }
    }
    let query_delta = displacement;
    let query_time = time;
    let query_position = [f(start[0] + displacement[0]), f(start[1] + displacement[1]), f(start[2] + displacement[2])];
    // playerMove after the query.
    let same_rotation = rotation == source_rotation;
    if tiny && (same_rotation || standing_count(base) == 0) {
        store_rotator(rotation_at, rotation);
        return finish(query_time, hit, query_time > 0.0, query_delta, query_position, &records);
    }
    if tiny && requested.iter().any(|v| *v != 0.0) { return HANDBACK; }
    let eligible_scanned = queried && source_flags & 14 != 0 && unsafe { js_move_eligible(depth) } != 0;
    if standing_count(base) != 0 {
        unsafe { js_move_riders(depth, query_delta[0], query_delta[1], query_delta[2], rotation[0], rotation[1], rotation[2]) };
    }
    if collision_flags(base) & 1 != 0 { unsafe { js_move_hash(depth, 0) }; }
    let position = vector(location);
    store_vector(location, [f(position[0] + query_delta[0]), f(position[1] + query_delta[1]), f(position[2] + query_delta[2])]);
    store_rotator(rotation_at, rotation);
    if collision_flags(base) & 1 != 0 { unsafe { js_move_hash(depth, 1) }; }
    if hit >= 0 {
        unsafe { js_move_bump(depth, hit_world as u32, hit as u32) };
    }
    let flags_now = collision_flags(base);
    if eligible_scanned || flags_now & 4 == 0 || flags_now & 8 == 0 {
        for i in 0..count {
            if !(f(records[i * HIT_WORDS]) < query_time) { break; }
            if unsafe { js_move_touch_facts(depth, i as u32) } == 0 {
                unsafe { js_move_begin_touch(depth, i as u32) };
            }
        }
    }
    let touching = address(base, F_TOUCHING);
    for i in 0..4 {
        let other = live(load32(touching + 4 * i));
        if other != 0 && unsafe { js_move_overlap(depth, other) } == 0 {
            unsafe { js_move_end_touch(depth, other) };
        }
    }
    unsafe { js_move_zone(depth) };
    finish(query_time, hit, query_time > 0.0, query_delta, vector(location), &records)
}
