import {createGalaxyAudio} from './galaxy-audio.mjs';
import {fastLineCheck} from './fast-line-check.mjs';
import {buildWindowSceneFrame} from './script-window-scene-frame.mjs';
import {decodeSoundResource} from './script-sound-resource.mjs';
import {lightTypeBrightness, LIGHT_TYPE_UNSUPPORTED} from './mesh-lighting.mjs';
import {msvcrtWtoi} from './script-text-parser.mjs';

/** Galaxy's channel logic (galaxy-audio.mjs) over the live level: ambient
 * sounds from Update's scan, and PlaySound through execPlaySound and the
 * player's ClientHearSound (docs/galaxy-audio.md "Play"). Voices are host records with a clock, and
 * each start/control/stop goes to `onVoice` for the browser's Web Audio.
 *
 * Host contract (not Galaxy's mixer, which is not translated): a voice plays
 * the sound's WAV at `frequency / rate`, loops between the WAV's own `smpl`
 * loop points when it has them, and finishes after its frames otherwise; its
 * clock advances by the elapsed time times its last frequency each Update. */
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

export async function createLiveAudio({runtime, level, player, onVoice = null}) {
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
  const galaxyConfig = {effectsChannels: channels, ambientFactor: f(Number.parseFloat(setting('AmbientFactor'))),
    dopplerSpeed: f(Math.max(1, Number.parseFloat(setting('DopplerSpeed')))),
    soundVolume: msvcrtWtoi(setting('SoundVolume')) & 255, speechVolume: msvcrtWtoi(setting('SpeechVolume')) & 255,
    useSurround: bool('UseSurround') ? 1 : 0, reverseStereo: bool('ReverseStereo') ? 1 : 0};
  if (bool('Use3dHardware')) throw new Error('Galaxy Use3dHardware voices are not translated');

  // Every AmbientSound of the level, decoded before the first tick (the
  // update is synchronous; RegisterSound's decode is the host's).
  const samples = new Map(), notes = new Set();
  // RegisterSound decodes on first use; the export's package bytes are in
  // memory once its package is loaded, so the decode can run synchronously.
  function decodeSample(sound) {
    const {asset, index} = sound;
    if (!asset?.bytes || !Number.isInteger(index)) return null;
    const decoded = decodeSoundResource({pkg: asset.pkg, bytes: asset.bytes, entry: asset.pkg.exports[index - 1]});
    const start = asset.pkg.exports[index - 1].serialOffset + decoded.lazy.inlineOffset;
    const bytes = decoded.bytes ?? asset.bytes.slice(start, start + decoded.lazy.byteCount);
    if (decoded.lazy.formatName.toLowerCase() !== 'wav') { notes.add(`${sound.key}: ${decoded.lazy.formatName} sample`); return null; }
    const sample = {sound, bytes, ...wavInfo(bytes)};
    samples.set(sound, sample);
    return sample;
  }
  async function prepareSample(sound) {
    if (!sound || samples.has(sound)) return;
    await runtime.prepareResource(sound);
    decodeSample(sound);
  }
  for (const actor of level.actors) if (actor) {
    try { await prepareSample(read(actor, 'AmbientSound')); } catch (error) { notes.add(String(error?.message ?? error)); }
  }

  const strobe = {last: null, on: 0};
  const voices = new Map();
  // Galaxy's digital master volume: the louder of SoundVolume and
  // SpeechVolume on 0..127 (galaxy-volumes.mjs).
  let nextVoice = 1, last = null;
  let digital = Math.trunc(Math.max(galaxyConfig.soundVolume, galaxyConfig.speechVolume) / 255 * 127);
  // Measured global indices only: a runtime spawn's host registry slot is not
  // the original index (ScriptRuntime.measuredObjectIndex).
  const index = actor => runtime.measuredObjectIndex(actor);
  const galaxy = createGalaxyAudio(galaxyConfig, {
    listener: () => ({actor: player(), viewTarget: player() ? read(player(), 'ViewTarget') : null}),
    read, atan2: Math.atan2, isValid: () => true,
    isA: (object, key) => { for (let cls = runtime.instance(object).cls; cls; cls = cls.base) if (cls.record.key === key) return true; return false; },
    index: actor => index(actor),
    // An actor whose global index is unmeasured cannot form its ambient
    // channel id; it is left out and noted rather than given an invented id.
    actors: () => level.actors.map(actor => {
      if (!actor || index(actor) !== null) return actor;
      try { if (read(actor, 'AmbientSound')) notes.add(`${actor.name}: ambient sound without a measured global index`); } catch {}
      return null;
    }),
    fastLineCheck: (end, start) => fastLineCheck(level.model, end, start),
    globalLighting: (realtime, actor, volume) => {
      const values = {LightType: realtime ? read(actor, 'LightType') : 1, LightPeriod: read(actor, 'LightPeriod'), LightPhase: read(actor, 'LightPhase')};
      const type = values.LightType & 255;
      if (LIGHT_TYPE_UNSUPPORTED.has(type)) notes.add(`LightType ${type} function is not applied to ambient volume`);
      let brightness = type < 10 ? f(lightTypeBrightness(values, volume, read(read(actor, 'Level'), 'TimeSeconds'), strobe)) : volume;
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
    voicePlaying: voice => voices.get(voice)?.playing ?? false,
    startVoice: (channel, sample, frequency, volume, pan) => {
      const voice = nextVoice++;
      voices.set(voice, {sample, frequency, volume, pan, position: 0, playing: true});
      if (sample.bytes) onVoice?.({op: 'start', voice, channel, sound: sample.sound.key, bytes: sample.bytes, rate: sample.rate,
        loop: sample.loop, frequency, volume, pan, digital});
      return voice;
    },
    controlVoice: (voice, frequency, volume, pan) => {
      Object.assign(voices.get(voice), {frequency, volume, pan});
      onVoice?.({op: 'control', voice, frequency, volume, pan, digital});
    },
    stopVoice: voice => { voices.delete(voice); onVoice?.({op: 'stop', voice}); },
  });

  /** UGameEngine::Draw's Audio->Update (0x1038f638) for the frame's view. */
  function update(view) {
    const now = performance.now() / 1000;
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
  /** A Player-start reload stops every channel (the host's: the original's
   * level change of the audio subsystem is not traced). */
  function reset() {
    for (let channel = 0; channel < galaxyConfig.effectsChannels; channel++) galaxy.stopSound(channel);
    voices.clear(); last = null;
  }
  return {galaxy, update, reset, notes, voices, setDigitalVolume: value => { digital = value & 127; }};
}
