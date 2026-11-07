// The fog kernel's block loop (fog.rs walk_blocks: four texels at a time on wasm simd128, the light-independent terms made once per surface,
// whole rows in bands for a surface larger than its scratch) against the reference loop (walk, one texel at a time per light) and, on the
// smaller cases, against the Ext model rounded to 24 bits (`Exact`, the precision-control-24 reference): the same bytes and the same final
// early-out flag on random surfaces of every shape the block loop has a branch for.
//
//   node scripts/validate-fog-blocks.mjs [--cases N] [--seed S]
//
// The cases: surface sizes from 1x1 to 100x200 (more than 8192 texels: several bands), 8192 wide (one row a band), 8193 wide (declined to
// the reference loop), 1 wide and 9000 tall; lattices of ordinary camera-space scale, with zero steps, positions that are exactly zero or
// near binary32's smallest normal (the products at or below it that rerun a texel on `Wide`), beyond the 2^30 bound `Single` holds (run on
// `Wide`), and non-finite (run on `Exact`); one to eight lights behind, in front, inside or far from the lattice, with radii from a few
// units to thousands; either incoming flag; a first table whose entry 0 is zero (the block loop's condition) or not (declined).
// Inputs are real-camera-scale where they can be so that a good share of texels are hits, not misses.
import assert from 'node:assert/strict';
import {loadScriptVmKernel} from '../src/runtime/script-vm-kernel.mjs';
import {squareRootTable} from '../src/runtime/dynamic-lighting.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : Number(process.argv[i + 1]); };
const CASES = option('cases', 1500);
let seed = option('seed', 0x2f06) >>> 0;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const between = (a, b) => a + (b - a) * random();
const pick = list => list[Math.floor(random() * list.length)];
const io = new DataView(new ArrayBuffer(4));
const bitsOf = v => (io.setFloat32(0, v, true), io.getUint32(0, true));

const kernel = await loadScriptVmKernel(), fog = kernel.fog;
if (!fog.verify) throw new Error('this kernel has no block loop');
fog.sqrt(squareRootTable());

function sizes() {
  const kind = random();
  if (kind < 0.35) return [1 + Math.floor(random() * 40), 1 + Math.floor(random() * 40)];
  if (kind < 0.6) return [pick([1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65]), pick([1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65])];
  if (kind < 0.8) return [1 + Math.floor(random() * 100), 1 + Math.floor(random() * 200)];
  if (kind < 0.9) return pick([[91, 91], [100, 200], [8192, 1], [4096, 3], [4097, 2], [5, 3000], [1, 9000], [8191, 5], [128, 128], [200, 90]]);
  return pick([[8193, 1], [1, 30000]]); // wider than the scratch; more bands than the loop keeps
}

function surface() {
  const scale = pick([1, 10, 100, 1000, 5000]);
  const [width, height] = sizes();
  const corner = [between(-1, 1) * scale, between(-1, 1) * scale, between(-1, 1) * scale + pick([0, 0, scale])];
  const span = () => [between(-1, 1) * scale / Math.max(width, 1) * 4, between(-1, 1) * scale / Math.max(width, 1) * 4, between(-1, 1) * scale / Math.max(width, 1) * 4];
  let stepU = span(), stepV = span();
  const special = random();
  let base = corner;
  if (special < 0.06) { stepU = [0, 0, 0]; stepV = [0, 0, 0]; }
  else if (special < 0.12) base = [0, pick([0, between(-1, 1)]), 0];
  else if (special < 0.17) base = [pick([0, 1e-20, -1e-20, 1.5e-19, 3e-19]), pick([0, 2e-19, -2e-19]), between(-1, 1) * 10];
  else if (special < 0.21) base = [pick([1, -1]) * 2 ** between(29.5, 31), between(-1, 1) * scale, between(-1, 1) * scale];
  else if (special < 0.23) base = [pick([NaN, Infinity, -Infinity]), between(-1, 1) * scale, scale];
  return {width, height, base, stepU, stepV};
}

