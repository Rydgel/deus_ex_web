//! Actor.Tick's per-actor bookkeeping in the interpreter (docs/rust-core.md,
//! step R3-d): src/runtime/actor-tick.mjs `tickStandaloneActor` with
//! `actorInStasis`, the timer phase (script-timers.mjs `updateActorTimer`),
//! and animation-tick.mjs `tickActorAnimation` over the animation tick view
//! (script-anim.mjs `animationTickView`). Each body is transcribed step for
//! step: the same reads, writes and callbacks in the same order, the same
//! double arithmetic, `Math.fround` where it rounds.
//!
//! The actor is the host's `(handle, base, mask, flags)`: its image base,
//! the fields `readNamed` reads in that image (bit i of the mask for field i
//! of T_FIELDS: the class resolves the spelling to the table's key and cell,
//! and the instance has no host binding for the key), and its class flags.
//! A read outside the mask goes to `js_tick_get`, the JavaScript body's own
//! read at that point (the tick's `services.read`, or the animation view's
//! accessor); a write to `js_tick_set`.
//!
//! Before the first effect (the bTicked write), every read must be in the
//! image; otherwise the whole tick is handed back (HANDBACK) and the
//! JavaScript body runs it, errors included. Those reads have no effect, so
//! running them again is not observable. A PlayerPawn is handed back too
//! (its input and view-target branches stay JavaScript).
//!
//! Callbacks (script events, ProcessState, physics, destruction, FarMoveActor,
//! the visibility helpers, the animation events) are imports that call the
//! same services at the same point. They may change anything, so each one
//! writes the actor's fresh receiver info, mask and the level's DemoRecDriver
//! test into T_STATE, which `refresh` reads back.

use crate::interp::{live, load32, load8, nan_first, quiet, store32, HOST};
use crate::trace::sqrt;
use core::ptr::{addr_of, addr_of_mut};

// Field indices (actor-tick-kernel.mjs TICK_FIELDS).
const F_ROLE: usize = 0;
const F_REMOTEROLE: usize = 1;
const F_LASTRENDERTIME: usize = 2;
const F_BSTASIS: usize = 3;
const F_BFORCESTASIS: usize = 4;
const F_PHYSICS: usize = 5;
const F_DISTANCE: usize = 6;
const F_BTRANSIENT: usize = 7;
const F_OWNER: usize = 8;
const F_BTICKED: usize = 9;
const F_BISPAWN: usize = 10;
const F_TIMERRATE: usize = 11;
const F_TIMERCOUNTER: usize = 12;
const F_BTIMERLOOP: usize = 13;
const F_LIFESPAN: usize = 14;
const F_BISPLAYER: usize = 15;
const F_BVIEWTARGET: usize = 16;
const F_VIEWROTATION: usize = 17;
const F_ROTATION: usize = 18;
const F_WEAPON: usize = 19;
const F_LOCATION: usize = 20;
const F_SIGHTCOUNTER: usize = 21;
const F_BHIDDEN: usize = 22;
const F_PAINTIME: usize = 23;
const F_SPEECHTIME: usize = 24;
const F_BADVANCEDTACTICS: usize = 25;
const F_ANIMSEQUENCE: usize = 26;
const F_ANIMFRAME: usize = 27;
const F_ANIMRATE: usize = 28;
const F_TWEENRATE: usize = 29;
const F_ANIMLAST: usize = 30;
const F_ANIMMINRATE: usize = 31;
const F_VELOCITY: usize = 32;
const F_BANIMFINISHED: usize = 33;
const F_BANIMLOOP: usize = 34;
const F_BANIMNOTIFY: usize = 35;
const F_BLENDSEQUENCE: usize = 36;
const F_BLENDFRAME: usize = 37;
const F_BLENDRATE: usize = 38;
const F_BLENDTWEEN: usize = 39;
const F_BLENDLAST: usize = 40;
const F_BLENDMINRATE: usize = 41;
const FIELD_COUNT: usize = 42;
/// js_tick_get/js_tick_set: the animation view's `animFlags` accessor.
const A_FLAGS: u32 = 64;
/// The fields the animation phase reads or writes, besides Role,
/// RemoteRole and bIsPawn: all in the image, or the JavaScript animation
/// body runs the phase (`js_tick_animation`).
const ANIM_FIELDS: u64 = ((1u64 << (F_BLENDMINRATE + 1)) - 1) & !((1u64 << F_ANIMSEQUENCE) - 1);

