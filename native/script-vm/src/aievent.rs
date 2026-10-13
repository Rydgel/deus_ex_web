//! UEventManager (Engine.dll 0x10382550..0x10384a90, docs/ai-event-manager.md): the level's AI event manager. Pawns register
//! reaction callbacks with AISetEventCallback (natives 710/711), actors announce events with AISendEvent / AIStartEvent /
//! AIEndEvent / AIClearEvent (713-716), and ULevel::Tick calls Tick (AIProcess, then CleanupEvents) after the actors. This is a
//! transcription of the original bodies over the original's data structures, which the SDK's UnEventManager.h describes and the
//! retail instructions confirm: a hash table of event types sorted by name, each with a list of senders and of receivers, and a
//! ring of all receivers (the process list) that AIProcess walks once per tick in order.
//!
//! The data lives here (arrays with 1-based indices standing for the original's pointers, 0 for NULL). What the original reads
//! from actors and runs in script stays with the host (the `js_ai_*` imports): an actor's flags, location, collision size and
//! owner, AActor::InStasis, APawn::AICanSee, ULevel::SingleLineCheck, and the two script calls (AIEvent's callback with the event,
//! state and XAIParams, and AIComputeScore's score callback). AICanHear and AICanSmell are Rust (0x103c7680, 0x103c7880).
//! `js_ai_callback` and `js_ai_score` run script, which calls back into the exports below (callbacks register and clear
//! callbacks, send events); like the original, no reference to the manager's tables is held across them.
//!
//! The rdtsc time budget AIProcess checks only while GTimestamp is set (a profiling flag) is not modelled: it is off in play.

use crate::x87::Ext;
use core::ptr::addr_of_mut;

#[link(wasm_import_module = "env")]
extern "C" {
    fn js_ai_name_hash(name: u32) -> u32;
    fn js_ai_name_cmp(a: u32, b: u32) -> i32;
    /// bit 0 bDeleteMe, bit 1 a Pawn, bit 2 an Inventory, bit 3 bDetectable.
    fn js_ai_flags(actor: u32) -> u32;
    /// float32 bits: 0..2 Location, 3 CollisionRadius, 4 CollisionHeight, 5 LastRenderTime, 6 DistanceFromPlayer, 7 HearingThreshold.
    fn js_ai_float(actor: u32, field: u32) -> u32;
    fn js_ai_owner(actor: u32) -> u32;
    /// The actor's XLevel->TimeSeconds (a double).
    fn js_ai_time(actor: u32) -> f64;
    fn js_ai_in_stasis(actor: u32) -> u32;
    fn js_ai_can_see(pawn: u32, other: u32, visibility: u32, c0: u32, c1: u32, c2: u32, c3: u32) -> u32;
    /// ULevel::SingleLineCheck's FCheckResult.Time (float32 bits) from the receiver to the sender's location.
    fn js_ai_line_check(receiver: u32, sender: u32) -> u32;
    /// AIEvent's ProcessEvent: the callback function (0: "AIEvent") with the event name, state and PARAMS[0..5].
    fn js_ai_callback(actor: u32, callback: u32, event: u32, state: u32);
    /// AIComputeScore's score callback (receiver.ProcessEvent): returns the float32 bits of its result.
    fn js_ai_score(receiver: u32, sender: u32, callback: u32, score: u32) -> u32;
    fn js_ai_warn(code: u32, count: u32);
}

const MAX_TYPES: usize = 128;
const MAX_SENDERS: usize = 1024;
const MAX_RECEIVERS: usize = 4096;
const MAX_CANDIDATES: usize = 256;

#[derive(Clone, Copy)]
struct EType {
    name: u32,
    hash: u32,
    senders: u32,
    receivers: u32,
    next: u32,
}

#[derive(Clone, Copy)]
struct Sender {
    ty: u32,
    actor: u32,
    destroyed: u32,
    next: u32,
    hold: u32,
    /// visual, audio, audioRadius, smell, per slot
    slots: [[u32; 4]; 16],
    current: [u32; 4],
}
const SENDER0: Sender = Sender { ty: 0, actor: 0, destroyed: 0, next: 0, hold: 0, slots: [[0; 4]; 16], current: [0; 4] };

#[derive(Clone, Copy)]
struct Receiver {
    ty: u32,
    actor: u32,
    destroyed: u32,
    next: u32,
    callback: u32,
    score_callback: u32,
    invoke: u32,
    state: u32,
    checks: [u32; 4],
    on: u32,
    best_score: u32,
    best_sender: u32,
    next_slot: u32,
    /// bestActor, score, visibility, volume, smell
    params: [u32; 5],
    next_process: u32,
    prev_process: u32,
}
const RECEIVER0: Receiver = Receiver {
    ty: 0, actor: 0, destroyed: 0, next: 0, callback: 0, score_callback: 0, invoke: 0, state: 0, checks: [0; 4], on: 0,
    best_score: 0, best_sender: 0, next_slot: 0, params: [0; 5], next_process: 0, prev_process: 0,
};

