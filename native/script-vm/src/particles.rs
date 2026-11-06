//! DeusEx.dll's execUpdateParticles (native 3017, 0x1001ac50) over a
//! ParticleIterator's own image cells (script-particles.mjs
//! `updateParticles`, docs/particles.md), instead of copying its 64
//! sParticle structs into JavaScript and back. The host
//! (script-vm-particles.mjs) fills the cell table, admits an iterator only
//! when every cell is its image storage, and supplies appFrand.

use crate::interp::{load32, store32};
use crate::render::{far_commit, far_plan, FarMove, Obj, FAR_MOVE_FIELDS, ITEM_FIELDS, R_DRAWSCALE, R_SCALEGLOW};
use crate::x87::Ext;
use core::ptr::{addr_of, addr_of_mut};

// P_FIELDS words: the Particles array's offset and stride, then each
// sParticle member's offset inside the element (bActive's bool mask after
// it), then the iterator's scalars (bool masks after the bools).
const P_ARRAY: usize = 0;
const P_STRIDE: usize = 1;
const P_ACTIVE: usize = 2;
const P_ACTIVE_MASK: usize = 3;
const P_INITVEL: usize = 4;
const P_VELOCITY: usize = 5;
const P_LOCATION: usize = 6;
const P_DRAWSCALE: usize = 7;
const P_SCALEGLOW: usize = 8;
const P_LIFESPAN: usize = 9;
const P_NEXTFREE: usize = 10;
const P_GRAVITY: usize = 11;
const P_GRAVITY_MASK: usize = 12;
const P_SCALES: usize = 13;
const P_SCALES_MASK: usize = 14;
const P_FADES: usize = 15;
const P_FADES_MASK: usize = 16;
const P_ZONEGRAVITY: usize = 17;
const P_RISERATE: usize = 18;
const P_LIFE: usize = 19;
const P_DRAWSCALE_OWNER: usize = 20;
// The iterator's Index (RenderIterator, an int), for `particle_items`.
const P_INDEX: usize = 21;
const P_WORDS: usize = 22;
const COUNT: u32 = 64;

static mut P_FIELDS: [u32; P_WORDS] = [0; P_WORDS];

#[no_mangle]
pub extern "C" fn particle_fields_ptr() -> *mut u32 {
    addr_of_mut!(P_FIELDS) as *mut u32
}

#[link(wasm_import_module = "env")]
extern "C" {
    /// The shared appFrand stream's next value.
    fn js_frand() -> f64;
}

#[inline(always)]
fn pf(i: usize) -> u32 {
    unsafe { (*addr_of!(P_FIELDS))[i] }
}

#[inline(always)]
fn gt(a: Ext, b: Ext) -> bool {
    a.compare(b) == (false, false)
}
#[inline(always)]
fn lt(a: Ext, b: Ext) -> bool {
    a.compare(b) == (true, false)
}

/// updateParticles on the iterator image at `base` for the float bits
/// `delta`; returns 1 when no particle is active afterwards (the proxy's
/// bHidden), else 0.
#[no_mangle]
pub extern "C" fn update_particles(base: u32, delta: u32) -> u32 {
    let dt = Ext::load(delta);
    let zero = Ext::load_f64(0.0);
    let flag = |at: usize, mask: usize| load32(base + pf(at)) & pf(mask) != 0;
    let float = |at: usize| load32(base + pf(at));
    let (gravity, scales, fades) = (flag(P_GRAVITY, P_GRAVITY_MASK), flag(P_SCALES, P_SCALES_MASK), flag(P_FADES, P_FADES_MASK));
    let mut none_active = true;
    for i in 0..COUNT {
        let p = base + pf(P_ARRAY) + i * pf(P_STRIDE);
        let active_at = p + pf(P_ACTIVE);
        if load32(active_at) & pf(P_ACTIVE_MASK) == 0 {
            continue;
        }
        let w = |member: usize, k: u32| p + pf(member) + 4 * k;
        let life_at = w(P_LIFESPAN, 0);
        if f32::from_bits(load32(life_at)) > 0.0 {
            let left = Ext::load(load32(life_at)).add(dt.neg());
            store32(life_at, if gt(left, zero) { left.store() } else { (-1.0f32).to_bits() });
        }
        if f32::from_bits(load32(life_at)) < 0.0 {
            // DeleteParticle (0x1001aaf0).
            store32(active_at, load32(active_at) & !pf(P_ACTIVE_MASK));
            store32(base + pf(P_NEXTFREE), i);
            continue;
        }
        none_active = false;
        for axis in 0..2 {
            let base_v = Ext::load(Ext::load(load32(w(P_INITVEL, axis))).add(Ext::load_f64(2.0)).store());
            let jitter = Ext::load_f64(unsafe { js_frand() }).mul(Ext::load(5.0f32.to_bits()));
            store32(w(P_VELOCITY, axis), base_v.add(jitter.neg()).store());
        }
        let life = Ext::load(load32(life_at));
        if gravity {
            let fall = dt.mul(Ext::load(float(P_ZONEGRAVITY))).mul(Ext::load_f64(0.2));
            store32(w(P_VELOCITY, 2), fall.add(Ext::load(load32(w(P_VELOCITY, 2)))).store());
        } else {
            let jitter = Ext::load_f64(unsafe { js_frand() }).mul(Ext::load_f64(0.2)).add(Ext::load_f64(0.9));
            let age = Ext::load(float(P_LIFE)).add(life.neg()).mul(Ext::load(float(P_RISERATE)));
            store32(w(P_VELOCITY, 2), jitter.mul(age).add(Ext::load(load32(w(P_INITVEL, 2)))).store());
        }
        let draw_scale = if scales {
            let scale = Ext::load(float(P_LIFE)).add(life.neg()).add(Ext::load_f64(1.0)).mul(Ext::load(float(P_DRAWSCALE_OWNER)));
            if lt(scale, Ext::load_f64(0.01)) {
                0.01f32.to_bits()
            } else if lt(scale, Ext::load_f64(3.0)) {
                scale.store()
            } else {
                3.0f32.to_bits()
            }
        } else {
            float(P_DRAWSCALE_OWNER)
        };
        store32(w(P_DRAWSCALE, 0), draw_scale);
        let glow = if fades { life.div(Ext::load(float(P_LIFE))).store() } else { 1.0f32.to_bits() };
        store32(w(P_SCALEGLOW, 0), glow);
        let step = |axis: u32| dt.mul(Ext::load(load32(w(P_VELOCITY, axis))));
        let dy = step(1).store();
        let dz = step(2).store();
        let x = step(0).add(Ext::load(load32(w(P_LOCATION, 0)))).store();
        store32(w(P_LOCATION, 0), x);
        store32(w(P_LOCATION, 1), Ext::load(dy).add(Ext::load(load32(w(P_LOCATION, 1)))).store());
        store32(w(P_LOCATION, 2), Ext::load(dz).add(Ext::load(load32(w(P_LOCATION, 2)))).store());
    }
    none_active as u32
}

