// Soundtrack for the promo: the Deus Ex main theme (Title_Music, by Alexander Brandon and Michiel van den Bos) re-thought as
// instrumental synth metal by the promo's own synthesizer. theme-score.mjs reads the song from the local installation at build
// time (nothing of it is stored in this repository); this file takes its harmony and quotes a few of its lines, and the riffs,
// drums, arpeggios, intro and form are its own. No sample of the module's audio is played. Cut sound effects sit on the
// picture's cues. Writes ad/build/music.wav (48 kHz, 16-bit stereo) and ad/build/score.json (the song's bars, which the picture
// cuts on).
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ARRANGEMENT, grid} from '../src/timeline.js';
import {themeScore} from './theme-score.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../build/music.wav');
const repo = path.resolve(here, '../..');
const game = ['Deus Ex GOTY Edition', 'game'].map(dir => path.join(repo, dir)).find(dir => existsSync(path.join(dir, 'Music')));
const score = await themeScore({game, arrangement: ARRANGEMENT});
const G = grid(score), {bar} = G;
const SR = 48000, DUR = G.duration, N = Math.ceil(SR * DUR);
const TAU = Math.PI * 2;
const BEAT = G.barLength(12) / 4, E8 = BEAT / 2, S16 = BEAT / 4;

// ------------------------------------------------------------------ buses
const mkbus = () => ({L: new Float32Array(N), R: new Float32Array(N)});
const B = {perc: mkbus(), timp: mkbus(), low: mkbus(), strings: mkbus(), marcato: mkbus(), choir: mkbus(), horns: mkbus(),
  synth: mkbus(), gong: mkbus(), fx: mkbus(), bass: mkbus(), kit: mkbus(), guitar: mkbus(), lead: mkbus()};
const REV = mkbus(), HALL = mkbus(), DLY = mkbus();
// Bus levels, applied where a voice writes, so its reverb and delay sends follow.
const LEVELS = {perc: 0.45, timp: 0.9, low: 1.25, strings: 2.6, marcato: 4.6, choir: 1.5, horns: 6.0, synth: 1.6, gong: 0.9, fx: 0.7,
  bass: 1.0, kit: 0.34, guitar: 2.0, lead: 13};
for (const [name, bus] of Object.entries(B)) bus.g = LEVELS[name];

