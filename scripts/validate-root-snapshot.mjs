/** RootWindow.GenerateSnapshot (native 1524), the pixel work, against the original (docs/root-snapshot.md): the method
 * XRootWindow::GenerateSnapshot (Extension.dll 0x10039410) runs unchanged under Unicorn (scripts/native-root-snapshot-oracle.py,
 * NATIVE_PROBE_PYTHON) over synthetic frames, with the render device's ReadPixels, GMalloc and the texture's storage as recorded
 * stand-ins. The same frames run through src/runtime/script-root-snapshot.mjs. Compared exactly: the P8 bytes, the grey palette
 * the method writes, the Init(U, V) the method asks for, and MaxColor. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {snapshotGrey, potCeiling} from '../src/runtime/script-root-snapshot.mjs';

let seed = 1524;
const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const byte = () => Math.floor(random() * 256);
const patterns = {
  noise: () => ((byte() | (byte() << 8) | (byte() << 16) | (byte() << 24)) >>> 0),
  low: () => (((byte() & 3) | ((byte() & 3) << 8) | ((byte() & 3) << 16)) >>> 0),          // small values: averages that sit on halves and thirds
  high: () => ((255 - (byte() & 3)) | ((255 - (byte() & 7)) << 8) | ((255 - (byte() & 1)) << 16)) >>> 0,
  flat: () => 0x00808080,
  black: () => 0,
  white: () => 0x00ffffff,
};
const gradient = (x, y, width) => ((x * 255 / width) | 0) | (((y * 3) & 255) << 8) | ((((x + y) * 5) & 255) << 16);
const geometry = [[40, 30, 16, 12], [37, 29, 20, 15], [100, 60, 64, 48], [64, 48, 64, 48], [30, 20, 60, 40], [97, 53, 10, 7], [200, 120, 50, 30],
  [123, 77, 40, 25], [50, 50, 1, 1], [50, 50, 3, 3], [33, 17, 33, 17], [33, 17, 32, 16], [31, 61, 20, 40], [128, 72, 65, 37], [1, 1, 1, 1], [2, 3, 5, 7],
  [50, 50, 0, 0], [160, 100, 40, 30]];
// Steps of 1.1, 1.2, 1.3 and 1.4 source pixels: the float32 accumulators land near whole pixels (k * 1.1 at k = 10, 20, ...), where a
// rounded add and an exact one truncate differently.
const accumulating = [[110, 110, 100, 100], [120, 120, 100, 100], [130, 130, 100, 100], [77, 77, 70, 70], [33, 33, 30, 30]];
const cases = [];
for (const [sizeX, sizeY, snapW, snapH] of accumulating) {
  cases.push({name: `noise ${sizeX}x${sizeY} -> ${snapW}x${snapH}`, sizeX, sizeY, snapW, snapH, pixels: Array.from({length: sizeX * sizeY}, patterns.noise)});
  cases.push({name: `gradient ${sizeX}x${sizeY} -> ${snapW}x${snapH}`, sizeX, sizeY, snapW, snapH,
    pixels: Array.from({length: sizeX * sizeY}, (_, i) => gradient(i % sizeX, Math.floor(i / sizeX), sizeX) >>> 0)});
}
for (const [sizeX, sizeY, snapW, snapH] of geometry) {
  for (const [name, make] of Object.entries(patterns)) {
    if (sizeX * sizeY > 20000 && name !== 'noise' && name !== 'low') continue;
    cases.push({name: `${name} ${sizeX}x${sizeY} -> ${snapW}x${snapH}`, sizeX, sizeY, snapW, snapH, pixels: Array.from({length: sizeX * sizeY}, make)});
  }
  if (sizeX * sizeY <= 20000)
    cases.push({name: `gradient ${sizeX}x${sizeY} -> ${snapW}x${snapH}`, sizeX, sizeY, snapW, snapH,
      pixels: Array.from({length: sizeX * sizeY}, (_, i) => gradient(i % sizeX, Math.floor(i / sizeX), sizeX) >>> 0)});
}
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const output = execFileSync(python, ['scripts/native-root-snapshot-oracle.py', gameDirectory()],
  {input: JSON.stringify({cases}), encoding: 'utf8', maxBuffer: 1 << 29});
const original = JSON.parse(output).results;

let mismatches = 0, compared = 0, differingBytes = 0;
const greyPalette = Buffer.alloc(1024);
for (let i = 0; i < 256; i++) greyPalette.writeUInt32LE((255 << 24 | i << 16 | i << 8 | i) >>> 0, i * 4);
cases.forEach((c, index) => {
  const expected = original[index];
  const actual = snapshotGrey(Uint32Array.from(c.pixels), c.sizeX, c.sizeY, c.snapW, c.snapH);
  const want = Buffer.from(expected.data, 'hex');
  const problems = [];
  if (actual.pitch !== expected.pitch || actual.height !== expected.height) problems.push(`size ${actual.pitch}x${actual.height} against ${expected.pitch}x${expected.height}`);
  if (!Buffer.from(actual.data).equals(want)) {
    const count = [...want].filter((v, i) => v !== actual.data[i]).length;
    problems.push(`${count} bytes differ`);
    differingBytes += count;
  }
  if (expected.palette !== greyPalette.toString('hex')) problems.push('palette is not the grey ramp');
  if (!expected.events.some(event => event[0] === 'Init' && event[1] === potCeiling(c.snapW) && event[2] === potCeiling(c.snapH)))
    problems.push(`Init(${potCeiling(c.snapW)}, ${potCeiling(c.snapH)}) not asked: ${JSON.stringify(expected.events.slice(0, 4))}`);
  if (expected.maxColor !== 0xffffffff) problems.push(`MaxColor ${expected.maxColor}`);
  compared++;
  if (problems.length) { mismatches++; if (mismatches <= 5) console.error(`${c.name}: ${problems.join('; ')}`); }
});
assert.equal(mismatches, 0, `${mismatches} of ${compared} cases differ from the original (${differingBytes} bytes)`);
console.log(JSON.stringify({cases: compared, mismatches, geometry: geometry.length + accumulating.length}));