// ---------------------------------------------------------------------------
// The render-iterator protocol's CurrentItem loop (docs/particles.md "Per frame").

const ITEM_CAP: usize = COUNT as usize;
/// `particle_items`' answer for a proxy the image cannot address: nothing ran.
const NOT_RUN: u32 = u32::MAX;
/// `particle_items`' output: the item count, the number of particles a refused move
/// deleted, then five words an item (DrawScale, ScaleGlow, then the proxy's Location after
/// its move), float32 bits.
static mut ITEMS: [u32; 2 + 5 * ITEM_CAP] = [0; 2 + 5 * ITEM_CAP];

#[no_mangle]
pub extern "C" fn particle_items_ptr() -> *const u32 {
    addr_of!(ITEMS) as *const u32
}

/// SetupDynamics' loop over a ParticleIterator (script-particles.mjs
/// `particleIteratorItems`, Engine's URenderIterator and DeusEx's
/// UParticleIterator::CurrentItem 0x1001ab20) from `start` below `max`, on the
/// iterator image at `base` and its proxy `proxy` (an image actor): for each Index,
/// Index is stored; for an active particle the proxy's DrawScale and ScaleGlow take
/// the particle's, and FarMoveActor(proxy, particle Location, 0, 0) (render.rs
/// `far_plan`) either moves the proxy (the item is recorded) or fails, which
/// DeleteParticle's the particle (0x1001aaf0: bActive cleared, nextFreeParticle the
/// index). Returns the Index of the first step the host must take, `max` when the
/// loop is complete: a move `far_plan` declines (a zone change, which runs script
/// events; a nonzero extent; ...) stops the loop before that step's DrawScale and
/// ScaleGlow stores, and everything before it is done. A proxy the image cannot
/// address returns NOT_RUN before any store. The items are in `ITEMS`.
#[no_mangle]
pub extern "C" fn particle_items(base: u32, proxy: u32, model: u32, world: u32, start: u32, max: u32) -> u32 {
    let items = addr_of_mut!(ITEMS) as *mut u32;
    let mut count = 0usize;
    let mut failed = 0u32;
    let a = Obj::of(proxy);
    let mut index = start;
    if !a.has(FAR_MOVE_FIELDS | ITEM_FIELDS) {
        unsafe {
            *items = 0;
            *items.add(1) = 0;
        }
        return NOT_RUN;
    }
    while index < max {
        store32(base + pf(P_INDEX), index);
        if index < COUNT {
            let particle = base + pf(P_ARRAY) + index * pf(P_STRIDE);
            let active_at = particle + pf(P_ACTIVE);
            if load32(active_at) & pf(P_ACTIVE_MASK) != 0 {
                let word = |member: usize, k: u32| load32(particle + pf(member) + 4 * k);
                let at = [word(P_LOCATION, 0), word(P_LOCATION, 1), word(P_LOCATION, 2)];
                let plan = far_plan(&a, model, world, at, 0);
                if let FarMove::Declined = plan {
                    break;
                }
                let (draw_scale, scale_glow) = (word(P_DRAWSCALE, 0), word(P_SCALEGLOW, 0));
                a.set_word(R_DRAWSCALE, 0, draw_scale);
                a.set_word(R_SCALEGLOW, 0, scale_glow);
                match plan {
                    FarMove::Moved(region) => {
                        far_commit(&a, at, region);
                        let item = unsafe { items.add(2 + 5 * count) };
                        unsafe {
                            *item = draw_scale;
                            *item.add(1) = scale_glow;
                            *item.add(2) = at[0];
                            *item.add(3) = at[1];
                            *item.add(4) = at[2];
                        }
                        count += 1;
                    }
                    _ => {
                        // DeleteParticle (0x1001aaf0).
                        store32(active_at, load32(active_at) & !pf(P_ACTIVE_MASK));
                        store32(base + pf(P_NEXTFREE), index);
                        failed += 1;
                    }
                }
            }
        }
        index += 1;
    }
    unsafe {
        *items = count as u32;
        *items.add(1) = failed;
    }
    index
}
