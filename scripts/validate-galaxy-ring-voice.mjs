#!/usr/bin/env node
/** Speech on Galaxy's ring transport (Stage 4 gate row 4.3.7, check 5
 * `galaxy-ring-voice`, docs/audio-output-scope.md §6): the Rust translation of
 * glxStartSample's ring branch, the mixer's refill posts, the stream decoder
 * thread 0x1060e340 and glxStopSample's ring free (native/galaxy-kernel/src/
 * ring.rs, effects.rs) against the original under Unicorn
 * (scripts/native-galaxy-ring-oracle.py), with the MPEG decoder 0x1061a690
 * replaced on both sides by the same PCM leaf (row 4.5.6 stays excluded) and
 * the real timer callback, renderer, mixer and SSE kernel behind them, bit for
 * bit:
 *
 * - the record of a host-decoded speech sound (the MPEG loader's stand-in:
 *   type 0x4024 mono, 0x4044 stereo);
 * - after every glxStartSample, glxControlSample and glxStopSample: the 32
 *   first voice records;
 * - after every timer callback: its secondary-buffer calls, heads, `ahead`,
 *   R and the secondary buffer and staging ring digests (what is mixed from
 *   the rings), and the mixer trace with its P records (the refill posts);
 * - after every decoder message (handled after the callback that posted it,
 *   in post order): the voice records and every live ring's 64 KB;
 * - cases: a mono line at the output rate (the first fill 0x2000 bytes past
 *   the read head, the 0x8000-byte cap, several ring laps, the end of the
 *   stream: the loop bits cleared, the end set at the write position, the
 *   voice ending), at other pitches, a stereo line on a pair of slots (the
 *   second slot's sound stopped, both rings fed, glxControlSample over the
 *   Link), a line shorter than the head start, a stop in the middle (the ring
 *   freed) and a restart on the same slot, two lines at once with music, a
 *   pair whose second slot is the first music voice, and random programs;
 * - the first audible sample, the refill sizes and the end, printed;
 * - instruction coverage, unreached runs explained;
 * - mutants 501..504, each of which must be caught (505 is equivalent under
 *   the leaf).
 *
 *   node scripts/validate-galaxy-ring-voice.mjs [--refresh] [--cases a,b]
 *
 * Needs NATIVE_PROBE_PYTHON and src/runtime/galaxy-kernel.wasm. Oracle outputs
 * are cached in .cache/galaxy-ring, keyed by the oracle scripts and the cases. */
import {existsSync} from 'node:fs';
import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {SIZE, STEP, waves, rng, pick, runOracle, replay, firstDiff, chunks, explain, runs, parseRecords, VOICE} from './galaxy-output-lib.mjs';

const ORACLE = 'scripts/native-galaxy-ring-oracle.py';
const ORACLE_DEPS = ['scripts/native-galaxy-output-oracle.py', 'scripts/native-galaxy-effects-oracle.py',
  'scripts/native-galaxy-music-sequencer-oracle.py', 'scripts/native-galaxy-music-oracle.py', 'scripts/native-collision-oracle.py'];
const CACHE = '.cache/galaxy-ring';
const MODULES = '.cache/galaxy-music/modules';
const WASM = 'src/runtime/galaxy-kernel.wasm';
const args = process.argv.slice(2);
// Mutant 505 (one decoder attempt) is equivalent under the leaf, which answers
// nothing only at the end of its source: it is not run.
const MUTANTS = {501: 'no 0x2000 head start', 502: 'ring loop end + 0x8000', 503: 'no 0x8000 fill cap',
  504: 'end set whatever the read head'};
const NAMES = ['DeusExSounds.Generic.AlarmUnitHum', 'Ambient.Ambient.BabyCrying'];
const [HUM, BABY] = NAMES;

// ---- signals -----------------------------------------------------------------------------

/** 16-bit PCM bytes, `channels` interleaved, `frames` frames of a signal that
 * is never 0 (so the first audible sample is visible): a tone plus noise. */