struct Mgr {
    level: u32,
    ref_processing: i32,
    delete_count: i32,
    current_slot: u32,
    first_process: u32,
    table: [u32; 256],
    warnings: u32,
}

/// The manager's tables, in a block the host allocates in the object arena (the module's statics are nearly all of the arena's
/// reserved region): `ai_pool_size`, `ai_attach`.
#[repr(C)]
struct Pool {
    m: Mgr,
    types: [EType; MAX_TYPES + 1],
    senders: [Sender; MAX_SENDERS + 1],
    receivers: [Receiver; MAX_RECEIVERS + 1],
    // Next never-used index of each table, and the free lists of deleted ones.
    next: [usize; 3],
    free_n: [usize; 3],
    free_t: [u32; MAX_TYPES],
    free_s: [u32; MAX_SENDERS],
    free_r: [u32; MAX_RECEIVERS],
}
static mut POOL: *mut Pool = core::ptr::null_mut();
// AIProcess's candidate array (the original's static 0x10585090) and AIEvent's parameter block for the host.
static mut CANDIDATES: [u32; MAX_CANDIDATES] = [0; MAX_CANDIDATES];
static mut PARAMS: [u32; 5] = [0; 5];
// A small cache of the host's name hashes.
static mut HASHES: [(u32, u32); 256] = [(u32::MAX, 0); 256];

fn pool() -> &'static mut Pool {
    unsafe { &mut *POOL }
}
fn m() -> &'static mut Mgr {
    &mut pool().m
}
fn ty(i: u32) -> &'static mut EType {
    &mut pool().types[i as usize]
}
fn snd(i: u32) -> &'static mut Sender {
    &mut pool().senders[i as usize]
}
fn rcv(i: u32) -> &'static mut Receiver {
    &mut pool().receivers[i as usize]
}

const F32_ZERO: u32 = 0;
const F32_ONE: u32 = 0x3f80_0000;
const F32_800: u32 = 0x4448_0000;
const NEAR_TIME: f64 = 5.0;
const NEAR_DISTANCE: f64 = 1200.0;
// 160000 as a float32: the squared range (400) a stasis or unseen receiver senses senders within.
const NEAR_SQUARED: u32 = 0x481c_4000;

/// A new object of a table (0 types, 1 senders, 2 receivers), not yet zeroed; 0 when full.
fn alloc(table: usize) -> u32 {
    let p = pool();
    if p.free_n[table] > 0 {
        p.free_n[table] -= 1;
        let at = p.free_n[table];
        return match table {
            0 => p.free_t[at],
            1 => p.free_s[at],
            _ => p.free_r[at],
        };
    }
    let cap = [MAX_TYPES, MAX_SENDERS, MAX_RECEIVERS][table];
    if p.next[table] > cap {
        return 0;
    }
    let index = p.next[table] as u32;
    p.next[table] += 1;
    index
}
fn release(table: usize, index: u32) {
    let p = pool();
    let at = p.free_n[table];
    match table {
        0 => p.free_t[at] = index,
        1 => p.free_s[at] = index,
        _ => p.free_r[at] = index,
    }
    p.free_n[table] += 1;
}

/// A pointer into the original's lists (`XAIEvent **`): the slot a new event is linked at.
#[derive(Clone, Copy, PartialEq)]
enum Link {
    Null,
    Senders(u32),
    Receivers(u32),
    SenderNext(u32),
    ReceiverNext(u32),
}
fn get_link(link: Link) -> u32 {
    match link {
        Link::Null => 0,
        Link::Senders(t) => ty(t).senders,
        Link::Receivers(t) => ty(t).receivers,
        Link::SenderNext(s) => snd(s).next,
        Link::ReceiverNext(r) => rcv(r).next,
    }
}
fn set_link(link: Link, value: u32) {
    match link {
        Link::Null => {}
        Link::Senders(t) => ty(t).senders = value,
        Link::Receivers(t) => ty(t).receivers = value,
        Link::SenderNext(s) => snd(s).next = value,
        Link::ReceiverNext(r) => rcv(r).next = value,
    }
}

fn name_hash(name: u32) -> u32 {
    unsafe {
        let slot = &mut (*addr_of_mut!(HASHES))[(name & 255) as usize];
        if slot.0 == name {
            return slot.1;
        }
        let hash = js_ai_name_hash(name);
        *slot = (name, hash);
        hash
    }
}
/// CompareEventNames (0x103833d0): equal names compare 0, others by appStricmp of their text.
fn compare_names(a: u32, b: u32) -> i32 {
    if a == b {
        0
    } else {
        unsafe { js_ai_name_cmp(a, b) }
    }
}

fn flags(actor: u32) -> u32 {
    unsafe { js_ai_flags(actor) }
}
fn is_deleted(actor: u32) -> bool {
    flags(actor) & 1 != 0
}
fn float(actor: u32, field: u32) -> u32 {
    unsafe { js_ai_float(actor, field) }
}

