import { x87load, x87double, x87int32, x87add, x87mul, x87neg, x87cmp, x87store, x87ftol, x87width } from './script-vm.mjs';

/** UGalaxyAudioSubsystem's music (Galaxy.dll 606e71d1…, docs/galaxy-music.md,
 * contract docs/galaxy-music/update-transition.md):
 *
 * - Update's music section 0x1060a50b..0x1060aa15 (`update`), which
 *   galaxy-audio.mjs runs after the channel loop inside Update's lock;
 * - SetVolumes 0x106061b0 (`setVolumes`);
 * - SetInstantMusicVolume 0x10606610 (`setInstantMusicVolume`, native 270's
 *   vtable +0x98);
 * - UnregisterMusic 0x10606e60 (`unregisterMusic`, vtable +0x70, also Engine
 *   UMusic::Destroy 0x10370d4c);
 * - the UMusic Data lifecycle Update drives: the Engine lazy array's Load
 *   0x1030cbb0 and Unload 0x1030cd90 (FLazyLoader vtable 0x104267fc) and
 *   FArray::Add(1024) 0x1060a708..0x1060a735.
 *
 * Subsystem fields: `state.current` +0x888 (UMusic*), `state.cdTrack` +0x88c,
 * `state.section` +0x88d, `state.fade` +0x900 (float32 MusicFade). The
 * constructor 0x10604a20 stores +0x900 = 1.0f and +0x88c = 0xff; +0x888 and
 * +0x88d have no store and start at the object allocation's zero (not
 * observable while +0x888 is 0 and +0x88c is 0xff: the first transition then
 * writes both). The config bytes MusicVolume +0x69, SoundVolume +0x6a and
 * SpeechVolume +0x6b are `config.volumes`, shared with galaxy-volumes.mjs.
 *
 * x87: the bodies' arithmetic is FLD/FILD (exact), FMUL/FSUB rounded to the
 * precision control (`config.precision`: 64, 53 or 24 significand bits; 64 is
 * what galaxy-audio.mjs assumes), FST m32 rounding the register to float32,
 * FCOM on the unrounded register values, and MSVCRT _ftol (truncation of the
 * register value). Which control word the game thread runs Update under is
 * open (update-transition.md §8.1); the oracle checks all three.
 *
 * Services:
 * - `library`: the glx* service object (galaxy-music-library.mjs);
 * - `music(song)`: the UMusic behind an object reference, as
 *   {fullName, handle (+0x48, read/write), lazy {savedPosition, num, max, data}
 *   (the TLazyArray<BYTE> at +0x28: SavedPos +0x30, Data/Num/Max +0x34..0x3c),
 *   load() (the lazy loader's Load, Engine 0x1030cbb0 over the music's
 *   archive), realloc(lazy) (FArray::Realloc(1): storage resized to Max,
 *   contents kept), bytes(lazy) (Data[0, Num) as a Uint8Array, never-written
 *   bytes 0)};
 * - `read(actor, name)` / `write(actor, name, value)`: the viewport Actor's
 *   Song (+0x670), SongSection (+0x674), CdTrack (+0x675), Transition (+0x676);
 * - `log(name, text)` (optional): GLog->Logf records, name 781 DevMusic or
 *   767 (the "%s failed: %i" lines);
 * - `trace(event)` (optional): internal calls for validation (setVolumes,
 *   unregister, lazyLoad, lazyUnload, realloc).
 *
 * The CD audio branches (UseCDMusic: glxStopCDAudio 0x10618290,
 * glxStartCDAudio 0x10611c70, the CD volume 0x1060e9a0) are not translated;
 * a config that enables them is refused. The +0x88c byte itself is
 * translated: it steers the transition whatever UseCDMusic says. */
