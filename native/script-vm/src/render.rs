//! The render scan (docs/play-cpu-plan.md Phase 2): one filter over
//! Level.Actors in array order for the viewer's per-frame consumers, read
//! from the object image instead of one readNamed chain per field. Host
//! work, not an original structure: each kind transcribes the JavaScript
//! test its consumer made per actor.
//! * LIGHT: game.movingLights()'s gate (SetupDynamics 0x10b230e8..0x10b2311c):
//!   LightType nonzero, not bDeleteMe, not (bStatic or bNoDelete) without
//!   bDynamicLight, LightBrightness and LightRadius nonzero.
//! * SPRITE / ITERATOR: sprite-scene.mjs `update`'s admission: not the
//!   viewer, not bHidden, not the first-person viewer's ViewTarget, the
//!   bOnlyOwnerSee owner walk (an owner chain reaching the viewer, first
//!   person only) and bOwnerNoSee; then RenderIteratorClass set (ITERATOR) or
//!   DrawType 1 or 7 (SPRITE). An ITERATOR entry ends the scan: JavaScript
//!   runs the iterator, which may run script, and scans on from the next
//!   index with the viewer's fields read again.
//! * MESH: a live Mesh pointer, npc-mesh-preview.mjs admission's first test.
//! * AMBIENT: a live AmbientSound pointer, the first test of Galaxy Update's
//!   ambient scan (galaxy-audio.mjs `update`).
//!
//! `mesh_reads` is the actor mesh scene's per-actor read pass
//! (npc-mesh-preview.mjs `update`): drawnInWorld, the cull sphere's fields,
//! Mesh, Style, ScaleGlow and the numeric half of `pose()`.
//! * JS: a field one of the requested kinds reads cannot be read in the
//!   image as readNamed would (a HOST receiver, a bound key, a class whose
//!   spelling resolves elsewhere), or an owner walk longer than OWNER_WALK:
//!   the consumer evaluates that actor in JavaScript, as before.
//!
//! The list is [count, handle...] (script-vm-render.mjs, per actorsEpoch);
//! an entry is `index << 6 | kind bits`.

use crate::interp::{
    bound_key, chain_has, class_entry, js_class_row, live, load32, load8, receiver, store32, BOUND, HOST, RELEASED,
};
use core::ptr::{addr_of, addr_of_mut};

// Field indices (script-vm-render.mjs RENDER_FIELDS).
const R_BHIDDEN: usize = 0;
pub(crate) const R_BDELETEME: usize = 1;
const R_MESH: usize = 2;
const R_DRAWTYPE: usize = 3;
const R_OWNER: usize = 4;
const R_BONLYOWNERSEE: usize = 5;
const R_BOWNERNOSEE: usize = 6;
const R_RENDERITERATOR: usize = 7;
pub(crate) const R_LIGHTTYPE: usize = 8;
pub(crate) const R_BSTATIC: usize = 9;
const R_BNODELETE: usize = 10;
const R_BDYNAMICLIGHT: usize = 11;
pub(crate) const R_LIGHTBRIGHTNESS: usize = 12;
pub(crate) const R_LIGHTRADIUS: usize = 13;
// The mesh-light selection's light fields (meshlight.rs).
pub(crate) const R_LIGHTEFFECT: usize = 14;
pub(crate) const R_BMOVABLE: usize = 15;
pub(crate) const R_BSPECIALLIT: usize = 16;
pub(crate) const R_LOCATION: usize = 17;
const R_AMBIENTSOUND: usize = 18;
// The level loop's fields (level.rs).
pub(crate) const R_DISTANCEFROMPLAYER: usize = 19;
// The mesh scene's per-actor reads (`mesh_reads`).
const R_PREPIVOT: usize = 20;
pub(crate) const R_DRAWSCALE: usize = 21;
const R_STYLE: usize = 22;
pub(crate) const R_SCALEGLOW: usize = 23;
const R_BANIMBYOWNER: usize = 24;
const R_BPARTICLES: usize = 25;
pub(crate) const R_ROTATION: usize = 26;
const R_ANIMFRAME: usize = 27;
const R_BLENDANIMFRAME: usize = 28;
// SetupForActor's reads; Region's members are entries of their own.
const R_REGION_ZONE: usize = 29;
const R_REGION_ILEAF: usize = 30;
const R_REGION_ZONENUMBER: usize = 31;
const R_AMBIENTGLOW: usize = 32;
const R_BNOSMOOTH: usize = 33;
const R_BMESHENVIROMAP: usize = 34;
const R_BMESHCURVY: usize = 35;
const R_BUNLIT: usize = 36;
// The noncolliding FarMoveActor (`far_move`).
pub(crate) const R_BCOLLIDEACTORS: usize = 37;
pub(crate) const R_BBLOCKACTORS: usize = 38;
pub(crate) const R_BBLOCKPLAYERS: usize = 39;
const R_BCOLLIDEWORLD: usize = 40;
const R_BCOLLIDEWHENPLACING: usize = 41;
const R_STANDINGCOUNT: usize = 42;
const R_BRUSH: usize = 43;
const R_OLDLOCATION: usize = 44;
const R_BJUSTTELEPORTED: usize = 45;
// FDynamicSprite::Setup's sequence name (`mesh_reads`).
const R_ANIMSEQUENCE: usize = 46;
// ULevel::DestroyActor's SetOwner/EndTouch scan (`destroy_scan`): the four
// Touching pointers.
const R_TOUCHING: usize = 47;
// The collision hash's candidate and filter reads (hash.rs).
pub(crate) const R_COLLISIONRADIUS: usize = 48;
pub(crate) const R_COLLISIONHEIGHT: usize = 49;
pub(crate) const R_BPROJTARGET: usize = 50;
const FIELD_COUNT: usize = 51;
/// The fields meshlight.rs reads on a light.
pub(crate) const MESH_LIGHT_FIELDS: u64 = 1 << R_LIGHTTYPE
    | 1 << R_LIGHTEFFECT
    | 1 << R_LIGHTBRIGHTNESS
    | 1 << R_LIGHTRADIUS
    | 1 << R_BSTATIC
    | 1 << R_BMOVABLE
    | 1 << R_BSPECIALLIT
    | 1 << R_BDELETEME
    | 1 << R_LOCATION;

// Entry kinds.
const K_LIGHT: u32 = 1;
const K_SPRITE: u32 = 2;
const K_ITERATOR: u32 = 4;
const K_MESH: u32 = 8;
const K_AMBIENT: u32 = 16;
const K_JS: u32 = 32;
/// Input only: with ITERATOR requested, an ITERATOR entry does not end the
/// scan (the frame's shared pass, script-vm-render.mjs `share`).
const K_THROUGH: u32 = 64;

const LIGHT_FIELDS: u64 = 1 << R_LIGHTTYPE
    | 1 << R_BDELETEME
    | 1 << R_BSTATIC
    | 1 << R_BNODELETE
    | 1 << R_BDYNAMICLIGHT
    | 1 << R_LIGHTBRIGHTNESS
    | 1 << R_LIGHTRADIUS;
const SPRITE_FIELDS: u64 = 1 << R_BHIDDEN
    | 1 << R_BONLYOWNERSEE
    | 1 << R_BOWNERNOSEE
    | 1 << R_OWNER
    | 1 << R_RENDERITERATOR
    | 1 << R_DRAWTYPE;
const MESH_FIELDS: u64 = 1 << R_MESH;
const AMBIENT_FIELDS: u64 = 1 << R_AMBIENTSOUND;
/// Owners followed before an actor is handed to JavaScript.
const OWNER_WALK: u32 = 64;

/// How `Obj::has` (here and in loco.rs) asks a BOUND receiver's binding set: 0 walks the set bits of the question, 1 every position of the
/// field table (the reference), 2 both, trapping on a difference. The host sets it once, when it attaches the interpreter.
pub(crate) static mut HAS_MODE: u32 = 0;

