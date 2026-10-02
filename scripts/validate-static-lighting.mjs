/** Compare src/runtime/static-lighting.mjs with the original Render.dll
 * static-light path (scripts/native-dynamic-light-oracle.py): the shadow
 * table and every shadow mask's illumination bytes on a map's BSP light maps.
 * Requires the local install and NATIVE_PROBE_PYTHON (default
 * .cache/native-probe-env). docs/static-lighting.md records the scope.
 *
 *   node scripts/validate-static-lighting.mjs [--map 00_Training] [--every 1]
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { shadowTable, shadowIllumination } from '../src/runtime/static-lighting.mjs';
import { gameDirectory } from './game-directory.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const mapName = option('map', '00_Training'), every = Number(option('every', 1));
const assets = new AssetStore(files), map = decodeMap((await assets.get(mapName)).bytes), model = map.model;
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const runOracle = cases => JSON.parse(execFileSync(python, ['scripts/native-dynamic-light-oracle.py', root],
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
console.log(`validate-static-lighting: PASS (${mapName}: shadow table, ${cases.length} illumination masks, ${texels} texels)`);
