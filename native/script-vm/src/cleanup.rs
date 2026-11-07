//! The pointer scan of ULevel::CleanupDestroyed (docs/firefox-60fps-plan.md "Tick hand-backs"): the inner loop of script-cleanup.mjs
//! `cleanupImageSites`, run over one actor's object image. The original walks every actor of the level once 128 destroyed actors are
//! pending and clears each object pointer that names a pending-kill object; the host did it site by site (a 4-byte read, a handle lookup,
//! a verdict Map lookup), about 60,000 sites in a pass.
//!
//! The scan reads the handle at each site (`base + offsets[i]`, the plan's pointer offsets for the actor's class) and looks it up in a
//! table of verdicts the host keeps for the pass: [handle, verdict] pairs in an open-addressing table (a power-of-two count of 8-byte
//! entries, handle 0 an empty entry), verdict 1 for a target that is not pending kill (also a released handle, which reads None) and
//! 2 for a pending one. The scan stops at the first site that needs the host and says why:
//! * NEED: the handle has no verdict yet; the host decides it (IsValid, IsPendingKill, exactly as `cleanupImageSites` does at the first
//!   site that names the object), enters it (vm_cleanup_insert) and scans again from the same site;
//! * CLEAR: the site names a pending-kill object; the host clears it through the property reference as before and scans again from the next.
//! The sites are visited in the order of the plan, so the host sees the same sequence of first encounters and clears as the JavaScript loop.
//! A site whose `skip` byte (the array at `skip`, 0 for none) is nonzero is a bound field's, which the host reads through its binding: the
//! scan passes it. IO = [status, site, handle, 0].

use crate::interp::{load32, store32};
use core::ptr::addr_of_mut;

const DONE: u32 = 0;
const NEED: u32 = 1;
const CLEAR: u32 = 2;

static mut IO: [u32; 4] = [0; 4];
#[no_mangle]
pub extern "C" fn vm_cleanup_io_ptr() -> *mut u32 {
    addr_of_mut!(IO) as *mut u32
}

#[inline(always)]
fn first_slot(handle: u32, mask: u32) -> u32 {
    (handle.wrapping_mul(0x9E37_79B1) >> 15) & mask
}

/// The verdict entered for `handle`, 0 when there is none.
#[inline(always)]
fn lookup(table: u32, mask: u32, handle: u32) -> u32 {
    let mut slot = first_slot(handle, mask);
    loop {
        let entry = table.wrapping_add(slot.wrapping_mul(8));
        let key = load32(entry);
        if key == handle {
            return load32(entry.wrapping_add(4));
        }
        if key == 0 {
            return 0;
        }
        slot = (slot + 1) & mask;
    }
}

/// Enter `verdict` for `handle` (the table must have an empty entry: the host keeps it under half full).
#[no_mangle]
pub extern "C" fn vm_cleanup_insert(table: u32, mask: u32, handle: u32, verdict: u32) {
    let mut slot = first_slot(handle, mask);
    loop {
        let entry = table.wrapping_add(slot.wrapping_mul(8));
        let key = load32(entry);
        if key == handle || key == 0 {
            store32(entry, handle);
            store32(entry.wrapping_add(4), verdict);
            return;
        }
        slot = (slot + 1) & mask;
    }
}

/// Scan sites `from..count` of the actor whose image is at `base` (see the header; `skip` the bound sites' flags). Returns DONE, NEED or CLEAR; IO has the site and handle.
#[no_mangle]
pub extern "C" fn vm_cleanup_scan(base: u32, offsets: u32, count: u32, from: u32, table: u32, mask: u32, skip: u32) -> u32 {
    let mut i = from;
    while i < count {
        if skip != 0 && crate::interp::load8(skip.wrapping_add(i)) != 0 {
            i += 1;
            continue;
        }
        let handle = load32(base.wrapping_add(load32(offsets.wrapping_add(i.wrapping_mul(4)))));
        if handle != 0 {
            let verdict = lookup(table, mask, handle);
            if verdict != 1 {
                unsafe { *addr_of_mut!(IO) = [if verdict == 2 { CLEAR } else { NEED }, i, handle, 0] };
                return if verdict == 2 { CLEAR } else { NEED };
            }
        }
        i += 1;
    }
    DONE
}