/// FindEvent (0x103834b0): `kind` 0 sender, 1 receiver. `want_type` / `want_prev` are the caller's ppEventType / pppPrev being
/// non-NULL; either makes a missing event type get created. Returns the event (0 when none), the event type (0 when the type is
/// missing and was not created) and the link a new event is added at.
fn find_event(kind: u32, name: u32, actor: u32, want_type: bool, want_prev: bool) -> (u32, u32, Link) {
    let create = want_type || want_prev;
    let hash = name_hash(name);
    let bucket = hash & 255;
    let mut prev_type = 0;
    let mut t = m().table[bucket as usize];
    while t != 0 {
        let c = compare_names(ty(t).name, name);
        if c < 0 {
            prev_type = t;
            t = ty(t).next;
        } else if c == 0 {
            break;
        } else {
            t = 0;
        }
    }
    if t == 0 {
        if !create {
            return (0, 0, Link::Null);
        }
        let n = alloc(0);
        if n == 0 {
            return (0, 0, Link::Null);
        }
        *ty(n) = EType { name, hash, senders: 0, receivers: 0, next: 0 };
        if prev_type != 0 {
            ty(n).next = ty(prev_type).next;
            ty(prev_type).next = n;
        } else {
            ty(n).next = m().table[bucket as usize];
            m().table[bucket as usize] = n;
        }
        t = n;
    }
    let mut prev_event = 0;
    let mut cur = if kind == 0 { ty(t).senders } else { ty(t).receivers };
    while cur != 0 {
        let (destroyed, owner) = if kind == 0 { (snd(cur).destroyed, snd(cur).actor) } else { (rcv(cur).destroyed, rcv(cur).actor) };
        if destroyed == 0 && owner == actor {
            break;
        }
        prev_event = cur;
        cur = if kind == 0 { snd(cur).next } else { rcv(cur).next };
    }
    let link = if !want_prev {
        Link::Null
    } else if prev_event != 0 {
        if kind == 0 { Link::SenderNext(prev_event) } else { Link::ReceiverNext(prev_event) }
    } else if kind == 0 {
        Link::Senders(t)
    } else {
        Link::Receivers(t)
    };
    (cur, t, link)
}

/// SafeDelete (0x10383780): marks the event; CleanupSlot frees it later.
fn safe_delete(kind: u32, event: u32) {
    let destroyed = if kind == 0 { &mut snd(event).destroyed } else { &mut rcv(event).destroyed };
    if *destroyed == 0 {
        m().delete_count += 1;
    }
    *destroyed = 1;
}

fn first_valid_sender(mut s: u32) -> u32 {
    while s != 0 && snd(s).destroyed != 0 {
        s = snd(s).next;
    }
    s
}
fn first_valid_receiver(mut r: u32) -> u32 {
    while r != 0 && rcv(r).destroyed != 0 {
        r = rcv(r).next;
    }
    r
}
/// XAIReceiverEvent::GetNextProcess / GetPrevProcess.
fn next_process(this: u32) -> u32 {
    let mut e = this;
    while e != 0 {
        e = rcv(e).next_process;
        if rcv(e).destroyed == 0 || e == this {
            break;
        }
    }
    e
}
fn prev_process(this: u32) -> u32 {
    let mut e = this;
    while e != 0 {
        e = rcv(e).prev_process;
        if rcv(e).destroyed == 0 || e == this {
            break;
        }
    }
    e
}

// ---- the natives ---------------------------------------------------------

/// AISetEventCallback (0x10382990).
fn set_callback(receiver: u32, name: u32, callback: u32, score: u32, checks: [u32; 4]) {
    if receiver == 0 || name == 0 {
        return;
    }
    let (mut found, t, link) = find_event(1, name, receiver, true, true);
    if found == 0 && t != 0 && link != Link::Null {
        let r = alloc(2);
        if r == 0 {
            return;
        }
        *rcv(r) = RECEIVER0;
        rcv(r).ty = t;
        rcv(r).actor = receiver;
        rcv(r).next_slot = m().current_slot;
        let first = m().first_process;
        if first != 0 {
            rcv(r).next_process = first;
            rcv(r).prev_process = rcv(first).prev_process;
            let before = rcv(first).prev_process;
            rcv(before).next_process = r;
            rcv(first).prev_process = r;
        } else {
            rcv(r).next_process = r;
            rcv(r).prev_process = r;
            m().first_process = r;
        }
        rcv(r).next = get_link(link);
        set_link(link, r);
        found = r;
    }
    if found != 0 {
        let e = rcv(found);
        e.callback = callback;
        e.score_callback = score;
        e.checks = checks;
    }
}

fn clear_callback(receiver: u32, name: u32) {
    if receiver == 0 || name == 0 {
        return;
    }
    let (found, _, _) = find_event(1, name, receiver, false, false);
    if found != 0 {
        safe_delete(1, found);
    }
}