// Class flags (by record key along the chain, as the tick's isA compares).
const C_PAWN: u32 = 1;
const C_PLAYERPAWN: u32 = 2;
const C_WEAPON: u32 = 4;

// Results besides the body's 0 and 1.
const HANDBACK: i32 = -1;
const DEFER: i32 = -2;

// js_tick_event events; Tick, UpdateEyeHeight and UpdateTactics take the
// delta, the others no argument.
const E_TICK: u32 = 0;
const E_TIMER: u32 = 1;
const E_EXPIRED: u32 = 2;
const E_UPDATEEYEHEIGHT: u32 = 3;
const E_PAINTIMER: u32 = 4;
const E_SPEECHTIMER: u32 = 5;
const E_UPDATETACTICS: u32 = 6;
// js_tick_probing names.
const P_TICK: u32 = 0;
const P_ENEMYNOTVISIBLE: u32 = 1;
// js_tick_stmt statements run in JavaScript when a field they use is not in
// the image: `set('ViewRotation',get('Rotation'))` and the weapon's
// `if(weapon)services.farMoveActor(weapon,get('Location'),0,0)`.
const S_VIEWROTATION: u32 = 0;
const S_WEAPON: u32 = 1;
// js_tick_error: the DemoRecDriver a callback installed.
const ERR_DEMO: u32 = 1;

/// T_FIELDS: per field [offset, bool mask or fixed-array element stride],
/// written by the host from the cell registry.
static mut T_FIELDS: [[u32; 2]; FIELD_COUNT] = [[0; 2]; FIELD_COUNT];
/// T_STATE: after a callback, [receiver info (base | HOST), mask low, mask
/// high, DemoRecDriver set]; [4]: js_tick_zone_time's value was not a number.
static mut T_STATE: [u32; 5] = [0; 5];
/// T_F64: js_anim_notify's notify time, js_anim_velocity's vector.
static mut T_F64: [f64; 3] = [0.0; 3];
/// The name word of the empty name '' (nameCellWord), which `named` rejects
/// like None (0).
static mut T_EMPTY_NAME: u32 = 0;

#[no_mangle]
pub extern "C" fn tick_fields_ptr() -> *mut u32 {
    addr_of_mut!(T_FIELDS) as *mut u32
}
#[no_mangle]
pub extern "C" fn tick_state_ptr() -> *mut u32 {
    addr_of_mut!(T_STATE) as *mut u32
}
#[no_mangle]
pub extern "C" fn tick_f64_ptr() -> *mut f64 {
    addr_of_mut!(T_F64) as *mut f64
}
#[no_mangle]
pub extern "C" fn tick_empty_name_ptr() -> *mut u32 {
    addr_of_mut!(T_EMPTY_NAME)
}

#[link(wasm_import_module = "env")]
extern "C" {
    fn js_tick_zone_time(ctx: u32) -> f64;
    fn js_tick_owner_ticked(ctx: u32, owner: u32) -> i32;
    fn js_tick_probing(ctx: u32, which: u32) -> i32;
    fn js_tick_destroy(ctx: u32);
    fn js_tick_event(ctx: u32, which: u32, delta: f64);
    fn js_tick_state(ctx: u32, delta: f64);
    fn js_tick_physics(ctx: u32, delta: f64);
    fn js_tick_far_move(ctx: u32, weapon: u32, x: f64, y: f64, z: f64);
    fn js_tick_show_self(ctx: u32);
    fn js_tick_check_enemy(ctx: u32);
    fn js_tick_animation(ctx: u32, delta: f64);
    fn js_tick_stmt(ctx: u32, which: u32);
    fn js_tick_get(ctx: u32, field: u32, element: i32) -> f64;
    fn js_tick_set(ctx: u32, field: u32, element: i32, value: f64);
    fn js_tick_error(ctx: u32, code: u32);
    fn js_anim_end(ctx: u32);
    fn js_anim_notify(ctx: u32, old: f64) -> i32;
    fn js_anim_notify_event(ctx: u32);
    fn js_anim_latent(ctx: u32) -> i32;
    fn js_anim_sim(ctx: u32, blend: i32, frame: f64, rate: f64);
    fn js_anim_velocity(ctx: u32);
}

