//! The pawn locomotion latent polls in the interpreter (docs/rust-core.md
//! "October 1: latent polls"): MoveTo 501, MoveToward 503, TurnTo 509,
//! TurnToward 511 and WaitForLanding 528 of
//! src/runtime/script-pawn-locomotion.mjs, with the helpers they reach
//! (turnSetup980, steerArrive200). Each body is transcribed step for step:
//! the same reads, writes and x87 model operations (`Ext`, with the
//! JavaScript model's operand order) and vectorToRotator's Math.atan2
//! (imported, percep.rs).
//!
//! A poll runs here only when it completes without JavaScript: every field
//! it reads or writes is in the image (the pawn's and its target's class
//! rows say the spelling resolves to the key and cell L_FIELDS describes,
//! the receiver is not HOST and the key not bound), every float it reads is
//! finite, and no branch it takes needs a service the Rust body does not
//! have. Those branches hand the poll back (`Poll::Js`) before its first
//! write, decided from reads alone:
//! * Physics PHYS_Falling (steerArrive's air control reads the zone) and
//!   PHYS_Spider (turnSetup returns early; MoveToward offsets along Floor);
//! * the bAdvancedTactics walking SpawnNotification lookup;
//! * an Inventory MoveTarget close enough for steerArrive's Touch event;
//! * MoveToward with a Pawn target (it reads the target's zone);
//! * WaitForLanding's LongFall event;
//! * a float read that is not finite or not below 2^60 in magnitude, or a
//!   facing direction (destination minus Location) that is not (the
//!   JavaScript model throws where an intermediate becomes infinite).

use crate::interp::{class_entry, js_class_row, live, load32, load8, receiver, row_has_name, store32, bound_key, BOUND, HOST, RELEASED};
use crate::x87::Ext;
use core::ptr::{addr_of, addr_of_mut};

// Field indices (script-vm-locomotion.mjs LOCO_FIELDS).
const L_PHYSICS: usize = 0;
const L_LOCATION: usize = 1;
const L_VELOCITY: usize = 2;
const L_ACCELERATION: usize = 3;
const L_ROTATION: usize = 4;
const L_DESIREDROTATION: usize = 5;
const L_DESTINATION: usize = 6;
const L_FOCUS: usize = 7;
const L_MOVETIMER: usize = 8;
const L_DESIREDSPEED: usize = 9;
const L_ACCELRATE: usize = 10;
const L_AVGPHYSICSTIME: usize = 11;
const L_CRADIUS: usize = 12;
const L_CHEIGHT: usize = 13;
const L_MELEERANGE: usize = 14;
const L_MOVETARGET: usize = 15;
const L_FACETARGET: usize = 16;
const L_BCANSTRAFE: usize = 17;
const L_BREDUCEDSPEED: usize = 18;
const L_BADVANCEDTACTICS: usize = 19;
const L_BCANGLIDE: usize = 20;
const L_LATENTFLOAT: usize = 21;
const FIELD_COUNT: usize = 22;

/// The fields each poll may read or write on the pawn.
const PAWN_FIELDS: u32 = (1 << FIELD_COUNT) - 1;
/// The fields read on a MoveTarget or FaceTarget.
const TARGET_FIELDS: u32 = 1 << L_LOCATION | 1 << L_CRADIUS | 1 << L_CHEIGHT;

/// L_FIELDS: per field [offset, bool mask, key id], written by the host.
static mut L_FIELDS: [[u32; 3]; FIELD_COUNT] = [[0; 3]; FIELD_COUNT];
/// L_NAMES: the folded name ids of `pawn` and `inventory` (row name lists),
/// then whether the table is complete (the polls run here only then).
static mut L_NAMES: [u32; 3] = [0; 3];

#[no_mangle]
pub extern "C" fn loco_fields_ptr() -> *mut u32 {
    addr_of_mut!(L_FIELDS) as *mut u32
}
#[no_mangle]
pub extern "C" fn loco_names_ptr() -> *mut u32 {
    addr_of_mut!(L_NAMES) as *mut u32
}