/// The settings update of SendEvent / StartEvent / EndEvent / ClearEvent (0x10382e60 with 0x10382fa0): the slot keeps its maximum,
/// and in mode 0 the current setting is the value.
fn update(a: &mut u32, b: &mut u32, value: u32, mode: u32) {
    // fld [a]; fcomp value; test ah,1: a < value or unordered
    let (less, _) = Ext::load(*a).compare(Ext::load(value));
    if less {
        *a = value;
    }
    if mode == 0 {
        *b = value;
    }
}
fn set_sender(event: u32, slot: u32, etype: u32, mode: u32, value: u32, radius: u32) {
    let s = snd(event);
    let slot = (slot & 15) as usize;
    match etype {
        1 => {
            let (a, b) = (&mut s.slots[slot][1], &mut s.current[1]);
            update(a, b, value, mode);
            let (a, b) = (&mut s.slots[slot][2], &mut s.current[2]);
            update(a, b, radius, mode);
        }
        0 => {
            let (a, b) = (&mut s.slots[slot][0], &mut s.current[0]);
            update(a, b, value, mode);
        }
        2 => {
            let (a, b) = (&mut s.slots[slot][3], &mut s.current[3]);
            update(a, b, value, mode);
        }
        _ => {}
    }
}

/// AISendEvent (mode 1) and AIStartEvent (mode 0).
fn send_event(mode: u32, sender: u32, name: u32, etype: u32, mut value: u32, mut radius: u32) {
    if sender == 0 || name == 0 {
        return;
    }
    if is_deleted(sender) {
        value = F32_ZERO;
        radius = F32_ZERO;
    }
    let (mut found, t, link) = find_event(0, name, sender, true, true);
    if found == 0 && t != 0 && link != Link::Null {
        let s = alloc(1);
        if s == 0 {
            return;
        }
        *snd(s) = SENDER0;
        snd(s).ty = t;
        snd(s).actor = sender;
        snd(s).next = get_link(link);
        set_link(link, s);
        found = s;
    }
    if found != 0 {
        set_sender(found, m().current_slot, etype, mode, value, radius);
    }
}

fn end_event(sender: u32, name: u32, etype: u32) {
    if sender == 0 || name == 0 {
        return;
    }
    let (found, _, _) = find_event(0, name, sender, false, false);
    if found != 0 {
        set_sender(found, m().current_slot, etype, 0, F32_ZERO, F32_ZERO);
    }
}

fn clear_event(sender: u32, name: u32) {
    if sender == 0 || name == 0 {
        return;
    }
    let (found, _, _) = find_event(0, name, sender, false, false);
    if found != 0 {
        for etype in [1, 0, 2] {
            set_sender(found, m().current_slot, etype, 0, F32_ZERO, F32_ZERO);
        }
    }
}

/// DestroyActor (0x10382760).
fn destroy_actor(actor: u32) {
    for bucket in 0..256 {
        let mut t = m().table[bucket];
        while t != 0 {
            let mut s = first_valid_sender(ty(t).senders);
            while s != 0 {
                if snd(s).actor == actor {
                    safe_delete(0, s);
                }
                s = first_valid_sender(snd(s).next);
            }
            let mut r = first_valid_receiver(ty(t).receivers);
            while r != 0 {
                if rcv(r).best_sender == actor {
                    rcv(r).best_sender = 0;
                }
                if rcv(r).actor == actor {
                    safe_delete(1, r);
                }
                r = first_valid_receiver(rcv(r).next);
            }
            t = ty(t).next;
        }
    }
}

// ---- processing ----------------------------------------------------------

fn sub(a: u32, b: u32) -> Ext {
    Ext::load(a).add(Ext::load(b).neg())
}
/// (dx*dx + dy*dy) + dz*dz of the differences `a - b`, in the order the original loads z, y, x and sums x, y, z.
fn squared_distance(a: u32, b: u32) -> Ext {
    let dz = sub(float(a, 2), float(b, 2));
    let dy = sub(float(a, 1), float(b, 1));
    let dx = sub(float(a, 0), float(b, 0));
    dx.mul(dx).add(dy.mul(dy)).add(dz.mul(dz))
}

/// AIComputeScore (0x10383f50): float32 bits.
fn compute_score(receiver: u32, sender: u32, callback: u32) -> u32 {
    let value = squared_distance(receiver, sender).add(Ext::load(F32_ONE));
    if callback == 0 {
        return value.store();
    }
    unsafe { js_ai_score(receiver, sender, callback, value.store()) }
}

