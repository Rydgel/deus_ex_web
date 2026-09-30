//! Callback-free noncolliding spawned rider MoveActor. Contract and native
//! reference: docs/rider-move-kernel.md. The host proves each field is an
//! authoritative image cell and excludes Pawn/Brush ancestry. Every guard,
//! including the prospective unchanged-zone query, precedes the first store.
use crate::interp::load32;
use crate::zone::{live, model_live, point_region, store_region_at};

// Each field has [offset, bool mask], in move-actor-kernel.mjs MOVE_FIELDS
// order. The final three words are PointRegion member offsets.
static mut FIELDS: [u32; 33] = [0; 33];
#[no_mangle]
pub extern "C" fn move_rider_fields_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(FIELDS) as *mut u32
}
#[inline(always)]
fn field(i: usize) -> u32 { unsafe { (*core::ptr::addr_of!(FIELDS))[i] } }
#[inline(always)]
fn address(base: u32, index: usize) -> u32 { base + field(index * 2) }
#[inline(always)]
fn flag(base: u32, index: usize) -> bool { load32(address(base, index)) & field(index * 2 + 1) != 0 }
#[inline(always)]
fn float(at: u32) -> f32 { f32::from_bits(load32(at)) }
#[inline(always)]
fn store(at: u32, word: u32) { unsafe { core::ptr::write_unaligned(at as usize as *mut u32, word) } }

/// 0: unchanged hand-back; 1: tiny rotation-only return; 2: complete move.
/// There are no imports and no callbacks while image pointers are live.
#[no_mangle]
pub extern "C" fn move_rider(base: u32, model: u32, dx: f32, dy: f32, dz: f32,
                            pitch: i32, yaw: i32, roll: i32) -> u32 {
    // Static, movable, collision/block flags, StandingCount, Touching.
    if flag(base, 0) || !flag(base, 1) || (2..6).any(|i| flag(base, i)) ||
        unsafe { core::ptr::read(address(base, 7) as usize as *const u8) } != 0 { return 0; }
    if live(load32(address(base, 14))) != 0 { return 0; }
    if (0..4).any(|i| live(load32(address(base, 8) + 4 * i)) != 0) { return 0; }
    let location = address(base, 9);
    let p = [float(location), float(location + 4), float(location + 8)];
    let d = [dx, dy, dz];
    if p.iter().chain(d.iter()).any(|v| !v.is_finite()) ||
        !float(address(base, 11)).is_finite() || !float(address(base, 12)).is_finite() { return 0; }
    // The reference compares float32 components against a double 0.0001.
    let tiny = d.iter().all(|v| (*v as f64).abs() < 0.0001);
    let next = [p[0] + dx, p[1] + dy, p[2] + dz];
    // Overflow is outside this bounded native reference: let the full body
    // handle it, with the original actor still untouched.
    if next.iter().any(|v| !v.is_finite()) { return 0; }
    let region = if tiny || flag(base, 6) { None } else {
        if model == 0 || !model_live(model) { return 0; }
        let r = match point_region(model, [next[0] as f64, next[1] as f64, next[2] as f64]) {
            Some(r) => r, None => return 0,
        };
        if r.zone != live(load32(address(base, 13) + field(30))) { return 0; }
        Some(r)
    };
    if !tiny {
        for i in 0..3 { store(location + 4 * i as u32, next[i].to_bits()); }
    }
    let rotation = address(base, 10);
    store(rotation, pitch as u32); store(rotation + 4, yaw as u32); store(rotation + 8, roll as u32);
    if let Some(r) = region {
        store_region_at(address(base, 13), [field(30), field(31), field(32)], 0xff, r);
    }
    if tiny { 1 } else { 2 }
}
