import {createGalaxyAudio} from './galaxy-audio.mjs';
import {createGalaxyMusic} from './galaxy-music.mjs';
import {createMirrorMusicLibrary} from './galaxy-music-library.mjs';
import {createMusicObjects} from './galaxy-music-objects.mjs';
import {createGalaxyVolumes} from './galaxy-volumes.mjs';
import {hostNow} from './host-clock.mjs';
import {fastLineCheck} from './fast-line-check.mjs';
import {buildWindowSceneFrame} from './script-window-scene-frame.mjs';
import {decodeSoundResource} from './script-sound-resource.mjs';
import {LIGHT_TYPE_UNSUPPORTED} from './mesh-lighting.mjs';
import {lightTypeBrightness} from './static-lighting.mjs';
import {lightGlobals} from './light-globals.mjs';
import {msvcrtWtoi} from './script-text-parser.mjs';
import {RENDER_AMBIENT, RENDER_SHIFT} from './script-vm-render.mjs';
import {mp3Channels, mp3Frames, mp3SampleRate} from './galaxy-lipsync-channels.mjs';

/** Galaxy's channel logic (galaxy-audio.mjs) over the live level: ambient
 * sounds from Update's scan, and PlaySound through execPlaySound and the
 * player's ClientHearSound (docs/galaxy-audio.md "Play").
 *
 * Voices, by the library service (`library`):
 * - Galaxy's own (a worklet library proxy with `effects`, unless
 *   DEUS_EX_SFX is 'webaudio'): RegisterSound runs glxLoadSample in the
 *   proxy's sample registry, and the voices are the library's
 *   (glxStartSample, glxControlSample, glxStopSample, glxControlVoice's
 *   status), mixed on bus B in the worklet (docs/galaxy-audio.md "Effects
 *   through Galaxy's mixer"). Until the worklet first reports (its library
 *   opens on the page's first gesture), the status comes from the host
 *   clock below.
 * - the Web Audio host mapping (?sfx=webaudio, ?music=0, headless): voices
 *   are host records with a clock, and each start/control/stop goes to
 *   `onVoice` for the browser's Web Audio.
 *
 * Host clock (not Galaxy's mixer): a voice plays the sound at `frequency /
 * rate`, loops between the WAV's own `smpl` loop points when it has them,
 * and finishes after its frames otherwise; its clock advances by the elapsed
 * time times its last frequency each Update.
 *
 * Speech (an MP3 USound: conversation, DataLink and bark lines) goes through
 * the same channels and voices (docs/galaxy-audio.md "Speech through
 * Galaxy's voices"). Galaxy's MPEG loader and decoder are not translated, so
 * the sample is a host-decoded record: its rate is the MPEG header's (the
 * loader's record +0x3c), and the 16-bit PCM is the page's decode, asked for
 * with an `onVoice({op: 'decode', sound, bytes, rate})` event when a voice
 * starts and given back through `attachDecoded(sound, pcm)`. It is attached
 * to the library's record while a voice plays it and dropped when none does.
 * The same PCM is Update's lip-sync input (step 12, `setLipSync`). */
const f = Math.fround;

/** RIFF WAVE: sample rate, frame count and the first `smpl` loop. */
export function wavInfo(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = at => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Galaxy sample is not a RIFF WAVE');
  let rate = null, blockAlign = null, frames = null, loop = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = tag(at), size = view.getUint32(at + 4, true), body = at + 8;
    if (id === 'fmt ') { rate = view.getUint32(body + 4, true); blockAlign = view.getUint16(body + 12, true); }
    else if (id === 'data') frames = blockAlign ? Math.floor(size / blockAlign) : null;
    else if (id === 'smpl' && view.getUint32(body + 28, true) > 0) {
      const first = body + 36;
      loop = { start: view.getUint32(first + 8, true), end: view.getUint32(first + 12, true) };
    }
    at = body + size + (size & 1);
  }
  if (!rate || frames === null) throw new Error('Galaxy sample WAVE has no fmt/data chunk');
  return { rate, frames, loop };
}

/** Speech sounds the opt-in ?easter=1 mod plays (docs/easter-egg.md "Voices"): a synthetic Sound object (no package export) to its MP3
 * bytes. Empty unless the mod registered one, so the stock path is unchanged without the flag; decodeSample asks it first and
 * takes the same host-decoded record path an original speech MP3 takes. */
