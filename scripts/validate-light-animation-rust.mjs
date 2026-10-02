// The animated light-map merge in the Rust core (light.rs, through
// light-animation-kernel.mjs) against static-lighting.mjs animateLightMap
// (docs/static-lighting.md "Rust kernel").
//
// Maps: each map's light maps are built headless the way world.mjs builds
// them (the level's surfaces, then every mover brush's), on a lighting whose
// animated light maps merge on the kernel. Every animated light map also gets
// a JavaScript mirror (its texels and memo) merged by animateLightMap with a
// second light frame on an identical appFrand stream. Each frame advances
// both frames to the same Level.TimeSeconds (steps, repeats, jumps), merges
// the same light maps (a deterministic subset is skipped on some frames, as a
// frustum would), and compares, for every animated light map, the returned
// region (null or its four bounds) and every texel byte; the kernel's colour
// tables (whenever they hold this frame's constants) and modulation tables
// (whenever built for this frame) against the reference's. Script brightness
// changes (lighting.invalidate) refill and re-register light maps mid-run.
//
// Synthetic: random light maps outside the game's data (static bytes above
// 127, every LightType 0-9 and effect 0-19, shared and private light
// actors, level brightness giving huge, negative and NaN colour steps,
// merge factors at ties, 0, 1, negative, huge, infinite and NaN, merges with
// and without a memo, re-registration into larger and smaller layouts, and a
// disposed and recreated kernel reusing freed blocks).
//
//   node scripts/validate-light-animation-rust.mjs [--maps 00_Training,...] [--frames 600] [--no-synthetic] [--bench 600]
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { ClassDefaults } from '../src/unreal/classes.mjs';
import { createLighting, pointZone } from '../src/unreal/lighting.mjs';
import { POLY, toView, fromView } from '../src/unreal/geometry.mjs';
import { readModel } from '../src/unreal/model.mjs';
import { readPolys, moverModelFromPolys } from '../src/unreal/polys.mjs';
import { brushMatrix } from '../src/viewer/transforms.mjs';
import { createLightFrame, animateLightMap } from '../src/runtime/static-lighting.mjs';
import { fgetHsv } from '../src/runtime/dynamic-lighting.mjs';
import { createNativeRng } from '../src/runtime/rng.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { createLightAnimationKernel } from '../src/runtime/light-animation-kernel.mjs';
import { gameDirectory } from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const flag = name => process.argv.includes(`--${name}`);
const frames = Number(option('frames', 600)), bench = Number(option('bench', 0));
const maps = option('maps', '00_Training,02_NYC_BatteryPark,11_Paris_Everett,06_HongKong_WanChai_Underworld,06_HongKong_MJ12lab,03_NYC_MolePeople,15_Area51_Page')
  .split(',').filter(Boolean);
const kernel = await loadScriptVmKernel();
const f = Math.fround;
const bytesOf = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const totals = { frames: 0, merges: 0, regions: 0, nulls: 0, memoSkips: 0, texelBytes: 0, tables: 0, fallbackTables: 0, modulationTables: 0,
  refills: 0, records: 0, kernelRecords: 0 };
const int32 = step => Number.isInteger(step) && step >= -0x80000000 && step <= 0x7fffffff;
/** animateLightMap, counting the memo's skips. */
function reference(base, texels, width, animated, frame, options, memo) {
  const before = memo?.signature, region = animateLightMap(base, texels, width, animated, frame, options, memo);
  if (memo && before !== undefined && memo.signature === before) totals.memoSkips++;
  return region;
}

function compareRegion(where, js, rust) {
  if (js === null || rust === null) {
    if (js !== rust) throw new Error(`${where}: region ${JSON.stringify(js)} != ${JSON.stringify(rust)}`);
    totals.nulls++;
    return;
  }
  for (const key of ['minU', 'maxU', 'minV', 'maxV'])
    if (js[key] !== rust[key]) throw new Error(`${where}: region.${key} ${js[key]} != ${rust[key]}`);
  totals.regions++;
}
function compareBytes(where, js, rust) {
  if (js.length !== rust.length || Buffer.compare(bytesOf(js), bytesOf(rust))) {
    let at = 0;
    while (at < js.length && js[at] === rust[at]) at++;
    throw new Error(`${where}: byte ${at} of ${js.length}: ${js[at]} != ${rust[at]}`);
  }
}
/** The kernel's colour tables for every light of this frame whose slot holds
 * this frame's constants, and its modulation tables built for this frame. */