/// APawn::AICanHear (0x103c7680): float32 bits.
fn can_hear(pawn: u32, other: u32, volume: u32, radius: u32) -> u32 {
    let zero = Ext::load(F32_ZERO);
    if other == 0 {
        return F32_ZERO;
    }
    let (less, equal) = Ext::load(volume).compare(zero);
    if less || equal || flags(other) & 8 == 0 {
        return F32_ZERO;
    }
    let (less, equal) = Ext::load(radius).compare(zero);
    let radius = if less || equal { F32_800 } else { radius };
    let dz = sub(float(other, 2), float(pawn, 2)).store();
    let dy = sub(float(other, 1), float(pawn, 1));
    let dx = sub(float(other, 0), float(pawn, 0)).store();
    let dz2 = Ext::load(dz).add(Ext::load(dz)).store();
    let (dxe, dz2e) = (Ext::load(dx), Ext::load(dz2));
    let sum = dxe.mul(dxe).add(dy.mul(dy)).add(dz2e.mul(dz2e));
    let reach = Ext::load(radius).mul(Ext::load(radius));
    let (below, _) = sum.compare(reach);
    if !below {
        return F32_ZERO;
    }
    // appSqrt(double): the operand stored as a double, FSQRT, the result kept extended
    let distance = sum.store_double().sqrt();
    let one = Ext::load_f64(1.0);
    let value = one.add(distance.div(Ext::load(radius)).neg()).mul(Ext::load(volume)).add(Ext::load(float(pawn, 7)).neg());
    let (below_zero, _) = value.compare(zero);
    if below_zero {
        return F32_ZERO;
    }
    let (below_one, _) = value.compare(Ext::load(F32_ONE));
    if below_one { value.store() } else { F32_ONE }
}

/// The union of a sender's settings from `start` through `end` (inclusive, wrapping): the original's GetSettings (0x10383bc0).
fn settings(event: u32, start: u32, end: u32) -> [u32; 4] {
    let mut acc = [F32_ZERO; 4];
    let mut slot = start;
    let mut guard = 0;
    loop {
        let row = snd(event).slots[(slot & 15) as usize];
        for i in 0..4 {
            let (less, _) = Ext::load(acc[i]).compare(Ext::load(row[i]));
            if less {
                acc[i] = row[i];
            }
        }
        if slot == end || guard > 32 {
            return acc;
        }
        slot = (slot + 1) & 15;
        guard += 1;
    }
}

/// ComputeSenseDetection (0x103837b0): (visibility, volume, smell) as float32 bits.
fn compute_sense(r: u32, s: u32) -> (u32, u32, u32) {
    let receiver = rcv(r).actor;
    let mut sender = snd(s).actor;
    let sender_event_actor = sender;
    let pawn = if flags(receiver) & 2 != 0 { receiver } else { 0 };
    let mut scale = F32_ONE;
    if sender != 0 && flags(sender) & 4 != 0 {
        let owner = unsafe { js_ai_owner(sender) };
        if owner != 0 {
            let size = |a: u32| Ext::load(float(a, 4)).mul(Ext::load(float(a, 3)));
            let (own, mine) = (size(owner), size(sender));
            sender = owner;
            let (_, zero) = own.compare(Ext::load(F32_ZERO));
            let ratio = if zero { mine } else { mine.div(own) };
            scale = ratio.store_double().sqrt().store();
        }
    }
    let [visual, audio, audio_radius, smell] = settings(s, rcv(r).next_slot, m().current_slot);
    let scaled = Ext::load(visual).mul(Ext::load(scale));
    let mut visibility = scaled.store();
    let (less, equal) = scaled.compare(Ext::load(F32_ZERO));
    if !(less || equal) {
        let checks = rcv(r).checks;
        if pawn != 0 {
            visibility = unsafe { js_ai_can_see(pawn, sender, visibility, checks[0], checks[1], checks[2], checks[3]) };
        } else {
            let time = unsafe { js_ai_line_check(receiver, sender_event_actor) };
            // FCheckResult.Time against 1.0 (FCOMP, C3): kept when equal or unordered, otherwise 0.0
            let (_, equal) = Ext::load(time).compare(Ext::load_f64(1.0));
            if !equal {
                visibility = F32_ZERO;
            }
        }
    }
    let mut volume = audio;
    let (less, equal) = Ext::load(audio).compare(Ext::load(F32_ZERO));
    if !(less || equal) {
        if pawn != 0 {
            volume = can_hear(pawn, sender, audio, audio_radius);
        } else {
            let sum = squared_distance(sender_event_actor, receiver);
            let reach = Ext::load(audio_radius).mul(Ext::load(audio_radius));
            let (below, _) = sum.compare(reach);
            volume = if below { audio } else { F32_ZERO };
        }
    }
    let mut smelled = smell;
    let (less, equal) = Ext::load(smell).compare(Ext::load(F32_ZERO));
    if !(less || equal) {
        // AICanSmell (0x103c7880) returns 0.0; a non-pawn receiver gets 0
        smelled = F32_ZERO;
    }
    (visibility, volume, smelled)
}

fn positive(bits: u32) -> bool {
    let (less, equal) = Ext::load(bits).compare(Ext::load(F32_ZERO));
    !(less || equal)
}