#[link(wasm_import_module = "env")]
extern "C" {
    /// Fill the locomotion word of `handle`'s class row (no script runs).
    fn js_loco_class(handle: u32);
    fn js_atan2(y: f64, x: f64) -> f64;
}

/// The class row's locomotion word: bit i for field i, and COMPUTED.
const COMPUTED: u32 = 1 << 31;

fn lfield(field: usize) -> [u32; 3] {
    unsafe { (*addr_of!(L_FIELDS))[field] }
}

/// A poll's outcome.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Poll {
    /// The latent action stays.
    Wait,
    /// The poll cleared the latent action.
    Done,
    /// JavaScript runs the poll; nothing was written.
    Js,
}

/// An object a poll reads: its receiver info, binding set, class row and
/// the row's locomotion word (0 for a HOST object or an undescribed one).
#[derive(Clone, Copy)]
struct Obj {
    info: u32,
    bind: u32,
    row: u32,
    fields: u32,
}

impl Obj {
    fn of(handle: u32) -> Obj {
        let (info, bind) = receiver(handle);
        let mut row = class_entry(handle);
        if row <= RELEASED {
            row = unsafe { js_class_row(handle) };
        }
        if row == 0 || info & HOST != 0 {
            return Obj { info, bind, row, fields: 0 };
        }
        // After the row's names and its two perception words.
        let at = row.wrapping_add(8).wrapping_add(load32(row.wrapping_add(4)).wrapping_mul(8)).wrapping_add(8);
        if load32(at) & COMPUTED == 0 {
            unsafe { js_loco_class(handle) };
        }
        Obj { info, bind, row, fields: load32(at) }
    }
    /// Whether every field of `set` is read in the image.
    fn has(&self, set: u32) -> bool {
        if self.fields & set != set {
            return false;
        }
        if self.info & BOUND != 0 {
            for i in 0..FIELD_COUNT {
                if set & (1 << i) != 0 && bound_key(self.bind, lfield(i)[2]) {
                    return false;
                }
            }
        }
        true
    }
    #[inline(always)]
    fn at(&self, field: usize) -> u32 {
        (self.info & !15).wrapping_add(lfield(field)[0])
    }
    fn is_a(&self, which: usize) -> bool {
        row_has_name(self.row, unsafe { (*addr_of!(L_NAMES))[which] })
    }
    fn byte(&self, field: usize) -> u32 {
        load8(self.at(field)) as u32
    }
    fn word(&self, field: usize) -> u32 {
        load32(self.at(field))
    }
    fn set_word(&self, field: usize, v: u32) {
        store32(self.at(field), v)
    }
    fn vec(&self, field: usize) -> [u32; 3] {
        let a = self.at(field);
        [load32(a), load32(a.wrapping_add(4)), load32(a.wrapping_add(8))]
    }
    fn set_vec(&self, field: usize, v: [u32; 3]) {
        let a = self.at(field);
        store32(a, v[0]);
        store32(a.wrapping_add(4), v[1]);
        store32(a.wrapping_add(8), v[2]);
    }
    fn flag(&self, field: usize) -> bool {
        load32(self.at(field)) & lfield(field)[1] != 0
    }
    fn set_flag(&self, field: usize, v: bool) {
        let (a, mask) = (self.at(field), lfield(field)[1]);
        let w = load32(a);
        store32(a, if v { w | mask } else { w & !mask });
    }
}

const PAWN: usize = 0;
const INVENTORY: usize = 1;

// ---- The JavaScript model's helpers (script-pawn-locomotion.mjs) ----------