#[inline(always)]
fn field(f: usize) -> [u32; 2] {
    unsafe { (*addr_of!(T_FIELDS))[f] }
}
#[inline(always)]
fn f64io(i: usize) -> f64 {
    unsafe { (*addr_of!(T_F64))[i] }
}

// ---- The JavaScript bodies' arithmetic ------------------------------------

/// Math.fround.
#[inline(always)]
fn fround(v: f64) -> f64 {
    v as f32 as f64
}
/// Math.fround's float32 bits (setFloat32 of the rounded value).
#[inline(always)]
fn narrow(v: f64) -> u32 {
    (v as f32).to_bits()
}
/// A float32 cell as `getFloat32` widens it (a signaling NaN quieted).
#[inline(always)]
fn widen(bits: u32) -> f64 {
    f32::from_bits(quiet(bits)) as f64
}
// `x op y` with the first NaN operand's payload (interp.rs nan_first).
#[inline(always)]
fn add(x: f64, y: f64) -> f64 {
    nan_first(x, y, x + y)
}
#[inline(always)]
fn sub(x: f64, y: f64) -> f64 {
    nan_first(x, y, x - y)
}
#[inline(always)]
fn mul(x: f64, y: f64) -> f64 {
    nan_first(x, y, x * y)
}
#[inline(always)]
fn div(x: f64, y: f64) -> f64 {
    nan_first(x, y, x / y)
}
/// x87 C0 (animation-tick.mjs and actor-tick.mjs `less`): below or unordered.
#[inline(always)]
fn less(a: f64, b: f64) -> bool {
    a < b || a != a || b != b
}
/// `value!==0&&!Number.isNaN(value)`.
#[inline(always)]
fn nonzero(v: f64) -> bool {
    v != 0.0 && v == v
}
/// Math.trunc.
fn trunc(x: f64) -> f64 {
    if !(x > -4_503_599_627_370_496.0 && x < 4_503_599_627_370_496.0) {
        return x;
    }
    let t = x as i64 as f64;
    if t == 0.0 && x.is_sign_negative() {
        -0.0
    } else {
        t
    }
}
/// animation-tick.mjs `named` on a name word (nameCellWord: None is 0).
#[inline(always)]
fn named_word(word: u32) -> bool {
    word != 0 && word != unsafe { T_EMPTY_NAME }
}

/// The ticking actor. `at` gives a field's image address when `readNamed`
/// reads it there.
struct Actor {
    ctx: u32,
    base: u32,
    host: bool,
    mask: u64,
    flags: u32,
    demo: bool,
}

impl Actor {
    #[inline(always)]
    fn at(&self, f: usize) -> Option<u32> {
        if self.host || self.mask & (1u64 << f) == 0 {
            None
        } else {
            Some(self.base.wrapping_add(field(f)[0]))
        }
    }
    #[inline(always)]
    fn element(&self, f: usize, i: u32) -> Option<u32> {
        self.at(f).map(|a| a.wrapping_add(i.wrapping_mul(field(f)[1])))
    }
    /// After a callback: the actor's fresh receiver info and mask.
    fn refresh(&mut self) {
        let s = unsafe { *addr_of!(T_STATE) };
        self.host = s[0] & HOST != 0;
        self.base = s[0] & !15;
        self.mask = (s[2] as u64) << 32 | s[1] as u64;
        self.demo = s[3] != 0;
    }

    // Image-only reads for the prelude (None hands the tick back).
    #[inline(always)]
    fn img_byte(&self, f: usize) -> Option<f64> {
        self.at(f).map(|a| load8(a) as f64)
    }
    #[inline(always)]
    fn img_bool(&self, f: usize) -> Option<bool> {
        self.at(f).map(|a| load32(a) & field(f)[1] != 0)
    }
    #[inline(always)]
    fn img_float(&self, f: usize) -> Option<f64> {
        self.at(f).map(|a| widen(load32(a)))
    }

