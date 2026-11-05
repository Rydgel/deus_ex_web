//! Mesh-light selection in the interpreter (docs/play-cpu-plan.md step 2.3):
//! FLightManager::SetupForActor's light choice (0x10b08c70) for one draw of
//! a mesh actor, transcribed from src/runtime/mesh-lighting.mjs
//! `setupForActor`, which matches the original (validate-mesh-lighting): the
//! per-actor fade cache, the candidate list (cached lights, the leaf's
//! permeating static lights, the leaf's moving lights; at most 120, each light
//! once), Core's unstable Sort by key, the 8 + 8 visibility rule with the
//! (Index ^ FrameCount) & 15 re-trace stagger and the fades, and the 16-entry
//! cache write. AddLight's colours stay in JavaScript (`finishSetup`).
//!
//! A light's fields come from its slot, filled once per frame (no script
//! runs during the render phase, so a later read in the frame returns the
//! same value): from the image through the render word (render.rs) when
//! every field reads there as readNamed would, else by `js_ml_light` from
//! the JavaScript light record. Alive is Level.Actors membership (a bitmap
//! the host rebuilds with the view's membership set) and not bDeleteMe; the
//! re-trace index comes from `js_ml_index` once per handle. The BSP line
//! check is `js_ml_trace`. Host bookkeeping, not an original structure.

use crate::interp::{handle_slot, load32, load8, store32, GONE};
use crate::render::{
    Obj, MESH_LIGHT_FIELDS, R_BDELETEME, R_BMOVABLE, R_BSPECIALLIT, R_BSTATIC, R_LIGHTBRIGHTNESS, R_LIGHTEFFECT,
    R_LIGHTRADIUS, R_LIGHTTYPE, R_LOCATION,
};
use core::ptr::{addr_of, addr_of_mut};

/// The light manager's square-root table (dynamic-lighting.mjs tableSqrt).
static mut SQRT: [u32; 2048] = [0; 2048];
/// ML_STATE: [light slot table, its capacity (handles), cache table, its
/// capacity (handles), frame stamp, membership bytes, their capacity,
/// index table (index + 1, 0 unknown), its capacity, spare light slot]. The
/// tables are indexed by handle slot, each capacity its window (interp.rs
/// header, HANDLES); a handle without a slot takes the spare light slot,
/// which js_ml_light rewrites at each use.
static mut ML_STATE: [u32; 10] = [0; 10];

#[no_mangle]
pub extern "C" fn ml_sqrt_ptr() -> *mut u32 {
    addr_of_mut!(SQRT) as *mut u32
}
#[no_mangle]
pub extern "C" fn ml_state_ptr() -> *mut u32 {
    addr_of_mut!(ML_STATE) as *mut u32
}

#[link(wasm_import_module = "env")]
extern "C" {
    /// Fill `handle`'s light slot for this frame (growing the table): its
    /// alive flag, and with `record` its light record's fields.
    fn js_ml_light(handle: u32, record: u32);
    /// Whether the BSP segment from the actor to the light is clear.
    fn js_ml_trace(ax: f64, ay: f64, az: f64, lx: f64, ly: f64, lz: f64) -> i32;
    /// The address of `handle`'s cache block, allocated (absent) if new.
    fn js_ml_cache(handle: u32) -> u32;
    /// The light record's re-trace index of `handle`, entered in the table.
    fn js_ml_index(handle: u32) -> u32;
}

// A light slot: [frame, LightType, LightEffect, LightBrightness, LightRadius,
// flags, x, y, z, index]: bytes as read & 255, flags SL_*, location float bits.
const SLOT_WORDS: u32 = 10;
const SL_STATIC: u32 = 1;
const SL_MOVABLE: u32 = 2;
const SL_SPECIAL: u32 = 4;
const SL_ALIVE: u32 = 8;
const SL_RECORD: u32 = 16;
/// A permeating light whose export has no live actor (`lightOf` throws).
const MISSING: u32 = u32::MAX;
// A cache block: [present, count, (light handle, fade) x 16].
const CACHE_ENTRIES: u32 = 16;
const MAX_LIST: usize = 120;

#[inline(always)]
fn state() -> [u32; 10] {
    unsafe { *addr_of!(ML_STATE) }
}

