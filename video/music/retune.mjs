// Tuning pass for a sampled SFZ instrument. Recorded ensemble libraries are tuned sample by sample, and some samples sit
// 15 to 35 cents off (measured on Virtual Playing Orchestra's strings and choir, 2026-11-11), which sours chords against
// the in-tune synths. For every region of a patch this renders the sample alone at its own key centre (sfizz_render, to a
// file), measures how far its sustained pitch is from equal temperament, and writes a copy of the patch whose regions
// carry the correction in `tune`. The copy also narrows the patch's per-note random detune. The library is not modified:
// the tuned patch goes to <dir>/ and points back at the library's samples.
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {readWav} from './sampler.mjs';

const VERSION = 5, SR = 48000;
const PITCH = {c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11};
const key = v => { const m = /^([a-g])(#|b)?(-?\d+)$/i.exec(v.trim()); return m ? 12 * (Number(m[3]) + 1) + PITCH[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] ? -1 : 0) : Number(v); };
const mtof = m => 440 * 2 ** ((m - 69) / 12);

/** `name=value` pairs of a piece of SFZ text (comments removed; a value runs to the next opcode on its line). */
function opcodes(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, ''), marks = [...line.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)];
    marks.forEach((m, i) => { out[m[1]] = line.slice(m.index + m[0].length, marks[i + 1]?.index ?? line.length).trim(); });
  }
  return out;
}

/** Cents by which the pitch around f0 is off: the energy centre of each of the first harmonics' spectral lobes (within 80 cents). */
export function centsOff(buf, i0, n, f0, harmonics = [1, 2, 3]) {
  const x = new Float64Array(n >> 1);
  for (let i = 0; i < x.length; i++) x[i] = (buf.L[i0 + 2 * i] + buf.R[i0 + 2 * i]) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / x.length));
  let sum = 0, weight = 0;
  for (const h of harmonics) {
    if (h * f0 > 5000) continue;
    const power = [];
    for (let c = -80; c <= 80; c += 2) {
      const w = 2 * Math.PI * h * f0 * 2 ** (c / 1200) * 2 / SR;
      let re = 0, im = 0;
      for (let i = 0; i < x.length; i++) { re += x[i] * Math.cos(w * i); im += x[i] * Math.sin(w * i); }
      power.push(re * re + im * im);
    }
    // every part of the lobe within 10 dB of its top counts: a section that sits at two pitches is read at their middle
    const floor = Math.max(...power) * 0.1;
    let a = 0, b = 0;
    for (let k = 0; k < power.length; k++) if (power[k] > floor) { a += power[k] * (-80 + 2 * k); b += power[k]; }
    if (b > 0) { sum += Math.sqrt(b) * (a / b); weight += Math.sqrt(b); }
  }
  return weight ? sum / weight : 0;
}

/**
 * The stretch of a note (starting at sample `onset`) whose pitch is the note's pitch: [start, length] in samples. A held
 * sound (choir, strings, a roll) is read from 0.8 s to 2.4 s, past the scoop and settling of its attack; a struck sound
 * (vibraphone, timpani) in its first 0.8 s, before it has decayed. null for silence.
 */
export function bodyOf(buf, onset) {
  const energy = (t0, t1) => { let e = 0; for (let i = onset + Math.round(t0 * SR); i < Math.min(buf.L.length, onset + Math.round(t1 * SR)); i++) e += buf.L[i] ** 2 + buf.R[i] ** 2; return e; };
  const early = energy(0, 1), late = energy(1, 2.4);
  if (early + late < 1e-7) return null;
  return late > early * 0.25 ? [onset + Math.round(0.8 * SR), Math.round(1.6 * SR)] : [onset + Math.round(0.04 * SR), Math.round(0.8 * SR)];
}

const run = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, {stdio: 'ignore'});
  child.on('error', reject);
  child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
});
async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({length: size}, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } }));
}
const oneNote = (midi, seconds) => {            // a MIDI file: one note, velocity 100, at 120 BPM
  const ticks = Math.round(seconds * 2 * 480), vlq = n => { const o = [n & 127]; while ((n >>= 7) > 0) o.unshift((n & 127) | 128); return o; };
  const body = [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, 0, 0x90, midi, 100, ...vlq(ticks), 0x80, midi, 0, ...vlq(480), 0xff, 0x2f, 0];
  const head = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 1, 0xe0, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 0]);
  head.writeUInt32BE(body.length, 18);
  return Buffer.concat([head, Buffer.from(body)]);
};

/**
 * -> {sfz: path of the tuned copy, regions, corrected, mean, max} (cents moved). `harmonics`: which partials to trust
 * ([1] for timpani, whose overtones are not harmonic). `limit`: larger measured errors are taken as a failed measurement
 * and left alone. `random`: the per-note random detune (cents) the copy keeps.
 */
