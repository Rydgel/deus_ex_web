//! AScriptedPawn::Tick (DeusEx.dll 0x100195a0) and its helpers 0x10019e30 and 0x10019f60 in the interpreter, ahead of
//! AActor::Tick on the pawn's image (docs/script-scripted-pawn-tick.md). src/runtime/scripted-pawn-tick.mjs is the JavaScript
//! twin and the reference: both are checked against the original bytes by scripts/validate-scripted-pawn-tick.mjs (the JavaScript
//! body) and ACTOR_TICK_DIFFERENTIAL (Rust against JavaScript). Every step is the twin's, in the same order, in the same x87
//! arithmetic (`Ext`: 80-bit, one rounding per operation, a float32 store where the original has an fst/fstp, comparisons on the
//! unrounded stack value).
//!
//! The pawn's fields are the host's SP table (actor-tick-kernel.mjs SP_FIELDS, offsets and bool masks from the cell registry); a
//! pawn runs here only when the host found every one of them in its image (the C_SCRIPTEDPAWN class flag). A field read or
//! written after a callback that took the image away goes through js_tick_get / js_tick_set (the SP table's ids start at SPB).

use crate::interp::{live, load32, load8, store32, store8};
use crate::tick::{field, Actor, F_BADVANCEDTACTICS, F_DISTANCE, F_LASTRENDERTIME, F_PHYSICS, F_REMOTEROLE, F_ROLE, F_VELOCITY, F_WEAPON};
use crate::x87::Ext;
use core::ptr::{addr_of, addr_of_mut};

// SP table indices (actor-tick-kernel.mjs SP_FIELDS).
pub(crate) const S_BSIMULATEDPAWN: usize = 0;
const S_ACCELERATION: usize = 1;
const S_MOVETIMER: usize = 2;
const S_HEALTH: usize = 3;
const S_BONFIRE: usize = 4;
const S_BURNTIMER: usize = 5;
const S_PREPIVOT: usize = 6;
const S_DESIREDPREPIVOT: usize = 7;
const S_PREPIVOTTIME: usize = 8;
const S_CARCASSCHECKTIMER: usize = 9;
const S_POTENTIALENEMYTIMER: usize = 10;
const S_BEAMCHECKTIMER: usize = 11;
const S_BALLIANCESCHANGED: usize = 12;
const S_RELOADTIMER: usize = 13;
const S_BCANBLEED: usize = 14;
const S_BLEEDRATE: usize = 15;
const S_DROPCOUNTER: usize = 16;
const S_CLOTPERIOD: usize = 17;
const S_AGITATIONDECAYRATE: usize = 18;
const S_AGITATIONTIMER: usize = 19;
const S_AGITATIONCHECKTIMER: usize = 20;
const S_PLAYERAGITATIONTIMER: usize = 21;
const S_FEARSUSTAINTIME: usize = 22;
const S_FEARDECAYRATE: usize = 23;
const S_FEARTIMER: usize = 24;
const S_FEARLEVEL: usize = 25;
const S_ALARMTIMER: usize = 26;
const S_WEAPONTIMER: usize = 27;
const S_FIRETIMER: usize = 28;
const S_SPECIALTIMER: usize = 29;
const S_BDISAPPEAR: usize = 30;
const S_BTICKVISIBLEONLY: usize = 31;
const S_BCLEAREDOBSTACLE: usize = 32;
const S_TURNDIRECTION: usize = 33;
const S_NEXTDIRECTION: usize = 34;
const S_ACTORAVOIDING: usize = 35;
const S_AVOIDWALLTIMER: usize = 36;
const S_AVOIDBUMPTIMER: usize = 37;
const S_OBSTACLETIMER: usize = 38;
const S_TAKEHITTIMER: usize = 39;
const S_BURNPERIOD: usize = 40;
const S_FUTZTIMER: usize = 41;
const S_DISTRESSTIMER: usize = 42;
const S_BHASCLOAK: usize = 43;
const S_CLOAKTHRESHOLD: usize = 44;
const S_CLOAKEMPTIMER: usize = 45;
const S_ALLIANCES: usize = 46;
/// The name PotentialEnemyAlliance: written (to None) through the host only, a name cell's id lives in its bytes and its value in
/// the reference array.
const S_POTENTIALENEMYALLIANCE: usize = 47;
pub(crate) const SP_COUNT: usize = 48;
/// js_tick_get / js_tick_set ids of the SP table: SPB + index.
const SPB: u32 = 100;