    // Reads with the JavaScript fallback: byte and float fields as numbers.
    #[inline(always)]
    fn num(&mut self, f: usize) -> f64 {
        match self.at(f) {
            Some(a) => {
                if f == F_ROLE || f == F_REMOTEROLE || f == F_PHYSICS {
                    load8(a) as f64
                } else {
                    widen(load32(a))
                }
            }
            None => unsafe { js_tick_get(self.ctx, f as u32, -1) },
        }
    }
    #[inline(always)]
    fn boolean(&mut self, f: usize) -> bool {
        match self.at(f) {
            Some(a) => load32(a) & field(f)[1] != 0,
            None => (unsafe { js_tick_get(self.ctx, f as u32, -1) }) != 0.0,
        }
    }
    #[inline(always)]
    fn set_float(&mut self, f: usize, v: f64) {
        match self.at(f) {
            Some(a) => store32(a, narrow(v)),
            None => {
                unsafe { js_tick_set(self.ctx, f as u32, -1, v) };
                self.refresh();
            }
        }
    }
    #[inline(always)]
    fn set_bool(&mut self, f: usize, v: bool) {
        match self.at(f) {
            Some(a) => {
                let mask = field(f)[1];
                let word = load32(a);
                store32(a, if v { word | mask } else { word & !mask });
            }
            None => {
                unsafe { js_tick_set(self.ctx, f as u32, -1, if v { 1.0 } else { 0.0 }) };
                self.refresh();
            }
        }
    }
    fn event(&mut self, which: u32, delta: f64) {
        unsafe { js_tick_event(self.ctx, which, delta) };
        self.refresh();
    }

    // The animation view (script-anim.mjs): a blend element `i`, or the
    // main fields for i < 0.
    #[inline(always)]
    fn anim(&mut self, f: usize) -> f64 {
        match self.at(f) {
            Some(a) => widen(load32(a)),
            None => unsafe { js_tick_get(self.ctx, f as u32, -1) },
        }
    }
    #[inline(always)]
    fn set_anim(&mut self, f: usize, v: f64) {
        self.set_float(f, v);
    }
    #[inline(always)]
    fn anim_named(&mut self) -> bool {
        match self.at(F_ANIMSEQUENCE) {
            Some(a) => named_word(load32(a)),
            None => (unsafe { js_tick_get(self.ctx, F_ANIMSEQUENCE as u32, -1) }) != 0.0,
        }
    }
    #[inline(always)]
    fn blend(&mut self, f: usize, i: u32) -> f64 {
        match self.element(f, i) {
            Some(a) => widen(load32(a)),
            None => unsafe { js_tick_get(self.ctx, f as u32, i as i32) },
        }
    }
    #[inline(always)]
    fn blend_named(&mut self, i: u32) -> bool {
        match self.element(F_BLENDSEQUENCE, i) {
            Some(a) => named_word(load32(a)),
            None => (unsafe { js_tick_get(self.ctx, F_BLENDSEQUENCE as u32, i as i32) }) != 0.0,
        }
    }
    /// `arrayReference(index, ref).set(value)`: the whole float array is
    /// read, the element replaced and the array written back, so each other
    /// element's bits go through getFloat32 and setFloat32 (quieted).
    fn set_blend(&mut self, f: usize, i: u32, v: f64) {
        match self.at(f) {
            Some(a) => {
                let stride = field(f)[1];
                for j in 0..4u32 {
                    let e = a.wrapping_add(j.wrapping_mul(stride));
                    store32(e, if j == i { narrow(v) } else { quiet(load32(e)) });
                }
            }
            None => {
                unsafe { js_tick_set(self.ctx, f as u32, i as i32, v) };
                self.refresh();
            }
        }
    }
    /// The view's `animFlags`: bAnimFinished 0x08, bAnimLoop 0x10,
    /// bAnimNotify 0x20.
    fn anim_flags(&mut self) -> u32 {
        match (self.at(F_BANIMFINISHED), self.at(F_BANIMLOOP), self.at(F_BANIMNOTIFY)) {
            (Some(a), Some(b), Some(c)) => {
                (if load32(a) & field(F_BANIMFINISHED)[1] != 0 { 0x08 } else { 0 })
                    | (if load32(b) & field(F_BANIMLOOP)[1] != 0 { 0x10 } else { 0 })
                    | (if load32(c) & field(F_BANIMNOTIFY)[1] != 0 { 0x20 } else { 0 })
            }
            _ => (unsafe { js_tick_get(self.ctx, A_FLAGS, -1) }) as u32,
        }
    }
    /// `animFlags = value`: each of the three bools, in that order.
    fn set_anim_flags(&mut self, value: u32) {
        if self.at(F_BANIMFINISHED).is_some() && self.at(F_BANIMLOOP).is_some() && self.at(F_BANIMNOTIFY).is_some()
        {
            self.set_bool(F_BANIMFINISHED, value & 0x08 != 0);
            self.set_bool(F_BANIMLOOP, value & 0x10 != 0);
            self.set_bool(F_BANIMNOTIFY, value & 0x20 != 0);
        } else {
            unsafe { js_tick_set(self.ctx, A_FLAGS, -1, value as f64) };
            self.refresh();
        }
    }
    /// The view's `Velocity` (`get('Velocity') ?? [0, 0, 0]`), destructured.
    fn velocity(&mut self) -> [f64; 3] {
        match self.at(F_VELOCITY) {
            Some(a) => [widen(load32(a)), widen(load32(a.wrapping_add(4))), widen(load32(a.wrapping_add(8)))],
            None => {
                unsafe { js_anim_velocity(self.ctx) };
                [f64io(0), f64io(1), f64io(2)]
            }
        }
    }
}