const bits64 = hex => { const view = new DataView(new ArrayBuffer(8)); view.setBigUint64(0, BigInt(`0x${hex}`)); return x87double(view.getFloat64(0)); };
const K = bits64('3f70101010101010');                 // 0x1063d548: 1/255
const ZERO_D = bits64('0000000000000000');            // 0x1063d538: 0.0
const ONE_D = bits64('3ff0000000000000');             // 0x1063c0e8: 1.0
const ZERO_F = x87load(0);                            // 0x1063d528: 0.0f
const SCALE_F = x87load(127);                         // 0x1063d530: 127.0f
const FADE_K = bits64('bf60624dd2f1a9fc');            // 0x1063d6f8: -0.002 (Fade)
const SLOW_RATE = bits64('3fc999999999999a');         // 0x1063d678: 0.2 (SlowFade)
const SLOW_K = bits64('bf3a36e2eb1c432d');            // 0x1063d6e8: -0.0004
const FAST_RATE = bits64('4008000000000000');         // 0x1063d6d8: 3.0 (FastFade)
const FAST_K = bits64('bf789374bc6a7efa');            // 0x1063d6c8: -0.006
const ONE_F = 1;                                       // 0x3f800000 (0x1060a663, ctor 0x10604aba)
const SLACK = 0x400;                                   // Data.Add(0x400) 0x1060a711
const DEV_MUSIC = 781, WARNING = 767;                  // 0x30d, 0x2ff
const GLX_SETPOSITION2 = 2;                          // update-transition.md §2.4

export const MUSIC_TRANSITION = Object.freeze({None: 0, Instant: 1, Segue: 2, Fade: 3, FastFade: 4, SlowFade: 5});

/** Round an exact positive significand to `width` bits, nearest-even. */
function round(neg, sig, exp, width) {
  if (sig === 0n) return {neg, sig, exp: 0};
  const n = x87width(sig);
  if (n <= width) return {neg, sig, exp};
  const shift = n - width, sh = BigInt(shift);
  let q = sig >> sh;
  const rem = sig - (q << sh), half = 1n << (sh - 1n);
  if (rem > half || (rem === half && (q & 1n))) q += 1n;
  if (x87width(q) > width) return {neg, sig: q >> 1n, exp: exp + shift + 1};
  return {neg, sig: q, exp: exp + shift};
}
const finite = v => v.nan === undefined && !v.inf;

/** FMUL / FADD / FSUB under precision control `width`: the exact result
 * rounded once to the control's significand width (at 64 bits this equals
 * script-vm.mjs's x87mul/x87add). Non-finite operands keep the 64-bit model's
 * rules (they do not occur on these paths). */
export function x87Arithmetic(width) {
  const mul = (a, b) => {
    if (!finite(a) || !finite(b)) return x87mul(a, b);
    if (a.sig === 0n || b.sig === 0n) return {neg: a.neg ^ b.neg, sig: 0n, exp: 0};
    return round(a.neg ^ b.neg, a.sig * b.sig, a.exp + b.exp, width);
  };
  const add = (a, b) => {
    if (!finite(a) || !finite(b)) return x87add(a, b);
    if (a.sig === 0n) return b.sig === 0n ? {neg: a.neg & b.neg, sig: 0n, exp: 0} : round(b.neg, b.sig, b.exp, width);
    if (b.sig === 0n) return round(a.neg, a.sig, a.exp, width);
    const exp = Math.min(a.exp, b.exp);
    const sum = (a.neg ? -(a.sig << BigInt(a.exp - exp)) : a.sig << BigInt(a.exp - exp))
      + (b.neg ? -(b.sig << BigInt(b.exp - exp)) : b.sig << BigInt(b.exp - exp));
    if (sum === 0n) return {neg: a.neg & b.neg, sig: 0n, exp: 0};
    return sum < 0n ? round(1, -sum, exp, width) : round(0, sum, exp, width);
  };
  return {mul, add, sub: (a, b) => add(a, x87neg(b))};
}

/** FCOM against an operand, then `test ah, 1` (C0: below or unordered). */
const below = (a, b) => { const c = x87cmp(a, b); return c === 'lt' || c === 'un'; };