#[no_mangle]
pub extern "C" fn vm_has_mode(mode: u32) {
    unsafe { HAS_MODE = mode };
}

/// R_FIELDS: per field [offset, bool mask, key id], written by the host.
static mut R_FIELDS: [[u32; 3]; FIELD_COUNT] = [[0; 3]; FIELD_COUNT];

#[no_mangle]
pub extern "C" fn render_fields_ptr() -> *mut u32 {
    addr_of_mut!(R_FIELDS) as *mut u32
}

#[link(wasm_import_module = "env")]
extern "C" {
    /// Fill the render word of `handle`'s class row (no script runs).
    fn js_render_class(handle: u32);
}

/// The class row's render words: the first holds fields 0..30 in bits
/// 0..30 and COMPUTED, the second fields 31..62 in bits 0..31.
const COMPUTED: u32 = 1 << 31;

#[inline(always)]
fn rfield(field: usize) -> [u32; 3] {
    unsafe { (*addr_of!(R_FIELDS))[field] }
}

/// An actor the scan reads: its receiver info, binding set and the row's
/// render word (0 for a HOST or undescribed object).
#[derive(Clone, Copy)]
pub(crate) struct Obj {
    info: u32,
    bind: u32,
    fields: u64,
}

impl Obj {
    const NONE: Obj = Obj { info: 0, bind: 0, fields: 0 };
    pub(crate) fn of(handle: u32) -> Obj {
        let (info, bind) = receiver(handle);
        let mut row = class_entry(handle);
        if row <= RELEASED {
            row = unsafe { js_class_row(handle) };
        }
        if row == 0 || info & HOST != 0 {
            return Obj { info, bind, fields: 0 };
        }
        // After the row's names, its two perception words and its
        // locomotion word.
        let at = row.wrapping_add(8).wrapping_add(load32(row.wrapping_add(4)).wrapping_mul(8)).wrapping_add(12);
        if load32(at) & COMPUTED == 0 {
            unsafe { js_render_class(handle) };
        }
        let fields = (load32(at) & !COMPUTED) as u64 | (load32(at.wrapping_add(4)) as u64) << 31;
        Obj { info, bind, fields }
    }
    /// Whether every field of `set` is read in the image. A BOUND receiver (every actor: its header fields are bound) asks the binding
    /// set about each field of `set` alone: the set bits are walked, not all FIELD_COUNT positions (51 iterations for the two to
    /// seven bits a scan asks about, in every slot of every scan). `vm_has_mode`: 0 walks the bits, 1 is the position-by-position
    /// reference, 2 runs both and traps on a difference.
    pub(crate) fn has(&self, set: u64) -> bool {
        if self.fields & set != set {
            return false;
        }
        if self.info & BOUND == 0 {
            return true;
        }
        match unsafe { HAS_MODE } {
            0 => self.bits_free(set),
            1 => self.positions_free(set),
            _ => {
                let walked = self.bits_free(set);
                assert!(walked == self.positions_free(set));
                walked
            }
        }
    }
    #[inline(always)]
    fn bits_free(&self, set: u64) -> bool {
        let mut rest = set & ((1u64 << FIELD_COUNT) - 1);
        while rest != 0 {
            let i = rest.trailing_zeros() as usize;
            rest &= rest - 1;
            if bound_key(self.bind, rfield(i)[2]) {
                return false;
            }
        }
        true
    }
    /// The reference: every position of the field table in turn.
    fn positions_free(&self, set: u64) -> bool {
        for i in 0..FIELD_COUNT {
            if set & (1 << i) != 0 && bound_key(self.bind, rfield(i)[2]) {
                return false;
            }
        }
        true
    }
    #[inline(always)]
    fn at(&self, field: usize) -> u32 {
        (self.info & !15).wrapping_add(rfield(field)[0])
    }
    pub(crate) fn byte(&self, field: usize) -> u32 {
        load8(self.at(field)) as u32
    }
    /// A float cell's bits at `field`, element `i`.
    pub(crate) fn word(&self, field: usize, i: u32) -> u32 {
        load32(self.at(field).wrapping_add(4 * i))
    }
    /// Store float bits at `field`, element `i`.
    pub(crate) fn set_word(&self, field: usize, i: u32, bits: u32) {
        store32(self.at(field).wrapping_add(4 * i), bits)
    }
    fn set_flag(&self, field: usize) {
        let at = self.at(field);
        store32(at, load32(at) | rfield(field)[1])
    }
    fn set_byte(&self, field: usize, value: u8) {
        crate::interp::store8(self.at(field), value)
    }
    pub(crate) fn flag(&self, field: usize) -> bool {
        load32(self.at(field)) & rfield(field)[1] != 0
    }
    /// A pointer as readNamed yields it: a released handle is None.
    fn pointer(&self, field: usize) -> u32 {
        live(load32(self.at(field)))
    }
    /// Read a byte of each field of `set` this object's image holds, for
    /// its cache line only (a volatile read is never removed).
    #[inline(always)]
    fn touch(&self, set: u64) {
        let set = set & self.fields;
        for field in [R_BHIDDEN, R_DRAWTYPE, R_RENDERITERATOR, R_LIGHTTYPE, R_MESH, R_AMBIENTSOUND] {
            if set & 1 << field != 0 {
                unsafe { core::ptr::read_volatile(self.at(field) as usize as *const u8) };
            }
        }
    }
}

/// SetupDynamics' moving-light gate on `a`.
fn light(a: &Obj) -> bool {
    if a.byte(R_LIGHTTYPE) == 0 || a.flag(R_BDELETEME) {
        return false;
    }
    if (a.flag(R_BSTATIC) || a.flag(R_BNODELETE)) && !a.flag(R_BDYNAMICLIGHT) {
        return false;
    }
    a.byte(R_LIGHTBRIGHTNESS) != 0 && a.byte(R_LIGHTRADIUS) != 0
}

/// The sprite admission on `a` (handle `h`): None when an owner on the walk
/// cannot be read in the image or the walk is too long, else the kind
/// (0 when not drawn).
fn sprite(a: &Obj, h: u32, viewer: u32, view_target: u32, first_person: bool) -> Option<u32> {
    if a.flag(R_BHIDDEN) {
        return Some(0);
    }
    if first_person && view_target == h {
        return Some(0);
    }
    if a.flag(R_BONLYOWNERSEE) {
        let mut owned = false;
        let mut owner = h;
        let mut steps = 0;
        while owner != 0 {
            if owner == viewer {
                owned = true;
                break;
            }
            steps += 1;
            if steps > OWNER_WALK {
                return None;
            }
            let o = if owner == h { None } else { Some(Obj::of(owner)) };
            let next = match &o {
                None => a.pointer(R_OWNER),
                Some(o) => {
                    if !o.has(1 << R_OWNER) {
                        return None;
                    }
                    o.pointer(R_OWNER)
                }
            };
            owner = next;
        }
        if !owned || !first_person {
            return Some(0);
        }
    }
    if a.flag(R_BOWNERNOSEE) && first_person && a.pointer(R_OWNER) == viewer {
        return Some(0);
    }
    if a.pointer(R_RENDERITERATOR) != 0 {
        return Some(K_ITERATOR);
    }
    let draw_type = a.byte(R_DRAWTYPE);
    Some(if draw_type == 1 || draw_type == 7 { K_SPRITE } else { 0 })
}

/// Actors per batch of `render_scan`. A walk over Level.Actors runs cold:
/// each consumer's comes after other work in the frame, so an actor's words
/// come from memory, and evaluated one actor after another their misses
/// came one after another too. A batch's objects, and a byte of the first
/// field each requested kind tests, are read first, in loops of independent
/// loads whose misses overlap; the evaluation then reads what is cached.
/// The objects read ahead of an ITERATOR entry that ends the scan only fill
/// the host's tables (js_class_row, js_render_class, js_receiver: no script
/// runs), as the walk itself would.
const BATCH: usize = 16;