/// AIProcess (0x10384080).
fn process() {
    if m().level == 0 {
        return;
    }
    m().ref_processing += 1;
    let next_slot = (m().current_slot + 1) & 15;
    let mut r = m().first_process;
    let mut visited = 0u32;
    while r != 0 {
        if rcv(r).destroyed == 0 {
            if is_deleted(rcv(r).actor) {
                safe_delete(1, r);
            }
            if rcv(r).destroyed == 0 {
                process_receiver(r);
            }
        }
        visited += 1;
        r = rcv(r).next_process;
        if r == m().first_process {
            r = 0;
        }
    }
    m().current_slot = next_slot;
    // senders with nothing in any slot are deleted; the new current slot takes the current settings
    for bucket in 0..256 {
        let mut t = m().table[bucket];
        while t != 0 {
            let mut s = first_valid_sender(ty(t).senders);
            while s != 0 {
                if is_deleted(snd(s).actor) {
                    snd(s).current = [0; 4];
                }
                snd(s).slots[next_slot as usize] = snd(s).current;
                let busy = (0..16).any(|i| {
                    let row = snd(s).slots[i];
                    positive(row[0]) || positive(row[1]) || positive(row[3])
                });
                if !busy {
                    safe_delete(0, s);
                }
                s = first_valid_sender(snd(s).next);
            }
            t = ty(t).next;
        }
    }
    // receivers that did not catch up with a whole cycle of slots
    let first = m().first_process;
    let mut start = first;
    if start != 0 && rcv(start).destroyed != 0 {
        start = next_process(start);
        if start == first {
            start = 0;
        }
    }
    let mut lagging = 0;
    let mut c = start;
    while c != 0 {
        if rcv(c).next_slot == next_slot {
            rcv(c).next_slot = (next_slot + 1) & 15;
            lagging += 1;
        }
        c = next_process(c);
        if c == start {
            break;
        }
    }
    if lagging > 0 {
        m().warnings += 1;
        unsafe { js_ai_warn(1, lagging) };
    }
    // the callbacks, after all receivers have been evaluated; no reference is held across them
    let mut e = m().first_process;
    let mut index = 0;
    while e != 0 {
        if rcv(e).destroyed == 0 {
            if rcv(e).invoke != 0 && rcv(e).ty != 0 {
                let actor = rcv(e).actor;
                let event = ty(rcv(e).ty).name;
                let (callback, state) = (rcv(e).callback, rcv(e).state);
                unsafe {
                    *addr_of_mut!(PARAMS) = rcv(e).params;
                    js_ai_callback(actor, callback, event, state);
                }
                rcv(e).invoke = 0;
            }
            rcv(e).next_slot = next_slot;
        }
        e = rcv(e).next_process;
        index += 1;
        if index >= visited || e == m().first_process {
            break;
        }
    }
    m().first_process = e;
    m().ref_processing -= 1;
}

/// The body of AIProcess's receiver loop for one live receiver.
fn process_receiver(r: u32) {
    let actor = rcv(r).actor;
    let t = rcv(r).ty;
    rcv(r).invoke = 0;
    let mut best_hold = F32_ZERO;
    let mut best_actor = 0;
    rcv(r).params = [0; 5];
    let mut near = false;
    let mut first = 0;
    if t != 0 {
        if unsafe { js_ai_in_stasis(actor) } == 0 {
            let age = Ext::load_f64(unsafe { js_ai_time(actor) }).add(Ext::load(float(actor, 5)).neg());
            let (less, equal) = age.compare(Ext::load_f64(NEAR_TIME));
            if less || equal {
                near = true;
            } else {
                let (less, equal) = Ext::load(float(actor, 6)).compare(Ext::load_f64(NEAR_DISTANCE));
                near = less || equal;
            }
        }
        first = first_valid_sender(ty(t).senders);
    }
    let mut distance = F32_ZERO;
    let mut count = 0;
    while first != 0 {
        let sender = snd(first).actor;
        if sender != actor {
            if !near {
                distance = squared_distance(actor, sender).store();
            }
            let (less, equal) = Ext::load(distance).compare(Ext::load(NEAR_SQUARED));
            if less || equal {
                let score = compute_score(actor, sender, rcv(r).score_callback);
                snd(first).hold = score;
                if positive(score) {
                    unsafe { (*addr_of_mut!(CANDIDATES))[count] = first };
                    count += 1;
                }
                if count >= MAX_CANDIDATES {
                    m().warnings += 1;
                    unsafe { js_ai_warn(2, MAX_CANDIDATES as u32) };
                    break;
                }
            }
        }
        first = first_valid_sender(snd(first).next);
    }
    let mut best = 0;
    if count > 0 {
        if count > 1 {
            // appQsort(CANDIDATES, count, 4, 0x10382420): ascending hold score, the slot order breaking ties
            unsafe {
                let all = &mut *addr_of_mut!(CANDIDATES);
                let list = &mut all[..count];
                for i in 1..count {
                    let item = list[i];
                    let key = snd(item).hold;
                    let mut j = i;
                    while j > 0 && order_before(key, snd(list[j - 1]).hold) {
                        list[j] = list[j - 1];
                        j -= 1;
                    }
                    list[j] = item;
                }
            }
        }
        for i in 0..count {
            let candidate = unsafe { (*addr_of_mut!(CANDIDATES))[i] };
            let (visibility, volume, smell) = compute_sense(r, candidate);
            if positive(visibility) || positive(volume) || positive(smell) {
                best = candidate;
                rcv(r).params = [snd(candidate).actor, snd(candidate).hold, visibility, volume, smell];
                best_actor = snd(candidate).actor;
                best_hold = snd(candidate).hold;
                break;
            }
        }
    }
    let was_on = rcv(r).on;
    let on = u32::from(best != 0);
    let mut persistent = on;
    if was_on != 0 {
        if on != 0 {
            if rcv(r).best_sender != best_actor {
                rcv(r).invoke = 1;
                rcv(r).state = 3;
            }
        } else {
            rcv(r).invoke = 1;
            rcv(r).state = 1;
        }
    } else {
        if best != 0 {
            let current = snd(best).current;
            if !(positive(current[1]) || positive(current[0]) || positive(current[3])) {
                persistent = 0;
            }
        }
        if on != 0 {
            rcv(r).invoke = 1;
            rcv(r).state = if persistent != 0 { 0 } else { 2 };
        }
    }
    rcv(r).on = on;
    if rcv(r).invoke != 0 && rcv(r).state == 2 {
        rcv(r).on = 0;
    }
    rcv(r).best_score = best_hold;
    rcv(r).best_sender = best_actor;
}

