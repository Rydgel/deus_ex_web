/** Compare src/runtime/dynamic-lighting.mjs with the original Render.dll and
 * Engine.dll moving-light path (scripts/native-dynamic-light-oracle.py) on
 * Training's BSP: the square-root table, all 256 light radii, FGetHSV, the
 * colour table, FDynamicLight::Filter, the texel rectangle and the
 * NonIncidence spatial bytes merged onto static texels. Requires the local
 * install and NATIVE_PROBE_PYTHON (default .cache/native-probe-env).
 * docs/dynamic-lighting.md records what this does and does not establish. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { lightColor, lightmapBasis } from '../src/unreal/lighting.mjs';
import { filterMovingLight, movingLightConstants, movingLightRect, nonIncidenceSpatial, colorTableEntry,
  squareRootTable, worldLightRadius, fgetHsv } from '../src/runtime/dynamic-lighting.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), asset = await assets.get('00_Training'), map = decodeMap(asset.bytes);
const model = map.model;
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const bits = new DataView(new ArrayBuffer(4));
const u32 = value => { bits.setFloat32(0, value, true); return bits.getUint32(0, true); };
const float = value => { bits.setUint32(0, value >>> 0, true); return bits.getFloat32(0, true); };

// AugLight Beams: b1 radius byte(size*5.12+4) in 4..9, brightness 192; b2
// radius 4, brightness 220; hue 32, saturation 140 (AugLight.BeginState).
// Positions: Beam0/Beam1 from a live F12 probe at PlayerStart1, points in
// the darkdoor maze, and seeded points across the level bounds.
let seed = 12345;
const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (const point of model.points) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], point[i]); max[i] = Math.max(max[i], point[i]); }
const lights = [
  { location: [-284.5, 825.84, -40.2], radius: 8, brightness: 192 },
  { location: [-1119.24, 825.84, -40.2], radius: 4, brightness: 220 },
  { location: [4360, 848, -120], radius: 9, brightness: 192 },
  { location: [4600, 700, -100], radius: 6, brightness: 192 },
  { location: [4860, 544, -120], radius: 5, brightness: 220 },
  { location: [4700, 620, -60], radius: 9, brightness: 192, specialLit: true },
];
for (let i = 0; i < 10; i++)
  lights.push({ location: min.map((lo, axis) => Math.fround(lo + random() * (max[axis] - lo))),
    radius: 4 + Math.floor(random() * 6), brightness: 192 });
for (const light of lights) { light.location = light.location.map(Math.fround); Object.assign(light, { hue: 32, saturation: 140, effect: 13, type: 1 }); }

const facetOf = surfaceIndex => {
  const surface = model.surfaces[surfaceIndex], lm = model.lightMaps[surface.lightMap];
  const basis = lightmapBasis(model, surface, lm);
  const facet = { origin: model.points[surface.base], axisU: model.vectors[surface.textureU],
    axisV: model.vectors[surface.textureV], normal: model.vectors[surface.normal],
    pan: [lm.pan[0], lm.pan[1]], scale: lm.scale, clamp: lm.clamp };
  const p00 = basis.point(0, 0), p10 = basis.point(1, 0), p01 = basis.point(0, 1);
  const grid = { start: p00.map(Math.fround), stepU: p10.map((v, i) => Math.fround(v - p00[i])),
    stepV: p01.map((v, i) => Math.fround(v - p00[i])) };
  return { facet, grid };
};
const staticTexel = (x, y) => (((x * 7 + y * 13) % 128) | (((x * 3 + y * 5) % 128) << 8) | (((x + y * 11) % 128) << 16) | 0x7f000000) >>> 0;

// JavaScript side.
const hsvCases = [[32, 140, 255]];
for (let hue = 0; hue < 256; hue++) for (const saturation of [0, 64, 100, 140, 200, 255]) hsvCases.push([hue, saturation, 255]);
for (let value = 0; value < 256; value++) hsvCases.push([32, 140, value], [170, 30, value]);
const js = { filters: [], rects: [], spatial: [] };
const cases = { sqrtTable: true, radii: [...Array(256).keys()], hsv: hsvCases, colors: [], rects: [], spatial: [],
  model: { nodes: model.nodes.map(n => [...n.plane, n.surface, n.back, n.front, n.coplanar]),
    surfaces: model.surfaces.map(s => [s.flags >>> 0, s.lightMap]), lightMaps: model.lightMaps.length },
  filters: [] };
let native = runOracle({ hsv: hsvCases });
const hsvBits = native.hsv;
for (const light of lights) {
  const radius = worldLightRadius({ LightRadius: light.radius });
  const surfaces = [...filterMovingLight(model, light.location, radius, light.specialLit)].sort((a, b) => a - b);
  js.filters.push(surfaces);
  cases.filters.push(light);
  const hsv = hsvBits[0].map(float);
  const constants = movingLightConstants({ LightRadius: light.radius, LightBrightness: light.brightness }, 1, hsv);
  cases.colors.push({ brightness: light.brightness, levelBrightness: u32(1), hsv: hsvBits[0] });
  const table = [...Array(256).keys()].map(i => (colorTableEntry(constants.steps[2], i) |
    (colorTableEntry(constants.steps[1], i) << 8) | (colorTableEntry(constants.steps[0], i) << 16) | 0xff000000) >>> 0);
  for (const surfaceIndex of surfaces) {
    const { facet, grid } = facetOf(surfaceIndex);
    const rect = movingLightRect(light.location, constants.radius, facet);
    js.rects.push([rect.minU, rect.maxU, rect.minV, rect.maxV]);
    const oracleFacet = { origin: facet.origin.map(u32), axisU: facet.axisU.map(u32), axisV: facet.axisV.map(u32),
      normal: facet.normal.map(u32), pan: facet.pan.map(u32), scale: facet.scale.map(u32), clamp: facet.clamp };
    cases.rects.push({ light, facet: oracleFacet });
    const [width, height] = facet.clamp, spatial = new Array(width * height).fill(0);
    nonIncidenceSpatial(rect, grid, light.location, constants, (u, v, value) => { spatial[v * width + u] = value; });
    const staticTexels = [], merged = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const texel = staticTexel(x, y); staticTexels.push(texel);
      const inside = x >= rect.minU && x < rect.maxU && y >= rect.minV && y < rect.maxV;
      if (!inside) { merged.push(texel); continue; }
      const entry = table[spatial[y * width + x]];
      let out = 0;
      for (let c = 0; c < 3; c++) out |= Math.min(127, ((texel >>> (c * 8)) & 0xff) + ((entry >>> (c * 8)) & 0xff)) << (c * 8);
      merged.push(out);
    }
    js.spatial.push({ spatial, merged });
    cases.spatial.push({ light, facet: oracleFacet, grid: { start: grid.start.map(u32), stepU: grid.stepU.map(u32),
      stepV: grid.stepV.map(u32) }, rect: [rect.minU, rect.maxU, rect.minV, rect.maxV],
    constants: { rradius: u32(constants.rradius), rr2: u32(constants.rr2) }, table, static: staticTexels });
  }
}

function runOracle(input, controlWord = '0x037f') {
  return JSON.parse(execFileSync(python, ['scripts/native-dynamic-light-oracle.py', root, controlWord],
    { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 1 << 30 }));
}

function compare(native, label) {
  const report = { label, controlWord: native.controlWord };
  const table = squareRootTable();
  report.sqrtTable = native.sqrtTable.filter((value, i) => value !== table[i]).length;
  report.radii = native.radii.filter((value, radius) => {
    const c = movingLightConstants({ LightRadius: radius, LightBrightness: 1 }, 1, [0, 0, 0]);
    return value[0] !== u32(c.radius) || value[1] !== u32(c.rradius) || value[2] !== u32(c.rr2);
  }).length;
  report.colors = native.colors.filter((value, i) => {
    const input = cases.colors[i], c = movingLightConstants({ LightRadius: 1, LightBrightness: input.brightness },
      float(input.levelBrightness), input.hsv.map(float));
    const entries = [...Array(256).keys()].map(s => colorTableEntry(c.steps[2], s) | (colorTableEntry(c.steps[1], s) << 8) |
      (colorTableEntry(c.steps[0], s) << 16) | 0xff000000);
    return value.color.some((v, k) => v !== u32(c.color[k])) || value.table.some((v, k) => (v >>> 0) !== (entries[k] >>> 0));
  }).length;
  report.filters = native.filters.filter((value, i) => JSON.stringify(value.surfaces) !== JSON.stringify(js.filters[i])).length;
  report.filterSurfaces = native.filters.reduce((n, value) => n + value.surfaces.length, 0);
  report.rects = native.rects.filter((value, i) => JSON.stringify(value) !== JSON.stringify(js.rects[i])).length;
  let texels = 0, spatialDiff = 0, mergedDiff = 0;
  native.spatial.forEach((value, i) => {
    texels += value.spatial.length;
    value.spatial.forEach((byte, k) => { if (byte !== js.spatial[i].spatial[k]) spatialDiff++; });
    value.merged.forEach((texel, k) => { if (((texel ^ js.spatial[i].merged[k]) & 0xffffff) !== 0) mergedDiff++; });
  });
  Object.assign(report, { surfaces: native.spatial.length, texels, spatialDiff, mergedDiff,
    litTexels: js.spatial.reduce((n, s) => n + s.spatial.filter(Boolean).length, 0) });
  report.hsv = native.hsv.length;
  report.hsvDiff = native.hsv.filter((value, i) => fgetHsv(...hsvCases[i]).some((c, k) => u32(c) !== value[k])).length;
  // The static path's double-precision lighting.mjs lightColor, measured only.
  report.lightColorDiff = native.hsv.filter((value, i) => lightColor(...hsvCases[i]).some((c, k) => u32(c) !== value[k])).length;
  return report;
}

native = runOracle(cases);
const extended = compare(native, 'extended precision (0x037f)');
const single = compare(runOracle(cases, '0x007f'), 'single precision (0x007f)');
console.log(JSON.stringify([extended, single], null, 1));
assert.equal(extended.sqrtTable, 0, 'square-root table matches the native initializer');
assert.equal(extended.radii, 0, 'radius, reciprocal and 4093/R^2 match for every LightRadius byte');
assert.equal(extended.colors, 0, 'brightness, colour and colour table match');
assert.equal(extended.hsvDiff, 0, 'FGetHSV matches for every hue and brightness byte sampled');
assert.equal(extended.filters, 0, 'FDynamicLight::Filter reaches the same surfaces');
assert.ok(extended.filterSurfaces > 50, 'filter cases reach real Training surfaces');
assert.equal(extended.rects, 0, 'texel rectangles match');
assert.equal(extended.spatialDiff, 0, 'NonIncidence spatial bytes match');
assert.equal(extended.mergedDiff, 0, 'merged texels match');
assert.ok(extended.litTexels > 1000, 'cases light a meaningful number of texels');
console.log(`Original moving-light path: ${extended.filterSurfaces} filtered surfaces, ${extended.surfaces} rectangles, ` +
  `${extended.texels} texels (${extended.litTexels} lit) match under the extended control word.`);