/// Scan `list` ([count, handle...]) from `start` for `kinds`, writing
/// entries to `out`; returns the number written. With ITERATOR requested,
/// the scan ends after the first ITERATOR entry, unless THROUGH is.
#[no_mangle]
pub extern "C" fn render_scan(list: u32, start: u32, kinds: u32, viewer: u32, view_target: u32, first_person: u32, out: u32) -> u32 {
    let count = load32(list);
    let mut need = 0;
    if kinds & K_LIGHT != 0 {
        need |= LIGHT_FIELDS;
    }
    if kinds & (K_SPRITE | K_ITERATOR) != 0 {
        need |= SPRITE_FIELDS;
    }
    if kinds & K_MESH != 0 {
        need |= MESH_FIELDS;
    }
    if kinds & K_AMBIENT != 0 {
        need |= AMBIENT_FIELDS;
    }
    let sprites = kinds & (K_SPRITE | K_ITERATOR) != 0;
    // The field each kind tests first (the sprite admission's usual path).
    let mut first = 0u64;
    if kinds & K_LIGHT != 0 {
        first |= 1 << R_LIGHTTYPE;
    }
    if sprites {
        first |= 1 << R_BHIDDEN | 1 << R_RENDERITERATOR | 1 << R_DRAWTYPE;
    }
    if kinds & K_MESH != 0 {
        first |= 1 << R_MESH;
    }
    if kinds & K_AMBIENT != 0 {
        first |= 1 << R_AMBIENTSOUND;
    }
    let mut written = 0u32;
    let mut emit = |index: u32, bits: u32| {
        crate::interp::store32(out.wrapping_add(written.wrapping_mul(4)), index << 6 | bits);
        written += 1;
    };
    let mut handles = [0u32; BATCH];
    let mut objs = [Obj::NONE; BATCH];
    let mut index = start;
    while index < count {
        let n = (count - index).min(BATCH as u32) as usize;
        for k in 0..n {
            let h = live(load32(list.wrapping_add(4).wrapping_add((index + k as u32).wrapping_mul(4))));
            handles[k] = h;
            objs[k] = if h == 0 { Obj::NONE } else { Obj::of(h) };
        }
        for a in &objs[..n] {
            a.touch(first);
        }
        for k in 0..n {
            let (h, i) = (handles[k], index + k as u32);
            if h == 0 {
                continue;
            }
            let a = &objs[k];
            if !a.has(need) {
                emit(i, K_JS);
                continue;
            }
            let mut bits = 0;
            if kinds & K_LIGHT != 0 && light(a) {
                bits |= K_LIGHT;
            }
            if kinds & K_MESH != 0 && a.pointer(R_MESH) != 0 {
                bits |= K_MESH;
            }
            if kinds & K_AMBIENT != 0 && a.pointer(R_AMBIENTSOUND) != 0 {
                bits |= K_AMBIENT;
            }
            if sprites && h != viewer {
                match sprite(a, h, viewer, view_target, first_person != 0) {
                    None => {
                        emit(i, K_JS);
                        continue;
                    }
                    Some(kind) => bits |= kind & kinds,
                }
            }
            if bits != 0 {
                emit(i, bits);
                if bits & K_ITERATOR != 0 && kinds & K_THROUGH == 0 {
                    return written;
                }
            }
        }
        index += n as u32;
    }
    written
}

/// CycleActors' scan step (script-iterators.mjs createCycleActorsIterator,
/// Engine.dll execCycleActors 0x1036e9d0) over `list` ([count, handle...]):
/// from `cursor` with `steps` taken of `bound`, wrapping the cursor to 0 at
/// the count, skip null slots and stop at the first actor whose class row
/// lists record id `rid` (the cls chain classIsA walks). Writes [kind,
/// cursor, steps] to `out`: kind 0 exhausted, 1 found (the actor is at
/// cursor - 1), 2 the actor at cursor - 1 has no class row (JavaScript tests
/// it).
#[no_mangle]
pub extern "C" fn cycle_scan(list: u32, cursor: u32, steps: u32, bound: u32, rid: u32, out: u32) {
    let (kind, cursor, steps) = cycle_scan_step(list, cursor, steps, bound, rid);
    store32(out, kind);
    store32(out.wrapping_add(4), cursor);
    store32(out.wrapping_add(8), steps);
}

/// `cycle_scan`'s answer as (kind, cursor, steps) (iter.rs reads it without the out words).
pub(crate) fn cycle_scan_step(list: u32, cursor: u32, steps: u32, bound: u32, rid: u32) -> (u32, u32, u32) {
    let count = load32(list);
    let (mut cursor, mut steps) = (cursor, steps);
    let mut kind = 0;
    while steps < bound {
        if cursor >= count {
            cursor = 0;
        }
        let h = load32(list.wrapping_add(4).wrapping_add(cursor.wrapping_mul(4)));
        cursor += 1;
        steps += 1;
        if h == 0 {
            continue;
        }
        let mut row = class_entry(h);
        if row <= RELEASED {
            row = unsafe { js_class_row(h) };
        }
        if row == 0 {
            kind = 2;
            break;
        }
        if chain_has(row, rid) {
            kind = 1;
            break;
        }
    }
    (kind, cursor, steps)
}

/// RadiusActors' (mode 1, Engine.dll execRadiusActors 0x103e4fa0) and VisibleActors' (mode 2, execVisibleActors 0x103e5260) scan
/// (script-iterators.mjs `scanArea`) over `list` ([count, handle...]) from `start`: the first slot that is not null and passes the
/// exec's tests as far as the image answers them (all are reads, so their order is not observable). Mode 1: the class row lists
/// record id `rid` and (Radius + CollisionRadius)^2 > sum((Location - Loc)^2); mode 2: bHidden is clear, the class row lists `rid`
/// and, for a Radius that is ordered nonzero, Radius^2 > sum((Location - Loc)^2) (the line check after them is the caller's).
/// `params` holds [Radius, Loc.x, Loc.y, Loc.z] as float32. Writes [kind, cursor] to `out`: kind 0 exhausted, 1 passed (the actor
/// is at cursor - 1), 2 the image does not answer for the actor at cursor - 1 (no class row, a host or bound object, or a class
/// without a field the tests read): JavaScript runs all of its tests.
#[no_mangle]
pub extern "C" fn area_scan(list: u32, start: u32, rid: u32, mode: u32, params: u32, out: u32) {
    let count = load32(list);
    let num = |bits: u32| f32::from_bits(bits) as f64;
    let radius = num(load32(params));
    let loc = [num(load32(params.wrapping_add(4))), num(load32(params.wrapping_add(8))), num(load32(params.wrapping_add(12)))];
    let gate = radius < 0.0 || radius > 0.0;
    let need = if mode == 1 {
        1u64 << R_LOCATION | 1u64 << R_COLLISIONRADIUS
    } else {
        1u64 << R_BHIDDEN | if gate { 1u64 << R_LOCATION } else { 0 }
    };
    let mut cursor = start;
    let mut kind = 0;
    while cursor < count {
        let h = load32(list.wrapping_add(4).wrapping_add(cursor.wrapping_mul(4)));
        cursor += 1;
        if h == 0 {
            continue;
        }
        let a = Obj::of(h);
        let row = class_entry(h);
        if row <= RELEASED || !a.has(need) {
            kind = 2;
            break;
        }
        if mode == 2 && a.flag(R_BHIDDEN) {
            continue;
        }
        if !chain_has(row, rid) {
            continue;
        }
        if mode == 1 || gate {
            let d = [num(a.word(R_LOCATION, 0)) - loc[0], num(a.word(R_LOCATION, 1)) - loc[1], num(a.word(R_LOCATION, 2)) - loc[2]];
            let reach = if mode == 1 { radius + num(a.word(R_COLLISIONRADIUS, 0)) } else { radius };
            if !(reach * reach > d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) {
                continue;
            }
        }
        kind = 1;
        break;
    }
    store32(out, kind);
    store32(out.wrapping_add(4), cursor);
}