#[inline(always)]
fn ld(bits: u32) -> Ext {
    Ext::load(bits)
}
#[inline(always)]
fn sub(a: Ext, b: Ext) -> Ext {
    a.add(b.neg())
}
#[inline(always)]
fn sub32(a: u32, b: u32) -> u32 {
    sub(ld(a), ld(b)).store()
}
#[inline(always)]
fn lt_u(a: Ext, b: Ext) -> bool {
    a.compare(b).0
}
#[inline(always)]
fn le_u(a: Ext, b: Ext) -> bool {
    let (c0, c3) = a.compare(b);
    c0 || c3
}
/// appSqrt through the double thunk: FSTP qword, FSQRT, FSTP dword.
#[inline(always)]
fn app_sqrt32(sum: Ext) -> u32 {
    sum.store_double().sqrt().store()
}
#[inline(always)]
fn int(v: f64) -> Ext {
    Ext::load((v as f32).to_bits())
}
/// A finite float below 2^60 in magnitude: every intermediate of the
/// bodies stays finite (the JavaScript model throws on some infinities).
fn finite(bits: u32) -> bool {
    (bits >> 23) & 0xff < 127 + 60
}
fn finite3(v: [u32; 3]) -> bool {
    finite(v[0]) && finite(v[1]) && finite(v[2])
}
fn f32num(bits: u32) -> f64 {
    f32::from_bits(bits) as f64
}

/// The pawn's state a poll needs before it decides: its object, Physics and
/// whether it glides.
struct Pawn {
    o: Obj,
    physics: u32,
}

impl Pawn {
    fn gliding(&self) -> bool {
        self.o.flag(L_BCANGLIDE) && !self.o.flag(L_BCANSTRAFE) && (self.physics == 4 || self.physics == 3)
    }
    /// The float fields every poll reads, finite.
    fn finite_inputs(&self) -> bool {
        let o = &self.o;
        finite3(o.vec(L_LOCATION)) && finite3(o.vec(L_VELOCITY)) && finite3(o.vec(L_ACCELERATION))
            && finite3(o.vec(L_DESTINATION)) && finite3(o.vec(L_FOCUS))
            && [L_MOVETIMER, L_DESIREDSPEED, L_ACCELRATE, L_AVGPHYSICSTIME, L_CRADIUS, L_CHEIGHT, L_MELEERANGE, L_LATENTFLOAT]
                .iter()
                .all(|&f| finite(o.word(f)))
    }
}

/// The pawn, when every poll field is in the image and finite, it is not
/// spider or falling and takes no tactics branch.
fn pawn(handle: u32) -> Option<Pawn> {
    if unsafe { (*addr_of!(L_NAMES))[2] } == 0 {
        return None;
    }
    let o = Obj::of(handle);
    if o.row == 0 || !o.has(PAWN_FIELDS) {
        return None;
    }
    let p = Pawn { o, physics: o.byte(L_PHYSICS) };
    if p.physics == 0xa || p.physics == 2 || !p.finite_inputs() {
        return None;
    }
    // tacticsEvent's FindFunction runs in JavaScript.
    if p.o.flag(L_BADVANCEDTACTICS) && p.physics == 1 {
        return None;
    }
    Some(p)
}

/// A target's object when the poll's reads of it are in the image and
/// finite.
fn target(handle: u32) -> Option<Obj> {
    let o = Obj::of(handle);
    if o.row == 0 || !o.has(TARGET_FIELDS) {
        return None;
    }
    if !finite3(o.vec(L_LOCATION)) || !finite(o.word(L_CRADIUS)) || !finite(o.word(L_CHEIGHT)) {
        return None;
    }
    Some(o)
}

/// vectorToRotator (script-decoration-primitives.mjs) of finite floats.
fn vector_to_rotator(v: [u32; 3]) -> [i32; 3] {
    const SCALE: f64 = 10430.219195527361;
    let (x, y, z) = (f32num(v[0]), f32num(v[1]), f32num(v[2]));
    let yaw = unsafe { js_atan2(y, x) } * SCALE;
    let pitch = unsafe { js_atan2(z, crate::trace::sqrt(x * x + y * y)) } * SCALE;
    [pitch as i32, yaw as i32, 0]
}

/// FCoords(Rotation)'s X axis as float32 words (fcoordsAxes(...)[1]).
fn x_axis(p: &Pawn) -> [u32; 3] {
    let r = p.o.vec(L_ROTATION);
    let x = crate::percep::fcoords_axes([r[0] as i32, r[1] as i32, r[2] as i32])[1];
    [(x[0] as f32).to_bits(), (x[1] as f32).to_bits(), (x[2] as f32).to_bits()]
}

