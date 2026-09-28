/** Stage 4: ordinary moving-light falloff against unchanged Render.dll code.
 * --reference-only records original cases before the browser translation is
 * exercised. See docs/moving-normal-lighting.md for the contract and limits. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { ClassDefaults } from '../src/unreal/classes.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { lightmapBasis } from '../src/unreal/lighting.mjs';
import { filterMovingLight, worldLightRadius } from '../src/runtime/dynamic-lighting.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), asset = await assets.get('00_Training'), map = decodeMap(asset.bytes);
const defaults = new ClassDefaults(assets), f = Math.fround, bits = new DataView(new ArrayBuffer(4));
const u32 = value => { bits.setFloat32(0, value, true); return bits.getUint32(0, true); };
const float = value => { bits.setUint32(0, value >>> 0, true); return bits.getFloat32(0, true); };
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
function original(cases, controlWord = '0x037f') {
  return JSON.parse(execFileSync(python, ['scripts/native-dynamic-light-oracle.py', root, controlWord],
    { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }));
}
const asBits = value => Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'clamp' ? v : v.map(u32)]));
const samples = [];
for (const actor of map.actors.filter(actor => actor.className === 'SecurityCamera')) {
  const values = await defaults.forActor(asset, actor);
  assert.equal(values.LightEffect ?? 0, 0);
  const light = { location: values.Location, radius: values.LightRadius, brightness: values.LightBrightness,
    hue: values.LightHue, saturation: values.LightSaturation, effect: 0 };
  const surfaces = filterMovingLight(map.model, light.location, worldLightRadius(values), values.bSpecialLit);
  for (const index of surfaces) {
    const surface = map.model.surfaces[index], lm = map.model.lightMaps[surface.lightMap];
    const basis = lightmapBasis(map.model, surface, lm), p00 = basis.point(0, 0);
    samples.push({ name: `${actor.name}/${index}`, light,
      facet: { origin: map.model.points[surface.base], axisU: map.model.vectors[surface.textureU],
        axisV: map.model.vectors[surface.textureV], normal: map.model.vectors[surface.normal],
        pan: lm.pan.slice(0, 2), scale: lm.scale, clamp: lm.clamp },
      grid: { start: p00.map(f), stepU: basis.point(1, 0).map((v, i) => f(v - p00[i])),
        stepV: basis.point(0, 1).map((v, i) => f(v - p00[i])) } });
  }
}
assert.ok(samples.length > 0, 'authored camera lights reach original Training lightmaps');
const authored = samples.length;
// Small controlled grids isolate native branches and integer recurrence. These
// are mathematical fixtures, not claims that these scenes occur in the game.
for (const [name, location, illumination, grid, rect] of [
  ['center', [0, 0, 8], 127], ['coplanar', [0, 0, 0], 127],
  ['backside', [0, 0, -8], 127], ['zero-mask', [0, 0, 8], 0],
  ['full-mask', [0, 0, 8], 255], ['radius-edge', [0, 0, 24.999], 127],
  ['outside-radius', [0, 0, 26], 127],
  ['oblique-subrect', [1.3, -2.7, 9.1], 127,
    { start: [-20.25, -19.5, 0], stepU: [5.5, 1.25, 0], stepV: [-1.125, 5.75, 0] }, [2, 8, 1, 7]],
]) {
  samples.push({ name, light: { location: location.map(f), radius: 0, brightness: 211, hue: 32, saturation: 140, effect: 0 },
    facet: { origin: [0, 0, 0], axisU: [1, 0, 0], axisV: [0, 1, 0], normal: [0, 0, 1],
      pan: [-20, -20], scale: [5, 5], clamp: [9, 9] },
    grid: grid ?? { start: [-20, -20, 0], stepU: [5, 0, 0], stepV: [0, 5, 0] },
    rect: rect ?? [0, 9, 0, 9], illumination });
}
const constants = original({ radii: samples.map(s => s.light.radius),
  hsv: samples.map(s => [s.light.hue, s.light.saturation, 255]), sqrtTable: true,
  rects: samples.map(s => ({ light: s.light, facet: asBits(s.facet) })) });
const factors = original({ incidence: samples.map((s, i) => ({ light: s.light, facet: asBits(s.facet), rradius: constants.radii[i][1] })),
  colors: samples.map((s, i) => ({ brightness: s.light.brightness, levelBrightness: u32(1), hsv: constants.hsv[i] })) });
const cases = { normalTable: true, spatial: samples.map((s, i) => {
  const [width, height] = s.facet.clamp;
  const staticTexels = Array.from({ length: width * height }, (_, p) => {
    const x = p % width, y = Math.floor(p / width);
    return (0x7f000000 | ((x * 7 + y * 13) % 128) | (((x * 3 + y * 5) % 128) << 8) | (((x + y * 11) % 128) << 16)) >>> 0;
  });
  return { light: s.light, facet: asBits(s.facet), grid: asBits(s.grid), rect: s.rect ?? constants.rects[i],
    constants: { rradius: constants.radii[i][1], rr2: constants.radii[i][2], incidence: factors.incidence[i] },
    table: factors.colors[i].table, static: staticTexels, illumination: s.illumination ?? 127 };
}) };
const reference = original(cases);
if (process.argv.includes('--reference-only')) {
  await writeFile('.cache/stage4-normal-original.json', JSON.stringify({ cases, reference }));
  console.log(`Original reference recorded: ${authored} Training surfaces, ${samples.length - authored} boundary grids, ` +
    `${reference.normalTable.length} table entries, ${reference.spatial.reduce((n, s) => n + s.spatial.length, 0)} texels.`);
  process.exit(0);
}
const { normalLightTable, normalLightIncidence, normalLightSpatial } = await import('../src/runtime/dynamic-lighting.mjs');
assert.deepEqual([...normalLightTable()].map(u32), reference.normalTable, 'all normal falloff table bits');
let lit = 0, texels = 0;
for (let i = 0; i < samples.length; i++) {
  const s = samples[i], c = cases.spatial[i], expected = reference.spatial[i];
  const constants = { rradius: float(c.constants.rradius), rr2: float(c.constants.rr2) };
  const incidence = normalLightIncidence(s.light.location, s.facet, constants.rradius);
  assert.equal(u32(incidence), c.constants.incidence, `${s.name}: incidence bits`);
  const [width, height] = s.facet.clamp, spatial = new Array(width * height).fill(0);
  const [minU, maxU, minV, maxV] = c.rect;
  normalLightSpatial({ minU, maxU, minV, maxV }, s.grid, s.light.location, { ...constants, incidence },
    (u, v, byte) => { spatial[v * width + u] = byte; }, c.illumination);
  assert.deepEqual(spatial, expected.spatial, `${s.name}: original spatial bytes`);
  const merged = c.static.map((value, p) => {
    const u = p % width, v = Math.floor(p / width);
    if (u < minU || u >= maxU || v < minV || v >= maxV) return value & 0xffffff;
    const entry = c.table[spatial[p]];
    let rgb = 0;
    for (let channel = 0; channel < 3; channel++) {
      const shift = channel * 8;
      rgb |= Math.min(127, ((value >>> shift) & 255) + ((entry >>> shift) & 255)) << shift;
    }
    return rgb;
  });
  assert.deepEqual(merged, expected.merged.map(v => v & 0xffffff), `${s.name}: original merged RGB`);
  texels += spatial.length; lit += spatial.filter(Boolean).length;
}
assert.ok(lit > 0);
const single = original(cases, '0x007f');
console.log(JSON.stringify({ authoredSurfaces: authored, boundaryGrids: samples.length - authored,
  tableEntries: reference.normalTable.length, texels, lit, mismatches: 0,
  singlePrecisionDifferences: { table: single.normalTable.filter((v, i) => v !== reference.normalTable[i]).length,
    spatial: single.spatial.reduce((n, s, i) => n + s.spatial.filter((v, p) => v !== reference.spatial[i].spatial[p]).length, 0) } }));