/// ULevel::DestroyActor's scan for the actors it hands SetOwner(None) and
/// EndTouch (script-destroy.mjs, Engine.dll DestroyActor) over `list`
/// ([count, handle...]): from `from`, the index of the first slot whose actor
/// has `receiver` as its Owner or in one of its four Touching slots, or whose
/// Owner or Touching the image does not answer (a bound or host receiver, a
/// class without those cells: JavaScript reads it); the count when no such
/// slot is left. Null slots are passed over. A pointer reads its handle as
/// `live` makes it (a released target is None, never `receiver`).
#[no_mangle]
pub extern "C" fn destroy_scan(list: u32, from: u32, receiver: u32) -> u32 {
    let count = load32(list);
    let mut index = from;
    while index < count {
        let h = load32(list.wrapping_add(4).wrapping_add(index.wrapping_mul(4)));
        if h != 0 {
            let a = Obj::of(h);
            if !a.has(1 << R_OWNER | 1 << R_TOUCHING) || a.pointer(R_OWNER) == receiver {
                return index;
            }
            for slot in 0..4 {
                if live(a.word(R_TOUCHING, slot)) == receiver {
                    return index;
                }
            }
        }
        index += 1;
    }
    count
}

// mesh_reads block words (npc-mesh-preview.mjs MESH_BLOCK).
const MB_STATUS: u32 = 0;
const MB_MESH: u32 = 1;
const MB_STYLE: u32 = 2;
const MB_SCALEGLOW: u32 = 3;
const MB_LOCATION: u32 = 4;
const MB_PREPIVOT: u32 = 7;
const MB_DRAWSCALE: u32 = 10;
const MB_ANIMACTOR: u32 = 11;
const MB_POSE: u32 = 12;
const MB_LAST: u32 = MB_POSE + POSE_WORDS;
const MB_LAST_VALID: u32 = MB_LAST + POSE_WORDS;
// SetupForActor's reads, valid with MS_SETUP.
const MB_ZONE: u32 = MB_LAST_VALID + 1;
const MB_ILEAF: u32 = MB_ZONE + 1;
const MB_ZONENUMBER: u32 = MB_ZONE + 2;
const MB_AMBIENTGLOW: u32 = MB_ZONE + 3;
/// bNoSmooth 1, bMeshEnviroMap 2, bMeshCurvy 4, bUnlit 8, bSpecialLit 16.
const MB_SETUP_FLAGS: u32 = MB_ZONE + 4;
/// FDynamicSprite::Setup's own reads (setup.rs; the pose words hold the
/// animation actor's): DrawType, bParticles and AnimFrame.
const MB_DRAWTYPE: u32 = MB_ZONE + 5;
const MB_OWN_PARTICLES: u32 = MB_ZONE + 6;
const MB_OWN_ANIMFRAME: u32 = MB_ZONE + 7;
/// The actor's own AnimSequence word (its folded name id, 0 for None),
/// valid with MS_ANIMSEQ: Setup's GetAnimSeq looks the name up only when
/// it changes.
const MB_ANIMSEQ: u32 = MB_ZONE + 8;
/// FDynamicSprite::Setup's GetAnimSeq answer for the name word it was made for (the host writes them in packSetup; `pack_candidates`
/// reads them): valid flag, that name word, found, StartFrame, NumFrames.
const MB_SEQ_VALID: u32 = MB_ANIMSEQ + 1;
const MB_SEQ_WORD: u32 = MB_ANIMSEQ + 2;
const MB_SEQ_HIT: u32 = MB_ANIMSEQ + 3;
const MB_SEQ_START: u32 = MB_ANIMSEQ + 4;
const MB_SEQ_FRAMES: u32 = MB_ANIMSEQ + 5;
/// The numeric pose: animation actor, bParticles, DrawScale, Location,
/// Rotation, PrePivot, AnimFrame, BlendAnimFrame[4].
const POSE_WORDS: u32 = 17;
/// Which pose words are floats (NaN equals NaN, as Object.is).
const POSE_FLOATS: u32 = 1 << 2 | 0b111 << 3 | 0b111 << 9 | 0b11111 << 12;
// Status bits.
const MS_OK: u32 = 1;
const MS_DRAWN: u32 = 2;
const MS_DRAWN_CHILD: u32 = 4;
const MS_CHANGED: u32 = 8;
const MS_SETUP: u32 = 16;
const MS_ANIMSEQ: u32 = 32;
const MESH_SETUP_FIELDS: u64 = 1 << R_REGION_ZONE
    | 1 << R_REGION_ILEAF
    | 1 << R_REGION_ZONENUMBER
    | 1 << R_AMBIENTGLOW
    | 1 << R_BNOSMOOTH
    | 1 << R_BMESHENVIROMAP
    | 1 << R_BMESHCURVY
    | 1 << R_BUNLIT
    | 1 << R_BSPECIALLIT;

const MESH_SELF_FIELDS: u64 = 1 << R_BHIDDEN
    | 1 << R_BDELETEME
    | 1 << R_OWNER
    | 1 << R_BONLYOWNERSEE
    | 1 << R_BOWNERNOSEE
    | 1 << R_MESH
    | 1 << R_STYLE
    | 1 << R_SCALEGLOW
    | 1 << R_LOCATION
    | 1 << R_PREPIVOT
    | 1 << R_DRAWSCALE
    | 1 << R_BANIMBYOWNER
    | 1 << R_ROTATION
    | 1 << R_DRAWTYPE
    | 1 << R_BPARTICLES
    | 1 << R_ANIMFRAME;
const MESH_ANIM_FIELDS: u64 = 1 << R_BPARTICLES | 1 << R_ANIMFRAME | 1 << R_BLENDANIMFRAME;

#[inline(always)]
fn same_word(a: u32, b: u32, float: bool) -> bool {
    a == b || float && (a & 0x7fff_ffff) > 0x7f80_0000 && (b & 0x7fff_ffff) > 0x7f80_0000
}

/// npc-mesh-preview.mjs drawnInWorld on `a` (handle `h`) for `player`
/// (0: none), `behind` and `view_target`, with `child` as its third
/// argument; None when an owner on the walk cannot be read in the image or
/// the walk is too long.
fn drawn_in_world(a: &Obj, h: u32, player: u32, behind: bool, view_target: u32, child: bool) -> Option<bool> {
    if a.flag(R_BHIDDEN) || a.flag(R_BDELETEME) {
        return Some(false);
    }
    if player == 0 {
        return Some(true);
    }
    let target = if view_target != 0 { view_target } else { player };
    if !child && !behind && (h == target || view_target == h) {
        return Some(false);
    }
    let mut owned = false;
    let mut owner = h;
    let mut steps = 0;
    while owner != 0 {
        if owner == player {
            owned = true;
            break;
        }
        steps += 1;
        if steps > OWNER_WALK {
            return None;
        }
        owner = if owner == h {
            a.pointer(R_OWNER)
        } else {
            let o = Obj::of(owner);
            if !o.has(1 << R_OWNER) {
                return None;
            }
            o.pointer(R_OWNER)
        };
    }
    if a.flag(R_BONLYOWNERSEE) && (!owned || behind) {
        return Some(false);
    }
    Some(!(owned && a.flag(R_BOWNERNOSEE) && !behind))
}

