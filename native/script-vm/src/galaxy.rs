//! UGalaxyAudioSubsystem::Update's and PlaySound's x87 arithmetic (Galaxy.dll
//! 606e71d1..., Update 0x10609510, PlaySound 0x10608100, docs/galaxy-audio.md),
//! the integer form of the JavaScript body in src/runtime/galaxy-audio.mjs.
//!
//! That body stays as the reference (`updateLockedReference`, run when the
//! kernel is not loaded or `options.kernel` is null); scripts/
//! validate-galaxy-audio-kernel.mjs runs both over the oracle validator's cases
//! and compares every channel word. The host (galaxy-audio.mjs, through
//! galaxy-update-kernel.mjs) keeps what is JavaScript's: the world reads
//! (Location, SoundRadius, ...), the channel records with their actors, sounds and
//! voices, and the services (FastLineCheck, GlobalLighting, the voices, FPATAN's
//! host `atan2`). Every x87 value of Update and PlaySound is computed here, on the
//! 80-bit model (x87.rs, the game thread's precision control), in the order of the
//! JavaScript body, one float32 store (FST/FSTP) where it has one.
//!
//! Values cross as float32 bit patterns in the IO block below, never as floats,
//! so a NaN keeps its payload and a zero its sign. The block lives in this
//! module's statics; the host writes the Update's context once (`C_*`), then
//! per call the inputs (`P_*`, `H_*`, `T_*`) and reads the results (`O_*`). No
//! state is kept between calls except that block.

use crate::x87::Ext;

/// IO block words. The layout is mirrored by galaxy-update-kernel.mjs.
pub const IO_WORDS: usize = 256;
// The Update's context (written once per Update).
const C_DT: usize = 0; // f64 (2 words): the prologue's clamped delta time
const C_LISTENER: usize = 2; // 3: the listener's Location
const C_ORIGIN: usize = 5; // 3: the listener FCoords' origin
const C_AXES: usize = 8; // 9: its X, Y and Z axes
const C_AMBIENT: usize = 17; // UGalaxyAudioSubsystem +0x58, the ambient volume factor
const C_DOPPLER: usize = 18; // +0x5c, DopplerSpeed
const C_SOUND: usize = 19; // +0x6a, SoundVolume (a byte)
const C_SPEECH: usize = 20; // +0x6b, SpeechVolume (a byte)
const C_REVERSE: usize = 21; // +0x4c, ReverseStereo
const C_SURROUND: usize = 22; // +0x34, UseSurround
// PlaySound's source and the listener (also the exact range test's).
const P_LOC: usize = 24; // 3
const P_LISTENER: usize = 27; // 3
// The channel in flight.
const H_LOC: usize = 32; // 3: its Location
const H_TIME: usize = 35; // +0x30
const H_RADIUS: usize = 36; // +0x24
const H_VOLUME: usize = 37; // +0x20
const H_PITCH: usize = 38; // +0x28
const H_OCCLUSION: usize = 39; // +0x3c
const H_FLAGS: usize = 40; // F_OCCLUDED | F_SPEECH | F_DOPPLER
const H_VEL: usize = 41; // 3: the actor's Velocity
const H_RATE: usize = 44; // the sample's SamplesPerSec (an int)
const H_ANGLE: usize = 45; // appAtan2's result, stored float32
// Results.
const O_TIME: usize = 48;
const O_PRIORITY: usize = 49;
const O_LOCAL: usize = 50; // 3: the Location in listener space
const O_ATAN_X: usize = 53; // appAtan2's second operand
const O_OCCLUSION: usize = 54;
const O_VOLUME: usize = 55; // the voice volume (an int)
const O_PAN: usize = 56; // the pan (an int)
const O_FREQUENCY: usize = 57; // the voice frequency (an int)
const O_AMB_VOLUME: usize = 58;
const O_AMB_DOUBLE: usize = 59;
const O_AMB_LIGHT: usize = 60;
const O_AMB_RADIUS: usize = 61;
const O_AMB_PITCH: usize = 62;
// The reverb tail's zone fields in, and the 27-word glxReverb block out.
const R_MASTER: usize = 192; // MasterGain (a byte)
const R_CUTOFF: usize = 193; // CutoffHz, clamped by the host's | 0 to an int
const R_DELAYS: usize = 194; // 6: Delay bytes
const R_GAINS: usize = 200; // 6: Gain bytes
const O_REVERB: usize = 224; // 27 words
// PlaySound's channel table: the Id and the Priority of each channel.
const MAX_CHANNELS: usize = 64;
const T_IDS: usize = 64;
const T_PRIORITIES: usize = 128;