// js_tick_event ids (actor-tick-kernel.mjs EVENTS).
const E_ENABLECLOAK_OFF: u32 = 7;
const E_ENABLECLOAK_ON: u32 = 8;
const E_EXTINGUISHFIRE: u32 = 9;
const E_SPURTBLOOD: u32 = 10;

/// SP_TABLE: per field [offset, bool mask or fixed-array stride], written by the host.
static mut SP_TABLE: [[u32; 2]; SP_COUNT] = [[0; 2]; SP_COUNT];
/// SP_ALLIANCE: the AlliancesEx element's AllianceName, AgitationLevel and bPermanent offsets, and bPermanent's mask.
static mut SP_ALLIANCE: [u32; 4] = [0; 4];

#[no_mangle]
pub extern "C" fn tick_sp_ptr() -> *mut u32 {
    addr_of_mut!(SP_TABLE) as *mut u32
}
#[no_mangle]
pub extern "C" fn tick_sp_alliance_ptr() -> *mut u32 {
    addr_of_mut!(SP_ALLIANCE) as *mut u32
}

#[link(wasm_import_module = "env")]
extern "C" {
    fn js_tick_event(ctx: u32, which: u32, delta: f64);
    fn js_tick_destroy(ctx: u32);
    fn js_tick_get(ctx: u32, field: u32, element: i32) -> f64;
    fn js_tick_set(ctx: u32, field: u32, element: i32, value: f64);
    fn js_tick_error(ctx: u32, code: u32);
}

#[inline(always)]
fn sp(s: usize) -> [u32; 2] {
    unsafe { (*addr_of!(SP_TABLE))[s] }
}

// ---- Field access ---------------------------------------------------------

/// The address of element `e` of SP field `s` in the image, or None where the image is gone (a callback released it).
#[inline(always)]
fn addr(a: &Actor, s: usize, e: u32) -> Option<u32> {
    if a.host || a.sp_mask & (1u64 << s) == 0 {
        None
    } else {
        Some(a.base.wrapping_add(sp(s)[0]).wrapping_add(e.wrapping_mul(4)))
    }
}
/// js_tick_get / js_tick_set's element argument: the component of a vector field, -1 for a scalar.
#[inline(always)]
fn elem(s: usize, e: u32) -> i32 {
    if matches!(s, S_ACCELERATION | S_PREPIVOT | S_DESIREDPREPIVOT) { e as i32 } else { -1 }
}
/// A float32 field's bits.
fn fbits(a: &mut Actor, s: usize, e: u32) -> u32 {
    match addr(a, s, e) {
        Some(p) => load32(p),
        None => (unsafe { js_tick_get(a.ctx, SPB + s as u32, elem(s, e)) } as f32).to_bits(),
    }
}
fn fput(a: &mut Actor, s: usize, e: u32, bits: u32) {
    match addr(a, s, e) {
        Some(p) => store32(p, bits),
        None => {
            unsafe { js_tick_set(a.ctx, SPB + s as u32, elem(s, e), f32::from_bits(bits) as f64) };
            a.refresh();
        }
    }
}
fn flag(a: &mut Actor, s: usize) -> bool {
    match addr(a, s, 0) {
        Some(p) => load32(p) & sp(s)[1] != 0,
        None => (unsafe { js_tick_get(a.ctx, SPB + s as u32, -1) }) != 0.0,
    }
}
fn flag_put(a: &mut Actor, s: usize, v: bool) {
    match addr(a, s, 0) {
        Some(p) => {
            let mask = sp(s)[1];
            let word = load32(p);
            store32(p, if v { word | mask } else { word & !mask });
        }
        None => {
            unsafe { js_tick_set(a.ctx, SPB + s as u32, -1, if v { 1.0 } else { 0.0 }) };
            a.refresh();
        }
    }
}
fn byte(a: &mut Actor, s: usize) -> u8 {
    match addr(a, s, 0) {
        Some(p) => load8(p),
        None => (unsafe { js_tick_get(a.ctx, SPB + s as u32, -1) }) as u8,
    }
}
fn byte_put(a: &mut Actor, s: usize, v: u8) {
    match addr(a, s, 0) {
        Some(p) => store8(p, v),
        None => {
            unsafe { js_tick_set(a.ctx, SPB + s as u32, -1, v as f64) };
            a.refresh();
        }
    }
}
fn int(a: &mut Actor, s: usize) -> i32 {
    match addr(a, s, 0) {
        Some(p) => load32(p) as i32,
        None => (unsafe { js_tick_get(a.ctx, SPB + s as u32, -1) }) as i32,
    }
}
fn pointer_clear(a: &mut Actor, s: usize) {
    match addr(a, s, 0) {
        Some(p) => store32(p, 0),
        None => {
            unsafe { js_tick_set(a.ctx, SPB + s as u32, -1, 0.0) };
            a.refresh();
        }
    }
}
/// An Actor/Pawn field of the main table, as float32 bits (or element `e` of a vector).
fn main_bits(a: &mut Actor, f: usize, e: u32) -> u32 {
    match a.at(f) {
        Some(p) => load32(p.wrapping_add(4 * e)),
        None => (unsafe { js_tick_get(a.ctx, f as u32, if f == F_VELOCITY { e as i32 } else { -1 }) } as f32).to_bits(),
    }
}
fn event(a: &mut Actor, which: u32) {
    unsafe { js_tick_event(a.ctx, which, 0.0) };
    a.refresh();
}

