// Galaxy.dll's lip-sync channels (UGalaxyAudioSubsystem::PlaySound
// 0x10608100 and Update 0x10609510; docs/lip-sync.md). One channel per
// speech the player hears (ClientHearSound -> Audio->PlaySound): its time and
// next-analysis time start at 0.0; each audio update adds the clamped
// wall-clock delta to the time, and a SLOT_Talk channel on a speaking Pawn
// whose time reached the next analysis takes the 1024 samples at the mixer
// position through the original analysis (lipsync.rs) into
// APawn.nextPhoneme, then advances the next time by 0.1.
//
// Host inputs, real-time in the original too (docs/lip-sync.md): the PCM is
// the host's decode of the speech MP3 at its own rate converted to 16-bit
// (Galaxy's own decoder is not translated), and the mixer position is the
// host's playback position.
import {x87add, x87double, x87load, x87store} from './script-vm.mjs';

const RING = 0x7fff; // samples in a streamed voice's loop (0x106120ca)
const add = (time, delta) => x87store(x87add(x87load(time), x87double(delta)));
const below = (a, b) => a < b || Number.isNaN(a) || Number.isNaN(b);

/** MPEG audio frame header sample rate (Galaxy's record +0x3c for speech). */
export function mp3SampleRate(bytes) {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[i + 1] >> 3) & 3, index = (bytes[i + 2] >> 2) & 3;
    if (version === 1 || index === 3) continue;
    return [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]][version][index];
  }
  return null;
}

/** Float PCM (-1..1) as little-endian int16 bytes, round to nearest and
 * clamp: an assumption about Galaxy's decoder output (unverified). */
export function pcm16(samples) {
  const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++)
    view.setInt16(2 * i, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), true);
  return bytes;
}

/**
 * services: {kernel (scriptVmKernel.lipsync), isPawn(actor), speaking(actor),
 * setPhoneme(actor, letter)}.
 */
export function createLipSyncChannels(services) {
  const channels = new Map();
  return {
    channels,
    /** PlaySound: a new channel (an id replaces its previous sound). */
    start({id, emitter}) { channels.set(id, {id, actor: emitter, time: 0, next: 0, pcm: null, rate: null, position: () => 0}); },
    /** The decoded speech and its mixer position (samples played). */
    attach(id, {pcm, rate, position}) {
      const channel = channels.get(id);
      if (channel) Object.assign(channel, {pcm, rate, position});
    },
    stop(id) { channels.delete(id); },
    clear() { channels.clear(); },
    /** One audio update with `seconds` of wall-clock time since the last. */
    update(seconds) {
      // 0x106095aa..0x106095e8: the double delta clamped to [0, 1].
      const delta = !(seconds >= 0) ? 0 : seconds > 1 ? 1 : seconds;
      for (const channel of channels.values()) {
        channel.time = add(channel.time, delta);
        const slot = channel.id & 0xf;
        if (!channel.actor || (slot !== 10 && slot !== 11) || !services.isPawn(channel.actor)) continue;
        if (below(channel.time, channel.next) || !services.speaking(channel.actor)) continue;
        // The voice starts playing once its speech is decoded; until then
        // there is nothing in the ring to analyse (a host boundary).
        if (!channel.pcm) continue;
        const stream = Math.max(0, Math.floor(channel.position()));
        const ring = stream % RING, available = Math.min(1024, RING - ring);
        const window = new Uint8Array(2048);
        window.set(channel.pcm.subarray(stream * 2, (stream + available) * 2));
        services.setPhoneme(channel.actor, services.kernel.analyze(window, available, channel.rate));
        channel.next = add(channel.next, 0.1);
      }
    },
  };
}