function signal(seed, frames, channels, {period = 97, amplitude = 9000} = {}) {
  const r = rng(seed), b = Buffer.alloc(2 * frames * channels);
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) {
    let v = Math.round(amplitude * Math.sin(2 * Math.PI * f / (period + 13 * c))) + ((r() % 2001) - 1000);
    if (v === 0) v = 1;
    b.writeInt16LE(Math.max(-32768, Math.min(32767, v)), 2 * (f * channels + c));
  }
  return b.toString('hex');
}

// ---- cases ---------------------------------------------------------------------------------

const prefix = (extra = []) => [{op: 'sampleVolume', volume: 127, mode: 0}, ...NAMES.map(sample => ({op: 'loadSample', sample})), ...extra];
const cb = (play, write) => ({op: 'dsCallback', play: play >>> 0, write: write >>> 0});
/** `count` steady callbacks from `play` (each 882 frames, the write cursor 1764 bytes ahead); [ops, next play]. */
function run(play, count) {
  const ops = [];
  for (let i = 0; i < count; i++, play += STEP) ops.push(cb(play % SIZE, (play + 1764) % SIZE));
  return [ops, play];
}
const ring = (name, seed, frames, channels = 1) => ({op: 'hostRingSample', name, rate: 44100, channels, pcm: signal(seed, frames, channels)});
const start = (voice, sample, freq = 44100, extra = {}) => ({op: 'startSample', voice, sample, freq, vol: 0x7fff, pan: 0x4000, ...extra});