let seed = 0x5eed1e;
const rand = () => { seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return seed / 4294967296; };
const noise = () => rand() * 2 - 1;
const midi = n => 440 * Math.pow(2, (n - 69) / 12);
const NOTES = {C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11};
const note = name => { const m = /^([A-G][#b]?)(-?\d)$/.exec(name); return 12 * (Number(m[2]) + 1) + NOTES[m[1]]; };
const hz = name => midi(note(name));
const midiName = m => `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

function write(bus, i, l, r) { if (i >= 0 && i < N) { const g = bus.g ?? 1; bus.L[i] += l * g; bus.R[i] += r * g; } }
const panLR = pan => [Math.cos((pan + 1) * Math.PI / 4), Math.sin((pan + 1) * Math.PI / 4)];

// Topology-preserving state-variable filter.
class SVF {
  constructor() { this.a = 0; this.b = 0; this.low = 0; this.band = 0; this.high = 0; }
  set(fc, q) {
    const g = Math.tan(Math.PI * Math.min(Math.max(fc, 10), SR * 0.45) / SR), k = 1 / q;
    this.a1 = 1 / (1 + g * (g + k)); this.a2 = g * this.a1; this.a3 = g * this.a2; this.k = k;
  }
  run(x) {
    const v3 = x - this.b, v1 = this.a1 * this.a + this.a2 * v3, v2 = this.b + this.a2 * this.a + this.a3 * v3;
    this.a = 2 * v1 - this.a; this.b = 2 * v2 - this.b;
    this.low = v2; this.band = v1; this.high = x - this.k * v1 - v2;
    return v2;
  }
}
const blep = (t, dt) => {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
};
const adsr = (tt, dur, attack, decay, sustain, release) => {
  if (tt < attack) return tt / attack;
  const held = sustain + (1 - sustain) * Math.exp(-(Math.min(tt, dur) - attack) / Math.max(1e-4, decay));
  return tt < dur ? held : held * Math.exp(-(tt - dur) / Math.max(1e-4, release / 3));
};

// Vowel formants (Hz, relative gain, Q) for the choir.
// (broad enough not to ring on the breath noise as a held whistle)
const VOWELS = {a: [[700, 1, 4.5], [1220, 0.5, 5], [2600, 0.18, 6]], o: [[480, 1, 4.5], [820, 0.5, 5], [2600, 0.1, 6]],
  u: [[340, 1, 4], [720, 0.35, 5], [2500, 0.06, 6]]};

// A note's volume curve ([[seconds into the note, gain]], the song's volume slides), linear between its points.
function curveAt(curve, tt) {
  if (!curve) return 1;
  if (tt <= curve[0][0]) return curve[0][1];
  for (let k = 1; k < curve.length; k++) if (tt < curve[k][0]) {
    const [t0, g0] = curve[k - 1], [t1, g1] = curve[k];
    return g0 + (g1 - g0) * (tt - t0) / Math.max(1e-6, t1 - t0);
  }
  return curve.at(-1)[1];
}

// Ensemble voice: n detuned band-limited saws, each with its own vibrato and drift, spread across the stereo field, then a
// low-pass with an envelope (strings, horns) or a vowel formant bank (choir).
function ens(bus, o) {
  const {t, dur, freq, n = 6, spread = 12, attack = 0.2, decay = 0.4, sustain = 0.8, release = 0.6, cutoff = 2500, env = 0,
    envDecay = 0.3, q = 0.7, gain = 0.1, pan = 0, width = 0.8, rev = 0, hall = 0, dly = 0, vib = 7, vibRate = 5.2, vibDelay = 0.25,
    drift = 3, vowel = null, breath = 0, glide = null, glideTime = 0.08, square = 0, curve = null} = o;
  const start = Math.floor(t * SR), len = Math.floor((dur + release) * SR);
  const oscs = [...Array(n)].map((_, i) => {
    const c = n > 1 ? spread * (i / (n - 1) * 2 - 1) + (rand() - 0.5) * 2 : 0;
    const p = n > 1 ? (i / (n - 1) * 2 - 1) * width : 0;
    return {ph: rand(), ratio: Math.pow(2, c / 1200), vph: rand() * TAU, vr: vibRate * (0.9 + rand() * 0.2), dph: rand() * TAU,
      dr: 0.15 + rand() * 0.25, l: Math.cos((p + 1) * Math.PI / 4), r: Math.sin((p + 1) * Math.PI / 4), m: 1};
  });
  const [pl, pr] = panLR(pan);
  const fl = new SVF(), fr = new SVF();
  const formL = vowel ? VOWELS[vowel].map(() => new SVF()) : null, formR = vowel ? VOWELS[vowel].map(() => new SVF()) : null;
  if (vowel) VOWELS[vowel].forEach(([f, , fq], k) => { formL[k].set(f, fq); formR[k].set(f, fq); });
  const norm = 1 / Math.sqrt(n);
  let cg = 1;
  for (let s = 0; s < len; s++) {
    const tt = s / SR;
    const amp = adsr(tt, dur, attack, decay, sustain, release) * cg;
    if (amp < 1e-5 && tt > dur) break;
    if ((s & 31) === 0) {
      cg = curveAt(curve, tt);
      let f = freq;
      if (glide) f = glide + (freq - glide) * (1 - Math.exp(-tt / glideTime));
      const vd = tt > vibDelay ? Math.min(1, (tt - vibDelay) / 0.4) : 0;
      for (const osc of oscs) osc.m = f * osc.ratio * Math.pow(2, (vib * vd * Math.sin(osc.vph + TAU * osc.vr * tt) + drift * Math.sin(osc.dph + TAU * osc.dr * tt)) / 1200) / SR;
      if (!vowel) { const fc = cutoff + env * Math.exp(-tt / envDecay); fl.set(fc, q); fr.set(fc, q); }
    }
    let xl = 0, xr = 0;
    for (const osc of oscs) {
      const dt = osc.m;
      osc.ph += dt; if (osc.ph >= 1) osc.ph -= 1;
      let v = 2 * osc.ph - 1 - blep(osc.ph, dt);
      if (square) { let sq = osc.ph < 0.5 ? 1 : -1; sq += blep(osc.ph, dt); sq -= blep((osc.ph + 0.5) % 1, dt); v = v * (1 - square) + sq * square; }
      xl += v * osc.l; xr += v * osc.r;
    }
    xl *= norm; xr *= norm;
    if (breath) { const b = noise() * breath; xl += b; xr += b; }
    let yl, yr;
    if (vowel) {
      yl = 0; yr = 0;
      VOWELS[vowel].forEach(([, g], k) => { formL[k].run(xl); formR[k].run(xr); yl += formL[k].band * g; yr += formR[k].band * g; });
      yl *= 2.2; yr *= 2.2;
    } else { yl = fl.run(xl); yr = fr.run(xr); }
    const l = yl * amp * gain * pl * 1.41, r = yr * amp * gain * pr * 1.41;
    const i = start + s;
    write(bus, i, l, r);
    if (rev) write(REV, i, l * rev * bus.g, r * rev * bus.g);
    if (hall) write(HALL, i, l * hall * bus.g, r * hall * bus.g);
    if (dly) write(DLY, i, l * dly * bus.g, r * dly * bus.g);
  }
}

// Simple subtractive voice (synth pads, sub tones).
function tone(bus, o) {
  const {t, dur, freq, type = 'saw', detune = [0], attack = 0.005, decay = 0.2, sustain = 0.7, release = 0.2,
    cutoff = 4000, env = 0, envDecay = 0.2, q = 0.8, pan = 0, gain = 0.2, rev = 0, hall = 0, dly = 0, lfo = 0, lfoRate = 0.2, curve = null,
    glide = null, glideTime = 0.06} = o;
  const start = Math.floor(t * SR), len = Math.floor((dur + release) * SR);
  const [pl, pr] = panLR(pan);
  const oscs = detune.map(c => ({ph: rand(), ratio: Math.pow(2, c / 1200), sp: detune.length > 1 ? (c > 0 ? 0.35 : -0.35) : 0}));
  const filt = new SVF();
  const norm = 1 / Math.sqrt(oscs.length);
  let cg = 1, f = freq;
  for (let s = 0; s < len; s++) {
    const tt = s / SR;
    const amp = adsr(tt, dur, attack, decay, sustain, release) * cg;
    if (amp < 1e-5 && tt > dur) break;
    if ((s & 7) === 0) {
      filt.set(cutoff * (1 + lfo * Math.sin(TAU * lfoRate * tt)) + env * Math.exp(-tt / envDecay), q);
      cg = curveAt(curve, tt);
      f = glide ? glide + (freq - glide) * (1 - Math.exp(-tt / glideTime)) : freq;
    }
    let x = 0, d = 0;
    for (const osc of oscs) {
      const dt = f * osc.ratio / SR;
      osc.ph += dt; if (osc.ph >= 1) osc.ph -= 1;
      let v;
      if (type === 'saw') v = 2 * osc.ph - 1 - blep(osc.ph, dt);
      else if (type === 'square') { v = osc.ph < 0.5 ? 1 : -1; v += blep(osc.ph, dt); v -= blep((osc.ph + 0.5) % 1, dt); }
      else if (type === 'tri') v = 1 - 4 * Math.abs(osc.ph - 0.5);
      else v = Math.sin(TAU * osc.ph);
      x += v; d += v * osc.sp;
    }
    const y = filt.run(x * norm), spread = d * norm * 0.5;
    const l = (y + spread) * amp * gain * pl * 1.41, r = (y - spread) * amp * gain * pr * 1.41;
    const i = start + s;
    write(bus, i, l, r);
    if (rev) write(REV, i, l * rev * bus.g, r * rev * bus.g);
    if (hall) write(HALL, i, l * hall * bus.g, r * hall * bus.g);
    if (dly) write(DLY, i, l * dly * bus.g, r * dly * bus.g);
  }
}

// ------------------------------------------------------------------ orchestra
function strings(t, dur, names, {gain = 0.05, attack = 0.6, release = 1.2, cutoff = 1800, pan = 0, hall = 0.5, vib = 6} = {}) {
  for (const [k, name] of names.entries())
    ens(B.strings, {t, dur, freq: hz(name), n: 6, spread: 14, attack, decay: 1, sustain: 1, release, cutoff: cutoff * 1.4 + 200 * k, q: 0.6,
      gain, pan: pan + (k / Math.max(1, names.length - 1) - 0.5) * 0.5, width: 0.9, hall, vib, vibRate: 5.4, breath: 0.015});
}
function lowStrings(t, dur, name, {gain = 0.09, attack = 1.2, release = 1.5} = {}) {
  ens(B.low, {t, dur, freq: hz(name), n: 5, spread: 9, attack, decay: 1, sustain: 1, release, cutoff: 650, env: 300, envDecay: 1.5,
    q: 0.8, gain, width: 0.5, hall: 0.3, vib: 4});
  ens(B.low, {t, dur, freq: hz(name) * 2, n: 4, spread: 11, attack, decay: 1, sustain: 1, release, cutoff: 1100, q: 0.7, gain: gain * 0.45,
    width: 0.8, hall: 0.35, vib: 5});
}
// Marcato strings: a short bowed attack with a filter bite.
function marcato(t, names, {gain = 0.055, len = E8 * 0.7, accent = 1} = {}) {
  for (const [k, name] of names.entries())
    ens(B.marcato, {t, dur: len, freq: hz(name), n: 5, spread: 12, attack: 0.008, decay: 0.09, sustain: 0.45, release: 0.12,
      cutoff: 900, env: 2600 * accent, envDecay: 0.06, q: 0.9, gain: gain * accent, pan: (k - (names.length - 1) / 2) * 0.35, width: 0.7,
      hall: 0.25, vib: 0, breath: 0.03});
}
function cello(t, name, {gain = 0.06, len = S16 * 1.6} = {}) {
  ens(B.marcato, {t, dur: len, freq: hz(name), n: 3, spread: 8, attack: 0.006, decay: 0.07, sustain: 0.3, release: 0.08,
    cutoff: 600, env: 1800, envDecay: 0.05, q: 1, gain, pan: -0.3, width: 0.4, hall: 0.2, vib: 0, breath: 0.02});
}
function choir(t, dur, names, {gain = 0.06, vowel = 'a', attack = 0.8, release = 1.6, hall = 0.6} = {}) {
  for (const [k, name] of names.entries())
    ens(B.choir, {t, dur, freq: hz(name), n: 5, spread: 16, attack, decay: 1, sustain: 1, release, gain, vowel, pan: (k % 2 ? 0.25 : -0.25),
      width: 0.9, hall, vib: 14, vibRate: 5.0, vibDelay: 0.35, drift: 5, breath: 0.012, square: 0.25});
}
// Horn: warm brass, the filter opening with the dynamic; `low` doubles an octave down.
function horn(t, dur, name, {gain = 0.08, glide = null, low = false, pan = -0.15, attack = 0.07, hall = 0.45} = {}) {
  const f = hz(name);
  ens(B.horns, {t, dur, freq: f, n: 3, spread: 6, attack, decay: 0.6, sustain: 0.85, release: 0.35, cutoff: Math.min(2400, f * 3.2),
    env: 900 + 2600 * gain, envDecay: 0.18, q: 0.75, gain, pan, width: 0.4, hall, vib: dur > 0.7 ? 9 : 0, vibRate: 4.8, vibDelay: 0.4,
    glide, glideTime: 0.06, square: 0.2});
  if (low) ens(B.horns, {t, dur, freq: f / 2, n: 3, spread: 5, attack: attack * 1.3, decay: 0.6, sustain: 0.85, release: 0.4,
    cutoff: Math.min(1400, f * 2), env: 600, envDecay: 0.2, q: 0.7, gain: gain * 0.7, pan: pan + 0.3, width: 0.4, hall, vib: 0,
    glide: glide ? glide / 2 : null, glideTime: 0.06, square: 0.3});
}
// Horn hit: a short, loud brass chord with a noise bite and a low thud.
function hornHit(t, names, {gain = 0.1} = {}) {
  for (const name of names)
    ens(B.horns, {t, dur: 0.22, freq: hz(name), n: 4, spread: 10, attack: 0.004, decay: 0.2, sustain: 0.25, release: 0.9,
      cutoff: 700, env: 4200, envDecay: 0.09, q: 0.9, gain, width: 0.8, hall: 0.9, vib: 0, square: 0.3});
  const start = Math.floor(t * SR), bp = new SVF();
  bp.set(1100, 0.8);
  for (let s = 0; s < SR * 0.3; s++) {
    bp.run(noise());
    const v = bp.band * Math.exp(-s / (SR * 0.05)) * gain * 1.4;
    write(B.horns, start + s, v, v); write(HALL, start + s, v * 0.6 * B.horns.g, v * 0.6 * B.horns.g);
  }
}

// ------------------------------------------------------------------ percussion
const TAIKOS = [];
function taiko(t, gain = 0.5, f0 = 62, pan = 0) {
  TAIKOS.push([t, gain]);
  const start = Math.floor(t * SR), slap = new SVF(), [pl, pr] = panLR(pan);
  slap.set(320, 1.1);
  let p1 = 0, p2 = 0;
  for (let s = 0; s < SR * 1.0; s++) {
    const tt = s / SR;
    const f = f0 * (1 + 0.55 * Math.exp(-tt / 0.018));
    p1 += f / SR; p2 += f * 1.59 / SR;
    slap.run(noise());
    const body = Math.sin(TAU * p1) * Math.exp(-tt / 0.42) + Math.sin(TAU * p2) * 0.35 * Math.exp(-tt / 0.14);
    const v = Math.tanh((body + slap.band * 2.2 * Math.exp(-tt / 0.03)) * 1.4) * gain;
    write(B.perc, start + s, v * pl * 1.41, v * pr * 1.41);
    write(HALL, start + s, v * 0.22 * B.perc.g, v * 0.22 * B.perc.g);
  }
}
const TIMP = [1, 1.504, 1.742, 2.0, 2.245, 2.494], TIMPA = [1, 0.55, 0.32, 0.26, 0.15, 0.1], TIMPD = [1.6, 0.9, 0.7, 0.55, 0.42, 0.3];
function timp(t, name, gain = 0.3, decayScale = 1) { timpF(t, hz(name), gain, decayScale); }
function timpF(t, f0, gain = 0.3, decayScale = 1) {
  const start = Math.floor(t * SR), lp = new SVF();
  lp.set(900, 0.7);
  const ph = TIMP.map(() => rand());
  for (let s = 0; s < SR * 2.2 * decayScale; s++) {
    const tt = s / SR, bend = 1 + 0.015 * Math.exp(-tt / 0.05);
    let v = 0;
    for (let k = 0; k < TIMP.length; k++) {
      ph[k] += f0 * TIMP[k] * bend / SR;
      v += Math.sin(TAU * ph[k]) * TIMPA[k] * Math.exp(-tt / (TIMPD[k] * decayScale));
    }
    lp.run(noise());
    v = (v + lp.low * 1.5 * Math.exp(-tt / 0.012)) * gain;
    write(B.timp, start + s, v * 0.9, v);
    write(HALL, start + s, v * 0.25 * B.timp.g, v * 0.25 * B.timp.g);
  }
}
function timpRoll(t0, t1, name, g0, g1) {
  for (let t = t0, k = 0; t < t1; t += 1 / 22, k++) {
    const p = (t - t0) / (t1 - t0);
    timp(t + (rand() - 0.5) * 0.006, name, (g0 + (g1 - g0) * p * p) * (k % 2 ? 0.85 : 1), 0.35);
  }
}
function snare(t, gain = 0.25, tail = 0.12) {
  const start = Math.floor(t * SR), bp = new SVF(), hp = new SVF();
  bp.set(2400, 0.9); hp.set(900, 0.7);
  let ph = 0;
  for (let s = 0; s < SR * 0.4; s++) {
    const tt = s / SR, nz = noise();
    bp.run(nz); hp.run(nz);
    ph += (200 + 50 * Math.exp(-tt / 0.015)) / SR;
    const v = ((bp.band * 0.8 + hp.high * 0.55) * Math.exp(-tt / tail) + Math.sin(TAU * ph) * 0.5 * Math.exp(-tt / 0.04)) * gain;
    write(B.perc, start + s, v * 0.92, v);
    write(HALL, start + s, v * 0.2 * B.perc.g, v * 0.2 * B.perc.g);
  }
}
function snareRoll(t0, t1, g0, g1) {
  for (let t = t0; t < t1; t += S16 / 2) { const p = (t - t0) / (t1 - t0); snare(t, g0 + (g1 - g0) * p, 0.06); }
}
const BEATS = [];
function heartbeat(t, gain = 0.5) {
  BEATS.push(t);
  for (const [dt, g, f] of [[0, 1, 52], [0.17, 0.6, 47]]) {
    const start = Math.floor((t + dt) * SR);
    let ph = 0;
    for (let s = 0; s < SR * 0.35; s++) {
      const tt = s / SR;
      ph += f * (1 + 0.8 * Math.exp(-tt / 0.012)) / SR;
      const v = Math.tanh(Math.sin(TAU * ph) * Math.exp(-tt / 0.11) * 1.8) * gain * g;
      write(B.perc, start + s, v, v);
    }
  }
}
function gong(t, gain = 0.35, len = 7) {
  const start = Math.floor(t * SR);
  const parts = [...Array(46)].map(() => {
    const f = 70 * Math.pow(40, rand());
    return {f, ph: rand(), a: (0.4 + rand()) / Math.sqrt(f / 70), d: len * (0.25 + rand() * 0.6) * Math.pow(70 / f, 0.25),
      bloom: 0.05 + 1.4 * Math.log(f / 70) / Math.log(40) * rand(), wob: 0.3 + rand() * 1.5};
  });
  const thump = new SVF(); thump.set(140, 0.8);
  let sum = 0; for (const p of parts) sum += p.a;
  for (let s = 0; s < SR * len; s++) {
    const tt = s / SR;
    let v = 0;
    for (const p of parts) {
      p.ph += p.f * (1 + 0.0015 * Math.sin(TAU * p.wob * tt)) / SR;
      const env = (1 - Math.exp(-tt / p.bloom)) * Math.exp(-tt / p.d);
      v += Math.sin(TAU * p.ph) * p.a * env;
    }
    thump.run(noise());
    v = (v / sum * 3 + thump.low * 3 * Math.exp(-tt / 0.08)) * gain;
    write(B.gong, start + s, v * (1 + 0.15 * Math.sin(tt * 1.7)), v * (1 + 0.15 * Math.cos(tt * 1.3)));
    write(HALL, start + s, v * 0.35 * B.gong.g, v * 0.35 * B.gong.g);
  }
}
function cymbalSwell(t0, t1, gain = 0.2) {
  const start = Math.floor(t0 * SR), len = Math.floor((t1 - t0) * SR), hp = new SVF(), bp = new SVF();
  hp.set(5000, 0.6); bp.set(9500, 0.6);
  for (let s = 0; s < len + SR * 0.12; s++) {
    const p = Math.min(1, s / len), nz = noise();
    hp.run(nz); bp.run(nz);
    const env = s < len ? Math.pow(p, 3) : Math.exp(-(s - len) / (SR * 0.03));
    const v = (hp.high * 0.6 + bp.band * 0.6) * env * gain;
    write(B.perc, start + s, v * 0.95, v);
    write(HALL, start + s, v * 0.3 * B.perc.g, v * 0.3 * B.perc.g);
  }
}
function crash(t, gain = 0.2) {
  const start = Math.floor(t * SR), hp = new SVF(), bp = new SVF();
  hp.set(4200, 0.6); bp.set(8000, 0.5);
  for (let s = 0; s < SR * 3.5; s++) {
    const tt = s / SR, nz = noise();
    hp.run(nz); bp.run(nz);
    const v = (hp.high * 0.7 + bp.band * 0.45) * Math.exp(-tt / 1.1) * gain;
    write(B.perc, start + s, v * (0.9 + 0.1 * Math.sin(tt * 7)), v * (0.9 + 0.1 * Math.cos(tt * 6)));
    write(HALL, start + s, v * 0.3 * B.perc.g, v * 0.3 * B.perc.g);
  }
}
function boom(t, gain = 0.6, len = 3) {
  const start = Math.floor(t * SR), lp = new SVF();
  lp.set(700, 0.7);
  let ph = 0;
  for (let s = 0; s < SR * len; s++) {
    const tt = s / SR;
    ph += (28 + 50 * Math.exp(-tt / 0.3)) / SR;
    lp.run(noise());
    const v = (Math.sin(TAU * ph) + lp.low * 0.5 * Math.exp(-tt / 0.1)) * Math.exp(-tt / (len / 3)) * gain;
    write(B.fx, start + s, v, v);
    write(HALL, start + s, v * 0.15 * B.fx.g, v * 0.15 * B.fx.g);
  }
}

// ------------------------------------------------------------------ sfx (on the picture's cues)
function whoosh(t, dur = 0.45, gain = 0.15, up = true) {
  const start = Math.floor(t * SR), bp = new SVF();
  for (let s = 0; s < SR * dur; s++) {
    const p = s / (SR * dur);
    if ((s & 7) === 0) bp.set(up ? 300 + 5000 * p * p : 5000 - 4700 * p, 1.4);
    bp.run(noise());
    const v = bp.band * Math.sin(Math.PI * p) * gain, [pl, pr] = panLR(up ? -0.6 + 1.2 * p : 0.6 - 1.2 * p);
    write(B.fx, start + s, v * pl, v * pr);
    write(REV, start + s, v * 0.3 * B.fx.g, v * 0.3 * B.fx.g);
  }
}
function riser(t0, t1, gain = 0.2) {
  const start = Math.floor(t0 * SR), len = Math.floor((t1 - t0) * SR), bp = new SVF();
  for (let s = 0; s < len; s++) {
    const p = s / len;
    if ((s & 7) === 0) bp.set(300 + 6000 * p * p, 2.0);
    bp.run(noise());
    const v = bp.band * p * p * gain;
    write(B.fx, start + s, v, v);
    write(HALL, start + s, v * 0.35 * B.fx.g, v * 0.35 * B.fx.g);
  }
}
function glitch(t, gain = 0.12, dur = 0.12) {
  const start = Math.floor(t * SR), f = 200 + rand() * 1400;
  let hold = 0, v = 0, ph = 0;
  for (let s = 0; s < SR * dur; s++) {
    if (hold-- <= 0) { hold = Math.floor(20 + rand() * 300); v = noise(); }
    ph += f / SR;
    const sq = (ph % 1) < 0.5 ? 1 : -1, env = 1 - s / (SR * dur);
    const x = (Math.round((v * 0.6 + sq * 0.3) * 6) / 6) * env * gain;
    write(B.fx, start + s, x * (rand() < 0.5 ? 1 : 0.6), x * (rand() < 0.5 ? 1 : 0.6));
  }
}
function click(t, gain = 0.05) {
  const start = Math.floor(t * SR), hp = new SVF();
  hp.set(2500 + rand() * 2500, 1.2);
  const [pl, pr] = panLR((rand() - 0.5) * 0.4);
  for (let s = 0; s < SR * 0.02; s++) {
    hp.run(noise());
    const v = hp.band * Math.exp(-s / (SR * 0.003)) * gain;
    write(B.fx, start + s, v * pl, v * pr);
  }
}
function blip(t, freq = 1400, gain = 0.07, dur = 0.08) {
  const start = Math.floor(t * SR);
  let ph = 0;
  for (let s = 0; s < SR * dur; s++) {
    const tt = s / SR;
    ph += freq * (1 - 0.3 * tt / dur) / SR;
    const v = Math.sin(TAU * ph) * Math.exp(-tt / (dur / 3)) * gain;
    write(B.fx, start + s, v, v);
    write(DLY, start + s, v * 0.3 * B.fx.g, v * 0.3 * B.fx.g);
  }
}
function typing(chars, t0, t1, gain = 0.045) {
  for (let i = 0; i < chars; i++) click(t0 + (t1 - t0) * (i / chars), gain);
}

// ------------------------------------------------------------------ the kit and synth voices the theme needs
const KICKS = [];
function kick(t, gain = 0.8) {
  KICKS.push([t, gain]);
  const start = Math.floor(t * SR);
  let ph = 0;
  for (let s = 0; s < SR * 0.5; s++) {
    const tt = s / SR;
    ph += (46 + 120 * Math.exp(-tt / 0.03)) / SR;
    const v = Math.tanh((Math.sin(TAU * ph) * Math.exp(-tt / 0.26) + (s < 180 ? noise() * (1 - s / 180) * 0.35 : 0)) * 1.6) * gain;
    write(B.kit, start + s, v, v);
  }
}
function hat(t, gain = 0.1, open = false, pan = 0.2) {
  const start = Math.floor(t * SR), hp = new SVF(), [pl, pr] = panLR(pan);
  hp.set(7500, 0.7);
  const d = open ? 0.2 : 0.035;
  for (let s = 0; s < SR * (open ? 0.6 : 0.12); s++) {
    hp.run(noise());
    const v = hp.high * Math.exp(-s / SR / d) * gain;
    write(B.kit, start + s, v * pl, v * pr);
  }
}
function ride(t, gain = 0.08) {
  const start = Math.floor(t * SR), hp = new SVF(), ph = [rand(), rand(), rand()], fr = [3150, 4720, 6210];
  hp.set(5200, 0.6);
  for (let s = 0; s < SR * 0.9; s++) {
    const tt = s / SR;
    hp.run(noise());
    let bell = 0;
    for (let k = 0; k < 3; k++) { ph[k] += fr[k] / SR; bell += Math.sin(TAU * ph[k]); }
    const v = (hp.high * 0.5 * Math.exp(-tt / 0.35) + bell * 0.08 * Math.exp(-tt / 0.5)) * gain;
    write(B.kit, start + s, v * 0.8, v);
    write(HALL, start + s, v * 0.15 * B.kit.g, v * 0.15 * B.kit.g);
  }
}
// synth bass: two detuned saws through a resonant low-pass with a pluck envelope, and a sine an octave down
function synthBass(t, dur, m, {gain = 0.18, glide = null, curve = null} = {}) {
  const f = midi(m);
  tone(B.bass, {t, dur, freq: f, type: 'saw', detune: [-7, 7], attack: 0.004, decay: 0.14, sustain: 0.5, release: 0.07, cutoff: 240,
    env: 1600, envDecay: 0.07, q: 1.2, gain, glide: glide && midi(glide), curve});
  tone(B.bass, {t, dur, freq: f / 2, type: 'sine', attack: 0.004, decay: 0.3, sustain: 0.8, release: 0.08, gain: gain * 0.9,
    glide: glide && midi(glide) / 2, curve});
}
// arpeggio pluck: a narrow square pair with a fast filter pluck into the ping-pong delay
function pluck(t, dur, m, {gain = 0.05, pan = 0, curve = null, glide = null} = {}) {
  tone(B.synth, {t, dur, freq: midi(m), type: 'square', detune: [0, 7], attack: 0.002, decay: 0.11, sustain: 0.18, release: 0.1,
    cutoff: 1300, env: 3600, envDecay: 0.06, q: 1.1, gain, pan, dly: 0.42, rev: 0.12, curve, glide: glide && midi(glide)});
}
// bell: a struck sine pair (1 : 2.76) with a short metallic attack
function bell(t, m, gain = 0.05, pan = 0.2) {
  const start = Math.floor(t * SR), f = midi(m), [pl, pr] = panLR(pan);
  let a = rand(), b = rand();
  for (let s = 0; s < SR * 2.2; s++) {
    const tt = s / SR;
    a += f / SR; b += f * 2.76 / SR;
    const v = (Math.sin(TAU * a) * Math.exp(-tt / 0.8) + Math.sin(TAU * b) * 0.35 * Math.exp(-tt / 0.18)) * gain;
    write(B.synth, start + s, v * pl, v * pr);
    write(HALL, start + s, v * 0.4 * B.synth.g, v * 0.4 * B.synth.g);
    write(DLY, start + s, v * 0.2 * B.synth.g, v * 0.2 * B.synth.g);
  }
}

// ------------------------------------------------------------------ the theme, re-thought
// Not a transcription: the song gives the harmony (each bar's root and chord, read from all its parts) and the lines the
// promo quotes (the "Deus Ex" lead, the build's descending line, the groove's fourths stab, the later synth line); everything
// else is the promo's own: the cinematic intro, the voicings, the ostinatos, the drums, the dynamics, a slow foreshadowing of
// the lead's opening motif and its callback at the end.
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BARS = G.bars;
const span = b => [bar(b), bar(b + 1)];
// each bar's chord: the root the bass parts dwell on, a major or minor third by weight, the fifth
const CHORDS = [];
for (let b = 0; b < BARS; b++) {
  const [t0, t1] = span(b), w = new Array(12).fill(0), bw = new Array(12).fill(0);
  for (const e of score.events) {
    if (e.midi == null) continue;
    const a0 = Math.max(t0, e.t), a1 = Math.min(t1, e.t + e.dur);
    if (a1 <= a0) continue;
    w[e.midi % 12] += (a1 - a0) * e.vol;
    if (['bass', 'pulse', 'low'].includes(e.role)) bw[e.midi % 12] += (a1 - a0) * e.vol;
  }
  const root = (bw.some(v => v > 0) ? bw : w).reduce((best, v, i, arr) => v > arr[best] ? i : best, 0);
  const third = w[(root + 4) % 12] > w[(root + 3) % 12] ? 4 : 3;
  CHORDS.push({root, third, name: `${NAMES[root]}${third === 3 ? 'm' : ''}`});
}
const rootMidi = (b, octave) => 12 * (octave + 1) + CHORDS[b].root;
const tones = b => { const c = CHORDS[b]; return [0, c.third, 7, 12]; };   // root, third, fifth, octave (semitones)

// the quoted lines: the song's notes of those parts in those bars, without the echo copies the module plays on other channels
const QUOTES = {lead: [[20, 28], [28, 40], [48, 52]], lead2: [[8, 12], [48, 52]], stab: [[12, 24]], synth: [[40, 48]], bass: [[12, 24]],
  arp: [[12, 24]], pulse: [[32, 40]]};
const inBars = (t, ranges) => ranges.some(([b0, b1]) => t >= bar(b0) - 1e-6 && t < bar(b1) - 1e-6);
const quoted = role => {
  const list = score.events.filter(e => e.role === role && e.midi != null && inBars(e.t, QUOTES[role]));
  // an echo copy is quieter than the note it repeats; equal repeats (a bass line's eighths) are the line itself
  return list.filter(e => !list.some(o => o !== e && o.midi % 12 === e.midi % 12 && o.t < e.t && e.t - o.t < 0.45 && o.vol > e.vol));
};
const LEAD = quoted('lead'), LEAD2 = quoted('lead2'), STAB = quoted('stab'), SYNTH = quoted('synth'), BASSLINE = quoted('bass'),
  ARP = quoted('arp'), PULSE = quoted('pulse');
const barOf = t => { let b = 0; while (b + 1 < BARS && bar(b + 1) <= t) b++; return b; };

// ------------------------------------------------------------------ the theme as synth metal
// The style of the arrangement is synth metal (chiptune and analog synths played as a metal band, fully instrumental): riffs
// on overdriven, double-tracked saw "guitars", a metal kit with double kick, square-wave arpeggios, a bright synth lead in
// twin harmony. The theme supplies the harmony and the quoted lines; the riffs, drums, intro and form are the promo's own.

// a power chord of detuned saws, overdriven and cabinet-filtered, double-tracked left and right; `mute` is a palm-muted chug
function guitar(t, dur, root, {mute = false, gain = 0.1, ring = 0.25} = {}) {
  const notes = [root, root + 7, root + 12];
  for (const [side, cents, delay] of [[-0.75, [-7, 4], 0], [0.75, [6, -3], 0.007]]) {
    const start = Math.floor((t + delay) * SR), len = Math.floor((dur + (mute ? 0.04 : ring)) * SR);
    const oscs = notes.flatMap(m => cents.map(c => ({ph: rand(), inc: midi(m) * Math.pow(2, c / 1200) / SR})));
    const hp = new SVF(), lp = new SVF(), lp2 = new SVF();
    hp.set(95, 0.7); lp.set(mute ? 1000 : 3600, 0.9); lp2.set(mute ? 1300 : 5000, 0.7);
    const [pl, pr] = panLR(side);
    for (let s = 0; s < len; s++) {
      const tt = s / SR;
      const env = mute ? Math.exp(-tt / 0.075) : tt < dur ? 1 - 0.25 * Math.min(1, tt / 0.8) : 0.75 * Math.exp(-(tt - dur) / (ring / 3));
      let x = 0;
      for (const o of oscs) { o.ph += o.inc; if (o.ph >= 1) o.ph -= 1; x += 2 * o.ph - 1 - blep(o.ph, o.inc); }
      hp.run(x / oscs.length);
      lp.run(Math.tanh(hp.high * 10));
      lp2.run(lp.low);
      const v = lp2.low * env * gain;
      write(B.guitar, start + s, v * pl, v * pr);
      write(REV, start + s, v * pl * 0.08 * B.guitar.g, v * pr * 0.08 * B.guitar.g);
    }
  }
}
// the guitars' register: each bar's root between E2 and D#3
const riffRoot = b => { const r = rootMidi(b, 2); return r > 51 ? r - 12 : r; };
// a sixteenth-step riff over bar b: 'O' an open power chord (rings to the next hit), 'm' a palm-muted chug, '.' a rest;
// the double kick follows every hit
function riffBar(b, pattern, {gain = 0.1, kickGain = 0.42} = {}) {
  const [t0, t1] = span(b), s16 = (t1 - t0) / 16, r = riffRoot(b);
  [...pattern].forEach((c, i) => {
    if (c === '.') return;
    const t = t0 + i * s16;
    if (c === 'O') {
      let n = 1; while (i + n < 16 && pattern[i + n] === '.') n++;
      guitar(t, n * s16 * 0.95, r, {gain});
    } else guitar(t, s16 * 0.8, r, {mute: true, gain: gain * 0.85});
    if (kickGain) kick(t, kickGain * (c === 'O' ? 1 : 0.7));
  });
}
function snares(b, steps, gain = 0.22) { const [t0, t1] = span(b); for (const i of steps) snare(t0 + i * (t1 - t0) / 16, gain, 0.1); }
function hats(b, every = 2, gain = 0.05) { const [t0, t1] = span(b); for (let i = 0; i < 16; i += every) hat(t0 + i * (t1 - t0) / 16, gain * (i % 4 === 0 ? 1.3 : 1), false, i % 4 ? 0.3 : -0.2); }
function crashOn(b, gain = 0.14) { crash(bar(b), gain); }
function tomFill(b, from = 8, gain = 0.32) {
  const [t0, t1] = span(b), s16 = (t1 - t0) / 16;
  for (let i = from; i < 16; i++) taiko(t0 + i * s16, gain * (0.7 + 0.3 * (i - from) / (16 - from)), 190 - (i - from) * 12, (i - from) / (16 - from) - 0.5);
}
// a square-wave arpeggio over a bar's chord tones, sixteenths: the chiptune layer
function chipBar(b, {gain = 0.04, octave = 5, pattern = [0, 1, 2, 3, 2, 1, 0, 2]} = {}) {
  const [t0, t1] = span(b), s16 = (t1 - t0) / 16, r = rootMidi(b, octave - 1), tt = tones(b);
  for (let i = 0; i < 16; i++) pluck(t0 + i * s16, s16 * 0.8, r + tt[pattern[i % pattern.length]], {gain, pan: i % 2 ? 0.4 : -0.4});
}
// a dark analog pad: four detuned saws, slow filter
function darkPad(t, dur, notes, {gain = 0.025, cutoff = 900} = {}) {
  for (const m of notes) tone(B.synth, {t, dur, freq: midi(m), type: 'saw', detune: [-11, -4, 5, 12], attack: Math.min(2, dur * 0.3), decay: 1, sustain: 1,
    release: 1.5, cutoff, q: 0.9, gain, hall: 0.5, lfo: 0.4, lfoRate: 0.12});
}
// the lead: a bright synth (three detuned pulse-saws, vibrato, delay); its twin a diatonic third above, in A minor
function lead(t, dur, m, {gain = 0.06, pan = 0, glide = null, clean = false} = {}) {
  ens(B.lead, {t, dur, freq: midi(m), n: 3, spread: 7, attack: 0.006, decay: 0.25, sustain: 0.85, release: 0.15, cutoff: clean ? 1800 : 3800,
    env: clean ? 600 : 1800, envDecay: 0.1, q: 0.9, gain, pan, width: 0.3, hall: 0.25, dly: 0.3, vib: dur > 0.3 && !clean ? 16 : 0, vibRate: 5.8,
    vibDelay: 0.16, glide: glide && midi(glide), glideTime: 0.04, square: 0.5});
}
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const thirdAbove = m => {
  const rel = ((m - 9) % 12 + 12) % 12, k = MINOR.indexOf(rel);
  if (k < 0) return m + 3;
  const up = MINOR[(k + 2) % 7] + (k + 2 >= 7 ? 12 : 0);
  return m + up - rel;
};
function twin(list, {gain = 0.06, octave = 1, harmony = true, clean = false} = {}) {
  for (const e of list) {
    const d = Math.max(0.1, Math.min(e.dur, 2)) * 0.97, m = e.midi + 12 * octave;
    lead(e.t, d, m, {gain: gain * Math.max(0.6, e.vol), pan: harmony ? -0.25 : 0, clean});
    if (harmony) lead(e.t, d, thirdAbove(m), {gain: gain * 0.7 * Math.max(0.6, e.vol), pan: 0.25, clean});
  }
}
const powerHit = (b, gain = 0.13) => { guitar(bar(b), 1.6, riffRoot(b), {gain, ring: 1.2}); crashOn(b, 0.16); kick(bar(b), 0.6); };

// open (bars 0-7): a dark analog intro under the cinematic; a slow chip arpeggio fades in; the lead's motif, slow and clean
boom(bar(0) + 0.02, 0.4, 4);
darkPad(bar(0), bar(4) - bar(0), [rootMidi(0, 2), rootMidi(0, 3), rootMidi(0, 3) + 7], {gain: 0.026, cutoff: 700});
darkPad(bar(4), bar(8) - bar(4), [rootMidi(4, 2), rootMidi(4, 3), rootMidi(4, 3) + 7], {gain: 0.028, cutoff: 900});
tone(B.bass, {t: bar(0), dur: bar(8) - bar(0), freq: midi(rootMidi(0, 1)), type: 'sine', attack: 2, sustain: 1, release: 1, gain: 0.08});
for (let b = 2; b < 8; b++) chipBar(b, {gain: 0.012 + 0.004 * (b - 2), pattern: [0, 2, 1, 3, 2, 1, 2, 0]});
guitar(bar(4), bar(5) - bar(4), riffRoot(4), {gain: 0.06, ring: 1.5}); guitar(bar(6), bar(7) - bar(6), riffRoot(6), {gain: 0.07, ring: 1.5});
{
  const motif = LEAD.filter(e => e.t < bar(22)).slice(0, 6);
  const beats = [bar(4), ...[1, 2, 3].map(k => bar(4) + k * (bar(5) - bar(4)) / 4), bar(5), bar(5) + (bar(6) - bar(5)) / 2];
  motif.forEach((e, k) => lead(beats[k], (k < 5 ? beats[k + 1] - beats[k] : bar(8) - beats[k] - 0.4) * 0.98, e.midi, {gain: 0.04, clean: true}));
}
snareRoll(bar(7.5), bar(8), 0.04, 0.2); cymbalSwell(bar(7), bar(8), 0.2);

// reveal (bars 8-11): the build. Eighth-note chugs and kick rising, the chip arpeggio in sixteenths, the theme's descending line
for (let b = 8; b < 12; b++) {
  riffBar(b, b < 10 ? 'm.m.m.m.m.m.m.m.' : 'mmmmmmmmmmmmmmmm', {gain: 0.06 + 0.012 * (b - 8), kickGain: 0.3 + 0.04 * (b - 8)});
  chipBar(b, {gain: 0.025, pattern: [0, 1, 2, 3]});
  if (b >= 10) hats(b, 2, 0.04);
}
twin(LEAD2.filter(e => e.t < bar(12)), {gain: 0.05, octave: 1, harmony: false});
snareRoll(bar(11), bar(12), 0.06, 0.26); tomFill(11, 12, 0.3);

// island (bars 12-23): the main riff (a gallop), double kick, snare on 2 and 4; the theme's bass line, arpeggio and fourths
// stab quoted on top; the twin lead from bar 20
for (let b = 12; b < 24; b++) {
  riffBar(b, 'O.mmO.mmO.mmO.mm', {gain: 0.085});
  snares(b, [4, 12]);
  hats(b, 2, 0.045);
  if (b % 4 === 0) crashOn(b, 0.12);
}
tomFill(19, 12, 0.28); tomFill(23, 12, 0.3);
for (const e of BASSLINE) synthBass(e.t, Math.min(e.dur, 0.8), e.midi, {gain: 0.07 * Math.max(0.5, e.vol)});
let chipSide = 1;
for (const e of ARP) pluck(e.t, Math.min(e.dur, 0.3), e.midi + 12, {gain: 0.04 * Math.max(0.5, e.vol), pan: (chipSide = -chipSide) * 0.4});
for (const e of STAB) if (e.t < bar(20))
  ens(B.lead, {t: e.t, dur: Math.min(e.dur, 0.12), freq: midi(e.midi + 12), n: 3, spread: 9, attack: 0.003, decay: 0.08, sustain: 0.3, release: 0.1,
    cutoff: 2600, env: 3000, envDecay: 0.05, q: 1, gain: 0.035 * Math.max(0.5, e.vol), width: 0.6, dly: 0.2, vib: 0, square: 0.6});
twin(LEAD.filter(e => e.t >= bar(20) && e.t < bar(24)), {gain: 0.06});

// method (bars 24-31): the half-time breakdown. Open chords on the one and the three, kick and a half-time snare, the arpeggio
// low; the lead's continuation on a clean lead; then tremolo-picked chugs climbing into the bridge
for (let b = 24; b < 28; b++) {
  riffBar(b, 'O.......O.......', {gain: 0.07, kickGain: 0.5});
  snares(b, [8], 0.24);
  chipBar(b, {gain: 0.018, octave: 4, pattern: [0, 2, 3, 2]});
}
twin(LEAD.filter(e => e.t >= bar(24) && e.t < bar(28)), {gain: 0.04, octave: 0, harmony: false, clean: true});
for (let b = 28; b < 32; b++) {
  const [t0, t1] = span(b), s32 = (t1 - t0) / 32;
  for (let i = 0; i < 32; i++) guitar(t0 + i * s32, s32 * 0.8, riffRoot(b), {mute: true, gain: 0.05 + 0.02 * (b - 28) / 3});
  kick(t0, 0.5); snares(b, [8], 0.22);
}
for (const e of LEAD.filter(e => e.t >= bar(28) && e.t < bar(32))) lead(e.t, Math.min(e.dur, 1.4), e.midi, {gain: 0.045});
riser(bar(30), bar(32), 0.14); snareRoll(bar(31), bar(32), 0.05, 0.26); tomFill(31, 8, 0.32); cymbalSwell(bar(31), bar(32), 0.2);

// pairs (bars 32-39): the bridge at full speed. Sixteenth chugs and double kick, a crash on every bar, the theme's pulse on the
// synth bass, the twin lead an octave up
for (let b = 32; b < 40; b++) {
  riffBar(b, 'OmmmmmmmOmmmmmmm', {gain: 0.08, kickGain: 0.36});
  snares(b, [4, 12]);
  crashOn(b, 0.1);
}
for (const e of PULSE) synthBass(e.t, Math.min(e.dur, 0.5), e.midi, {gain: 0.065 * Math.max(0.5, e.vol)});
twin(LEAD.filter(e => e.t >= bar(32) && e.t < bar(40)), {gain: 0.065});
tomFill(39, 8, 0.32);

// progress (bars 40-47): the machine section. Eighth chugs, a straight beat, the theme's synth line as a chip arpeggio
for (let b = 40; b < 48; b++) {
  riffBar(b, 'O.m.m.m.O.m.m.m.', {gain: 0.07, kickGain: 0.38});
  snares(b, [4, 12], 0.2);
  hats(b, 1, 0.035);
  if (b % 4 === 0) crashOn(b, 0.1);
}
for (const e of SYNTH) { pluck(e.t, Math.min(e.dur, 0.4), e.midi, {gain: 0.05, pan: (chipSide = -chipSide) * 0.3}); pluck(e.t, Math.min(e.dur, 0.3), e.midi + 12, {gain: 0.025}); }
darkPad(bar(44), bar(48) - bar(44), [rootMidi(44, 3), rootMidi(44, 3) + 7], {gain: 0.02, cutoff: 1600});
cymbalSwell(bar(47), bar(48), 0.16);

// numbers (bars 48-51): the melody's return, twin lead over the gallop, building to the last hit
for (let b = 48; b < 52; b++) {
  riffBar(b, b < 50 ? 'O.mmO.mmO.mmO.mm' : 'OmmmOmmmOmmmOmmm', {gain: 0.085});
  snares(b, [4, 12]);
  crashOn(b, 0.1);
}
twin(LEAD.filter(e => e.t >= bar(48) && e.t < bar(52)), {gain: 0.065});
twin(LEAD2.filter(e => e.t >= bar(48) && e.t < bar(52)), {gain: 0.035, octave: 1, harmony: false});
tomFill(51, 8, 0.34); snareRoll(bar(51.5), bar(52), 0.06, 0.26);

// outro (bars 52-55): the last power chord rings; the pad, and the motif's callback on the clean lead
darkPad(bar(52), bar(56) - bar(52) + 1.5, [rootMidi(52, 2), rootMidi(52, 3), rootMidi(52, 3) + 7], {gain: 0.028, cutoff: 1100});
tone(B.bass, {t: bar(52), dur: bar(56) - bar(52), freq: midi(rootMidi(52, 1)), type: 'sine', attack: 0.05, sustain: 1, release: 2, gain: 0.09});
{
  const motif = LEAD.filter(e => e.t < bar(22)).slice(0, 3);
  const at = [bar(53), bar(53) + (bar(54) - bar(53)) / 2, bar(54)];
  motif.forEach((e, k) => lead(at[k], k < 2 ? (at[k + 1] - at[k]) * 0.97 : bar(56) - at[k], e.midi, {gain: 0.045, clean: true}));
}

// ------------------------------------------------------------------ the hits on the section cuts
powerHit(8); boom(bar(8), 0.45, 3);
powerHit(12, 0.12);
powerHit(32, 0.12);
powerHit(52, 0.14); boom(bar(52), 0.5, 4);

// ------------------------------------------------------------------ cut effects on the picture's cues (ad/src/main.js)
typing(14, bar(0.6), bar(0.6) + 0.8);                                   // "Deus Ex, 2000."
for (const b of [2, 3, 4, 5, 6, 7]) glitch(bar(b), 0.06, 0.08);           // the intro's shots
typing(24, bar(9) + 0.1, bar(9) + 1.0, 0.035);                          // "Running in your browser."
for (const b of [13.5, 15, 16.5, 18, 19.5, 21, 22.5, 24]) whoosh(bar(b) - 0.22, 0.32, 0.08, b % 3 === 0);
for (const t0 of [bar(24.4), bar(24.9), bar(25.4)]) for (let i = 0; i < 11; i++) click(t0 + 0.2 + i * 0.07, 0.035);   // the cards' lines
[0, 1, 2, 3].forEach(i => blip(bar(28.2) + i * BEAT, 660 + i * 110, 0.05, 0.12));                                  // the oracle's verdict
[0, 1, 2].forEach(i => blip(bar(30.6) + i * 0.25, 880 + i * 220, 0.05, 0.25));                                     // fstp = .store()
for (let b = 33; b < 40; b++) whoosh(bar(b) - 0.2, 0.3, 0.07, b % 2 === 0);                                       // the pairs
for (let i = 0; i < 15; i++) blip(bar(40) + 1.0 + i * 0.3, 990 + i * 40, 0.035, 0.08);                            // the milestones
for (let i = 0; i < 4; i++) blip(bar(44) + 0.3 + i * 0.3, 740 + i * 90, 0.05, 0.12);                              // the stage cards
for (let i = 0; i < 6; i++) blip(bar(48) + 0.2 + i * 0.3, 1180 + i * 70, 0.05, 0.1);                              // the tiles

// ------------------------------------------------------------------ effects
function duck(bus, times, depth, release = 0.12) {
  const env = new Float32Array(N).fill(1);
  for (const [t, g] of times) {
    const s0 = Math.floor(t * SR), d = depth * Math.min(1, g * 2);
    for (let s = 0; s < SR * release * 4 && s0 + s < N; s++) env[s0 + s] = Math.min(env[s0 + s], 1 - d * Math.exp(-s / (SR * release)));
  }
  for (let i = 0; i < N; i++) { bus.L[i] *= env[i]; bus.R[i] *= env[i]; }
}
function pingpong(src, time = BEAT * 0.75, feedback = 0.4, damp = 3000) {
  const d = Math.floor(time * SR), outL = new Float32Array(N), outR = new Float32Array(N), lpL = new SVF(), lpR = new SVF();
  lpL.set(damp, 0.6); lpR.set(damp, 0.6);
  for (let i = 0; i < N; i++) {
    const fl = i >= d ? outR[i - d] : 0, fr = i >= d ? outL[i - d] : 0;
    outL[i] = lpL.run((src.L[i] + src.R[i]) * 0.5 + fl * feedback);
    outR[i] = lpR.run(fr * feedback);
  }
  return {L: outL, R: outR};
}
function reverb(src, room = 0.86, damp = 0.35, scale = 1, predelay = 0) {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116].map(n => Math.round(n * scale * SR / 44100));
  const aps = [556, 441, 341, 225].map(n => Math.round(n * SR / 44100));
  const pre = Math.floor(predelay * SR);
  const out = {L: new Float32Array(N), R: new Float32Array(N)};
  for (const [ch, spread] of [['L', 0], ['R', 23]]) {
    const input = src[ch], acc = new Float32Array(N);
    for (const len0 of combs) {
      const len = len0 + spread, buf = new Float32Array(len);
      let idx = 0, store = 0;
      for (let i = 0; i < N; i++) {
        const y = buf[idx];
        store = y * (1 - damp) + store * damp;
        buf[idx] = (i >= pre ? input[i - pre] : 0) * 0.015 + store * room;
        acc[i] += y;
        if (++idx >= len) idx = 0;
      }
    }
    for (const len0 of aps) {
      const len = len0 + spread, buf = new Float32Array(len);
      let idx = 0;
      for (let i = 0; i < N; i++) {
        const b = buf[idx], x = acc[i];
        acc[i] = -x + b; buf[idx] = x + b * 0.5;
        if (++idx >= len) idx = 0;
      }
    }
    out[ch] = acc;
  }
  return out;
}

const levels = Object.fromEntries(Object.keys(B).map(name => [name, 1]));
if (process.env.MUSIC_DEBUG) {
  for (const [label, [a, b]] of Object.keys(G.sections).map(name => [name, G.span(name).map(t => Math.floor(t * SR))])) {
    const rows = Object.entries(B).map(([name, bus]) => {
      let sum = 0;
      for (let i = a; i < b; i++) sum += bus.L[i] * bus.L[i] + bus.R[i] * bus.R[i];
      return `${name} ${(10 * Math.log10(sum * levels[name] ** 2 / (2 * (b - a)) + 1e-12)).toFixed(1)}`;
    });
    console.log(label.padEnd(9), rows.join(' | '));
  }
}
// MUSIC_STEMS=1: each bus, dry, to ad/build/stems/<bus>.wav (mixing checks)
if (process.env.MUSIC_STEMS) {
  const dir = path.resolve(here, '../build/stems');
  mkdirSync(dir, {recursive: true});
  for (const [name, bus] of Object.entries(B)) {
    let peak = 1e-9; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(bus.L[i]), Math.abs(bus.R[i]));
    const out = Buffer.alloc(44 + N * 4);
    out.write('RIFF', 0); out.writeUInt32LE(36 + N * 4, 4); out.write('WAVE', 8); out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20);
    out.writeUInt16LE(2, 22); out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 4, 28); out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(N * 4, 40);
    for (let i = 0; i < N; i++) { out.writeInt16LE(Math.round(bus.L[i] / peak * 32000), 44 + 4 * i); out.writeInt16LE(Math.round(bus.R[i] / peak * 32000), 46 + 4 * i); }
    writeFileSync(path.join(dir, `${name}.wav`), out);
  }
}
// the heartbeat and the taiko make room in the sustained voices
duck(B.low, BEATS.map(t => [t, 0.5]), 0.35); duck(B.strings, TAIKOS, 0.12); duck(B.choir, TAIKOS, 0.08);
const echo = pingpong(DLY);
const room = reverb(REV, 0.84, 0.35, 1, 0.01);
const hall = reverb(HALL, 0.9, 0.45, 1.35, 0.03);
const mix = {L: new Float32Array(N), R: new Float32Array(N)};
for (const [name, bus] of Object.entries(B)) {
  const g = levels[name];
  for (let i = 0; i < N; i++) { mix.L[i] += bus.L[i] * g; mix.R[i] += bus.R[i] * g; }
}
for (let i = 0; i < N; i++) {
  mix.L[i] += echo.L[i] * 0.45 + room.L[i] * 0.7 + hall.L[i] * 1.0;
  mix.R[i] += echo.R[i] * 0.45 + room.R[i] * 0.7 + hall.R[i] * 1.0;
}
// high-pass the master below the timpani's and taiko's fundamentals' useful range
const hpL = new SVF(), hpR = new SVF();
hpL.set(34, 0.7); hpR.set(34, 0.7);
// and a high shelf (+3 dB from about 4 kHz) for the strings' and cymbals' air
const shL = new SVF(), shR = new SVF();
shL.set(4000, 0.6); shR.set(4000, 0.6);
// Look-ahead peak limiter (2 ms window, 80 ms release) into a -1 dBFS ceiling, then a gentle soft clip; MUSIC_GAIN sets the loudness.
let raw = 0;
for (let i = 0; i < N; i++) {
  hpL.run(mix.L[i]); hpR.run(mix.R[i]);
  mix.L[i] = hpL.high; mix.R[i] = hpR.high;
  shL.run(mix.L[i]); shR.run(mix.R[i]);
  mix.L[i] += shL.high * 0.42; mix.R[i] += shR.high * 0.42;
  raw = Math.max(raw, Math.abs(mix.L[i]), Math.abs(mix.R[i]));
}
const INPUT_GAIN = Number(process.env.MUSIC_GAIN ?? 1.15) / raw;
const ceiling = 0.87, look = Math.floor(SR * 0.002), relCoef = 1 - Math.exp(-1 / (SR * 0.08));
const absMax = new Float32Array(N);
for (let i = 0; i < N; i++) absMax[i] = Math.max(Math.abs(mix.L[i]), Math.abs(mix.R[i])) * INPUT_GAIN;
const ahead = new Float32Array(N), deque = new Int32Array(N);
let head = 0, tail = 0;
for (let i = N - 1; i >= 0; i--) {
  while (tail > head && absMax[deque[tail - 1]] <= absMax[i]) tail--;
  deque[tail++] = i;
  while (deque[head] > i + look) head++;
  ahead[i] = absMax[deque[head]];
}
let g = 1, peak = 0, reduction = 0;
for (let i = 0; i < N; i++) {
  const target = Math.min(1, ceiling / Math.max(1e-9, ahead[i]));
  g = target < g ? target : g + (target - g) * relCoef;
  reduction = Math.max(reduction, -20 * Math.log10(g));
  mix.L[i] = Math.tanh(mix.L[i] * INPUT_GAIN * g * 1.05) / Math.tanh(1.05);
  mix.R[i] = Math.tanh(mix.R[i] * INPUT_GAIN * g * 1.05) / Math.tanh(1.05);
  peak = Math.max(peak, Math.abs(mix.L[i]), Math.abs(mix.R[i]));
}
console.log(`raw ${raw.toFixed(2)} · max gain reduction ${reduction.toFixed(1)} dB`);
const norm = Math.min(1, 0.891 / peak);
const fadeIn = SR * 0.02, fadeOut = SR * 3;
const pcm = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  const edge = Math.min(1, i / fadeIn, (N - i) / fadeOut);
  for (const [c, arr] of [[0, mix.L], [1, mix.R]]) {
    const dither = (rand() - rand()) / 32768;
    const v = Math.max(-1, Math.min(1, arr[i] * norm * edge + dither));
    pcm.writeInt16LE(Math.round(v * 32767), i * 4 + c * 2);
  }
}
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
mkdirSync(path.dirname(OUT), {recursive: true});
writeFileSync(OUT, Buffer.concat([header, pcm]));
writeFileSync(path.resolve(here, '../build/score.json'), JSON.stringify({song: 'Title_Music', arrangement: ARRANGEMENT, bars: score.bars, end: score.end}));
console.log(`wrote ${OUT} · ${DUR.toFixed(1)}s · peak before normalize ${peak.toFixed(3)} · ${LEAD.length + LEAD2.length + STAB.length + SYNTH.length} quoted notes over the theme's ${G.bars} bars`);
