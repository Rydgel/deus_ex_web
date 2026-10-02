// Volumetric fog maps (docs/volumetric-fog.md): src/runtime/volumetric-fog.mjs
// against unchanged Render.dll code (native-volumetric-fog-oracle.py) —
// ComputeFromActor's volumetric constants and colour table, and SetupForSurf's
// fog loop (first light written from its table, later lights merged through
// the attenuation table) over random frames, light-map grids and 1-3 lights,
// with the early-out flag carried in either state. Compared bit-exactly:
// every light field and table byte, every fog texel and the final flag.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { gameDirectory } from './game-directory.mjs';
import { getAxes } from '../src/runtime/camera.mjs';
import { coordsTransform, volumetricLight, fogMap, sortVolumetricLights } from '../src/runtime/volumetric-fog.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const f = Math.fround, io = new DataView(new ArrayBuffer(4));
const bits = v => (io.setFloat32(0, v, true), io.getUint32(0, true));
let seed = 0x5eed1234;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const between = (a, b) => f(a + (b - a) * random());
const vec = (c, s) => c.map(v => f(v + between(-s, s)));
const int = n => Math.floor(random() * n);

const cases = [], js = [];
for (let c = 0; c < 120; c++) {
  const surface = [between(-3000, 3000), between(-3000, 3000), between(-1000, 1000)];
  const eye = vec(surface, c % 4 === 0 ? 120 : 900);
  const [x, y, z] = getAxes([int(65536) - 32768, int(65536), c % 5 === 0 ? int(65536) : 0]);
  const coords = { origin: eye, x, y, z };
  const spacing = [16, 32, 8][c % 3], width = 1 + int(c % 7 === 0 ? 40 : 18), height = 1 + int(14);
  const u = getAxes([int(65536) - 32768, int(65536), 0])[0].map(v => f(v * spacing));
  const v = getAxes([int(65536) - 32768, int(65536), 0])[1].map(w => f(w * spacing));
  const grid = { base: surface.map(f), stepU: u, stepV: v };
  const lightInputs = Array.from({ length: 1 + (c % 3) }, (_, k) => {
    const world = vec(surface, c % 6 === 1 ? 40 : 400);
    return { location: coordsTransform(world, coords), color: [between(0, 1.4), between(0, 1.4), between(0, 1.4)],
      brightness: between(0, 1), volumeRadius: c % 11 === 3 ? 255 : 1 + int(k ? 40 : 24),
      volumeBrightness: c % 9 === 4 ? 0 : int(256), volumeFog: int(256) };
  });
  const lights = lightInputs.map(volumetricLight);
  const sorted = sortVolumetricLights(lights), order = sorted.map(light => lights.indexOf(light));
  const missFlag = c % 2;
  cases.push({ coords: [...eye, ...x, ...y, ...z].map(bits), grid: { base: grid.base.map(bits), stepU: u.map(bits), stepV: v.map(bits) },
    width, height, missFlag, order, lights: lightInputs.map(l => ({ ...l, location: l.location.map(bits), color: l.color.map(bits),
      brightness: bits(l.brightness) })) });
  const state = { missFlag };
  js.push({ lights, texels: fogMap({ grid, width, height, coords, lights, state }), state });
}
const reference = JSON.parse(execFileSync(python, ['scripts/native-volumetric-fog-oracle.py', gameDirectory()],
  { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 1 << 28 }));

let texels = 0, lit = 0, merged = 0, inside = 0;
cases.forEach((c, i) => {
  const expected = reference[i], actual = js[i];
  expected.lights.forEach((e, k) => {
    const a = actual.lights[k], where = `case ${i} light ${k}`;
    for (const name of ['fog', 'radius', 'radiusSq', 'brightness', 'distanceSq', 'invRadius', 'invRadiusSq'])
      assert.equal(bits(a[name]), e[name], `${where}: ${name}`);
    assert.equal(a.inside ? 1 : 0, e.inside, `${where}: inside`);
    assert.equal(e.tableAt, 0x10, `${where}: table follows the 16-byte colour key`);
    assert.deepEqual([...a.table], e.table, `${where}: colour table`);
    if (a.inside) inside++;
  });
  assert.deepEqual([...actual.texels], expected.texels, `case ${i}: fog texels`);
  assert.equal(actual.state.missFlag, expected.missFlag, `case ${i}: early-out flag`);
  texels += c.width * c.height;
  for (let t = 3; t < expected.texels.length; t += 4) if (expected.texels[t]) lit++;
  if (c.lights.length > 1) merged++;
});
assert.ok(lit > 2000 && merged > 50 && inside > 3, 'cases reach fogged texels, merges and inside-volume lights');
console.log(`Volumetric fog: ${cases.length} surfaces, ${texels} texels (${lit} fogged), ${merged} with merged lights, ${inside} inside-volume lights match the original Render.dll.`);
