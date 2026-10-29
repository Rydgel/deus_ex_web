#!/usr/bin/env node
/** Galaxy's sample entries and effect voices (docs/galaxy-music/effects.md)
 * in the Rust kernel (native/galaxy-kernel/src/effects.rs, with the mixer of
 * mixer.rs and sequencer.rs) against the original Galaxy.dll running under
 * Unicorn (scripts/native-galaxy-effects-oracle.py), bit for bit:
 *
 * - glxLoadSample on every shipped WAV sound (549, from DeusExSounds,
 *   Ambient and MoverSFX) and on synthetic WAVs for the loader's other
 *   branches: the glxSample record and its Data block (with the 31-byte pad);
 * - glxStartSample, glxControlSample, glxControlVoice (status, mode, volume),
 *   glxStopSample and glxUnloadSample, each op's result and the 32 first voice records, and
 *   the mixer's output: the sequencer/mixer trace (U/T/K/M/R) and the
 *   renderer's int16 PCM of both buses per 20 ms callback, with music playing
 *   alongside in some programs; seeded random programs of the subsystem's
 *   kind of calls;
 * - the browser path galaxy_render (bus A stored, bus B added onto the same
 *   frames) against the original renderer called with posB = posA;
 * - instruction coverage of the entries, unreached runs explained;
 * - mutants 301..304, each of which must be caught.
 *
 *   node scripts/validate-galaxy-effects.mjs [--refresh] [--cases a,b]
 *
 * Needs NATIVE_PROBE_PYTHON, the IT modules in .cache/galaxy-music/modules
 * (validate-galaxy-music-loader.mjs writes them) and src/runtime/galaxy-kernel.wasm.
 * Oracle outputs are cached in .cache/galaxy-effects, keyed by the oracle
 * scripts, the samples and the case list. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeSoundResource} from '../src/runtime/script-sound-resource.mjs';
import {createGalaxyAudio} from '../src/runtime/galaxy-audio.mjs';
import {loadScriptVmKernel} from '../src/runtime/script-vm-kernel.mjs';
import {gameDirectory} from './game-directory.mjs';

// PlaySound and Update's arithmetic runs in the Rust core, as in Play (galaxy.rs; GALAXY_AUDIO_BODY=js is the BigInt reference).
if (process.env.GALAXY_AUDIO_BODY !== 'js') await loadScriptVmKernel();

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const ORACLE = 'scripts/native-galaxy-effects-oracle.py';
const ORACLE_DEPS = [ORACLE, 'scripts/native-galaxy-music-sequencer-oracle.py', 'scripts/native-galaxy-music-oracle.py',
  'scripts/native-collision-oracle.py'];
const CACHE = '.cache/galaxy-effects';
const SAMPLES = path.join(CACHE, 'samples');
const MODULES = '.cache/galaxy-music/modules';
const WASM = 'src/runtime/galaxy-kernel.wasm';
const args = process.argv.slice(2);
const sha = bytes => createHash('sha256').update(bytes).digest();
const CALLBACK_FRAMES = 882, CALLBACK_BYTES = 3528, RING_SIZE = 176400;
const RING_A0 = RING_SIZE - CALLBACK_BYTES / 2, RING_D = RING_SIZE / 2;
const VOICE = 0xa0, RECORD_VOICES = 32, VOICE_BASE = 0x1068dca0;
const AHEAD = 7056;
const UNSUPPORTED_SPIN = 0x108, SPIN_MARK = 0xfffffffe;
const MUTANTS = {301: 'smpl loop end + 1', 302: 'control keeps the step', 303: 'default pan ignores GLX_PANNING',
  304: 'pad bytes not zeroed', 305: 'reverb kernel without the cross-feed', 306: 'reverb low-pass weights swapped'};

// ---- samples --------------------------------------------------------------------------

/** Every WAV Sound export of the effect packages, by `Package.Group.Name`. */
async function shippedWaves() {
  const root = gameDirectory();
  const files = ['System/DeusExSounds.u', 'Sounds/Ambient.uax', 'Sounds/MoverSFX.uax'].map(f => ({path: path.join(root, f), read: () => readFile(path.join(root, f))}));
  const assets = new AssetStore(files), out = new Map();
  for (const name of ['DeusExSounds', 'Ambient', 'MoverSFX']) {
    const asset = await assets.get(name);
    for (const entry of asset.pkg.exports) {
      if (entry.className !== 'Sound') continue;
      const decoded = decodeSoundResource({pkg: asset.pkg, bytes: asset.bytes, entry});
      if (decoded.lazy.formatName.toLowerCase() !== 'wav') continue;
      const start = entry.serialOffset + decoded.lazy.inlineOffset;
      const key = [...asset.exportsByPath].find(([, i]) => asset.pkg.exports[i - 1] === entry)?.[0];
      out.set(`${name}.${key ?? entry.objectName}`, asset.bytes.slice(start, start + decoded.lazy.byteCount));
    }
  }
  return out;
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
}
const pick = (r, list) => list[r() % list.length];

/** A RIFF WAVE from chunks [id, bytes]; `riffSize` overrides the header's size. */
function riff(chunks, riffSize = null) {
  const parts = [];
  for (const [id, body, pad = true] of chunks) {
    const head = Buffer.alloc(8); head.write(id, 0, 'latin1'); head.writeUInt32LE(body.length, 4);
    parts.push(head, body);
    if (pad && body.length & 1) parts.push(Buffer.alloc(1));
  }
  const body = Buffer.concat(parts), head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(riffSize ?? body.length + 4, 4); head.write('WAVE', 8, 'latin1');
  return Buffer.concat([head, body]);
}
function fmt({tag = 1, channels = 1, rate = 22050, bits = 16, align = channels * bits / 8, extra = null}) {
  const b = Buffer.alloc(16 + (extra ? extra.length : 0));
  b.writeUInt16LE(tag, 0); b.writeUInt16LE(channels, 2); b.writeUInt32LE(rate, 4); b.writeUInt32LE(rate * align, 8);
  b.writeUInt16LE(align, 12); b.writeUInt16LE(bits, 14);
  if (extra) extra.copy(b, 16);
  return b;
}
function smpl(loops) {
  const b = Buffer.alloc(36 + 24 * loops.length);
  b.writeUInt32LE(loops.length, 28);
  loops.forEach(([type, start, end], i) => { const o = 36 + 24 * i; b.writeUInt32LE(i, o); b.writeUInt32LE(type, o + 4); b.writeUInt32LE(start, o + 8); b.writeUInt32LE(end, o + 12); });
  return b;
}
function noise(seed, n) { const r = rng(seed), b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = r() & 0xff; return b; }