// ---- The x87 model --------------------------------------------------------

#[inline(always)]
fn ld(bits: u32) -> Ext {
    Ext::load(bits)
}
#[inline(always)]
fn st(e: Ext) -> u32 {
    e.store()
}
#[inline(always)]
fn sub(x: Ext, y: Ext) -> Ext {
    x.add(y.neg())
}
/// FCOM's C0: below or unordered (`test ah,1`).
#[inline(always)]
fn lt(x: Ext, y: Ext) -> bool {
    x.compare(y).0
}
/// `test ah,0x41`: below, equal or unordered.
#[inline(always)]
fn le(x: Ext, y: Ext) -> bool {
    let (c0, c3) = x.compare(y);
    c0 || c3
}
/// `test ah,0x40`: equal or unordered.
#[inline(always)]
fn eq(x: Ext, y: Ext) -> bool {
    x.compare(y).1
}
fn zero() -> Ext {
    Ext::load(0)
}
fn one32() -> Ext {
    Ext::load(0x3f80_0000)
}
fn d(value: f64) -> Ext {
    Ext::load_f64(value)
}

/// `if (x <= 0) skip; x -= dt (fst); if (x < 0) x = 0`.
fn count_down(a: &mut Actor, s: usize, dt: u32) {
    let value = ld(fbits(a, s, 0));
    if le(value, zero()) {
        return;
    }
    let result = sub(value, ld(dt));
    fput(a, s, 0, st(result));
    if lt(result, zero()) {
        fput(a, s, 0, 0);
    }
}

/// 0x10019e30: AgitationCheckTimer, AgitationTimer, and the alliances' AgitationLevel decay.
fn update_agitation(a: &mut Actor, dt: u32) {
    count_down(a, S_AGITATIONCHECKTIMER, dt);
    let timer = ld(fbits(a, S_AGITATIONTIMER, 0));
    let rate = ld(fbits(a, S_AGITATIONDECAYRATE, 0));
    let decay;
    if le(timer, zero()) {
        decay = ld(dt).mul(rate);
    } else if lt(timer, ld(dt)) {
        let ratio = timer.div(ld(dt));
        fput(a, S_AGITATIONTIMER, 0, 0);
        decay = sub(d(1.0), ratio).mul(ld(dt).mul(rate));
    } else {
        fput(a, S_AGITATIONTIMER, 0, st(sub(timer, ld(dt))));
        decay = zero();
    }
    if !flag(a, S_BALLIANCESCHANGED) || le(decay, zero()) {
        return;
    }
    flag_put(a, S_BALLIANCESCHANGED, false);
    if a.host || a.sp_mask & (1u64 << S_ALLIANCES) == 0 {
        // The array left the image with a callback; none runs before this point in the phase.
        unsafe { js_tick_error(a.ctx, 4) };
        return;
    }
    let stride = sp(S_ALLIANCES)[1];
    let [name_at, agitation_at, permanent_at, permanent_mask] = unsafe { *addr_of!(SP_ALLIANCE) };
    let first = a.base.wrapping_add(sp(S_ALLIANCES)[0]);
    for i in (0..16u32).rev() {
        let entry = first.wrapping_add(i.wrapping_mul(stride));
        let name = load32(entry.wrapping_add(name_at));
        if !crate::tick::named_word(name) || load32(entry.wrapping_add(permanent_at)) & permanent_mask != 0 {
            continue;
        }
        let level = ld(load32(entry.wrapping_add(agitation_at)));
        if le(level, zero()) {
            continue;
        }
        flag_put(a, S_BALLIANCESCHANGED, true);
        let result = sub(level, decay);
        store32(entry.wrapping_add(agitation_at), st(result));
        if lt(result, zero()) {
            store32(entry.wrapping_add(agitation_at), 0);
        }
    }
}

