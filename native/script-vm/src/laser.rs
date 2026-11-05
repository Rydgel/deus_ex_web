//! ULaserIterator::CurrentItem (DeusEx.dll 0x1001a1a0, docs/lasers.md) in
//! Rust: script-laser.mjs `laserCurrentItem`, statement for statement, on the
//! x87 model (x87.rs) at precision control 24, where SetupDynamics runs it
//! (docs/render-pass-precision.md). The JavaScript body stays the reference
//! (LASER=verify runs both); scripts/validate-native-laser.mjs compares both
//! with the DLL's body.
//!
//! The state is LASER_IO, words the host (laser-kernel.mjs) writes from
//! script-laser.mjs's iterator state before each item and reads back after
//! it (L_*): the eight sBeam structs, then Index, MaxItems, prevLoc,
//! prevRand, savedLoc, savedRot, nextItem, bRandomBeam and the Outer's
//! Location (float32 bits and int32 words). An item writes the proxy moves
//! after them: their count, then per move its kind (MOVE_LOCATION or
//! MOVE_ROTATION) and three words.

use crate::interp::{load32, store32};
use crate::x87::{set_x87_precision, Ext};
use core::ptr::addr_of_mut;

#[link(wasm_import_module = "env")]
extern "C" {
    /// appFrand from the caller's stream (script-vm-laser.mjs `frand`).
    fn js_laser_frand() -> f64;
    /// Math.atan2: FPATAN as vectorToRotator24 takes it.
    fn js_atan2(y: f64, x: f64) -> f64;
}

const BEAMS: u32 = 8;
/// A beam's words: bActive, Location (3), Rotation (3), Length, numSegments.
const BEAM_WORDS: u32 = 9;
const B_LOCATION: u32 = 1;
const B_ROTATION: u32 = 4;
const B_LENGTH: u32 = 7;
const B_SEGMENTS: u32 = 8;
const L_INDEX: u32 = BEAMS * BEAM_WORDS;
const L_MAXITEMS: u32 = L_INDEX + 1;
const L_PREVLOC: u32 = L_INDEX + 2;
const L_PREVRAND: u32 = L_INDEX + 5;
const L_SAVEDLOC: u32 = L_INDEX + 8;
const L_SAVEDROT: u32 = L_INDEX + 11;
const L_NEXTITEM: u32 = L_INDEX + 14;
const L_RANDOMBEAM: u32 = L_INDEX + 15;
const L_OWNER: u32 = L_INDEX + 16;
const L_MOVES: u32 = L_INDEX + 19;
/// Four moves of four words.
const L_WORDS: usize = L_MOVES as usize + 1 + 16;
const MOVE_LOCATION: u32 = 1;
const MOVE_ROTATION: u32 = 2;
/// The rotation scale FVector::Rotation multiplies by (the double at 0x10178050).
const ROTATION_SCALE: f64 = 10430.219195527361;

/// Results: an item computed, or FVector::Rotation of a non-finite vector
/// (the JavaScript body throws there).
const DONE: u32 = 0;
const NONFINITE: u32 = 1;

static mut LASER_IO: [u32; L_WORDS] = [0; L_WORDS];

#[no_mangle]
pub extern "C" fn laser_io_ptr() -> *mut u32 {
    addr_of_mut!(LASER_IO) as *mut u32
}

#[inline(always)]
fn word(block: u32, i: u32) -> u32 {
    load32(block.wrapping_add(4 * i))
}
#[inline(always)]
fn set(block: u32, i: u32, value: u32) {
    store32(block.wrapping_add(4 * i), value)
}
#[inline(always)]
fn ld(bits: u32) -> Ext {
    Ext::load(bits)
}
#[inline(always)]
fn sub(a: Ext, b: Ext) -> Ext {
    a.add(b.neg())
}
/// x87cmp's 'lt' or 'un' (FCOM's C0).
#[inline(always)]
fn less_or_unordered(a: Ext, b: Ext) -> bool {
    a.compare(b).0
}
/// x87cmp's 'gt'.
#[inline(always)]
fn greater(a: Ext, b: Ext) -> bool {
    a.compare(b) == (false, false)
}
/// x87cmp's 'eq' or 'un' (FCOM's C3).
#[inline(always)]
fn equal_or_unordered(a: Ext, b: Ext) -> bool {
    a.compare(b).1
}
fn one() -> Ext {
    Ext::load_f64(1.0)
}
fn sin(angle: i32) -> f64 {
    f32::from_bits(crate::rotator_sin(angle)) as f64
}

