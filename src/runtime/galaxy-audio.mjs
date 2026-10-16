import { x87Arithmetic } from './galaxy-music.mjs';
import { x87load, x87double, x87int32, x87mul, x87add, x87neg, x87div, x87cmp, x87store, x87storeDouble,
  x87sqrt, x87ftol, x87safeNormal } from './script-vm.mjs';

/** UGalaxyAudioSubsystem's channel logic (Galaxy.dll 606e71d1…, vtable
 * 0x1063d0e4; docs/galaxy-audio.md): PlaySound (0x10608100), StopSound
 * (0x10607e50), StopSoundId (0x10607ef0), NoteDestroy (0x106083a0) and
 * Update's ambient scan, ambient refresh and per-channel
 * voice parameters (0x10609510). The Galaxy library's voices are services:
 * `voicePlaying(voice)` (0x1060cf00(voice, 2, 0, 0) != 0),
 * `startVoice(index, sample, frequency, volume, pan)` (0x10612310, 2D),
 * `controlVoice(voice, frequency, volume, pan)` (0x1060d280) and
 * `stopVoice(voice)` (0x10618410). The music section is galaxy-music.mjs's,
 * reached through `services.music` inside `services.library`'s lock; the 3D
 * hardware path (Use3dHardware is False in the installed DeusEx.ini) is
 * outside this module. Step 12, the lip-sync sampling of a speaking pawn's
 * Talk channel, keeps its gate and cadence here and calls the optional
 * `lipSync(channel, index)` for the analysis of the voice's data
 * (galaxy-lipsync-channels.mjs); without it the step is skipped.
 *
 * World services: `listener()` the viewport Actor and its ViewTarget,
 * `read(object, name)`, `isA(object, key)`, `index(actor)` the UObject index
 * used in ambient ids, `actors()` XLevel's actor array (`ambientActors()`,
 * optional, the same without actors whose AmbientSound is None, or null),
 * `fastLineCheck(end,
 * start)` UModel::FastLineCheck (true when clear), `globalLighting(realtime,
 * actor, volume)` URender::GlobalLighting's volume, `sample(sound)` the
 * registered Galaxy sample ({rate}, RegisterSound when absent) and
 * `isValid(actor)`. */
const X = x87load;
const ZERO = x87double(0), ONE = x87double(1), HALF = x87double(0.5), TWO = x87double(2);
const FLOOR = x87double(0.33), TENTH = x87double(0.1), INV_PI = x87double(0.3183098861837907);
const CENTRE = x87double(16383), PAN_SCALE = X(28671.125), INV_255 = x87double(1 / 255);
const TWENTY_FIVE = x87double(25), SIXTY_FOURTH = x87double(0.015625), FULL = X(32767), INV_255F = X(0.003921568859368563);
const sub = (a, b) => x87add(a, x87neg(b));
const f32 = v => x87store(v);
const lt = c => c === 'lt' || c === 'un';
const RECORD = () => ({ voice: null, actor: null, id: 0, is3D: 0, sound: null, location: [0, 0, 0], volume: 0, radius: 0,
  pitch: 0, priority: 0, time: 0, lipSync: 0, amplitude: -1, occlusion: 0 });

/** appSqrt: FLD m64; FSQRT on the double the caller stored. */
const appSqrt = sum => x87sqrt(x87storeDouble(sum));
// The reverb tail's floats (0x1063d6c4 0.002f, 0x1063d6c0 0.001f, 0x1063d6bc
// 0.34f, 0x1063d6b8 0.999f), the glxReverb size in dwords, the log name.
const TIME_SCALE = X(0.0020000000949949026), MIN_F = X(0.0010000000474974513), MAX_TIME = X(0.3400000035762787),
  MAX_GAIN = X(0.9990000128746033);