/** Synthetic WAVs for the loader's branches the shipped files do not take. */
function syntheticWaves() {
  const list = {
    'syn.8bit-loop': riff([['fmt ', fmt({bits: 8, rate: 11025})], ['data', noise(1, 501)], ['smpl', smpl([[0, 10, 400]])]]),
    'syn.pingpong': riff([['fmt ', fmt({})], ['data', noise(2, 2000)], ['smpl', smpl([[1, 100, 900]])]]),
    'syn.stereo': riff([['fmt ', fmt({channels: 2})], ['data', noise(3, 4000)]]),
    'syn.fmt-ext': riff([['fmt ', fmt({extra: Buffer.from([0, 0])})], ['data', noise(4, 1200)]]),
    'syn.adpcm-fmt-odd': riff([['fmt ', fmt({tag: 2, extra: Buffer.from([2, 0, 0xf4, 1, 7])})], ['LIST', noise(5, 33)], ['data', Buffer.alloc(64)]]),
    'syn.odd-list': riff([['fmt ', fmt({})], ['LIST', noise(6, 17)], ['data', noise(7, 1000)], ['cue ', noise(8, 3)]]),
    'syn.smpl-first': riff([['fmt ', fmt({})], ['smpl', smpl([[0, 5, 50]])], ['data', noise(9, 300)]]),
    'syn.two-data': riff([['fmt ', fmt({rate: 16000})], ['data', noise(10, 200)], ['data', noise(11, 600)], ['smpl', smpl([[0, 1, 99]])]]),
    'syn.no-data': riff([['fmt ', fmt({})], ['LIST', noise(12, 80)]]),
    'syn.truncated': riff([['fmt ', fmt({})], ['data', noise(13, 3000)]]).subarray(0, 1500),
    'syn.riff-short': riff([['fmt ', fmt({})], ['data', noise(14, 800)], ['smpl', smpl([[0, 3, 300]])]], 100),
    'syn.riff-long': riff([['fmt ', fmt({})], ['data', noise(15, 800)]], 5000),
    'syn.smpl-zero': riff([['fmt ', fmt({})], ['data', noise(16, 400)], ['smpl', smpl([])], ['LIST', noise(17, 40)]]),
    'syn.align4': riff([['fmt ', fmt({align: 4})], ['data', noise(18, 1003)]]),
    'syn.bits24': riff([['fmt ', fmt({bits: 24, align: 3})], ['data', noise(19, 900)]]),
    'syn.smpl-two-loops': riff([['fmt ', fmt({})], ['data', noise(20, 600)], ['smpl', smpl([[1, 7, 77], [0, 1, 2]])]]),
  };
  return new Map(Object.entries(list));
}

// ---- cases ------------------------------------------------------------------------------

const REAL = ['DeusExSounds.generic.beep1', 'ambient.ambient.babycrying', 'deusexsounds.generic.alarmunithum',
  'deusexsounds.weapons.plasmariflefire', 'deusexsounds.special.phonevoice1', 'ambient.ambient.tvnewsneutral',
  'deusexsounds.generic.spark2', 'deusexsounds.weapons.lamambient', 'moversfx.door.metaldoorclose'];

function voiceProgram(samples, extra = []) {
  return [{op: 'sampleVolume', volume: 127, mode: 0}, ...samples.map(sample => ({op: 'loadSample', sample})), {op: 'ahead', value: AHEAD},
    {op: 'pin', voiceCounter: 0, tickCounter: 0}, ...extra];
}

/** A glxReverb as Update's reverb tail builds it (galaxy-audio.mjs) for a
 * zone, with the setup's FCOS input and the model's result for it (the
 * oracle replaces Unicorn's double-precision FCOS with it; the coefficient
 * it yields equals the hardware's at every reachable input,
 * validate-galaxy-reverb.mjs). */
function reverbOp(zone, cosOf) {
  let words = null;
  const listener = {Region: {'engine.actor.pointregion.zone': {bReverbZone: true, ...zone}}};
  createGalaxyAudio({effectsChannels: 16, ambientFactor: 0.7, dopplerSpeed: 6500, soundVolume: 204, speechVolume: 255, useSurround: 0,
    reverseStereo: 0, useReverb: 1}, {listener: () => ({actor: listener, viewTarget: null}),
    read: (object, name) => name === 'Location' ? [0, 0, 0] : name === 'ShowFlags' ? 0 : object[name],
    library: {lock() {}, unlock() {}, setSampleReverb: w => { words = w; return 0; }}})
    .update(0, {origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1]});
  const block = Buffer.from(words?.buffer ?? new ArrayBuffer(0x6c), 0, 0x6c);
  const cos = cosOf(block.readUInt32LE(0x10));
  const part = (b, at) => [b.readBigUInt64LE(at).toString(16), b.readUInt16LE(at + 8).toString(16)];
  return {op: 'sampleReverb', block: block.toString('hex'), cos: [[...part(cos, 0), ...part(cos, 10)]]};
}
const ROOM = {MasterGain: 100, CutoffHz: 6000, Delay: [20, 34, 0, 0, 0, 0], Gain: [150, 70, 0, 0, 0, 0]};
const GARAGE = {MasterGain: 255, CutoffHz: 1000, Delay: [40, 70, 10, 5, 3, 1], Gain: [44, 140, 30, 20, 10, 5]};
const SILENT = {MasterGain: 0, CutoffHz: 6000, Delay: [20, 34, 0, 0, 0, 0], Gain: [150, 70, 0, 0, 0, 0]};

