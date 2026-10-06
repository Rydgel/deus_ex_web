/** Compare native/script-vm/src/spatial.rs (Render.dll's time-varying
 * spatial light functions and Shell, docs/static-lighting.md "Spatially
 * dynamic effects") with the original bodies executed unchanged by
 * scripts/native-dynamic-light-oracle.py at control word 0x007f (URender::
 * PreRender's 24-bit precision), with Core appAtan2's FPATAN measured on x87
 * hardware (tools/x87-fpatan-probe.c under Wine).
 *
 * Cases: every light with one of these effects on the census maps, on every
 * `--surfaces`-th surface whose light list holds it (Play's own facet, grid,
 * per-light constants, rectangle and shadow illumination), at several
 * TimeSeconds; then fabricated lights and grids: exact hits (dx = dy = 0),
 * zero illumination, singular (NaN) grids, LightPeriod 0, large times.
 * Checks, per case: ComputeFromActor's rr2 and incidence at 24 bits
 * (static-lighting.mjs renderPassConstants against the original segments at
 * 0x007f), the spatial bytes and the sequence of appAtan2 operand
 * pairs the original asked for. A moving LE_Shell light (the grenades'
 * ExplosionLight) through Play's moving-light path on 00_Training: every
 * light map it reaches against the static copy plus the original Shell
 * bytes' colour entries. Then the FPATAN model: every measured pair's
 * 24-bit k·FPATAN for k = 4, 6, 11 against spatial.rs, and the f64 fast path
 * against the double-double path on random pairs.
 *
 *   node scripts/validate-light-spatial.mjs [--maps a,b] [--surfaces 1] [--random 1000000] [--cw 0x007f]
 *
 * Needs the local install, NATIVE_PROBE_PYTHON, i686-w64-mingw32-gcc and
 * Wine (X87_PROBE_WINE, default `wine`); without the toolchain the FPATAN
 * measurement cannot run and the validator skips loudly. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { ClassDefaults } from '../src/unreal/classes.mjs';
import { lightmapBasis, createLighting } from '../src/unreal/lighting.mjs';
import { createMovingLights } from '../src/viewer/moving-lights.mjs';
import { POLY } from '../src/unreal/geometry.mjs';
import { shadowIllumination, renderPassConstants } from '../src/runtime/static-lighting.mjs';
import { rotationSineTable } from '../src/runtime/coords.mjs';
import { fgetHsv, movingLightConstants, movingLightRect, normalLightIncidence, squareRootTable, normalLightTable,
  surfaceLightClass, colorTableEntry } from '../src/runtime/dynamic-lighting.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { gameDirectory } from './game-directory.mjs';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const skip = reason => { console.log(`SKIP validate-light-spatial: ${reason}`); process.exit(0); };
// Wine as the other x87 hardware validators run it: X87_PROBE_WINE, else
// CrossOver's (with the DeusEx bottle) where installed, else `wine`.
const crossover = '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine';
const wine = process.env.X87_PROBE_WINE || (existsSync(crossover) ? crossover : 'wine');
const cc = process.env.X87_PROBE_CC || 'i686-w64-mingw32-gcc', bottle = process.env.X87_PROBE_BOTTLE || 'DeusEx';
try { execFileSync('which', [cc], { stdio: 'ignore' }); } catch { skip(`no ${cc} on PATH`); }
try { execFileSync(wine, ['--version'], { stdio: 'ignore' }); } catch { skip(`no Wine at ${wine} (set X87_PROBE_WINE)`); }

const SPATIAL_EFFECTS = new Set([4, 5, 6, 9, 10, 14, 16, 18]);
const ATAN_K = { 4: [4], 18: [6], 10: [11], 16: [11] };
const CENSUS = ['06_HongKong_Helibase', '06_HongKong_WanChai_Canal', '06_HongKong_WanChai_Garage', '06_HongKong_WanChai_Underworld',
  '09_NYC_Graveyard', '09_NYC_ShipBelow', '09_NYC_ShipFan', '10_Paris_Club', '12_Vandenberg_Tunnels', '14_Vandenberg_Sub',
  '15_Area51_Page', '99_Endgame1', '99_Endgame2', '99_Endgame3'];
const mapNames = option('maps', CENSUS.join(',')).split(',').filter(Boolean);
const surfaceEvery = Number(option('surfaces', 1)), randomPairs = Number(option('random', 1000000));
// --cw 0x037f runs the original at 64-bit precision instead (a contrast: it
// should not match).
const controlWord = option('cw', '0x007f');
const TIMES = [0.0137, 2.5, 61.75, 1234.5678, 20000.125, 131072.5];

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const runOracle = (cases, cw = '0x007f') => JSON.parse(execFileSync(python, ['scripts/native-dynamic-light-oracle.py', root, cw],
  { input: JSON.stringify(cases), maxBuffer: 1 << 30 }));
const view = new DataView(new ArrayBuffer(8));
const u32 = value => { view.setFloat32(0, value, true); return view.getUint32(0, true); };
const f = Math.fround;
const hex = bytes => Buffer.from(bytes).toString('hex');

const kernel = await loadScriptVmKernel(), spatial = kernel.spatial;
assert.ok(spatial, 'the script VM core exports spatial.rs (npm run build:wasm)');
spatial.tables(squareRootTable(), normalLightTable());

// ---------------------------------------------------------------------------
// Cases: Play's inputs on the census maps.
const cases = [];
let seed = 0x5ba7;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8;
const census = [];
for (const mapName of mapNames) {
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes), model = map.model, defaults = new ClassDefaults(assets);
  const values = new Map();
  const valuesOf = async ref => {
    if (!values.has(ref)) values.set(ref, await defaults.forActor(asset, map.actors.find(a => a.index === ref)));
    return values.get(ref);
  };
  const levelInfo = map.actors.find(a => a.className === 'LevelInfo'), level = await valuesOf(levelInfo.index);
  const levelBrightness = f(level.Brightness ?? 1);
  let lights = new Set(), surfaces = 0, steps = 0;
  for (let index = 0; index < model.surfaces.length; index++) {
    const surface = model.surfaces[index], lm = model.lightMaps[surface.lightMap];
    if (!lm || lm.lightActors == null || lm.lightActors < 0) continue;
    const refs = [];
    for (let at = lm.lightActors; model.lights[at]; at++) refs.push(model.lights[at]);
    const listed = [];
    for (const [light, ref] of refs.entries()) {
      const v = await valuesOf(ref);
      if (v && SPATIAL_EFFECTS.has(v.LightEffect ?? 0) && surfaceLightClass(v) === 1) listed.push({ light, ref, v });
    }
    if (!listed.length || (surfaces++ % surfaceEvery)) continue;
    let basis;
    try { basis = lightmapBasis(model, surface, lm); } catch { continue; }
    const [width, height] = lm.clamp, pitch = (width + 7) >> 3;
    const facet = { origin: model.points[surface.base], axisU: model.vectors[surface.textureU], axisV: model.vectors[surface.textureV],
      normal: model.vectors[surface.normal], pan: [lm.pan[0], lm.pan[1]], scale: lm.scale, clamp: lm.clamp };
    const p00 = basis.point(0, 0);
    const grid = { start: p00.map(f), stepU: basis.point(1, 0).map((v, i) => f(v - p00[i])), stepV: basis.point(0, 1).map((v, i) => f(v - p00[i])) };
    for (const { light, ref, v } of listed) {
      const location = (v.Location ?? [0, 0, 0]).map(f);
      const constants = movingLightConstants(v, levelBrightness, fgetHsv(v.LightHue ?? 0, v.LightSaturation ?? 0, 255));
      const rect = movingLightRect(location, constants.radius, facet);
      if (rect.minU >= rect.maxU || rect.minV >= rect.maxV) continue;
      const { rr2, incidence } = renderPassConstants(location, facet, constants.rradius);
      const full = shadowIllumination(model.lightBits, lm.dataOffset + light * pitch * height, width, height), stride = pitch * 8;
      const rw = rect.maxU - rect.minU, illumination = new Uint8Array(rw * (rect.maxV - rect.minV));
      for (let y = rect.minV; y < rect.maxV; y++) illumination.set(full.subarray(y * stride + rect.minU, y * stride + rect.maxU), (y - rect.minV) * rw);
      lights.add(ref);
      for (const time of [TIMES[steps % TIMES.length], TIMES[(steps + 3) % TIMES.length]]) {
        cases.push({ source: `${mapName}:${ref}:${index}`, effect: v.LightEffect, clamp: [width, height], rect, grid, location,
          rradius: constants.rradius, rr2, incidence, time: f(time + (random() % 1000) / 4096), radius: v.LightRadius & 255, facet,
          period: v.LightPeriod ?? 0, phase: v.LightPhase ?? 0, illumination });
      }
      steps++;
    }
  }
  census.push({ map: mapName, lights: lights.size, surfaces, steps });
}
const realCases = cases.length;

// ComputeFromActor's rr2 (every LightRadius) and each real case's incidence
// at 0x007f against renderPassConstants.
const facetBits = facet => ({ origin: facet.origin.map(u32), axisU: facet.axisU.map(u32), axisV: facet.axisV.map(u32),
  normal: facet.normal.map(u32), pan: facet.pan.map(u32), scale: facet.scale.map(u32), clamp: facet.clamp });
const constantReport = { radii: 256, rr2Mismatch: 0, incidences: 0, incidenceMismatch: 0, rr2At64: 0, incidenceAt64: 0 };
{
  const radii = [...Array(256).keys()], native = runOracle({ radii }).radii;
  radii.forEach((radius, i) => {
    const constants = movingLightConstants({ LightRadius: radius, LightBrightness: 255 }, 1, [1, 1, 1]);
    if (native[i][2] !== u32(renderPassConstants([0, 0, 0], { origin: [0, 0, 0], normal: [0, 0, 1] }, constants.rradius).rr2))
      constantReport.rr2Mismatch++;
    if (native[i][2] !== u32(constants.rr2)) constantReport.rr2At64++;
  });
  const seen = new Set(), list = [];
  for (const c of cases.slice(0, realCases)) {
    const key = `${c.location}|${c.facet.origin}|${c.facet.normal}`;
    if (seen.has(key)) continue;
    seen.add(key); list.push(c);
  }
  for (let start = 0; start < list.length; start += 2000) {
    const part = list.slice(start, start + 2000);
    const native = runOracle({ incidence: part.map(c => ({ light: { location: c.location, brightness: 1, radius: c.radius },
      facet: facetBits(c.facet), rradius: u32(c.rradius) })) }).incidence;
    part.forEach((c, i) => {
      constantReport.incidences++;
      if (native[i] !== u32(c.incidence)) constantReport.incidenceMismatch++;
      if (native[i] !== u32(normalLightIncidence(c.location, c.facet, c.rradius))) constantReport.incidenceAt64++;
    });
  }
  // What the 64-bit constants would change: spatial bytes of the real cases.
  constantReport.texelsChangedAt64 = 0;
  for (const c of cases.slice(0, realCases)) {
    const at64 = movingLightConstants({ LightRadius: c.radius, LightBrightness: 255 }, 1, [1, 1, 1]).rr2;
    const a = spatial.run(c), b = spatial.run({ ...c, rr2: at64, incidence: normalLightIncidence(c.location, c.facet, c.rradius) });
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) constantReport.texelsChangedAt64++;
  }
}

// Fabricated cases: every body, exact hits, zeros, NaN grids, edge times.
for (const effect of SPATIAL_EFFECTS) for (let k = 0; k < 24; k++) {
  const width = 1 + random() % 48, height = 1 + random() % 32;
  const minU = random() % width, maxU = minU + 1 + random() % (width - minU), minV = random() % height, maxV = minV + 1 + random() % (height - minV);
  const step = () => f(((random() % 2001) - 1000) / 64);
  const grid = { start: [0, 1, 2].map(() => f(((random() % 20001) - 10000) / 8)), stepU: [step(), step(), 0], stepV: [0, step(), step()] };
  if (k % 6 === 5) grid.stepU = [NaN, NaN, NaN];
  // A light on a texel position (dx = dy = 0 there) or near the rectangle.
  const hitU = minU + random() % (maxU - minU), hitV = minV + random() % (maxV - minV);
  const texel = grid.start.map((s, i) => f(f(s + f(hitV * grid.stepV[i])) + f(hitU * grid.stepU[i])));
  const location = k % 3 === 0 ? texel.map((t, i) => i === 2 ? f(t + (random() % 64)) : t)
    : texel.map(t => f(t + ((random() % 4001) - 2000) / 16));
  const radius = 1 + random() % 64, R = f(25 * (radius + 1)), rr = f(1 / R);
  const illumination = Uint8Array.from({ length: (maxU - minU) * (maxV - minV) }, () => (random() % 5 ? random() % 255 : 0));
  const times = [0, f(1e-3 * (random() % 1000)), f(random() % 100000), f(3.5e6 + random() % 1000)];
  cases.push({ source: `synthetic:${effect}:${k}`, effect, clamp: [width, height], rect: { minU, maxU, minV, maxV }, grid, location,
    rradius: rr, rr2: f(rr * rr * 4093), incidence: f((random() % 1001) / 1000), time: times[k % 4],
    period: k % 4 === 1 ? 0 : random() & 255, phase: random() & 255, illumination: k % 7 === 6 ? null : illumination });
}

// ---------------------------------------------------------------------------
// spatial.rs, recording each case's appAtan2 pairs.
const rust = [], pairsOf = [];
for (const c of cases) {
  spatial.collect(2 * (c.rect.maxU - c.rect.minU) * (c.rect.maxV - c.rect.minV) + 16);
  rust.push(spatial.run(c));
  const pairs = spatial.pairs(), list = [];
  for (let i = 0; i < pairs.length; i += 2) list.push(`${pairs[i].toString(16).padStart(16, '0')}:${pairs[i + 1].toString(16).padStart(16, '0')}`);
  pairsOf.push(list);
}
spatial.collect(0);
// The cached form light.rs merges with (run_frame): the bytes at the case's
// time from a fresh cache, at another time, and at the first time again.
let cachedMismatch = 0, cachedFrames = 0;
for (const [i, c] of cases.entries()) {
  const later = f(c.time + 0.37), [first, second, again] = spatial.runFrames(c, [c.time, later, c.time]);
  const direct = spatial.run({ ...c, time: later });
  for (const [a, b] of [[first, rust[i]], [second, direct], [again, rust[i]]]) {
    cachedFrames++;
    if (Buffer.compare(Buffer.from(a), Buffer.from(b))) cachedMismatch++;
  }
}

// FPATAN on the hardware for every distinct pair, at 0x007f and 0x037f.
const unique = [...new Set(pairsOf.flat())];
const cache = path.join(here, '.cache');
mkdirSync(cache, { recursive: true });
const exe = path.join(cache, 'x87-fpatan-probe.exe'), listFile = path.join(cache, 'fpatan-pairs.txt');
execFileSync(cc, ['-O1', '-o', exe, path.join(here, 'tools', 'x87-fpatan-probe.c')]);
writeFileSync(listFile, unique.map(key => key.replace(':', ' ')).join('\n') + '\n');
const measure = cw => {
  const out = execFileSync(wine, [exe, `Z:${listFile.replaceAll('/', '\\')}`, cw],
    { env: { ...process.env, CX_BOTTLE: bottle, WINEDEBUG: '-all' }, maxBuffer: 1 << 30, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/);
  assert.equal(out[0], `#cw=${cw.slice(2).padStart(4, '0')}`, `the probe ran at control word ${cw}`);
  return out.slice(1, unique.length + 1);
};
const hw = measure('0x007f'), hw037f = measure('0x037f');
assert.equal(hw.length, unique.length, 'one FPATAN result per pair');
const fpatan = Object.fromEntries(unique.map((key, i) => [key, hw[i]]));
const precisionDependent = hw.filter((value, i) => value !== hw037f[i]).length;

// The original bodies, in chunks (the oracle's fixture heap is a bump
// allocator; each chunk is a fresh process).
const sines = [...rotationSineTable()].map(u32);
const tables = { sqrt: [...squareRootTable()], normal: [...normalLightTable()].map(u32) };
const toOracle = c => ({ effect: c.effect, clamp: c.clamp, rect: [c.rect.minU, c.rect.maxU, c.rect.minV, c.rect.maxV],
  grid: { start: c.grid.start.map(u32), stepU: c.grid.stepU.map(u32), stepV: c.grid.stepV.map(u32) }, location: c.location.map(u32),
  constants: { rradius: u32(c.rradius), rr2: u32(c.rr2), incidence: u32(c.incidence) }, time: u32(c.time),
  period: c.period & 255, phase: c.phase & 255, illumination: c.illumination ? hex(c.illumination) : null });
const original = [];
let missing = 0;
for (let start = 0; start < cases.length;) {
  let end = start, texels = 0;
  while (end < cases.length && (end === start || texels < 400000)) {
    const { rect } = cases[end++];
    texels += (rect.maxU - rect.minU) * (rect.maxV - rect.minV);
  }
  const chunk = cases.slice(start, end), keys = new Set(pairsOf.slice(start, end).flat());
  const part = runOracle({ sines, tables, spatialDynamic: chunk.map(toOracle),
    fpatan: Object.fromEntries([...keys].map(key => [key, fpatan[key]])) }, controlWord);
  original.push(...part.spatialDynamic);
  missing += part.atanMissing.length;
  start = end;
}

const report = { controlWord, census, realCases, constants: constantReport, cached: { frames: cachedFrames, mismatches: cachedMismatch }, cases: cases.length, texels: 0, lit: 0, mismatches: 0, pairMismatches: 0, missing,
  pairs: unique.length, atanCalls: pairsOf.flat().length, precisionDependent, byEffect: {}, first: [] };
cases.forEach((c, i) => {
  const expected = Buffer.from(original[i].spatial, 'hex'), got = rust[i];
  const row = report.byEffect[c.effect] ??= { cases: 0, texels: 0, lit: 0, mismatches: 0 };
  row.cases++; row.texels += got.length; report.texels += got.length;
  let bad = 0;
  for (let k = 0; k < got.length; k++) { if (expected[k]) { row.lit++; report.lit++; } if (expected[k] !== got[k]) bad++; }
  const pairsSame = original[i].pairs.length === pairsOf[i].length && original[i].pairs.every((p, k) => p === pairsOf[i][k]);
  if (!pairsSame) report.pairMismatches++;
  if (bad || expected.length !== got.length) {
    row.mismatches++; report.mismatches++;
    if (!report.first.length) writeFileSync(path.join(cache, 'light-spatial-first-mismatch.json'), JSON.stringify({ sines, tables,
      spatialDynamic: [toOracle(c)], fpatan: Object.fromEntries(pairsOf[i].map(key => [key, fpatan[key]])), rust: [...got] }));
    if (report.first.length < 6) report.first.push({ source: c.source, effect: c.effect, time: c.time, bad,
      sample: [...got].map((v, k) => [k, expected[k], v]).filter(([, a, b]) => a !== b).slice(0, 4) });
  }
});

// ---------------------------------------------------------------------------
// A moving Shell light in Play's moving-light path (moving-lights.mjs, full
// mode) on Training's level light maps, against the original body.
const shellReport = { lights: 0, records: 0, texels: 0, lit: 0, mismatches: 0 };
{
  const asset = await assets.get('00_Training'), map = decodeMap(asset.bytes), model = map.model;
  const lighting = await createLighting(map, asset, assets, { kernel });
  await lighting.prepare(model);
  const seen = new Set();
  for (const t of map.triangles) {
    const zone = model.nodes[t.node].zones[1], key = `${t.surface}:${zone}`, surface = model.surfaces[t.surface];
    if (seen.has(key) || surface.flags & (POLY.Invisible | POLY.FakeBackdrop | POLY.Unlit)) continue;
    seen.add(key);
    try { lighting.surface(model, t.surface, zone); } catch { /* the world refuses these surfaces too */ }
  }
  const moving = createMovingLights(lighting, model, { mode: 'full' });
  lighting.setMovingApplier(moving.apply);
  const values = { LightType: 1, LightEffect: 14, LightBrightness: 255, LightRadius: 8, LightHue: 128, LightSaturation: 96,
    bStatic: false, bNoDelete: false, bDynamicLight: false, bSpecialLit: false };
  // Beside a few lit surfaces, off their planes.
  const lit = [...new Set(map.triangles.map(t => t.surface))].filter(i => lighting.recordsFor(model, i).length);
  for (let k = 0; k < 6; k++) {
    const surface = model.surfaces[lit[(k * 997) % lit.length]], base = model.points[surface.base], normal = model.vectors[surface.normal];
    const location = base.map((v, i) => f(v + normal[i] * (24 + 16 * k)));
    const light = { name: 'ExplosionLight0', location, values: { ...values, LightRadius: 4 + k }, levelBrightness: lighting.levelBrightness };
    moving.update([light]);
    const constants = movingLightConstants(light.values, lighting.levelBrightness, fgetHsv(128, 96, 255));
    shellReport.lights++;
    const shellCases = [], checks = [];
    for (const record of moving.records()) {
      const { facet, start, stepU, stepV } = record.movingGeometry, grid = { start: start.map(f), stepU, stepV };
      const rect = movingLightRect(location, constants.radius, facet);
      if (rect.minU >= rect.maxU || rect.minV >= rect.maxV) continue;
      shellCases.push({ effect: 14, clamp: [record.width, record.height], rect, grid, location, rradius: constants.rradius,
        rr2: renderPassConstants(location, facet, constants.rradius).rr2, incidence: 0, time: 0, period: 0, phase: 0, illumination: null });
      checks.push({ record, rect });
    }
    if (!shellCases.length) continue;
    const native = runOracle({ sines, tables, spatialDynamic: shellCases.map(toOracle), fpatan: {} }, controlWord).spatialDynamic;
    checks.forEach(({ record, rect }, i) => {
      const bytes = Buffer.from(native[i].spatial, 'hex'), base = record.staticPixels, MAX = 127 / 255;
      shellReport.records++;
      for (let v = rect.minV, k2 = 0; v < rect.maxV; v++) for (let u = rect.minU; u < rect.maxU; u++, k2++) {
        const at = (v * record.width + u) * 3;
        shellReport.texels++; if (bytes[k2]) shellReport.lit++;
        for (let c = 0; c < 3; c++) {
          const expected = bytes[k2] ? f(Math.min(MAX, base[at + c] + colorTableEntry(constants.steps[c], bytes[k2]) / 255)) : base[at + c];
          if (record.pixels[at + c] !== expected) { shellReport.mismatches++; if (!shellReport.first) shellReport.first = { u, v, c, byte: bytes[k2], got: record.pixels[at + c], expected, base: base[at + c], rect, w: record.width }; }
        }
      }
    });
  }
  shellReport.notes = [...moving.notes].filter(note => /effect 14|Shell/.test(note));
  lighting.dispose();
}

