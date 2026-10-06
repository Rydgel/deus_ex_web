/** Compare src/runtime/static-lighting.mjs with the original Render.dll
 * static-light path (scripts/native-dynamic-light-oracle.py): the shadow
 * table and every shadow mask's illumination bytes on a map's BSP light maps.
 * Requires the local install and NATIVE_PROBE_PYTHON (default
 * .cache/native-probe-env). docs/static-lighting.md records the scope.
 *
 *   node scripts/validate-static-lighting.mjs [--map 00_Training] [--every 1]
 */
import { execFileSync } from 'node:child_process';
import { auditAssert, auditControlWord } from './precision-audit.mjs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { ClassDefaults } from '../src/unreal/classes.mjs';
import { lightmapBasis } from '../src/unreal/lighting.mjs';
import { shadowTable, shadowIllumination, ambientTexel, spotLightSpatial, cylinderSpatial, rsqrtTables } from '../src/runtime/static-lighting.mjs';
import { fcoordsAxes } from '../src/runtime/script-pawn-locomotion.mjs';
import { rotationSineTable } from '../src/runtime/coords.mjs';
import { fgetHsv, movingLightConstants, movingLightRect, normalLightIncidence, normalLightSpatial, nonIncidenceSpatial,
  colorTableEntry, surfaceLightClass } from '../src/runtime/dynamic-lighting.mjs';
import { gameDirectory } from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const mapName = option('map', '00_Training'), every = Number(option('every', 1)), surfaceEvery = Number(option('surfaces', 8));
const assets = new AssetStore(files), asset = await assets.get(mapName), map = decodeMap(asset.bytes), model = map.model;
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
// ORACLE_CW=0x007f: the render-pass precision audit (precision-audit.mjs);
// the light-manager tables stay at the init word.
const assert = auditAssert(), controlWord = auditControlWord();
const runOracle = cases => JSON.parse(execFileSync(python, ['scripts/native-dynamic-light-oracle.py', root, ...(controlWord ? [controlWord] : [])],
  { input: JSON.stringify(cases), maxBuffer: 1 << 30 }));
const hex = array => Buffer.from(array).toString('hex');

// Every light's shadow mask on every light map (each `every`-th), plus a
// no-shadow case and fabricated single-row and odd-width masks.
const cases = [], expected = [];
let maps = 0;
model.lightMaps.forEach((lm, index) => {
  if (index % every || lm.lightActors == null || lm.lightActors < 0) return;
  const [width, height] = lm.clamp, pitch = (width + 7) >> 3;
  let light = 0;
  for (let at = lm.lightActors; model.lights[at]; at++, light++) {
    const offset = lm.dataOffset + light * pitch * height;
    cases.push({ clamp: [width, height], bits: hex(model.lightBits.subarray(offset, offset + pitch * height)) });
    expected.push(shadowIllumination(model.lightBits, offset, width, height));
  }
  maps++;
});
let seed = 0x51ad0;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8;
for (const [width, height] of [[1, 1], [5, 1], [9, 1], [17, 3], [8, 2], [3, 7], [64, 2], [33, 33]]) {
  const pitch = (width + 7) >> 3, bits = Uint8Array.from({ length: pitch * height }, () => random() & 255);
  cases.push({ clamp: [width, height], bits: hex(bits) });
  expected.push(shadowIllumination(bits, 0, width, height));
}
cases.push({ clamp: [13, 4], bits: null });
expected.push(shadowIllumination(null, 0, 13, 4));

const native = runOracle({ shadowTable: true, illumination: cases });
const table = Uint8Array.from(native.shadowTable.flatMap(word => [word & 255, (word >>> 8) & 255, (word >>> 16) & 255, word >>> 24]));
assert.equal(hex(shadowTable), hex(table), 'shadow table (0x10b3cae0)');
let mismatches = 0, texels = 0, lit = 0;
const first = [];
cases.forEach((c, i) => {
  const [width, height] = c.clamp, stride = ((width + 7) >> 3) * 8;
  const original = Buffer.from(native.illumination[i], 'hex').subarray(0, stride * height);
  texels += width * height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (original[y * stride + x]) lit++;
  if (hex(original) !== hex(expected[i])) { mismatches++; if (first.length < 5) first.push({ case: i, clamp: c.clamp }); }
});
console.log(JSON.stringify({ map: mapName, lightMaps: maps, masks: cases.length, texels, lit, mismatches, first }));
assert.equal(mismatches, 0, 'illumination bytes match the original');