/// The mesh scene's reads for `count` (handle, block) pairs at `pairs`: per
/// block the status (OK when every read is in the image; DRAWN and
/// DRAWN_CHILD, drawnInWorld without and with `child`; CHANGED when
/// MB_LAST_VALID and a numeric pose word differs from the last), Mesh,
/// Style, ScaleGlow, Location, PrePivot, DrawScale, the animation actor
/// (bAnimByOwner ? Owner ?? self : self), the numeric pose and the actor's
/// own DrawType, bParticles, AnimFrame and AnimSequence (FDynamicSprite::Setup's).
#[no_mangle]
pub extern "C" fn mesh_reads(pairs: u32, count: u32, player: u32, behind: u32, view_target: u32) {
    for k in 0..count {
        let h = load32(pairs.wrapping_add(8 * k));
        let block = load32(pairs.wrapping_add(8 * k + 4));
        mesh_read_block(h, block, player, behind != 0, view_target);
    }
}

/// `mesh_reads` for one (handle, block) pair.
fn mesh_read_block(h: u32, block: u32, player: u32, behind: bool, view_target: u32) {
    {
        let word = |i: u32| block.wrapping_add(4 * i);
        store32(word(MB_STATUS), 0);
        let a = Obj::of(h);
        if !a.has(MESH_SELF_FIELDS) {
            return;
        }
        let (Some(drawn), Some(drawn_child)) = (
            drawn_in_world(&a, h, player, behind, view_target, false),
            drawn_in_world(&a, h, player, behind, view_target, true),
        ) else {
            return;
        };
        let mut anim_actor = h;
        if a.flag(R_BANIMBYOWNER) {
            let owner = a.pointer(R_OWNER);
            if owner != 0 {
                anim_actor = owner;
            }
        }
        let other;
        let anim = if anim_actor == h {
            &a
        } else {
            other = Obj::of(anim_actor);
            &other
        };
        if !anim.has(MESH_ANIM_FIELDS) {
            return;
        }
        store32(word(MB_MESH), a.pointer(R_MESH));
        store32(word(MB_STYLE), a.byte(R_STYLE));
        store32(word(MB_SCALEGLOW), a.word(R_SCALEGLOW, 0));
        for i in 0..3 {
            store32(word(MB_LOCATION + i), a.word(R_LOCATION, i));
            store32(word(MB_PREPIVOT + i), a.word(R_PREPIVOT, i));
        }
        store32(word(MB_DRAWSCALE), a.word(R_DRAWSCALE, 0));
        store32(word(MB_ANIMACTOR), anim_actor);
        store32(word(MB_DRAWTYPE), a.byte(R_DRAWTYPE));
        store32(word(MB_OWN_PARTICLES), a.flag(R_BPARTICLES) as u32);
        store32(word(MB_OWN_ANIMFRAME), a.word(R_ANIMFRAME, 0));
        let mut pose = [0u32; POSE_WORDS as usize];
        pose[0] = anim_actor;
        pose[1] = anim.flag(R_BPARTICLES) as u32;
        pose[2] = a.word(R_DRAWSCALE, 0);
        for i in 0..3 {
            pose[3 + i] = a.word(R_LOCATION, i as u32);
            pose[6 + i] = a.word(R_ROTATION, i as u32);
            pose[9 + i] = a.word(R_PREPIVOT, i as u32);
        }
        pose[12] = anim.word(R_ANIMFRAME, 0);
        for i in 0..4 {
            pose[13 + i] = anim.word(R_BLENDANIMFRAME, i as u32);
        }
        let mut changed = false;
        for (i, &value) in pose.iter().enumerate() {
            let i = i as u32;
            changed |= !same_word(value, load32(word(MB_LAST + i)), POSE_FLOATS & 1 << i != 0);
            store32(word(MB_POSE + i), value);
        }
        let mut status = MS_OK;
        if drawn {
            status |= MS_DRAWN;
        }
        if drawn_child {
            status |= MS_DRAWN_CHILD;
        }
        if changed && load32(word(MB_LAST_VALID)) != 0 {
            status |= MS_CHANGED;
        }
        if a.has(MESH_SETUP_FIELDS) {
            status |= MS_SETUP;
            store32(word(MB_ZONE), a.pointer(R_REGION_ZONE));
            store32(word(MB_ILEAF), a.word(R_REGION_ILEAF, 0));
            store32(word(MB_ZONENUMBER), a.byte(R_REGION_ZONENUMBER));
            store32(word(MB_AMBIENTGLOW), a.byte(R_AMBIENTGLOW));
            let flags = a.flag(R_BNOSMOOTH) as u32
                | (a.flag(R_BMESHENVIROMAP) as u32) << 1
                | (a.flag(R_BMESHCURVY) as u32) << 2
                | (a.flag(R_BUNLIT) as u32) << 3
                | (a.flag(R_BSPECIALLIT) as u32) << 4;
            store32(word(MB_SETUP_FLAGS), flags);
        }
        if a.has(1 << R_ANIMSEQUENCE) {
            status |= MS_ANIMSEQ;
            store32(word(MB_ANIMSEQ), load32(a.at(R_ANIMSEQUENCE)));
        }
        store32(word(MB_STATUS), status);
    }
}

// The actor mesh layer's roster (actor-mesh-sim.mjs, docs/firefox-60fps-plan.md "Actors layer in bulk"): one row of eight words per
// binding, in the layer's binding order.
const RW_HANDLE: u32 = 0;
const RW_BLOCK: u32 = 1;
const RW_MESH: u32 = 2;
const RW_POS: u32 = 3;
/// The mesh record's address in the occlusion kernel (the host writes it once; `pack_candidates` reads it).
const RW_RECORD: u32 = 4;
const ROW_BYTES: u32 = 32;
/// A row's position when its actor is not in Level.Actors (or the positions were not asked for).
const NO_POS: u32 = 0xffff_ffff;
// What a row gets the host's attention for (`roster_reads`' entries are `row << 4 | reasons`).
/// The positions were asked for and the actor is not in Level.Actors.
const AT_ABSENT: u32 = 1;
/// The block was read and its Mesh is not the one the binding was made for.
const AT_MESH: u32 = 2;
/// The image does not answer for the actor's reads (the block's status lacks OK, or the binding has no block): the host reads them.
const AT_NOT_OK: u32 = 4;
/// The row's handle has been released since it was written.
const AT_STALE: u32 = 8;

#[inline(always)]
fn handle_slot_of(handle: u32, mask: u32) -> u32 {
    let x = handle.wrapping_mul(0x9e37_79b1);
    (x ^ (x >> 15)) & mask
}

/// A table of `slots` (a power of two) [handle, value] pairs at `table`, emptied.
fn clear_table(table: u32, slots: u32) {
    for i in 0..slots.wrapping_mul(2) {
        store32(table.wrapping_add(i.wrapping_mul(4)), 0);
    }
}

/// Add `handle` -> `value` to the table unless the handle is in it.
fn table_add(table: u32, mask: u32, handle: u32, value: u32) {
    let mut at = handle_slot_of(handle, mask);
    loop {
        let entry = table.wrapping_add(at.wrapping_mul(8));
        let key = load32(entry);
        if key == handle {
            return;
        }
        if key == 0 {
            store32(entry, handle);
            store32(entry.wrapping_add(4), value);
            return;
        }
        at = at.wrapping_add(1) & mask;
    }
}

/// The value the table holds for `handle`, or None.
fn table_get(table: u32, mask: u32, handle: u32) -> Option<u32> {
    let mut at = handle_slot_of(handle, mask);
    loop {
        let entry = table.wrapping_add(at.wrapping_mul(8));
        let key = load32(entry);
        if key == handle {
            return Some(load32(entry.wrapping_add(4)));
        }
        if key == 0 {
            return None;
        }
        at = at.wrapping_add(1) & mask;
    }
}

/// The table of Level.Actors' handles at `scratch`: each live handle of `list` ([count, handle...]) -> the first index it is at.
fn level_table(list: u32, scratch: u32, slots: u32) {
    let mask = slots.wrapping_sub(1);
    clear_table(scratch, slots);
    let n = load32(list);
    for i in 0..n {
        let h = live(load32(list.wrapping_add(4).wrapping_add(i.wrapping_mul(4))));
        if h != 0 {
            table_add(scratch, mask, h, i);
        }
    }
}