// ---------------------------------------------------------------------------
// The FPATAN model. Exact 24-bit k·X from the measured 80-bit X.
const extended = text => ({ sign: parseInt(text.slice(0, 4), 16) >> 15, exponent: parseInt(text.slice(0, 4), 16) & 0x7fff,
  significand: BigInt(`0x${text.slice(4)}`) });
const round24 = (n, exponent) => { // n·2^exponent, n > 0 BigInt, to a 24-bit double
  const length = n.toString(2).length;
  if (length <= 24) return Number(n) * 2 ** exponent;
  const shift = BigInt(length - 24), half = 1n << (shift - 1n), rem = n & ((1n << shift) - 1n);
  let q = n >> shift;
  if (rem > half || (rem === half && (q & 1n))) q++;
  return Number(q) * 2 ** (exponent + Number(shift));
};
const kTimesX = (text, k) => {
  const { sign, exponent, significand } = extended(text);
  if (significand === 0n) return sign ? -0 : 0;
  const value = round24(significand * BigInt(k), exponent - 16383 - 63);
  return sign ? -value : value;
};
const doubleOf = bits => { view.setBigUint64(0, BigInt(`0x${bits}`), true); return view.getFloat64(0, true); };
// The double-double value rounded to 64 bits, as the probe prints it.
const rn64 = (hi, lo) => {
  if (hi === 0) return '0000'.padEnd(20, '0');
  const exact = d => { view.setFloat64(0, d, true); const b = view.getBigUint64(0, true), e = Number((b >> 52n) & 0x7ffn);
    const m = e ? (b & ((1n << 52n) - 1n)) | (1n << 52n) : (b & ((1n << 52n) - 1n)) << 1n;
    return { n: (b >> 63n ? -1n : 1n) * m, e: (e || 1) - 1075 }; };
  const a = exact(hi), b = exact(lo), e = Math.min(a.e, b.e);
  let n = (a.n << BigInt(a.e - e)) + (b.n << BigInt(b.e - e));
  const sign = n < 0n ? 1 : 0; if (sign) n = -n;
  const length = n.toString(2).length, shift = BigInt(length - 64);
  let q = shift > 0n ? n >> shift : n << -shift;
  if (shift > 0n) { const rem = n & ((1n << shift) - 1n), half = 1n << (shift - 1n); if (rem > half || (rem === half && (q & 1n))) q++; }
  let exponent = e + Number(shift) + 63;
  if (q >> 64n) { q >>= 1n; exponent++; }
  return ((sign << 15) | (exponent + 16383)).toString(16).padStart(4, '0') + q.toString(16).padStart(16, '0');
};
let modelMismatch = 0, notCorrectlyRounded = 0, products = 0;
const modelFirst = [];
spatial.resetCounts();
unique.forEach((key, i) => {
  const [yb, xb] = key.split(':'), y = doubleOf(yb), x = doubleOf(xb);
  const [hi, lo] = spatial.atanDd(y, x);
  if (rn64(hi, lo) !== hw[i]) notCorrectlyRounded++;
  for (const k of [4, 6, 11]) {
    products++;
    const expected = kTimesX(hw[i], k), got = spatial.atanK(y, x, k);
    if (!Object.is(expected, got)) { modelMismatch++; if (modelFirst.length < 5) modelFirst.push({ key, k, expected, got, hw: hw[i] }); }
  }
});
const measuredFallbacks = spatial.fallbacks(), measuredAmbiguous = spatial.ambiguous();