/// Fill the slot at `at` of `handle` from the image; false when a field
/// takes the JavaScript path.
fn fill(handle: u32, at: u32, s: &[u32; 10]) -> bool {
    let a = Obj::of(handle);
    if !a.has(MESH_LIGHT_FIELDS) {
        return false;
    }
    let member = match handle_slot(handle, s[6]) {
        slot if slot < GONE => load8(s[5].wrapping_add(slot)) != 0,
        _ => false,
    };
    let alive = member && !a.flag(R_BDELETEME);
    let entry = match handle_slot(handle, s[8]) {
        slot if slot < GONE => load32(s[7].wrapping_add(slot.wrapping_mul(4))),
        _ => 0,
    };
    let index = if entry != 0 { entry.wrapping_sub(1) } else { unsafe { js_ml_index(handle) } };
    let flags = SL_RECORD
        | if alive { SL_ALIVE } else { 0 }
        | if a.flag(R_BSTATIC) { SL_STATIC } else { 0 }
        | if a.flag(R_BMOVABLE) { SL_MOVABLE } else { 0 }
        | if a.flag(R_BSPECIALLIT) { SL_SPECIAL } else { 0 };
    store32(at, s[4]);
    store32(at.wrapping_add(4), a.byte(R_LIGHTTYPE));
    store32(at.wrapping_add(8), a.byte(R_LIGHTEFFECT));
    store32(at.wrapping_add(12), a.byte(R_LIGHTBRIGHTNESS));
    store32(at.wrapping_add(16), a.byte(R_LIGHTRADIUS));
    store32(at.wrapping_add(20), flags);
    for i in 0..3 {
        store32(at.wrapping_add(24 + 4 * i), a.word(R_LOCATION, i));
    }
    store32(at.wrapping_add(36), index);
    true
}

/// `handle`'s slot for this frame; with `record`, its fields too.
fn slot(handle: u32, record: bool) -> u32 {
    let s = state();
    let slot = handle_slot(handle, s[1]);
    if slot < GONE {
        let at = s[0].wrapping_add(slot.wrapping_mul(SLOT_WORDS * 4));
        if load32(at) == s[4] && (!record || load32(at.wrapping_add(20)) & SL_RECORD != 0) {
            return at;
        }
        if fill(handle, at, &s) {
            return at;
        }
    }
    unsafe { js_ml_light(handle, record as u32) };
    // js_ml_light grew the table to give a level's handle its slot; any other handle's light is in the spare slot.
    let s = state();
    match handle_slot(handle, s[1]) {
        slot if slot < GONE => s[0].wrapping_add(slot.wrapping_mul(SLOT_WORDS * 4)),
        _ => s[9],
    }
}
#[inline(always)]
fn word(slot: u32, i: u32) -> u32 {
    load32(slot.wrapping_add(i * 4))
}

fn cache_block(handle: u32) -> u32 {
    let s = state();
    let slot = handle_slot(handle, s[3]);
    if slot < GONE {
        let at = load32(s[2].wrapping_add(slot.wrapping_mul(4)));
        if at != 0 {
            return at;
        }
    }
    unsafe { js_ml_cache(handle) }
}

#[inline(always)]
fn f(v: f64) -> f64 {
    (v as f32) as f64
}
#[inline(always)]
fn float(bits: u32) -> f64 {
    f32::from_bits(bits) as f64
}
fn table_sqrt(value: f64) -> f64 {
    let bits = (value as f32).to_bits();
    let r = unsafe { (*addr_of!(SQRT))[((bits >> 13) & 0x7ff) as usize] }.wrapping_add((bits & 0x7f00_0000) >> 1);
    f32::from_bits(r) as f64
}
/// FISTP under round-to-nearest-even (dynamic-lighting.mjs fistp).
fn fistp(v: f64) -> i32 {
    let t = v as i64 as f64;
    let floor = if t > v { t - 1.0 } else { t };
    let fraction = v - floor;
    let floor = floor as i64;
    (if fraction != 0.5 {
        if fraction > 0.5 {
            floor + 1
        } else {
            floor
        }
    } else if floor % 2 == 0 {
        floor
    } else {
        floor + 1
    }) as i32
}

