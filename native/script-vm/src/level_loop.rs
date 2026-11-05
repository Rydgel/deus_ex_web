//! ULevel::Tick's actor loop over a run of Level.Actors (level-tick.mjs
//! `tickStandaloneLevel`, docs/script-level-tick.md) in the interpreter: each
//! actor whose tick descriptor is current is ticked here by tick.rs
//! `tick_actor`, with the arguments actor-tick-kernel.mjs `run` would pass,
//! so the host's per-actor chain (processLevelTick's tickActor, the doors'
//! aroundActorTick, processActorTick, `run`) runs only for the actors
//! JavaScript ticks. The order is the loop's: the list's slots from `start`,
//! null slots skipped.
//!
//! The list is the host's copy of Level.Actors, `[count, handle...]`, with a
//! descriptor per slot, `[receiver epoch, table version, image base, row]`:
//! what `run` takes from `describe` for that actor, valid while the
//! receiver epoch (interp.rs RECEIVERS) and the tick table's version are the
//! ones it was written under; the host writes it (`js_tick_describe`) when it
//! is not. A row is `[mask lo, mask hi, SP mask lo, SP mask hi, flags]`,
//! shared by the actors that have the same one; JS_TICK in its flags marks
//! an actor JavaScript ticks (no image, the PlayerPawn, a ScriptedPawn with
//! SP fields outside its image).
//!
//! A run ends at an actor JavaScript ticks, at a hand-back, after an actor
//! whose tick changed Level.Actors (the host's actorsEpoch, mirrored into
//! LEVEL_IO), when the deferred list is full, or at the list's end. The host
//! then links the deferred actors as `run` does and goes on from `next`.

use crate::interp::{load32, store32};
use crate::tick::{set_sp_mask, tick_actor, DEFER, HANDBACK};
use core::ptr::{addr_of, addr_of_mut};

#[link(wasm_import_module = "env")]
extern "C" {
    /// The host writes slot `index`'s descriptor (handle `handle`); under
    /// LEVEL_LOOP=verify it first checks the current one.
    fn js_tick_describe(index: u32, handle: u32);
}

/// An actor JavaScript ticks.
const JS_TICK: u32 = 1 << 31;
const MAX_DEFERRED: usize = 64;

// LEVEL_IO words (actor-tick-kernel.mjs L_*), after the two doubles.
const W_LIST: usize = 0;
const W_DESC: usize = 1;
const W_START: usize = 2;
const W_ROWS: usize = 3;
const W_VERSION: usize = 4;
const W_TICK_TYPE: usize = 5;
const W_TICK_TAG: usize = 6;
const W_EVENTS: usize = 7;
const W_ACTORS_EPOCH: usize = 8;
const W_VERIFY: usize = 9;
const W_NEXT: usize = 10;
const W_PROGRESS: usize = 11;
const W_CURRENT: usize = 12;
const W_HANDLE: usize = 13;
const W_FLAGS: usize = 14;
const W_TICKED: usize = 15;
const W_DEFERRED: usize = 16;
const WORDS: usize = 17;

// Why a run ended.
const STOP_END: u32 = 0;
const STOP_JS: u32 = 1;
const STOP_LIST: u32 = 2;
const STOP_HANDBACK: u32 = 3;
const STOP_FULL: u32 = 4;

#[repr(C)]
struct LevelIo {
    seconds: f64,
    time_seconds: f64,
    words: [u32; WORDS],
    deferred: [u32; MAX_DEFERRED],
}
static mut LEVEL_IO: LevelIo = LevelIo { seconds: 0.0, time_seconds: 0.0, words: [0; WORDS], deferred: [0; MAX_DEFERRED] };

#[no_mangle]
pub extern "C" fn level_io_ptr() -> *mut u8 {
    addr_of_mut!(LEVEL_IO) as *mut u8
}

#[inline(always)]
fn word(i: usize) -> u32 {
    unsafe { (*addr_of!(LEVEL_IO)).words[i] }
}
#[inline(always)]
fn set_word(i: usize, value: u32) {
    unsafe { (*addr_of_mut!(LEVEL_IO)).words[i] = value }
}
/// The host's receiver epoch (interp.rs RECEIVERS[2]).
#[inline(always)]
fn receiver_epoch() -> u32 {
    unsafe { *crate::interp::vm_receivers_ptr().add(2) }
}

