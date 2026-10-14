/** Compare the light animation in src/runtime/static-lighting.mjs with the
 * original Render.dll (scripts/native-dynamic-light-oracle.py): the per-frame
 * light noise (0x10b13080) over irregular, repeated, backward and jumping
 * times; GlobalLighting's LightType functions (0x10b05e90) per frame; and the
 * merge's TorchWaver/FireWaver/WateryShimmer modulation (0x10b03040), at
 * the render pass's control word 0x007f (docs/render-pass-precision.md).
 * docs/static-lighting.md "Light animation" records the scope. */
import { execFileSync } from 'node:child_process';
import { auditAssert, auditControlWord } from './precision-audit.mjs';
import { createLightNoise, lightTypeBrightness, mergeModulation, createLightFrame, mergeFactor } from '../src/runtime/static-lighting.mjs';
import { fistp } from '../src/runtime/dynamic-lighting.mjs';
import { colorTableEntry } from '../src/runtime/dynamic-lighting.mjs';
import { createNativeRng } from '../src/runtime/rng.mjs';
import { rotationSineTable } from '../src/runtime/coords.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory(), python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
// ORACLE_CW=0x007f: the render-pass precision audit (precision-audit.mjs).
const assert = auditAssert(), controlWord = auditControlWord();
const runOracle = cases => JSON.parse(execFileSync(python, ['scripts/native-dynamic-light-oracle.py', root, ...(controlWord ? [controlWord] : [])],
  { input: JSON.stringify(cases), maxBuffer: 1 << 30 }));
const view = new DataView(new ArrayBuffer(4));
const u32 = value => { view.setFloat32(0, value, true); return view.getUint32(0, true); };
let seed = 0x1a77;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8;
const f = Math.fround;

// Noise: a frame clock with ordinary steps, repeats, a backward step and jumps.
const times = [];
let t = 0.004;
for (let k = 0; k < 80; k++) {
  const r = random() % 20;
  t = r === 0 ? t : r === 1 ? t - 0.05 : r === 2 ? t + 0.6 : r === 3 ? t + 0.457 : t + (1 + random() % 40) / 1000;
  times.push(f(Math.max(0, t)));
}
// A late clock (an hour of play): the 24-bit products TimeSeconds·35 and
// TimeSeconds·2293760 lose their low bits there.
const late = [];
for (let k = 0, t2 = 1800 + (random() % 1000) / 7; k < 80; k++) { t2 += (1 + random() % 40) / 1000; late.push(f(t2)); }
const noiseCases = [[0, times], [7, times], [-3, times], [51000, late]].map(([last, list]) => {
  const rng = createNativeRng(0x5eed + last), frand = Array.from({ length: 512 * list.length }, () => rng.frand());
  return { last, times: list, frand };
});
// Light types 0-7 (8, 9 are not translated), several periods/phases, per frame.
const typeCases = [];
for (const type of [0, 1, 2, 3, 4, 5, 6, 7]) for (let k = 0; k < 8; k++) {
  const light = { type, brightness: random() & 255, period: k % 4 === 0 ? 0 : random() & 255, phase: random() & 255 };
  const frames = (k < 4 ? times : late).slice(0, 40).map(time => ({ time, A: Array.from({ length: 256 }, () => u32(f((random() % 1000) / 999))),
    brightness: u32(f((light.brightness & 255) * f(1 / 255))) }));
  typeCases.push({ light, frames, strobe: [u32(0), 0], animate: k % 4 === 3 ? 0 : 1 });
}
// Merge modulation: effects 1-3, random rectangles, spatial bytes and tables.
const mergeCases = [];
for (const effect of [1, 2, 3]) for (let k = 0; k < 6; k++) {
  const width = 1 + random() % 40, height = 1 + random() % 20;
  const minU = random() % width, maxU = minU + 1 + random() % (width - minU), minV = random() % height, maxV = minV + 1 + random() % (height - minV);
  const steps = [0, 1, 2].map(() => random() % 200000);
  const table = Array.from({ length: 256 }, (_, i) => (colorTableEntry(steps[2], i) | colorTableEntry(steps[1], i) << 8 | colorTableEntry(steps[0], i) << 16 | 0xff000000) >>> 0);
  mergeCases.push({ effect, clamp: [width, height], rect: [minU, maxU, minV, maxV], index: random() & 0xffff,
    spatial: Array.from({ length: width * height }, () => random() & 255), table,
    static: Array.from({ length: width * height }, () => ((random() & 0x7f) | (random() & 0x7f) << 8 | (random() & 0x7f) << 16 | 0x7f000000) >>> 0),
    A: Array.from({ length: 256 }, () => u32(f((random() % 1000) / 999))), W: Array.from({ length: 256 }, () => u32(f((random() % 1000) / 999))) });
}