function cases() {
  const out = [];
  {
    // 100,000 frames: three ring laps and the end.
    const [a] = run(1000, 3 + Math.ceil((100000 + 4096 + 2 * 0x7fff) / 882));
    out.push({name: 'mono-line', program: prefix([ring('line', 1, 100000), cb(0, 1764), start(3, 'line'), ...a])});
  }
  for (const freq of [47000, 30000, 44099]) {
    const frames = 60000, [a] = run(1000, 6 + Math.ceil((frames * 44100 / freq + 4096 + 0x7fff) / 882));
    out.push({name: `mono-pitch-${freq}`, program: prefix([ring('line', 2, frames), cb(0, 1764), start(5, 'line', freq), ...a])});
  }
  {
    // A stereo line on voice 4 (slots 3 and 4) while slot 4 plays a WAV, which the pair start stops.
    const [pre, p] = run(1000, 6);
    const [a] = run(p, 8);
    const [b, q] = run(p + 8 * STEP, 10 + Math.ceil((70000 + 4096 + 0x7fff) / 882));
    out.push({name: 'stereo-pair', program: prefix([ring('pair', 3, 70000, 2), cb(0, 1764),
      {op: 'startSample', voice: 5, sample: HUM, freq: 22050, vol: 0x7fff, pan: 0x1000}, ...pre,
      start(4, 'pair', 44100, {pan: 0x3000}), ...a, {op: 'controlSample', slot: 3, freq: 44100, vol: 0x5000, pan: 0x6000}, ...b,
      {op: 'controlVoice', slot: 3, cmd: 2}, {op: 'controlVoice', slot: 4, cmd: 2}, ...run(q, 2)[0]])});
    // The default pan of a pair (-1: 0 and 0x7fff).
    out.push({name: 'stereo-default-pan', program: prefix([ring('pair', 4, 30000, 2), cb(0, 1764), start(2, 'pair', -1, {vol: -1, pan: -1}),
      ...run(1000, 6 + Math.ceil((30000 + 4096 + 0x7fff) / 882))[0]])});
  }
  {
    // A mono line's default pan (-1: the record's 0x4000, the voice's 0x20 bit),
    // glxControlSample's sample defaults (-1) on a ring voice.
    const [a, p] = run(1000, 10);
    out.push({name: 'mono-defaults', program: prefix([ring('line', 11, 20000), cb(0, 1764), start(6, 'line', -1, {vol: -1, pan: -1}), ...a,
      {op: 'controlSample', slot: 5, freq: -1, vol: -1, pan: -1}, ...run(p, 4)[0], {op: 'controlSample', slot: 5, freq: 40000, vol: 0x3000, pan: -1},
      ...run(p + 4 * STEP, 40)[0]])});
  }
  {
    // Shorter than the head start: the stream ends in the first fill.
    out.push({name: 'short-line', program: prefix([ring('short', 5, 1500), cb(0, 1764), start(1, 'short'),
      ...run(1000, 6 + Math.ceil((1500 + 4096 + 0x7fff) / 882))[0]])});
  }
  {
    // A stop in the middle frees the ring; a restart allocates it again; a restart while playing.
    const [a, p] = run(1000, 30);
    const [b, q] = run(p, 20);
    const [c, r] = run(q, 15);
    out.push({name: 'stop-restart', program: prefix([ring('one', 6, 80000), ring('two', 7, 20000), cb(0, 1764), start(2, 'one'), ...a,
      {op: 'stopSample', slot: 1}, ...b, start(2, 'two'), ...c, start(2, 'one', 40000), ...run(r, 40)[0],
      {op: 'stopSample', slot: 1}, ...run(r + 40 * STEP, 3)[0]])});
  }
  {
    // Two lines at once with music and an effect voice.
    const [a] = run(1000, 90);
    out.push({name: 'two-lines-music', program: prefix([ring('one', 8, 50000), ring('two', 9, 45000), {op: 'load', module: 'Intro_Music'},
      {op: 'start', section: 0}, cb(0, 1764), start(1, 'one'), start(7, 'two', 44100, {pan: 0x7000}),
      {op: 'startSample', voice: 9, sample: BABY, freq: 16000, vol: 0x6000, pan: 0x5000}, ...a])});
  }
  {
    // A pair on voice 16: the second slot is the first music voice (Update's last channel).
    const [a] = run(1000, 70);
    out.push({name: 'pair-music-slot', program: prefix([ring('pair', 10, 40000, 2), {op: 'load', module: 'Intro_Music'}, {op: 'start', section: 0},
      cb(0, 1764), ...run(1000, 4)[0], start(16, 'pair'), ...a])});
  }
  for (let p = 0; p < 3; p++) {
    const r = rng(700 + p), ops = [ring('a', 20 + p, 30000 + r() % 30000), ring('b', 30 + p, 5000 + r() % 20000, 2), ring('c', 40 + p, 2000 + r() % 3000), cb(0, 1764)];
    let play = 1000;
    for (let i = 0; i < 120; i++) {
      const k = r() % 14;
      // The stereo line only on voice 8 (slots 7 and 8) and nothing else
      // started on slot 8: a WAV there while the pair's first voice plays
      // would take the decoder's second channel into the WAV's data
      // (HAZARD_RING_FOREIGN_WRITE, not modelled).
      if (k === 0) ops.push(start(1 + r() % 7, pick(r, ['a', 'c']), pick(r, [44100, 44100, 22050, 48000, 44111]), {pan: pick(r, [r() & 0x7fff, -1])}));
      else if (k === 1) ops.push({op: 'stopSample', slot: r() % 9});
      // Frequency and volume -1 read the voice's record, a null pointer on an
      // idle voice (an access violation in the original; Update never passes -1).
      else if (k === 2) ops.push({op: 'controlSample', slot: r() % 9, freq: pick(r, [44100, 30000, 50000]), vol: 0x7fff, pan: pick(r, [r() & 0x7fff, -1])});
      else if (k === 3) ops.push({op: 'startSample', voice: 1 + r() % 7, sample: pick(r, NAMES), freq: 22050, vol: 0x7fff, pan: 0x4000});
      else if (k === 4 && r() % 3 === 0) ops.push(start(8, 'b', pick(r, [44100, 40000]), {pan: pick(r, [0x4000, -1])}));
      else { ops.push(cb(play % SIZE, (play + 1764) % SIZE)); play += STEP; }
    }
    out.push({name: `random-${p}`, program: prefix(ops)});
  }
  return out;
}