// ---- actorInStasis and the owner test (reads only) ------------------------

enum Start {
    Stasis(bool),
    Defer,
    Tick,
}

/// The body up to its first effect: the Role gate, actorInStasis, the
/// stasis destruction test and the owner test. None hands the tick back.
#[inline(always)]
fn start(a: &Actor, time_seconds: f64, tick_tag: u32) -> Option<Start> {
    // `get('Role')!==4` throws in JavaScript (the level gates are the host's).
    if a.img_byte(F_ROLE)? != 4.0 {
        return None;
    }
    // actorInStasis: the unrounded double differences, unordered compares
    // failing, and level.netMode === 0 (the host admitted only NetMode 0).
    let stasis = 'stasis: {
        if !(time_seconds - a.img_float(F_LASTRENDERTIME)? > 5.0) || !a.img_bool(F_BSTASIS)? {
            break 'stasis false;
        }
        let physics = a.img_byte(F_PHYSICS)?;
        if !a.img_bool(F_BFORCESTASIS)? && physics != 0.0 && physics != 5.0 {
            break 'stasis false;
        }
        let rendered = unsafe { js_tick_zone_time(a.ctx) };
        if unsafe { (*addr_of!(T_STATE))[4] } != 0 {
            // Not a number: the JavaScript body throws.
            return None;
        }
        if !(time_seconds - rendered > 5.0) && !(a.img_float(F_DISTANCE)? > 1200.0) {
            break 'stasis false;
        }
        true
    };
    if stasis {
        return Some(Start::Stasis(a.img_bool(F_BTRANSIENT)? && a.img_byte(F_ROLE)? >= 2.0));
    }
    let owner = live(a.at(F_OWNER).map(load32)?);
    if owner != 0 {
        let ticked = unsafe { js_tick_owner_ticked(a.ctx, owner) };
        if ticked >= 0 && ticked as u32 != tick_tag {
            return Some(Start::Defer);
        }
    }
    Some(Start::Tick)
}