#[derive(Clone, Copy)]
struct Item {
    light: u32,
    slot: u32,
    key: i32,
    fade: i32,
}

/// Core's Sort<T> (0x10b0b830) with Compare(A, B) = A.key > B.key ? -1 : 1
/// (mesh-lighting.mjs sortLightCandidates).
fn sort(items: &mut [Item]) {
    let n = items.len();
    if n < 2 {
        return;
    }
    let greater = |a: &Item, b: &Item| -> i32 { if a.key > b.key { -1 } else { 1 } };
    let mut stack: [(usize, usize); 64] = [(0, 0); 64];
    let mut top = 0;
    stack[top] = (0, n - 1);
    top += 1;
    while top > 0 {
        top -= 1;
        let (mut min, mut max) = stack[top];
        loop {
            let count = max - min + 1;
            if count <= 8 {
                while max > min {
                    let mut best = min;
                    for item in min + 1..=max {
                        if greater(&items[item], &items[best]) > 0 {
                            best = item;
                        }
                    }
                    items.swap(best, max);
                    max -= 1;
                }
                break;
            }
            items.swap(min + (count >> 1), min);
            let (mut inner_min, mut inner_max) = (min as isize, max as isize + 1);
            loop {
                loop {
                    inner_min += 1;
                    if !(inner_min <= max as isize && greater(&items[inner_min as usize], &items[min]) <= 0) {
                        break;
                    }
                }
                loop {
                    inner_max -= 1;
                    if !(inner_max > min as isize && greater(&items[inner_max as usize], &items[min]) >= 0) {
                        break;
                    }
                }
                if inner_min > inner_max {
                    break;
                }
                items.swap(inner_min as usize, inner_max as usize);
            }
            let inner_max = inner_max as usize;
            let inner_min = inner_min as usize;
            items.swap(min, inner_max);
            if inner_max as isize - 1 - min as isize >= max as isize - inner_min as isize {
                if min + 1 < inner_max {
                    stack[top] = (min, inner_max - 1);
                    top += 1;
                }
                if inner_min < max {
                    min = inner_min;
                    continue;
                }
            } else {
                if inner_min < max {
                    stack[top] = (inner_min, max);
                    top += 1;
                }
                if min + 1 < inner_max {
                    max = inner_max - 1;
                    continue;
                }
            }
            break;
        }
    }
}

