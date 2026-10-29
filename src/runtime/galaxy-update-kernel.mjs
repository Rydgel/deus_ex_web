/** The host side of native/script-vm/src/galaxy.rs: UGalaxyAudioSubsystem's
 * PlaySound and Update arithmetic (docs/galaxy-audio.md "Update in Rust") on
 * the Rust x87 model, called from galaxy-audio.mjs in place of its BigInt
 * body once the script VM kernel is loaded. The JavaScript body stays as the
 * reference; scripts/validate-galaxy-audio-kernel.mjs runs both.
 *
 * Everything crosses through one block of 32-bit words in the kernel
 * instance's memory (galaxy.rs lists them): a float is written as a
 * JavaScript number into a Float32Array view, which rounds as FLD m32 of the
 * stored word does, and a result is read back from it. Nothing is allocated
 * per call. The views are made again when the memory grows (the kernel's
 * allocator is the only thing that grows it).
 *
 * The first-half/second-half split of a channel (`pre`, `angle`, `post`) is
 * FPATAN: the host's `atan2` runs between them, as `services.atan2` does in
 * the JavaScript body. */
export const IO_WORDS = 192;
// galaxy.rs's block.
const C_DT = 0, C_LISTENER = 2, C_ORIGIN = 5, C_AXES = 8, C_AMBIENT = 17, C_DOPPLER = 18, C_SOUND = 19, C_SPEECH = 20,
  C_REVERSE = 21, C_SURROUND = 22;
const P_LOC = 24, P_LISTENER = 27;
const H_LOC = 32, H_TIME = 35, H_RADIUS = 36, H_VOLUME = 37, H_PITCH = 38, H_OCCLUSION = 39, H_FLAGS = 40, H_VEL = 41, H_RATE = 44,
  H_ANGLE = 45;
const O_TIME = 48, O_PRIORITY = 49, O_LOCAL = 50, O_ATAN_X = 53, O_OCCLUSION = 54, O_VOLUME = 55, O_PAN = 56, O_FREQUENCY = 57,
  O_AMB_VOLUME = 58, O_AMB_DOUBLE = 59, O_AMB_LIGHT = 60, O_AMB_RADIUS = 61, O_AMB_PITCH = 62;
const T_IDS = 64, T_PRIORITIES = 128;
const F_OCCLUDED = 1, F_SPEECH = 2, F_DOPPLER = 4;
// Words 46 and 47 are the host's scratch for a float32 argument and the word it turns into (galaxy.rs never touches them).
const S_ARG = 46, S_BITS = 47;

