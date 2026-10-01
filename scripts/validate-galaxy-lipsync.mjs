/** Galaxy.dll's lip-sync analysis (docs/lip-sync.md) against the Rust kernel
 * (native/script-vm/src/lipsync.rs): the original block 0x1060a0da..0x1060a268
 * runs unchanged in Unicorn (scripts/native-galaxy-lipsync-oracle.py, with the
 * FFT's fsin/fcos from .cache/galaxy-fft-twiddles.csv, measured on a real x87
 * by tools/galaxy-fft-twiddle-probe.c). Every window, real and imaginary
 * float32 and the chosen letter must match bit for bit.
 *
 * Inputs: sines on each band and on the bin edges of its thresholds, near-tie
 * two-tone mixes, an amplitude sweep across the 5.0 peak gate, noise, square
 * waves, positions near the ring end, silence, and (when ffmpeg is installed)
 * windows of Island speech decoded from DeusExConAudioMission01.u. The decoder
 * is not under test; its samples are only realistic inputs. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {loadScriptVmKernel} from '../src/runtime/script-vm-kernel.mjs';

let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-galaxy-lipsync: no installed game data'); process.exit(0); }
const twiddles = '.cache/galaxy-fft-twiddles.csv';
if (!existsSync(twiddles)) { console.log(`SKIP validate-galaxy-lipsync: ${twiddles} (hardware twiddles) is missing; see tools/galaxy-fft-twiddle-probe.c`); process.exit(0); }
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const RING = 0x7fff, RATE = 44100;

let seed = 0x2545f491;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; };
const f32bits = value => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, value, true); return d.getUint32(0, true); };
const clamp = v => Math.max(-32768, Math.min(32767, Math.round(v)));
const ringOf = (generate, length = 4096) => {
  const bytes = new Uint8Array(length * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < length; i++) view.setInt16(2 * i, clamp(generate(i)), true);
  return bytes;
};
const sine = (freq, amp = 12000, phase = 0) => i => amp * Math.sin(2 * Math.PI * freq * i / RATE + phase);

const cases = [];
const add = (name, ring, pos = 0) => cases.push({name, ring, pos});
const binHz = RATE / 1024;
for (const bin of [1, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15, 20, 30, 34, 35, 36, 46, 47, 48, 60, 100, 200, 400, 511, 512, 600])
  for (const offset of [0, 0.25, 0.5]) add(`sine bin ${bin}+${offset}`, ringOf(sine((bin + offset) * binHz, 9000, 0.3)));
for (let k = 0; k < 24; k++) {
  const a = 4 + Math.floor(random() * 60), b = a + 1 + Math.floor(random() * 3), ratio = 0.97 + random() * 0.06;
  add(`two-tone ${a}/${b}`, ringOf(i => sine(a * binHz, 8000)(i) + sine(b * binHz, 8000 * ratio, 1.1)(i)));
}
for (const amp of [1, 2, 3, 5, 8, 12, 20, 40, 80, 160, 400, 2000, 32767])
  add(`amplitude ${amp}`, ringOf(sine(12.3 * binHz, amp)));
for (let k = 0; k < 16; k++) add(`noise ${k}`, ringOf(() => (random() * 2 - 1) * (k < 8 ? 32767 : 300)));
add('square', ringOf(i => (Math.floor(i / 20) & 1 ? 32767 : -32768)));
add('silence', new Uint8Array(0));
add('dc negative', ringOf(() => -20000));
for (const tail of [1, 2, 500, 1023, 1024, 1025]) add(`ring end -${tail}`, ringOf(sine(17 * binHz), RING), RING - tail);

// Island speech, decoded at its own rate to 16-bit (only when ffmpeg is installed).
let speechWindows = 0;
try {
  execFileSync('ffmpeg', ['-version'], {stdio: 'ignore'});
  const {parsePackage} = await import('../src/unreal/package.mjs');
  const {decodeSoundResource} = await import('../src/runtime/script-sound-resource.mjs');
  const bytes = new Uint8Array(readFileSync(path.join(root, 'System', 'DeusExConAudioMission01.u')));
  const pkg = parsePackage(bytes), dir = mkdtempSync(path.join(tmpdir(), 'lipsync-'));
  try {
    for (const name of ['ConAudioMission01_0', 'ConAudioMission01_1', 'ConAudioMission01_2']) {
      const entry = pkg.exports.find(e => (e.objectName ?? e.name) === name);
      const decoded = decodeSoundResource({pkg, bytes, entry});
      const start = entry.serialOffset + decoded.lazy.inlineOffset;
      writeFileSync(path.join(dir, 'in.mp3'), decoded.bytes ?? bytes.slice(start, start + decoded.lazy.byteCount));
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(dir, 'in.mp3'), '-f', 's16le', '-ac', '1', '-ar', String(RATE), path.join(dir, 'out.raw')]);
      const pcm = new Uint8Array(readFileSync(path.join(dir, 'out.raw')));
      for (let at = 0; at + 2048 <= pcm.length && speechWindows < 60; at += 4410 * 2) {
        add(`${name} @${at / 2}`, pcm.slice(at, at + 4096 * 2)); speechWindows++;
      }
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

// The classifier alone (0x10608d70) over crafted bins: exact ties across
// bands (the first maximum wins), the 5.0 peak gate, the mean gate with
// negative bins, NaN and infinite bins, signed zeros and other rates.
const classifyCases = [];
const bins = (fill, edits = {}) => { const b = new Uint32Array(1024).fill(f32bits(fill)); for (const [k, v] of Object.entries(edits)) b[k] = typeof v === 'number' ? f32bits(v) : v; return b; };
const nextUp = v => { const b = f32bits(v); return b + 1; };
for (const rate of [44100, 22050, 11025, 8000, 48000, 96000, 301, 1023, 65536, 200000]) {
  classifyCases.push({name: `tie ${rate}`, bins: bins(0.1, {8: 10, 40: 10}), rate});
  classifyCases.push({name: `tie reversed ${rate}`, bins: bins(0.1, {40: 10, 8: 10, 100: 9.99}), rate});
  classifyCases.push({name: `peak 5 ${rate}`, bins: bins(0.1, {20: 5}), rate});
  classifyCases.push({name: `peak above 5 ${rate}`, bins: bins(0.1, {20: nextUp(5)}), rate});
  for (const level of [-0.79, -0.8, -0.81, -1, -2])
    classifyCases.push({name: `mean ${level} ${rate}`, bins: bins(0.1, {...Object.fromEntries(Array.from({length: 40}, (_, k) => [k, level])), 60: 30}), rate});
  classifyCases.push({name: `nan bin ${rate}`, bins: bins(0.1, {3: 0x7fc00000, 30: 50}), rate});
  classifyCases.push({name: `inf bin ${rate}`, bins: bins(0.1, {12: 0x7f800000}), rate});
  classifyCases.push({name: `signed zeros ${rate}`, bins: bins(-0, {15: 7}), rate});
  for (let k = 0; k < 6; k++) classifyCases.push({name: `random ${k} ${rate}`, bins: Uint32Array.from({length: 1024}, () => f32bits(random() * 20)), rate});
}

const neg1 = f32bits(-1);
const oracleCases = [...cases.map(c => ({ring: Buffer.from(c.ring).toString('hex'), pos: c.pos, voiceFlags: 0x40a4, recordFlags: 0x4024,
  time: f32bits(0.016), next: 0, mean: neg1, phoneme: ''})),
  ...classifyCases.map(c => ({kind: 'classify', real: Buffer.from(c.bins.buffer).toString('hex'), rate: c.rate}))];
// The original's results are cached by input, oracle and twiddle table.
const input = JSON.stringify(oracleCases);
const key = createHash('sha256').update(input).update(readFileSync('scripts/native-galaxy-lipsync-oracle.py'))
  .update(readFileSync(twiddles)).digest('hex').slice(0, 16);
const cache = `.cache/galaxy-lipsync-reference-${key}.json`;
let reference;
if (existsSync(cache)) reference = JSON.parse(readFileSync(cache, 'utf8'));
else {
  reference = JSON.parse(execFileSync(python, ['scripts/native-galaxy-lipsync-oracle.py', root],
    {input, encoding: 'utf8', maxBuffer: 1 << 30})).results;
  writeFileSync(cache, JSON.stringify(reference));
}

const kernel = await loadScriptVmKernel();
const words = hex => new Uint32Array(Uint8Array.from(Buffer.from(hex, 'hex')).buffer);
const letters = {};
for (const [index, sample] of cases.entries()) {
  const original = reference[index];
  const ring = new Uint8Array(0x10000); ring.set(sample.ring.subarray(0, 0x10000));
  const input = ring.slice(sample.pos * 2, sample.pos * 2 + 2048);
  const padded = new Uint8Array(2048); padded.set(input);
  const letter = kernel.lipsync.analyze(padded, Math.min(1024, RING - sample.pos), RATE);
  for (const [field, got] of [['window', kernel.lipsync.window()], ['real', kernel.lipsync.real()], ['imag', kernel.lipsync.imag()]]) {
    const want = words(original[field]);
    const first = got.findIndex((value, i) => value !== want[i]);
    assert.equal(first, -1, `${sample.name}: ${field}[${first}] ${got[first]?.toString(16)} != original ${want[first]?.toString(16)}`);
  }
  assert.equal(letter, original.phoneme, `${sample.name}: letter`);
  assert.equal(original.next, f32bits(0.1), `${sample.name}: next += 0.1`);
  letters[letter] = (letters[letter] ?? 0) + 1;
}
for (const letter of ['A', 'E', 'F', 'O', 'T', 'U', 'X']) assert.ok(letters[letter] > 0, `coverage: letter ${letter}`);
const verdicts = {};
for (const [index, sample] of classifyCases.entries()) {
  const original = reference[cases.length + index].phoneme;
  assert.equal(kernel.lipsync.classify(sample.bins, sample.rate), original, `classifier ${sample.name}`);
  verdicts[original] = (verdicts[original] ?? 0) + 1;
}
console.log(`PASS validate-galaxy-lipsync: ${cases.length} original analyses bit-exact (window, FFT real/imag, |real|, letter; ${speechWindows} speech windows); letters ${JSON.stringify(letters)}; ${classifyCases.length} classifier edge cases ${JSON.stringify(verdicts)}`);
