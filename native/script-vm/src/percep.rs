//! Perception natives in the interpreter (docs/rust-core.md, step R3-c):
//! ScriptedPawn's IsValidEnemy (2105) and GetPawnAllianceType (2107)
//! (src/runtime/script-pawn-alliance.mjs) and Pawn's AICanSee (705) with
//! AIVisibility and AIGetLightLevel inside it
//! (src/runtime/script-pawn-perception.mjs, script-ai-visibility.mjs). Each
//! body transcribes its JavaScript function step for step: the same reads in
//! the same order, the same x87 model operations (`Ext`, with the JavaScript
//! model's operand order), `Math.fround` where it rounds, and the same
//! transcendental functions (Math.atan and Math.atan2, imported).
//!
//! Word code (after the kind): `node, argc`, then per argument a presence
//! word (0 for EX_Nothing, whose value is undefined) and, when present, the
//! argument's words. The arguments evaluate in order with SELF, as
//! `evaluateArgument` does, before the body runs.
//! * PAWN_ENEMY 200 (bool): IsValidEnemy(Pawn, optional bool).
//! * PAWN_ALLIANCE 201 (int): GetPawnAllianceType(Pawn).
//! * AI_CAN_SEE 202 (float): AICanSee(Actor, optional float, four optional
//!   bools).
//!
//! Reads. A field is read in the image when its object's receiver info is
//! not HOST, its class row's field word says the property name resolves to
//! the key and cell the host table (P_FIELDS) describes, and the key is not
//! a bound key on a BOUND receiver: exactly when `readNamed` reads that cell.
//! A name cell's bytes hold its `nameKeyId` (0 for None), the fold the
//! alliance bodies compare.
//! * The alliance bodies only read, so any read that cannot be made in the
//!   image hands the whole call to JavaScript (`js_alliance`), with the
//!   evaluated arguments in P_ARGS.
//! * AICanSee writes the target's visibility cache half way. Any other read
//!   goes through `js_pread`/`js_pread3`, the JavaScript read of that body at
//!   the same point, and a write that cannot be made in the image through
//!   `js_pwrite`. A call is handed to JavaScript (`js_aicansee`) only before
//!   the first write, when a value's bits could depend on V8 (a NaN reaching
//!   a store, a nonfinite transcendental or rotation argument, whose
//!   JavaScript throws) or a host seam (`perceptionLighting`) is set.
//! * The level queries stay imports: the light traces (`js_light_trace`,
//!   AIGetLightLevel's SingleLineCheck) and the line-of-sight traces
//!   (`js_los_trace`, the SingleLineCheck wrapper with its filter) run in the
//!   trace kernel's instance, which holds the BSP and the collision hash.
//!   Level.Actors comes from `js_level_actors` as (handle, receiver info)
//!   pairs, built per scan.
//!
//! PERCEPTION_DIFFERENTIAL (P_CHECK): each call completed here reports to
//! `js_percep_verify`, which runs the JavaScript body on the same arguments
//! and state (AICanSee's cache fields are restored from `js_percep_begin`'s
//! snapshot first) and compares the result, the writes and the traces.

use crate::interp::{
    bound_key, class_entry, js_class_row, load32, load8, receiver, row_has_name, store32, to_int32, widen,
    Recv, Run, BOUND, HOST, NAME_NONE, RELEASED, SELF, UNDEFINED, UNDEF_F64_BITS,
};
use crate::trace::{f, pow2, sqrt};
use crate::x87::Ext;
use core::ptr::{addr_of, addr_of_mut};

// Field indices (script-vm-rust.mjs PERCEPTION_FIELDS).
pub(crate) const F_BDELETEME: usize = 0;
pub(crate) const F_BDETECTABLE: usize = 1;
pub(crate) const F_HEALTH: usize = 2;
pub(crate) const F_ALLIANCE: usize = 3;
pub(crate) const F_ALLIANCES: usize = 4;
pub(crate) const F_BLIKESNEUTRAL: usize = 5;
pub(crate) const F_BREVERSE: usize = 6;
pub(crate) const F_LOCATION: usize = 7;
pub(crate) const F_CRADIUS: usize = 8;
pub(crate) const F_CHEIGHT: usize = 9;
pub(crate) const F_VISUPDATE: usize = 10;
pub(crate) const F_CURVIS: usize = 11;
pub(crate) const F_LASTVIS: usize = 12;
pub(crate) const F_VELOCITY: usize = 13;
pub(crate) const F_BUNLIT: usize = 14;
pub(crate) const F_BASEEYE: usize = 15;
pub(crate) const F_MINANG: usize = 16;
pub(crate) const F_ASPECT: usize = 17;
pub(crate) const F_HFOV: usize = 18;
pub(crate) const F_ROTATION: usize = 19;
pub(crate) const F_VIEWROT: usize = 20;
pub(crate) const F_ADDVIEWROT: usize = 21;
pub(crate) const F_VISTHRESH: usize = 22;
pub(crate) const F_LIGHTTYPE: usize = 23;
pub(crate) const F_LIGHTBRIGHT: usize = 24;
pub(crate) const F_LIGHTRADIUS: usize = 25;
pub(crate) const F_LIGHTSAT: usize = 26;
pub(crate) const F_BSTATIC: usize = 27;
pub(crate) const F_TIMESECONDS: usize = 28;
pub(crate) const F_AMBBRIGHT: usize = 29;
pub(crate) const F_AMBSAT: usize = 30;
const FIELD_COUNT: usize = 31;