// The fast path against the double-double path on random float pairs.
const randomInputs = Array.from({ length: randomPairs }, (_, i) => {
  const scale = 2 ** ((random() % 40) - 20);
  return [f(((random() % 2000001) - 1000000) / 1000 * scale), f(((random() % 2000001) - 1000000) / 1000 * (i % 3 ? scale : 1)), [4, 6, 11][i % 3]];
});
spatial.resetCounts();
const fastValues = randomInputs.map(([y, x, k]) => spatial.atanK(y, x, k));
const randomFallbacks = spatial.fallbacks();
spatial.slowOnly(true);
const fastMismatch = randomInputs.filter(([y, x, k], i) => !Object.is(fastValues[i], spatial.atanK(y, x, k))).length;
spatial.slowOnly(false);

Object.assign(report, { movingShell: shellReport, fpatan: { products, modelMismatch, notCorrectlyRounded, fallbacks: measuredFallbacks, ambiguous: measuredAmbiguous, first: modelFirst },
  random: { pairs: randomPairs, fastMismatch, fallbacks: randomFallbacks } });
console.log(JSON.stringify(report));
assert.equal(missing, 0, 'every appAtan2 pair the original asked for was measured');
assert.equal(cachedMismatch, 0, 'the cached per-frame form gives the single loop\'s bytes');
if (controlWord === '0x007f') {
  assert.equal(constantReport.rr2Mismatch, 0, 'rr2 at 24 bits matches ComputeFromActor for every LightRadius');
  assert.equal(constantReport.incidenceMismatch, 0, 'incidence at 24 bits matches ComputeFromActor');
}
assert.equal(report.pairMismatches, 0, 'spatial.rs asks for the same appAtan2 operands as the original');
assert.equal(report.mismatches, 0, 'spatial bytes match the original at 0x007f');
assert.equal(modelMismatch, 0, 'k·FPATAN at 24 bits matches the hardware for every measured pair');
assert.ok(shellReport.lit > 0 && shellReport.mismatches === 0 && !shellReport.notes.length,
  'a moving Shell light adds the original Shell bytes in Play\'s moving-light path');
assert.equal(fastMismatch, 0, 'the f64 atan fast path agrees with the double-double path');
console.log(`validate-light-spatial: PASS (${report.cases} cases, ${report.texels} texels, ${report.lit} lit; ` +
  `${unique.length} FPATAN pairs measured on x87 hardware, ${products} products; ${randomPairs} random fast/slow pairs; ` +
  `moving Shell ${shellReport.records} light maps, ${shellReport.lit} lit texels)`);