const REVERB_WORDS = 27, WARNING = 767;
const bitsView = new DataView(new ArrayBuffer(4));
const floatBits = value => (bitsView.setFloat32(0, value, true), bitsView.getInt32(0, true));
/** (dx*dx + dy*dy) + dz*dz over float differences, kept extended. */
function distanceSquared(a, b) {
  const [dx, dy, dz] = [0, 1, 2].map(i => sub(X(a[i]), X(b[i])));
  return x87add(x87add(x87mul(dx, dx), x87mul(dy, dy)), x87mul(dz, dz));
}

/** Whether an ambient sound's radius ((SoundRadius & 0xff) + 1) * 25 reaches
 * the listener: radius*radius >= dist^2, kept extended (the original's
 * compare in Update, 0x10609510). */
export function ambientInRangeExact(location, listener, soundRadius) {
  const radius = x87mul(x87int32((soundRadius & 0xff) + 1), TWENTY_FIVE);
  return !lt(x87cmp(x87mul(radius, radius), distanceSquared(location, listener)));
}
/** The same answer, decided in doubles when the squared distance is not
 * within 1e-9 (relative) of the squared radius: the radius and its square are
 * exact integers, the float differences and their squares carry at most about
 * 5e-16 relative error in doubles and 5e-19 in extended precision, and the
 * terms are non-negative, so no rounding on either side can cross that gap. A
 * NaN or infinite distance, and the gap itself, take the exact path. Update
 * asks for every ambient actor of the level every frame; the exact path builds
 * a dozen BigInt records each time. */
export function ambientInRange(location, listener, soundRadius) {
  const reach = ((soundRadius & 0xff) + 1) * 25, reach2 = reach * reach;
  const dx = location[0] - listener[0], dy = location[1] - listener[1], dz = location[2] - listener[2];
  const d2 = dx * dx + dy * dy + dz * dz, gap = d2 - reach2, margin = (reach2 + d2) * 1e-9;
  if (gap > margin) return false;
  if (-gap > margin) return true;
  return ambientInRangeExact(location, listener, soundRadius);
}

