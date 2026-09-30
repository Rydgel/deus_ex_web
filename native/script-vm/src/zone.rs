//! SetActorZone's common case in Rust (docs/rust-core.md, step R3-e). The
//! JavaScript references are zone.mjs `pointRegion` (UModel::PointRegion
//! 0x103f5db0) and `setActorZone` (ULevel::SetActorZone 0x1039b940, the
//! Actor/Pawn route), reached through ScriptRuntime.setSpawnActorZone and the
//! map pawn view's `setActorZone`.
//!
//! `zone_update` completes a call only when the JavaScript body would make
//! no event, no PlayerReplicationInfo store and no error: the actor is
//! deleted (the body returns at once), or every region it computes keeps its
//! zone (or `test` is set), so the body's only effects are the region stores.
//! Any other case returns HANDBACK before the first store, and the host runs
//! the JavaScript body, whose point queries are pure. The host has checked
//! that each field the body reads or writes is the image cell `readNamed`
//! and the field references use (zone-kernel.mjs).
//!
//! Zone model (host-built in the runtime arena, `zone-kernel.mjs`):
//! [node count, zone count, fallback zone handle, zone handles address,
//! nodes address]; zone handles are u32 per zone number (0: none); a node is
//! 40 bytes: plane x, y, z, w as f32, then front, back, leaf 0, leaf 1 as
//! i32 and zone 0, zone 1 as u32.
use crate::interp::{class_entry, load32, RELEASED};
use crate::trace::f;

const DONE: u32 = 0;
const HANDBACK: u32 = 1;

// ZONE_IO: the request, written by the host before `zone_update`.
// [0] image base, [1] flags (1 pawn, 2 test), [2] zone model address,
// [3] bDeleteMe offset, [4] its mask, [5] Location, [6] CollisionHeight,
// [7] EyeHeight, [8] Region, [9] FootRegion, [10] HeadRegion,
// [11] PlayerReplicationInfo, [12..15] PointRegion's Zone, iLeaf and
// ZoneNumber offsets inside the struct; [15] the ZoneNumber mask.
// `zone_test_point` returns its region in [16..19].
static mut ZONE_IO: [u32; 20] = [0; 20];

#[no_mangle]
pub extern "C" fn zone_io_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(ZONE_IO) as *mut u32
}
#[inline(always)]
fn io(i: usize) -> u32 {
    unsafe { (*core::ptr::addr_of!(ZONE_IO))[i] }
}
#[inline(always)]
fn f32_at(address: u32) -> f64 {
    f32::from_bits(load32(address)) as f64
}
#[inline(always)]
fn store32(address: u32, value: u32) {
    unsafe { core::ptr::write_unaligned(address as usize as *mut u32, value) }
}
#[inline(always)]
fn store8(address: u32, value: u8) {
    unsafe { core::ptr::write(address as usize as *mut u8, value) }
}

#[derive(Clone, Copy, PartialEq)]
struct Region {
    zone: u32,
    leaf: i32,
    number: u32,
}

/// zone.mjs `pointRegion`: None where the JavaScript throws (an invalid or
/// cyclic BSP).
fn point_region(model: u32, p: [f64; 3]) -> Option<Region> {
    let count = load32(model);
    let zones = load32(model + 4);
    let fallback = load32(model + 8);
    let handles = load32(model + 12);
    let nodes = load32(model + 16);
    if count == 0 {
        return Some(Region { zone: fallback, leaf: -1, number: 0 });
    }
    let mut index: u32 = 0;
    let mut visits: u32 = 0;
    while visits <= count {
        if index >= count {
            return None;
        }
        let node = nodes + 40 * index;
        let d = p[2] * f32_at(node + 8) + p[1] * f32_at(node + 4) + p[0] * f32_at(node) - f32_at(node + 12);
        let side = if d >= 0.0 { 1u32 } else { 0 };
        let next = load32(node + if side == 1 { 16 } else { 20 }) as i32;
        if next == -1 {
            let number = if zones != 0 { load32(node + 32 + 4 * side) } else { 0 };
            // `zoneActors[zoneNumber] || levelInfo`
            let actor = if number < zones { load32(handles + 4 * number) } else { 0 };
            let leaf = load32(node + 24 + 4 * side) as i32;
            return Some(Region { zone: if actor != 0 { actor } else { fallback }, leaf, number });
        }
        if next < 0 {
            return None;
        }
        index = next as u32;
        visits += 1;
    }
    None
}