export function createGalaxyMusic(config, services) {
  if (config.useCDMusic) throw new Error('Galaxy UseCDMusic (glxStartCDAudio/glxStopCDAudio/CD volume) is not translated');
  const precision = config.precision ?? 64;
  if (![64, 53, 24].includes(precision)) throw new Error(`Galaxy music: x87 precision ${precision} is not a control-word width`);
  const {mul, sub} = x87Arithmetic(precision);
  const {library, read, write} = services;
  const volumes = config.volumes;
  const useDigitalMusic = Boolean(config.useDigitalMusic);
  const latency = config.latency | 0, effectsChannels = config.effectsChannels | 0;
  const log = services.log ?? null, trace = services.trace ?? null;
  // Constructor 0x10604a20: +0x900 = 1.0f, +0x88c = 0xff.
  const state = {current: null, cdTrack: 0xff, section: 0, fade: ONE_F};
  // Latency * k, a FILD times an m64 constant: the same every frame for one
  // control word, so it is computed once.
  const thresholds = {3: mul(x87int32(latency), FADE_K), 5: mul(x87int32(latency), SLOW_K),
    4: mul(x87int32(latency), FAST_K)};

  /** nM, the float32 of clamp(byte * K, 0.0, 1.0) (FCOM m64 0.0 then 1.0). */
  function musicFactor(byte) {
    let value = mul(x87int32(byte & 0xff), K);
    if (below(value, ZERO_D)) value = ZERO_D;
    else if (!below(value, ONE_D)) value = ONE_D;
    return x87store(value);
  }

  /** SetVolumes 0x106061b0. glxSetSampleVolume's and glxSetMusicVolume's
   * nonzero results go to appFailAssert (lines 0x221, 0x223); the volumes
   * built here are always 0..127, where the setters return 0. */
  function setVolumes() {
    trace?.({op: 'setVolumes'});
    const nS = x87store(mul(x87int32(volumes.soundVolume & 0xff), K));
    const nM = musicFactor(volumes.musicVolume);
    const sp = mul(x87int32(volumes.speechVolume & 0xff), K);
    // fld m32 nS; fcomp st1: C0 keeps the register speech value.
    const louder = below(x87load(nS), sp) ? sp : x87load(nS);
    library.setSampleVolume(x87ftol(mul(louder, SCALE_F)), 0);
    if (useDigitalMusic) {
      let fade = x87load(state.fade);
      if (below(fade, ZERO_F)) fade = ZERO_F;
      library.setMusicVolume(x87ftol(mul(mul(fade, x87load(nM)), SCALE_F)), 0);
    }
  }

  /** SetInstantMusicVolume 0x10606610 (native 270, vtable +0x98). Outside
   * Update: no subsystem lock; MusicFade is not applied, so a fading song
   * jumps to the unfaded volume until the next fading frame's SetVolumes.
   * The glxSetMusicVolume result goes to appFailAssert (line 0x25c). */
  function setInstantMusicVolume(value) {
    const factor = musicFactor(value & 0xff);
    if (useDigitalMusic) library.setMusicVolume(x87ftol(mul(x87load(factor), SCALE_F)), 0);
    volumes.musicVolume = value & 0xff;
  }

  /** UnregisterMusic 0x10606e60. */
  function unregisterMusic(song) {
    trace?.({op: 'unregister', music: song});
    if (!song) throw new Error('Galaxy UnregisterMusic: Music is None (appFailAssert "Music", line 0x2cd)');
    const music = services.music(song);
    if (music.handle) {
      if (song !== state.current)
        throw new Error('Galaxy UnregisterMusic: Music != CurrentMusic (appFailAssert "Music==CurrentMusic", line 0x2d0)');
      log?.(DEV_MUSIC, `Unregister music: ${music.fullName}`);
      library.stopMusic();
      const result = library.unloadMusic();
      if (result) log?.(WARNING, `glxUnloadMusic() failed: ${result}`);
      music.handle = 0;
    }
    if (state.current === song) state.current = null;
  }

  /** Data.Load(): the FLazyLoader vtable's slot 0, Engine TLazyArray Load
   * 0x1030cbb0 (script-lazy-byte-array.mjs's translation, run by the
   * adapter over its archive): a positive SavedPos re-reads the bytes, then
   * SavedPos is negated; otherwise nothing. */
  function lazyLoad(music) {
    trace?.({op: 'lazyLoad', music, savedPosition: music.lazy.savedPosition});
    music.load();
  }
  /** Engine TLazyArray Unload 0x1030cd90: a negative SavedPos empties the
   * array (Num = Max = 0, Realloc) and is negated. */
  function lazyUnload(music) {
    const lazy = music.lazy;
    trace?.({op: 'lazyUnload', music, savedPosition: lazy.savedPosition});
    if (lazy.savedPosition >= 0) return;
    lazy.num = 0; lazy.max = 0;
    realloc(music);
    lazy.savedPosition = -lazy.savedPosition | 0;
  }
  function realloc(music) {
    trace?.({op: 'realloc', num: music.lazy.num, max: music.lazy.max});
    music.realloc(music.lazy);
  }

  /** Update 0x1060a50b..0x1060aa15. `dt` is the prologue's stored double
   * [ebp-0x30] as an x87 value (clamped to [0, 1]); `actor` is
   * Viewport->Actor, dereferenced without a null test. */
  function update(dt, actor) {
    const transition = read(actor, 'Transition');
    if (transition === 0) {
      // 0x1060aa09: SongSection = the library's order position.
      write(actor, 'SongSection', library.order());
      return;
    }
    pendingTransition(dt, actor, transition & 0xff);
  }

  /** 0x1060a526..0x1060a908: a transition is pending (Transition != 0). */
  function pendingTransition(dt, actor, transition) {
    const changed = state.current !== read(actor, 'Song');
    if (state.current !== null || state.cdTrack !== 0xff) {
      let done = true;
      if (state.section !== 0xff) {
        let f = null;
        if (transition === 3) f = sub(x87load(state.fade), dt);
        else if (transition === 5) f = sub(x87load(state.fade), mul(dt, SLOW_RATE));
        else if (transition === 4) f = sub(x87load(state.fade), mul(dt, FAST_RATE));
        if (f) {
          state.fade = x87store(f);
          // fcompp on the register f (not the stored float); test ah, 0x41:
          // done when Latency*k > f, ordered.
          done = x87cmp(thresholds[transition], f) === 'gt';
        }
      }
      if (done) {
        // ShutUpMusic.
        if (state.current !== null && changed) unregisterMusic(state.current);
        state.current = null; state.cdTrack = 0xff;
      } else setVolumes();
    }
    // NewMusic.
    if (state.current !== null || state.cdTrack !== 0xff) return;
    state.fade = ONE_F;
    setVolumes();
    state.current = read(actor, 'Song') ?? null;
    state.cdTrack = read(actor, 'CdTrack') & 0xff;
    state.section = read(actor, 'SongSection') & 0xff;
    if (state.current !== null && useDigitalMusic) {
      if (changed) {
        // StartNewMusic.
        const music = services.music(state.current);
        log?.(DEV_MUSIC, `Load music: ${music.fullName}`);
        lazyLoad(music);
        const lazy = music.lazy;
        lazy.num = (lazy.num + SLACK) | 0;
        if (lazy.num > lazy.max) {
          const triple = Math.imul(lazy.num, 3);
          lazy.max = (lazy.num + ((triple + ((triple >> 31) & 7)) >> 3) + 32) | 0;
          realloc(music);
        }
        // glxLoadMusic(&Mem{'MEMO', 0xc, Data, Num, 0}, GLX_LOADFROMMEMORY = 2).
        const result = library.loadMusic(music.bytes(lazy));
        if (result) log?.(WARNING, `glxLoadMusic(&Mem, GLX_LOADFROMMEMORY ) failed: ${result}`);
        music.handle = -1;
        lazyUnload(music);
      }
      setVolumes();
      if (state.section !== 0xff) {
        library.stopMusic();
        library.clearVoiceActive(effectsChannels, 32);
        library.startMusic();
        const result = library.controlMusic(GLX_SETPOSITION2, read(actor, 'SongSection') & 0xff);
        if (result) log?.(WARNING, `glxControlMusic( GLX_SETPOSITION2, Viewport->Actor->SongSection ) failed: ${result}`);
        library.setBreakFlag();
      } else library.stopMusic();
    }
    write(actor, 'Transition', 0);
  }

  return {state, update, setVolumes, setInstantMusicVolume, unregisterMusic};
}
