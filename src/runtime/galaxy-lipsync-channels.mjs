// Galaxy.dll's lip-sync sampling, step 12 of UGalaxyAudioSubsystem::Update
// (0x10609510; docs/lip-sync.md, docs/galaxy-audio.md). Update's channel loop
// (galaxy-audio.mjs) owns the gate and the cadence: a channel with a voice,
// an Actor and a SLOT_Talk id, on a Pawn that is speaking, whose time (+0x30)
// reached the next analysis time (+0x34), is analysed and its next time
// advances by 0.1. This module is the analysis on the voice's data: the 1024
// samples at the mixer position through the original analysis (lipsync.rs)
// into APawn.nextPhoneme.
//
// Host inputs, real-time in the original too (docs/lip-sync.md): the PCM is
// the host's decode of the speech MP3 at its own rate converted to 16-bit
// (Galaxy's own decoder is not translated), the same PCM Galaxy's mixer
// plays (docs/galaxy-audio.md "Speech through Galaxy's voices"), and the
// mixer position is the library's read head when the worklet reports it.

const RING = 0x7fff; // samples in a streamed voice's loop (0x106120ca)

/** The first MPEG audio frame header at or after `from`: {at, version, layer,
 * rate, bitrate, padding} or null (the bit fields of ISO 11172-3 2.4.1.3). */
function mpegHeader(bytes, from) {
  for (let i = from; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[i + 1] >> 3) & 3, layer = (bytes[i + 1] >> 1) & 3;
    const bitrateIndex = bytes[i + 2] >> 4, rateIndex = (bytes[i + 2] >> 2) & 3;
    if (version === 1 || layer === 0 || rateIndex === 3 || bitrateIndex === 15) continue;
    return { at: i, version, layer, bitrateIndex, padding: (bytes[i + 2] >> 1) & 1,
      rate: [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]][version][rateIndex] };
  }
  return null;
}

/** MPEG audio frame header sample rate (Galaxy's record +0x3c for speech). */
export function mp3SampleRate(bytes) {
  return mpegHeader(bytes, 0)?.rate ?? null;
}

// Kilobits per second by [MPEG-1 ? 0 : 1][layer 3..1 as 0..2][index].
const BITRATES = [
  [[0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]],
  [[0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]],
];

/** The samples an MPEG audio stream's frames carry (a walk over the frame
 * headers from the first one: 384 per Layer I frame, 1152 per Layer II and
 * MPEG-1 Layer III frame, 576 per MPEG-2/2.5 Layer III frame), or null. A
 * host estimate of the decoded length (a decoder may drop its delay and the
 * encoder's padding); the host clock uses it until a decode gives the real
 * length. */
export function mp3Frames(bytes) {
  let header = mpegHeader(bytes, 0), samples = 0;
  if (!header) return null;
  while (header) {
    const mpeg1 = header.version === 3, layer = 4 - header.layer;
    const kbps = BITRATES[mpeg1 ? 0 : 1][layer - 1][header.bitrateIndex];
    if (!kbps) break; // free format: not walked
    const length = layer === 1 ? (Math.floor(12000 * kbps / header.rate) + header.padding) * 4
      : Math.floor((layer === 3 && !mpeg1 ? 72000 : 144000) * kbps / header.rate) + header.padding;
    samples += layer === 1 ? 384 : layer === 3 && !mpeg1 ? 576 : 1152;
    const next = header.at + length;
    if (next + 3 >= bytes.length) break;
    header = mpegHeader(bytes, next);
    if (header && header.at !== next) break; // lost sync: stop at the last whole frame
  }
  return samples;
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
 * services: {kernel (scriptVmKernel.lipsync), setPhoneme(actor, letter),
 * enabled() (optional: false while a replay feeds the original's letters)}.
 * `analyze(actor, {pcm, rate, position})`: the window of a streamed voice
 * (0x1060a0e9: the ring position `[0x46] - [0x52]`, the next 1024 samples to
 * be mixed, zero-filled past the end of the ring, no wrap) at `position`
 * (samples the mixer has passed), analysed at `rate` into the Pawn's
 * nextPhoneme. Returns the letter.
 */
export function createLipSyncAnalysis(services) {
  const analysis = {
    analyses: 0,
    enabled: () => services.enabled?.() ?? true,
    analyze(actor, { pcm, rate, position }) {
      const stream = Math.max(0, Math.floor(position));
      const ring = stream % RING, available = Math.min(1024, RING - ring);
      const window = new Uint8Array(2048);
      window.set(pcm.subarray(Math.min(pcm.length, stream * 2), Math.min(pcm.length, (stream + available) * 2)));
      const letter = services.kernel.analyze(window, available, rate);
      services.setPhoneme(actor, letter);
      analysis.analyses++;
      return letter;
    },
  };
  return analysis;
}