/// A pointer read as JavaScript sees it: a released handle is None.
#[inline(always)]
fn live(handle: u32) -> u32 {
    if class_entry(handle) == RELEASED {
        0
    } else {
        handle
    }
}

fn zone_of(base: u32, region: u32) -> u32 {
    live(load32(base + region + io(12)))
}

fn store_region(base: u32, region: u32, value: Region) {
    let at = base + region;
    store32(at + io(12), value.zone);
    store32(at + io(13), value.leaf as u32);
    let mask = io(15);
    let byte = at + io(14);
    // The ZoneNumber byte: a whole byte cell, or bits of a shared word.
    if mask == 0xff {
        store8(byte, value.number as u8);
    } else {
        let old = load32(byte);
        store32(byte, (old & !mask) | ((value.number << mask.trailing_zeros()) & mask));
    }
}

/// SetActorZone(test) on the actor at IO[0]: DONE when completed here,
/// HANDBACK when the JavaScript body must run it.
#[no_mangle]
pub extern "C" fn zone_update() -> u32 {
    let base = io(0);
    let pawn = io(1) & 1 != 0;
    let test = io(1) & 2 != 0;
    let model = io(2);
    // `if (pawn.deleted) return;`
    if load32(base + io(3)) & io(4) != 0 {
        return DONE;
    }
    // A zone actor released since the model was built reads as None in
    // JavaScript, which the model's handles no longer describe.
    let zones = load32(model + 4);
    for i in 0..zones {
        let handle = load32(load32(model + 12) + 4 * i);
        if handle != 0 && class_entry(handle) == RELEASED {
            return HANDBACK;
        }
    }
    if class_entry(load32(model + 8)) == RELEASED {
        return HANDBACK;
    }
    let location = base + io(5);
    let p = [f32_at(location), f32_at(location + 4), f32_at(location + 8)];
    let region = match point_region(model, p) {
        Some(r) => r,
        None => return HANDBACK,
    };
    if region.zone != zone_of(base, io(8)) && !test {
        return HANDBACK;
    }
    if !pawn {
        store_region(base, io(8), region);
        return DONE;
    }
    let height = f32_at(base + io(6));
    let foot = match point_region(model, [p[0], p[1], f(p[2] - height)]) {
        Some(r) => r,
        None => return HANDBACK,
    };
    if foot.zone != zone_of(base, io(9)) && !test {
        return HANDBACK;
    }
    let eye = f32_at(base + io(7));
    let head = match point_region(model, [p[0], p[1], f(p[2] + eye)]) {
        Some(r) => r,
        None => return HANDBACK,
    };
    if head.zone != zone_of(base, io(10)) && !test {
        return HANDBACK;
    }
    // `if (world.netMode !== 3 && pawn.playerReplicationInfo) ...PlayerZone = ...`
    if live(load32(base + io(11))) != 0 {
        return HANDBACK;
    }
    store_region(base, io(8), region);
    store_region(base, io(9), foot);
    store_region(base, io(10), head);
    DONE
}

/// pointRegion on the model at IO[2] for float32 bits IO[16..19]: the
/// region in IO[16..19] (zone handle, leaf, zone number, 1), or IO[19] = 0
/// where the JavaScript throws.
#[no_mangle]
pub extern "C" fn zone_test_point() {
    let p = [f32::from_bits(io(16)) as f64, f32::from_bits(io(17)) as f64, f32::from_bits(io(18)) as f64];
    let out = unsafe { &mut *core::ptr::addr_of_mut!(ZONE_IO) };
    match point_region(io(2), p) {
        Some(r) => {
            out[16] = r.zone;
            out[17] = r.leaf as u32;
            out[18] = r.number;
            out[19] = 1;
        }
        None => out[19] = 0,
    }
}