// Phase 2: the zone ambients, then on every `surfaceEvery`-th world surface
// each static light whose spatial function is translated (normal-body
// effects, NonIncidence) chained from the ambient fill: rectangle, incidence,
// colour table, spatial bytes on the real illumination, and the merge.
const bitsView = new DataView(new ArrayBuffer(4));
const u32 = value => { bitsView.setFloat32(0, value, true); return bitsView.getUint32(0, true); };
const asBits = value => Array.isArray(value) ? value.map(asBits) : typeof value === 'number' ? u32(value)
  : Object.fromEntries(Object.entries(value).map(([key, v]) => [key, key === 'clamp' ? v : asBits(v)]));
const defaults = new ClassDefaults(assets), actorValues = new Map();
const valuesOf = async ref => {
  if (!actorValues.has(ref)) actorValues.set(ref, await defaults.forActor(asset, map.actors.find(a => a.index === ref)));
  return actorValues.get(ref);
};
const levelInfo = map.actors.find(a => a.className === 'LevelInfo'), level = await valuesOf(levelInfo.index);
const levelBrightness = Math.fround(level.Brightness ?? 1);
const zoneTriples = [];
for (const zone of model.zones) {
  const v = zone.actor ? await valuesOf(zone.actor) : level;
  zoneTriples.push([v.AmbientHue ?? 0, v.AmbientSaturation ?? 0, v.AmbientBrightness ?? 0]);
}
for (let k = 0; k < 64; k++) zoneTriples.push([random() & 255, random() & 255, random() & 255]);
const NORMAL_BODY = new Set([0, 1, 2, 3, 11, 19]);
// The light-manager tables (square roots, normal falloff) must be built first.
const second = { ambient: zoneTriples }, chain = [];
let surfaces = 0;
for (let index = 0; index < model.surfaces.length; index += surfaceEvery) {
  const surface = model.surfaces[index], lm = model.lightMaps[surface.lightMap];
  if (!lm || lm.lightActors == null || lm.lightActors < 0 || surface.flags & 0x80) continue;
  let basis;
  try { basis = lightmapBasis(model, surface, lm); } catch { continue; }
  const [width, height] = lm.clamp, pitch = (width + 7) >> 3;
  const facet = { origin: model.points[surface.base], axisU: model.vectors[surface.textureU],
    axisV: model.vectors[surface.textureV], normal: model.vectors[surface.normal],
    pan: [lm.pan[0], lm.pan[1]], scale: lm.scale, clamp: lm.clamp };
  const p00 = basis.point(0, 0);
  const grid = { start: p00.map(Math.fround), stepU: basis.point(1, 0).map((v, i) => Math.fround(v - p00[i])),
    stepV: basis.point(0, 1).map((v, i) => Math.fround(v - p00[i])) };
  const [r, g, b] = ambientTexel(fgetHsv(...zoneTriples[0]));
  let texels = new Array(width * height).fill((b | g << 8 | r << 16 | 0x7f000000) >>> 0);
  let light = 0, used = 0;
  for (let at = lm.lightActors; model.lights[at]; at++, light++) {
    const values = await valuesOf(model.lights[at]), effect = values.LightEffect ?? 0, lightClass = surfaceLightClass(values);
    if (lightClass !== 0 && lightClass !== 1) continue;
    const spot = effect === 8 || effect === 12, cylinder = effect === 17;
    if (!NORMAL_BODY.has(effect) && effect !== 13 && !spot && !cylinder) continue;
    if (Boolean(surface.flags & 0x100000) !== Boolean(values.bSpecialLit)) continue;
    const location = (values.Location ?? [0, 0, 0]).map(Math.fround);
    const hsv = fgetHsv(values.LightHue ?? 0, values.LightSaturation ?? 0, 255);
    const constants = movingLightConstants(values, levelBrightness, hsv);
    const rect = movingLightRect(location, constants.radius, facet);
    const incidence = normalLightIncidence(location, facet, constants.rradius);
    const illumination = { bytes: shadowIllumination(model.lightBits, lm.dataOffset + light * pitch * height, width, height), stride: pitch * 8 };
    const spatial = new Array(width * height).fill(0);
    const rotation = (values.Rotation ?? [0, 0, 0]).map(n => n | 0), cone = values.LightCone ?? 0;
    if (cylinder) cylinderSpatial(rect, grid, location, constants, (u, v, byte) => { spatial[v * width + u] = byte; }, illumination);
    else if (spot) spotLightSpatial(rect, grid, location, { ...constants, incidence }, (u, v, byte) => { spatial[v * width + u] = byte; },
      illumination, { cone, axis: fcoordsAxes(rotation)[1] });
    else (effect === 13 ? nonIncidenceSpatial : normalLightSpatial)(rect, grid, location, { ...constants, incidence },
      (u, v, byte) => { spatial[v * width + u] = byte; }, illumination);
    const table = [...Array(256).keys()].map(i => (colorTableEntry(constants.steps[2], i) |
      (colorTableEntry(constants.steps[1], i) << 8) | (colorTableEntry(constants.steps[0], i) << 16) | 0xff000000) >>> 0);
    const merged = texels.map((texel, p) => {
      const u = p % width, v = Math.floor(p / width);
      if (u < rect.minU || u >= rect.maxU || v < rect.minV || v >= rect.maxV) return texel;
      let out = texel & 0xff000000;
      for (let c = 0; c < 3; c++) out |= Math.min(127, ((texel >>> (c * 8)) & 255) + ((table[spatial[p]] >>> (c * 8)) & 255)) << (c * 8);
      return out >>> 0;
    });
    const oracleLight = { location, type: values.LightType, effect: effect === 13 ? 13 : 0, brightness: values.LightBrightness,
      hue: values.LightHue ?? 0, saturation: values.LightSaturation ?? 0, radius: values.LightRadius ?? 0, specialLit: Boolean(values.bSpecialLit) };
    const bodyCase = { light: { ...oracleLight, rotation, cone }, facet: asBits(facet), grid: asBits(grid),
      rect: [rect.minU, rect.maxU, rect.minV, rect.maxV],
      constants: { rradius: u32(constants.rradius), rr2: u32(constants.rr2), incidence: u32(incidence) },
      table, static: texels, illumination: hex(illumination.bytes), ...(cylinder ? { address: 0x10b04a80 } : {}) };
    chain.push({ spot: spot || cylinder, cylinder, cases: { rects: { light: oracleLight, facet: asBits(facet) },
      incidence: { light: oracleLight, facet: asBits(facet), rradius: u32(constants.rradius) },
      colors: { brightness: values.LightBrightness, levelBrightness: u32(levelBrightness), hsv: hsv.map(u32) },
      [spot || cylinder ? 'spots' : 'spatial']: bodyCase },
      rect: [rect.minU, rect.maxU, rect.minV, rect.maxV], incidence: u32(incidence), table, spatial, merged,
      color: constants.color.map(u32) });
    texels = merged; used++;
  }
  if (used) surfaces++;
}
// The oracle's fixture heap is a bump allocator: send the steps in chunks.
const sines = [...rotationSineTable()].map(u32);
const nat = { ambient: runOracle({ ambient: second.ambient }).ambient, steps: [] };
let rsqrt = null;
for (let start = 0; start < chain.length; start += 300) {
  const steps = chain.slice(start, start + 300), keys = ['rects', 'incidence', 'colors', 'spatial', 'spots'];
  const input = { sqrtTable: true, normalTable: true, rsqrtTables: true, sines,
    ...Object.fromEntries(keys.map(key => [key, steps.map(step => step.cases[key]).filter(Boolean)])) };
  const part = runOracle(input), next = Object.fromEntries(keys.map(key => [key, 0]));
  rsqrt = part.rsqrtTables;
  for (const step of steps) nat.steps.push(Object.fromEntries(keys.filter(key => step.cases[key]).map(key => [key, part[key][next[key]++]])));
}
const ambientMismatch = nat.ambient.filter((word, i) => {
  const [r, g, b] = ambientTexel(fgetHsv(...zoneTriples[i]));
  return word >>> 0 !== (b | g << 8 | r << 16 | 0x7f000000) >>> 0;
}).length;
let chainMismatch = 0, spatialTexels = 0, litSpatial = 0;
const chainFirst = [];
const rsqrtJs = rsqrtTables();
const rsqrtMismatch = rsqrt ? rsqrt.mantissa.filter((v, i) => v !== u32(rsqrtJs.mantissa[i])).length
  + rsqrt.exponent.filter((v, i) => v !== u32(rsqrtJs.exponent[i])).length : 0;