/// tickStandaloneActor for one actor. Returns its result (0 or 1), DEFER
/// (the host allocates the deferred node, then the result is 0) or HANDBACK.
#[no_mangle]
pub extern "C" fn tick_actor(
    ctx: u32,
    base: u32,
    mask_lo: u32,
    mask_hi: u32,
    flags: u32,
    seconds: f64,
    tick_type: u32,
    time_seconds: f64,
    tick_tag: u32,
) -> i32 {
    let mut a = Actor { ctx, base, host: false, mask: (mask_hi as u64) << 32 | mask_lo as u64, flags, demo: false };
    if flags & C_PLAYERPAWN != 0 {
        return HANDBACK;
    }
    let delta = fround(seconds);
    match start(&a, time_seconds, tick_tag) {
        None => return HANDBACK,
        Some(Start::Stasis(destroy)) => {
            if destroy {
                unsafe { js_tick_destroy(ctx) };
            }
            return 1;
        }
        Some(Start::Defer) => return DEFER,
        Some(Start::Tick) => {}
    }
    a.set_bool(F_BTICKED, tick_tag & 1 != 0);
    let pawn = a.boolean(F_BISPAWN) && flags & C_PAWN != 0;
    animation(&mut a, delta);
    if a.num(F_REMOTEROLE) == 3.0 {
        if a.num(F_ROLE) == 4.0 {
            // A PlayerPawn's view-target copy is handed back above.
            script_and_timer(&mut a, delta);
        }
    } else if a.num(F_ROLE) >= 2.0 {
        // A controlled PlayerPawn's input is handed back above.
        if tick_type == 1 {
            return 1;
        }
        if unsafe { js_tick_probing(ctx, P_TICK) } != 0 {
            a.event(E_TICK, delta);
        }
        script_and_timer(&mut a, delta);
        let lifespan = a.num(F_LIFESPAN);
        if lifespan != 0.0 && lifespan == lifespan {
            let remaining = sub(lifespan, delta);
            a.set_float(F_LIFESPAN, fround(remaining));
            if !(remaining > 0.0001) {
                a.event(E_EXPIRED, delta);
                unsafe { js_tick_destroy(ctx) };
                return 1;
            }
        }
        if a.num(F_PHYSICS) != 0.0 && a.num(F_ROLE) != 3.0 {
            unsafe { js_tick_physics(ctx, delta) };
            a.refresh();
        }
    } else if a.num(F_PHYSICS) == 2.0 {
        unsafe { js_tick_physics(ctx, delta) };
        a.refresh();
    }
    if a.demo {
        unsafe { js_tick_error(ctx, ERR_DEMO) };
    }
    if !pawn {
        return 1;
    }
    if a.boolean(F_BISPLAYER) && a.num(F_ROLE) >= 3.0 {
        if a.boolean(F_BVIEWTARGET) {
            a.event(E_UPDATEEYEHEIGHT, delta);
        } else {
            match (a.at(F_ROTATION), a.at(F_VIEWROTATION)) {
                // A rotator's three int32 words, as the codec copies them.
                (Some(from), Some(to)) => {
                    store32(to, load32(from));
                    store32(to.wrapping_add(4), load32(from.wrapping_add(4)));
                    store32(to.wrapping_add(8), load32(from.wrapping_add(8)));
                }
                _ => {
                    unsafe { js_tick_stmt(ctx, S_VIEWROTATION) };
                    a.refresh();
                }
            }
        }
    }
    match (a.at(F_WEAPON), a.at(F_LOCATION)) {
        (Some(w), Some(l)) => {
            let weapon = live(load32(w));
            if weapon != 0 {
                let (x, y, z) = (widen(load32(l)), widen(load32(l.wrapping_add(4))), widen(load32(l.wrapping_add(8))));
                unsafe { js_tick_far_move(ctx, weapon, x, y, z) };
                a.refresh();
            }
        }
        (Some(w), None) if live(load32(w)) == 0 => {}
        _ => {
            unsafe { js_tick_stmt(ctx, S_WEAPON) };
            a.refresh();
        }
    }
    if a.num(F_ROLE) != 4.0 || tick_type != 2 {
        return 1;
    }
    if less(a.num(F_SIGHTCOUNTER), 0.0) {
        let sight = a.num(F_SIGHTCOUNTER);
        a.set_float(F_SIGHTCOUNTER, fround(add(sight, 0.2)));
    }
    let sight = a.num(F_SIGHTCOUNTER);
    a.set_float(F_SIGHTCOUNTER, fround(sub(sight, delta)));
    if a.boolean(F_BISPLAYER) && !a.boolean(F_BHIDDEN) {
        unsafe { js_tick_show_self(ctx) };
        a.refresh();
    }
    if less(a.num(F_SIGHTCOUNTER), 0.0) && unsafe { js_tick_probing(ctx, P_ENEMYNOTVISIBLE) } != 0 {
        unsafe { js_tick_check_enemy(ctx) };
        a.refresh();
        a.set_float(F_SIGHTCOUNTER, fround(0.1));
    }
    for (f, callback) in [(F_PAINTIME, E_PAINTIMER), (F_SPEECHTIME, E_SPEECHTIMER)] {
        if a.num(f) > 0.0 {
            let remaining = sub(a.num(f), delta);
            a.set_float(f, fround(remaining));
            if less(remaining, 0.001) {
                a.set_float(f, 0.0);
                a.event(callback, delta);
            }
        }
    }
    if a.boolean(F_BADVANCEDTACTICS) {
        a.event(E_UPDATETACTICS, delta);
    }
    1
}

