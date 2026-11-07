//! The list walk of APawn::ShowSelf (Engine.dll 0x103c0410, docs/script-pawn-tick-visibility.md) over the pawns' images. The
//! JavaScript reference is script-pawn-perception.mjs `showPawnSelf`: for every pawn of the level's PawnList other than the player
//! it reads `SightCounter` and, only when that is below zero or not a number, asks whether the pawn is probing SeePlayer and runs the
//! LOS worker; every other pawn costs two reads (SightCounter, then `NextPawn`) and no effect. A level holds fifty pawns and the walk
//! runs for the player every tick, so the reads were most of its 0.2 ms in Firefox (generic field reads through `soundField`).
//!
//! `showself_scan` does the reads: from a pawn it finds the first pawn, past the player, that the body has to see. A pawn that
//! has no plain cell for either field (no image, a poisoned value, a released allocation, or a host binding of that field) is handed back
//! the same way, so the body reads it as it always did. The body itself, and the `NextPawn` read after it, stay in JavaScript.
use crate::interp::{field_addr, live, load32, receiver};

// SS_FIELDS: SightCounter's offset and NextPawn's in a pawn's image, then their field key ids (show-self-kernel.mjs table()).
static mut SS_FIELDS: [u32; 4] = [0; 4];

#[no_mangle]
pub extern "C" fn showself_fields_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(SS_FIELDS) as *mut u32
}

/// The first pawn, from `start` on along NextPawn, other than `skip`, whose SightCounter is below zero or NaN, or whose fields the walk
/// cannot read from its image; 0 at the end of the list. (`skip` itself is not read for a counter, only for its NextPawn.)
#[no_mangle]
pub extern "C" fn showself_scan(start: u32, skip: u32) -> u32 {
    let (sight, next, sight_key, next_key) = unsafe {
        let f = core::ptr::addr_of!(SS_FIELDS);
        ((*f)[0], (*f)[1], (*f)[2], (*f)[3])
    };
    let mut pawn = start;
    while pawn != 0 {
        let (info, bind) = receiver(pawn);
        let Some(next_at) = field_addr(info, bind, next_key, next) else { return pawn };
        if pawn != skip {
            let Some(sight_at) = field_addr(info, bind, sight_key, sight) else { return pawn };
            let counter = f32::from_bits(load32(sight_at));
            if counter < 0.0 || counter != counter {
                return pawn;
            }
        }
        // `listener = services.nextPawn(listener)`: a released handle names no pawn.
        pawn = live(load32(next_at));
    }
    0
}