// Cell kinds of the fields, as the host checked them.
const K_BOOL: u8 = 1;
const K_INT: u8 = 2;
const K_BYTE: u8 = 3;
const K_FLOAT: u8 = 4;
const K_NAME: u8 = 5;
const K_VECTOR: u8 = 6;
const K_ROTATOR: u8 = 7;
const K_FIXED: u8 = 8;
const KINDS: [u8; FIELD_COUNT] = [
    K_BOOL, K_BOOL, K_INT, K_NAME, K_FIXED, K_BOOL, K_BOOL, // alliance
    K_VECTOR, K_FLOAT, K_FLOAT, K_FLOAT, K_FLOAT, K_FLOAT, K_VECTOR, K_BOOL, // target actor
    K_FLOAT, K_FLOAT, K_FLOAT, K_FLOAT, K_ROTATOR, K_ROTATOR, K_ROTATOR, K_FLOAT, // viewer pawn
    K_BYTE, K_BYTE, K_BYTE, K_BYTE, K_BOOL, // light
    K_FLOAT, K_BYTE, K_BYTE, // LevelInfo, ZoneInfo
];

// A class row's two words after its name list: the fields it resolves as
// P_FIELDS describes (bit i for field i), then flags (0 until the host
// computed them).
const H_SCRIPTED_PAWN: u32 = 1;

// The JavaScript read services of each body (js_pread).
const SITE_PERCEP: u32 = 1;
const SITE_AIVIS: u32 = 2;

// Alliance types.
const FRIENDLY: i32 = 0;
const NEUTRAL: i32 = 1;
const HOSTILE: i32 = 2;

/// P_FIELDS: per field [offset, bool mask, key id], written by the host once.
static mut P_FIELDS: [[u32; 3]; FIELD_COUNT] = [[0; 3]; FIELD_COUNT];
/// P_ALLIANCE: the AlliancesEx element's stride and its AllianceName,
/// AllianceLevel and AgitationLevel offsets.
static mut P_ALLIANCE: [u32; 4] = [0; 4];
/// P_NAMES: the name ids of `playerpawn` and `levelinfo` (row name lists).
static mut P_NAMES: [u32; 2] = [0; 2];
/// P_ARGS: argc, the EX_Nothing mask, then the six argument values (object
/// handles, bools 0/1, the float as its JavaScript number).
static mut P_ARGS: [f64; 8] = [0.0; 8];
/// P_IO: a vector or rotator js_pread3 read.
static mut P_IO: [f64; 3] = [0.0; 3];
/// P_CHECK: PERCEPTION_DIFFERENTIAL.
static mut P_CHECK: u32 = 0;

#[no_mangle]
pub extern "C" fn percep_fields_ptr() -> *mut u32 {
    addr_of_mut!(P_FIELDS) as *mut u32
}
#[no_mangle]
pub extern "C" fn percep_alliance_ptr() -> *mut u32 {
    addr_of_mut!(P_ALLIANCE) as *mut u32
}
#[no_mangle]
pub extern "C" fn percep_names_ptr() -> *mut u32 {
    addr_of_mut!(P_NAMES) as *mut u32
}
#[no_mangle]
pub extern "C" fn percep_args_ptr() -> *mut f64 {
    addr_of_mut!(P_ARGS) as *mut f64
}
#[no_mangle]
pub extern "C" fn percep_io_ptr() -> *mut f64 {
    addr_of_mut!(P_IO) as *mut f64
}
#[no_mangle]
pub extern "C" fn percep_check_ptr() -> *mut u32 {
    addr_of_mut!(P_CHECK)
}

#[link(wasm_import_module = "env")]
extern "C" {
    fn js_class_fields(handle: u32);
    fn js_pread(frame: u32, handle: u32, field: u32, site: u32) -> f64;
    fn js_pread3(frame: u32, handle: u32, field: u32, site: u32);
    fn js_pwrite(frame: u32, handle: u32, field: u32, value: f64);
    fn js_is_a(frame: u32, handle: u32, name: u32) -> i32;
    fn js_alliance(frame: u32, node: u32, receiver: u32) -> i32;
    fn js_aicansee(frame: u32, node: u32, receiver: u32) -> f64;
    fn js_vis_info(frame: u32, handle: u32) -> u32;
    fn js_zone(frame: u32, handle: u32) -> u32;
    fn js_level_actors(frame: u32, handle: u32) -> u32;
    fn js_light_trace(frame: u32, source: u32, px: f64, py: f64, pz: f64, sx: f64, sy: f64, sz: f64) -> i32;
    fn js_los_trace(frame: u32, viewer: u32, other: u32, ex: f64, ey: f64, ez: f64, sx: f64, sy: f64, sz: f64)
        -> i32;
    fn js_atan(x: f64) -> f64;
    fn js_atan2(y: f64, x: f64) -> f64;
    fn js_percep_begin(frame: u32, node: u32, receiver: u32);
    fn js_percep_verify(frame: u32, node: u32, receiver: u32, result: f64);
}

#[inline(always)]
fn pfield(field: usize) -> [u32; 3] {
    unsafe { (*addr_of!(P_FIELDS))[field] }
}
#[inline(always)]
fn check() -> bool {
    unsafe { P_CHECK != 0 }
}
/// A name cell's id: its nameKeyId, None stored as 0.
#[inline(always)]
fn name_word(addr: u32) -> u32 {
    let id = load32(addr);
    if id == 0 {
        NAME_NONE
    } else {
        id
    }
}