/// glideAcceleration: Acceleration = X axis * AccelRate.
fn glide_acceleration(p: &Pawn) {
    let ar = ld(p.o.word(L_ACCELRATE));
    let x = x_axis(p);
    p.o.set_vec(L_ACCELERATION, [ld(x[0]).mul(ar).store(), ld(x[1]).mul(ar).store(), ld(x[2]).mul(ar).store()]);
}

/// Whether turnSetup980's direction toward `dest` is finite and small.
fn facing_ok(p: &Pawn, dest: [u32; 3]) -> bool {
    let loc = p.o.vec(L_LOCATION);
    finite3(dest) && (0..3).all(|i| finite(sub32(dest[i], loc[i])))
}

/// Helper 0x103be980, turnSetup980: DesiredRotation toward `dest`; whether
/// the pawn faces it. Not PHYS_Spider (`pawn` hands that back).
fn turn_setup(p: &Pawn, dest: [u32; 3]) -> bool {
    let o = &p.o;
    let loc = o.vec(L_LOCATION);
    let d = [sub32(dest[0], loc[0]), sub32(dest[1], loc[1]), sub32(dest[2], loc[2])];
    let rot = vector_to_rotator(d);
    let yaw = rot[1] & 0xffff;
    let mut desired = [rot[0], yaw, rot[2]];
    if p.physics == 1 {
        let t = live(o.word(L_MOVETARGET));
        if !(t != 0 && Obj::of(t).is_a(PAWN)) {
            desired = [0, yaw, rot[2]];
        }
    }
    o.set_vec(L_DESIREDROTATION, [desired[0] as u32, desired[1] as u32, desired[2] as u32]);
    let dyaw = yaw.wrapping_sub(o.vec(L_ROTATION)[1] as i32 & 0xffff);
    let a = dyaw.wrapping_abs();
    a < 0x7d0 || a > 0xf82f
}

/// Whether steerArrive200's Inventory branch would fire Touch on `target`.
fn would_touch(p: &Pawn, t: &Obj) -> bool {
    let (loc, tl) = (p.o.vec(L_LOCATION), t.vec(L_LOCATION));
    let mut dz = sub(ld(loc[2]), ld(tl[2]));
    if lt_u(dz, Ext::zero(0)) {
        dz = dz.neg();
    }
    if !lt_u(dz, ld(p.o.word(L_CHEIGHT))) {
        return false;
    }
    let dx = sub(ld(loc[0]), ld(tl[0]));
    let dy = sub(ld(loc[1]), ld(tl[1]));
    let cr = ld(p.o.word(L_CRADIUS));
    let d2 = dy.mul(dy).add(dx.mul(dx));
    !le_u(cr.mul(cr), d2)
}

/// The MoveTarget's object for steerArrive200, or Err when the poll must be
/// handed back (a target outside the image, or a Touch it would fire).
fn steer_target(p: &Pawn) -> Result<Option<Obj>, ()> {
    let t = live(p.o.word(L_MOVETARGET));
    if t == 0 {
        return Ok(None);
    }
    let o = target(t).ok_or(())?;
    if o.is_a(INVENTORY) && would_touch(p, &o) {
        return Err(());
    }
    Ok(Some(o))
}