/// Slot `i`'s descriptor (image base, row address) when it is current.
#[inline(always)]
fn current(i: u32) -> Option<(u32, u32)> {
    let at = word(W_DESC).wrapping_add(16 * i);
    if load32(at) != receiver_epoch() || load32(at.wrapping_add(4)) != word(W_VERSION) {
        return None;
    }
    Some((load32(at.wrapping_add(8)), word(W_ROWS).wrapping_add(20 * load32(at.wrapping_add(12)))))
}

/// The run of actors from LEVEL_IO's `start`: why it ended (STOP_*), with
/// `next` (the first slot not ticked here), the progress of the actors
/// ticked, and the slots whose tick deferred.
#[no_mangle]
pub extern "C" fn level_tick_batch() -> u32 {
    let (seconds, time_seconds) = unsafe { ((*addr_of!(LEVEL_IO)).seconds, (*addr_of!(LEVEL_IO)).time_seconds) };
    let (list, tick_type, tick_tag, events, verify) =
        (word(W_LIST), word(W_TICK_TYPE), word(W_TICK_TAG), word(W_EVENTS), word(W_VERIFY) != 0);
    let count = load32(list);
    let actors_epoch = word(W_ACTORS_EPOCH);
    let (mut i, mut progress, mut ticked, mut deferred) = (word(W_START), 0i32, 0u32, 0usize);
    let stop = loop {
        if i >= count {
            break STOP_END;
        }
        let handle = load32(list.wrapping_add(4 + 4 * i));
        if handle == 0 {
            i += 1;
            continue;
        }
        // The slot a throw is reported for (the host's npcFailures), from its description on.
        set_word(W_CURRENT, i);
        let entry = match current(i) {
            Some(entry) if !verify => entry,
            _ => {
                unsafe { js_tick_describe(i, handle) };
                match current(i) {
                    Some(entry) => entry,
                    None => break STOP_JS,
                }
            }
        };
        let (base, row) = entry;
        let flags = load32(row.wrapping_add(16));
        if flags & JS_TICK != 0 {
            break STOP_JS;
        }
        if deferred == MAX_DEFERRED {
            break STOP_FULL;
        }
        set_sp_mask(load32(row.wrapping_add(8)), load32(row.wrapping_add(12)));
        // The actor in flight: the host binds its imports' context to it and unwinds its tick when one throws.
        set_word(W_HANDLE, handle);
        set_word(W_FLAGS, flags);
        let result = tick_actor(0, handle, base, load32(row), load32(row.wrapping_add(4)), flags, seconds, tick_type, time_seconds, tick_tag, events);
        set_word(W_HANDLE, 0);
        if result == HANDBACK {
            // `run` hands it back before any effect: JavaScript ticks it.
            break STOP_HANDBACK;
        }
        ticked += 1;
        if result == DEFER {
            unsafe { (*addr_of_mut!(LEVEL_IO)).deferred[deferred] = i };
            deferred += 1;
        } else {
            progress = progress.wrapping_add(result);
        }
        i += 1;
        if word(W_ACTORS_EPOCH) != actors_epoch {
            break STOP_LIST;
        }
    };
    set_word(W_NEXT, i);
    set_word(W_PROGRESS, progress as u32);
    set_word(W_TICKED, ticked);
    set_word(W_DEFERRED, deferred as u32);
    stop
}

/// The descriptors of a rebuilt list: each slot takes the descriptor its
/// handle had in the old list, searched forward from the previous match
/// (Level.Actors keeps its order through appends, nulled slots and
/// compaction) within a window; any other slot starts empty.
#[no_mangle]
pub extern "C" fn level_desc_carry(old_list: u32, old_desc: u32, new_list: u32, new_desc: u32) {
    const WINDOW: u32 = 64;
    let old_count = if old_list == 0 { 0 } else { load32(old_list) };
    let count = load32(new_list);
    let mut j = 0u32;
    for i in 0..count {
        let at = new_desc.wrapping_add(16 * i);
        for k in 0..4 {
            store32(at.wrapping_add(4 * k), 0);
        }
        let handle = load32(new_list.wrapping_add(4 + 4 * i));
        if handle == 0 {
            continue;
        }
        let end = old_count.min(j.saturating_add(WINDOW));
        let mut k = j;
        while k < end && load32(old_list.wrapping_add(4 + 4 * k)) != handle {
            k += 1;
        }
        if k < end {
            let from = old_desc.wrapping_add(16 * k);
            for w in 0..4 {
                store32(at.wrapping_add(4 * w), load32(from.wrapping_add(4 * w)));
            }
            j = k + 1;
        }
    }
}