function compareTables(where, animationKernel, frameR, frameJ) {
  for (const [ref, constants] of frameR.constants ?? []) {
    const held = animationKernel.tables(ref);
    if (!held || held.constants !== constants) continue;
    const [r, g, b] = constants.tables;
    compareBytes(`${where} colour tables of ${ref}`, Buffer.concat([r, g, b]), held.bytes);
    totals.tables++;
    if (!constants.steps.every(int32)) totals.fallbackTables++;
  }
  for (const effect of [1, 2, 3]) {
    const built = animationKernel.modulation(effect);
    if (!built || built.frame !== frameR || built.version !== (effect === 3 ? frameR.noise.version : frameR.frameIndex)) continue;
    compareBytes(`${where} modulation ${effect}`, frameJ.modulation(effect), built.bytes);
    totals.modulationTables++;
  }
}
// A frame clock: ordinary 60 Hz steps with jitter, repeats (a paused level),
// and jumps past the noise's 16-step window.
function clock(seed) {
  let s = seed, t = 0.004;
  const random = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 8;
  return () => {
    const r = random() % 40;
    t = r === 0 ? t : r === 1 ? t + 0.6 : r === 2 ? t + 0.457 : t + (14 + random() % 6) / 1000;
    return f(t);
  };
}
// Which light maps merge on frame k (all of them on most frames).
const visibleOn = (k, index) => k % 7 < 4 || ((Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(k, 0x85ebca6b)) >>> 0) % 4 !== 0;

let files = null;
async function assets() {
  if (files) return files;
  const root = gameDirectory(), list = [];
  for (const directory of ['Maps', 'System'])
    for (const name of await readdir(path.join(root, directory)))
      list.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
  return files = new AssetStore(list);
}