/// 0x10019f60: FearTimer and the FearLevel decay.
fn update_fear(a: &mut Actor, dt: u32) {
    let timer = ld(fbits(a, S_FEARTIMER, 0));
    let rate = ld(fbits(a, S_FEARDECAYRATE, 0));
    let decay;
    if le(timer, zero()) {
        decay = ld(dt).mul(rate);
    } else if lt(timer, ld(dt)) {
        let ratio = timer.div(ld(dt));
        fput(a, S_FEARTIMER, 0, 0);
        decay = sub(d(1.0), ratio).mul(ld(dt).mul(rate));
    } else {
        fput(a, S_FEARTIMER, 0, st(sub(timer, ld(dt))));
        return;
    }
    if le(decay, zero()) {
        return;
    }
    let level = ld(fbits(a, S_FEARLEVEL, 0));
    if le(level, zero()) {
        return;
    }
    let result = sub(level, decay);
    fput(a, S_FEARLEVEL, 0, st(result));
    if lt(result, zero()) {
        fput(a, S_FEARLEVEL, 0, 0);
    }
}

/// actorInStasis (actor-tick.mjs), for bDisappear: the same reads as tick.rs `start`, in the same order; None where a field is
/// outside the image (JavaScript decides then).
fn in_stasis(a: &mut Actor, time_seconds: f64) -> Option<bool> {
    let last = f32::from_bits(a.at(F_LASTRENDERTIME).map(load32)?) as f64;
    if !(time_seconds - last > 5.0) || !a.at(crate::tick::F_BSTASIS).map(|p| load32(p) & field(crate::tick::F_BSTASIS)[1] != 0)? {
        return Some(false);
    }
    let physics = a.at(F_PHYSICS).map(load8)? as f64;
    let forced = a.at(crate::tick::F_BFORCESTASIS).map(|p| load32(p) & field(crate::tick::F_BFORCESTASIS)[1] != 0)?;
    if !forced && physics != 0.0 && physics != 5.0 {
        return Some(false);
    }
    let rendered = crate::tick::zone_render_time(a);
    if crate::tick::zone_time_bad() {
        // Not a number: the JavaScript body throws.
        unsafe { js_tick_error(a.ctx, 3) };
        return Some(false);
    }
    if !(time_seconds - rendered > 5.0) && !(f32::from_bits(a.at(F_DISTANCE).map(load32)?) as f64 > 1200.0) {
        return Some(false);
    }
    Some(true)
}

