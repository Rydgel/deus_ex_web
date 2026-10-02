/** Compare src/runtime/script-particles.mjs updateParticles with DeusEx.dll's
 * execUpdateParticles (scripts/native-particles-oracle.py): every particle
 * field, nextFreeParticle and the proxy's bHidden after each update, over
 * gravity, rise, scale and fade owners, expiring and fresh particles. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { updateParticles } from '../src/runtime/script-particles.mjs';
import { createNativeRng } from '../src/runtime/rng.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory(), python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const view = new DataView(new ArrayBuffer(4));
const u32 = value => { view.setFloat32(0, value, true); return view.getUint32(0, true); };
const f = Math.fround;
let seed = 0x9a71;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8;
const r = (lo, hi) => f(lo + (random() % 100000) / 100000 * (hi - lo));

const cases = [];
for (let k = 0; k < 24; k++) {
  const flags = k % 8, ownerLifeSpan = r(0.5, 6), rng = createNativeRng(0x100 + k);
  const particles = Array.from({ length: 64 }, (_, i) => {
    const active = random() % 3 !== 0;
    const lifeSpan = random() % 9 === 0 ? 0 : random() % 9 === 1 ? r(-1, 0) : r(0, ownerLifeSpan);
    return { active: active ? (random() % 2 ? 1 : 0xfffffff1) : (random() % 2 ? 0 : 0xfffffff0),
      initVel: [r(-80, 80), r(-80, 80), r(-40, 120)], velocity: [r(-80, 80), r(-80, 80), r(-200, 200)],
      location: [r(-4000, 4000), r(-4000, 4000), r(-1000, 1000)], drawScale: r(0, 3), scaleGlow: r(0, 1), lifeSpan };
  });
  const times = Array.from({ length: 12 }, () => random() % 7 === 0 ? 0 : r(0.001, 0.25));
  cases.push({ flags, zoneGravity: random() % 2 ? f(-950) : r(-1500, 0), riseRate: r(0, 50), ownerLifeSpan, ownerDrawScale: r(0.05, 2),
    nextFreeParticle: random() % 64 - 1, particles, times, frand: Array.from({ length: 64 * 3 * times.length }, () => rng.frand()) });
}
const native = JSON.parse(execFileSync(python, ['scripts/native-particles-oracle.py', root], { input: JSON.stringify(cases), maxBuffer: 1 << 30 }));
let steps = 0, mismatches = 0, active = 0;
const first = [];
cases.forEach((c, i) => {
  const queue = [...c.frand];
  const state = { gravity: Boolean(c.flags & 1), scales: Boolean(c.flags & 2), fades: Boolean(c.flags & 4), zoneGravity: c.zoneGravity,
    riseRate: c.riseRate, ownerLifeSpan: c.ownerLifeSpan, ownerDrawScale: c.ownerDrawScale, nextFreeParticle: c.nextFreeParticle,
    particles: c.particles.map(p => ({ active: Boolean(p.active & 1), initVel: [...p.initVel], velocity: [...p.velocity], location: [...p.location],
      drawScale: p.drawScale, scaleGlow: p.scaleGlow, lifeSpan: p.lifeSpan })) };
  native.results[i].steps.forEach((expected, k) => {
    updateParticles(state, c.times[k], () => queue.shift());
    steps++;
    const bad = [];
    state.particles.forEach((p, j) => {
      const e = expected.particles[j];
      if (Boolean(e[0] & 1) !== p.active) bad.push(`p${j}.active`);
      const fields = [...p.initVel, ...p.velocity, ...p.location, p.drawScale, p.scaleGlow, p.lifeSpan].map(u32);
      fields.forEach((v, m) => { if (v !== e[m + 1]) bad.push(`p${j}.f${m}`); });
      if (p.active) active++;
    });
    if (state.nextFreeParticle !== expected.nextFreeParticle) bad.push('nextFreeParticle');
    if (state.proxyHidden !== Boolean(expected.proxyFlags & 2)) bad.push('proxy.bHidden');
    if (bad.length) { mismatches++; if (first.length < 5) first.push({ i, k, bad: bad.slice(0, 6) }); }
  });
  assert.equal(queue.length, native.results[i].frandLeft, `case ${i}: appFrand draws`);
});
console.log(JSON.stringify({ cases: cases.length, steps, activeParticleSteps: active, mismatches, first }));
assert.equal(mismatches, 0, 'UpdateParticles matches DeusEx.dll');
console.log(`validate-native-particles: PASS (${steps} updates, ${active} active particle updates)`);