/** world.mjs's light maps: addModel over the level, then each mover brush. */
async function loadLighting(name, choice) {
  const store = await assets(), asset = await store.get(name), map = decodeMap(asset.bytes);
  const lighting = await createLighting(map, asset, store, { kernel: choice }), defaults = new ClassDefaults(store);
  const errors = [];
  async function addModel(model, triangles, actorName = null, matrix = null) {
    await lighting.prepare(model);
    const normalMatrix = matrix ? new THREE.Matrix3().getNormalMatrix(matrix) : null;
    const transform = matrix ? p => fromView(new THREE.Vector3(...toView(p)).applyMatrix4(matrix).toArray()) : p => p;
    const transformNormal = normalMatrix ? n => fromView(new THREE.Vector3(...toView(n)).applyMatrix3(normalMatrix).toArray()) : n => n;
    const moverZone = matrix ? pointZone(map.model, transform(model.bounds.min.map((n, i) => (n + model.bounds.max[i]) / 2))) : null;
    const seen = new Set();
    for (const t of triangles) {
      const zone = moverZone ?? model.nodes[t.node].zones[1], key = `${t.surface}:${zone}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const surface = model.surfaces[t.surface];
      if (surface.flags & (POLY.Invisible | POLY.FakeBackdrop) || surface.flags & POLY.Unlit) continue;
      try { lighting.surface(model, t.surface, zone, transform, transformNormal, actorName); } catch (error) { errors.push(error.message); }
    }
  }
  await addModel(map.model, map.triangles);
  for (const actor of map.actors.filter(a => /Mover$/.test(a.className) && a.values.Brush > 0)) {
    try {
      const rawModel = readModel(asset.pkg, asset.bytes, actor.values.Brush);
      const { model, triangles } = moverModelFromPolys(rawModel, readPolys(asset.pkg, asset.bytes, rawModel.polygons),
        { specialLit: Boolean((await defaults.forActor(asset, actor)).bSpecialLit) });
      const matrix = new THREE.Matrix4().copy(brushMatrix(actor.values));
      await addModel(model, triangles, actor.name, matrix);
    } catch (error) { errors.push(error.message); }
  }
  return { lighting, errors };
}

async function validateMap(name) {
  const { lighting, errors } = await loadLighting(name, kernel);
  const options = { levelBrightness: lighting.levelBrightness, hsv: lighting.hsv, keyOf: ref => ref & 0xff };
  const records = lighting.animatedRecords(), mirrors = new Map();
  const mirror = record => {
    const m = { texels: record.texels.slice(), memo: {} };
    mirrors.set(record, m);
    return m;
  };
  records.forEach(mirror);
  const census = { records: records.length, kernel: records.filter(r => r.lightKernel).length, lights: 0, types: {}, effects: {} };
  for (const record of records) for (const { values, effect } of record.animated) {
    census.lights++;
    census.types[values.LightType & 255] = (census.types[values.LightType & 255] ?? 0) + 1;
    census.effects[effect] = (census.effects[effect] ?? 0) + 1;
  }
  // Script brightness changes: an animated light and a light of an animated
  // map's static list, each changed twice.
  const lightRefs = [...new Set(records.flatMap(r => r.animated.map(l => l.ref)))];
  const staticRefs = [...new Set(records.flatMap(r => [...r.lightRefs]))].filter(ref => !lightRefs.includes(ref));
  const changes = new Map([[Math.floor(frames * 0.3), lightRefs[0]], [Math.floor(frames * 0.45), staticRefs[0]],
    [Math.floor(frames * 0.6), lightRefs.at(-1)], [Math.floor(frames * 0.75), staticRefs.at(-1)]].filter(([, ref]) => ref));
  const frameR = createLightFrame(createNativeRng(0x11647).frand), frameJ = createLightFrame(createNativeRng(0x11647).frand);
  const next = clock(name.length * 977 + 1);
  let merges = 0, changed = 0;
  for (let k = 0; k < frames; k++) {
    const time = next();
    const indexOf = new Map(lighting.animatedRecords().map((r, i) => [r, i]));
    const visible = record => visibleOn(k, indexOf.get(record));
    const rust = new Map(lighting.animate(frameR.advance(time), visible).map(({ lightmap, region }) => [lightmap, region]));
    frameJ.advance(time);
    for (const record of lighting.animatedRecords()) {
      const m = mirrors.get(record) ?? mirror(record), where = `${name} frame ${k} light map ${record.index}:${record.zone}`;
      if (visible(record)) {
        const region = reference(record.baseTexels, m.texels, record.width, record.animated, frameJ, options, m.memo);
        compareRegion(where, region, rust.get(record) ?? null);
        merges++; if (region) changed++;
      }
      compareBytes(where, m.texels, record.texels);
      totals.texelBytes += m.texels.length;
    }
    compareTables(`${name} frame ${k}`, lighting.animationKernel, frameR, frameJ);
    const ref = changes.get(k);
    if (ref) {
      const brightness = (k * 37) & 255, update = lighting.invalidate({ ref, values: { LightBrightness: brightness } });
      for (const record of update.lightmaps) {
        if (!record.animated?.length) continue;
        const m = mirrors.get(record) ?? mirror(record);
        m.texels = record.baseTexels.slice();
        animateLightMap(record.baseTexels, m.texels, record.width, record.animated, frameJ, options);
        m.memo = {};
        compareBytes(`${name} refill at frame ${k}`, m.texels, record.texels);
        totals.refills++;
      }
    }
  }
  totals.frames += frames; totals.merges += merges; totals.records += census.records; totals.kernelRecords += census.kernel;
  console.log(JSON.stringify({ map: name, ...census, merges, changed, refills: changes.size, surfaceErrors: errors.length }));
  assert.equal(census.kernel, census.records, `${name}: every animated light map is admitted to the kernel`);
  lighting.dispose();
}

/** Synthetic light maps on a private kernel instance. */
function synthetic(seed, rounds) {
  let s = seed;
  const random = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 8, pick = list => list[random() % list.length];
  const hsvCache = new Map(), hsv = (h, sat) => {
    const key = (h & 255) << 8 | sat & 255;
    if (!hsvCache.has(key)) hsvCache.set(key, fgetHsv(h, sat, 255));
    return hsvCache.get(key);
  };
  const actors = Array.from({ length: 24 }, (_, i) => ({ ref: 100 + i * 37, values: {
    LightType: i < 10 ? i : pick([1, 2, 3, 4, 5, 7]), LightBrightness: random() & 255, LightHue: random() & 255,
    LightSaturation: pick([0, 255, random() & 255]), LightRadius: random() & 255, LightPeriod: pick([0, 1, 255, random() & 255]),
    LightPhase: random() & 255 } }));
  const factorEdges = [0, 1, 0.5, 0.25, 1 / 3, 0.95, 0.6, -1, -0.002, 2, 1e300, -1e300, 1e39 / 255, NaN, Infinity, -Infinity, 5e-324,
    1 + 2 ** -52, 1 - 2 ** -53, 255.5 / 255, 128.5 / 255, 2 ** 52, -(2 ** 52), 1e16, -3e17, 2 ** 53 / 3, 2 ** 61, 2 ** 62, 2 ** 70];
  const levels = [1, 1, 1, 0.5, 2.75, 1e6, -2, NaN];
  let animationKernel = createLightAnimationKernel(kernel);
  const makeRecord = () => {
    const width = 1 + random() % 40, height = 1 + random() % 24, n = width * height * 3;
    const base = Uint8Array.from({ length: n }, () => pick([random() & 127, random() & 255, 0, 127, 128, 255]));
    const count = 1 + random() % 6, animated = [];
    for (let i = 0; i < count; i++) {
      const full = random() % 5 === 0;
      const minU = full ? 0 : random() % width, maxU = full ? width : minU + 1 + random() % (width - minU);
      const minV = full ? 0 : random() % height, maxV = full ? height : minV + 1 + random() % (height - minV);
      const spatial = Uint8Array.from({ length: (maxU - minU) * (maxV - minV) }, () => pick([0, 0, 255, 1, random() & 255, random() & 255]));
      const actor = random() % 4 ? pick(actors) : { ref: 5000 + random() % 50, values: { ...pick(actors).values, LightType: random() % 10 } };
      animated.push({ values: actor.values, ref: actor.ref, effect: pick([0, 1, 2, 3, 1, 2, 3, random() % 20]), rect: { minU, maxU, minV, maxV }, spatial });
    }
    return { width, base, animated };
  };
  let made = 0, recordCount = 0, mergesDone = 0;
  const types = new Set(), effects = new Set();
  for (let round = 0; round < rounds; round++) {
    const options = { levelBrightness: f(pick(levels)), hsv, keyOf: ref => ref & 0xff };
    const records = Array.from({ length: 12 }, () => {
      const r = makeRecord(), texels = r.base.map((b, i) => i % 5 ? b : random() & 255);
      return { ...r, js: texels.slice(), memo: {}, rustTexels: texels.slice(), rustMemo: {}, handle: animationKernel.register(r.base, r.width, r.animated, texels) };
    });
    made += records.length;
    for (const r of records) assert.ok(r.handle, 'synthetic light map admitted');
    const frameR = createLightFrame(createNativeRng(0x5000 + round).frand), frameJ = createLightFrame(createNativeRng(0x5000 + round).frand);
    const next = clock(0x77 + round);
    for (let k = 0; k < 60; k++) {
      const time = next();
      frameR.advance(time); frameJ.advance(time);
      if (k % 9 === 4) for (const effect of [1, 2, 3]) for (let i = 0; i < 256; i++) {
        const value = random() % 3 ? pick(factorEdges) : (random() % 100000) / 50000 - 0.5;
        frameR.factors[effect][i] = value; frameJ.factors[effect][i] = value;
      }
      records.forEach((r, index) => {
        if (!visibleOn(k, index)) return;
        const useMemo = k % 11 !== 3, where = `synthetic round ${round} frame ${k} map ${index}`;
        const js = reference(r.base, r.js, r.width, r.animated, frameJ, options, useMemo ? r.memo : null);
        const rust = animationKernel.animate(r.handle, r.rustTexels, frameR, options, useMemo ? r.rustMemo : null);
        compareRegion(where, js, rust);
        compareBytes(where, r.js, r.rustTexels);
        mergesDone++;
        for (const { values, effect } of r.animated) { types.add(values.LightType & 255); effects.add(effect); }
      });
      compareTables(`synthetic round ${round} frame ${k}`, animationKernel, frameR, frameJ);
      // Re-registration (a refill): new lights, the same static bytes and
      // current texels, the old block lent when it fits.
      if (k % 13 === 12) {
        const r = records[random() % records.length], width = r.width, height = r.base.length / (3 * width);
        r.animated = makeRecord().animated.map(l => {
          const minU = l.rect.minU % width, maxU = Math.min(width, minU + 1 + (l.rect.maxU - l.rect.minU) % 5);
          const minV = l.rect.minV % height, maxV = Math.min(height, minV + 1 + (l.rect.maxV - l.rect.minV) % 5);
          return { ...l, rect: { minU, maxU, minV, maxV }, spatial: Uint8Array.from({ length: (maxU - minU) * (maxV - minV) }, () => random() & 255) };
        });
        r.handle = animationKernel.register(r.base, r.width, r.animated, r.rustTexels, r.handle);
        assert.ok(r.handle, 'synthetic re-registration admitted');
        r.memo = {}; r.rustMemo = {};
      }
    }
    recordCount += records.length;
    // Every few rounds the kernel goes, and a new one reuses its blocks.
    if (round % 4 === 3) { animationKernel.dispose(); animationKernel = createLightAnimationKernel(kernel); }
  }
  animationKernel.dispose();
  totals.merges += mergesDone;
  console.log(JSON.stringify({ synthetic: { rounds, lightMaps: made, merges: mergesDone, lightTypes: [...types].sort((a, b) => a - b),
    effects: [...effects].sort((a, b) => a - b) } }));
}

/** ms per frame over interleaved blocks of frames: the merge alone
 * (animateLightMap vs the kernel's animate, every light map merged), and
 * lighting.animate end to end (with the float samples of changed regions)
 * on a JavaScript and a kernel lighting. */
async function benchMap(name) {
  const { lighting } = await loadLighting(name, null);
  const options = { levelBrightness: lighting.levelBrightness, hsv: lighting.hsv, keyOf: ref => ref & 0xff };
  const records = lighting.animatedRecords(), animationKernel = createLightAnimationKernel(kernel);
  const js = records.map(r => ({ r, texels: r.texels.slice(), memo: {} }));
  const rust = records.map(r => ({ r, texels: r.texels.slice(), memo: {}, handle: animationKernel.register(r.baseTexels, r.width, r.animated, r.texels) }));
  const frameJ = createLightFrame(createNativeRng(0x11647).frand), frameR = createLightFrame(createNativeRng(0x11647).frand);
  const nextJ = clock(5), nextR = clock(5), block = 50, times = { js: [], rust: [] };
  for (let done = 0; done < bench; done += block) {
    for (const side of done % (2 * block) ? ['rust', 'js'] : ['js', 'rust']) {
      for (let k = 0; k < block; k++) {
        if (side === 'js') {
          frameJ.advance(nextJ());
          const start = performance.now();
          for (const m of js) animateLightMap(m.r.baseTexels, m.texels, m.r.width, m.r.animated, frameJ, options, m.memo);
          times.js.push(performance.now() - start);
        } else {
          frameR.advance(nextR());
          const start = performance.now();
          for (const m of rust) animationKernel.animate(m.handle, m.texels, frameR, options, m.memo);
          times.rust.push(performance.now() - start);
        }
      }
    }
  }
  for (const [i, m] of js.entries()) compareBytes(`${name} bench`, m.texels, rust[i].texels);
  animationKernel.dispose();
  const { lighting: kernelLighting } = await loadLighting(name, kernel);
  const sides = { js: { lighting, frame: createLightFrame(createNativeRng(0x11647).frand), next: clock(5), times: [] },
    rust: { lighting: kernelLighting, frame: createLightFrame(createNativeRng(0x11647).frand), next: clock(5), times: [] } };
  for (let done = 0; done < bench; done += block) {
    for (const side of done % (2 * block) ? ['rust', 'js'] : ['js', 'rust']) {
      const run = sides[side];
      for (let k = 0; k < block; k++) {
        run.frame.advance(run.next());
        const start = performance.now();
        run.lighting.animate(run.frame);
        run.times.push(performance.now() - start);
      }
    }
  }
  const kernelRecords = kernelLighting.animatedRecords();
  records.forEach((r, i) => compareBytes(`${name} end-to-end bench`, r.texels, kernelRecords[i].texels));
  kernelLighting.dispose();
  const median = list => { const sorted = [...list].sort((a, b) => a - b); return +sorted[sorted.length >> 1].toFixed(3); };
  console.log(JSON.stringify({ bench: name, records: records.length, frames: times.js.length,
    mergeMedianMs: { js: median(times.js), rust: median(times.rust) },
    animateMedianMs: { js: median(sides.js.times), rust: median(sides.rust.times) } }));
}

let root = null;
try { root = gameDirectory(); } catch { root = null; }
if (!flag('no-synthetic')) synthetic(0x1a77, Number(option('rounds', 24)));
if (!root) console.log('validate-light-animation-rust: no installed game data, maps skipped');
else if (bench) for (const name of maps) await benchMap(name);
else for (const name of maps) await validateMap(name);
console.log(JSON.stringify(totals));
if (bench) console.log('validate-light-animation-rust: bench done (texels equal after both runs)');
else console.log(`validate-light-animation-rust: PASS (${totals.merges} merges, ${totals.frames} map frames, ${totals.regions} regions, ${totals.nulls} nulls, `
  + `${totals.tables} colour tables, ${totals.modulationTables} modulation tables, ${totals.refills} refills)`);
