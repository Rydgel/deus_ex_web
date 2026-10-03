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
const FIELD_COUNT: usize = 20;
/// The fields meshlight.rs reads on a light.
pub(crate) const MESH_LIGHT_FIELDS: u32 = 1 << R_LIGHTTYPE
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

const LIGHT_FIELDS: u32 = 1 << R_LIGHTTYPE
    | 1 << R_BDELETEME
    | 1 << R_BSTATIC
    | 1 << R_BNODELETE
    | 1 << R_BDYNAMICLIGHT
    | 1 << R_LIGHTBRIGHTNESS
    | 1 << R_LIGHTRADIUS;
const SPRITE_FIELDS: u32 = 1 << R_BHIDDEN
    | 1 << R_BONLYOWNERSEE
    | 1 << R_BOWNERNOSEE
    | 1 << R_OWNER
    | 1 << R_RENDERITERATOR
    | 1 << R_DRAWTYPE;
const MESH_FIELDS: u32 = 1 << R_MESH;
const AMBIENT_FIELDS: u32 = 1 << R_AMBIENTSOUND;
/// Owners followed before an actor is handed to JavaScript.
const OWNER_WALK: u32 = 64;

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

/// The class row's render word: bit i for field i, and COMPUTED.
const COMPUTED: u32 = 1 << 31;

#[inline(always)]
fn rfield(field: usize) -> [u32; 3] {
    unsafe { (*addr_of!(R_FIELDS))[field] }
}

/// An actor the scan reads: its receiver info, binding set and the row's
/// render word (0 for a HOST or undescribed object).
pub(crate) struct Obj {
    info: u32,
    bind: u32,
    fields: u32,
}

impl Obj {
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
        Obj { info, bind, fields: load32(at) }
    }
    /// Whether every field of `set` is read in the image.
    pub(crate) fn has(&self, set: u32) -> bool {
        if self.fields & set != set {
            return false;
        }
        if self.info & BOUND != 0 {
            for i in 0..FIELD_COUNT {
                if set & (1 << i) != 0 && bound_key(self.bind, rfield(i)[2]) {
                    return false;
                }
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
    pub(crate) fn flag(&self, field: usize) -> bool {
        load32(self.at(field)) & rfield(field)[1] != 0
    }
    /// A pointer as readNamed yields it: a released handle is None.
    fn pointer(&self, field: usize) -> u32 {
        live(load32(self.at(field)))
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

/// Scan `list` ([count, handle...]) from `start` for `kinds`, writing
/// entries to `out`; returns the number written. With ITERATOR requested,
/// the scan ends after the first ITERATOR entry.
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
    let mut written = 0u32;
    let mut emit = |index: u32, bits: u32| {
        crate::interp::store32(out.wrapping_add(written.wrapping_mul(4)), index << 6 | bits);
        written += 1;
    };
    let mut index = start;
    while index < count {
        let h = live(load32(list.wrapping_add(4).wrapping_add(index.wrapping_mul(4))));
        let i = index;
        index += 1;
        if h == 0 {
            continue;
        }
        let a = Obj::of(h);
        if !a.has(need) {
            emit(i, K_JS);
            continue;
        }
        let mut bits = 0;
        if kinds & K_LIGHT != 0 && light(&a) {
            bits |= K_LIGHT;
        }
        if kinds & K_MESH != 0 && a.pointer(R_MESH) != 0 {
            bits |= K_MESH;
        }
        if kinds & K_AMBIENT != 0 && a.pointer(R_AMBIENTSOUND) != 0 {
            bits |= K_AMBIENT;
        }
        if sprites && h != viewer {
            match sprite(&a, h, viewer, view_target, first_person != 0) {
                None => {
                    emit(i, K_JS);
                    continue;
                }
                Some(kind) => bits |= kind & kinds,
            }
        }
        if bits != 0 {
            emit(i, bits);
            if bits & K_ITERATOR != 0 {
                break;
            }
        }
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
    store32(out, kind);
    store32(out.wrapping_add(4), cursor);
    store32(out.wrapping_add(8), steps);
}