function lights(count, reach) {
  const out = [];
  for (let k = 0; k < count; k++) {
    const radius = pick([25, 50, 150, 325, 800, 2500, 6400]) * (1 + random() * .05);
    const where = random();
    let location;
    if (where < 0.25) location = [between(-1, 1) * radius * 0.5, between(-1, 1) * radius * 0.5, between(-1, 1) * radius * 0.5]; // inside
    else location = [between(-1, 1) * reach, between(-1, 1) * reach, between(-1, 1) * reach];
    if (random() < 0.05) location[Math.floor(random() * 3)] = pick([0, 1e-20, -1e-20, 2 ** 31]);
    const radiusSq = Math.fround(radius * radius), distanceSq = Math.fround(location[0] ** 2 + location[1] ** 2 + location[2] ** 2);
    const inside = random() < 0.1 ? random() < 0.5 : distanceSq < radiusSq;
    out.push([...location.map(Math.fround), radiusSq, Math.fround(1 / radius), Math.fround(1 / radiusSq), distanceSq, Math.fround(between(0.05, 4)), inside ? 1 : 0].map(v => bitsOf(v)));
  }
  return out;
}

function table(zeroFirst) {
  const t = new Uint8Array(1024);
  const step = [between(0, 2000), between(0, 2000), between(0, 2000), between(0, 2000)];
  for (let i = 0; i < 256; i++) for (let c = 0; c < 4; c++) t[i * 4 + c] = Math.min(127, (i * Math.floor(step[c])) >> 8);
  if (zeroFirst) t.fill(0, 0, 4);
  else if (random() < 0.5) t[0] = 3;
  return t;
}

const totals = {cases: 0, texelLights: 0, declined: 0, exact: 0, reference: 0, nonFinite: 0, hits: 0};
for (let c = 0; c < CASES; c++) {
  const {width, height, base, stepU, stepV} = surface();
  const count = 1 + Math.floor(random() * 8);
  const words = new Uint32Array(count * 9), tables = new Uint8Array(count * 1024);
  const reach = pick([200, 1000, 4000]);
  lights(count, reach).forEach((w, k) => { words.set(w, k * 9); tables.set(table(random() < 0.9 || k > 0), k * 1024); });
  const grid = new Uint32Array([...base, ...stepU, ...stepV].map(bitsOf));
  const missIn = random() < 0.5 ? 1 : 0;
  const where = `case ${c} ${width}x${height} x${count}`;
  fog.lights(words); fog.tables(tables); fog.grid(grid);
  const run = (setup) => { fog.resetFallbacks(); setup(); fog.setMiss(missIn); const texels = fog.map(width, height, count); return {texels, miss: fog.miss(), fallbacks: fog.fallbacks(), reruns: fog.reruns()}; };
  const blocks = run(() => { fog.setExact(false); fog.setPath('blocks'); });
  const reference = run(() => { fog.setExact(false); fog.setPath('reference'); });
  assert.ok(blocks.texels && reference.texels, `${where}: both loops answer`);
  assert.ok(Buffer.from(blocks.texels).equals(Buffer.from(reference.texels)), `${where}: block loop map equals the reference loop's`);
  assert.equal(blocks.miss, reference.miss, `${where}: final flag`);
  assert.equal(blocks.fallbacks, reference.fallbacks, `${where}: texels run on Exact for a non-finite input`);
  assert.equal(blocks.reruns, reference.reruns, `${where}: texels rerun on Wide`);
  fog.setMiss(missIn);
  const verified = fog.verify(width, height, count);
  assert.ok(verified === 0 || verified === 0x10000000, `${where}: fog.verify answers ${verified}`);
  if (verified === 0x10000000) totals.declined++;
  if (width * height * count <= 120000) {
    const exact = run(() => { fog.setExact(true); });
    fog.setExact(false);
    assert.ok(Buffer.from(blocks.texels).equals(Buffer.from(exact.texels)), `${where}: block loop map equals Exact's`);
    assert.equal(blocks.miss, exact.miss, `${where}: final flag against Exact`);
    totals.exact++;
  }
  totals.cases++; totals.texelLights += width * height * count; totals.reference++; totals.nonFinite += blocks.fallbacks;
  for (let t = 3; t < blocks.texels.length; t += 4) if (blocks.texels[t]) totals.hits++;
}
fog.setPath('blocks');
console.log(`validate-fog-blocks: PASS (${totals.cases} surfaces, ${totals.texelLights} texel-lights; the block loop equals the reference loop on every byte and flag, `
  + `and Exact on the ${totals.exact} smaller ones; ${totals.declined} declined by the block loop; ${totals.nonFinite} texels with a non-finite input; ${totals.hits} fogged texels)`);