function cases(waves, synthetic, realNames, cosOf) {
  const [beep, baby, hum, plasma, phone, tv, spark, lam, door] = realNames;
  const out = [];
  out.push({name: 'load-shipped', program: [...waves.keys()].map(sample => ({op: 'loadSample', sample}))});
  const spins = ['syn.riff-long', 'syn.riff-short'];
  out.push({name: 'load-synthetic', program: [...synthetic.keys()].filter(n => !spins.includes(n)).map(sample => ({op: 'loadSample', sample}))});
  // A RIFF size past the data, or one the chunks overrun (remaining wraps): the
  // loader's chunk loop never sees remaining == 0 and never returns.
  for (const sample of spins) out.push({name: `load-spin-${sample.replace('syn.', '')}`, program: [{op: 'loadSample', sample: 'syn.8bit-loop'}, {op: 'loadSample', sample}]});
  const run = callbacks => ({op: 'run', callbacks});
  const basic = [
    {op: 'startSample', voice: 1, sample: beep, freq: 22050, vol: 0x4000, pan: 0x4000},
    {op: 'controlVoice', slot: 0, cmd: 2}, run(3), {op: 'controlVoice', slot: 0, cmd: 2},
    {op: 'startSample', voice: 2, sample: hum, freq: 22050, vol: 0x7fff, pan: 0x1000}, run(5),
    {op: 'controlSample', slot: 1, freq: 30000, vol: 0x2000, pan: 0x7000}, run(4),
    {op: 'controlSample', slot: 1, freq: 21000, vol: 0x6000, pan: 0xc000}, run(3),
    {op: 'startSample', voice: 16, sample: plasma, freq: -1, vol: -1, pan: -1, flags: 1}, run(2),
    {op: 'startSample', voice: 3, sample: null, freq: 22050, vol: 0x1000, pan: 0},
    {op: 'startSample', voice: 4, sample: phone, freq: 11025, vol: 0x3000, pan: 0x7fff, flags: 3}, run(6),
    {op: 'controlVoice', slot: 3, cmd: 0, p1: 0}, run(2), {op: 'controlVoice', slot: 3, cmd: 0, p1: 1},
    {op: 'controlVoice', slot: 3, cmd: 0, p1: 2}, {op: 'controlVoice', slot: 3, cmd: 1, p1: 0x40, p2: 0},
    {op: 'controlVoice', slot: 3, cmd: 1, p1: 0x10, p2: 3}, {op: 'controlVoice', slot: 3, cmd: 1, p1: 0x50, p2: 2},
    {op: 'controlVoice', slot: 3, cmd: 1, p1: 0x80, p2: 0}, {op: 'controlVoice', slot: 3, cmd: 7},
    {op: 'controlVoice', slot: 3, cmd: -1}, {op: 'controlVoice', slot: null, cmd: 2},
    {op: 'controlSample', slot: null, freq: 1, vol: 1, pan: 1}, {op: 'stopSample', slot: null},
    {op: 'stopSample', slot: 1}, run(2), {op: 'stopSample', slot: 1}, {op: 'controlVoice', slot: 1, cmd: 2},
    {op: 'stopSample', slot: 9}, {op: 'controlSample', slot: 1, freq: 22050, vol: 0x100, pan: 0x100}, run(1),
    {op: 'startSample', voice: 2, sample: baby, freq: 16000, vol: 0x5000, pan: 0x2000}, run(3),
    {op: 'startSample', voice: 2, sample: baby, freq: 32000, vol: 0x5000, pan: 0x3fff}, run(3),
    {op: 'startSample', voice: 5, sample: spark, freq: 88200, vol: 0x7fff, pan: 0}, run(2),
    {op: 'startSample', voice: 6, sample: tv, freq: 0, vol: 0x7fff, pan: 0}, run(2),
    {op: 'startSample', voice: 7, sample: lam, freq: 300000, vol: 0x80, pan: 0x6000}, run(2),
    {op: 'startSample', voice: 8, sample: door, freq: 22050, vol: 0x7fff, pan: 0x4000}, run(40),
    {op: 'controlVoice', slot: 7, cmd: 2}, {op: 'controlVoice', slot: 0, cmd: 2},
    {op: 'sampleVolume', volume: 64, mode: 0}, run(2), {op: 'sampleVolume', volume: 127, mode: 3}, run(10),
    {op: 'sampleVolume', volume: 200, mode: 0}, run(1),
  ];
  out.push({name: 'voices-basic', program: voiceProgram(realNames, basic)});
  out.push({name: 'voices-basic-browser', program: voiceProgram(realNames, [{op: 'heads', same: true}, ...basic])});
  out.push({name: 'voices-synthetic', program: voiceProgram([...synthetic.keys()].filter(n => !/stereo|truncated|no-data|adpcm|riff-/.test(n)), [
    ...['syn.8bit-loop', 'syn.pingpong', 'syn.fmt-ext', 'syn.odd-list', 'syn.smpl-first', 'syn.two-data',
      'syn.smpl-zero', 'syn.align4', 'syn.bits24', 'syn.smpl-two-loops'].map((sample, i) =>
      ({op: 'startSample', voice: i + 1, sample, freq: [11025, 22050, 44100, 16000][i % 4] + 13 * i, vol: 0x7fff - 999 * i, pan: 0x1000 * i})),
    run(30)])});
  const music = [{op: 'load', module: 'Intro_Music'}, {op: 'start', section: 0},
    {op: 'startSample', voice: 1, sample: hum, freq: 22050, vol: 0x7fff, pan: 0x3000},
    {op: 'startSample', voice: 9, sample: baby, freq: 16000, vol: 0x7fff, pan: 0x5000}, run(20),
    {op: 'startSample', voice: 2, sample: plasma, freq: 44100, vol: 0x7fff, pan: 0x4000}, run(30),
    {op: 'controlSample', slot: 0, freq: 26000, vol: 0x7fff, pan: 0x0}, run(10)];
  out.push({name: 'voices-music', program: voiceProgram([hum, baby, plasma], music)});
  out.push({name: 'voices-music-browser', program: voiceProgram([hum, baby, plasma], [{op: 'heads', same: true}, ...music])});
  // Sample defaults (-1), which the subsystem never passes; a restart on a voice
  // whose pan differs from the sample's.
  out.push({name: 'voices-defaults', program: voiceProgram([hum, baby, 'syn.8bit-loop'], [
    {op: 'startSample', voice: 3, sample: hum, freq: 22050, vol: 0x7fff, pan: 0x1234}, run(2),
    {op: 'startSample', voice: 3, sample: hum, freq: -1, vol: -1, pan: -1}, run(2),
    {op: 'startSample', voice: 4, sample: 'syn.8bit-loop', freq: 7000, vol: 0x6000, pan: 0x6000}, run(1),
    {op: 'controlSample', slot: 3, freq: -1, vol: -1, pan: -1}, run(2),
    {op: 'controlSample', slot: 2, freq: -1, vol: 0x2000, pan: 0x7000}, run(1),
    {op: 'controlSample', slot: 2, freq: 30000, vol: -1, pan: -1}, run(2),
    // An idle voice (type 0, no GLX_PANNING): pan -1 keeps its +0x14.
    {op: 'controlSample', slot: 9, freq: 22050, vol: 0x100, pan: -1}])});
  // UnregisterSound's glxUnloadSample: the voices playing the sample stop (two here), another sample's voice plays
  // on; a NULL sample; a sample loaded and never started.
  out.push({name: 'voices-unload', program: voiceProgram([hum, baby, beep], [
    {op: 'startSample', voice: 1, sample: hum, freq: 22050, vol: 0x7fff, pan: 0x3000},
    {op: 'startSample', voice: 2, sample: hum, freq: 16000, vol: 0x6000, pan: 0x5000},
    {op: 'startSample', voice: 3, sample: baby, freq: 22050, vol: 0x7fff, pan: 0x4000}, run(4),
    {op: 'unloadSample', sample: hum}, run(4), {op: 'unloadSample', sample: null}, {op: 'unloadSample', sample: beep}, run(2),
    {op: 'unloadSample', sample: baby}, run(2)])});
  // No effect channels (Init clamps EffectsChannels to 0..32): the start refuses.
  out.push({name: 'voices-no-channels', program: voiceProgram([hum], [{op: 'poke', address: 0x1068828d, width: 1, value: 0},
    {op: 'startSample', voice: 1, sample: hum, freq: 22050, vol: 0x7fff, pan: 0x4000}, run(1)])});
  // An Amiga-slide module (Endgame1_Music, IT flags 0x13) sets player mode bit 0:
  // the start's period is then 6848 * 0x20ab / C4Speed (0x1061262c).
  out.push({name: 'voices-amiga-mode', program: voiceProgram([hum, spark], [{op: 'load', module: 'Endgame1_Music'},
    {op: 'startSample', voice: 1, sample: hum, freq: 22050, vol: 0x7fff, pan: 0x4000},
    {op: 'startSample', voice: 2, sample: spark, freq: 0, vol: 0x7fff, pan: 0x4000}, run(3)])});
  // Quotes_Music section 4: negative run counts move the bus pointers back over
  // d04 (HAZARD_BUS_UNDERRUN, docs/galaxy-music/mixer.md §8.3), so bus B holds
  // music the renderer adds; the browser path against the original renderer at
  // coincident heads (validate-galaxy-mixer.mjs checks the two-head ring).
  out.push({name: 'quotes-s4-browser', program: [{op: 'load', module: 'Quotes_Music'}, {op: 'start', section: 4},
    {op: 'pin', voiceCounter: 0, tickCounter: 0}, {op: 'ahead', value: AHEAD}, {op: 'heads', same: true}, run(250)]});
  // The effects reverb: glxSetSampleReverb installing, changing and freeing
  // the SSE engine, the renderer's hook on (d04, d0c) between the mix and the
  // conversions, with voices and with music.
  const reverbVoices = [
    {op: 'startSample', voice: 1, sample: plasma, freq: 44100, vol: 0x7fff, pan: 0x2000},
    {op: 'startSample', voice: 2, sample: hum, freq: 22050, vol: 0x6000, pan: 0x6000},
    {op: 'startSample', voice: 3, sample: beep, freq: 22050, vol: 0x7fff, pan: 0x4000},
    reverbOp(ROOM, cosOf), run(12), reverbOp(ROOM, cosOf), run(2),
    reverbOp(GARAGE, cosOf), {op: 'startSample', voice: 4, sample: spark, freq: 22050, vol: 0x7fff, pan: 0x7000}, run(20),
    reverbOp(SILENT, cosOf), run(4), reverbOp(ROOM, cosOf), run(6),
    {op: 'stopSample', slot: 0}, {op: 'stopSample', slot: 1}, {op: 'stopSample', slot: 2}, {op: 'stopSample', slot: 3}, run(30)];
  out.push({name: 'reverb-voices', program: voiceProgram([plasma, hum, beep, spark], reverbVoices)});
  out.push({name: 'reverb-voices-browser', program: voiceProgram([plasma, hum, beep, spark], [{op: 'heads', same: true}, ...reverbVoices])});
  out.push({name: 'reverb-music-browser', program: voiceProgram([hum, baby], [{op: 'heads', same: true}, {op: 'load', module: 'Intro_Music'},
    {op: 'start', section: 0}, reverbOp(GARAGE, cosOf), {op: 'startSample', voice: 1, sample: hum, freq: 22050, vol: 0x7fff, pan: 0x3000},
    {op: 'startSample', voice: 9, sample: baby, freq: 16000, vol: 0x7fff, pan: 0x5000}, run(40)])});
  {
    const r = rng(500), ops = [];
    for (let i = 0; i < 40; i++) {
      const k = r() % 6;
      if (k === 0) ops.push(reverbOp({MasterGain: r() % 256, CutoffHz: r() % 44101, Delay: Array.from({length: 6}, () => r() % 256),
        Gain: Array.from({length: 6}, () => r() % 256)}, cosOf));
      else if (k < 3) ops.push({op: 'startSample', voice: 1 + r() % 16, sample: pick(r, realNames), freq: pick(r, [22050, 11025, 44100, 30000]),
        vol: pick(r, [0x7fff, 0x4000, 0x80]), pan: pick(r, [0, 0x4000, 0x7fff, 0xc000])});
      else ops.push(run(1 + r() % 5));
    }
    out.push({name: 'reverb-random', program: voiceProgram(realNames, ops)});
  }
  // Random programs of the subsystem's kind of calls.
  // No ping-pong sample here: glxControlSample recomputes a positive step even
  // on a ping-pong loop's backward pass (0x1060d30e), so the next run count is
  // negative and the bus pointers leave the bus block (the HAZARD_BUS_UNDERRUN
  // path, past the non-SSE table block): original memory corruption that no
  // shipped effect reaches (every shipped loop is forward, smpl type 0).
  const mono = [...realNames, ...['syn.8bit-loop', 'syn.two-data']];
  for (let p = 0; p < 8; p++) {
    const r = rng(100 + p), ops = p & 1 ? [{op: 'heads', same: true}] : [];
    for (let i = 0; i < 60; i++) {
      const kind = r() % 10, slot = r() % 16;
      const freq = pick(r, [22050, 11025, 16000, 44100, 15000, 33075, 6000, 22051, r() % 90000]);
      const vol = pick(r, [0x7fff, 0x80, 0x4000, r() & 0x7fff]), pan = pick(r, [0, 0x3fff, 0x4000, 0x7fff, 0xc000, r() & 0x7fff]);
      if (kind < 3) ops.push({op: 'startSample', voice: slot + 1, sample: pick(r, mono), freq, vol, pan, flags: r() % 5 === 0 ? 1 : 0});
      else if (kind < 6) ops.push({op: 'controlSample', slot, freq, vol, pan});
      else if (kind === 6) ops.push({op: 'stopSample', slot});
      else if (kind === 7) ops.push({op: 'controlVoice', slot, cmd: 2});
      else if (kind === 8 && r() % 4 === 0) ops.push({op: 'sampleVolume', volume: r() % 128, mode: r() % 3});
      else ops.push(run(1 + r() % 6));
    }
    ops.push(run(4));
    out.push({name: `voices-random-${p}`, program: voiceProgram(mono, ops)});
  }
  return out;
}