/// actor-tick.mjs `scriptAndTimer`: ProcessState, then updateActorTimer on
/// the TimerRate/TimerCounter/bTimerLoop accessors.
fn script_and_timer(a: &mut Actor, delta: f64) {
    unsafe { js_tick_state(a.ctx, delta) };
    a.refresh();
    if !(fround(a.num(F_TIMERRATE)) > 0.0) {
        return;
    }
    let rate = fround(a.num(F_TIMERRATE));
    if !(rate > 0.0) {
        return;
    }
    let counter = fround(a.num(F_TIMERCOUNTER));
    let sum = add(fround(delta), counter);
    a.set_float(F_TIMERCOUNTER, fround(sum));
    if !(sum >= rate) {
        return;
    }
    let periods = trunc(div(sum, rate));
    a.set_float(F_TIMERCOUNTER, fround(sub(sum, mul(periods, rate))));
    if periods != 0.0 && !a.boolean(F_BTIMERLOOP) {
        a.set_float(F_TIMERRATE, 0.0);
    }
    a.event(E_TIMER, delta);
}

// ---- The animation phase (animation-tick.mjs) -----------------------------

/// processActorAnimation: the whole phase in JavaScript unless every
/// animation field is in the image.
fn animation(a: &mut Actor, delta: f64) {
    if a.host || a.mask & ANIM_FIELDS != ANIM_FIELDS {
        unsafe { js_tick_animation(a.ctx, delta) };
        a.refresh();
        return;
    }
    // The view's simulatedPawn, evaluated once when the options are built.
    let simulated = a.boolean(F_BISPAWN) && a.flags & C_PAWN != 0 && a.num(F_ROLE) == 2.0;
    tick_actor_animation(a, delta, simulated);
}

/// `remainder(end, start, stop)`.
#[inline(always)]
fn remainder(end: f64, start: f64, stop: f64, remaining: f64) -> f64 {
    fround(div(mul(sub(end, stop), remaining), sub(end, start)))
}

/// `scaledRate(actor, rate, minimum, blend)`.
fn scaled_rate(a: &mut Actor, rate: f64, minimum: f64, blend: bool) -> f64 {
    if !less(rate, 0.0) {
        return rate;
    }
    let [x, y, z] = a.velocity();
    let s = add(add(mul(x, x), mul(y, y)), mul(z, z));
    let root = if s != s { s } else { sqrt(s) };
    let product = mul(-root, rate);
    let scaled = if blend { fround(product) } else { product };
    if less(minimum, scaled) {
        scaled
    } else {
        minimum
    }
}

fn end_event(a: &mut Actor, simulated: bool) {
    if !simulated {
        unsafe { js_anim_end(a.ctx) };
        a.refresh();
    }
}

/// `replicateCompletion(actor, animation)` for the main sequence (blend < 0)
/// or blend slot `blend`.
fn replicate(a: &mut Actor, blend: i32) {
    if a.num(F_REMOTEROLE) >= 2.0 || a.flags & C_WEAPON != 0 {
        return;
    }
    let (rate, frame) = if blend < 0 {
        (mul(a.anim(F_ANIMRATE), 5000.0), a.anim(F_ANIMFRAME))
    } else {
        (mul(a.blend(F_BLENDRATE, blend as u32), 5000.0), a.blend(F_BLENDFRAME, blend as u32))
    };
    let frame = fround(mul(frame, 10000.0));
    let rate = if rate > 32767.0 { 32767.0 } else { fround(rate) };
    unsafe { js_anim_sim(a.ctx, blend, frame, rate) };
    a.refresh();
}

/// `active(actor)`: a named sequence with a nonzero rate (the tween rate
/// while AnimFrame is negative).
#[inline(always)]
fn active(a: &mut Actor) -> bool {
    if !a.anim_named() {
        return false;
    }
    let rate = if less(a.anim(F_ANIMFRAME), 0.0) { a.anim(F_TWEENRATE) } else { a.anim(F_ANIMRATE) };
    nonzero(rate)
}

/// `admit()`: the shared gate and four-iteration budget of both loops.
#[inline(always)]
fn admit(a: &mut Actor, remaining: f64, iterations: &mut u32) -> bool {
    if !active(a) || !(remaining > 0.0) {
        return false;
    }
    *iterations += 1;
    *iterations <= 4
}