let spots = 0, cylinders = 0;
const problemCounts = {}, problemTexels = { spatial: 0, merged: 0 };
chain.forEach((c, i) => {
  const problems = [], n = nat.steps[i];
  if (JSON.stringify(n.rects) !== JSON.stringify(c.rect)) problems.push('rect');
  if (n.incidence !== c.incidence) problems.push('incidence');
  if (n.colors.table.some((v, k) => (v >>> 0) !== c.table[k]) || n.colors.color.some((v, k) => v !== c.color[k])) problems.push('colour');
  const body = n.spatial ?? n.spots;
  if (body.spatial.some((v, k) => v !== c.spatial[k])) problems.push('spatial');
  if (n.spatial && n.spatial.merged.some((v, k) => ((v ^ c.merged[k]) & 0xffffff) !== 0)) problems.push('merged');
  for (const problem of problems) problemCounts[problem] = (problemCounts[problem] ?? 0) + 1;
  problemTexels.spatial += body.spatial.reduce((m, v, k) => m + (v !== c.spatial[k]), 0);
  if (n.spatial) problemTexels.merged += n.spatial.merged.reduce((m, v, k) => m + (((v ^ c.merged[k]) & 0xffffff) !== 0), 0);
  if (c.cylinder) cylinders++; else if (c.spot) spots++;
  spatialTexels += c.spatial.length; litSpatial += c.spatial.filter(Boolean).length;
  if (problems.length) { chainMismatch++; if (chainFirst.length < 5) chainFirst.push({ step: i, spot: c.spot, problems,
    spatialDiff: body.spatial.reduce((m, v, k) => m + (v !== c.spatial[k]), 0),
    sample: body.spatial.map((v, k) => [k, v, c.spatial[k]]).filter(([, a, b]) => a !== b).slice(0, 4) }); }
});
console.log(JSON.stringify({ zones: model.zones.length, ambient: zoneTriples.length, ambientMismatch, rsqrtMismatch,
  rsqrtMargin: rsqrtJs.margin, surfaces, lightSteps: chain.length, spots, cylinders, spatialTexels, litSpatial, chainMismatch,
  problemCounts, problemTexels, chainFirst }));
assert.equal(rsqrtMismatch, 0, 'x^-0.5 power tables match');
assert.equal(ambientMismatch, 0, 'ambient fill texels match');
assert.equal(chainMismatch, 0, 'static light rectangles, incidence, colour, spatial bytes and merges match');
if (assert.enabled) assert.report('validate-static-lighting');
else console.log(`validate-static-lighting: PASS (${mapName}: shadow table, ${cases.length} illumination masks, ${texels} texels; ` +
  `${zoneTriples.length} ambients; ${chain.length} static light steps on ${surfaces} surfaces, ${spatialTexels} texels)`);