/// Helper 0x103be200, steerArrive200, for a pawn that is not falling, with
/// its MoveTarget checked by `steer_target`: whether it arrived.
fn steer_arrive(p: &Pawn, target: Option<Obj>, dest: [u32; 3]) -> bool {
    let o = &p.o;
    let glide = p.gliding();
    let loc = o.vec(L_LOCATION);
    let mut d = [sub32(dest[0], loc[0]), sub32(dest[1], loc[1]), sub32(dest[2], loc[2])];
    if p.physics == 1 {
        d[2] = 0;
    }
    let dl = [ld(d[0]), ld(d[1]), ld(d[2])];
    let dist = app_sqrt32(dl[1].mul(dl[1]).add(dl[0].mul(dl[0])).add(dl[2].mul(dl[2])));
    let zero = Ext::zero(0);
    if lt_u(dl[1].mul(dl[1]).add(dl[0].mul(dl[0])), int(256.0)) {
        let mut az = dl[2];
        if lt_u(az, zero) {
            az = az.neg();
        }
        let ch = ld(o.word(L_CHEIGHT));
        let bound = if lt_u(int(48.0), ch) { ch } else { int(48.0) };
        if lt_u(az, bound) {
            if !glide {
                o.set_vec(L_ACCELERATION, [0, 0, 0]);
            }
            return true;
        }
    }
    if glide {
        d = x_axis(p);
    } else if !le_u(ld(dist), zero) {
        let s80 = ld(dist).recip();
        let s32 = s80.store();
        d = [ld(s32).mul(dl[0]).store(), ld(s32).mul(dl[1]).store(), s80.mul(dl[2]).store()];
    }
    let ar = ld(o.word(L_ACCELRATE));
    o.set_vec(L_ACCELERATION, [ar.mul(ld(d[0])).store(), ar.mul(ld(d[1])).store(), ar.mul(ld(d[2])).store()]);
    if lt_u(ld(o.word(L_MOVETIMER)), zero.store_double()) {
        return true;
    }
    if let Some(t) = target {
        if t.is_a(PAWN) {
            let bound = ld(t.word(L_CRADIUS))
                .add(ld(o.word(L_CRADIUS)))
                .add(ld(o.word(L_MELEERANGE)).mul(Ext::load_f64(0.8)));
            return !le_u(bound, ld(dist));
        }
    }
    let v = o.vec(L_VELOCITY);
    let speed = app_sqrt32(ld(v[0]).mul(ld(v[0])).add(ld(v[1]).mul(ld(v[1]))).add(ld(v[2]).mul(ld(v[2]))));
    if !glide && !le_u(ld(speed), int(100.0)) {
        let s80 = ld(speed).recip();
        let svx = s80.mul(ld(v[0])).store();
        let svy = s80.mul(ld(v[1])).store();
        let svz80 = s80.mul(ld(v[2]));
        let rx = sub(ld(svx), ld(d[0])).store();
        let ry = sub(ld(svy), ld(d[1])).store();
        let rz = sub(svz80, ld(d[2])).store();
        let dot = ld(svx).mul(ld(d[0])).add(svz80.mul(ld(d[2])).add(ld(svy).mul(ld(d[1]))));
        let scale = sub(Ext::load_f64(1.0), dot).mul(ld(speed)).mul(Ext::load_f64(0.2));
        d = [ld(rx).mul(scale).store(), ld(ry).mul(scale).store(), rz];
        let a = o.vec(L_ACCELERATION);
        o.set_vec(
            L_ACCELERATION,
            [sub(ld(a[0]), ld(d[0])).store(), sub(ld(a[1]), ld(d[1])).store(), sub(ld(a[2]), scale.mul(ld(rz))).store()],
        );
    }
    if le_u(ld(o.word(L_AVGPHYSICSTIME)).mul(ld(speed)).mul(Ext::load_f64(1.4)), ld(dist)) {
        return false;
    }
    if !o.flag(L_BREDUCEDSPEED) {
        o.set_flag(L_BREDUCEDSPEED, true);
        o.set_word(L_DESIREDSPEED, ld(o.word(L_DESIREDSPEED)).mul(Ext::load_f64(0.5)).store());
    }
    if !le_u(ld(speed), zero) {
        let cap = int(200.0).div(ld(speed));
        if !le_u(ld(o.word(L_DESIREDSPEED)), cap) {
            o.set_word(L_DESIREDSPEED, cap.store());
        }
    }
    glide
}

/// Engine 0x103bd060, pollMoveTo.
fn poll_move_to(p: &Pawn) -> Poll {
    let target = match steer_target(p) {
        Ok(t) => t,
        Err(()) => return Poll::Js,
    };
    let dest = p.o.vec(L_DESTINATION);
    if !facing_ok(p, dest) {
        return Poll::Js;
    }
    turn_setup(p, dest);
    let done = steer_arrive(p, target, dest);
    p.o.set_vec(L_DESTINATION, dest);
    if done { Poll::Done } else { Poll::Wait }
}