export function createGalaxyUpdateKernel(x, memory) {
  const at = x.galaxy_io_ptr();
  const maxChannels = x.galaxy_max_channels();
  let buffer = null, u32 = null, i32 = null, f32 = null, f64 = null;
  const sync = () => {
    if (memory.buffer === buffer) return;
    buffer = memory.buffer;
    u32 = new Uint32Array(buffer, at, IO_WORDS);
    i32 = new Int32Array(buffer, at, IO_WORDS);
    f32 = new Float32Array(buffer, at, IO_WORDS);
    f64 = new Float64Array(buffer, at, IO_WORDS / 2);
  };
  const put3 = (index, v) => { f32[index] = v[0]; f32[index + 1] = v[1]; f32[index + 2] = v[2]; };
  return Object.freeze({
    maxChannels,
    /** An Update's context: the prologue's clamped delta time (a double in
     * [0, 1]), the listener's Location and FCoords ({origin, x, y, z}), and
     * the subsystem's fields from `config`. */
    begin(dt, listener, coords, config) {
      sync();
      f64[C_DT >> 1] = dt;
      put3(C_LISTENER, listener);
      put3(C_ORIGIN, coords.origin);
      put3(C_AXES, coords.x); put3(C_AXES + 3, coords.y); put3(C_AXES + 6, coords.z);
      f32[C_AMBIENT] = config.ambientFactor;
      f32[C_DOPPLER] = config.dopplerSpeed;
      u32[C_SOUND] = config.soundVolume & 0xff;
      u32[C_SPEECH] = config.speechVolume & 0xff;
      u32[C_REVERSE] = config.reverseStereo ? 1 : 0;
      u32[C_SURROUND] = config.useSurround ? 1 : 0;
    },
    /** ambientInRangeExact's compare, in extended precision. */
    inRangeExact(location, listener, soundRadius) {
      sync();
      put3(P_LOC, location); put3(P_LISTENER, listener);
      return x.galaxy_in_range_exact(soundRadius) !== 0;
    },
    /** An ambient actor's values (read with the getters below): Volume, the
     * refresh's doubled volume, its light-scaled value (`brightness` is
     * LightBrightness), Radius and Pitch. */
    ambient(soundRadius, soundVolume, soundPitch, brightness) {
      sync();
      x.galaxy_ambient(soundRadius, soundVolume, soundPitch, brightness);
    },
    ambientVolume: () => (sync(), f32[O_AMB_VOLUME]),
    ambientDouble: () => (sync(), f32[O_AMB_DOUBLE]),
    ambientLight: () => (sync(), f32[O_AMB_LIGHT]),
    ambientRadius: () => (sync(), f32[O_AMB_RADIUS]),
    ambientPitch: () => (sync(), f32[O_AMB_PITCH]),
    /** PlaySound's priority and channel choice for a sound at `location`
     * heard from `listener`: the channel index, -1 for none, -2 for a
     * matching Id with NoOverride. The new Priority is `priority()`. */
    play(channels, count, id, location, listener, radius, volume) {
      sync();
      for (let index = 0; index < count; index++) {
        const channel = channels[index];
        i32[T_IDS + index] = channel.id; f32[T_PRIORITIES + index] = channel.priority;
      }
      put3(P_LOC, location); put3(P_LISTENER, listener);
      f32[H_RADIUS] = radius; f32[H_VOLUME] = volume;
      return x.galaxy_play(id | 0, count);
    },
    /** A channel record's inputs for `pre` and `post`. */
    channel(channel) {
      sync();
      put3(H_LOC, channel.location);
      f32[H_TIME] = channel.time; f32[H_RADIUS] = channel.radius; f32[H_VOLUME] = channel.volume;
      f32[H_PITCH] = channel.pitch; f32[H_OCCLUSION] = channel.occlusion;
    },
    /** The play time, the Priority and the listener-space Location of the
     * channel `channel()` loaded. */
    pre: () => x.galaxy_channel_pre(),
    time: () => (sync(), f32[O_TIME]),
    priority: () => (sync(), f32[O_PRIORITY]),
    /** FPATAN: appAtan2(local.x, |local.z|) with the host's `atan2`,
     * stored float32 for `post`. */
    angle(atan2) {
      sync();
      f32[H_ANGLE] = Math.fround(atan2(f32[O_LOCAL], f32[O_ATAN_X]));
    },
    /** The pan, occlusion, voice volume and frequency after `angle`;
     * `velocity` is the actor's Velocity for a Doppler channel (else null)
     * and `rate` the sample's SamplesPerSec. */
    post(occluded, speech, velocity, rate) {
      sync();
      u32[H_FLAGS] = (occluded ? F_OCCLUDED : 0) | (speech ? F_SPEECH : 0) | (velocity ? F_DOPPLER : 0);
      if (velocity) put3(H_VEL, velocity);
      i32[H_RATE] = rate | 0;
      x.galaxy_channel_post();
    },
    occlusion: () => (sync(), f32[O_OCCLUSION]),
    volume: () => (sync(), i32[O_VOLUME]),
    pan: () => (sync(), i32[O_PAN]),
    frequency: () => (sync(), i32[O_FREQUENCY]),
    /** EyeHeight + Location.z, one float store. */
    eye(eyeHeight, z) {
      sync();
      f32[S_ARG] = eyeHeight; f32[S_BITS] = z;
      u32[S_BITS] = x.galaxy_eye(u32[S_ARG], u32[S_BITS]);
      return f32[S_BITS];
    },
    /** float(next + 0.1), step 12's analysis time. */
    addTenth(next) {
      sync();
      f32[S_ARG] = next;
      u32[S_BITS] = x.galaxy_add_tenth(u32[S_ARG]);
      return f32[S_BITS];
    },
  });
}