/// The positions `roster_reads` writes, alone: each row's index in Level.Actors (NO_POS for none, and for a row whose handle has been
/// released).
#[no_mangle]
pub extern "C" fn roster_positions(rows: u32, count: u32, list: u32, scratch: u32, list_slots: u32) {
    let mask = list_slots.wrapping_sub(1);
    level_table(list, scratch, list_slots);
    for k in 0..count {
        let row = rows.wrapping_add(k.wrapping_mul(ROW_BYTES));
        let h = load32(row.wrapping_add(4 * RW_HANDLE));
        let pos = if h == 0 || live(h) != h { NO_POS } else { table_get(scratch, mask, h).unwrap_or(NO_POS) };
        store32(row.wrapping_add(4 * RW_POS), pos);
    }
}

/// `mesh_reads` over the roster's `count` rows at `rows`, and what the host must look at. Per row with a block: the block as
/// `mesh_reads` makes it (not for a row whose handle has been released: its block is cleared). With `list` ([count, handle...] of
/// Level.Actors, `list_slots` a power of two of at least twice its count; `scratch` that many [handle, index] pairs of memory) also
/// the row's position in it (the first index of its handle, NO_POS when it has none), written to the row. `attn` receives
/// `row << 4 | reasons` for each row with a reason (AT_*), in row order; returns how many.
#[no_mangle]
pub extern "C" fn roster_reads(rows: u32, count: u32, player: u32, behind: u32, view_target: u32, list: u32, scratch: u32, list_slots: u32, attn: u32) -> u32 {
    let mask = list_slots.wrapping_sub(1);
    if list != 0 {
        level_table(list, scratch, list_slots);
    }
    let mut written = 0u32;
    for k in 0..count {
        let row = rows.wrapping_add(k.wrapping_mul(ROW_BYTES));
        let h = load32(row.wrapping_add(4 * RW_HANDLE));
        let block = load32(row.wrapping_add(4 * RW_BLOCK));
        let mesh = load32(row.wrapping_add(4 * RW_MESH));
        let mut reasons = 0;
        let stale = h != 0 && live(h) != h;
        if stale {
            reasons |= AT_STALE;
        }
        if block != 0 {
            if stale {
                store32(block.wrapping_add(4 * MB_STATUS), 0);
            } else {
                mesh_read_block(h, block, player, behind != 0, view_target);
            }
            let status = load32(block.wrapping_add(4 * MB_STATUS));
            if status & MS_OK == 0 {
                reasons |= AT_NOT_OK;
            } else if load32(block.wrapping_add(4 * MB_MESH)) != mesh {
                reasons |= AT_MESH;
            }
        } else {
            reasons |= AT_NOT_OK;
        }
        if list != 0 {
            let pos = if h == 0 || stale { NO_POS } else { table_get(scratch, mask, h).unwrap_or(NO_POS) };
            store32(row.wrapping_add(4 * RW_POS), pos);
            if pos == NO_POS {
                reasons |= AT_ABSENT;
            }
        }
        if reasons != 0 {
            store32(attn.wrapping_add(written.wrapping_mul(4)), k << 4 | reasons);
            written += 1;
        }
    }
    written
}

/// The fields `admit_filter` reads: drawnInWorld's.
const ADMIT_FIELDS: u64 = 1 << R_BHIDDEN | 1 << R_BDELETEME | 1 << R_OWNER | 1 << R_BONLYOWNERSEE | 1 << R_BOWNERNOSEE;

/// The admission scan's mesh entries from `n` render_scan entries at `entries` over `list` (`entry >> 6` the Level.Actors index; the
/// frame's shared walk, or a walk for the mesh kind): the entries' bits in `keep` (the kinds the consumer asked for and K_JS), an
/// entry with none is passed over, as the host's `served` does. Of those, without the ones the layer's admit would turn away without
/// effect: an actor that has a row in the roster (it is bound), and one that drawnInWorld rejects (for a root frame and, with
/// `child_frames`, for a child frame), when the image answers for it. Entries the image does not answer for (K_JS) and every other
/// are kept, in order. `scratch` and `slots` are as for `roster_reads`. Returns the number written to `out`.
#[no_mangle]
pub extern "C" fn admit_filter(list: u32, entries: u32, n: u32, keep: u32, rows: u32, count: u32, player: u32, behind: u32, view_target: u32,
    child_frames: u32, scratch: u32, slots: u32, out: u32) -> u32 {
    let mask = slots.wrapping_sub(1);
    clear_table(scratch, slots);
    for k in 0..count {
        let h = load32(rows.wrapping_add(k.wrapping_mul(ROW_BYTES)).wrapping_add(4 * RW_HANDLE));
        if h != 0 {
            table_add(scratch, mask, h, 1);
        }
    }
    let mut written = 0u32;
    for i in 0..n {
        let raw = load32(entries.wrapping_add(i.wrapping_mul(4)));
        let bits = raw & keep & 63;
        if bits == 0 {
            continue;
        }
        let entry = raw & !63 | bits;
        if entry & K_JS == 0 {
            let h = live(load32(list.wrapping_add(4).wrapping_add((entry >> 6).wrapping_mul(4))));
            if h != 0 {
                if table_get(scratch, mask, h).is_some() {
                    continue;
                }
                let a = Obj::of(h);
                if a.has(ADMIT_FIELDS) {
                    let root = drawn_in_world(&a, h, player, behind != 0, view_target, false);
                    let child = if child_frames != 0 { drawn_in_world(&a, h, player, behind != 0, view_target, true) } else { Some(false) };
                    if root == Some(false) && child == Some(false) {
                        continue;
                    }
                }
            }
        }
        store32(out.wrapping_add(written.wrapping_mul(4)), entry);
        written += 1;
    }
    written
}

// Setup candidate words, as setup.rs C_* and bsp-occlusion.mjs SETUP lay them out.
const SU_KEY: u32 = 0;
const SU_DRAWTYPE: u32 = 1;
const SU_MESH: u32 = 2;
const SU_LOCATION: u32 = 6;
const SU_ROTATION: u32 = 9;
const SU_DRAWSCALE: u32 = 12;
const SU_PREPIVOT: u32 = 13;
const SU_PARTICLES: u32 = 16;
const SU_SEQ: u32 = 17;
const SU_SEQ_START: u32 = 18;
const SU_SEQ_FRAMES: u32 = 19;
const SU_ANIMFRAME: u32 = 20;
const SU_FLAGS: u32 = 21;
const SU_WORDS: u32 = 22;
/// refs bit: the binding is a candidate only for child frames (SETUP_ROOT_EXCLUDED).
const EC_EXCLUDED: u32 = 1 << 29;
/// `pack_candidates`' answer when the host must pack the frame itself.
const PACK_HOST: u32 = 0xffff_ffff;

/// A binding's Setup candidate words (actor-mesh-sim.mjs packSetup from this frame's block) at `out`, as entry `key` with mesh record
/// `record`; false when the block's cached GetAnimSeq answer is not for the actor's AnimSequence name word (the host packs it).
fn pack_binding(block: u32, key: u32, record: u32, excluded: bool, out: u32) -> bool {
    if block == 0 {
        return false;
    }
    let w = |i: u32| load32(block.wrapping_add(4 * i));
    let status = w(MB_STATUS);
    if status & MS_ANIMSEQ == 0 || w(MB_SEQ_VALID) == 0 || w(MB_SEQ_WORD) != w(MB_ANIMSEQ) {
        return false;
    }
    let put = |i: u32, value: u32| store32(out.wrapping_add(4 * i), value);
    put(SU_KEY, key);
    put(SU_DRAWTYPE, w(MB_DRAWTYPE));
    put(SU_MESH, record);
    put(3, 0);
    put(4, 0);
    put(5, 0);
    for k in 0..3 {
        put(SU_LOCATION + k, w(MB_LOCATION + k));
        put(SU_ROTATION + k, w(MB_POSE + 6 + k));
        put(SU_PREPIVOT + k, w(MB_PREPIVOT + k));
    }
    put(SU_DRAWSCALE, w(MB_DRAWSCALE));
    put(SU_PARTICLES, w(MB_OWN_PARTICLES));
    put(SU_SEQ, w(MB_SEQ_HIT));
    put(SU_SEQ_START, w(MB_SEQ_START));
    put(SU_SEQ_FRAMES, w(MB_SEQ_FRAMES));
    put(SU_ANIMFRAME, w(MB_OWN_ANIMFRAME));
    put(SU_FLAGS, excluded as u32);
    true
}