// Unreached instruction runs (start address -> reason); any other fails.
const UNREACHED = {
  // glxStartSample (the non-ring paths are validate-galaxy-effects.mjs's)
  0x1061234b: "a Sample whose FourCC is not 'SAMP': the subsystem passes only loaded records",
  0x10612395: 'Voice 0 (the free-voice search): the subsystem passes its channel + 1',
  0x10612326: 'no effect channels (EffectsChannels 0): validate-galaxy-effects.mjs',
  0x10612338: 'a null Sample: validate-galaxy-effects.mjs',
  0x1061267c: 'a null voice or a refused stop: Voice is never 0 here',
  // glxStopSample: the 3D voices (output type 0) and a null voice
  0x1061848a: 'the release of a 3D voice (Use3dHardware False)',
  0x1061857c: 'a null voice: validate-galaxy-effects.mjs',
  // glxControlSample: a null voice
  0x1060d2fb: 'a null voice: validate-galaxy-effects.mjs',
  0x1061262c: 'the Amiga period of player mode 1 (an Amiga-slide song loaded): validate-galaxy-effects.mjs voices-amiga-mode',
  // glxControlSample's sample defaults (-1) and the null voice
  0x1060d35f: 'a null voice: validate-galaxy-effects.mjs',
  // The decoder thread
  0x1060e833: 'GetMessageA failing at the first call (WM_QUIT before any message)',
  0x1060e42f: 'an 8-bit ring voice (the read head in bytes): the MPEG loader always types its records 16-bit (0x4024/0x4044)',
  0x1060e452: 'the channel and sample-size factor of a type without 0x2000/0x4000 (a stereo PCM WAV, 0x10619800): none shipped',
  0x1060e499: 'a null voice (the handler has already read its record)',
  0x1060e4b6: 'an 8-bit Link voice: the MPEG loader always types its records 16-bit',
  0x1060e569: 'a null voice (the handler has already read its record)',
  0x1060e5ac: 'a decoder that reports more consumed than remaining: the leaf never does (the MPEG decoder is row 4.5.6)',
  0x1060e6f6: 'the end of an 8-bit ring voice: the MPEG loader always types its records 16-bit',
  0x1060e774: 'the end of an 8-bit Link voice: the MPEG loader always types its records 16-bit',
  0x1060e387: 'a message for a voice that is not a ring voice (bit 0x40 test of a non-ring type)',
  0x1060e406: "a Link voice without a mutex (the pair's second voice stopped alone, then a refill for the first)",
  0x1060e448: 'factor 1 for a decoded type (0x2000/0x4000): taken; the other branch is a stereo PCM WAV ring (0x10619800), none shipped',
  0x1060e508: 'the type 0x8000 source fields (GLX_LOADASSTREAMING, flags 8): RegisterSound never passes it',
  0x1060e5b2: 'the IMA ADPCM (0x1061a170) and stereo PCM (0x10619800) decoders: no shipped sound takes them',
  0x1060e5fc: 'the type 0x8000 source refill through [0x1069838c] (GLX_LOADASSTREAMING)',
  0x1060e67b: 'the type 0x8000 source fields stored back (GLX_LOADASSTREAMING)',
  0x1060e7d8: 'a looped streamed record (type 8): the MPEG loader never sets it',
};

// ---- main -----------------------------------------------------------------------------------------

const samples = await waves(NAMES);
const only = args.includes('--cases') ? new Set(args[args.indexOf('--cases') + 1].split(',')) : null;
const list = cases().filter(c => !only || only.has(c.name));
await mkdir(CACHE, {recursive: true});
await runOracle({oracle: ORACLE, deps: ORACLE_DEPS, cache: CACHE, list, samples, refresh: args.includes('--refresh')});
const {instance} = await WebAssembly.instantiate(await readFile(WASM));
const x = instance.exports;
const modules = {Intro_Music: await readFile(path.join(MODULES, 'Intro_Music.it'))};
let failures = 0;
const fail = msg => { failures++; console.log(`FAIL ${msg}`); };
const total = {callbacks: 0, messages: 0, groups: 0};