const F_OCCLUDED: u32 = 1;
const F_SPEECH: u32 = 2;
const F_DOPPLER: u32 = 4;

#[repr(align(16))]
struct Io([u32; IO_WORDS]);
static mut IO: Io = Io([0; IO_WORDS]);

#[no_mangle]
pub extern "C" fn galaxy_io_ptr() -> *mut u32 {
    core::ptr::addr_of_mut!(IO) as *mut u32
}
#[no_mangle]
pub extern "C" fn galaxy_max_channels() -> u32 {
    MAX_CHANNELS as u32
}

fn io(i: usize) -> u32 {
    unsafe { (*core::ptr::addr_of!(IO)).0[i] }
}
fn put(i: usize, value: u32) {
    unsafe { (*core::ptr::addr_of_mut!(IO)).0[i] = value };
}
/// FLD m32 of an IO word.
fn ld(i: usize) -> Ext {
    Ext::load(io(i))
}
fn triple(at: usize) -> [u32; 3] {
    [io(at), io(at + 1), io(at + 2)]
}

/// FLD m64 of an embedded double (script-vm.mjs `x87double`).
fn c64(value: f64) -> Ext {
    Ext::load_f64(value)
}
/// The Update's delta time as the JavaScript body holds it: the host has
/// clamped it to [0, 1] already (a NaN or negative is 0, 1 above), so it is a
/// finite double, FLD m64.
fn dt() -> Ext {
    c64(f64::from_bits((io(C_DT + 1) as u64) << 32 | io(C_DT) as u64))
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Cmp {
    Lt,
    Eq,
    Gt,
    Un,
}

/// FCOM's condition codes as script-vm.mjs `x87cmp` gives them: 'un' for a
/// NaN, an infinity ordered by its sign, else the sign of the exact
/// difference. (`Ext::compare` is the locomotion model's, which never calls
/// an infinity pair below.)
pub(crate) fn cmp(a: Ext, b: Ext) -> Cmp {
    if a.nan() || b.nan() {
        return Cmp::Un;
    }
    if a.inf() || b.inf() {
        if a.inf() && b.inf() && a.sign == b.sign {
            return Cmp::Eq;
        }
        if a.inf() {
            return if a.sign != 0 { Cmp::Lt } else { Cmp::Gt };
        }
        return if b.sign != 0 { Cmp::Gt } else { Cmp::Lt };
    }
    let (below, equal) = a.compare(b);
    if equal {
        Cmp::Eq
    } else if below {
        Cmp::Lt
    } else {
        Cmp::Gt
    }
}
/// `test ah, 1` after FCOM (C0): below or unordered.
pub(crate) fn below(c: Cmp) -> bool {
    matches!(c, Cmp::Lt | Cmp::Un)
}
fn sub(a: Ext, b: Ext) -> Ext {
    a.add(b.neg())
}
/// Core `appSqrt` (IAT 0x10699730): FLD m64 of the double the caller stored,
/// FSQRT. (A NaN comes back quieted, as the hardware does.)
fn app_sqrt(sum: Ext) -> Ext {
    let double = sum.store_double();
    if double.nan() {
        double.quiet()
    } else {
        double.sqrt()
    }
}
/// (dx*dx + dy*dy) + dz*dz over the float differences, kept extended.
fn distance_squared(a: [u32; 3], b: [u32; 3]) -> Ext {
    let d = |i: usize| sub(Ext::load(a[i]), Ext::load(b[i]));
    let (dx, dy, dz) = (d(0), d(1), d(2));
    dx.mul(dx).add(dy.mul(dy)).add(dz.mul(dz))
}
/// The Priority formula of PlaySound and Update: (1.0 - sqrt(d^2) / Radius) *
/// Volume, left extended.
fn priority(location: [u32; 3], listener: [u32; 3], radius: u32, volume: u32) -> Ext {
    sub(c64(1.0), app_sqrt(distance_squared(location, listener)).div(Ext::load(radius))).mul(Ext::load(volume))
}
/// clamp(v, 0, 0x7fff) of an _ftol result.
fn clamp_word(v: i32) -> i32 {
    if v < 0 {
        0
    } else if v >= 0x7fff {
        0x7fff
    } else {
        v
    }
}

/// Whether an ambient sound's radius ((SoundRadius & 0xff) + 1) * 25 reaches
/// the listener: radius*radius >= dist^2, kept extended (Update's compare,
/// 0x10609510; `ambientInRangeExact`). Location at P_LOC, listener at P_LISTENER.
#[no_mangle]
pub extern "C" fn galaxy_in_range_exact(sound_radius: u32) -> u32 {
    u32::from(in_range_exact(triple(P_LOC), triple(P_LISTENER), sound_radius))
}

/// `ambient_in_range` (the doubles screen, then the extended compare) for the Location at P_LOC and the listener at P_LISTENER: the
/// decision render.rs `ambient_scan` makes, exported so that validate-galaxy-audio-kernel compares it with `ambientInRange`.
#[no_mangle]
pub extern "C" fn galaxy_in_range(sound_radius: u32) -> u32 {
    u32::from(ambient_in_range(triple(P_LOC), triple(P_LISTENER), sound_radius))
}

/// `galaxy_in_range_exact` over a Location and a listener given as float32 bits.
fn in_range_exact(location: [u32; 3], listener: [u32; 3], sound_radius: u32) -> bool {
    let radius = Ext::load_i32(((sound_radius & 0xff) + 1) as i32).mul(c64(25.0));
    let squared = distance_squared(location, listener);
    !below(cmp(radius.mul(radius), squared))
}

/// `ambientInRange` (galaxy-audio.mjs) for the ambient scan in render.rs: the answer the JavaScript decides in doubles when the squared
/// distance is not within 1e-9 (relative) of the squared radius (its operations, in its order: float32 differences and their squares
/// are the doubles the host computes), and `in_range_exact` otherwise or for a NaN. The Location and the listener are float32 bits.
pub(crate) fn ambient_in_range(location: [u32; 3], listener: [u32; 3], sound_radius: u32) -> bool {
    let reach = ((sound_radius & 0xff) + 1) as f64 * 25.0;
    let reach2 = reach * reach;
    let d = |i: usize| f32::from_bits(location[i]) as f64 - f32::from_bits(listener[i]) as f64;
    let (dx, dy, dz) = (d(0), d(1), d(2));
    let d2 = dx * dx + dy * dy + dz * dz;
    let gap = d2 - reach2;
    let margin = (reach2 + d2) * 1e-9;
    if gap > margin {
        return false;
    }
    if -gap > margin {
        return true;
    }
    in_range_exact(location, listener, sound_radius)
}

/// An ambient actor's values (`ambientVolume`, `ambientRadius` and the pitch
/// of Update's scan and refresh) into O_AMB_*: Volume = SoundVolume *
/// AmbientFactor * (1/255) as one float32; the refresh's twice that; the
/// refresh's light scale (LightBrightness * volume * (1/255)) of the doubled
/// float32; Radius = (SoundRadius + 1) * 25; Pitch = SoundPitch * (1/64).
#[no_mangle]
pub extern "C" fn galaxy_ambient(sound_radius: u32, sound_volume: u32, sound_pitch: u32, brightness: u32) {
    let base = Ext::load_i32((sound_volume & 0xff) as i32).mul(ld(C_AMBIENT)).mul(c64(1.0 / 255.0));
    put(O_AMB_VOLUME, base.store());
    let doubled = base.add(base).store();
    put(O_AMB_DOUBLE, doubled);
    put(O_AMB_LIGHT, Ext::load_i32((brightness & 0xff) as i32).mul(Ext::load(doubled)).mul(c64(1.0 / 255.0)).store());
    put(O_AMB_RADIUS, Ext::load_i32(((sound_radius & 0xff) + 1) as i32).mul(c64(25.0)).store());
    put(O_AMB_PITCH, Ext::load_i32((sound_pitch & 0xff) as i32).mul(c64(0.015625)).store());
}

/// PlaySound's priority and channel choice (0x10608100 steps 3 and 4) for the
/// sound at P_LOC with the Radius and Volume at H_RADIUS and H_VOLUME, over
/// `count` channels whose Ids and Priorities are at T_IDS and T_PRIORITIES.
/// The new Priority is stored at O_PRIORITY. Returns the channel index the
/// sound takes, -1 when none has a lower Priority, -2 when the matching Id
/// has NoOverride (bit 0) set.
#[no_mangle]
pub extern "C" fn galaxy_play(id: i32, count: u32) -> i32 {
    let mut running = priority(triple(P_LOC), triple(P_LISTENER), io(H_RADIUS), io(H_VOLUME));
    put(O_PRIORITY, running.store());
    let mut chosen = -1;
    for index in 0..(count as usize).min(MAX_CHANNELS) {
        if ((io(T_IDS + index) as i32 ^ id) & !1) == 0 {
            if id & 1 != 0 {
                return -2;
            }
            chosen = index as i32;
            break;
        }
        let other = ld(T_PRIORITIES + index);
        if !below(cmp(running, other)) {
            running = other;
            chosen = index as i32;
        }
    }
    chosen
}

/// Update's per-channel step up to FPATAN: the play time (+0x30), the
/// Priority refresh, the Location in listener space (three float-stored dot
/// products with the FCoords axes) and appAtan2's operands: local.x is the
/// first, O_ATAN_X (|local.z|, FCHS only below 0) the second. The channel is
/// at H_*.
#[no_mangle]
pub extern "C" fn galaxy_channel_pre() {
    put(O_TIME, ld(H_TIME).add(dt()).store());
    let location = triple(H_LOC);
    put(O_PRIORITY, priority(location, triple(C_LISTENER), io(H_RADIUS), io(H_VOLUME)).store());
    let v = |i: usize| sub(Ext::load(location[i]), ld(C_ORIGIN + i));
    let (v0, v1, v2) = (v(0), v(1), v(2));
    for k in 0..3 {
        let axis = C_AXES + 3 * k;
        put(O_LOCAL + k, v0.mul(ld(axis)).add(v1.mul(ld(axis + 1))).add(v2.mul(ld(axis + 2))).store());
    }
    let z = io(O_LOCAL + 2);
    put(O_ATAN_X, if below(cmp(Ext::load(z), c64(0.0))) { z ^ 0x8000_0000 } else { z });
}

/// Update's per-channel step after FPATAN (H_ANGLE): the pan, the occlusion
/// ramp, the voice volume, the Doppler shift and the voice frequency, into
/// O_PAN, O_OCCLUSION, O_VOLUME and O_FREQUENCY. The listener-space Location
/// is galaxy_channel_pre's (O_LOCAL).
#[no_mangle]
pub extern "C" fn galaxy_channel_post() {
    let dt = dt();
    let flags = io(H_FLAGS);
    let radius = ld(H_RADIUS);
    let local = [ld(O_LOCAL), ld(O_LOCAL + 1), ld(O_LOCAL + 2)];
    let angle = ld(H_ANGLE);
    // Pan: appAtan2(local.x, |local.z|), scaled by dist / (0.1 * Radius)
    // inside that radius, then ftol(angle * 28671.125f * (1/pi) + 16383.0).
    let near_radius = Ext::load(radius_times_tenth(radius));
    let lateral = local[1].mul(local[1]).add(local[0].mul(local[0])).add(local[2].mul(local[2]));
    let lateral_stored = Ext::load(lateral.store());
    let distance = app_sqrt(lateral);
    let scaled = if cmp(near_radius.mul(near_radius), lateral_stored) == Cmp::Gt {
        distance.div(near_radius).mul(angle)
    } else {
        angle
    };
    let mut pan = clamp_word(
        scaled.mul(Ext::load(0x46df_fe40)).mul(c64(0.3183098861837907)).add(c64(16383.0)).ftol(),
    );
    // The distance factor: clamp(1 - dist / Radius, 0, 1), one float store.
    let mut attenuation = sub(c64(1.0), distance.div(radius));
    if below(cmp(attenuation, c64(0.0))) {
        attenuation = c64(0.0);
    } else if !below(cmp(attenuation, c64(1.0))) {
        attenuation = c64(1.0);
    }
    let distance_factor = attenuation.store();
    // Occlusion (+0x3c): min(occ + dt, 0.5) when occluded, else max(occ - dt, 0).
    let occlusion = if flags & F_OCCLUDED != 0 {
        let sum = ld(H_OCCLUSION).add(dt);
        if cmp(c64(0.5), sum) == Cmp::Gt { sum.store() } else { c64(0.5).store() }
    } else {
        let difference = sub(ld(H_OCCLUSION), dt);
        if below(cmp(c64(0.0), difference)) { difference.store() } else { c64(0.0).store() }
    };
    put(O_OCCLUSION, occlusion);
    let mut factor = sub(c64(1.0), Ext::load(occlusion).add(Ext::load(occlusion)));
    if !below(cmp(c64(0.33), factor)) {
        factor = c64(0.33);
    }
    // The category ratio of SoundVolume and SpeechVolume (FILD, FDIV/FMUL).
    let (sound, speech) = (io(C_SOUND) as i32, io(C_SPEECH) as i32);
    let inv_255 = Ext::load(0x3b80_8081);
    let mut ratio = Ext::load(0x3f80_0000);
    if flags & F_SPEECH != 0 {
        if sound > speech {
            ratio = Ext::load_i32(speech).div(Ext::load_i32(sound));
        } else if sound == speech {
            ratio = Ext::load_i32(sound).mul(inv_255);
        }
    } else if sound < speech {
        ratio = Ext::load_i32(sound).div(Ext::load_i32(speech));
    } else if sound == speech {
        ratio = Ext::load_i32(sound).mul(inv_255);
    }
    let mut volume = clamp_word(
        factor.mul(Ext::load(distance_factor)).mul(ratio).mul(ld(H_VOLUME)).mul(Ext::load(0x46ff_fe00)).ftol(),
    );
    if io(C_REVERSE) != 0 {
        pan = 0x7fff - pan;
    }
    if below(cmp(local[2], c64(0.0))) && io(C_SURROUND) != 0 {
        pan = 0xc000;
    }
    if volume < 0x80 {
        volume = 0x80;
    }
    // Doppler on an ambient channel: 1 - dot(SafeNormal(actor - listener),
    // Velocity) / DopplerSpeed, clamped to [0.5, 2].
    let mut doppler = 0x3f80_0000;
    if flags & F_DOPPLER != 0 {
        let there = triple(H_LOC);
        let listener = triple(C_LISTENER);
        let difference = |i: usize| sub(Ext::load(there[i]), Ext::load(listener[i])).store();
        let direction = crate::safe_normal([difference(0), difference(1), difference(2)]);
        let d = |i: usize| Ext::load(direction[i]);
        let dot = d(2).mul(ld(H_VEL + 2)).add(d(1).mul(ld(H_VEL + 1))).add(d(0).mul(ld(H_VEL)));
        let mut shift = sub(c64(1.0), dot.div(ld(C_DOPPLER)));
        if below(cmp(shift, c64(0.5))) {
            shift = c64(0.5);
        } else if !below(cmp(shift, c64(2.0))) {
            shift = c64(2.0);
        }
        doppler = shift.store();
    }
    let frequency = Ext::load_i32(io(H_RATE) as i32).mul(ld(H_PITCH)).mul(Ext::load(doppler)).ftol();
    put(O_PAN, pan as u32);
    put(O_VOLUME, volume as u32);
    put(O_FREQUENCY, frequency as u32);
}

/// nearRadius = float32(Radius * 0.1), the radius a pan scales inside.
fn radius_times_tenth(radius: Ext) -> u32 {
    radius.mul(c64(0.1)).store()
}

/// The listener's eye for FastLineCheck: EyeHeight (+0x3f8) + Location.z,
/// an FADD of two floats and one float store (Update step 5).
#[no_mangle]
pub extern "C" fn galaxy_eye(eye_height: u32, z: u32) -> u32 {
    Ext::load(eye_height).add(Ext::load(z)).store()
}

/// Step 12's `time = float(next + 0.1)`, the double at 0x1063d768 (0x1060a259).
#[no_mangle]
pub extern "C" fn galaxy_add_tenth(next: u32) -> u32 {
    Ext::load(next).add(c64(0.1)).store()
}

/// Update's reverb tail (0x1060aa15..0x1060ab93, docs/galaxy-music/reverb.md §2) for a
/// reverb zone: a zeroed 27-word glxReverb at O_REVERB with Volume (+0xc) =
/// float(MasterGain * 1/255), HFDamp (+0x10) = float(clamp(CutoffHz, 0, 44100)) and, for six
/// delays at +0x34 + 8i, Time = float(clamp(Delay * 0.002f, 0.001f, 0.34f)) and Gain =
/// float(clamp(Gain * (1/255)f, 0.001f, 0.999f)), each clamp an FCOM (below or unordered)
/// and a replacement. At the game thread's precision control, as galaxy-audio.mjs's
/// `precisionMul` at 64.
#[no_mangle]
pub extern "C" fn galaxy_reverb() {
    const TIME_SCALE: u32 = 0x3b03_126f; // 0.002f (0x1063d6c4)
    const MIN: u32 = 0x3a83_126f; // 0.001f (0x1063d6c0)
    const MAX_TIME: u32 = 0x3eae_147b; // 0.34f (0x1063d6bc)
    const MAX_GAIN: u32 = 0x3f7f_be77; // 0.999f (0x1063d6b8)
    for i in 0..27 {
        put(O_REVERB + i, 0);
    }
    put(O_REVERB + 3, Ext::load_i32((io(R_MASTER) & 0xff) as i32).mul(c64(1.0 / 255.0)).store());
    let cutoff = (io(R_CUTOFF) as i32).clamp(0, 44100);
    put(O_REVERB + 4, Ext::load_i32(cutoff).store());
    // value < low -> low; else not below high -> high; else value.
    let clamp = |value: Ext, low: u32, high: u32| -> u32 {
        if below(cmp(value, ld_const(low))) {
            low
        } else if below(cmp(value, ld_const(high))) {
            value.store()
        } else {
            high
        }
    };
    for i in 0..6 {
        let time = Ext::load_i32((io(R_DELAYS + i) & 0xff) as i32).mul(ld_const(TIME_SCALE));
        put(O_REVERB + 13 + 2 * i, clamp(time, MIN, MAX_TIME));
        let gain = Ext::load_i32((io(R_GAINS + i) & 0xff) as i32).mul(ld_const(0x3b80_8081));
        put(O_REVERB + 14 + 2 * i, clamp(gain, MIN, MAX_GAIN));
    }
}
fn ld_const(bits: u32) -> Ext {
    Ext::load(bits)
}