export const moddedSounds = new WeakMap();

/** `library` is the Galaxy library service object (galaxy-music-library.mjs):
 * the browser host's AudioWorklet proxy, or by default the recording mirror.
 * It outlives this runtime: the subsystem's music state does not (see
 * `dispose`). */
export async function createLiveAudio({runtime, level, player, onVoice = null, library = createMirrorMusicLibrary()}) {
  const read = (object, name) => runtime.readNamed(object, name);
  const config = await runtime.classLoader?.prepareConfig?.();
  const setting = key => {
    const text = config?.getString('Galaxy.GalaxyAudioSubsystem', key);
    if (text == null) throw new Error(`Galaxy ${key} is not in DeusEx.ini [Galaxy.GalaxyAudioSubsystem]`);
    return text;
  };
  const bool = key => /^true$/i.test(setting(key).trim());
  // Init (0x10605580) clamps EffectsChannels to 0..32 and DopplerSpeed to >= 1.
  const channels = Math.max(0, Math.min(32, msvcrtWtoi(setting('EffectsChannels'))));
  // The subsystem's volume bytes +0x69/+0x6a/+0x6b (UByteProperty: appAtoi,
  // low byte), shared by Update's category ratio, SetVolumes and the
  // SetInstant*Volume natives 268-270 (galaxy-volumes.mjs).
  const volumes = createGalaxyVolumes({musicVolume: msvcrtWtoi(setting('MusicVolume')) & 255,
    soundVolume: msvcrtWtoi(setting('SoundVolume')) & 255, speechVolume: msvcrtWtoi(setting('SpeechVolume')) & 255});
  const galaxyConfig = {effectsChannels: channels, ambientFactor: f(Number.parseFloat(setting('AmbientFactor'))),
    dopplerSpeed: f(Math.max(1, Number.parseFloat(setting('DopplerSpeed')))),
    get soundVolume() { return volumes.state.soundVolume; }, get speechVolume() { return volumes.state.speechVolume; },
    useSurround: bool('UseSurround') ? 1 : 0, reverseStereo: bool('ReverseStereo') ? 1 : 0};
  if (bool('Use3dHardware')) throw new Error('Galaxy Use3dHardware voices are not translated');
  // UseReverb (+0x44): Update's reverb tail hands the listener zone's
  // glxReverb to the library (galaxy-audio.mjs); it reaches a mixer only with
  // Galaxy's own voices (below), as the reverb hook runs on bus B.
  galaxyConfig.useReverb = bool('UseReverb') ? 1 : 0;

  // Music (galaxy-music.mjs): UseDigitalMusic, UseCDMusic (refused when
  // True), Latency (clamped to 10..250 by 0x10605ad0, the function holding
  // PostEditChange's SetVolumes call; the installed 40 is inside the range).
  const latency = Math.max(10, Math.min(250, msvcrtWtoi(setting('Latency'))));
  const musicLog = [];
  const musicObjects = createMusicObjects({graph: runtime.classLoader?.graph ?? null});
  const music = createGalaxyMusic({useDigitalMusic: bool('UseDigitalMusic') ? 1 : 0, useCDMusic: bool('UseCDMusic') ? 1 : 0,
    latency, effectsChannels: channels, volumes: volumes.state}, {
    library, music: song => musicObjects.music(song), read,
    write: (object, name, value) => runtime.writeNamed(object, name, value),
    // GLog lines (DevMusic "Load music"/"Unregister music", the "failed: %i"
    // warnings); the last 64.
    log: (name, text) => { musicLog.push({name, text}); if (musicLog.length > 64) musicLog.shift(); },
  });
  volumes.music = music;
  volumes.library = library;
  // Effects through the library's own voices (above).
  const galaxyVoices = Boolean(library?.effects) && globalThis.DEUS_EX_SFX !== 'webaudio';
  if (galaxyVoices) await library.ready();
  if (!galaxyVoices) galaxyConfig.useReverb = 0;

  // Every AmbientSound of the level, decoded before the first tick (the
  // update is synchronous; RegisterSound's decode is the host's).
  const samples = new Map(), notes = new Set();
  // Speech samples by sound key (attachDecoded), and the counts of what the
  // host decode did (status).
  const hostSamples = new Map(), speech = {requests: 0, attached: 0, dropped: 0, failed: 0, releases: 0};
  /** RegisterSound for an MP3 sound: a host-decoded record (the stand-in of
   * Galaxy's MPEG loader 0x10620b30, effects.rs `host_sample`). The rate is
   * the MPEG header's, which the original loader puts at +0x3c (44100 for the
   * shipped speech, docs/lip-sync.md), and so is the mode: a single-channel
   * stream is a mono record (0x4024), any other a stereo one (0x4044, two
   * voices); the frame count is a walk over the MPEG frame headers until a
   * decode gives the real one. No PCM yet. */
  /** The first channel of interleaved stereo 16-bit PCM (the host clock's lip-sync stand-in reads the left voice). */
  const leftChannel = pcm => {
    const out = new Uint8Array(pcm.length >> 1);
    for (let i = 0, j = 0; i + 3 < pcm.length; i += 4, j += 2) { out[j] = pcm[i]; out[j + 1] = pcm[i + 1]; }
    return out;
  };
  function hostSample(sound, bytes) {
    const rate = mp3SampleRate(bytes);
    if (!rate) { notes.add(`${sound.key}: MP3 sound without an MPEG frame header; the sound is silent`); return null; }
    const frames = mp3Frames(bytes) ?? 0, channels = mp3Channels(bytes);
    const sample = {sound, rate, frames, channels, loop: null, bytes, handle: 0,
      host: {pcm: null, attached: false, requested: false, users: 0}};
    if (galaxyVoices) sample.handle = library.registerHostSample(sound.key, rate, frames, channels).handle;
    samples.set(sound, sample);
    hostSamples.set(sound.key, sample);
    return sample;
  }
  // RegisterSound decodes on first use; the export's package bytes are in
  // memory once its package is loaded, so the decode can run synchronously.
  function decodeSample(sound) {
    const modded = moddedSounds.get(sound);
    if (modded) return hostSample(sound, modded);
    const {asset, index} = sound;
    if (!asset?.bytes || !Number.isInteger(index)) return null;
    const decoded = decodeSoundResource({pkg: asset.pkg, bytes: asset.bytes, entry: asset.pkg.exports[index - 1]});
    const start = asset.pkg.exports[index - 1].serialOffset + decoded.lazy.inlineOffset;
    const bytes = decoded.bytes ?? asset.bytes.slice(start, start + decoded.lazy.byteCount);
    if (decoded.lazy.formatName.toLowerCase() === 'mp3') return hostSample(sound, bytes);
    if (galaxyVoices) {
      // RegisterSound 0x10606af0: glxLoadSample(&Mem{Data, Num}, 2) on the
      // FSoundData bytes. The registry's record gives Update its C4Speed.
      const entry = library.registerSample(sound.key, bytes);
      if (!entry.handle) {
        notes.add(entry.fault
          ? `${sound.key}: glxLoadSample path not translated (fault 0x${entry.fault.toString(16)}); the sound is silent`
          : `${sound.key}: glxLoadSample returned no sample; the sound is silent`);
      }
      const loop = entry.handle && entry.type & 8 ? {start: entry.loopStart, end: entry.loopEnd} : null;
      const sample = {sound, handle: entry.handle, rate: entry.c4Speed ?? 22050, frames: entry.length ?? 0, loop};
      samples.set(sound, sample);
      return sample;
    }
    if (decoded.lazy.formatName.toLowerCase() !== 'wav') { notes.add(`${sound.key}: ${decoded.lazy.formatName} sample`); return null; }
    const sample = {sound, bytes, ...wavInfo(bytes)};
    samples.set(sound, sample);
    return sample;
  }
  async function prepareSample(sound) {
    if (!sound || samples.has(sound)) return;
    await runtime.prepareResource(sound);
    // Galaxy's voices register a sound when Update first needs it (step 11).
    if (!galaxyVoices) decodeSample(sound);
  }
  for (const actor of level.actors) if (actor) {
    try { await prepareSample(read(actor, 'AmbientSound')); } catch (error) { notes.add(String(error?.message ?? error)); }
  }

  // Render.dll's Strobe state and light noise, shared with the light maps and
  // mesh lighting (light-globals.mjs).
  const globals = lightGlobals(runtime);
  const voices = new Map();
  // Galaxy's digital master volume: the louder of SoundVolume and
  // SpeechVolume on 0..127 (galaxy-volumes.mjs).
  let nextVoice = 1, last = null;
  let digital = Math.trunc(Math.max(galaxyConfig.soundVolume, galaxyConfig.speechVolume) / 255 * 127);
  // Measured (the live capture) or modeled (the slot AddObject's rule gives a
  // runtime spawn, continued from a measured registry state) global indices;
  // a runtime spawn's host registry slot is neither
  // (ScriptRuntime.soundObjectIndex, docs/object-index-captures.md).
  const index = actor => runtime.soundObjectIndex(actor)?.index ?? null;
  // Sounds played with a modeled index, by class: reported, not hidden.
  const modeledIds = new Map();
  const noteModeledId = actor => {
    const name = runtime.instance(actor).cls?.record?.name ?? '?';
    modeledIds.set(name, (modeledIds.get(name) ?? 0) + 1);
  };
  // An actor with no measured or modeled global index cannot form its
  // ambient channel id; it is left out and noted rather than given an invented id.
  const measured = actor => {
    if (!actor || index(actor) !== null) return actor;
    try { if (read(actor, 'AmbientSound')) notes.add(`${actor.name}: ambient sound without a measured or modeled global index`); } catch {}
    return null;
  };
  const galaxy = createGalaxyAudio(galaxyConfig, {
    library, music,
    listener: () => ({actor: player(), viewTarget: player() ? read(player(), 'ViewTarget') : null}),
    read, atan2: Math.atan2, isValid: () => true,
    isA: (object, key) => { for (let cls = runtime.instance(object).cls; cls; cls = cls.base) if (cls.record.key === key) return true; return false; },
    index: actor => index(actor),
    actors: () => level.actors.map(measured),
    // The render scan (script-vm-render.mjs) leaves the actors with a live
    // AmbientSound and those it hands back, in array order.
    ambientActors: () => {
      const entries = runtime.scriptVm?.render?.scan(level.actors, {kinds: RENDER_AMBIENT});
      if (!entries) return null;
      const actors = new Array(entries.length);
      for (let i = 0; i < entries.length; i++) actors[i] = measured(level.actors[entries[i] >>> RENDER_SHIFT]);
      return actors;
    },
    fastLineCheck: (end, start) => fastLineCheck(level.model, end, start),
    globalLighting: (realtime, actor, volume) => {
      const values = {LightType: realtime ? read(actor, 'LightType') : 1, LightPeriod: read(actor, 'LightPeriod'), LightPhase: read(actor, 'LightPhase')};
      const type = values.LightType & 255;
      if (LIGHT_TYPE_UNSUPPORTED.has(type)) notes.add(`LightType ${type} function is not applied to ambient volume`);
      // URender::GlobalLighting from Audio->Update, before PreRender: the
      // game thread's precision (64-bit, the assumption: render-pass
      // precision), the noise table A of the previous PreRender, the shared
      // Strobe state; Flicker's key is the actor's (as the light maps').
      let brightness = type < 10 ? f(lightTypeBrightness(values, {timeSeconds: read(read(actor, 'Level'), 'TimeSeconds'), brightness: volume,
        noise: {A: globals.previousA}, strobe: globals.strobe, flickerKey: globals.flickerKeyOf(actor), precision: 'pc64'})) : volume;
      if (!(brightness >= 0)) brightness = 0; else if (!(brightness < 1)) brightness = 1;
      return brightness;
    },
    // A sample the host cannot decode (package bytes not loaded, a format
    // other than WAV) plays as an empty voice that finishes at once, noted:
    // a host limitation, not Galaxy's (whose loader would have decoded it).
    sample: sound => {
      let sample = samples.get(sound);
      if (!sample) { try { sample = decodeSample(sound); } catch (error) { notes.add(String(error?.message ?? error)); } }
      if (!sample) {
        notes.add(`${sound?.key ?? 'None'}: sample unavailable to the host`);
        sample = {sound, bytes: null, rate: 22050, frames: 0, loop: null};
        samples.set(sound, sample);
      }
      return sample;
    },
    voicePlaying: voice => {
      const host = voices.get(voice);
      // glxControlVoice(voice, GLX_GETSTATUS): the library's Active byte once
      // the worklet reports; the host clock before that.
      if (galaxyVoices && host && !host.silent && library.live()) return library.voiceActive(voice) !== 0;
      return host?.playing ?? false;
    },
    startVoice: (channel, sample, frequency, volume, pan) => {
      if (sample.host) useHostSample(sample);
      if (galaxyVoices) {
        // glxStartSample(channel + 1, sample, ...) (0x1060a435): the voice is
        // the fixed slot's. A sound the translated loader cannot register
        // is a silent host voice that finishes at once (noted).
        if (!sample.handle) {
          const silentVoice = -(nextVoice++);
          voices.set(silentVoice, {sample, frequency, volume, pan, position: 0, playing: false, silent: true});
          return silentVoice;
        }
        const voice = library.startSample(channel, sample.handle, frequency, volume, pan, 0);
        voices.set(voice, {sample, frequency, volume, pan, position: 0, playing: true});
        return voice;
      }
      const voice = nextVoice++;
      voices.set(voice, {sample, frequency, volume, pan, position: 0, playing: true});
      // `speech`: the page decodes the MP3 itself and keeps no buffer after the stop.
      if (sample.bytes) onVoice?.({op: 'start', voice, channel, sound: sample.sound.key, bytes: sample.bytes, rate: sample.rate,
        loop: sample.loop, frequency, volume, pan, digital, speech: Boolean(sample.host)});
      return voice;
    },
    controlVoice: (voice, frequency, volume, pan) => {
      const host = voices.get(voice);
      Object.assign(host, {frequency, volume, pan});
      if (galaxyVoices) { if (!host.silent) library.controlSample(voice, frequency, volume, pan); return; }
      onVoice?.({op: 'control', voice, frequency, volume, pan, digital});
    },
    stopVoice: voice => {
      const host = voices.get(voice);
      voices.delete(voice);
      if (galaxyVoices) { if (host && !host.silent) library.stopSample(voice); }
      else onVoice?.({op: 'stop', voice});
      if (host?.sample.host) leaveHostSample(host.sample);
    },
    // Step 12's analysis (galaxy-audio.mjs owns the gate and the cadence):
    // the window of the voice's ring at the mixer's read head, as the
    // worklet reports it (a held start has none: not started yet); before the
    // worklet reports and under the Web Audio mapping, the PCM at the host
    // clock's position (a stand-in without the ring's head start).
    lipSync: channel => {
      if (!lipSync?.enabled()) return false;
      const sample = samples.get(channel.sound);
      if (!sample?.host) return false;
      if (galaxyVoices && library.live()) {
        const window = library.voiceWindow(channel.voice);
        if (!window) return false;
        lipSync.analyze(channel.actor, {window: window.bytes, available: window.available, rate: sample.rate});
        return true;
      }
      const pcm = sample.host.pcm, position = voices.get(channel.voice)?.position;
      if (!pcm?.length || position === null || position === undefined) return false;
      lipSync.analyze(channel.actor, {pcm: sample.channels === 2 ? leftChannel(pcm) : pcm, rate: sample.rate, position});
      return true;
    },
  });
  // The lip-sync analysis (galaxy-lipsync-channels.mjs createLipSyncAnalysis),
  // set by the host that loaded the kernel; none: step 12 analyses nothing.
  let lipSync = null;
  /** A voice starts on a speech sample: its PCM goes to the library's record,
   * or the page is asked for the decode (once until it arrives). */
  function useHostSample(sample) {
    const host = sample.host;
    host.users++;
    if (host.pcm) { if (galaxyVoices && !host.attached) { library.attachSample(sample.handle, host.pcm); host.attached = true; } return; }
    if (host.requested) return;
    host.requested = true; speech.requests++;
    onVoice?.({op: 'decode', sound: sample.sound.key, bytes: sample.bytes, rate: sample.rate, channels: sample.channels});
  }
  /** A voice of a speech sample stopped: with none left, the PCM is dropped
   * (from the library's record too); the next voice asks for it again. */
  function leaveHostSample(sample) {
    const host = sample.host;
    host.users = Math.max(0, host.users - 1);
    if (host.users) return;
    if (host.attached) { library.releaseSample(sample.handle); host.attached = false; speech.releases++; }
    host.pcm = null;
  }
  /** The page's 16-bit decode of a speech sample (`sound` its key); empty
   * when the decode failed (the voice then plays nothing and finishes). */
  function attachDecoded(sound, pcm) {
    const sample = hostSamples.get(sound);
    if (!sample) return false;
    const host = sample.host;
    host.requested = false;
    if (!host.users) { speech.dropped++; return false; }
    if (!pcm.length) { speech.failed++; notes.add(`${sound}: the host could not decode the speech; it plays nothing`); }
    host.pcm = pcm; speech.attached++;
    sample.frames = pcm.length / (2 * (sample.channels ?? 1));
    if (galaxyVoices && !host.attached) { library.attachSample(sample.handle, pcm); host.attached = true; }
    return true;
  }

  let disposed = false;
  /** UGameEngine::Draw's Audio->Update (0x1038f638) for the frame's view. */
  function update(view) {
    if (disposed) return;
    const now = hostNow() / 1000;
    const elapsed = last === null ? 0 : now - last;
    last = now;
    if (!player() || !view) return;
    for (const voice of voices.values()) {
      if (!voice.playing) continue;
      voice.position += Math.max(0, Math.min(1, elapsed)) * voice.frequency;
      const {frames, loop} = voice.sample;
      if (loop && loop.end > loop.start) {
        if (voice.position >= loop.end) voice.position = loop.start + (voice.position - loop.end) % (loop.end - loop.start);
      } else if (voice.position >= frames) voice.playing = false;
    }
    const frame = buildWindowSceneFrame({...view, width: 640, height: 480});
    const c = frame.coords;
    galaxy.update(elapsed, {origin: c.slice(0, 3), x: c.slice(3, 6), y: c.slice(6, 9), z: c.slice(9, 12)});
  }
  /** A Player-start reload: LoadMap's SetViewport(GetViewport()) stops the
   * effect channels (0x10605ca6..0x10605cb4) and returns early, so music is
   * untouched (docs/galaxy-music/update-transition.md §5.3). The map package
   * reloads in place and the music package stays loaded, so LevelInfo.Song
   * is the same UMusic and LoadMap's collection keeps it: the new player's
   * PostLogin transition fades and restarts the section on the loaded
   * module. */
  function reset() {
    for (let channel = 0; channel < galaxyConfig.effectsChannels; channel++) galaxy.stopSound(channel);
    voices.clear(); last = null;
  }
  /** The runtime is dropped (the browser builds a fresh runtime per map):
   * its UMusic objects go with it. In the original that is LoadMap's
   * collection destroying them: UMusic::Destroy (Engine 0x10370d4c) calls
   * Audio->UnregisterMusic (vtable +0x70) for each, and only +0x888 can
   * hold a handle, so the current song is stopped and unloaded and +0x888
   * cleared before the next Update. Outside Update: no lock batch.
   * Same-song map changes differ (the original keeps a UMusic the new
   * level references, and fades instead of reloading). */
  function dispose() {
    if (disposed) return;
    disposed = true;
    // The library outlives this runtime: its effect voices stop with the map,
    // as SetViewport's StopSound loop (0x10605ca6..0x10605cb4) stops them at
    // a Player start (the original's map change of the subsystem is not
    // traced).
    if (galaxyVoices) {
      library.lock();
      for (let channel = 0; channel < galaxyConfig.effectsChannels; channel++) galaxy.stopSound(channel);
      library.unlock();
    }
    if (music.state.current !== null) music.unregisterMusic(music.state.current);
  }
  return {galaxy, music, volumes, library, galaxyConfig, musicLog, update, reset, dispose, notes, voices, galaxyVoices, modeledIds, noteModeledId,
    samples, hostSamples, speech, attachDecoded,
    setLipSync: analysis => { lipSync = analysis; },
    get lipSync() { return lipSync; },
    setDigitalVolume: value => { digital = value & 127; }};
}