for (const c of list) {
  const oracleDig = chunks(await readFile(path.join(CACHE, `${c.name}.dig`)), 8);
  const oracleSecondary = chunks(await readFile(path.join(CACHE, `${c.name}.secondary`)), SIZE);
  const info = JSON.parse(await readFile(path.join(CACHE, `${c.name}.json`), 'utf8'));
  let rust;
  try { rust = replay(x, c, samples, modules, 0); } catch (e) { fail(`${c.name}: ${e.message}`); continue; }
  const d = firstDiff(rust.digests, oracleDig), b = firstDiff(rust.secondaries, oracleSecondary);
  const st = rust.stats;
  total.callbacks += st.callbacks; total.messages += st.messages; total.groups += oracleDig.length;
  // The transport's landmarks (from the Rust replay, bit-equal with the original's trace).
  const summary = [...st.ring].map(([slot, m]) => `slot ${slot}: ${m.starts} start(s), first post at ring sample ${m.firstRead}, ` +
    `first decoded sample at ${(m.firstWrite - 0x8000 + 0x10000) % 0x10000 / 2} (${((m.firstWrite - 0x8000 - 2 * m.firstRead + 0x20000) % 0x10000) / 2} after the read head), ` +
    `${m.posts} messages filling ${m.filled} bytes (first refills ${m.fills.join(', ')})` +
    (m.end ? `, end set at ring sample ${m.end.sample} when the read head was at ${m.end.read}` : ', no end') +
    (m.silentAfter !== null ? `, Active clear after callback ${m.silentAfter}` : '')).join('\n    ');
  const label = `${c.name}: ${st.callbacks} callbacks, ${st.messages} decoder messages, ${info.leafCalls} decoder calls, ${oracleDig.length} groups` +
    `${st.hazards ? `, hazards ${st.hazards}` : ''}`;
  if (d >= 0 || b >= 0) {
    const why = d >= 0 ? explain(await readFile(path.join(CACHE, `${c.name}.full`)), rust.records, d) : `secondary buffer after callback ${b}`;
    fail(`${label}: trace group ${d}: ${why}`);
  } else console.log(`${label}: bit-equal, peak |sample| ${st.peak}${summary ? `\n    ${summary}` : ''}`);
}
console.log(`${list.length} cases, ${total.callbacks} callbacks, ${total.messages} decoder messages, ${total.groups} groups`);

if (existsSync(path.join(CACHE, 'coverage.json')) && !only) {
  const coverage = JSON.parse(await readFile(path.join(CACHE, 'coverage.json'), 'utf8'));
  for (const entry of coverage) {
    if (!/glxStartSample|glxStopSample|glxControlSample|decoder thread/.test(entry.function)) continue;
    const unreached = runs(entry);
    console.log(`coverage ${entry.function}: ${entry.covered.length}/${entry.instructions.length}` +
      (unreached.length ? `; unreached: ${unreached.map(r => `${r.start.toString(16)}(${r.count}) ${UNREACHED[r.start] ?? `? ${r.first}`}`).join('; ')}` : ''));
    for (const r of unreached) if (!UNREACHED[r.start]) fail(`coverage ${entry.function}: unexplained unreached run ${r.start.toString(16)} (${r.count}: ${r.first})`);
  }
}

if (!only) {
  for (const [id, label] of Object.entries(MUTANTS)) {
    const caught = [];
    for (const c of list) {
      const oracleDig = chunks(await readFile(path.join(CACHE, `${c.name}.dig`)), 8);
      try { if (firstDiff(replay(x, c, samples, modules, +id).digests, oracleDig) >= 0) caught.push(c.name); }
      catch { caught.push(`${c.name} (fault)`); }
    }
    if (!caught.length) fail(`mutant ${id} (${label}) not caught`);
    else console.log(`mutant ${id} (${label}): caught by ${caught.length} (${caught.slice(0, 5).join(', ')}${caught.length > 5 ? ', ...' : ''})`);
  }
  x.galaxy_set_mutant(0);
}
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('Galaxy ring voices: all checks passed');
