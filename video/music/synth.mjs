// Offline synthesizer for the video's score: the synthesized voices (pad, bell, lead, bass, pluck, low drums, effects), the
// processors (chorus, sidechain, delay, plate reverb) and the metering and mastering tools. Plain JavaScript, no dependencies,
// deterministic (one seeded generator). Every voice adds itself into a stereo bus. The sampled instruments are in sampler.mjs.
export const SR = 48000;
export const TAU = Math.PI * 2;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
export const db = x => 20 * Math.log10(Math.max(x, 1e-12));
export const undb = d => Math.pow(10, d / 20);

const PITCH = {C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11};
/** 'A4', 'F#3', 'Bb2' -> MIDI note number. */
export function n(name) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note name ${name}`);
  return 12 * (Number(m[3]) + 1) + PITCH[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

let state = 0x1234abcd;
export function seed(s) { state = s >>> 0; }
export function rnd() {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const nz = () => rnd() * 2 - 1;

export const stereo = len => ({L: new Float32Array(len), R: new Float32Array(len)});
const panGains = p => [Math.cos((clamp(p, -1, 1) + 1) * Math.PI / 4), Math.sin((clamp(p, -1, 1) + 1) * Math.PI / 4)];

// ---------------------------------------------------------------------------------------------------------- filters
/** State-variable filter, trapezoidal integration: stable while its cutoff moves. lp / bp / hp are read after run(). */
export class SVF {
  constructor(fc = 1000, q = 0.707) { this.s1 = 0; this.s2 = 0; this.lp = 0; this.bp = 0; this.hp = 0; this.set(fc, q); }
  set(fc, q) {
    const g = Math.tan(Math.PI * clamp(fc, 12, SR * 0.45) / SR);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  run(x) {
    const v3 = x - this.s2, v1 = this.a1 * this.s1 + this.a2 * v3, v2 = this.s2 + this.a2 * this.s1 + this.a3 * v3;
    this.s1 = 2 * v1 - this.s1; this.s2 = 2 * v2 - this.s2;
    this.lp = v2; this.bp = v1; this.hp = x - this.k * v1 - v2;
    return v2;
  }
}

/** Biquad from the audio EQ cookbook: 'lowshelf' | 'highshelf' | 'peak' | 'hp' | 'lp'. */
export class Biquad {
  constructor(type, f, q = 0.707, gainDb = 0) {
    const A = Math.pow(10, gainDb / 40), w = TAU * f / SR, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'peak') { b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; }
    else if (type === 'lowshelf') {
      const r = 2 * Math.sqrt(A) * al;
      b0 = A * (A + 1 - (A - 1) * cs + r); b1 = 2 * A * (A - 1 - (A + 1) * cs); b2 = A * (A + 1 - (A - 1) * cs - r);
      a0 = A + 1 + (A - 1) * cs + r; a1 = -2 * (A - 1 + (A + 1) * cs); a2 = A + 1 + (A - 1) * cs - r;
    } else if (type === 'highshelf') {
      const r = 2 * Math.sqrt(A) * al;
      b0 = A * (A + 1 + (A - 1) * cs + r); b1 = -2 * A * (A - 1 + (A + 1) * cs); b2 = A * (A + 1 + (A - 1) * cs - r);
      a0 = A + 1 - (A - 1) * cs + r; a1 = 2 * (A - 1 - (A + 1) * cs); a2 = A + 1 - (A - 1) * cs - r;
    } else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; this.z1 = 0; this.z2 = 0;
  }
  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}
/** Runs a list of [type, f, q, gainDb] biquads over a stereo buffer in place. */
export function eq(buf, bands) {
  for (const ch of [buf.L, buf.R]) {
    const chain = bands.map(b => new Biquad(...b));
    for (let i = 0; i < ch.length; i++) { let x = ch[i]; for (const f of chain) x = f.run(x); ch[i] = x; }
  }
  return buf;
}

// polyBLEP residual for a unit downward step at phase 0 (phase t in cycles, increment dt)
const blep = (t, dt) => {
  if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
  if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
  return 0;
};

// ---------------------------------------------------------------------------------------------------- pitched voices
/** Pad: a stack of detuned band-limited saws spread across the stereo field, a slow low-pass, long attack and release. */
export function pad(bus, o) {
  const {t, dur, midi, gain = 0.1, voices = 7, detune = 15, attack = 1.2, release = 2, cutoff = 1400, cutoff2 = cutoff, q = 0.6,
    lfoRate = 0.12, lfoDepth = 0.18, width = 0.9, pan = 0, sub = 0} = o;
  const f = mtof(midi), i0 = Math.round(t * SR), total = Math.round((dur + release) * SR), N = bus.L.length, K = voices;
  const inc = new Float64Array(K), ph = new Float64Array(K), gl = new Float64Array(K), gr = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    const x = K > 1 ? k / (K - 1) * 2 - 1 : 0;
    inc[k] = f * Math.pow(2, detune * (x + (rnd() - 0.5) * 0.25) / 1200) / SR;
    ph[k] = rnd();
    [gl[k], gr[k]] = panGains(pan + width * (K > 1 ? ((k * 0.61803) % 1) * 2 - 1 : 0));
  }
  const norm = gain * 1.4 / Math.sqrt(K), fl = new SVF(), fr = new SVF(), lph = rnd() * TAU, subGain = sub * Math.sqrt(K) * 0.7;
  let sph = rnd(), a = 0;
  for (let s = 0; s < total; s++) {
    const i = i0 + s; if (i >= N) break;
    const tt = s / SR;
    if ((s & 15) === 0) {
      const fc = cutoff * Math.pow(cutoff2 / cutoff, Math.min(1, tt / dur)) * (1 + lfoDepth * Math.sin(lph + TAU * lfoRate * tt));
      fl.set(fc, q); fr.set(fc * 1.03, q);
      const on = Math.min(tt, dur);
      a = on < attack ? 0.5 - 0.5 * Math.cos(Math.PI * on / attack) : 1;
      if (tt > dur) a *= 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, (tt - dur) / release));
    }
    let l = 0, r = 0;
    for (let k = 0; k < K; k++) {
      const d = inc[k];
      let p = ph[k] + d; if (p >= 1) p -= 1; ph[k] = p;
      const v = 2 * p - 1 - blep(p, d);
      l += v * gl[k]; r += v * gr[k];
    }
    if (sub) { sph += f * 0.5 / SR; if (sph >= 1) sph -= 1; const sv = Math.sin(TAU * sph) * subGain; l += sv; r += sv; }
    const yl = fl.run(l), yr = fr.run(r);
    if (i >= 0) { bus.L[i] += yl * a * norm; bus.R[i] += yr * a * norm; }
  }
}

/** Glass bell: a 1:4 FM pair struck bright and settling to almost a sine, an octave partial and a short high ping. */
export function glass(bus, o) {
  const {t, midi, vel = 0.8, gain = 0.15, pan = 0, decay = 1.8, ring = 6, bright = 1} = o;
  const f = mtof(midi), i0 = Math.round(t * SR), N = bus.L.length;
  const tau = decay * clamp(1.4 - (midi - 60) / 40, 0.5, 1.5), total = Math.round(Math.min(ring, tau * 7) * SR);
  const [pl, pr] = panGains(pan), ping = f * 7.02 < 12000 ? 0.07 : 0, det = Math.pow(2, 1.2 / 1200);
  for (let s = 0; s < total; s++) {
    const i = i0 + s; if (i >= N) break;
    const tt = s / SR, env = Math.min(1, tt / 0.002) * Math.exp(-tt / tau) * Math.min(1, (total - s) / 2400);
    const idx = bright * (0.1 + 1.25 * vel * Math.exp(-tt / 0.1)), m = idx * Math.sin(TAU * 4 * f * tt);
    const oct = Math.sin(TAU * 2 * f * tt + 0.4 * m) * 0.22 * Math.exp(-tt / (tau * 0.45));
    const hi = ping * vel * Math.sin(TAU * 7.02 * f * tt) * Math.exp(-tt / 0.05);
    const a = Math.sin(TAU * f / det * tt + m) + oct + hi, b = Math.sin(TAU * f * det * tt + m) + oct + hi, g = env * vel * gain;
    if (i >= 0) { bus.L[i] += (a * 0.8 + b * 0.2) * g * pl * 1.414; bus.R[i] += (b * 0.8 + a * 0.2) * g * pr * 1.414; }
  }
}

/** Lead: detuned saws in unison across the stereo field and a slowly width-modulated pulse through a 24 dB low-pass, delayed vibrato, optional glide. */
export function lead(bus, o) {
  const {t, dur, midi, from = null, glide = 0.045, gain = 0.15, cutoff = 2200, env = 1500, envDecay = 0.3, q = 0.8, vib = 9, vibRate = 5.3,
    vibDelay = 0.25, attack = 0.015, release = 0.14, voices = 5, detune = 11, pulse = 0.4, pan = 0, width = 0.45, vel = 1} = o;
  const i0 = Math.round(t * SR), N = bus.L.length, total = Math.round((dur + release * 6) * SR), K = voices;
  const ratio = new Float64Array(K), ph = new Float64Array(K), gl = new Float64Array(K), gr = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    const x = K > 1 ? k / (K - 1) * 2 - 1 : 0;
    ratio[k] = Math.pow(2, detune * x / 1200); ph[k] = rnd();
    [gl[k], gr[k]] = panGains(pan + width * x * (k % 2 ? 1 : -1));
  }
  const [cl, cr] = panGains(pan), norm = 1.04 / Math.sqrt(K);
  const f1 = new SVF(), f2 = new SVF(), f3 = new SVF(), f4 = new SVF();
  const vph = rnd() * TAU, start = from == null ? 0 : from - midi;
  let pp = rnd(), inc = mtof(midi) / SR, pw = 0.5;
  for (let s = 0; s < total; s++) {
    const i = i0 + s; if (i >= N) break;
    const tt = s / SR;
    const amp = (tt < attack ? tt / attack : 0.86 + 0.14 * Math.exp(-(tt - attack) / 0.4)) * (tt > dur ? Math.exp(-(tt - dur) / release) : 1);
    if (amp < 1e-5 && tt > dur) break;
    if ((s & 7) === 0) {
      const vd = tt > vibDelay ? Math.min(1, (tt - vibDelay) / 0.35) : 0;
      const semis = start * Math.exp(-tt / glide) + vib * vd * Math.sin(vph + TAU * vibRate * tt) / 100;
      inc = mtof(midi + semis) / SR;
      const fc = cutoff + env * vel * Math.exp(-tt / envDecay);
      f1.set(fc, q); f2.set(fc * 1.5, 0.6); f3.set(fc, q); f4.set(fc * 1.5, 0.6);
      pw = 0.5 + 0.32 * Math.sin(TAU * 0.31 * tt + vph);
    }
    let l = 0, r = 0;
    for (let k = 0; k < K; k++) {
      const d = inc * ratio[k];
      let p = ph[k] + d; if (p >= 1) p -= 1; ph[k] = p;
      const v = 2 * p - 1 - blep(p, d);
      l += v * gl[k]; r += v * gr[k];
    }
    pp += inc; if (pp >= 1) pp -= 1;
    let sq = pp < pw ? 1 : -1;
    sq += blep(pp, inc); sq -= blep((pp - pw + 1) % 1, inc);
    l = l * norm + sq * pulse * cl; r = r * norm + sq * pulse * cr;
    const yl = f2.run(f1.run(l)), yr = f4.run(f3.run(r)), g = amp * gain * vel;
    if (i >= 0) { bus.L[i] += yl * g; bus.R[i] += yr * g; }
  }
}

/** Bass: two detuned saws through a 24 dB low-pass with a pluck envelope and a little drive, over a clean sine. Mono. */
export function bass(bus, o) {
  const {t, dur, midi, gain = 0.3, cutoff = 180, env = 900, envDecay = 0.11, q = 1.0, sub = 0.9, saw = 1, attack = 0.004, release = 0.06,
    sustain = 0.75, drive = 1.2, vel = 1} = o;
  const f = mtof(midi), i0 = Math.round(t * SR), N = bus.L.length, total = Math.round((dur + release * 6) * SR);
  const da = f * Math.pow(2, -6 / 1200) / SR, dbb = f * Math.pow(2, 6 / 1200) / SR, f1 = new SVF(), f2 = new SVF();
  let pa = rnd(), pb = rnd(), ps = 0;
  for (let s = 0; s < total; s++) {
    const i = i0 + s; if (i >= N) break;
    const tt = s / SR;
    const amp = (tt < attack ? tt / attack : sustain + (1 - sustain) * Math.exp(-(tt - attack) / 0.18)) * (tt > dur ? Math.exp(-(tt - dur) / release) : 1);
    if (amp < 1e-5 && tt > dur) break;
    if ((s & 7) === 0) { const fc = cutoff + env * vel * Math.exp(-tt / envDecay); f1.set(fc, q); f2.set(fc, 0.6); }
    pa += da; if (pa >= 1) pa -= 1; pb += dbb; if (pb >= 1) pb -= 1; ps += f / SR;
    const x = (2 * pa - 1 - blep(pa, da) + 2 * pb - 1 - blep(pb, dbb)) * 0.5 * saw;
    const v = (Math.tanh(f2.run(f1.run(x)) * drive) / drive + Math.sin(TAU * ps) * sub) * amp * gain * vel;
    if (i >= 0) { bus.L[i] += v; bus.R[i] += v; }
  }
}

/** Pluck (the arpeggio voice): saw and square a few cents apart, a low-pass that snaps shut, a short amplitude decay. */
export function pluck(bus, o) {
  const {t, dur = 0.12, midi, gain = 0.1, pan = 0, cutoff = 500, env = 3000, envDecay = 0.07, q = 1.2, decay = 0.16, vel = 1, square = 0.5} = o;
  const f = mtof(midi), i0 = Math.round(t * SR), N = bus.L.length, total = Math.round((dur + 0.4) * SR);
  const da = f / SR, dq = f * Math.pow(2, 7 / 1200) / SR, flt = new SVF(), [pl, pr] = panGains(pan);
  let pa = rnd(), pq = rnd();
  for (let s = 0; s < total; s++) {
    const i = i0 + s; if (i >= N) break;
    const tt = s / SR;
    const amp = Math.min(1, tt / 0.002) * Math.exp(-tt / decay) * (tt > dur ? Math.exp(-(tt - dur) / 0.05) : 1);
    if (amp < 1e-5 && tt > 0.01) break;
    if ((s & 7) === 0) flt.set(cutoff + env * vel * Math.exp(-tt / envDecay), q);
    pa += da; if (pa >= 1) pa -= 1; pq += dq; if (pq >= 1) pq -= 1;
    let sq = pq < 0.5 ? 1 : -1;
    sq += blep(pq, dq); sq -= blep((pq + 0.5) % 1, dq);
    const v = flt.run((2 * pa - 1 - blep(pa, da)) * (1 - square) + sq * square) * amp * gain * vel;
    if (i >= 0) { bus.L[i] += v * pl * 1.414; bus.R[i] += v * pr * 1.414; }
  }
}

// ------------------------------------------------------------------------------------- synthesized drums (the layer under the sampled kit)
export function kick(bus, {t, gain = 1, tune = 48, punch = 1, decay = 0.24, click = 0.5}) {
  const i0 = Math.round(t * SR), N = bus.L.length, total = Math.round(0.6 * SR);
  let ph = 0;
  for (let s = 0; s < total; s++) {
    const i = i0 + s; if (i >= N) break;
    const tt = s / SR;
    ph += (tune + 115 * punch * Math.exp(-tt / 0.022) + 38 * Math.exp(-tt / 0.09)) / SR;
    const v = Math.tanh(Math.sin(TAU * ph) * Math.exp(-tt / decay) * 1.5 + nz() * click * 0.4 * Math.exp(-tt / 0.003)) * gain * Math.min(1, (total - s) / 480);
    if (i >= 0) { bus.L[i] += v; bus.R[i] += v; }
  }
}
export function snare(bus, {t, gain = 1, tone = 185, noiseDecay = 0.15, bodyDecay = 0.09, bright = 1, pan = 0}) {
  const i0 = Math.round(t * SR), N = bus.L.length, total = Math.round(0.7 * SR), bp = new SVF(2000, 0.8), hp = new SVF(5200, 0.7), [pl, pr] = panGains(pan);
  let p1 = 0, p2 = 0;
  for (let s = 0; s < total; s++) {
    const i = i0 + s; if (i >= N) break;
    const tt = s / SR, x = nz();
    bp.run(x); hp.run(x);
    p1 += tone * (1 + 0.5 * Math.exp(-tt / 0.012)) / SR; p2 += tone * 1.78 * (1 + 0.3 * Math.exp(-tt / 0.01)) / SR;
    const body = Math.sin(TAU * p1) * Math.exp(-tt / bodyDecay) + 0.5 * Math.sin(TAU * p2) * Math.exp(-tt / (bodyDecay * 0.6));
    const wires = (bp.bp * 0.9 + hp.hp * 0.6 * bright) * (Math.exp(-tt / noiseDecay) + 0.08 * Math.exp(-tt / 0.32));
    const v = Math.tanh((body * 0.9 + wires * 0.9) * 1.3) * gain;
    if (i >= 0) { bus.L[i] += v * pl * 1.414; bus.R[i] += v * pr * 1.414; }
  }
}
// ---------------------------------------------------------------------------------------------- noise and tone effects
/** Band-passed noise sweeping from f0 to f1 and growing: the lift into a section. */
export function riser(bus, {t0, t1, gain = 0.2, f0 = 300, f1 = 8000, q = 1.6}) {
  const i0 = Math.round(t0 * SR), len = Math.round((t1 - t0) * SR), N = bus.L.length, bl = new SVF(f0, q), br = new SVF(f0, q);
  for (let s = 0; s < len; s++) {
    const i = i0 + s; if (i >= N) break;
    const p = s / len;
    if ((s & 15) === 0) { const fc = f0 * Math.pow(f1 / f0, p * p); bl.set(fc, q); br.set(fc * 1.07, q); }
    bl.run(nz()); br.run(nz());
    const e = p * p * Math.min(1, (len - s) / 240) * gain;
    if (i >= 0) { bus.L[i] += bl.bp * e; bus.R[i] += br.bp * e; }
  }
}
/** Low boom: a sine falling into the sub range with a soft thud on top. */
export function boom(bus, {t, gain = 0.7, length = 2.5, from = 95, to = 36}) {
  const i0 = Math.round(t * SR), N = bus.L.length, total = Math.round(length * SR), lp = new SVF(500, 0.7);
  let ph = 0;
  for (let s = 0; s < total; s++) {
    const i = i0 + s; if (i >= N) break;
    const tt = s / SR;
    ph += (to + (from - to) * Math.exp(-tt / 0.22)) / SR;
    const v = Math.tanh((Math.sin(TAU * ph) * Math.exp(-tt / (length / 3.2)) + lp.run(nz()) * 0.9 * Math.exp(-tt / 0.09)) * 1.2) * gain * Math.min(1, (total - s) / 4800);
    if (i >= 0) { bus.L[i] += v; bus.R[i] += v; }
  }
}
/** A short sine blip (the cursor, the data ticks). */
export function blip(bus, {t, freq = 1320, gain = 0.1, dur = 0.07, pan = 0}) {
  const i0 = Math.round(t * SR), N = bus.L.length, total = Math.round(dur * 4 * SR), [pl, pr] = panGains(pan);
  for (let s = 0; s < total; s++) {
    const i = i0 + s; if (i >= N) break;
    const tt = s / SR, v = Math.sin(TAU * freq * tt) * Math.min(1, tt / 0.002) * Math.exp(-tt / (dur / 2.5)) * gain;
    if (i >= 0) { bus.L[i] += v * pl * 1.414; bus.R[i] += v * pr * 1.414; }
  }
}
/** A held sine (the drone under the quiet scenes). */
export function sine(bus, {t, dur, midi, gain = 0.2, attack = 1, release = 1.5}) {
  const f = mtof(midi), i0 = Math.round(t * SR), N = bus.L.length, total = Math.round((dur + release) * SR);
  for (let s = 0; s < total; s++) {
    const i = i0 + s; if (i >= N) break;
    const tt = s / SR, on = Math.min(tt, dur);
    let a = on < attack ? 0.5 - 0.5 * Math.cos(Math.PI * on / attack) : 1;
    if (tt > dur) a *= 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, (tt - dur) / release));
    const v = (Math.sin(TAU * f * tt) + 0.12 * Math.sin(TAU * 2 * f * tt)) * a * gain;
    if (i >= 0) { bus.L[i] += v; bus.R[i] += v; }
  }
}

// ------------------------------------------------------------------------------------------------------- processors
/** Chorus in place: modulated delay taps per channel, the right channel's sweeps a quarter cycle behind the left's. */
export function chorus(buf, {rate = 0.42, depth = 0.0032, base = 0.014, mix = 0.5, taps = 2} = {}) {
  const size = Math.ceil((base + depth * 2 + 0.01) * SR);
  [buf.L, buf.R].forEach((ch, c) => {
    const line = new Float32Array(size);
    let w = 0;
    for (let i = 0; i < ch.length; i++) {
      line[w] = ch[i];
      let wet = 0;
      for (let k = 0; k < taps; k++) {
        const d = (base * (1 + 0.37 * k) + depth * Math.sin(TAU * (rate * (1 + 0.23 * k) * i / SR + c * 0.25 + k * 0.4))) * SR;
        const rp = w - d, fl = Math.floor(rp), fr = rp - fl, a = ((fl % size) + size) % size;
        wet += line[a] * (1 - fr) + line[(a + 1) % size] * fr;
      }
      ch[i] = ch[i] * (1 - mix * 0.4) + wet * mix / taps;
      if (++w >= size) w = 0;
    }
  });
  return buf;
}

/** Sidechain: dips a buffer under each hit time, with a short hold and an exponential recovery. */
export function duck(buf, times, {depth = 0.4, hold = 0.03, release = 0.16} = {}) {
  const N = buf.L.length, g = new Float32Array(N).fill(1), ramp = Math.round(0.004 * SR), span = Math.round((hold + release * 5) * SR);
  for (const t of times) {
    const i0 = Math.round(t * SR) - ramp;
    for (let s = 0; s < span; s++) {
      const i = i0 + s; if (i < 0) continue; if (i >= N) break;
      const tt = (s - ramp) / SR, d = s < ramp ? s / ramp : tt < hold ? 1 : Math.exp(-(tt - hold) / release), v = 1 - depth * d;
      if (v < g[i]) g[i] = v;
    }
  }
  for (let i = 0; i < N; i++) { buf.L[i] *= g[i]; buf.R[i] *= g[i]; }
  return buf;
}

/** Ping-pong delay (wet only): the input lands left, then right, each repeat darker and thinner. */
export function pingPong(src, {time, feedback = 0.45, lp = 3800, hp = 280} = {}) {
  const N = src.L.length, d = Math.max(1, Math.round(time * SR)), out = stereo(N), bl = new Float32Array(d), br = new Float32Array(d);
  const k = Math.sqrt(feedback), al = 1 - Math.exp(-TAU * lp / SR), ah = 1 - Math.exp(-TAU * hp / SR);
  let w = 0, l1 = 0, l2 = 0, h1 = 0, h2 = 0;
  for (let i = 0; i < N; i++) {
    const yl = bl[w], yr = br[w];
    out.L[i] = yl; out.R[i] = yr;
    let a = (src.L[i] + src.R[i]) * 0.5 + yr * k, b = yl * k;
    l1 += al * (a - l1); h1 += ah * (l1 - h1); a = l1 - h1;
    l2 += al * (b - l2); h2 += ah * (l2 - h2); b = l2 - h2;
    bl[w] = a; br[w] = b;
    if (++w >= d) w = 0;
  }
  return out;
}

/**
 * Plate reverb (wet only) after Dattorro's 1997 figure-of-eight tank: input diffusion, two cross-fed halves each with a
 * modulated all-pass, a delay, damping, a second all-pass and a delay; the outputs are sums of taps across both halves.
 * `size` stretches every tank length; `decay` (0..1) sets the tail, `damping` (0..1) how fast its highs die.
 */
export function plate(src, {decay = 0.7, damping = 0.45, bandwidth = 0.85, predelay = 0.02, size = 1, excursion = 1} = {}) {
  const N = src.L.length, out = stereo(N), k = SR / 29761, ks = k * size, L = x => Math.max(4, Math.round(x * ks));
  const line = len => ({b: new Float32Array(len), n: len, w: 0});
  const rd = d => d.b[d.w];                                                    // oldest sample: a delay of d.n
  const wr = (d, x) => { d.b[d.w] = x; if (++d.w >= d.n) d.w = 0; };
  const tap = (d, off) => { let i = d.w - 1 - Math.min(d.n - 1, Math.round(off * ks)); if (i < 0) i += d.n; return d.b[i]; };
  const pre = line(Math.max(1, Math.round(predelay * SR)));
  const diff = [[142, 0.75], [107, 0.75], [379, 0.625], [277, 0.625]].map(([len, g]) => ({d: line(Math.max(4, Math.round(len * k))), g}));
  const exc = 16 * ks * excursion, modLine = len => ({b: new Float32Array(L(len) + Math.ceil(exc) + 4), base: L(len), w: 0});
  const modRead = (m, lfo) => {
    const n = m.b.length, rp = m.w - (m.base + exc * lfo), fl = Math.floor(rp), fr = rp - fl, a = ((fl % n) + n) % n;
    return m.b[a] * (1 - fr) + m.b[(a + 1) % n] * fr;
  };
  const modWrite = (m, x) => { m.b[m.w] = x; if (++m.w >= m.b.length) m.w = 0; };
  const mA = modLine(672), dA1 = line(L(4453)), aA = line(L(1800)), dA2 = line(L(3720));
  const mB = modLine(908), dB1 = line(L(4217)), aB = line(L(2656)), dB2 = line(L(3163));
  const bw = bandwidth, damp = 1 - damping, g2 = clamp(decay + 0.15, 0.25, 0.5);
  let lpIn = 0, lpA = 0, lpB = 0;
  for (let i = 0; i < N; i++) {
    let x = rd(pre); wr(pre, (src.L[i] + src.R[i]) * 0.5);
    lpIn += bw * (x - lpIn); x = lpIn;
    for (const {d, g} of diff) { const y = rd(d), v = x - g * y; wr(d, v); x = y + g * v; }
    const fbA = rd(dB2), fbB = rd(dA2), ph = TAU * i / SR;
    // half A
    let a = x + decay * fbA;
    let y = modRead(mA, Math.sin(ph * 0.71)), v = a + 0.7 * y; modWrite(mA, v); a = y - 0.7 * v;
    y = rd(dA1); wr(dA1, a);
    lpA += damp * (y - lpA); a = lpA * decay;
    y = rd(aA); v = a - g2 * y; wr(aA, v); a = y + g2 * v;
    wr(dA2, a);
    // half B
    let b = x + decay * fbB;
    y = modRead(mB, Math.sin(ph * 0.53 + 1.3)); v = b + 0.7 * y; modWrite(mB, v); b = y - 0.7 * v;
    y = rd(dB1); wr(dB1, b);
    lpB += damp * (y - lpB); b = lpB * decay;
    y = rd(aB); v = b - g2 * y; wr(aB, v); b = y + g2 * v;
    wr(dB2, b);
    out.L[i] = 0.6 * (tap(dB1, 266) + tap(dB1, 2974) - tap(aB, 1913) + tap(dB2, 1996) - tap(dA1, 1990) - tap(aA, 187) - tap(dA2, 1066));
    out.R[i] = 0.6 * (tap(dA1, 353) + tap(dA1, 3627) - tap(aA, 1228) + tap(dA2, 2673) - tap(dB1, 2111) - tap(aB, 335) - tap(dB2, 121));
  }
  return out;
}
/** The plate's steady-state gain for broadband input (output RMS / input RMS), so sends can be given as wet/dry ratios. */
export function plateGain(opts) {
  const len = SR * 8, src = stereo(len), saved = state;
  seed(99);
  for (let i = 0; i < len; i++) { const x = nz() * 0.1; src.L[i] = x; src.R[i] = x; }
  state = saved;
  const out = plate(src, opts);
  let a = 0, b = 0;
  for (let i = len - SR * 2; i < len; i++) { a += src.L[i] ** 2; b += (out.L[i] ** 2 + out.R[i] ** 2) / 2; }
  return Math.sqrt(b / a);
}

// --------------------------------------------------------------------------------------------------------- metering
export function peakOf(buf, i0 = 0, i1 = buf.L.length) {
  let p = 0;
  for (let i = i0; i < i1; i++) { const a = Math.abs(buf.L[i]), b = Math.abs(buf.R[i]); if (a > p) p = a; if (b > p) p = b; }
  return p;
}
/** Integrated loudness (ITU-R BS.1770: K-weighting, 400 ms blocks, absolute and relative gates) of a stereo range, LUFS. */
export function lufs(buf, i0 = 0, i1 = buf.L.length) {
  const block = Math.round(0.4 * SR), hop = block / 4, sums = [];
  const acc = new Float64Array(Math.max(1, Math.ceil((i1 - i0) / hop)));
  for (const ch of [buf.L, buf.R]) {
    let a1 = 0, a2 = 0, b1 = 0, b2 = 0;
    for (let i = i0; i < i1; i++) {
      const x = ch[i];
      const y = 1.53512485958697 * x + a1; a1 = -2.69169618940638 * x + 1.69065929318241 * y + a2; a2 = 1.19839281085285 * x - 0.73248077421585 * y;
      const z = y + b1; b1 = -2 * y + 1.99004745483398 * z + b2; b2 = y - 0.99007225036621 * z;
      acc[Math.floor((i - i0) / hop)] += z * z;
    }
  }
  for (let k = 0; k + 3 < acc.length; k++) sums.push((acc[k] + acc[k + 1] + acc[k + 2] + acc[k + 3]) / block);
  if (!sums.length) return -Infinity;
  const L = p => -0.691 + 10 * Math.log10(p + 1e-20), mean = list => list.reduce((a, b) => a + b, 0) / list.length;
  const abs = sums.filter(p => L(p) > -70);
  if (!abs.length) return -Infinity;
  const gate = L(mean(abs)) - 10, rel = abs.filter(p => L(p) > gate);
  return L(mean(rel.length ? rel : abs));
}
/** Energy per octave band (dB, relative), to check the tonal balance without ears. */
export function octaveBands(buf, i0 = 0, i1 = buf.L.length) {
  const centres = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000], out = {};
  for (const fc of centres) {
    const f = new SVF(fc, 1.414);
    let sum = 0;
    for (let i = i0; i < i1; i += 1) { f.run((buf.L[i] + buf.R[i]) * 0.5); sum += f.bp * f.bp * f.k * f.k; }
    out[fc] = 10 * Math.log10(sum / (i1 - i0) + 1e-20);
  }
  return out;
}

// -------------------------------------------------------------------------------------------------------- mastering
/** Look-ahead peak limiter in place: the gain reaches each peak's requirement exactly when the peak arrives. */
export function limit(buf, {ceiling = 0.87, lookahead = 0.005, release = 0.12} = {}) {
  const N = buf.L.length, look = Math.round(lookahead * SR), need = new Float32Array(N), rel = 1 - Math.exp(-1 / (release * SR));
  for (let i = 0; i < N; i++) need[i] = Math.min(1, ceiling / Math.max(1e-9, Math.abs(buf.L[i]), Math.abs(buf.R[i])));
  // minimum of the requirement over the next `look` samples, recovering slowly afterwards
  const ahead = new Float32Array(N), dq = new Int32Array(N);
  let head = 0, tail = 0;
  for (let i = N - 1; i >= 0; i--) {
    while (tail > head && need[dq[tail - 1]] >= need[i]) tail--;
    dq[tail++] = i;
    while (dq[head] > i + look) head++;
    ahead[i] = need[dq[head]];
  }
  let g = 1, worst = 1, run = 0;
  const hist = new Float32Array(look).fill(1);
  let hw = 0, sum = look;
  for (let i = 0; i < N; i++) {
    g = Math.min(ahead[i], g + (1 - g) * rel);
    sum += g - hist[hw]; hist[hw] = g; if (++hw >= look) hw = 0;
    if (++run >= 1 << 20) { run = 0; sum = 0; for (let k = 0; k < look; k++) sum += hist[k]; }   // keep the running sum exact
    const s = Math.min(sum / look, need[i]);
    if (s < worst) worst = s;
    buf.L[i] *= s; buf.R[i] *= s;
  }
  return -db(worst);
}

/** 24-bit PCM WAV bytes of a stereo buffer. */
export function wav24(buf, len = buf.L.length) {
  const out = Buffer.alloc(44 + len * 6);
  out.write('RIFF', 0); out.writeUInt32LE(36 + len * 6, 4); out.write('WAVE', 8); out.write('fmt ', 12); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22); out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 6, 28); out.writeUInt16LE(6, 32);
  out.writeUInt16LE(24, 34); out.write('data', 36); out.writeUInt32LE(len * 6, 40);
  for (let i = 0; i < len; i++) {
    out.writeIntLE(Math.round(clamp(buf.L[i], -1, 1) * 8388607), 44 + i * 6, 3);
    out.writeIntLE(Math.round(clamp(buf.R[i], -1, 1) * 8388607), 47 + i * 6, 3);
  }
  return out;
}