// ---- oracle --------------------------------------------------------------------------------

async function runOracle(list, samples) {
  await mkdir(SAMPLES, {recursive: true});
  const key = createHash('sha256');
  for (const f of ORACLE_DEPS) key.update(await readFile(f));
  for (const [name, bytes] of samples) {
    key.update(name); key.update(bytes);
    const file = path.join(SAMPLES, `${name}.wav`);
    if (!existsSync(file)) await writeFile(file, bytes);
  }
  const casesJson = JSON.stringify(list.map(({name, program}) => ({name, program})));
  key.update(casesJson);
  const digest = key.digest('hex'), keyFile = path.join(CACHE, 'key.txt');
  if (!args.includes('--refresh') && existsSync(keyFile) && (await readFile(keyFile, 'utf8')) === digest) return;
  await writeFile(path.join(CACHE, 'cases.json'), casesJson);
  console.log(`oracle: ${list.length} cases ...`);
  execFileSync(python, [ORACLE, gameDirectory(), MODULES, SAMPLES, path.join(CACHE, 'cases.json'), CACHE],
    {stdio: ['ignore', 'inherit', 'inherit']});
  await writeFile(keyFile, digest);
}

// ---- Rust kernel ------------------------------------------------------------------------------

class Groups {
  constructor(x) { this.x = x; this.cursor = 0; this.hash = createHash('sha256'); this.digests = []; this.records = []; this.keep = 256; }
  bytes(ptr, len) { return new Uint8Array(this.x.memory.buffer, ptr, len); }
  pull() {
    const x = this.x;
    if (!x.galaxy_trace_ptr()) return;
    const gn = x.galaxy_trace_groups_len();
    const ends = gn ? new Uint32Array(x.memory.buffer, x.galaxy_trace_groups_ptr(), gn).slice() : [];
    for (const e of ends) { this.feed(this.bytes(x.galaxy_trace_ptr() + this.cursor, e - this.cursor)); this.close(); this.cursor = e; }
    if (gn) { x.galaxy_trace_consume(); this.cursor -= ends[gn - 1]; }
    const len = x.galaxy_trace_len();
    this.feed(this.bytes(x.galaxy_trace_ptr() + this.cursor, len - this.cursor));
    this.cursor = len;
  }
  feed(bytes) { this.hash.update(bytes); if (this.digests.length < this.keep) this.records.push(Buffer.from(bytes)); }
  record(tag, payload) {
    const head = Buffer.alloc(5); head[0] = tag.charCodeAt(0); head.writeUInt32LE(payload.length, 1);
    this.feed(head); this.feed(payload);
  }
  close() { this.digests.push(this.hash.digest().subarray(0, 8)); this.hash = createHash('sha256'); }
}