/// The scripted-pawn phase. False when the pawn was destroyed (the caller returns 1 without AActor::Tick).
pub(crate) fn pre(a: &mut Actor, seconds: f64, tick_type: u32, time_seconds: f64) -> bool {
    let dt = (seconds as f32).to_bits();
    if a.num(F_REMOTEROLE) == 3.0 || a.num(F_ROLE) < 2.0 || tick_type == 1 {
        if !flag(a, S_BSIMULATEDPAWN) {
            return true;
        }
    }
    // Seconds since the last render, as a float32, floored at 0 by a stored +0.
    let last = ld(main_bits(a, F_LASTRENDERTIME, 0));
    let elapsed = sub(Ext::load_f64(time_seconds), last);
    let mut age = st(elapsed);
    if lt(elapsed, zero()) {
        age = 0;
    }
    if flag(a, S_BDISAPPEAR) {
        let stasis = match in_stasis(a, time_seconds) {
            Some(v) => v,
            None => {
                // outside the image: the host's actorInStasis (never reached for an admitted pawn)
                unsafe { js_tick_error(a.ctx, 4) };
                false
            }
        };
        if stasis || !le(ld(age), d(5.0)) {
            unsafe { js_tick_destroy(a.ctx) };
            return false;
        }
    }
    // PrePivot easing toward DesiredPrePivot over PrePivotTime.
    let pivot_time = ld(fbits(a, S_PREPIVOTTIME, 0));
    if !le(pivot_time, zero()) {
        if lt(ld(dt), pivot_time) {
            let dpp = [fbits(a, S_DESIREDPREPIVOT, 0), fbits(a, S_DESIREDPREPIVOT, 1), fbits(a, S_DESIREDPREPIVOT, 2)];
            let pp = [fbits(a, S_PREPIVOT, 0), fbits(a, S_PREPIVOT, 1), fbits(a, S_PREPIVOT, 2)];
            let mut dz = sub(ld(dpp[2]), ld(pp[2]));
            let dy = st(sub(ld(dpp[1]), ld(pp[1])));
            let dx = st(sub(ld(dpp[0]), ld(pp[0])));
            dz = dz.mul(ld(dt));
            let dy2 = st(ld(dy).mul(ld(dt)));
            let dx2 = st(ld(dx).mul(ld(dt)));
            let inverse = st(d(1.0).div(pivot_time));
            dz = dz.mul(ld(inverse));
            let dy3 = st(ld(dy2).mul(ld(inverse)));
            let dx3 = st(ld(dx2).mul(ld(inverse)));
            let z = st(dz.add(ld(pp[2])));
            let y = st(ld(dy3).add(ld(pp[1])));
            let x = st(ld(dx3).add(ld(pp[0])));
            fput(a, S_PREPIVOT, 0, x);
            fput(a, S_PREPIVOT, 1, y);
            fput(a, S_PREPIVOT, 2, z);
            fput(a, S_PREPIVOTTIME, 0, st(sub(pivot_time, ld(dt))));
        } else {
            for e in 0..3 {
                let v = fbits(a, S_DESIREDPREPIVOT, e);
                fput(a, S_PREPIVOT, e, v);
            }
            fput(a, S_PREPIVOTTIME, 0, 0);
        }
    }
    // The bleeding block below runs unless bTickVisibleOnly and the player is over 1200 units away.
    let mut bleed = true;
    if flag(a, S_BTICKVISIBLEONLY) && !le(ld(main_bits(a, F_DISTANCE, 0)), ld(1200.0f32.to_bits())) {
        bleed = false;
    }
    update_agitation(a, dt);
    update_fear(a, dt);
    // AlarmTimer always subtracts and floors at 0.
    {
        let result = sub(ld(fbits(a, S_ALARMTIMER, 0)), ld(dt));
        fput(a, S_ALARMTIMER, 0, st(result));
        if lt(result, zero()) {
            fput(a, S_ALARMTIMER, 0, 0);
        }
    }
    let weapon = match a.at(F_WEAPON) {
        Some(w) => live(load32(w)) != 0,
        None => (unsafe { js_tick_get(a.ctx, F_WEAPON as u32, -1) }) != 0.0,
    };
    if weapon {
        let sum = ld(dt).add(ld(fbits(a, S_WEAPONTIMER, 0)));
        fput(a, S_WEAPONTIMER, 0, st(sum));
    } else if !eq(ld(fbits(a, S_WEAPONTIMER, 0)), zero()) {
        fput(a, S_WEAPONTIMER, 0, 0);
    }
    count_down(a, S_FIRETIMER, dt);
    count_down(a, S_SPECIALTIMER, dt);
    {
        let reload = ld(fbits(a, S_RELOADTIMER, 0));
        if !le(reload, zero()) && weapon {
            fput(a, S_RELOADTIMER, 0, st(sub(reload, ld(dt))));
        } else {
            fput(a, S_RELOADTIMER, 0, 0);
        }
    }
    for s in [S_AVOIDWALLTIMER, S_AVOIDBUMPTIMER, S_OBSTACLETIMER, S_CLOAKEMPTIMER, S_TAKEHITTIMER, S_CARCASSCHECKTIMER] {
        count_down(a, s, dt);
    }
    {
        let timer = ld(fbits(a, S_POTENTIALENEMYTIMER, 0));
        if !le(timer, zero()) {
            let result = sub(timer, ld(dt));
            fput(a, S_POTENTIALENEMYTIMER, 0, st(result));
            if le(result, zero()) {
                fput(a, S_POTENTIALENEMYTIMER, 0, 0);
                unsafe { js_tick_set(a.ctx, SPB + S_POTENTIALENEMYALLIANCE as u32, -1, 0.0) };
                a.refresh();
            }
        }
    }
    for s in [S_BEAMCHECKTIMER, S_FUTZTIMER, S_PLAYERAGITATIONTIMER] {
        count_down(a, s, dt);
    }
    {
        let timer = ld(fbits(a, S_DISTRESSTIMER, 0));
        if !lt(timer, zero()) {
            let sum = ld(dt).add(timer);
            fput(a, S_DISTRESSTIMER, 0, st(sum));
            if !le(sum, ld(fbits(a, S_FEARSUSTAINTIME, 0))) {
                fput(a, S_DISTRESSTIMER, 0, (-1.0f32).to_bits());
            }
        }
    }
    // A pawn with a cloak reports its health against CloakThreshold every tick (the parameter's low bit).
    if flag(a, S_BHASCLOAK) {
        let health = int(a, S_HEALTH);
        let threshold = int(a, S_CLOAKTHRESHOLD);
        event(a, if health <= threshold { E_ENABLECLOAK_ON } else { E_ENABLECLOAK_OFF });
    }
    // Leaving the walking, accelerating, turning state clears the avoidance (and Bump's +4 on MoveTimer).
    if a.boolean(F_BADVANCEDTACTICS) {
        let acceleration = [fbits(a, S_ACCELERATION, 0), fbits(a, S_ACCELERATION, 1), fbits(a, S_ACCELERATION, 2)];
        let moving = !(eq(ld(acceleration[0]), zero()) && eq(ld(acceleration[1]), zero()) && eq(ld(acceleration[2]), zero()));
        if !(moving && a.num(F_PHYSICS) == 1.0 && byte(a, S_TURNDIRECTION) != 0) {
            a.set_bool(F_BADVANCEDTACTICS, false);
            if byte(a, S_TURNDIRECTION) != 0 {
                let timer = fbits(a, S_MOVETIMER, 0);
                fput(a, S_MOVETIMER, 0, st(sub(ld(timer), d(4.0))));
            }
            pointer_clear(a, S_ACTORAVOIDING);
            byte_put(a, S_NEXTDIRECTION, 0);
            byte_put(a, S_TURNDIRECTION, 0);
            flag_put(a, S_BCLEAREDOBSTACLE, true);
            fput(a, S_OBSTACLETIMER, 0, 0);
        }
    }
    // A burning pawn is put out after BurnPeriod.
    if flag(a, S_BONFIRE) {
        let burn = ld(dt).add(ld(fbits(a, S_BURNTIMER, 0)));
        fput(a, S_BURNTIMER, 0, st(burn));
        if !lt(burn, ld(fbits(a, S_BURNPERIOD, 0))) {
            event(a, E_EXTINGUISHFIRE);
        }
    }
    if !bleed {
        return true;
    }
    // Bleeding drops at a rate that follows the pawn's speed.
    let rate = ld(fbits(a, S_BLEEDRATE, 0));
    if !le(rate, zero()) && flag(a, S_BCANBLEED) {
        let mut x = rate;
        if lt(x, zero()) {
            x = zero();
        } else if !lt(x, one32()) {
            x = one32();
        }
        let period = st(sub(d(1.0), x).add(d(0.1)));
        let (vx, vy, vz) = (ld(main_bits(a, F_VELOCITY, 0)), ld(main_bits(a, F_VELOCITY, 1)), ld(main_bits(a, F_VELOCITY, 2)));
        let speed = vx.mul(vx).add(vy.mul(vy)).add(vz.mul(vz)).store_double().sqrt();
        let mut scaled = speed.mul(d(0.001953125));
        if lt(scaled, ld(0.05f32.to_bits())) {
            scaled = ld(0.05f32.to_bits());
        } else if !lt(scaled, one32()) {
            scaled = one32();
        }
        let threshold = st(ld(period).div(scaled));
        let counter = st(ld(dt).add(ld(fbits(a, S_DROPCOUNTER, 0))));
        fput(a, S_DROPCOUNTER, 0, counter);
        while !lt(ld(fbits(a, S_DROPCOUNTER, 0)), ld(threshold)) {
            event(a, E_SPURTBLOOD);
            let next = st(sub(ld(fbits(a, S_DROPCOUNTER, 0)), ld(threshold)));
            fput(a, S_DROPCOUNTER, 0, next);
        }
        let current = ld(fbits(a, S_BLEEDRATE, 0));
        let clot = ld(fbits(a, S_CLOTPERIOD, 0));
        let next = st(sub(current, ld(dt).div(clot)));
        fput(a, S_BLEEDRATE, 0, next);
    }
    if le(ld(fbits(a, S_BLEEDRATE, 0)), zero()) {
        fput(a, S_DROPCOUNTER, 0, 0);
        fput(a, S_BLEEDRATE, 0, 0);
    }
    true
}