/// FVector::UnsafeNormal (Core 0x10117dd0): (x*x + y*y) + z*z, FSTP to a
/// double, FSQRT, FDIVR by the double 1.0, each component times that scale.
fn unsafe_normal(v: [u32; 3]) -> [u32; 3] {
    let [x, y, z] = v.map(ld);
    let sum = x.mul(x).add(y.mul(y)).add(z.mul(z)).store_double();
    let scale = one().div(sum.sqrt());
    [scale.mul(x).store(), scale.mul(y).store(), scale.mul(z).store()]
}

/// FVector::Rotation (Core 0x10144390) at precision control 24, as
/// vectorToRotator24: None for a non-finite component.
fn rotation24(v: [u32; 3]) -> Option<[i32; 3]> {
    let [x, y, z] = v.map(|b| f32::from_bits(b) as f64);
    if !(x.is_finite() && y.is_finite() && z.is_finite()) {
        return None;
    }
    let r24 = crate::p24::r24;
    let root = r24(crate::trace::sqrt(r24(r24(y * y) + r24(x * x)))) as f32 as f64;
    let scaled = |angle: f64| Ext::load_f64(angle).mul(Ext::load_f64(ROTATION_SCALE)).ftol();
    Some([scaled(unsafe { js_atan2(z, root) }), scaled(unsafe { js_atan2(y, x) }), 0])
}

/// CurrentItem for the state in LASER_IO (an iterator with a proxy): DONE
/// with the moves and the new state there, or NONFINITE.
#[no_mangle]
pub extern "C" fn laser_current_item() -> u32 {
    let previous = set_x87_precision(24);
    let result = current_item(laser_io_ptr() as u32);
    set_x87_precision(previous);
    result
}