const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };

function replay(x, c, samples, modules, mutant) {
  x.galaxy_set_mutant(mutant);
  x.galaxy_reset(16);
  x.galaxy_seq_setup(64);
  x.galaxy_seq_trace(1);
  const g = new Groups(x), addr = new Map();
  let same = false, a = RING_A0, b = (RING_A0 + RING_D) % RING_SIZE, ring = x.galaxy_mixer_ring(RING_SIZE);
  const pcm = [];
  let spun = false, peak = 0;
  const check = what => { const f = x.galaxy_fault(); if (f) throw new Error(`${c.name} ${what}: fault 0x${f.toString(16)}`); };
  const voices = result => Buffer.concat([u32(result), Buffer.from(new Uint8Array(x.memory.buffer, x.galaxy_voices_ptr(), RECORD_VOICES * VOICE))]);
  const mem = () => new Uint8Array(x.memory.buffer);
  const ptr = slot => slot == null ? 0 : VOICE_BASE + slot * VOICE;
  for (const s of c.program) {
    if (s.op === 'loadSample') {
      const bytes = samples.get(s.sample);
      const input = x.galaxy_input(bytes.length);
      new Uint8Array(x.memory.buffer, input, bytes.length).set(bytes);
      const result = x.galaxy_sample_load(bytes.length) >>> 0;
      if (x.galaxy_fault() === UNSUPPORTED_SPIN) { g.pull(); g.record('W', u32(SPIN_MARK)); g.close(); spun = true; break; }
      check(`loadSample ${s.sample}`);
      g.pull();
      let payload = u32(result);
      if (result) {
        const record = Buffer.from(new Uint8Array(x.memory.buffer, x.galaxy_sample_record(result), 0x48));
        const n = x.galaxy_sample_data_len(result);
        payload = Buffer.concat([payload, record, u32(n), Buffer.from(new Uint8Array(x.memory.buffer, x.galaxy_sample_data(result), n))]);
        addr.set(s.sample, result);
      }
      g.record('W', payload); g.close();
    } else if (s.op === 'startSample') {
      const sample = s.sample ? (addr.get(s.sample) ?? 0) : 0;
      const result = x.galaxy_sample_start(s.voice, sample, s.freq, s.vol, s.pan, s.flags ?? 0) >>> 0;
      check('startSample'); g.pull(); g.record('V', voices(result)); g.close();
    } else if (s.op === 'controlSample') {
      const result = x.galaxy_sample_control(ptr(s.slot), s.freq, s.vol, s.pan) >>> 0;
      check('controlSample'); g.pull(); g.record('V', voices(result)); g.close();
    } else if (s.op === 'stopSample') {
      const result = x.galaxy_sample_stop(ptr(s.slot)) >>> 0;
      check('stopSample'); g.pull(); g.record('V', voices(result)); g.close();
    } else if (s.op === 'unloadSample') {
      const sample = s.sample ? (addr.get(s.sample) ?? 0) : 0;
      const result = x.galaxy_sample_unload(sample) >>> 0;
      check('unloadSample'); g.pull();
      const freed = sample && !x.galaxy_sample_record(sample) ? 1 : 0;
      if (s.sample) addr.delete(s.sample);
      g.record('U', Buffer.concat([voices(result), u32(freed)])); g.close();
    } else if (s.op === 'controlVoice') {
      const result = x.galaxy_voice_control(ptr(s.slot), s.cmd, s.p1 ?? 0, s.p2 ?? 0) >>> 0;
      check('controlVoice'); g.pull(); g.record('V', voices(result)); g.close();
    } else if (s.op === 'sampleVolume') {
      const result = x.galaxy_set_sample_volume(s.volume, s.mode) >>> 0;
      g.pull(); g.record('V', voices(result)); g.close();
    } else if (s.op === 'sampleReverb') {
      mem().set(Buffer.from(s.block, 'hex'), x.galaxy_reverb_block());
      const result = x.galaxy_set_sample_reverb() >>> 0;
      check('sampleReverb');
      const state = x.galaxy_reverb_state();
      const header = state & 2 ? Buffer.from(new Uint8Array(x.memory.buffer, x.galaxy_reverb_ctx(), 0xc8)) : Buffer.alloc(0xc8);
      g.pull(); g.record('Y', Buffer.concat([u32(result), u32(state & 3), header])); g.close();
    } else if (s.op === 'heads') same = s.same;
    else if (s.op === 'ahead') x.galaxy_seq_ahead(s.value);
    else if (s.op === 'poke') { if (!x.galaxy_poke(s.address, s.value)) throw new Error(`poke ${s.address.toString(16)}`); }
    else if (s.op === 'pin') x.galaxy_seq_pin(s.voiceCounter, s.tickCounter);
    else if (s.op === 'load') {
      const module = modules[s.module];
      const input = x.galaxy_input(module.length);
      new Uint8Array(x.memory.buffer, input, module.length).set(module);
      x.galaxy_seq_load(module.length, 127, 76); g.pull();
    } else if (s.op === 'start') { x.galaxy_seq_start(16, s.section); g.pull(); }
    else if (s.op === 'run') {
      for (let i = 0; i < s.callbacks; i++) {
        if (same) {
          const out = x.galaxy_render(CALLBACK_FRAMES);
          check('render');
          const frame = new Int16Array(x.memory.buffer, out, 2 * CALLBACK_FRAMES);
          for (const v of frame) peak = Math.max(peak, Math.abs(v));
          pcm.push(sha(new Uint8Array(x.memory.buffer, out, CALLBACK_BYTES)).subarray(0, 8));
        } else {
          x.galaxy_mixer_ahead_now();
          const got = x.galaxy_render_ring(a, b, CALLBACK_BYTES, CALLBACK_BYTES);
          check('render_ring');
          if (got !== CALLBACK_BYTES) throw new Error(`${c.name}: renderer returned ${got}`);
          ring = x.galaxy_mixer_ring_ptr();
          const seg = pos => { const m = new Uint8Array(x.memory.buffer, ring, RING_SIZE), first = Math.min(CALLBACK_BYTES, RING_SIZE - pos);
            return Buffer.concat([m.subarray(pos, pos + first), m.subarray(0, CALLBACK_BYTES - first)]); };
          const sb = seg(b);
          for (let k = 0; k < sb.length; k += 2) peak = Math.max(peak, Math.abs(sb.readInt16LE(k)));
          pcm.push(Buffer.concat([sha(seg(a)).subarray(0, 8), sha(sb).subarray(0, 8)]));
        }
        a = (a + CALLBACK_BYTES) % RING_SIZE; b = (b + CALLBACK_BYTES) % RING_SIZE;
        g.pull();
      }
    } else throw new Error(`op ${s.op}`);
  }
  x.galaxy_seq_end(); g.pull();
  return {digests: g.digests, pcm: Buffer.concat(pcm), records: g.records, spun, peak};
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (Buffer.compare(Buffer.from(a[i]), Buffer.from(b[i]))) return i;
  return a.length === b.length ? -1 : n;
}
const chunks = (buf, size) => Array.from({length: buf.length / size}, (_, i) => buf.subarray(i * size, (i + 1) * size));