/// Whether the candidate with hold score `a` sorts strictly before the one with `b` that was in the list first: the comparator
/// 0x10382420 orders by score, ties by slot position, so an equal score never moves before an earlier slot.
fn order_before(a: u32, b: u32) -> bool {
    // comparator(a, b) < 0: a < b by fld/fcomp (C0, which an unordered pair also sets)
    let (less, _) = Ext::load(a).compare(Ext::load(b));
    less
}

/// CleanupSlot (0x10383cb0).
fn cleanup_slot(kind: u32, mut link: Link) {
    loop {
        let event = get_link(link);
        if event == 0 {
            return;
        }
        let (destroyed, next) = if kind == 0 { (snd(event).destroyed, snd(event).next) } else { (rcv(event).destroyed, rcv(event).next) };
        if destroyed != 0 {
            set_link(link, next);
            release(kind as usize + 1, event);
            m().delete_count -= 1;
        } else {
            link = if kind == 0 { Link::SenderNext(event) } else { Link::ReceiverNext(event) };
        }
    }
}

/// CleanupEvents (0x10383d80).
fn cleanup() {
    if m().ref_processing != 0 || m().delete_count <= 0 {
        return;
    }
    let mut c = m().first_process;
    if c != 0 && rcv(c).destroyed != 0 {
        let next = next_process(c);
        c = if next == m().first_process { 0 } else { next };
    }
    m().first_process = c;
    while c != 0 {
        rcv(c).next_process = next_process(c);
        rcv(c).prev_process = prev_process(c);
        let next = next_process(c);
        c = if next == m().first_process { 0 } else { next };
    }
    for bucket in 0..256 {
        let mut t = m().table[bucket];
        while t != 0 {
            cleanup_slot(0, Link::Senders(t));
            cleanup_slot(1, Link::Receivers(t));
            t = ty(t).next;
        }
    }
}

// ---- exports -------------------------------------------------------------

/// The byte size of the manager's tables, for the host to allocate (zeroed) before `ai_attach`.
#[no_mangle]
pub extern "C" fn ai_pool_size() -> u32 {
    core::mem::size_of::<Pool>() as u32
}
#[no_mangle]
pub extern "C" fn ai_attach(at: u32) {
    unsafe { POOL = at as usize as *mut Pool };
}
/// UEventManager(ULevel*): a fresh manager (LevelInfo.InitEventManager).
#[no_mangle]
pub extern "C" fn ai_reset() {
    unsafe {
        if POOL.is_null() {
            return;
        }
        core::ptr::write_bytes(POOL as *mut u8, 0, core::mem::size_of::<Pool>());
        (*POOL).next = [1; 3];
        *addr_of_mut!(HASHES) = [(u32::MAX, 0); 256];
    }
    m().level = 1;
}
/// UEventManager::Destroy.
#[no_mangle]
pub extern "C" fn ai_destroy() {
    if unsafe { !POOL.is_null() } {
        m().level = 0;
    }
}
/// After a script error unwound through AIProcess: nothing is processing any more.
#[no_mangle]
pub extern "C" fn ai_recover() {
    if unsafe { !POOL.is_null() } {
        m().ref_processing = 0;
    }
}
#[no_mangle]
pub extern "C" fn ai_active() -> u32 {
    if unsafe { POOL.is_null() } { 0 } else { m().level }
}
#[no_mangle]
pub extern "C" fn ai_set_callback(receiver: u32, name: u32, callback: u32, score: u32, c0: u32, c1: u32, c2: u32, c3: u32) {
    set_callback(receiver, name, callback, score, [c0, c1, c2, c3]);
}
#[no_mangle]
pub extern "C" fn ai_clear_callback(receiver: u32, name: u32) {
    clear_callback(receiver, name);
}
#[no_mangle]
pub extern "C" fn ai_send(sender: u32, name: u32, etype: u32, value: u32, radius: u32) {
    send_event(1, sender, name, etype, value, radius);
}
#[no_mangle]
pub extern "C" fn ai_start(sender: u32, name: u32, etype: u32, value: u32, radius: u32) {
    send_event(0, sender, name, etype, value, radius);
}
#[no_mangle]
pub extern "C" fn ai_end(sender: u32, name: u32, etype: u32) {
    end_event(sender, name, etype);
}
#[no_mangle]
pub extern "C" fn ai_clear(sender: u32, name: u32) {
    clear_event(sender, name);
}
#[no_mangle]
pub extern "C" fn ai_destroy_actor(actor: u32) {
    if m().level != 0 {
        destroy_actor(actor);
    }
}
#[no_mangle]
pub extern "C" fn ai_process() {
    process();
}
#[no_mangle]
pub extern "C" fn ai_cleanup() {
    cleanup();
}
/// UEventManager::Tick.
#[no_mangle]
pub extern "C" fn ai_tick() {
    process();
    cleanup();
}
#[no_mangle]
pub extern "C" fn ai_params_ptr() -> *const u32 {
    addr_of_mut!(PARAMS) as *const u32
}
#[no_mangle]
pub extern "C" fn ai_warnings() -> u32 {
    if unsafe { POOL.is_null() } { 0 } else { m().warnings }
}