const native = runOracle({ sines: [...rotationSineTable()].map(u32), noise: noiseCases, lightTypes: typeCases, mergeMods: mergeCases });
const report = { noiseSteps: 0, noiseMismatch: 0, typeFrames: 0, typeMismatch: 0, mergeTexels: 0, mergeMismatch: 0, first: [] };

noiseCases.forEach((c, i) => {
  const values = [...c.frand], noise = createLightNoise(() => values.shift());
  noise.last = c.last;
  native.noise[i].steps.forEach((expected, step) => {
    noise.update(c.times[step]); report.noiseSteps++;
    const bad = ['A', 'W', 'S'].filter(key => expected[key].some((v, k) => v !== u32(noise[key][k])));
    if (expected.last !== noise.last) bad.push('last');
    if (bad.length) { report.noiseMismatch++; if (report.first.length < 5) report.first.push({ noise: i, step, bad }); }
  });
});
typeCases.forEach((c, i) => {
  const strobe = { time: 0, flag: 0 }, key = native.lightTypes[i].flickerKey;
  const values = { LightType: c.light.type, LightBrightness: c.light.brightness, LightPeriod: c.light.period, LightPhase: c.light.phase };
  c.frames.forEach((frame, k) => {
    const A = Float32Array.from(frame.A, bits => { view.setUint32(0, bits, true); return view.getFloat32(0, true); });
    const brightness = lightTypeBrightness(values, { timeSeconds: frame.time, noise: { A }, strobe, flickerKey: key, animate: Boolean(c.animate) });
    report.typeFrames++;
    if (u32(brightness) !== native.lightTypes[i].frames[k].brightness) {
      report.typeMismatch++; if (report.first.length < 5) report.first.push({ type: c.light.type, frame: k, js: brightness, bits: native.lightTypes[i].frames[k].brightness });
    }
  });
});
mergeCases.forEach((c, i) => {
  const fl = bits => { view.setUint32(0, bits, true); return view.getFloat32(0, true); };
  const noise = { A: Float32Array.from(c.A, fl), W: Float32Array.from(c.W, fl) }, modulate = mergeModulation(c.effect, noise);
  const [width] = c.clamp, [minU, maxU, minV, maxV] = c.rect;
  let index = c.index;
  const merged = [...c.static];
  for (let v = minV; v < maxV; v++) for (let u = minU; u < maxU; u++) {
    const p = v * width + u, byte = modulate(c.spatial[p], index++), entry = c.table[byte];
    let out = c.static[p] & 0xff000000;
    for (let ch = 0; ch < 3; ch++) out |= Math.min(127, ((c.static[p] >>> (ch * 8)) & 255) + ((entry >>> (ch * 8)) & 255)) << (ch * 8);
    merged[p] = out >>> 0;
  }
  native.mergeMods[i].merged.forEach((v, p) => { report.mergeTexels++; if (((v ^ merged[p]) & 0xffffff) !== 0) report.mergeMismatch++; });
});
// Play's per-frame merge factors (createLightFrame, doubles) against the
// x87-model modulation for every noise entry and spatial byte, on 16
// frames of real noise and 16 of random tables.
report.factorPairs = 0; report.factorMismatch = 0;
const frame = createLightFrame(createNativeRng(0xfac7).frand);
for (let k = 0; k < 32; k++) {
  frame.advance(k < 16 ? k * 0.0137 : 100 + k);
  if (k >= 16) for (let i = 0; i < 256; i++) { frame.noise.A[i] = f((random() % 100000) / 99999); frame.noise.W[i] = f((random() % 100000) / 99999); }
  for (let i = 0; i < 256; i++) {
    frame.factors[1][i] = mergeFactor(frame.noise.A[i], 0.05, 0.95); frame.factors[2][i] = mergeFactor(frame.noise.A[i], 0.2, 0.8);
    frame.factors[3][i] = mergeFactor(frame.noise.W[i], 0.4, 0.6);
  }
  for (const effect of [1, 2, 3]) {
    const exact = mergeModulation(effect, frame.noise);
    for (let i = 0; i < 256; i++) for (let spatial = 0; spatial < 256; spatial++) {
      report.factorPairs++;
      if ((fistp(f(frame.factors[effect][i] * spatial) - 0.5) & 255) !== exact(spatial, i)) report.factorMismatch++;
    }
  }
}
// Galaxy's Update calls the same GlobalLighting before PreRender, on the
// game thread (its 64-bit word, the assumption): the type functions with
// `precision: 'pc64'` against the original at 0x037f, on the same cases
// with an input brightness (Galaxy passes its volume).
report.gameThreadFrames = 0; report.gameThreadMismatch = 0;
// GAME_THREAD_CW=0x027f counts the mismatches against the word the game thread has until URender::PostRender's first reset (measured in
// the running original, docs/render-pass-precision.md "Measured in the running original"): the first Draw's Galaxy Update runs there.
const gameThreadWord = process.env.GAME_THREAD_CW ?? '0x037f';
if (!controlWord) {
  const gameThreadCases = typeCases.map(c => ({ ...c, frames: c.frames.map(frame => ({ ...frame, brightness: u32(f((random() % 1000) / 999)) })) }));
  const gameThread = JSON.parse(execFileSync(python, ['scripts/native-dynamic-light-oracle.py', root, gameThreadWord],
    { input: JSON.stringify({ sines: [...rotationSineTable()].map(u32), lightTypes: gameThreadCases }), encoding: 'utf8', maxBuffer: 1 << 28 }));
  gameThreadCases.forEach((c, i) => {
    const strobe = { time: 0, flag: 0 }, key = gameThread.lightTypes[i].flickerKey;
    const values = { LightType: c.light.type, LightBrightness: c.light.brightness, LightPeriod: c.light.period, LightPhase: c.light.phase };
    c.frames.forEach((frame, k) => {
      const A = Float32Array.from(frame.A, bits => { view.setUint32(0, bits, true); return view.getFloat32(0, true); });
      view.setUint32(0, frame.brightness, true);
      const brightness = lightTypeBrightness(values, { timeSeconds: frame.time, noise: { A }, strobe, flickerKey: key,
        animate: Boolean(c.animate), brightness: view.getFloat32(0, true), precision: 'pc64' });
      report.gameThreadFrames++;
      if (u32(brightness) !== gameThread.lightTypes[i].frames[k].brightness) report.gameThreadMismatch++;
    });
  });
}
console.log(JSON.stringify({ ...report, gameThreadWord }));
if (gameThreadWord === '0x037f') assert.equal(report.gameThreadMismatch, 0, 'the game thread\'s LightType brightness matches at 0x037f');
assert.equal(report.factorMismatch, 0, 'the 24-bit merge factors give the x87 modulation bytes');
assert.equal(report.noiseMismatch, 0, 'light noise tables match');
assert.equal(report.typeMismatch, 0, 'LightType brightness matches');
assert.equal(report.mergeMismatch, 0, 'merge modulation matches');
if (assert.enabled) assert.report('validate-light-animation');
else console.log(`validate-light-animation: PASS (${report.noiseSteps} noise frames, ${report.typeFrames} LightType frames, ${report.mergeTexels} merged texels)`);
