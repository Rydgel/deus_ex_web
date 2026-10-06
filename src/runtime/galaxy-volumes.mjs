/** UGalaxyAudioSubsystem's instant volumes (Galaxy.dll, docs/galaxy-volumes.md).
 *
 * Actor.SetInstantSoundVolume/SpeechVolume/MusicVolume (natives 268/269/270,
 * Engine exec 0x103e2850/0x103e28d0/0x103e2950) step past the byte argument
 * and call XLevel->Engine->Audio's vtable +0x90/+0x94/+0x98 with it, when the
 * engine has an audio subsystem. Galaxy's bodies:
 *
 * - SetInstantSoundVolume 0x106063d0 / SetInstantSpeechVolume 0x106064f0:
 *   a = SoundVolume * K in 80-bit (FILD, FMUL the double 1/255 at 0x1063d548),
 *   b = float32(SpeechVolume * K) (FSTP to a temporary), the larger one (FCOM:
 *   b when a < b or unordered), times the float 127.0 at 0x1063d530, _ftol,
 *   then the Galaxy call 0x1060ec00(volume, 0), which stores the digital
 *   master volume 0..127 (0x1069817c and the fade target 0x10697ce4, fade step
 *   0x10697ca0 = 0). The new byte replaces SoundVolume (+0x6a) or SpeechVolume
 *   (+0x6b) after the call, so the other one is the stored byte.
 * - SetInstantMusicVolume 0x10606610: float32(clamp(byte * K, 0, 1)); with
 *   UseDigitalMusic (+0x40) glxSetMusicVolume 0x1060eb60 and with UseCDMusic
 *   (+0x3c) the CD volume 0x1060e9a0 take ftol(that * 127.0f); then
 *   MusicVolume (+0x69) = the byte. Its translation is galaxy-music.mjs's
 *   setInstantMusicVolume: Play sets `music` to the subsystem's music
 *   (script-audio-live.mjs), whose bytes are this `state`. Without it only
 *   the byte changes, as both config flags clear would leave it.
 *
 * The three bytes start as the subsystem's config values
 * ([Galaxy.GalaxyAudioSubsystem] MusicVolume/SoundVolume/SpeechVolume). */
import {x87cmp, x87double, x87ftol, x87int32, x87load, x87mul, x87store} from './script-vm.mjs';

const K = x87double(1 / 255);          // 0x1063d548: 0.00392156862745098
const SCALE = x87load(127);            // 0x1063d530: 127.0f

function digitalVolume(sound, speech) {
  const a = x87mul(x87int32(sound & 255), K);
  const b = x87load(x87store(x87mul(x87int32(speech & 255), K)));
  const order = x87cmp(a, b);
  return x87ftol(x87mul(order === 'lt' || order === 'un' ? b : a, SCALE));
}

export function createGalaxyVolumes({musicVolume = 0, soundVolume = 0, speechVolume = 0} = {}) {
  const state = {musicVolume: musicVolume & 255, soundVolume: soundVolume & 255, speechVolume: speechVolume & 255,
    // Galaxy's digital master volume (0x1069817c) once a SetInstant call set it.
    digitalVolume: null};
  return {
    state,
    /** galaxy-music.mjs's subsystem music, which handles native 270. */
    music: null,
    /** The Galaxy library service object (galaxy-music-library.mjs), which
     * receives 0x1060ec00(volume, 0) as glxSetSampleVolume. */
    library: null,
    /** Native 268's audio call (vtable +0x90). */
    setInstantSoundVolume(volume) {
      state.digitalVolume = digitalVolume(volume, state.speechVolume);
      this.library?.setSampleVolume(state.digitalVolume, 0);
      state.soundVolume = volume & 255;
    },
    /** Native 269's audio call (vtable +0x94). */
    setInstantSpeechVolume(volume) {
      state.digitalVolume = digitalVolume(state.soundVolume, volume);
      this.library?.setSampleVolume(state.digitalVolume, 0);
      state.speechVolume = volume & 255;
    },
    /** Native 270's audio call (vtable +0x98). */
    setInstantMusicVolume(volume) {
      if (this.music) this.music.setInstantMusicVolume(volume);
      else state.musicVolume = volume & 255;
    },
  };
}