export async function tunedPatch(sfz, {dir, harmonics = [1, 2, 3], limit = 60, random = 3} = {}) {
  const source = readFileSync(sfz, 'utf8');
  if (/#include|#define/.test(source)) throw new Error(`${sfz}: #include / #define are not handled by the tuning pass`);
  const id = createHash('sha1').update(source).update(JSON.stringify([VERSION, harmonics, limit, random, sfz])).digest('hex').slice(0, 12);
  const out = path.join(dir, `${path.basename(sfz, '.sfz')}-${id}.sfz`), report = out.replace(/\.sfz$/, '.json');
  if (existsSync(out) && existsSync(report)) return {sfz: out, ...JSON.parse(readFileSync(report, 'utf8'))};
  mkdirSync(dir, {recursive: true});
  const home = path.dirname(sfz) + path.sep;
  // the patch as headers with their text; each region's effective opcodes come from the enclosing global / master / group
  const pieces = [], marks = [...source.matchAll(/<(control|global|master|group|region|curve|effect|midi|sample)>/g)];
  pieces.push({header: null, text: source.slice(0, marks[0]?.index ?? source.length)});
  marks.forEach((m, i) => pieces.push({header: m[1], text: source.slice(m.index + m[0].length, marks[i + 1]?.index ?? source.length)}));
  const scope = {global: {}, master: {}, group: {}}, regions = [];
  for (const piece of pieces) {
    if (piece.header === 'global') { scope.global = opcodes(piece.text); scope.master = {}; scope.group = {}; }
    else if (piece.header === 'master') { scope.master = opcodes(piece.text); scope.group = {}; }
    else if (piece.header === 'group') scope.group = opcodes(piece.text);
    else if (piece.header === 'region') {
      const o = {...scope.global, ...scope.master, ...scope.group, ...opcodes(piece.text)};
      if (!o.sample || o.sample.startsWith('*') || o.pitch_keytrack === '0' || o.trigger === 'release') continue;
      const centre = o.pitch_keycenter != null ? key(o.pitch_keycenter) : o.key != null ? key(o.key) : 60;
      regions.push({piece, sample: o.sample, centre, tune: Number(o.tune ?? 0), offset: o.offset});
    }
  }
  // one measurement per distinct (sample, key centre, tuning)
  const jobs = new Map();
  for (const r of regions) { r.job = `${r.sample}|${r.centre}|${r.tune}`; if (!jobs.has(r.job)) jobs.set(r.job, {...r, error: null}); }
  const tmp = path.join(dir, `measuring-${id}`);
  mkdirSync(tmp, {recursive: true});
  await pool([...jobs.values()], 12, async (job, i) => {
    const base = path.join(tmp, String(i)), note = Math.max(0, Math.min(127, job.centre));
    writeFileSync(`${base}.sfz`, `<control>\ndefault_path=${home}\n<region>\nsample=${job.sample}\nlokey=0\nhikey=127\npitch_keycenter=${job.centre}\ntune=${job.tune}\n${job.offset ? `offset=${job.offset}\n` : ''}ampeg_attack=0.02\nampeg_release=0.2\n`);
    writeFileSync(`${base}.mid`, oneNote(note, 2.6));
    try {
      await run('sfizz_render', ['--sfz', `${base}.sfz`, '--midi', `${base}.mid`, '--wav', `${base}.wav`, '-s', String(SR), '-q', '3']);
      const buf = readWav(`${base}.wav`, SR * 3);
      const window = bodyOf(buf, 0);
      if (window) job.error = centsOff(buf, ...window, mtof(note), harmonics);
    } catch { job.error = null; }
  });
  rmSync(tmp, {recursive: true, force: true});
  let corrected = 0, sum = 0, max = 0;
  for (const r of regions) {
    const error = jobs.get(r.job).error;
    if (error == null || Math.abs(error) > limit) continue;
    const tune = Math.round(r.tune - error);
    r.piece.text = `${r.piece.text.replace(/\s*$/, '')}\ntune=${tune}\n\n`;
    corrected++; sum += Math.abs(error); max = Math.max(max, Math.abs(error));
  }
  let text = pieces.map(p => (p.header ? `<${p.header}>` : '') + p.text).join('').replace(/pitch_random=\d+(\.\d+)?/g, `pitch_random=${random}`);
  text = /<control>/.test(text) ? text.replace('<control>', `<control>\ndefault_path=${home}\n`) : `<control>\ndefault_path=${home}\n${text}`;
  writeFileSync(out, `// tuned copy of ${sfz} (video/music/retune.mjs): ${corrected} of ${regions.length} regions retuned\n${text}`);
  const summary = {regions: regions.length, corrected, mean: corrected ? +(sum / corrected).toFixed(1) : 0, max: +max.toFixed(1)};
  writeFileSync(report, JSON.stringify(summary));
  return {sfz: out, ...summary};
}
