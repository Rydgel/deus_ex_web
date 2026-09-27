// Original soundtrack for the promo, synthesized from scratch (no samples):
// a 120 BPM D-minor piece in the spirit of late-90s tracker game scores —
// ping-pong arpeggios, breakbeat drums, synth-brass lead, orchestra stabs —
// with its own melody, plus sound effects placed on the video's cuts.
// Writes ad/build/music.wav (48 kHz, 16-bit stereo).
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../build/music.wav');
const SR = 48000, DUR = 106, N = Math.ceil(SR * DUR);
const BEAT = 0.5, BAR = 2, S16 = BEAT / 4;
const TAU = Math.PI * 2;

// ------------------------------------------------------------------ buses
const mkbus = () => ({L: new Float32Array(N), R: new Float32Array(N)});
const B = {drums: mkbus(), bass: mkbus(), pad: mkbus(), arp: mkbus(), lead: mkbus(), keys: mkbus(), orch: mkbus(), fx: mkbus()};
const REV = mkbus(), DLY = mkbus();

let seed = 0x2d5f1a;
const rand = () => { seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return seed / 4294967296; };
const noise = () => rand() * 2 - 1;
const midi = n => 440 * Math.pow(2, (n - 69) / 12);
const NOTES = {C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11};
const note = name => { const m = /^([A-G][#b]?)(-?\d)$/.exec(name); return 12 * (Number(m[2]) + 1) + NOTES[m[1]]; };

function write(bus, i, l, r) { if (i >= 0 && i < N) { bus.L[i] += l; bus.R[i] += r; } }
const panLR = pan => [Math.cos((pan + 1) * Math.PI / 4), Math.sin((pan + 1) * Math.PI / 4)];

// Topology-preserving state-variable filter.
class SVF {
  constructor() { this.a = 0; this.b = 0; }
  set(fc, q) {
    const g = Math.tan(Math.PI * Math.min(fc, SR * 0.45) / SR), k = 1 / q;
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

// Generic subtractive voice.
function tone(bus, o) {
  const {t, dur, freq, type = 'saw', detune = [0], attack = 0.005, decay = 0.2, sustain = 0.7, release = 0.2,
    cutoff = 4000, env = 0, envDecay = 0.2, q = 0.8, pan = 0, gain = 0.2, vib = 0, vibRate = 5.5, vibDelay = 0.25,
    glide = null, glideTime = 0.06, rev = 0, dly = 0, sub = 0, drive = 0} = o;
  const start = Math.floor(t * SR), len = Math.floor((dur + release) * SR);
  const [pl, pr] = panLR(pan);
  const oscs = detune.map(c => ({ph: rand(), ratio: Math.pow(2, c / 1200), sp: (detune.length > 1 ? (c > 0 ? 0.35 : -0.35) : 0)}));
  const filt = new SVF();
  let subPh = 0;
  for (let n = 0; n < len; n++) {
    const tt = n / SR;
    let amp;
    if (tt < attack) amp = tt / attack;
    else if (tt < dur) amp = sustain + (1 - sustain) * Math.exp(-(tt - attack) / Math.max(1e-4, decay));
    else amp = (sustain + (1 - sustain) * Math.exp(-(dur - attack) / Math.max(1e-4, decay))) * Math.exp(-(tt - dur) / Math.max(1e-4, release / 3));
    if (amp < 1e-5 && tt > dur) break;
    let f = freq;
    if (glide) f = glide + (freq - glide) * (1 - Math.exp(-tt / glideTime));
    if (vib && tt > vibDelay) f *= Math.pow(2, vib * Math.min(1, (tt - vibDelay) / 0.3) * Math.sin(TAU * vibRate * tt) / 1200);
    if ((n & 7) === 0) filt.set(cutoff + env * Math.exp(-tt / envDecay), q);
    let x = 0, xl = 0, xr = 0;
    for (const osc of oscs) {
      const dt = f * osc.ratio / SR;
      osc.ph += dt; if (osc.ph >= 1) osc.ph -= 1;
      let v;
      if (type === 'saw') v = 2 * osc.ph - 1 - blep(osc.ph, dt);
      else if (type === 'square') { v = osc.ph < 0.5 ? 1 : -1; v += blep(osc.ph, dt); v -= blep((osc.ph + 0.5) % 1, dt); }
      else if (type === 'tri') v = 1 - 4 * Math.abs(osc.ph - 0.5);
      else v = Math.sin(TAU * osc.ph);
      xl += v * (0.5 - osc.sp); xr += v * (0.5 + osc.sp); x += v;
    }
    const norm = 1 / Math.sqrt(oscs.length);
    if (sub) { subPh += f / 2 / SR; if (subPh >= 1) subPh -= 1; }
    const subv = sub ? Math.sin(TAU * subPh) * sub : 0;
    // filter the mono sum, keep a little stereo spread from the detune
    const y = filt.run(x * norm + subv);
    const spread = (xl - xr) * norm * 0.25;
    let l = (y + spread) * amp * gain, r = (y - spread) * amp * gain;
    if (drive) { l = Math.tanh(l * drive) / drive; r = Math.tanh(r * drive) / drive; }
    const i = start + n;
    write(bus, i, l * pl * 1.41, r * pr * 1.41);
    if (rev) write(REV, i, l * rev, r * rev);
    if (dly) write(DLY, i, l * dly, r * dly);
  }
}

// ------------------------------------------------------------------ drums
const KICKS = [];
function kick(t, gain = 0.9) {
  KICKS.push(t);
  const start = Math.floor(t * SR);
  let ph = 0;
  for (let n = 0; n < SR * 0.5; n++) {
    const tt = n / SR;
    const f = 44 + 120 * Math.exp(-tt / 0.03);
    ph += f / SR;
    const body = Math.sin(TAU * ph) * Math.exp(-tt / 0.28);
    const click = n < 180 ? noise() * (1 - n / 180) * 0.35 : 0;
    const v = Math.tanh((body + click) * 1.6) * gain;
    write(B.drums, start + n, v, v);
  }
}
function snare(t, gain = 0.5, tail = 0.16) {
  const start = Math.floor(t * SR), bp = new SVF(), hp = new SVF();
  bp.set(1900, 0.9); hp.set(700, 0.7);
  let ph = 0;
  for (let n = 0; n < SR * 0.45; n++) {
    const tt = n / SR;
    const nz = noise();
    bp.run(nz); hp.run(nz);
    ph += (185 + 60 * Math.exp(-tt / 0.02)) / SR;
    const v = ((bp.band * 0.9 + hp.high * 0.5) * Math.exp(-tt / tail) + Math.sin(TAU * ph) * 0.6 * Math.exp(-tt / 0.06)) * gain;
    write(B.drums, start + n, v, v * 0.96);
    write(REV, start + n, v * 0.25, v * 0.25);
  }
}
function hat(t, gain = 0.12, open = false, pan = 0.2) {
  const start = Math.floor(t * SR), hp = new SVF();
  hp.set(7500, 0.7);
  const [pl, pr] = panLR(pan);
  const d = open ? 0.22 : 0.035;
  for (let n = 0; n < SR * (open ? 0.6 : 0.12); n++) {
    const tt = n / SR;
    hp.run(noise());
    const v = hp.high * Math.exp(-tt / d) * gain;
    write(B.drums, start + n, v * pl, v * pr);
  }
}
function crash(t, gain = 0.28) {
  const start = Math.floor(t * SR), hp = new SVF(), bp = new SVF();
  hp.set(4200, 0.6); bp.set(9000, 0.5);
  for (let n = 0; n < SR * 3; n++) {
    const tt = n / SR;
    const nz = noise();
    hp.run(nz); bp.run(nz);
    const v = (hp.high * 0.7 + bp.band * 0.5) * Math.exp(-tt / 0.9) * gain;
    write(B.drums, start + n, v * (0.9 + 0.1 * Math.sin(tt * 7)), v * (0.9 + 0.1 * Math.cos(tt * 6)));
    write(REV, start + n, v * 0.3, v * 0.3);
  }
}
function boom(t, gain = 0.9, len = 2.2) {
  const start = Math.floor(t * SR), lp = new SVF();
  lp.set(900, 0.7);
  let ph = 0;
  for (let n = 0; n < SR * len; n++) {
    const tt = n / SR;
    ph += (30 + 60 * Math.exp(-tt / 0.25)) / SR;
    lp.run(noise());
    const v = (Math.sin(TAU * ph) * 1.0 + lp.low * 0.5 * Math.exp(-tt / 0.08)) * Math.exp(-tt / (len / 3)) * gain;
    write(B.fx, start + n, v, v);
    write(REV, start + n, v * 0.2, v * 0.2);
  }
}

// ------------------------------------------------------------------ sfx
function whoosh(t, dur = 0.45, gain = 0.22, up = true) {
  const start = Math.floor(t * SR), bp = new SVF();
  for (let n = 0; n < SR * dur; n++) {
    const tt = n / SR, p = tt / dur;
    if ((n & 7) === 0) bp.set(up ? 300 + 5000 * p * p : 5000 - 4700 * p, 1.4);
    bp.run(noise());
    const v = bp.band * Math.sin(Math.PI * p) * gain;
    const pan = up ? -0.6 + 1.2 * p : 0.6 - 1.2 * p;
    const [pl, pr] = panLR(pan);
    write(B.fx, start + n, v * pl, v * pr);
    write(REV, start + n, v * 0.3, v * 0.3);
  }
}
function riser(t0, t1, gain = 0.25) {
  const start = Math.floor(t0 * SR), len = Math.floor((t1 - t0) * SR), bp = new SVF();
  let ph = 0;
  for (let n = 0; n < len; n++) {
    const p = n / len;
    if ((n & 7) === 0) bp.set(400 + 7000 * p * p, 2.0);
    bp.run(noise());
    ph += (110 + 770 * p * p) / SR;
    const saw = 2 * (ph % 1) - 1;
    const v = (bp.band * 0.8 + saw * 0.12 * p) * p * p * gain;
    write(B.fx, start + n, v, v);
    write(REV, start + n, v * 0.35, v * 0.35);
  }
}
function glitch(t, gain = 0.2, dur = 0.16) {
  const start = Math.floor(t * SR);
  let hold = 0, v = 0, ph = 0;
  const f = 200 + rand() * 1400;
  for (let n = 0; n < SR * dur; n++) {
    if (hold-- <= 0) { hold = Math.floor(20 + rand() * 300); v = noise(); }
    ph += f / SR;
    const sq = (ph % 1) < 0.5 ? 1 : -1;
    const env = 1 - n / (SR * dur);
    const s = (Math.round((v * 0.6 + sq * 0.3) * 6) / 6) * env * gain;
    write(B.fx, start + n, s * (rand() < 0.5 ? 1 : 0.6), s * (rand() < 0.5 ? 1 : 0.6));
  }
}
function click(t, gain = 0.07) {
  const start = Math.floor(t * SR), hp = new SVF();
  hp.set(2500 + rand() * 2500, 1.2);
  const pan = (rand() - 0.5) * 0.4, [pl, pr] = panLR(pan);
  for (let n = 0; n < SR * 0.02; n++) {
    hp.run(noise());
    const v = hp.band * Math.exp(-n / (SR * 0.003)) * gain;
    write(B.fx, start + n, v * pl, v * pr);
  }
}
function blip(t, freq = 1400, gain = 0.1, dur = 0.08) {
  const start = Math.floor(t * SR);
  let ph = 0;
  for (let n = 0; n < SR * dur; n++) {
    const tt = n / SR;
    ph += freq * (1 - 0.3 * tt / dur) / SR;
    const v = Math.sin(TAU * ph) * Math.exp(-tt / (dur / 3)) * gain;
    write(B.fx, start + n, v, v);
    write(DLY, start + n, v * 0.3, v * 0.3);
  }
}
function chatter(t0, t1, gain = 0.05) {
  for (let t = t0; t < t1; t += 0.028 + rand() * 0.02) blip(t, 600 + rand() * 2600, gain, 0.025);
}
function typing(text, t0, t1, gain = 0.06) {
  const chars = text.length;
  for (let i = 0; i < chars; i++) if (text[i] !== ' ') click(t0 + (t1 - t0) * (i / chars), gain);
}

// ------------------------------------------------------------------ harmony
const CHORDS = {
  Dm: {root: 'D2', pad: ['D3', 'F3', 'A3', 'D4', 'E4'], arp: ['D5', 'A5', 'F5', 'A5', 'D6', 'A5', 'F5', 'E5']},
  Bb: {root: 'Bb1', pad: ['Bb2', 'D3', 'F3', 'Bb3', 'C4'], arp: ['Bb4', 'F5', 'D5', 'F5', 'Bb5', 'F5', 'D5', 'C5']},
  Gm: {root: 'G1', pad: ['G2', 'Bb2', 'D3', 'G3', 'A3'], arp: ['G4', 'D5', 'Bb4', 'D5', 'G5', 'D5', 'Bb4', 'A4']},
  A: {root: 'A1', pad: ['A2', 'C#3', 'E3', 'A3', 'E4'], arp: ['A4', 'E5', 'C#5', 'E5', 'A5', 'E5', 'C#5', 'E5']},
  C: {root: 'C2', pad: ['C3', 'E3', 'G3', 'C4', 'D4'], arp: ['C5', 'G5', 'E5', 'G5', 'C6', 'G5', 'E5', 'D5']},
};
const LOOP = ['Dm', 'Bb', 'Gm', 'A'];
const barStart = b => b * BAR;              // bar index from 0
const chordAt = b => LOOP[b % 4];

function pad(b, chord, gain = 0.07, bars = 1, cutoff = 1700) {
  for (const n of CHORDS[chord].pad)
    tone(B.pad, {t: barStart(b), dur: bars * BAR, freq: midi(note(n)), type: 'saw', detune: [-9, -3, 4, 10], attack: 0.9,
      decay: 1, sustain: 0.9, release: 1.6, cutoff, env: 600, envDecay: 1.2, q: 0.7, gain, pan: (rand() - 0.5) * 0.5, rev: 0.55});
}
function bassBar(b, chord, pattern = 'drive', gain = 0.22) {
  const root = note(CHORDS[chord].root);
  if (pattern === 'long') {
    tone(B.bass, {t: barStart(b), dur: BAR * 0.95, freq: midi(root), type: 'saw', cutoff: 380, env: 500, envDecay: 0.4, q: 1.1, gain, sub: 0.8, drive: 1.5});
    return;
  }
  const steps = pattern === 'drive' ? [0, 0, 12, 0, 0, 0, 12, 0, 0, 0, 12, 0, 0, 7, 12, 10] : [0, -1, 0, -1, 12, -1, 0, -1, 0, -1, 0, -1, 12, -1, 7, -1];
  steps.forEach((st, i) => {
    if (st < 0) return;
    const t = barStart(b) + i * S16 * (pattern === 'drive' ? 1 : 1);
    tone(B.bass, {t, dur: S16 * 0.8, freq: midi(root + st), type: 'saw', attack: 0.002, decay: 0.09, sustain: 0.35, release: 0.05,
      cutoff: 320, env: 1500, envDecay: 0.07, q: 1.3, gain, sub: 0.7, drive: 1.6});
  });
}
function arpBar(b, chord, gain = 0.045, cutoff = 2200, pan = 0) {
  const notes = CHORDS[chord].arp;
  for (let i = 0; i < 16; i++) {
    tone(B.arp, {t: barStart(b) + i * S16, dur: S16 * 0.6, freq: midi(note(notes[i % notes.length])), type: 'square',
      detune: [0, 7], attack: 0.002, decay: 0.08, sustain: 0.15, release: 0.06, cutoff, env: 3000, envDecay: 0.05, q: 1.1,
      gain: gain * (i % 4 === 0 ? 1.15 : 0.9), pan: i % 2 ? 0.35 + pan : -0.35 + pan, dly: 0.45, rev: 0.15});
  }
}
function orch(t, chord = 'Dm', gain = 0.09) {
  const notes = [...CHORDS[chord].pad.slice(0, 4), CHORDS[chord].arp[0], CHORDS[chord].arp[4]];
  for (const n of notes)
    tone(B.orch, {t, dur: 0.12, freq: midi(note(n)), type: 'saw', detune: [-12, 0, 12], attack: 0.003, decay: 0.18, sustain: 0.2,
      release: 0.5, cutoff: 900, env: 5000, envDecay: 0.12, q: 0.9, gain, rev: 0.6});
  const start = Math.floor(t * SR), bp = new SVF();
  bp.set(1200, 0.8);
  for (let n = 0; n < SR * 0.25; n++) {
    bp.run(noise());
    const v = bp.band * Math.exp(-n / (SR * 0.05)) * gain * 1.6;
    write(B.orch, start + n, v, v);
    write(REV, start + n, v * 0.5, v * 0.5);
  }
}
function pluck(t, n, gain = 0.1, pan = 0) {
  tone(B.keys, {t, dur: 0.1, freq: midi(note(n)), type: 'tri', detune: [-4, 4], attack: 0.002, decay: 0.7, sustain: 0.0,
    release: 1.4, cutoff: 2600, env: 2000, envDecay: 0.15, q: 0.7, gain, pan, rev: 0.5, dly: 0.35});
  tone(B.keys, {t, dur: 0.1, freq: midi(note(n) + 12), type: 'sine', attack: 0.001, decay: 0.3, sustain: 0, release: 0.8,
    gain: gain * 0.35, pan, rev: 0.4});
}

// Lead melody: [note, beats]. Original theme, D minor.
const THEME = [
  ['D5', 1.5], ['E5', 0.5], ['F5', 1], ['A5', 1],
  ['G5', 2], ['F5', 1], ['D5', 1],
  ['Bb4', 1.5], ['C5', 0.5], ['D5', 1], ['G5', 1],
  ['E5', 2.5], ['C#5', 0.5], ['A4', 1],
  ['D5', 1.5], ['E5', 0.5], ['F5', 1], ['A5', 1],
  ['D6', 2], ['C6', 1], ['Bb5', 1],
  ['A5', 1], ['G5', 1], ['F5', 1], ['E5', 1],
  ['C#5', 1], ['E5', 1], ['D5', 2],
];
function lead(t0, {octave = 0, gain = 0.085, double = false} = {}) {
  let t = t0, prev = null;
  for (const [n, beats] of THEME) {
    const freq = midi(note(n) + 12 * octave), dur = beats * BEAT;
    const legato = prev && beats <= 1;
    tone(B.lead, {t, dur: dur * 0.94, freq, glide: legato ? prev : null, type: 'saw', detune: [-6, 6], attack: 0.03, decay: 0.4,
      sustain: 0.75, release: 0.25, cutoff: 1500, env: 2200, envDecay: 0.25, q: 0.9, gain, vib: dur > 0.6 ? 14 : 0, rev: 0.35, dly: 0.25});
    if (double) tone(B.lead, {t, dur: dur * 0.94, freq: freq * 2, type: 'square', attack: 0.04, decay: 0.3, sustain: 0.6, release: 0.2,
      cutoff: 2400, q: 0.7, gain: gain * 0.28, vib: dur > 0.6 ? 10 : 0, rev: 0.4, dly: 0.3, pan: 0.15});
    prev = freq;
    t += dur;
  }
}

// ------------------------------------------------------------------ arrangement (bars are 0-indexed; bar b starts at 2b s)
// 0-1 logo · 2-3 intro · 4-7 montage · 8-10 question · 11-13 title · 14-18 method · 19-23 oracle
// 24-26 x87 · 27-31 pairs · 32-39 footage · 40-44 pace · 45-48 numbers · 49-52 outro
// logo: drone and glass
tone(B.pad, {t: 0, dur: 4.2, freq: midi(note('D1')), type: 'saw', detune: [-5, 5], attack: 2.5, decay: 1, sustain: 1, release: 1.5, cutoff: 220, env: 180, envDecay: 3, q: 1.2, gain: 0.16, rev: 0.3});
tone(B.pad, {t: 0.3, dur: 3.8, freq: midi(note('A5')), type: 'sine', detune: [-8, 8], attack: 2, decay: 1, sustain: 1, release: 1.2, gain: 0.03, rev: 0.8});
tone(B.pad, {t: 0.9, dur: 3.2, freq: midi(note('D6')), type: 'sine', detune: [-6, 7], attack: 1.8, decay: 1, sustain: 1, release: 1.2, gain: 0.022, rev: 0.8});
for (const t of [0.1, 0.26, 0.42]) glitch(t, 0.14, 0.07);
for (let t = 0.6; t < 3.9; t += 0.07 + rand() * 0.4) if (rand() < 0.35) click(t, 0.05);
typing('DEUS EX  (2000)', 1.6, 2.2, 0.05);
typing('Unreal Engine 1 · DeusEx.exe · Direct3D · 00_Intro', 2.2, 3.0, 0.035);
riser(2.6, 4.0, 0.18);
// intro cinematic: pad and low piano on each cut
pad(2, 'Dm', 0.06, 1, 1100); pad(3, 'Bb', 0.06, 1, 1100);
[['D3', 4], ['A2', 5], ['F2', 6], ['Bb1', 7]].forEach(([n, t]) => { pluck(t, n, 0.14); boom(t, 0.35, 1.2); });
tone(B.bass, {t: 4, dur: 4, freq: midi(note('D1')), type: 'sine', attack: 0.5, sustain: 1, release: 1, gain: 0.12});
// montage: groove enters
for (let b = 4; b <= 7; b++) {
  const c = chordAt(b - 4);
  pad(b, c, 0.045, 1, 1500);
  bassBar(b, c, 'drive', 0.2);
  arpBar(b, c, 0.038, 1200 + (b - 4) * 450);
  for (let q = 0; q < 4; q++) { if (q % 2 === 0) kick(barStart(b) + q * BEAT, 0.8); hat(barStart(b) + q * BEAT + BEAT / 2, 0.09); }
  snare(barStart(b) + 3 * BEAT, 0.3);
}
crash(8, 0.22);
for (let t = 9; t <= 15; t++) whoosh(t - 0.18, 0.3, 0.12, t % 2 === 0);
// question: breakdown with pluck motif
pad(8, 'Dm', 0.055, 1, 1200); pad(9, 'Bb', 0.055, 1, 1200); pad(10, 'Gm', 0.055, 1, 1200);
[['D5', 16.0], ['A4', 16.75], ['F5', 17.5], ['E5', 18.25], ['D5', 19.0], ['A4', 19.75], ['Bb4', 20.5], ['A4', 21.25]]
  .forEach(([n, t], i) => pluck(t, n, 0.09, i % 2 ? 0.3 : -0.3));
tone(B.bass, {t: 16, dur: 6, freq: midi(note('D1')), type: 'sine', attack: 1, sustain: 1, release: 1, gain: 0.1});
typing('Deus Ex, 2000.', 16.3, 17.0, 0.07);
typing('Rebuilt in the browser,', 17.7, 18.7, 0.07);
typing('piece by piece — from its own data, UnrealScript bytecode and x86 machine code', 19.2, 20.8, 0.04);
riser(20.0, 22.0, 0.3);
// title hit
kick(22, 1.0); boom(22, 1.0, 3.2); crash(22, 0.32); orch(22, 'Dm', 0.12);
chatter(22.25, 23.3, 0.035);
for (let b = 11; b <= 13; b++) {
  const c = chordAt(b - 11);
  pad(b, c, 0.06, 1, 1900);
  bassBar(b, c, 'long', 0.2);
  arpBar(b, c, 0.04, 2400);
  kick(barStart(b), 0.85); snare(barStart(b) + 2 * BEAT, 0.42, 0.25);
  for (let q = 0; q < 8; q++) hat(barStart(b) + q * BEAT / 2 + BEAT / 4, 0.06, q === 7);
}
// main groove (method, oracle, x87, pairs, footage, pace, numbers)
function groove(b, {busy = 1, snareGain = 0.45} = {}) {
  const t = barStart(b);
  // breakbeat: kick 1, 2&, 3a(varied); snare 2 and 4
  kick(t, 0.85); kick(t + BEAT * 1.5, 0.7);
  if (b % 2) kick(t + BEAT * 2.75, 0.6); else kick(t + BEAT * 2.5, 0.65);
  snare(t + BEAT, snareGain); snare(t + BEAT * 3, snareGain);
  if (busy > 1 && b % 4 === 3) { snare(t + BEAT * 3.5, snareGain * 0.6); snare(t + BEAT * 3.75, snareGain * 0.7); }
  for (let i = 0; i < 16; i++) hat(t + i * S16, (i % 4 === 2 ? 0.1 : 0.055) * (busy > 1 ? 1.1 : 1), i === 14 && b % 2 === 1, i % 2 ? 0.3 : -0.1);
}
for (let b = 14; b <= 48; b++) {
  const c = chordAt(b - 14);
  groove(b, {busy: b >= 32 && b <= 39 ? 2 : 1, snareGain: b >= 32 && b <= 39 ? 0.5 : 0.42});
  bassBar(b, c, 'drive', 0.2);
  pad(b, c, b >= 32 && b <= 39 ? 0.05 : 0.04, 1, b >= 32 ? 2200 : 1800);
  arpBar(b, c, 0.036, b >= 40 ? 2800 : 2200);
}
// section accents
for (const t of [28, 38, 48, 54, 64, 80, 90]) { crash(t, 0.24); glitch(t, 0.16, 0.12); }
for (const t of [4, 8, 16, 98]) glitch(t, 0.16, 0.12);
lead(38, {gain: 0.08});                                   // oracle + precision: theme
for (let b = 27; b <= 31; b++) orch(barStart(b), chordAt(b - 14), 0.075);   // pairs: stabs
lead(64, {gain: 0.085, double: true});                    // footage: theme, doubled
for (const b of [32, 36]) orch(barStart(b), chordAt(b - 14), 0.08);
// method: card lines ticking, convergence
for (let i = 0; i < 11; i++) { click(29.5 + i * 0.12, 0.04); click(30.2 + i * 0.12, 0.04); click(30.9 + i * 0.12, 0.04); }
whoosh(34.6, 0.9, 0.14, false); blip(35.4, 880, 0.08, 0.3);
// oracle: meters and stamp
[39.6, 40.1, 40.6, 41.1].forEach((t, i) => blip(t, 660 + i * 110, 0.06, 0.12));
[41.6, 42.1, 42.6, 43.1].forEach((t, i) => blip(t, 1320 + i * 90, 0.05, 0.1));
boom(44.8, 0.5, 1.6); blip(45.0, 880, 0.09, 0.5); blip(45.08, 1320, 0.08, 0.6);
// precision: bits chatter
chatter(48.6, 49.6, 0.025);
for (let i = 0; i < 4; i++) click(50.0 + i * 0.35, 0.08);
// pairs: wipes
for (let i = 0; i < 4; i++) { whoosh(54 + i * 2.5 + 0.3, 0.6, 0.15, true); whoosh(54 + i * 2.5 + 2.05, 0.45, 0.12, false); }
// footage: segment cuts
for (const t of [67.5, 69.5, 72.5, 75.5, 77.5]) glitch(t, 0.1, 0.08);
// numbers: tile pops, then build
for (let i = 0; i < 6; i++) blip(90.3 + i * 0.35, 990 + i * 70, 0.07, 0.12);
for (let i = 0; i < 16; i++) snare(96 + i * S16, 0.12 + i * 0.02, 0.08);
riser(95.0, 98.0, 0.28);
// outro
kick(98, 1.0); boom(98, 0.9, 4.0); crash(98, 0.3); orch(98, 'Dm', 0.11);
pad(49, 'Dm', 0.07, 2, 1500); pad(51, 'Bb', 0.06, 1, 1300); pad(52, 'Dm', 0.06, 1.5, 1100);
tone(B.bass, {t: 98, dur: 7, freq: midi(note('D1')), type: 'sine', attack: 0.3, sustain: 1, release: 1.5, gain: 0.14});
[['D5', 99.0, 1.0], ['A4', 100.0, 0.5], ['F5', 100.5, 0.5], ['E5', 101.0, 1.0], ['D5', 102.0, 2.5]].forEach(([n, t, d]) =>
  tone(B.lead, {t, dur: d, freq: midi(note(n)), type: 'saw', detune: [-6, 6], attack: 0.05, decay: 0.5, sustain: 0.7, release: 1.2,
    cutoff: 1300, env: 1200, envDecay: 0.4, q: 0.8, gain: 0.07, vib: 12, rev: 0.6, dly: 0.35}));
for (let i = 0; i < 12; i++) pluck(99 + i * 0.25, CHORDS.Dm.arp[i % 8], 0.035, i % 2 ? 0.4 : -0.4);

// ------------------------------------------------------------------ effects
function sidechain(bus, depth, release = 0.16) {
  const env = new Float32Array(N).fill(1);
  for (const k of KICKS) {
    const s = Math.floor(k * SR);
    for (let n = 0; n < SR * release * 4 && s + n < N; n++) env[s + n] = Math.min(env[s + n], 1 - depth * Math.exp(-n / (SR * release)));
  }
  for (let i = 0; i < N; i++) { bus.L[i] *= env[i]; bus.R[i] *= env[i]; }
}
function pingpong(src, time = 0.375, feedback = 0.42, damp = 3500) {
  const d = Math.floor(time * SR), outL = new Float32Array(N), outR = new Float32Array(N);
  const lpL = new SVF(), lpR = new SVF();
  lpL.set(damp, 0.6); lpR.set(damp, 0.6);
  for (let i = 0; i < N; i++) {
    const inL = src.L[i] + src.R[i];
    const fl = i >= d ? outR[i - d] : 0, fr = i >= d ? outL[i - d] : 0;
    outL[i] = lpL.run(inL * 0.5 + fl * feedback);
    outR[i] = lpR.run(fr * feedback + (i >= d ? 0 : 0));
  }
  return {L: outL, R: outR};
}
function reverb(src, room = 0.86, damp = 0.35, wet = 1) {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116].map(n => Math.round(n * SR / 44100));
  const aps = [556, 441, 341, 225].map(n => Math.round(n * SR / 44100));
  const out = {L: new Float32Array(N), R: new Float32Array(N)};
  for (const [ch, spread] of [['L', 0], ['R', 23]]) {
    const input = src[ch], acc = new Float32Array(N);
    for (const len0 of combs) {
      const len = len0 + spread, buf = new Float32Array(len);
      let idx = 0, store = 0;
      for (let i = 0; i < N; i++) {
        const y = buf[idx];
        store = y * (1 - damp) + store * damp;
        buf[idx] = input[i] * 0.015 + store * room;
        acc[i] += y;
        if (++idx >= len) idx = 0;
      }
    }
    for (const len0 of aps) {
      const len = len0 + spread, buf = new Float32Array(len);
      let idx = 0;
      for (let i = 0; i < N; i++) {
        const b = buf[idx], x = acc[i];
        acc[i] = -x + b;
        buf[idx] = x + b * 0.5;
        if (++idx >= len) idx = 0;
      }
    }
    for (let i = 0; i < N; i++) out[ch][i] = acc[i] * wet;
  }
  return out;
}

if (process.env.MUSIC_DEBUG) {
  const win = (a, b) => [Math.floor(a * SR), Math.floor(b * SR)];
  for (const [label, [a, b]] of [['montage', win(8, 16)], ['groove', win(40, 48)], ['footage', win(66, 76)], ['outro', win(99, 104)]]) {
    const rows = Object.entries(B).map(([name, bus]) => {
      let sum = 0;
      for (let i = a; i < b; i++) sum += bus.L[i] * bus.L[i] + bus.R[i] * bus.R[i];
      return `${name} ${(10 * Math.log10(sum / (2 * (b - a)) + 1e-12)).toFixed(1)}`;
    });
    console.log(label.padEnd(8), rows.join(' | '));
  }
}
sidechain(B.pad, 0.55); sidechain(B.arp, 0.35); sidechain(B.bass, 0.45); sidechain(B.lead, 0.15); sidechain(B.keys, 0.2);
const echo = pingpong(DLY, 0.375, 0.45);
const room = reverb(REV, 0.86, 0.3, 1.0);
const mix = {L: new Float32Array(N), R: new Float32Array(N)};
const levels = {drums: 0.5, bass: 0.8, pad: 1.4, arp: 1.9, lead: 1.9, keys: 1.3, orch: 1.2, fx: 0.9};
for (const [name, bus] of Object.entries(B)) {
  const g = levels[name];
  for (let i = 0; i < N; i++) { mix.L[i] += bus.L[i] * g; mix.R[i] += bus.R[i] * g; }
}
for (let i = 0; i < N; i++) {
  mix.L[i] += echo.L[i] * 0.55 + room.L[i] * 0.9;
  mix.R[i] += echo.R[i] * 0.55 + room.R[i] * 0.9;
}
// gentle high-pass on the master to keep sub rumble in check
const hpL = new SVF(), hpR = new SVF();
hpL.set(28, 0.7); hpR.set(28, 0.7);
// Look-ahead peak limiter (2 ms window, 80 ms release) into a -1 dBFS ceiling,
// then a gentle soft clip; INPUT_GAIN sets the loudness (about -14 LUFS).
let raw = 0;
for (let i = 0; i < N; i++) {
  hpL.run(mix.L[i]); hpR.run(mix.R[i]);
  mix.L[i] = hpL.high; mix.R[i] = hpR.high;
  raw = Math.max(raw, Math.abs(mix.L[i]), Math.abs(mix.R[i]));
}
const INPUT_GAIN = Number(process.env.MUSIC_GAIN ?? 2.05) / raw;
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
const fadeIn = SR * 0.02, fadeOut = SR * 2.5;
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
console.log(`wrote ${OUT} · ${DUR}s · peak before normalize ${peak.toFixed(3)} · kicks ${KICKS.length}`);