/// An object a body reads: its handle, receiver info, class row (0 when not
/// described) and the row's field and flag words (0 for a HOST object).
#[derive(Clone, Copy)]
struct Obj {
    handle: u32,
    info: u32,
    /// Its binding set (interp.rs `receiver`), 0 for the global table.
    bind: u32,
    row: u32,
    fields: u32,
    flags: u32,
}

impl Obj {
    /// The field's address in the image, when `readNamed` reads it there.
    #[inline(always)]
    fn addr(&self, field: usize) -> Option<u32> {
        if self.fields & (1 << field) == 0 {
            return None;
        }
        let [offset, _, key] = pfield(field);
        if self.info & BOUND != 0 && bound_key(self.bind, key) {
            return None;
        }
        Some((self.info & !15).wrapping_add(offset))
    }
}

// ---- The JavaScript x87 model's helpers (script-vm.mjs x87*) -------------

/// x87load of a JavaScript number: `f32bits(v)` (setFloat32's rounding).
#[inline(always)]
fn ld(v: f64) -> Ext {
    Ext::load((v as f32).to_bits())
}
/// x87store: the float32, as the JavaScript number `f32num` returns.
#[inline(always)]
fn st(v: Ext) -> f64 {
    f32::from_bits(v.store()) as f64
}
/// `x87add(a, x87neg(b))`.
#[inline(always)]
fn sub(a: Ext, b: Ext) -> Ext {
    a.add(b.neg())
}
/// FCOM's C0 (below) and C3 (equal): both on unordered (x87compare /
/// script-ai-visibility.mjs `compare`).
fn fcom(a: Ext, b: Ext) -> (bool, bool) {
    if a.nan() || b.nan() {
        return (true, true);
    }
    let order = |x: Ext| -> (i32, i32, u64) {
        // (class, exponent, significand) for a nonnegative magnitude order.
        if x.inf() {
            (2, 0, 0)
        } else if x.sig == 0 {
            (0, 0, 0)
        } else {
            (1, x.exp, x.sig)
        }
    };
    // Two zeros are equal whatever their signs; otherwise a signed zero
    // orders as zero does.
    let (sa, sb) = (a.negative(), b.negative());
    let (ma, mb) = (order(a), order(b));
    let m = if ma.0 == 0 && mb.0 == 0 {
        0
    } else if sa != sb {
        if sa {
            -1
        } else {
            1
        }
    } else {
        let c = if ma < mb {
            -1
        } else if ma > mb {
            1
        } else {
            0
        };
        if sa {
            -c
        } else {
            c
        }
    };
    (m < 0, m == 0)
}
#[inline(always)]
fn below(a: Ext, b: Ext) -> bool {
    fcom(a, b).0
}
/// `add(add(mul(a0, b0), mul(a1, b1)), mul(a2, b2))` on loads.
#[inline(always)]
fn dot3(a: [f64; 3], b: [f64; 3]) -> Ext {
    ld(a[0]).mul(ld(b[0])).add(ld(a[1]).mul(ld(b[1]))).add(ld(a[2]).mul(ld(b[2])))
}
#[inline(always)]
fn magsq3(v: [f64; 3]) -> Ext {
    dot3(v, v)
}
/// The value of a finite x87 double (x87toDouble): `sig * 2 ** exp` with
/// the 53 significant bits store_double leaves.
fn to_double(v: Ext) -> f64 {
    if v.inf() {
        return if v.negative() { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    if v.sig == 0 {
        return if v.negative() { -0.0 } else { 0.0 };
    }
    let n = (v.sig >> 11) as f64;
    (if v.negative() { -n } else { n }) * pow2(v.exp + 11)
}
fn is_finite_double(v: f64) -> bool {
    v == v && v != f64::INFINITY && v != f64::NEG_INFINITY
}
/// Core FGlobalMath's table sine, as a JavaScript number.
#[inline(always)]
fn sin_of(angle: i32) -> f64 {
    f32::from_bits(crate::rotator_sin(angle)) as f64
}

/// FCoords(FRotator) (script-pawn-locomotion.mjs fcoordsAxes): roll, pitch,
/// then yaw passes over the unit coords, each field's components stored.
pub(crate) fn fcoords_axes(rotation: [i32; 3]) -> [[f64; 3]; 4] {
    let [pitch, yaw, roll] = rotation;
    let c = |a: i32| sin_of(a.wrapping_add(0x4000));
    let s = sin_of;
    let passes: [[[f64; 3]; 4]; 3] = [
        [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, c(roll), s(roll)], [0.0, -s(roll), c(roll)]],
        [[0.0, 0.0, 0.0], [c(pitch), 0.0, -s(pitch)], [0.0, 1.0, 0.0], [s(pitch), 0.0, c(pitch)]],
        [[0.0, 0.0, 0.0], [c(yaw), -s(yaw), 0.0], [s(yaw), c(yaw), 0.0], [0.0, 0.0, 1.0]],
    ];
    // Locomotion's dot3: one float32 store per component.
    fn dot(t: [Ext; 3], r: [f64; 3]) -> f64 {
        st(t[0].mul(ld(r[0])).add(t[1].mul(ld(r[1]))).add(t[2].mul(ld(r[2]))))
    }
    let mut fields = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for m in passes.iter() {
        let mut next = [[0.0f64; 3]; 4];
        for (i, v) in fields.iter().enumerate() {
            let t = if i == 0 {
                [sub(ld(v[0]), ld(m[0][0])), sub(ld(v[1]), ld(m[0][1])), sub(ld(v[2]), ld(m[0][2]))]
            } else {
                [ld(v[0]), ld(v[1]), ld(v[2])]
            };
            next[i] = [dot(t, m[1]), dot(t, m[2]), dot(t, m[3])];
        }
        fields = next;
    }
    fields
}

/// vectorToRotator (script-decoration-primitives.mjs), or None where it
/// throws (a nonfinite component).
fn vector_to_rotator(v: [f64; 3]) -> Option<[i32; 3]> {
    const SCALE: f64 = 10430.219195527361;
    let (x, y, z) = (f(v[0]), f(v[1]), f(v[2]));
    if !(is_finite_double(x) && is_finite_double(y) && is_finite_double(z)) {
        return None;
    }
    // Math.trunc(a * scale) | 0: the angles are within +-pi, so the
    // truncation toward zero is exact in i32.
    let yaw = unsafe { js_atan2(y, x) } * SCALE;
    let pitch = unsafe { js_atan2(z, sqrt(x * x + y * y)) } * SCALE;
    Some([pitch as i32, yaw as i32, 0])
}

/// The angular trapezoid (0x103c7360, script-pawn-perception.mjs).
fn trapezoid(delta: f64, halfwidth: f64, extent: f64) -> f64 {
    let mut d = f(delta);
    while d <= -180.0 {
        d = f(d + 360.0);
    }
    while d > 180.0 {
        d = f(d - 360.0);
    }
    let d = f64::from_bits(d.to_bits() & !(1u64 << 63));
    let plateau = st(sub(ld(halfwidth), ld(extent)).mul(crate::load_double(0.5)));
    let edge = st(ld(plateau).add(ld(extent)));
    if d <= plateau {
        return 1.0;
    }
    if d > edge {
        return 0.0;
    }
    st(sub(crate::load_double(1.0), sub(ld(d), ld(plateau)).div(ld(extent))))
}

/// appSqrt: the double argument, FSQRT, the double result. The JavaScript
/// model throws on a NaN operand; `Ext::sqrt` passes it through, and
/// app_atan's NaN then hands the call back, so JavaScript throws there. (The
/// angular-size gate already returns for every NaN operand: a NaN radius
/// makes the ratio NaN, and a NaN distance is replaced by 1.)
fn app_sqrt(v: Ext) -> Ext {
    v.store_double().sqrt().store_double()
}
/// appAtan: Math.atan of the double, loaded as a double; None where ld64
/// throws (a nonfinite result).
fn app_atan(v: Ext) -> Option<Ext> {
    let a = unsafe { js_atan(to_double(v)) };
    if !is_finite_double(a) {
        return None;
    }
    Some(crate::load_double(a))
}

// script-ai-visibility.mjs constants.
#[inline(always)]
fn zero() -> Ext {
    ld(0.0)
}
#[inline(always)]
fn one() -> Ext {
    ld(1.0)
}
#[inline(always)]
fn half() -> Ext {
    ld(0.5)
}
#[inline(always)]
fn quarter() -> Ext {
    ld(0.25)
}
/// clamp: below zero (or unordered) is zero, below one the value, else one.
fn clamp(v: Ext) -> Ext {
    if below(v, zero()) {
        zero()
    } else if below(v, one()) {
        v
    } else {
        one()
    }
}
/// The brightness/saturation scalar (0x1036bc50).
fn scalar(brightness: f64, saturation: f64) -> Ext {
    let s = ld((to_int32(saturation) & 255) as f64);
    let b = ld((to_int32(brightness) & 255) as f64);
    s.add(crate::load_double(127.5))
        .mul(crate::load_double(0.00261437908496732))
        .mul(b.mul(crate::load_double(0.00392156862745098)))
}
/// JavaScript truthiness of a read value (a bool as 0/1, a number as itself).
#[inline(always)]
fn truthy(v: f64) -> bool {
    v != 0.0 && v == v
}

/// A call the Rust body gives to JavaScript before any effect.
struct HandBack;

impl Run {
    // ---- Arguments ---------------------------------------------------------

    /// One argument's presence word; false for EX_Nothing.
    #[inline(always)]
    fn present(&mut self) -> bool {
        let p = self.op(0) != 0;
        self.skip(1);
        p
    }
    fn set_args(argc: u32, nothing: u32, values: [f64; 6]) {
        unsafe {
            let args = addr_of_mut!(P_ARGS) as *mut f64;
            *args = argc as f64;
            *args.add(1) = nothing as f64;
            for (i, v) in values.iter().enumerate() {
                *args.add(2 + i) = *v;
            }
        }
    }

    // ---- Objects and reads -------------------------------------------------

    /// Receiver info of a handle: SELF's cached one, else the receiver
    /// table's.
    fn info_of(&mut self, handle: u32) -> (u32, u32) {
        if handle == self.self_handle {
            let info = self.self_info();
            (info, self.self_bind)
        } else {
            receiver(handle)
        }
    }
    fn describe(&mut self, handle: u32) -> Obj {
        let (info, bind) = self.info_of(handle);
        let mut row = class_entry(handle);
        if row <= RELEASED {
            // js_class_row runs no script.
            row = unsafe { js_class_row(handle) };
        }
        if row == 0 {
            return Obj { handle, info, bind, row: 0, fields: 0, flags: 0 };
        }
        let at = row.wrapping_add(8).wrapping_add(load32(row.wrapping_add(4)).wrapping_mul(8));
        if load32(at.wrapping_add(4)) == 0 {
            // No script either: the host resolves the class's fields once.
            unsafe { js_class_fields(handle) };
        }
        let fields = if info & HOST != 0 { 0 } else { load32(at) };
        Obj { handle, info, bind, row, fields, flags: load32(at.wrapping_add(4)) }
    }
    /// soundServices' isA(actor, name): the row's name list, or JavaScript.
    fn obj_is_a(&mut self, o: &Obj, which: usize) -> bool {
        let name = unsafe { (*addr_of!(P_NAMES))[which] };
        if o.row != 0 {
            return row_has_name(o.row, name);
        }
        unsafe { js_is_a(self.frame, o.handle, name) != 0 }
    }
    /// A scalar field as the body's read returns it (a bool as 0/1).
    fn read(&mut self, o: &Obj, field: usize, site: u32) -> f64 {
        match o.addr(field) {
            Some(addr) => match KINDS[field] {
                K_BOOL => (load32(addr) & pfield(field)[1] != 0) as i32 as f64,
                K_INT => load32(addr) as i32 as f64,
                K_BYTE => load8(addr) as f64,
                _ => widen(load32(addr)),
            },
            None => unsafe { js_pread(self.frame, o.handle, field as u32, site) },
        }
    }
    /// A vector or rotator field as JavaScript numbers.
    fn read3(&mut self, o: &Obj, field: usize, site: u32) -> [f64; 3] {
        match o.addr(field) {
            Some(addr) => {
                let w = [load32(addr), load32(addr.wrapping_add(4)), load32(addr.wrapping_add(8))];
                if KINDS[field] == K_ROTATOR {
                    [w[0] as i32 as f64, w[1] as i32 as f64, w[2] as i32 as f64]
                } else {
                    [widen(w[0]), widen(w[1]), widen(w[2])]
                }
            }
            None => unsafe {
                js_pread3(self.frame, o.handle, field as u32, site);
                *addr_of!(P_IO)
            },
        }
    }
    /// writeNamed of a float field with a non-NaN float32 value.
    fn write(&mut self, o: &Obj, field: usize, value: f64) {
        match o.addr(field) {
            Some(addr) => store32(addr, (value as f32).to_bits()),
            None => unsafe { js_pwrite(self.frame, o.handle, field as u32, value) },
        }
    }

    // ---- ScriptedPawn alliances (script-pawn-alliance.mjs) -----------------

    /// pawnAllianceType(pawn, name) for the name's id; HandBack where a
    /// read is not in the image.
    fn alliance_type(&self, pawn: &Obj, wanted: u32) -> Result<i32, HandBack> {
        let mut result = NEUTRAL;
        if wanted != NAME_NONE {
            let base = pawn.addr(F_ALLIANCES).ok_or(HandBack)?;
            let [stride, name, level, agitation] = unsafe { *addr_of!(P_ALLIANCE) };
            for index in 0..16u32 {
                let entry = base.wrapping_add(index.wrapping_mul(stride));
                if name_word(entry.wrapping_add(name)) != wanted {
                    continue;
                }
                let level = widen(load32(entry.wrapping_add(level)));
                let agitation = widen(load32(entry.wrapping_add(agitation)));
                // FCOM's C0 includes unordered: a NaN alliance is hostile, a
                // NaN agitation does not cross the >= 1 gate.
                result = if !(level >= 0.0) || agitation >= 1.0 {
                    HOSTILE
                } else if level > 0.0 {
                    FRIENDLY
                } else {
                    NEUTRAL
                };
                break;
            }
        }
        let likes = pawn.addr(F_BLIKESNEUTRAL).ok_or(HandBack)?;
        if load32(likes) & pfield(F_BLIKESNEUTRAL)[1] != 0 && result == NEUTRAL {
            result = FRIENDLY;
        }
        let reverse = pawn.addr(F_BREVERSE).ok_or(HandBack)?;
        if load32(reverse) & pfield(F_BREVERSE)[1] != 0 {
            result = match result {
                FRIENDLY => HOSTILE,
                HOSTILE => FRIENDLY,
                _ => NEUTRAL,
            };
        }
        Ok(result)
    }
    /// pawnToPawnAllianceType(receiver, other) for a non-None other.
    fn pawn_to_pawn(&self, me: &Obj, other: &Obj) -> Result<i32, HandBack> {
        let reverse = if other.flags & H_SCRIPTED_PAWN != 0 {
            let wanted = name_word(me.addr(F_ALLIANCE).ok_or(HandBack)?);
            self.alliance_type(other, wanted)?
        } else {
            NEUTRAL
        };
        // The receiver query runs even if reverse hostility already decides it.
        let wanted = name_word(other.addr(F_ALLIANCE).ok_or(HandBack)?);
        let direct = self.alliance_type(me, wanted)?;
        Ok(if reverse == HOSTILE { HOSTILE } else { direct })
    }

    /// PAWN_ENEMY / PAWN_ALLIANCE: execPawnAlliance for 2105 and 2107. The
    /// result is 0/1 (2105) or the alliance type (2107).
    pub(crate) fn pawn_alliance(&mut self, r: Recv, enemy: bool) -> i32 {
        let (node, argc) = (self.op(1), self.op(2));
        self.skip(3);
        let mut nothing = 0u32;
        let other = if self.present() {
            self.object(SELF)
        } else {
            nothing |= 1;
            UNDEFINED
        };
        let mut optional = None;
        if argc > 1 {
            if self.present() {
                optional = Some(self.boolean(SELF));
            } else {
                nothing |= 2;
            }
        }
        let receiver = self.handle(r);
        Self::set_args(
            argc,
            nothing,
            [other as f64, optional.map_or(0.0, |v| v as i32 as f64), 0.0, 0.0, 0.0, 0.0],
        );
        let result = self.alliance_body(receiver, other, optional, enemy);
        match result {
            Ok(value) => {
                if check() {
                    unsafe { js_percep_verify(self.frame, node, receiver, value as f64) };
                }
                value
            }
            Err(HandBack) => {
                let value = unsafe { js_alliance(self.frame, node, receiver) };
                self.self_fresh = false;
                value
            }
        }
    }
    fn alliance_body(&mut self, receiver: u32, other: u32, optional: Option<bool>, enemy: bool) -> Result<i32, HandBack> {
        if !enemy {
            // 2107: `if (!other) return NEUTRAL`.
            if other == 0 || other == UNDEFINED {
                return Ok(NEUTRAL);
            }
            let o = self.describe(other);
            let me = self.describe(receiver);
            return self.pawn_to_pawn(&me, &o);
        }
        // 2105: `optional === undefined ? true : Boolean(optional)`.
        let check_alliance = optional.unwrap_or(true);
        if other == 0 || other == UNDEFINED || other == receiver {
            return Ok(0);
        }
        let o = self.describe(other);
        let deleted = o.addr(F_BDELETEME).ok_or(HandBack)?;
        let detectable = o.addr(F_BDETECTABLE).ok_or(HandBack)?;
        let health = o.addr(F_HEALTH).ok_or(HandBack)?;
        if load32(deleted) & pfield(F_BDELETEME)[1] != 0
            || load32(detectable) & pfield(F_BDETECTABLE)[1] == 0
            || load32(health) as i32 <= 0
        {
            return Ok(0);
        }
        if !check_alliance {
            return Ok(1);
        }
        let me = self.describe(receiver);
        Ok((self.pawn_to_pawn(&me, &o)? == HOSTILE) as i32)
    }

    // ---- AICanSee (script-pawn-perception.mjs execAICanSee) ----------------

    /// AI_CAN_SEE: the float result.
    pub(crate) fn ai_can_see(&mut self, r: Recv) -> f64 {
        let (node, argc) = (self.op(1), self.op(2));
        self.skip(3);
        // args(call): every argument, in order, before the body.
        let mut values = [0.0f64; 6];
        let mut nothing = 0u32;
        for i in 0..argc.min(6) as usize {
            if !self.present() {
                nothing |= 1 << i;
                values[i] = f64::from_bits(UNDEF_F64_BITS);
                continue;
            }
            values[i] = match i {
                0 => self.object(SELF) as f64,
                1 => self.float(SELF),
                _ => self.boolean(SELF) as i32 as f64,
            };
        }
        let receiver = self.handle(r);
        Self::set_args(argc, nothing, values);
        let other = if nothing & 1 != 0 { UNDEFINED } else { values[0] as u32 };
        // `if (!other) return 0` (nothing has been read).
        if other == 0 || other == UNDEFINED {
            return 0.0;
        }
        if check() {
            unsafe { js_percep_begin(self.frame, node, receiver) };
        }
        let flag = |i: u32, default: bool| if argc > i { nothing & (1 << i) == 0 && values[i as usize] != 0.0 } else { default };
        // Number(undefined) is NaN (UNDEF_F64 is a NaN).
        let visibility = if argc > 1 { values[1] } else { 1.0 };
        let checks = [flag(2, true), flag(3, true), flag(4, false), flag(5, true)];
        match self.ai_can_see_body(receiver, other, visibility, checks) {
            Ok(value) => {
                if check() {
                    unsafe { js_percep_verify(self.frame, node, receiver, value) };
                }
                value
            }
            Err(HandBack) => {
                let value = unsafe { js_aicansee(self.frame, node, receiver) };
                self.self_fresh = false;
                value
            }
        }
    }

    fn ai_can_see_body(&mut self, receiver: u32, other: u32, visibility: f64, checks: [bool; 4]) -> Result<f64, HandBack> {
        let [check_visibility, check_dir, check_cylinder, check_los] = checks;
        // services.level(viewer) is a pure lookup; the traces make it again.
        if !(visibility > 0.0) {
            return Ok(0.0);
        }
        let viewer = self.describe(receiver);
        let o = self.describe(other);
        if !truthy_strict(self.read(&o, F_BDETECTABLE, SITE_PERCEP)) {
            return Ok(0.0);
        }
        let v_loc = self.read3(&viewer, F_LOCATION, SITE_PERCEP);
        let o_loc = self.read3(&o, F_LOCATION, SITE_PERCEP);
        let base_eye = self.read(&viewer, F_BASEEYE, SITE_PERCEP);
        let eye = [v_loc[0], v_loc[1], f(v_loc[2] + base_eye)];
        let delta = [f(o_loc[0] - eye[0]), f(o_loc[1] - eye[1]), f(o_loc[2] - eye[2])];
        let mut dist_sq = st(magsq3(delta));
        if !(dist_sq >= 1.0) {
            dist_sq = 1.0;
        }
        let cr = self.read(&o, F_CRADIUS, SITE_PERCEP);
        let ch = self.read(&o, F_CHEIGHT, SITE_PERCEP);
        let cr2 = ld(cr).mul(ld(cr));
        let ch2 = ld(ch).mul(ld(ch));
        let ratio = st(cr2.add(ch2).div(ld(dist_sq)));
        if !(ratio > self.read(&viewer, F_MINANG, SITE_PERCEP)) {
            return Ok(0.0);
        }
        let cyl = check_cylinder && ratio >= 0.0003046792916483;
        let mut acc = st(ld(visibility).mul(ld(ratio)).mul(ld(64.0)));

        if check_dir && acc > 0.0 {
            let aspect = self.read(&viewer, F_ASPECT, SITE_PERCEP);
            let half_fov_v = if aspect > 0.0 {
                st(ld(self.read(&viewer, F_HFOV, SITE_PERCEP)).div(ld(aspect)))
            } else {
                0.0
            };
            let degrees = crate::load_double(114.59155902616465);
            let h_ext = st(app_atan(app_sqrt(cr2.div(ld(dist_sq)))).ok_or(HandBack)?.mul(degrees));
            let v_ext = st(app_atan(app_sqrt(ch2.div(ld(dist_sq)))).ok_or(HandBack)?.mul(degrees));
            let is_player = self.obj_is_a(&viewer, 0);
            let base = self.read3(&viewer, if is_player { F_VIEWROT } else { F_ROTATION }, SITE_PERCEP);
            let add = self.read3(&viewer, F_ADDVIEWROT, SITE_PERCEP);
            // viewRot = f32(base + add), then fcoordsAxes' `v | 0`.
            let view_rot = [to_int32(f(base[0] + add[0])), to_int32(f(base[1] + add[1])), to_int32(f(base[2] + add[2]))];
            let axes = fcoords_axes(view_rot);
            let dir_view = [st(dot3(axes[1], delta)), st(dot3(axes[2], delta)), st(dot3(axes[3], delta))];
            let rot = vector_to_rotator(dir_view).ok_or(HandBack)?;
            let unit = ld(1.52587890625e-05);
            let yaw_deg = st(ld(rot[1] as f64 * 360.0).mul(unit));
            let pitch_deg = st(ld(rot[0] as f64 * 360.0).mul(unit));
            let yaw_trap = trapezoid(yaw_deg, self.read(&viewer, F_HFOV, SITE_PERCEP), h_ext);
            let mut pitch_trap = trapezoid(pitch_deg, half_fov_v, v_ext);
            // Near-target pitch floor (0x103c6e38).
            if dist_sq < 22500.0 && pitch_trap < 0.75 {
                pitch_trap = 0.75;
            }
            acc = st(ld(acc).mul(ld(yaw_trap)));
            acc = st(ld(acc).mul(ld(pitch_trap)));
        }

        if check_visibility && acc > 0.0 {
            // FST retains ST0 at 103c6e8a: the extended visibility times acc.
            acc = st(self.ai_visibility(&o)?.mul(ld(acc)));
        }

        // From here on nothing is handed back: the visibility cache may have
        // been written.
        let threshold = self.read(&viewer, F_VISTHRESH, SITE_PERCEP);
        acc = st(sub(ld(acc), ld(threshold)));
        if !(acc >= 0.0) {
            acc = 0.0;
        } else if !(acc < 1.0) {
            acc = 1.0;
        }
        if check_los && acc > 0.0 && !self.line_of_sight(&viewer, &o, cyl, o_loc, eye, delta) {
            acc = 0.0;
        }
        Ok(acc)
    }

    /// actorVisibilityExtended(actor, 1) (AIVisibility 0x1036bca0): the
    /// retained x87 value. HandBack only before its first write.
    fn ai_visibility(&mut self, o: &Obj) -> Result<Ext, HandBack> {
        // Level, Actors[0] as LevelInfo (the import throws the body's error),
        // or 0 when a host lighting seam is set.
        let info_handle = unsafe { js_vis_info(self.frame, o.handle) };
        if info_handle == 0 {
            return Err(HandBack);
        }
        let info = self.describe(info_handle);
        let time_value = self.read(&info, F_TIMESECONDS, SITE_AIVIS);
        // A NaN clock would reach VisUpdateTime's store with V8's NaN bits.
        if time_value != time_value {
            return Err(HandBack);
        }
        let time = ld(time_value);
        let elapsed = st(sub(time, ld(self.read(o, F_VISUPDATE, SITE_AIVIS))));
        let mut base;
        if below(half(), ld(elapsed)) {
            self.write(o, F_VISUPDATE, st(time));
            let location = self.read3(o, F_LOCATION, SITE_AIVIS);
            let value = st(self.light_level(o, location));
            self.write(o, F_CURVIS, value);
            self.write(o, F_LASTVIS, value);
            base = ld(value);
        } else {
            let (lt, eq) = fcom(ld(elapsed), quarter());
            if !lt && !eq {
                let current = self.read(o, F_CURVIS, SITE_AIVIS);
                if current != current {
                    return Err(HandBack);
                }
                self.write(o, F_LASTVIS, current);
                self.write(o, F_VISUPDATE, st(time));
                let location = self.read3(o, F_LOCATION, SITE_AIVIS);
                let value = st(self.light_level(o, location));
                base = ld(self.read(o, F_LASTVIS, SITE_AIVIS));
                self.write(o, F_CURVIS, value);
            } else {
                let last = ld(self.read(o, F_LASTVIS, SITE_AIVIS));
                let current = ld(self.read(o, F_CURVIS, SITE_AIVIS));
                base = sub(current, last).mul(ld(elapsed).div(quarter())).add(last);
            }
        }
        // includeVelocity.
        let stored = Ext::load(base.store());
        let velocity = self.read3(o, F_VELOCITY, SITE_AIVIS);
        let squared = magsq3(velocity).store_double();
        let speed = if squared.nan() { squared } else { squared.sqrt() };
        let ratio = clamp(sub(speed, ld(30.0)).div(ld(170.0)));
        base = ratio.mul(stored).mul(half()).add(stored);
        Ok(clamp(base))
    }

    /// actorLightLevelExtended(actor, point) (AIGetLightLevel 0x1036b980).
    fn light_level(&mut self, o: &Obj, point: [f64; 3]) -> Ext {
        let point = [f(point[0]), f(point[1]), f(point[2])];
        // Region.Zone and the level; the import throws the body's error for
        // a missing zone.
        let zone_handle = unsafe { js_zone(self.frame, o.handle) };
        let zone = self.describe(zone_handle);
        let mut sum = 0.0f64;
        if truthy(self.read(o, F_BUNLIT, SITE_AIVIS)) {
            sum = 1.0;
        } else {
            let actors = unsafe { js_level_actors(self.frame, o.handle) };
            let count = load32(actors);
            for i in 0..count {
                let entry = actors.wrapping_add(4).wrapping_add(i.wrapping_mul(8));
                let handle = load32(entry);
                if handle == 0 {
                    continue;
                }
                let light = self.describe_known(handle, load32(entry.wrapping_add(4)));
                if to_int32(self.read(&light, F_LIGHTTYPE, SITE_AIVIS)) & 255 == 0
                    || to_int32(self.read(&light, F_LIGHTBRIGHT, SITE_AIVIS)) & 255 == 0
                    || handle == o.handle
                {
                    continue;
                }
                let radius = ld(((to_int32(self.read(&light, F_LIGHTRADIUS, SITE_AIVIS)) & 255) + 1) as f64).mul(ld(25.0));
                let radius_sq = st(radius.mul(radius));
                let start = self.read3(&light, F_LOCATION, SITE_AIVIS);
                let d = [sub(ld(point[0]), ld(start[0])), sub(ld(point[1]), ld(start[1])), sub(ld(point[2]), ld(start[2]))];
                let distance_sq = st(d[0].mul(d[0]).add(d[1].mul(d[1])).add(d[2].mul(d[2])));
                let (lt, eq) = fcom(ld(radius_sq), ld(distance_sq));
                if lt || eq {
                    continue;
                }
                if truthy(self.read(&light, F_BSTATIC, SITE_AIVIS))
                    && unsafe {
                        js_light_trace(self.frame, o.handle, point[0], point[1], point[2], start[0], start[1], start[2])
                    } == 0
                {
                    continue;
                }
                let root = ld(distance_sq).div(ld(radius_sq)).store_double().sqrt().store_double();
                let attenuation = st(sub(one(), root));
                let brightness = self.read(&light, F_LIGHTBRIGHT, SITE_AIVIS);
                let saturation = self.read(&light, F_LIGHTSAT, SITE_AIVIS);
                sum = st(scalar(brightness, saturation).mul(ld(attenuation)).add(ld(sum)));
            }
            sum = st(ld(sum).mul(half()));
        }
        let ambient = scalar(self.read(&zone, F_AMBBRIGHT, SITE_AIVIS), self.read(&zone, F_AMBSAT, SITE_AIVIS));
        clamp(ambient.add(ambient).add(ld(sum)))
    }
    /// describe() with the receiver info the scan's import computed.
    fn describe_known(&mut self, handle: u32, info: u32) -> Obj {
        let mut row = class_entry(handle);
        if row <= RELEASED {
            row = unsafe { js_class_row(handle) };
        }
        if row == 0 {
            return Obj { handle, info, bind: 0, row: 0, fields: 0, flags: 0 };
        }
        let at = row.wrapping_add(8).wrapping_add(load32(row.wrapping_add(4)).wrapping_mul(8));
        if load32(at.wrapping_add(4)) == 0 {
            unsafe { js_class_fields(handle) };
        }
        let fields = if info & HOST != 0 { 0 } else { load32(at) };
        Obj { handle, info, bind: 0, row, fields, flags: load32(at.wrapping_add(4)) }
    }

    /// losCheckAICanSee: SingleLineCheck traces from the eye.
    fn line_of_sight(&mut self, viewer: &Obj, o: &Obj, cyl: bool, o_loc: [f64; 3], eye: [f64; 3], delta: [f64; 3]) -> bool {
        let is_player = self.obj_is_a(o, 0);
        let cr = self.read(o, F_CRADIUS, SITE_PERCEP);
        let ch = self.read(o, F_CHEIGHT, SITE_PERCEP);
        let (vh, oh) = (viewer.handle, o.handle);
        let frame = self.frame;
        let sl = |end: [f64; 3]| unsafe { js_los_trace(frame, vh, oh, end[0], end[1], end[2], eye[0], eye[1], eye[2]) != 0 };
        if !cyl {
            return sl(o_loc);
        }
        if is_player {
            let eye_height = self.read(o, F_BASEEYE, SITE_PERCEP);
            return sl([o_loc[0], o_loc[1], f(o_loc[2] + eye_height)])
                || sl([o_loc[0], o_loc[1], f(o_loc[2] + ch)])
                || sl([o_loc[0], o_loc[1], f(o_loc[2] - ch)]);
        }
        if sl([o_loc[0], o_loc[1], f(o_loc[2] + ch)]) || sl([o_loc[0], o_loc[1], f(o_loc[2] - ch)]) {
            return true;
        }
        let dir = crate::safe_normal([(delta[0] as f32).to_bits(), (delta[1] as f32).to_bits(), 0]);
        let (d0, d1) = (widen(dir[0]), widen(dir[1]));
        let px = f(d1 * cr);
        let py = f(-d0 * cr);
        sl([f(o_loc[0] + px), f(o_loc[1] + py), o_loc[2]]) || sl([f(o_loc[0] - px), f(o_loc[1] - py), o_loc[2]])
    }
}

/// `truthy` of script-pawn-perception.mjs: true or a nonzero number (NaN
/// included).
#[inline(always)]
fn truthy_strict(v: f64) -> bool {
    v != 0.0
}