// A structural dump for the validators (scripts/validate-event-manager.mjs): u32 words.
//   header: current_slot, ref_processing, delete_count, first_process actor, first_process event name, type count
//   per type in bucket order: bucket, name, hash, sender count, receiver count
//     per sender: actor, destroyed, hold, 64 slot words, 4 current words
//     per receiver: actor, destroyed, callback, score callback, invoke, state, 4 checks, on, best score, best sender, next slot, 5 params
//   then the ring: count, and per entry actor, event name, destroyed
#[no_mangle]
pub extern "C" fn ai_dump(out: u32, capacity: u32) -> u32 {
    let dump = unsafe { core::slice::from_raw_parts_mut(out as usize as *mut u32, capacity as usize) };
    let mut n = 0usize;
    fn put(dump: &mut [u32], value: u32, n: &mut usize) {
        if *n < dump.len() {
            dump[*n] = value;
            *n += 1;
        }
    }
    let first = m().first_process;
    put(dump, m().current_slot, &mut n);
    put(dump, m().ref_processing as u32, &mut n);
    put(dump, m().delete_count as u32, &mut n);
    put(dump, if first != 0 { rcv(first).actor } else { 0 }, &mut n);
    put(dump, if first != 0 { ty(rcv(first).ty).name } else { 0 }, &mut n);
    let count_at = n;
    put(dump, 0, &mut n);
    let mut types = 0;
    for bucket in 0..256u32 {
        let mut t = m().table[bucket as usize];
        while t != 0 {
            types += 1;
            let (mut senders, mut receivers) = (0, 0);
            let mut s = ty(t).senders;
            while s != 0 {
                senders += 1;
                s = snd(s).next;
            }
            let mut r = ty(t).receivers;
            while r != 0 {
                receivers += 1;
                r = rcv(r).next;
            }
            put(dump, bucket, &mut n);
            put(dump, ty(t).name, &mut n);
            put(dump, ty(t).hash, &mut n);
            put(dump, senders, &mut n);
            put(dump, receivers, &mut n);
            let mut s = ty(t).senders;
            while s != 0 {
                put(dump, snd(s).actor, &mut n);
                put(dump, snd(s).destroyed, &mut n);
                put(dump, snd(s).hold, &mut n);
                for slot in 0..16 {
                    for i in 0..4 {
                        put(dump, snd(s).slots[slot][i], &mut n);
                    }
                }
                for i in 0..4 {
                    put(dump, snd(s).current[i], &mut n);
                }
                s = snd(s).next;
            }
            let mut r = ty(t).receivers;
            while r != 0 {
                let e = *rcv(r);
                for word in [e.actor, e.destroyed, e.callback, e.score_callback, e.invoke, e.state, e.checks[0], e.checks[1], e.checks[2], e.checks[3],
                    e.on, e.best_score, e.best_sender, e.next_slot, e.params[0], e.params[1], e.params[2], e.params[3], e.params[4]] {
                    put(dump, word, &mut n);
                }
                r = e.next;
            }
            t = ty(t).next;
        }
    }
    dump[count_at] = types;
    let ring_at = n;
    put(dump, 0, &mut n);
    let mut ring = 0;
    let mut e = first;
    while e != 0 && ring < 8192 {
        put(dump, rcv(e).actor, &mut n);
        put(dump, ty(rcv(e).ty).name, &mut n);
        put(dump, rcv(e).destroyed, &mut n);
        ring += 1;
        e = rcv(e).next_process;
        if e == first {
            break;
        }
    }
    dump[ring_at] = ring;
    n as u32
}