export function createGalaxyAudio(config, services) {
  const channelCount = config.effectsChannels;
  // `reverb`: the glxReverb Update last handed the library (+0x88e, zeroed by
  // Init 0x10605f54), as 27 int32 words.
  const state = { channels: Array.from({ length: channelCount }, RECORD), counter: 0, reverb: new Int32Array(REVERB_WORDS) };
  // The reverb tail's products at the game thread's precision control
  // (64 bits in Play; the music validator also replays 53 and 24).
  const { mul: precisionMul } = x87Arithmetic(config.precision ?? 64);
  const reverbBlock = new Int32Array(REVERB_WORDS);
  const { read } = services;
  // Music: the library service object and the music section
  // (galaxy-music.mjs); both optional, so the channel logic runs alone too.
  const library = services.library ?? null, music = services.music ?? null;
  const listenerLocation = () => {
    const { actor, viewTarget } = services.listener();
    return read(viewTarget ?? actor, 'Location');
  };

  /** 0x10607e50: stop the channel's voice and reset its record. */
  function stopSound(index) {
    const channel = state.channels[index];
    if (channel.voice) services.stopVoice(channel.voice, channel.is3D);
    state.channels[index] = RECORD();
  }

  /** 0x10608100. Returns whether a channel took the sound. */
  function playSound(actor, id, sound, location, volume, radius, pitch) {
    if (x87cmp(X(radius), X(0)) === 'eq') throw new Error('Galaxy PlaySound: Radius == 0 (original appFailAssert)');
    const { actor: viewActor } = services.listener();
    if (!viewActor || !sound) return false;
    if ((id & 0xe) === 0) { state.counter = (state.counter - 1) | 0; id = (state.counter << 4) | 0; }
    const root = appSqrt(distanceSquared(location, listenerLocation()));
    let running = x87mul(sub(ONE, x87div(root, X(radius))), X(volume));
    const priority = f32(running);
    let chosen = -1;
    for (let index = 0; index < channelCount; index++) {
      const channel = state.channels[index];
      if (((channel.id ^ id) & ~1) === 0) {
        if (id & 1) return false;
        chosen = index; break;
      }
      if (!lt(x87cmp(running, X(channel.priority)))) { running = X(channel.priority); chosen = index; }
    }
    if (chosen < 0) return false;
    stopSound(chosen);
    Object.assign(state.channels[chosen], { actor, id, sound, location: location.map(Math.fround),
      volume: Math.fround(volume), radius: Math.fround(radius), pitch: Math.fround(pitch), priority });
    return true;
  }

  const ambientRadius = actor => x87mul(x87int32((read(actor, 'SoundRadius') & 0xff) + 1), TWENTY_FIVE);
  const inAmbientRange = (actor, listener) => {
    return ambientInRange(read(actor, 'Location'), listener, read(actor, 'SoundRadius'));
  };
  const ambientVolume = actor => x87mul(x87mul(x87int32(read(actor, 'SoundVolume') & 0xff), X(config.ambientFactor)), INV_255);

  /** 0x10609510 without the 3D branches (and step 12 only with `services.lipSync`).
   * `deltaTime` is the elapsed time since the last Update (the original reads
   * appSecondsSlow against `+0x880`); it is clamped to [0, 1] here as at
   * 0x106095aa. `coords` is the listener FCoords: origin, x, y, z axes. */
  function update(deltaTime, coords) {
    const { actor: viewActor, viewTarget } = services.listener();
    if (!viewActor) return;
    // 0x10609549 EnterCriticalSection .. 0x1060abd6 LeaveCriticalSection: the
    // rest of Update runs under the Galaxy lock, so the music section's
    // library calls form one batch (galaxy-music-library.mjs).
    library?.lock();
    try { updateLocked(viewActor, viewTarget, deltaTime, coords); }
    finally { library?.unlock(); }
  }

  function updateLocked(viewActor, viewTarget, deltaTime, coords) {
    let dt = x87double(deltaTime);
    if (lt(x87cmp(dt, ZERO))) dt = ZERO;
    else if (!lt(x87cmp(dt, ONE))) dt = ONE;
    const listener = read(viewTarget ?? viewActor, 'Location');
    // Ambient scan: ShowFlags & 0x4800 and an empty Level.Pauser.
    let ambientActive = false;
    if ((read(viewActor, 'ShowFlags') & 0x4800) && read(read(viewTarget ?? viewActor, 'Level'), 'Pauser') === '') {
      ambientActive = true;
      // `ambientActors()` may leave out actors whose AmbientSound is None
      // (the scan's first test), keeping the others in array order.
      const actors = services.ambientActors?.() ?? services.actors();
      for (let index = 0; index < actors.length; index++) {
        const actor = actors[index];
        if (!actor) continue;
        const ambient = read(actor, 'AmbientSound');
        if (!ambient || !inAmbientRange(actor, listener)) continue;
        const id = ((services.index(actor) << 4) + 8) | 0;
        if (state.channels.some(channel => channel.id === id)) continue;
        playSound(actor, id, ambient, read(actor, 'Location'), f32(ambientVolume(actor)),
          f32(ambientRadius(actor)), f32(x87mul(x87int32(read(actor, 'SoundPitch') & 0xff), SIXTY_FOURTH)));
      }
    }
    // Ambient refresh (slot 4).
    for (let index = 0; index < channelCount; index++) {
      const channel = state.channels[index];
      if ((channel.id & 0xe) !== 8) continue;
      const actor = channel.actor;
      if (!actor) throw new Error('Galaxy Update: ambient channel without an actor (original appFailAssert)');
      if (!inAmbientRange(actor, listener) || read(actor, 'AmbientSound') !== channel.sound || !ambientActive) {
        stopSound(index); continue;
      }
      const base = ambientVolume(actor);
      let volume = f32(x87add(base, base));
      if (read(actor, 'LightType') & 0xff) {
        volume = f32(x87mul(x87mul(x87int32(read(actor, 'LightBrightness') & 0xff), X(volume)), INV_255));
        volume = services.globalLighting(Boolean((read(viewActor, 'ShowFlags') >>> 11) & 1), actor, volume);
      }
      channel.volume = volume;
      channel.radius = f32(ambientRadius(actor));
      channel.pitch = f32(x87mul(x87int32(read(actor, 'SoundPitch') & 0xff), SIXTY_FOURTH));
    }
    // Every channel with a sound.
    for (let index = 0; index < channelCount; index++) {
      const channel = state.channels[index];
      if (channel.actor && !services.isValid(channel.actor))
        throw new Error('Galaxy Update: channel actor is not valid (original appFailAssert)');
      if (!channel.id) continue;
      if (channel.voice && !services.voicePlaying(channel.voice)) { stopSound(index); continue; }
      channel.time = f32(x87add(X(channel.time), dt));
      if (channel.actor) channel.location = read(channel.actor, 'Location').map(Math.fround);
      const location = channel.location;
      // Priority, as in PlaySound.
      channel.priority = f32(x87mul(sub(ONE, x87div(appSqrt(distanceSquared(location, listener)), X(channel.radius))), X(channel.volume)));
      // Listener space: ((v.x*K.x + v.y*K.y) + v.z*K.z) per axis K.
      const v = [0, 1, 2].map(i => sub(X(location[i]), X(coords.origin[i])));
      const local = [coords.x, coords.y, coords.z].map(axis =>
        f32(x87add(x87add(x87mul(v[0], X(axis[0])), x87mul(v[1], X(axis[1]))), x87mul(v[2], X(axis[2])))));
      const z = X(local[2]);
      // appAtan2(local.x, |local.z|): FCHS only below 0, so -0 stays -0.
      // FPATAN is a transcendental; `atan2` is the host's (docs/galaxy-audio.md).
      const angle = Math.fround(services.atan2(local[0], lt(x87cmp(z, X(0))) ? -local[2] : local[2]));
      const nearRadius = f32(x87mul(X(channel.radius), TENTH));
      const lateral = x87add(x87add(x87mul(X(local[1]), X(local[1])), x87mul(X(local[0]), X(local[0]))), x87mul(z, z));
      const lateralF = f32(lateral);
      const dist = appSqrt(lateral);
      const scaled = x87cmp(x87mul(X(nearRadius), X(nearRadius)), X(lateralF)) === 'gt'
        ? x87mul(x87div(dist, X(nearRadius)), X(angle)) : X(angle);
      let pan = x87ftol(x87add(x87mul(x87mul(scaled, PAN_SCALE), INV_PI), CENTRE));
      pan = pan < 0 ? 0 : pan >= 0x7fff ? 0x7fff : pan;
      let atten = sub(ONE, x87div(dist, X(channel.radius)));
      if (lt(x87cmp(atten, ZERO))) atten = ZERO;
      else if (!lt(x87cmp(atten, ONE))) atten = ONE;
      const distanceFactor = f32(atten);
      const slot = channel.id & 0xf, speech = slot === 0xa || slot === 0xb;
      // Occlusion: a line from the source to the listener's eye.
      let occluded = false;
      if (channel.actor && !speech) {
        const from = read(viewActor, 'Location');
        const eye = services.isA(viewActor, 'engine.pawn')
          ? [from[0], from[1], f32(x87add(X(read(viewActor, 'EyeHeight')), X(from[2])))] : from;
        occluded = !services.fastLineCheck(eye, read(channel.actor, 'Location'));
      }
      if (occluded) {
        const sum = x87add(X(channel.occlusion), dt);
        channel.occlusion = f32(x87cmp(HALF, sum) === 'gt' ? sum : HALF);
      } else {
        const difference = sub(X(channel.occlusion), dt);
        channel.occlusion = f32(lt(x87cmp(ZERO, difference)) ? difference : ZERO);
      }
      let factor = sub(ONE, x87add(X(channel.occlusion), X(channel.occlusion)));
      if (!lt(x87cmp(FLOOR, factor))) factor = FLOOR;
      const sound = config.soundVolume & 0xff, speechVolume = config.speechVolume & 0xff;
      let ratio = X(1);
      if (speech) {
        if (sound > speechVolume) ratio = x87div(x87int32(speechVolume), x87int32(sound));
        else if (sound === speechVolume) ratio = x87mul(x87int32(sound), INV_255F);
      } else if (sound < speechVolume) ratio = x87div(x87int32(sound), x87int32(speechVolume));
      else if (sound === speechVolume) ratio = x87mul(x87int32(sound), INV_255F);
      let volume = x87ftol(x87mul(x87mul(x87mul(x87mul(factor, X(distanceFactor)), ratio), X(channel.volume)), FULL));
      volume = volume < 0 ? 0 : volume >= 0x7fff ? 0x7fff : volume;
      if (config.reverseStereo) pan = 0x7fff - pan;
      if (lt(x87cmp(X(local[2]), ZERO)) && config.useSurround) pan = 0xc000;
      if (volume < 0x80) volume = 0x80;
      // Doppler on an ambient channel.
      let doppler = 1;
      if (channel.actor && (channel.id & 0xe) === 8) {
        const there = read(channel.actor, 'Location');
        const direction = x87safeNormal(there.map((value, axis) => f32(sub(X(value), X(listener[axis])))));
        const velocity = read(channel.actor, 'Velocity');
        const dot = x87add(x87add(x87mul(X(direction[2]), X(velocity[2])), x87mul(X(direction[1]), X(velocity[1]))),
          x87mul(X(direction[0]), X(velocity[0])));
        let shift = sub(ONE, x87div(dot, X(config.dopplerSpeed)));
        if (lt(x87cmp(shift, HALF))) shift = HALF;
        else if (!lt(x87cmp(shift, TWO))) shift = TWO;
        doppler = f32(shift);
      }
      const sample = services.sample(channel.sound);
      // Step 12, the lip-sync sampling (0x1060a05b..0x1060a268,
      // docs/lip-sync.md): a voice, an Actor and a SLOT_Talk id
      // (0x10609c86..0x10609ca3), the Actor IsA Pawn, time (+0x30) not below
      // the next analysis time (+0x34; fcomp, C0 skips, so unordered skips)
      // and bIsSpeaking. `services.lipSync(channel)` analyses the voice's
      // data; false when the host has no data for it yet (the voice is held
      // until its decode arrives), and then `next` stays. next = float(next
      // + 0.1), the double at 0x1063d768 (0x1060a259).
      if (services.lipSync && channel.voice && channel.actor && speech && services.isA(channel.actor, 'engine.pawn')
        && !lt(x87cmp(X(channel.time), X(channel.lipSync))) && read(channel.actor, 'bIsSpeaking')
        && services.lipSync(channel, index)) channel.lipSync = f32(x87add(X(channel.lipSync), TENTH));
      const frequency = x87ftol(x87mul(x87mul(x87int32(sample.rate), X(channel.pitch)), X(doppler)));
      if (channel.voice) services.controlVoice(channel.voice, frequency, volume, pan);
      else {
        channel.is3D = 0;
        channel.voice = services.startVoice(index + 1, sample, frequency, volume, pan);
        if (!channel.voice) throw new Error('Galaxy Update: voice start failed (original appFailAssert)');
      }
    }
    // The music section 0x1060a50b..0x1060aa15 (galaxy-music.mjs), on the
    // prologue's clamped dt, then the reverb tail.
    music?.update(dt, viewActor);
    reverbTail(viewTarget ?? viewActor);
  }

  /** Update's reverb tail 0x1060aa15..0x1060ab93: a zeroed glxReverb; with
   * UseReverb (+0x44) and the listener's Region.Zone (AActor +0xc8) a reverb
   * zone (bReverbZone, +0x3bc bit 0): Volume (+0xc) = f32(MasterGain · 1/255),
   * HFDamp (+0x10) = f32(clamp(CutoffHz, 0, 44100)), and six Delay pairs
   * (+0x34 + 8i) of Time = f32(clamp(Delay[i] · 0.002f, 0.001f, 0.34f)) and
   * Gain = f32(clamp(Gain[i] · (1/255)f, 0.001f, 0.999f)). When it differs
   * from the last one handed over (+0x88e, REPE CMPSD), it is copied there
   * and passed to glxSetSampleReverb (0x106113d0, a library call inside
   * Update's lock); a nonzero result is logged. The listener is the
   * viewport Actor's ViewTarget, else the Actor ([ebp-0x40]). */
  function reverbTail(listener) {
    reverbBlock.fill(0);
    if (config.useReverb) {
      const zone = read(listener, 'Region')?.['engine.actor.pointregion.zone'] ?? null;
      if (zone && read(zone, 'bReverbZone')) {
        reverbBlock[3] = floatBits(f32(precisionMul(x87int32(read(zone, 'MasterGain') & 0xff), INV_255)));
        const cutoff = read(zone, 'CutoffHz') | 0;
        reverbBlock[4] = floatBits(f32(x87int32(cutoff < 0 ? 0 : cutoff >= 44100 ? 44100 : cutoff)));
        const delays = read(zone, 'Delay'), gains = read(zone, 'Gain');
        for (let i = 0; i < 6; i++) {
          let time = precisionMul(x87int32(delays[i] & 0xff), TIME_SCALE);
          time = lt(x87cmp(time, MIN_F)) ? MIN_F : lt(x87cmp(time, MAX_TIME)) ? time : MAX_TIME;
          let gain = precisionMul(x87int32(gains[i] & 0xff), INV_255F);
          gain = lt(x87cmp(gain, MIN_F)) ? MIN_F : lt(x87cmp(gain, MAX_GAIN)) ? gain : MAX_GAIN;
          reverbBlock[13 + 2 * i] = floatBits(f32(time));
          reverbBlock[14 + 2 * i] = floatBits(f32(gain));
        }
      }
    }
    let same = true;
    for (let i = 0; i < REVERB_WORDS; i++) if (reverbBlock[i] !== state.reverb[i]) { same = false; break; }
    if (same) return;
    state.reverb.set(reverbBlock);
    const result = library?.setSampleReverb?.(reverbBlock.slice()) ?? 0;
    if (result) services.log?.(WARNING, `glxSetSampleReverb(&Reverb) failed: ${result}`);
  }

  /** StopSoundId (DEUS_EX, 0x10607ef0): stop the first channel whose Id
   * matches except for bit 0. */
  function stopSoundId(id) {
    const index = state.channels.findIndex(channel => ((channel.id ^ id) & ~1) === 0);
    if (index >= 0) stopSound(index);
  }

  /** NoteDestroy (0x106083a0), from ULevel::DestroyActor: asserts a valid
   * actor; an ambient channel of the actor stops, any other channel of it
   * forgets the actor and keeps playing at its last Location. */
  function noteDestroy(actor) {
    if (!actor) throw new Error('Galaxy NoteDestroy: Actor is None (original appFailAssert)');
    if (!services.isValid(actor)) throw new Error('Galaxy NoteDestroy: Actor is not valid (original appFailAssert)');
    for (let index = 0; index < channelCount; index++) {
      const channel = state.channels[index];
      if (channel.actor !== actor) continue;
      if ((channel.id & 0xe) === 8) stopSound(index);
      else channel.actor = null;
    }
  }
  return { state, playSound, stopSound, stopSoundId, noteDestroy, update };
}
