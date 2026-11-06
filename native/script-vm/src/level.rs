//! The level loop's per-actor host passes (docs/play-cpu-plan.md Phase 4
//! step 6) read from the object image instead of one readNamed/writeNamed
//! chain per actor. Each transcribes a JavaScript loop over Level.Actors
//! that runs no script:
//! * `level_distance`: tickStandaloneLevel's DistanceFromPlayer pass
//!   (level-tick.mjs; ULevel::Tick, docs/script-level-tick.md), with
//!   playerDistance's fast path and its x87 sequence.
//! * `level_settled`: whether compactScriptActors (script-cleanup.mjs,
//!   CompactActors 0x103963e0) would find nothing to do: no null slot and no
//!   bDeleteMe actor from FirstDynamicActor on.
//! * `level_flagged`: the slots compactScriptActors has to look at when
//!   that is not so (a null slot, a bDeleteMe actor, an actor the image
//!   cannot answer); the loop reads bDeleteMe of those only.
//!
//! The list is the render scan's [count, handle...] (script-vm-render.mjs,
//! per actorsEpoch). An actor whose fields the image cannot answer as
//! readNamed would (render.rs Obj) is handed back to JavaScript.

use crate::fog::certain_f32;
use crate::interp::{load32, store32};
use crate::render::{Obj, R_BDELETEME, R_DISTANCEFROMPLAYER, R_LOCATION};
use crate::trace::sqrt;
use crate::x87::Ext;

const DISTANCE_FIELDS: u64 = 1 << R_LOCATION | 1 << R_DISTANCEFROMPLAYER;
const U: f64 = 1.0 / 9_007_199_254_740_992.0; // 2^-53

#[inline(always)]
fn finite(bits: u32) -> bool {
    bits & 0x7f80_0000 != 0x7f80_0000
}

/// level-tick.mjs playerDistance of finite `l` from finite `o` (f32 bits):
/// the fast path's double root when every real within 16 * 2^-53 of it
/// rounds to one f32, else the x87 sequence: 64-bit differences,
/// (y*y + z*z) + x*x, the 53-bit FSTL, FSQRT and the f32 store.
fn distance(l: [u32; 3], o: [u32; 3]) -> u32 {
    let d = [0, 1, 2].map(|i| f32::from_bits(l[i]) as f64 - f32::from_bits(o[i]) as f64);
    if d[0] != 0.0 || d[1] != 0.0 || d[2] != 0.0 {
        let root = sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
        if let Some(bits) = certain_f32(root, root * (16.0 * U)) {
            return bits;
        }
    }
    let [x, y, z] = [0, 1, 2].map(|i| Ext::load(l[i]).add(Ext::load(o[i]).neg()));
    let square = y.mul(y).add(z.mul(z)).add(x.mul(x));
    square.store_double().sqrt().store()
}

/// DistanceFromPlayer of every actor of `list` from `start`, from the
/// player's Location `origin` (finite f32 bits): writes the image actors'
/// cells and the indices it hands back (a field the image cannot answer, a
/// non-finite Location) to `out`, in order; returns their count.
#[no_mangle]
pub extern "C" fn level_distance(list: u32, start: u32, ox: u32, oy: u32, oz: u32, out: u32) -> u32 {
    let count = load32(list);
    let origin = [ox, oy, oz];
    let mut handed = 0u32;
    let mut index = start;
    while index < count {
        let h = load32(list.wrapping_add(4).wrapping_add(index.wrapping_mul(4)));
        let i = index;
        index += 1;
        if h == 0 {
            continue;
        }
        let a = Obj::of(h);
        if a.has(DISTANCE_FIELDS) {
            let location = [a.word(R_LOCATION, 0), a.word(R_LOCATION, 1), a.word(R_LOCATION, 2)];
            if location.iter().all(|&w| finite(w)) {
                a.set_word(R_DISTANCEFROMPLAYER, 0, distance(location, origin));
                continue;
            }
        }
        store32(out.wrapping_add(handed.wrapping_mul(4)), i);
        handed += 1;
    }
    handed
}

/// The slots of `list` from `start` that compactScriptActors cannot pass
/// without a look: a null slot, an actor the image cannot answer, or a
/// bDeleteMe actor. Writes their indices to `out` in order and returns
/// their count; every other slot holds an actor whose bDeleteMe the image
/// reads false, which is what the JavaScript read of it gives.
#[no_mangle]
pub extern "C" fn level_flagged(list: u32, start: u32, out: u32) -> u32 {
    let count = load32(list);
    let mut index = start;
    let mut flagged = 0u32;
    while index < count {
        let h = load32(list.wrapping_add(4).wrapping_add(index.wrapping_mul(4)));
        let alive = h != 0 && {
            let a = Obj::of(h);
            a.has(1 << R_BDELETEME) && !a.flag(R_BDELETEME)
        };
        if !alive {
            store32(out.wrapping_add(flagged.wrapping_mul(4)), index);
            flagged += 1;
        }
        index += 1;
    }
    flagged
}

/// 1 when every slot of `list` from `start` holds an actor the image
/// answers and none is bDeleteMe (compactScriptActors then changes
/// nothing), else 0.
#[no_mangle]
pub extern "C" fn level_settled(list: u32, start: u32) -> u32 {
    let count = load32(list);
    let mut index = start;
    while index < count {
        let h = load32(list.wrapping_add(4).wrapping_add(index.wrapping_mul(4)));
        index += 1;
        if h == 0 {
            return 0;
        }
        let a = Obj::of(h);
        if !a.has(1 << R_BDELETEME) || a.flag(R_BDELETEME) {
            return 0;
        }
    }
    1
}