/// SetupDynamics' candidate order of the main frame (dynamics-candidates.mjs packDynamics) from the roster: the admitted bindings in
/// Level.Actors order (a row's order is its position times 65536) merged with the host's items and sprites by order, ties in the
/// order packDynamics builds them (bindings, then items, then sprites, each in its own order); an entry's index is its place in that
/// order. `skip` ([count, row << 2 | mode...]) are the rows the host decided: mode 1 not a candidate (an iterator stands in for the
/// actor, or the host found it not admitted), 2 a candidate for the root frame, 3 a candidate for child frames only; they are the rows
/// whose blocks the image does not answer for (a binding just made, one without a block) and the iterators' actors. `extra` holds
/// `extra_n` triples [order, class, index] (class 1 an item, 2 a sprite) the host builds; `scratch` is 9 * (count + extra_n) bytes of
/// memory (8-byte aligned). Writes, per entry, `refs`: class << 30 | EC_EXCLUDED | index (the row, the item or the sprite). Returns the
/// number of entries, or PACK_HOST when a binding's block is not answered by the image and the host did not decide it (the host's
/// packDynamics runs).
#[no_mangle]
pub extern "C" fn pack_order(rows: u32, count: u32, child_frames: u32, skip: u32, extra: u32, extra_n: u32, scratch: u32, refs: u32) -> u32 {
    let keys = scratch as usize as *mut u64;
    let flags = scratch.wrapping_add(8 * count.wrapping_add(extra_n));
    for b in 0..count {
        crate::interp::store8(flags.wrapping_add(b), 0);
    }
    for k in 0..load32(skip) {
        let entry = load32(skip.wrapping_add(4).wrapping_add(4 * k));
        if entry >> 2 < count {
            crate::interp::store8(flags.wrapping_add(entry >> 2), (entry & 3) as u8);
        }
    }
    let mut n = 0u32;
    for b in 0..count {
        let mode = load8(flags.wrapping_add(b));
        if mode == 1 {
            continue;
        }
        let row = rows.wrapping_add(b.wrapping_mul(ROW_BYTES));
        let pos = load32(row.wrapping_add(4 * RW_POS));
        if pos == NO_POS {
            continue;
        }
        let excluded = if mode >= 2 {
            mode == 3
        } else {
            let block = load32(row.wrapping_add(4 * RW_BLOCK));
            if block == 0 {
                return PACK_HOST;
            }
            let status = load32(block.wrapping_add(4 * MB_STATUS));
            if status & MS_OK == 0 {
                return PACK_HOST;
            }
            if status & MS_DRAWN != 0 {
                false
            } else if child_frames != 0 && status & MS_DRAWN_CHILD != 0 {
                true
            } else {
                continue;
            }
        };
        // order, then class (0 bindings), then the row
        unsafe { *keys.add(n as usize) = (pos as u64 * 65536) << 32 | (excluded as u64) << 29 | b as u64 };
        n += 1;
    }
    for k in 0..extra_n {
        let at = extra.wrapping_add(12 * k);
        let (order, class, index) = (load32(at), load32(at.wrapping_add(4)), load32(at.wrapping_add(8)));
        unsafe { *keys.add(n as usize) = (order as u64) << 32 | (class as u64) << 30 | index as u64 };
        n += 1;
    }
    let sorted = unsafe { core::slice::from_raw_parts_mut(keys, n as usize) };
    sorted.sort_unstable();
    for (i, &key) in sorted.iter().enumerate() {
        store32(refs.wrapping_add(4 * i as u32), key as u32);
    }
    n
}

/// The candidate words of the binding entries of `pack_order`'s `refs` (`n` entries) at `words` (SU_WORDS each, the key the entry's
/// index, the mesh record the row's); `host` ([count, entry...]) receives the binding entries whose block does not hold the sequence
/// answer for the actor's AnimSequence name word, which the host packs.
#[no_mangle]
pub extern "C" fn pack_words(rows: u32, refs: u32, n: u32, words: u32, host: u32) {
    let mut hosted = 0u32;
    for i in 0..n {
        let low = load32(refs.wrapping_add(4 * i));
        if low >> 30 != 0 {
            continue;
        }
        let row = rows.wrapping_add((low & 0x1fff_ffff).wrapping_mul(ROW_BYTES));
        let block = load32(row.wrapping_add(4 * RW_BLOCK));
        let record = load32(row.wrapping_add(4 * RW_RECORD));
        if !pack_binding(block, i, record, low & EC_EXCLUDED != 0, words.wrapping_add(4 * SU_WORDS * i)) {
            store32(host.wrapping_add(4).wrapping_add(4 * hosted), i);
            hosted += 1;
        }
    }
    store32(host, hosted);
}

// A mover's block (`mover_reads`): status, Location, Rotation, then the pair last given to the tracker and whether there is one.
const MV_STATUS: u32 = 0;
const MV_LOCATION: u32 = 1;
const MV_ROTATION: u32 = 4;
const MV_LAST: u32 = 7;
const MV_LAST_VALID: u32 = 13;
const MVS_OK: u32 = 1;
const MVS_MOVING: u32 = 2;
const MVS_CHANGED: u32 = 4;
const MOVER_FIELDS: u64 = 1 << R_BHIDDEN
    | 1 << R_OWNER
    | 1 << R_BONLYOWNERSEE
    | 1 << R_BOWNERNOSEE
    | 1 << R_BSTATIC
    | 1 << R_BRUSH
    | 1 << R_LOCATION
    | 1 << R_ROTATION;

/// render-visibility.mjs dynamicActorRoute on the moving brush `a` (handle `h`) in a root frame (Recursion 0, HighDetailActors set,
/// a running level) for the view actor `viewer`, with `view_target` and `behind` (bBehindView): whether the route is 'moving-brush'.
/// The excluded actor is the ViewTarget, else the view actor, unless bBehindView. None when an owner on the walk cannot be read in
/// the image or the walk is too long.
fn moving_brush(a: &Obj, h: u32, viewer: u32, view_target: u32, behind: bool) -> Option<bool> {
    if !behind && h == view_target {
        return Some(false);
    }
    let excluded = if behind {
        0
    } else if view_target != 0 {
        view_target
    } else {
        viewer
    };
    if h == excluded || a.flag(R_BHIDDEN) {
        return Some(false);
    }
    let mut owned = false;
    let mut owner = h;
    let mut steps = 0;
    while owner != 0 {
        if owner == viewer {
            owned = true;
            break;
        }
        steps += 1;
        if steps > OWNER_WALK {
            return None;
        }
        owner = if owner == h {
            a.pointer(R_OWNER)
        } else {
            let o = Obj::of(owner);
            if !o.has(1 << R_OWNER) {
                return None;
            }
            o.pointer(R_OWNER)
        };
    }
    if a.flag(R_BONLYOWNERSEE) && (!owned || behind) {
        return Some(false);
    }
    if owned && a.flag(R_BOWNERNOSEE) && !behind {
        return Some(false);
    }
    Some(a.pointer(R_BRUSH) != 0 && !a.flag(R_BSTATIC))
}