fn current_item(block: u32) -> u32 {
    let index = word(block, L_INDEX) as i32;
    // The beam holding Index: active beams accumulate numSegments (int32).
    let (mut beam, mut cumulative) = (0u32, 0i32);
    for i in 0..BEAMS {
        let at = i * BEAM_WORDS;
        if word(block, at) == 0 {
            continue;
        }
        cumulative = cumulative.wrapping_add(word(block, at + B_SEGMENTS) as i32);
        if index < cumulative {
            beam = i;
            break;
        }
    }
    let b = beam * BEAM_WORDS;
    let segments = word(block, b + B_SEGMENTS) as i32;
    let (zero, one) = (Ext::load_f64(0.0), one());
    let mut alpha = sub(one, Ext::load_i32(cumulative.wrapping_sub(index)).div(Ext::load_i32(segments)));
    if less_or_unordered(alpha, zero) {
        alpha = zero;
    } else if !less_or_unordered(alpha, one) {
        alpha = one;
    }
    let a = alpha.stored();
    let rotation = [0, 1, 2].map(|i| word(block, b + B_ROTATION + i) as i32);
    let (pitch, yaw) = (rotation[0], rotation[1]);
    let (sp, cp) = (sin(pitch), sin(pitch.wrapping_add(16384)));
    let (sy, cy) = (sin(yaw), sin(yaw.wrapping_add(16384)));
    let axis = [((cp * cy) as f32).to_bits(), ((cp * sy) as f32).to_bits(), (sp as f32).to_bits()];
    let len = ld(word(block, b + B_LENGTH));
    let [lx, ly, lz] = [0, 1, 2].map(|i| ld(word(block, b + B_LOCATION + i)));
    let z_end = ld(ld(axis[2]).mul(len).store()).add(lz).store();
    let y_end = ld(ld(axis[1]).mul(len).store()).add(ly).store();
    let mut x = sub(len.mul(ld(axis[0])).add(lx), lx).mul(a).add(lx).store();
    let mut y = sub(ld(y_end), ly).mul(a).add(ly).store();
    let mut z = sub(ld(z_end), lz).mul(a).add(lz).store();
    let mut rot = rotation;
    if word(block, L_RANDOMBEAM) != 0 {
        // Rejection-sample (2·appFrand − 1)³ inside the unit sphere; the Z
        // square multiplies the unrounded value by its float32 store.
        let component = || {
            let v = Ext::load_f64(unsafe { js_laser_frand() });
            sub(v.add(v), one)
        };
        let r = loop {
            let rx = component().store();
            let ry = component().store();
            let zx = component();
            let rz = zx.store();
            let length_sq = zx.mul(ld(rz)).add(ld(ry).mul(ld(ry))).add(ld(rx).mul(ld(rx)));
            if !greater(length_sq, one) {
                break [rx, ry, rz];
            }
        };
        let n = unsafe_normal(r);
        let pr = [0, 1, 2].map(|i| word(block, L_PREVRAND + i));
        let pl = [0, 1, 2].map(|i| word(block, L_PREVLOC + i));
        let jitter = |i: usize| ld(n[i]).add(ld(pr[i]));
        let (jx, jy, jz) = (jitter(0), jitter(1), jitter(2));
        x = jx.add(ld(x)).store();
        y = jy.add(ld(y)).store();
        let z_ext = jz.add(ld(z));
        z = z_ext.store();
        // The new prevLoc is 2·pos − prevLoc (Z from the unrounded sum); the
        // segment faces from it back to the old prevLoc.
        let dz = sub(z_ext, ld(pl[2]));
        let dy = sub(ld(y), ld(pl[1])).store();
        let dx = sub(ld(x), ld(pl[0])).store();
        let nz_ext = dz.add(ld(z));
        let ny = ld(dy).add(ld(y)).store();
        let nx = ld(dx).add(ld(x)).store();
        let nz = nz_ext.store();
        match rotation24([sub(ld(pl[0]), ld(nx)).store(), sub(ld(pl[1]), ld(ny)).store(), sub(ld(pl[2]), nz_ext).store()]) {
            Some(r) => rot = r,
            None => return NONFINITE,
        }
        for i in 0..3 {
            set(block, L_PREVLOC + i, [nx, ny, nz][i as usize]);
            set(block, L_PREVRAND + i, n[i as usize]);
        }
    }
    let mut moves = 0;
    let mut push = |kind: u32, words: [u32; 3]| {
        let at = L_MOVES + 1 + 4 * moves;
        set(block, at, kind);
        for i in 0..3 {
            set(block, at + 1 + i, words[i as usize]);
        }
        moves += 1;
    };
    push(MOVE_LOCATION, [x, y, z]);
    push(MOVE_ROTATION, rot.map(|v| v as u32));
    // While savedLoc is still the Outer's Location (FCOMP C3: equal or
    // unordered), take this item with probability nextItem/MaxItems against
    // a float32 appFrand.
    let next = word(block, L_NEXTITEM) as i32;
    let max = word(block, L_MAXITEMS) as i32;
    if (0..3).all(|i| equal_or_unordered(ld(word(block, L_SAVEDLOC + i)), ld(word(block, L_OWNER + i)))) {
        let r = ld((unsafe { js_laser_frand() } as f32).to_bits());
        if greater(Ext::load_i32(next).div(Ext::load_i32(max)), r) {
            for i in 0..3 {
                set(block, L_SAVEDLOC + i, [x, y, z][i as usize]);
                set(block, L_SAVEDROT + i, rot[i as usize] as u32);
            }
        }
    }
    let next = next.wrapping_add(1);
    set(block, L_NEXTITEM, next as u32);
    // The last item leaves the proxy at the saved point.
    if next == max {
        push(MOVE_LOCATION, [0, 1, 2].map(|i| word(block, L_SAVEDLOC + i)));
        push(MOVE_ROTATION, [0, 1, 2].map(|i| word(block, L_SAVEDROT + i)));
    }
    set(block, L_MOVES, moves);
    DONE
}