/** Records (tag, payload) of a .full trace. */
function parseRecords(buf) {
  const out = [];
  for (let at = 0; at + 5 <= buf.length;) { const len = buf.readUInt32LE(at + 1); out.push({tag: String.fromCharCode(buf[at]), payload: buf.subarray(at + 5, at + 5 + len)}); at += 5 + len; }
  return out;
}

/** The first differing record of the first differing group, decoded for W/V. */
function explain(oracleFull, rustRecords, group, oracleDig) {
  const ours = parseRecords(Buffer.concat(rustRecords)), theirs = parseRecords(oracleFull);
  for (let i = 0; i < Math.min(ours.length, theirs.length); i++) {
    const o = ours[i], t = theirs[i];
    if (o.tag === t.tag && !Buffer.compare(o.payload, t.payload)) continue;
    if (o.tag !== t.tag) return `record ${i}: tag ${o.tag} vs ${t.tag}`;
    for (let k = 0; k < Math.min(o.payload.length, t.payload.length); k++) {
      if (o.payload[k] !== t.payload[k]) {
        let where = `byte ${k}`;
        if (o.tag === 'V' && k >= 4) where = `voice ${Math.floor((k - 4) / VOICE)} +0x${((k - 4) % VOICE).toString(16)}`;
        if (o.tag === 'W') where = k < 4 ? 'result' : k < 0x4c ? `record +0x${(k - 4).toString(16)}` : k < 0x50 ? 'data size' : `data byte ${k - 0x50}`;
        return `record ${i} (${o.tag}) ${where}: ${o.payload[k]} vs ${t.payload[k]} (lengths ${o.payload.length}/${t.payload.length})`;
      }
    }
    return `record ${i} (${o.tag}) lengths ${o.payload.length} vs ${t.payload.length}`;
  }
  return `group ${group} (records beyond the kept window)`;
}