/// Engine 0x103bd370, pollMoveToward, for a target that is not a Pawn.
fn poll_move_toward(p: &Pawn) -> Poll {
    let t = live(p.o.word(L_MOVETARGET));
    if t == 0 {
        return Poll::Done;
    }
    let target = match steer_target(p) {
        Ok(Some(o)) if !o.is_a(PAWN) => o,
        _ => return Poll::Js,
    };
    let dest = target.vec(L_LOCATION);
    if !facing_ok(p, dest) {
        return Poll::Js;
    }
    p.o.set_vec(L_DESTINATION, dest);
    p.o.set_vec(L_FOCUS, dest);
    turn_setup(p, dest);
    let done = steer_arrive(p, Some(target), dest);
    p.o.set_vec(L_DESTINATION, target.vec(L_LOCATION));
    if done { Poll::Done } else { Poll::Wait }
}

/// Engine 0x103be020, pollTurnTo.
fn poll_turn_to(p: &Pawn) -> Poll {
    let focus = p.o.vec(L_FOCUS);
    if !facing_ok(p, focus) {
        return Poll::Js;
    }
    if p.gliding() {
        glide_acceleration(p);
    }
    if turn_setup(p, focus) { Poll::Done } else { Poll::Wait }
}

/// Engine 0x103bdd60, pollTurnToward.
fn poll_turn_toward(p: &Pawn) -> Poll {
    let t = live(p.o.word(L_FACETARGET));
    if t == 0 {
        return Poll::Done;
    }
    let Some(target) = target(t) else { return Poll::Js };
    // turnSetup980 reads MoveTarget's class on a walking pawn.
    let m = live(p.o.word(L_MOVETARGET));
    if p.physics == 1 && m != 0 && Obj::of(m).row == 0 {
        return Poll::Js;
    }
    let focus = target.vec(L_LOCATION);
    if !facing_ok(p, focus) {
        return Poll::Js;
    }
    if p.gliding() {
        glide_acceleration(p);
    }
    p.o.set_vec(L_FOCUS, focus);
    if turn_setup(p, focus) { Poll::Done } else { Poll::Wait }
}

/// Engine 0x103bb730, pollWaitForLanding, without the LongFall event.
fn poll_wait_for_landing(handle: u32, delta: f64) -> Poll {
    if unsafe { (*addr_of!(L_NAMES))[2] } == 0 {
        return Poll::Js;
    }
    let o = Obj::of(handle);
    if o.row == 0 || !o.has(1 << L_PHYSICS | 1 << L_LATENTFLOAT) {
        return Poll::Js;
    }
    if o.byte(L_PHYSICS) != 2 {
        return Poll::Done;
    }
    let left = sub(ld(o.word(L_LATENTFLOAT)), ld((delta as f32).to_bits()));
    if lt_u(left, Ext::zero(0)) {
        return Poll::Js;
    }
    o.set_word(L_LATENTFLOAT, left.store());
    Poll::Wait
}

/// The poll of latent action `latent` on `handle` with delta `delta`.
pub(crate) fn poll(handle: u32, latent: u32, delta: f64) -> Poll {
    if latent == 528 {
        return poll_wait_for_landing(handle, delta);
    }
    let Some(p) = pawn(handle) else { return Poll::Js };
    // turnSetup980 reads MoveTarget's class on a walking pawn: it must be
    // described (`Obj::of` gives row 0 otherwise).
    let m = live(p.o.word(L_MOVETARGET));
    if p.physics == 1 && m != 0 && Obj::of(m).row == 0 {
        return Poll::Js;
    }
    match latent {
        501 => poll_move_to(&p),
        503 => poll_move_toward(&p),
        509 => poll_turn_to(&p),
        511 => poll_turn_toward(&p),
        _ => Poll::Js,
    }
}

/// The host's entry for validators: 0 the latent action stays, 1 cleared,
/// -1 JavaScript runs the poll (nothing written).
#[no_mangle]
pub extern "C" fn vm_loco_poll(handle: u32, latent: u32, delta: f64) -> i32 {
    match poll(handle, latent, delta) {
        Poll::Wait => 0,
        Poll::Done => 1,
        Poll::Js => -1,
    }
}