/// SetupDynamics' moving brushes' reads (sim-session.mjs updateMovers) for `count` (handle, block) pairs at `pairs`: per block the
/// status (OK when every field is read in the image; MOVING when dynamicActorRoute gives 'moving-brush'; CHANGED when moving and
/// the Location and Rotation words differ from the pair the host last gave the tracker, or it gave none), and the Location and
/// Rotation words. The host writes the last pair (MV_LAST, MV_LAST_VALID) when it gives them to the tracker.
#[no_mangle]
pub extern "C" fn mover_reads(pairs: u32, count: u32, viewer: u32, view_target: u32, behind: u32) {
    for k in 0..count {
        let h = load32(pairs.wrapping_add(8 * k));
        let block = load32(pairs.wrapping_add(8 * k + 4));
        let word = |i: u32| block.wrapping_add(4 * i);
        store32(word(MV_STATUS), 0);
        let a = Obj::of(h);
        if !a.has(MOVER_FIELDS) {
            continue;
        }
        let Some(moving) = moving_brush(&a, h, viewer, view_target, behind != 0) else {
            continue;
        };
        let mut status = MVS_OK;
        if moving {
            status |= MVS_MOVING;
            let valid = load32(word(MV_LAST_VALID)) != 0;
            let mut changed = !valid;
            for i in 0..3 {
                let (location, rotation) = (a.word(R_LOCATION, i), a.word(R_ROTATION, i));
                store32(word(MV_LOCATION + i), location);
                store32(word(MV_ROTATION + i), rotation);
                changed |= location != load32(word(MV_LAST + i)) || rotation != load32(word(MV_LAST + 3 + i));
            }
            if changed {
                status |= MVS_CHANGED;
            }
        }
        store32(word(MV_STATUS), status);
    }
}

pub(crate) const FAR_MOVE_FIELDS: u64 = 1 << R_BSTATIC
    | 1 << R_BMOVABLE
    | 1 << R_BDELETEME
    | 1 << R_BCOLLIDEACTORS
    | 1 << R_BBLOCKACTORS
    | 1 << R_BBLOCKPLAYERS
    | 1 << R_BCOLLIDEWORLD
    | 1 << R_BCOLLIDEWHENPLACING
    | 1 << R_STANDINGCOUNT
    | 1 << R_BRUSH
    | 1 << R_LOCATION
    | 1 << R_OLDLOCATION
    | 1 << R_BJUSTTELEPORTED
    | 1 << R_REGION_ZONE
    | 1 << R_REGION_ILEAF
    | 1 << R_REGION_ZONENUMBER;
/// FindSpot's extent: the actor cylinder (relocation.mjs passes `[radius, radius, height]`).
const FAR_MOVE_FIT_FIELDS: u64 = 1 << R_COLLISIONRADIUS | 1 << R_COLLISIONHEIGHT;
/// ParticleIterator::CurrentItem's two writes onto the proxy (particles.rs `particle_items`).
pub(crate) const ITEM_FIELDS: u64 = 1 << R_DRAWSCALE | 1 << R_SCALEGLOW;

/// What `far_plan` decides for one FarMoveActor.
pub(crate) enum FarMove {
    /// The JavaScript body must run; nothing was stored.
    Declined,
    /// FindSpot refuses the destination: the original returns false before
    /// any store, and the actor is untouched.
    Failed,
    /// The move succeeds; the zone to store with it (None for a deleted actor).
    Moved(Option<crate::zone::Region>),
}

/// ULevel::FarMoveActor (0x10398ba0, relocation.mjs farMoveActor) with
/// Test 0 on a non-Pawn, non-Brush actor of the image (`a`) to the f32
/// bits `p`, decided without a store, where the JavaScript body would run
/// no callback beyond FindSpot's one point check: movable and not static,
/// no collision or blocking bits and no Brush (no hash remove/add; the
/// non-Pawn CheckEncroachment returns false before any query,
/// docs/rider-move-kernel.md), no standing riders, a finite destination,
/// and SetActorZone keeping the zone (or bDeleteMe, where it returns at
/// once). FindSpot (`no_check` clear and bCollideWorld or
/// bCollideWhenPlacing, standalone): Engine 0x10398480 with a zero extent
/// (CollisionRadius and CollisionHeight zero) is one SinglePointCheck on the
/// world model (docs/fitting.md, fitting.mjs `findSpot`), answered by
/// `world`, the world BSP's kernel address (trace.rs `point_clear`; 0 where
/// the host has none, a nonzero extent or a model the JavaScript throws on
/// declines). `model` is the zone model (zone.rs).
pub(crate) fn far_plan(a: &Obj, model: u32, world: u32, p: [u32; 3], no_check: u32) -> FarMove {
    if !a.has(FAR_MOVE_FIELDS) || a.flag(R_BSTATIC) || !a.flag(R_BMOVABLE) {
        return FarMove::Declined;
    }
    if a.flag(R_BCOLLIDEACTORS) || a.flag(R_BBLOCKACTORS) || a.flag(R_BBLOCKPLAYERS) || a.pointer(R_BRUSH) != 0 {
        return FarMove::Declined;
    }
    if a.byte(R_STANDINGCOUNT) != 0 {
        return FarMove::Declined;
    }
    if p.iter().any(|&w| w & 0x7f80_0000 == 0x7f80_0000) {
        return FarMove::Declined;
    }
    if no_check == 0 && (a.flag(R_BCOLLIDEWORLD) || a.flag(R_BCOLLIDEWHENPLACING)) {
        // A NaN extent is not zero (`e.every(value => value === 0)`); -0 is.
        if !a.has(FAR_MOVE_FIT_FIELDS)
            || (a.word(R_COLLISIONRADIUS, 0) | a.word(R_COLLISIONHEIGHT, 0)) & 0x7fff_ffff != 0
            || world == 0
        {
            return FarMove::Declined;
        }
        match unsafe { crate::trace::point_clear(world, p.map(|w| f32::from_bits(w) as f64)) } {
            1 => {}
            0 => return FarMove::Failed,
            _ => return FarMove::Declined,
        }
    }
    if a.flag(R_BDELETEME) {
        return FarMove::Moved(None);
    }
    if model == 0 || !crate::zone::model_live(model) {
        return FarMove::Declined;
    }
    let point = p.map(|w| f32::from_bits(w) as f64);
    let Some(r) = crate::zone::point_region(model, point) else {
        return FarMove::Declined;
    };
    if r.zone != a.pointer(R_REGION_ZONE) {
        return FarMove::Declined;
    }
    FarMove::Moved(Some(r))
}

/// The stores of a successful `far_plan`: bJustTeleported, Location,
/// OldLocation and Region.
pub(crate) fn far_commit(a: &Obj, p: [u32; 3], region: Option<crate::zone::Region>) {
    a.set_flag(R_BJUSTTELEPORTED);
    for i in 0..3 {
        a.set_word(R_LOCATION, i, p[i as usize]);
        a.set_word(R_OLDLOCATION, i, p[i as usize]);
    }
    if let Some(r) = region {
        a.set_word(R_REGION_ZONE, 0, r.zone);
        a.set_word(R_REGION_ILEAF, 0, r.leaf as u32);
        a.set_byte(R_REGION_ZONENUMBER, r.number as u8);
    }
}

/// FarMoveActor(actor, destination, Test 0, `no_check`) to the f32 bits
/// `x, y, z` on the image actor `handle` (`far_plan`): 1 when the actor
/// moved, 2 when FindSpot refused (the original's false, nothing stored), 0
/// when the JavaScript body must run (nothing was stored).
#[no_mangle]
pub extern "C" fn far_move(handle: u32, model: u32, x: u32, y: u32, z: u32, no_check: u32, world: u32) -> u32 {
    let a = Obj::of(handle);
    let p = [x, y, z];
    match far_plan(&a, model, world, p, no_check) {
        FarMove::Declined => 0,
        FarMove::Failed => 2,
        FarMove::Moved(region) => {
            far_commit(&a, p, region);
            1
        }
    }
}