// ---- coverage -----------------------------------------------------------------------------------

// Unreached instruction runs (start address -> reason); any other fails.
const UNREACHED = {
  // glxLoadSample
  0x10618e7b: 'GLX_LOADFROMSTREAM (flags 1): RegisterSound passes GLX_LOADFROMMEMORY only (0x10606b91)',
  0x10618f21: "the 'AS  ' loader 0x1062b640: no shipped sound (census: 549 WAV, 10080 MP3)",
  0x10618f44: "the '.snd' loader 0x1062b4c0: no shipped sound",
  0x10618f79: "the 'SCRS' loader 0x1062b410 and the MPEG path 0x10620b30 (not translated): UserInterface.Menu_SpeechTest is the one shipped effect it would take; conversation speech keeps its own transport",
  // WAV loader
  0x10619b1c: 'IMA ADPCM data (format 0x11): no shipped WAV (every one is PCM)',
  0x10619cd1: 'GLX_LOADASSTREAMING (flags 8) and MPEG WAVs (format 0x55): not passed / not shipped',
  // glxStartSample
  0x1061234b: "a Sample whose FourCC is not 'SAMP': the subsystem passes only glxLoadSample's results",
  0x10612395: 'Voice 0 (the free-voice search): the subsystem passes its channel + 1 (0x1060a42e)',
  0x10612452: 'the ring path (types 0xe000, 0x40: compressed, streamed, stereo): no shipped effect',
  0x10612492: 'the second voice of a stereo pair (type 0x40): no shipped effect',
  0x106124e9: 'the ring allocation (types 0xe000, 0x40)',
  0x10612562: 'the ring loop setup (types 0xe000, 0x40)',
  0x106125ce: "a stereo pair's default pan (0 / 0x7fff)",
  0x10612674: "a stereo pair's Link",
  0x106126bd: "ReleaseMutex of a stereo pair's first voice",
  0x1061271b: '3D voices (output type [0x1069817a] is 0: Use3dHardware False)',
  // glxControlVoice / glxStopSample
  0x1060cf5c: 'the status of a 3D voice (+0x11 bit 2; Use3dHardware False)',
  0x1061848a: 'the release of a 3D voice (Use3dHardware False)',
  0x10618503: 'the ring buffer free (types 0xe000, 0x40)',
  0x1061953a: 'glxUnloadSample of a sample a 3D voice plays (+0x11 bit 2; Use3dHardware False)',
  0x10619567: "glxUnloadSample's free of +0x40: zero in every WAV record (glxLoadSample zeroes the record, rep stosd 0x10618eef; of the WAV loader only the IMA ADPCM branch writes it, 0x10619b30: no shipped WAV is ADPCM)",
  // glxSetSampleReverb and the reverb setup
  0x1061147b: 'the 3DNow and MMX reverb engines (0x106220e7, 0x1062135b): the CPU has SSE, which selects 0x10622d33',
  0x10611577: 'EAX reverb properties on a free (output type 3 or 5): output type 0',
  0x10610e9e: 'the EAX branch of the setup (output type 3 or 5): output type 0, so the setup returns after the six taps',
  0x10611221: 'a refused block (Volume outside [-1, 1], HFDamp above the rate): Update never builds one; validate-galaxy-reverb.mjs runs them natively',
  ...Object.fromEntries([0x10610af7, 0x10610b89, 0x10610c15, 0x10610ca1, 0x10610d2c, 0x10610db8].map(a => [a,
    'a zero delay Time (0.001f instead): Update clamps Time to at least 0.001; validate-galaxy-reverb.mjs runs it natively'])),
  ...Object.fromEntries([0x10610b0c, 0x10610b9e, 0x10610c2a, 0x10610cb6, 0x10610d41, 0x10610dcd].map(a => [a,
    'a delay gain 1 - Gain of exactly 1 (0.999f instead): Update clamps Gain to at least 0.001; validate-galaxy-reverb.mjs runs it natively'])),
  // renderer: the hooks other than the effects reverb (null for DX, docs/galaxy-music/mixer.md §3)
  0x1061476c: 'music reverb hook [0x10684ea8]: only the unreferenced "AE  " loader installs it',
  0x106147c0: 'music chorus hook [0x10698388]: its setter has no caller',
  0x106147ea: 'effects chorus hook [0x106981c8]: its setter has no caller',
};
function runs(entry) {
  const covered = new Set(entry.covered), out = [];
  let run = null;
  for (const [a, text] of entry.instructions) {
    if (covered.has(a)) { run = null; continue; }
    if (!run) out.push(run = {start: a, count: 0, first: text});
    run.count++;
  }
  return out;
}