fn tick_actor_animation(a: &mut Actor, seconds: f64, simulated: bool) {
    let mut remaining = fround(seconds);
    let mut iterations = 0u32;
    while admit(a, remaining, &mut iterations) {
        let old = a.anim(F_ANIMFRAME);
        if less(old, 0.0) {
            let tween = a.anim(F_TWEENRATE);
            let advanced = add(old, mul(remaining, tween));
            a.set_anim(F_ANIMFRAME, fround(advanced));
            if less(advanced, 0.0) {
                break;
            }
            remaining = remainder(advanced, old, 0.0, remaining);
            a.set_anim(F_ANIMFRAME, 0.0);
            if !nonzero(a.anim(F_ANIMRATE)) {
                let flags = a.anim_flags();
                a.set_anim_flags(flags | 0x08);
                end_event(a, simulated);
            }
            continue;
        }
        let rate = a.anim(F_ANIMRATE);
        let minimum = a.anim(F_ANIMMINRATE);
        let scaled = scaled_rate(a, rate, minimum, false);
        a.set_anim(F_ANIMFRAME, fround(add(old, mul(remaining, scaled))));
        if a.anim_flags() & 0x20 != 0 && unsafe { js_anim_notify(a.ctx, old) } != 0 {
            let time = f64io(0);
            remaining = remainder(a.anim(F_ANIMFRAME), old, time, remaining);
            a.set_anim(F_ANIMFRAME, time);
            unsafe { js_anim_notify_event(a.ctx) };
            a.refresh();
            continue;
        }
        if less(a.anim(F_ANIMFRAME), a.anim(F_ANIMLAST)) {
            break;
        }
        if a.anim_flags() & 0x10 != 0 {
            if less(a.anim(F_ANIMFRAME), 1.0) {
                remaining = 0.0;
            } else {
                remaining = remainder(a.anim(F_ANIMFRAME), old, 1.0, remaining);
                a.set_anim(F_ANIMFRAME, 0.0);
            }
            if less(old, a.anim(F_ANIMLAST)) {
                if unsafe { js_anim_latent(a.ctx) } != 0 {
                    let flags = a.anim_flags();
                    a.set_anim_flags(flags | 0x08);
                }
                end_event(a, simulated);
            }
        } else {
            let frame = a.anim(F_ANIMFRAME);
            let last = a.anim(F_ANIMLAST);
            remaining = remainder(frame, old, last, remaining);
            let last = a.anim(F_ANIMLAST);
            a.set_anim(F_ANIMFRAME, last);
            a.set_anim(F_ANIMRATE, 0.0);
            let flags = a.anim_flags();
            a.set_anim_flags(flags | 0x08);
            end_event(a, simulated);
            replicate(a, -1);
        }
    }
    // 103a1fa1 -> 103a21f4 -> 103a1fa1: the same gate and budget, then one
    // pass over the four blend slots per admission.
    while admit(a, remaining, &mut iterations) {
        for i in 0..4u32 {
            if !a.blend_named(i) || !less(a.blend(F_BLENDFRAME, i), a.blend(F_BLENDLAST, i)) {
                continue;
            }
            let old = a.blend(F_BLENDFRAME, i);
            if less(old, 0.0) {
                let tween = a.blend(F_BLENDTWEEN, i);
                let advanced = add(old, mul(remaining, tween));
                a.set_blend(F_BLENDFRAME, i, fround(advanced));
                if !less(advanced, 0.0) {
                    remaining = remainder(advanced, old, 0.0, remaining);
                    a.set_blend(F_BLENDFRAME, i, 0.0);
                }
            } else {
                let rate = a.blend(F_BLENDRATE, i);
                let minimum = a.blend(F_BLENDMINRATE, i);
                let scaled = scaled_rate(a, rate, minimum, true);
                a.set_blend(F_BLENDFRAME, i, fround(add(old, mul(remaining, scaled))));
                if !less(a.blend(F_BLENDFRAME, i), a.blend(F_BLENDLAST, i)) {
                    let frame = a.blend(F_BLENDFRAME, i);
                    let last = a.blend(F_BLENDLAST, i);
                    remaining = remainder(frame, old, last, remaining);
                    let last = a.blend(F_BLENDLAST, i);
                    a.set_blend(F_BLENDFRAME, i, last);
                    a.set_blend(F_BLENDRATE, i, 0.0);
                    replicate(a, i as i32);
                }
            }
        }
    }
}