/// The selection for one draw of `actor` at float bits (ax, ay, az).
/// `perm`/`leaf` point to `perm_count`/`leaf_count` light handles: the
/// leaf's permeating static lights and its moving lights. Writes to `out`
/// [added count, (handle, fade) per added light, traced count, handles], or
/// [MISSING, run index] when a permeating light reached has no actor.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn ml_select(
    actor: u32,
    ax: u32,
    ay: u32,
    az: u32,
    special_lit: u32,
    step: i32,
    frame_count: u32,
    perm: u32,
    perm_count: u32,
    leaf: u32,
    leaf_count: u32,
    out: u32,
) {
    let (ax, ay, az) = (float(ax), float(ay), float(az));
    let block = cache_block(actor);
    let new_cache = load32(block) == 0;
    let mut list = [Item { light: 0, slot: 0, key: 0, fade: 0 }; MAX_LIST];
    let mut n = 0usize;
    let consider = |light: u32, fade: i32, list: &mut [Item; MAX_LIST], n: &mut usize| {
        if *n >= MAX_LIST || list[..*n].iter().any(|item| item.light == light) {
            return;
        }
        let s = slot(light, true);
        let (lx, ly, lz) = (float(word(s, 6)), float(word(s, 7)), float(word(s, 8)));
        // SetupForActor 0x10b090a7-0x10b09194 at the render pass's 24 bits
        // (mesh-lighting.mjs setupForActor): every operation is one binary32
        // rounding of float operands.
        let (dx, dy, dz) = (f(lx - ax), f(ly - ay), f(lz - az));
        let dist2 = f(f(f(dz * dz) + f(dy * dy)) + f(dx * dx));
        let radius = f(25.0 * ((word(s, 4) & 255) + 1) as f64);
        if ((word(s, 5) & SL_SPECIAL) != 0) != (special_lit != 0) || !(f(radius * radius) > dist2) {
            return;
        }
        let mut brightness = (word(s, 3) & 255) as f64;
        let mut r = radius;
        if word(s, 2) & 255 == 17 {
            brightness = f(brightness * 0.75);
            r = f(r * 0.75);
        }
        let key = fistp(f(f(f(1.0 - f(table_sqrt(dist2) / r)) * brightness) * 1024.0));
        list[*n] = Item { light, slot: s, key, fade };
        *n += 1;
    };
    if !new_cache {
        let count = load32(block.wrapping_add(4));
        // The filter, then the considered entries (current fields).
        let mut kept = [(0u32, 0i32); CACHE_ENTRIES as usize];
        let mut k = 0;
        for i in 0..count.min(CACHE_ENTRIES) {
            let at = block.wrapping_add(8 + 8 * i);
            let light = load32(at);
            if word(slot(light, false), 5) & SL_ALIVE != 0 {
                kept[k] = (light, load32(at.wrapping_add(4)) as i32);
                k += 1;
            }
        }
        for &(light, fade) in &kept[..k] {
            consider(light, fade, &mut list, &mut n);
        }
    }
    for i in 0..perm_count {
        if n >= MAX_LIST {
            break;
        }
        let light = load32(perm.wrapping_add(4 * i));
        if light == MISSING {
            // JavaScript raises lightOf's error for run entry i; nothing
            // was written.
            store32(out, MISSING);
            store32(out.wrapping_add(4), i);
            return;
        }
        consider(light, 0, &mut list, &mut n);
    }
    for i in 0..leaf_count {
        if n >= MAX_LIST {
            break;
        }
        consider(load32(leaf.wrapping_add(4 * i)), 255, &mut list, &mut n);
    }
    let items = &mut list[..n];
    sort(items);
    let (mut count, mut static_count, mut threshold) = (0, 0, -1i32);
    let mut added = 0u32;
    let mut traced = [0u32; MAX_LIST];
    let mut traced_n = 0usize;
    let mut added_list = [(0u32, 0i32); MAX_LIST];
    for i in 0..items.len() {
        let it = items[i];
        let flags = word(it.slot, 5);
        let b_static = flags & SL_STATIC != 0;
        let mut fade = it.fade;
        let mut done = false;
        if it.key >= threshold && (if b_static { static_count } else { count }) < 8 {
            let visible = if !b_static && flags & SL_MOVABLE != 0 {
                true
            } else if !new_cache && ((word(it.slot, 9) ^ frame_count) & 15) != 0 {
                fade & 1 != 0
            } else {
                let v = unsafe {
                    js_ml_trace(ax, ay, az, float(word(it.slot, 6)), float(word(it.slot, 7)), float(word(it.slot, 8)))
                } != 0;
                traced[traced_n] = it.light;
                traced_n += 1;
                if v && new_cache {
                    fade = 255;
                }
                v
            };
            if visible {
                count += 1;
                if b_static {
                    static_count += 1;
                }
                if threshold == -1 {
                    threshold = it.key / 8;
                }
                fade = (fade + step).min(255) | 1;
                added_list[added as usize] = (it.light, fade);
                added += 1;
                done = true;
            }
        }
        if !done {
            fade = (fade - step).max(0) & !1;
            if fade > 0 {
                added_list[added as usize] = (it.light, fade);
                added += 1;
            }
        }
        items[i].fade = fade;
    }
    // The cache: the first 16 of the sorted list still fading in or lit.
    let mut written = 0u32;
    for it in items.iter() {
        if written < CACHE_ENTRIES && it.fade > 1 {
            let at = block.wrapping_add(8 + 8 * written);
            store32(at, it.light);
            store32(at.wrapping_add(4), it.fade as u32);
            written += 1;
        }
    }
    store32(block, 1);
    store32(block.wrapping_add(4), written);
    store32(out, added);
    for i in 0..added {
        let (light, fade) = added_list[i as usize];
        store32(out.wrapping_add(4 + 8 * i), light);
        store32(out.wrapping_add(8 + 8 * i), fade as u32);
    }
    let t = out.wrapping_add(4 + 8 * added);
    store32(t, traced_n as u32);
    for i in 0..traced_n {
        store32(t.wrapping_add(4 + 4 * i as u32), traced[i]);
    }
}