// ---- main -----------------------------------------------------------------------------------------

const waves = await shippedWaves();
const synthetic = syntheticWaves();
const samples = new Map([...waves, ...synthetic]);
const lower = new Map([...waves.keys()].map(k => [k.toLowerCase(), k]));
const realNames = REAL.map(n => { const k = lower.get(n.toLowerCase()); if (!k) throw new Error(`no shipped sound ${n}`); return k; });
const only = args.includes('--cases') ? new Set(args[args.indexOf('--cases') + 1].split(',')) : null;
const {instance} = await WebAssembly.instantiate(await readFile(WASM));
const x0 = instance.exports;
x0.galaxy_reset(16); x0.galaxy_seq_setup(64);
const cosOf = hf => { const p = x0.galaxy_reverb_cos(hf); return Buffer.from(new Uint8Array(x0.memory.buffer, p, 20)); };
const list = cases(waves, synthetic, realNames, cosOf).filter(c => !only || only.has(c.name));
await runOracle(list, samples);
let lastRing = 0;
const x = Object.assign(Object.create(null), x0, {
  galaxy_mixer_ring: n => (lastRing = x0.galaxy_mixer_ring(n)), galaxy_mixer_ring_ptr: () => lastRing,
});
const modules = {Intro_Music: await readFile(path.join(MODULES, 'Intro_Music.it')),
  Endgame1_Music: await readFile(path.join(MODULES, 'Endgame1_Music.it')), Quotes_Music: await readFile(path.join(MODULES, 'Quotes_Music.it'))};
let failures = 0;
const fail = msg => { failures++; console.log(`FAIL ${msg}`); };
let totalGroups = 0, totalCallbacks = 0, totalLoads = 0, totalVoiceOps = 0;
for (const c of list) {
  const oracleDig = chunks(await readFile(path.join(CACHE, `${c.name}.dig`)), 8);
  const sameHeads = c.program.some(s => s.op === 'heads' && s.same);
  const oraclePcm = chunks(await readFile(path.join(CACHE, `${c.name}.pcm.dig`)), sameHeads ? 8 : 16);
  const info = JSON.parse(await readFile(path.join(CACHE, `${c.name}.json`), 'utf8'));
  let rust;
  try { rust = replay(x, c, samples, modules, 0); } catch (e) { fail(`${c.name}: ${e.message}`); continue; }
  const d = firstDiff(rust.digests, oracleDig), p = firstDiff(chunks(rust.pcm, sameHeads ? 8 : 16), oraclePcm);
  const loads = c.program.filter(s => s.op === 'loadSample').length, voiceOps = c.program.filter(s => /Sample|Voice|sampleVolume/.test(s.op) && !['loadSample', 'sampleReverb'].includes(s.op)).length, reverbOps = c.program.filter(s => s.op === 'sampleReverb').length;
  totalGroups += oracleDig.length; totalCallbacks += oraclePcm.length; totalLoads += loads; totalVoiceOps += voiceOps;
  const label = `${c.name}: ${loads} loads, ${voiceOps} voice ops, ${reverbOps ? `${reverbOps} reverb changes, ` : ""}${oraclePcm.length} callbacks${sameHeads ? ' (galaxy_render, coincident heads)' : ''}, ${oracleDig.length} groups`;
  if (d >= 0 || p >= 0) {
    const why = d >= 0 ? explain(await readFile(path.join(CACHE, `${c.name}.full`)), rust.records, d, oracleDig) : '';
    fail(`${label}: trace group ${d}, PCM callback ${p}${why ? `: ${why}` : ''}`);
  } else {
    const nonzero = info.steps.filter(s => s.loadSample !== undefined && s.result).length;
    console.log(`${label}: bit-equal${loads ? ` (${nonzero} samples loaded)` : ''}${oraclePcm.length ? `, peak |sample| ${rust.peak} (bus B${sameHeads ? ' + A' : ''})` : ''}`);
  }
}
console.log(`${list.length} cases, ${totalLoads} loads, ${totalVoiceOps} voice ops, ${totalCallbacks} callbacks, ${totalGroups} groups`);

// Coverage.
if (existsSync(path.join(CACHE, 'coverage.json')) && !only) {
  const coverage = JSON.parse(await readFile(path.join(CACHE, 'coverage.json'), 'utf8'));
  for (const entry of coverage) {
    const unreached = runs(entry);
    console.log(`coverage ${entry.function}: ${entry.covered.length}/${entry.instructions.length}` +
      (unreached.length ? `; unreached: ${unreached.map(r => `${r.start.toString(16)}(${r.count}) ${UNREACHED[r.start] ?? `? ${r.first}`}`).join('; ')}` : ''));
    for (const run of unreached) if (!UNREACHED[run.start]) fail(`coverage ${entry.function}: unexplained unreached run ${run.start.toString(16)} (${run.count}: ${run.first})`);
  }
}

// Mutants.
if (!only) {
  for (const [id, label] of Object.entries(MUTANTS)) {
    const caught = [];
    for (const c of list) {
      const oracleDig = chunks(await readFile(path.join(CACHE, `${c.name}.dig`)), 8);
      const sameHeads = c.program.some(s => s.op === 'heads' && s.same);
      const oraclePcm = chunks(await readFile(path.join(CACHE, `${c.name}.pcm.dig`)), sameHeads ? 8 : 16);
      try {
        const r = replay(x, c, samples, modules, +id);
        if (firstDiff(r.digests, oracleDig) >= 0 || firstDiff(chunks(r.pcm, sameHeads ? 8 : 16), oraclePcm) >= 0) caught.push(c.name);
      } catch (e) { caught.push(`${c.name} (fault)`); }
    }
    if (!caught.length) fail(`mutant ${id} (${label}) not caught`);
    else console.log(`mutant ${id} (${label}): caught by ${caught.length} (${caught.slice(0, 5).join(', ')}${caught.length > 5 ? ', ...' : ''})`);
  }
  x.galaxy_set_mutant(0);
}
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('Galaxy effects: all checks passed');
