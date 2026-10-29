/** Original Engine frame producers, with Core appTan measured on real x87.
 * Captures remain in .cache. No browser camera or JS Math.tan reference.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {buildWindowSceneFrame, writeWindowSceneFrame, sceneFrameMeasuredFovs} from '../src/runtime/script-window-scene-frame.mjs';
import {x87storeDouble, setX87Precision} from '../src/runtime/script-vm.mjs';

const samples = sceneFrameMeasuredFovs.map(fov => ({name: `neutral-${fov}`,
  location: [0, 0, 0], rotation: [0, 0, 0], width: 640, height: 480, fov}));
for (const [i, [rotation, location, size]] of [
  [[16384, 0, 0], [1, 2, 3], [1280, 720]],
  [[0, 16384, 0], [-20.5, 202.25, 0], [1920, 1080]],
  [[0, 0, 16384], [0, 0, 40], [801, 601]],
  [[13579, -23645, 32001], [1000.125, -1024.5, 57.3], [1365, 767]],
  [[-300000, 650000, -271234], [5e-6, -1000.1, 3000.5], [1, 1]],
  [[2147483647, -2147483648, -1], [-0, 0, 0], [16777217, 16777219]],
  [[4, 8, 12], [Math.PI, 1e-30, -1e30], [320, 200]],
].entries()) samples.push({name: `transform-${i}`, rotation, location,
  width: size[0], height: size[1], fov: i % 2 ? 75 : 90});
samples.push({...samples[10], name: 'external-appTan-fractional', fov: 72.25, externalTan: true});
// The render pass: XRootWindow::PreRender runs ComputeRenderSize again at
// precision control 24 on the (possibly clipped) frame (Extension 0x1003a8cd,
// docs/render-pass-precision.md "UnrealScript in the render pass"). Every
// sample takes it at its own size; four more at clipped sizes and the FOVs
// Play meets.
for (const sample of samples) sample.pass = [sample.width, sample.height];
for (const [fov, size] of [[75, [1004, 600]], [90, [1024, 640]], [75, [1920, 1080]], [120, [1365, 767]]])
  samples.push({name: `pass-${fov}-${size.join('x')}`, location: [0, 0, 0], rotation: [0, 0, 0], width: size[0] + 20, height: size[1] + 40,
    fov, pass: size});

// The last rotation's rows and the last size's values are kept (script-window-scene-frame.mjs `viewRotationRows`, `sizeKept`): a call
// with other inputs in between, and one straight after, give each result unchanged, at the game thread's precision control and the
// render pass's.
for (const precision of [64, 24]) {
  const previous = setX87Precision(precision);
  try {
    for (const sample of samples.filter(sample => !sample.externalTan)) {
      const first = buildWindowSceneFrame(sample);
      buildWindowSceneFrame({location: [1, 2, 3], rotation: [5, 6, 7], width: 33, height: 44, fov: 90});
      assert.deepStrictEqual(buildWindowSceneFrame(sample), first, `${sample.name} after other inputs at precision ${precision}`);
      assert.deepStrictEqual(buildWindowSceneFrame(sample), first, `${sample.name} straight after at precision ${precision}`);
    }
  } finally { setX87Precision(previous); }
}

const io = new DataView(new ArrayBuffer(8));
const bits32 = value => (io.setFloat32(0, value, true), io.getUint32(0, true));
const bits64 = value => (io.setFloat64(0, value, true), io.getBigUint64(0, true).toString(16).padStart(16, '0'));
const number64 = hex => (io.setBigUint64(0, BigInt(`0x${hex}`), true), io.getFloat64(0, true));
const argumentsByFov = new Map(), passArgumentsByFov = new Map();
for (const sample of samples) buildWindowSceneFrame({...sample,
  appTan: argument => (argumentsByFov.set(sample.fov, bits64(argument)), 1)});
const atPass = run => { const previous = setX87Precision(24); try { return run(); } finally { setX87Precision(previous); } };
for (const sample of samples) atPass(() => buildWindowSceneFrame({...sample, width: sample.pass[0], height: sample.pass[1],
  appTan: argument => (passArgumentsByFov.set(sample.fov, bits64(argument)), 1)}));

const wine = process.env.X87_PROBE_WINE || '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine';
const cc = process.env.X87_PROBE_CC || 'i686-w64-mingw32-gcc';
const skip = reason => {console.log(`SKIP validate-window-scene-frame: ${reason}`); process.exit(0);};
if (!existsSync(wine)) skip(`real-x87 runner missing at ${wine}`);
try {execFileSync('which', [cc], {stdio: 'ignore'});} catch {skip(`missing compiler ${cc}`);}
const capture = path.resolve('.cache/window-scene-frame');
mkdirSync(capture, {recursive: true});
const executable = path.join(capture, 'tangent-probe.exe');
execFileSync(cc, ['-O1', '-o', executable, path.resolve('tools/x87-transcendental-probe.c')], {timeout: 30000});
const input = [...new Set([...argumentsByFov.values(), ...passArgumentsByFov.values()])].join('\n') + '\n';
const csv = execFileSync(wine, [executable, '--double-tan'], {input, encoding: 'utf8', timeout: 30000,
  env: {...process.env, CX_BOTTLE: process.env.X87_PROBE_BOTTLE || 'DeusEx'}});
writeFileSync(path.join(capture, 'tangent-inputs.txt'), input);
writeFileSync(path.join(capture, 'tangent-hardware.csv'), csv);
const tangents = {};
for (const line of csv.trim().split(/\r?\n/)) {
  const [argument, , significand, signExponent] = line.split(',');
  const se = parseInt(signExponent, 16), sig = BigInt(`0x${significand}`);
  assert.ok((sig & 0x7ffn) !== 0n, 'FPTAN output must retain real extended precision');
  const result = x87storeDouble({neg: se >> 15, sig, exp: (se & 0x7fff) - 16383 - 63});
  tangents[argument] = bits64((result.neg ? -1 : 1) * Number(result.sig) * 2 ** result.exp);
}
assert.equal(Object.keys(tangents).length, new Set([...argumentsByFov.values(), ...passArgumentsByFov.values()]).size);
const request = {gameRoot: gameDirectory(), tangents, samples};
const originalText = execFileSync(process.env.NATIVE_PROBE_PYTHON || path.resolve('.cache/native-probe-env/bin/python'),
  [path.resolve('scripts/native-window-scene-frame-oracle.py')],
  {input: JSON.stringify(request), encoding: 'utf8', timeout: 30000, maxBuffer: 2 ** 20});
writeFileSync(path.join(capture, 'original-input.json'), JSON.stringify(request));
writeFileSync(path.join(capture, 'original.json'), originalText);
const original = JSON.parse(originalText);
assert.deepEqual(original.viewCoords, [0, 0, 0, 0, 1, 0, 0, 0, -1, 1, 0, 0]);
let passDiffers = 0;
for (const [index, sample] of samples.entries()) {
  const appTan = sample.externalTan ? argument => number64(tangents[bits64(argument)]) : undefined;
  const frame = {};
  const W = {setI32: (o, offset, value) => {o[offset] = value | 0;},
    setF32: (o, offset, value) => {o[offset] = Math.fround(value);}};
  writeWindowSceneFrame(W, frame, {...sample, appTan});
  assert.deepEqual(Array.from({length: 12}, (_, i) => bits32(frame[0x34 + i * 4])),
    original.results[index].coordsBits, `${sample.name}: coords`);
  assert.deepEqual([0xb8, 0xbc, 0xc8, 0xcc, 0xdc].map(offset => bits32(frame[offset])),
    original.results[index].sizeBits, `${sample.name}: size/projection`);
  assert.equal(frame[0xa8], sample.width); assert.equal(frame[0xac], sample.height);
  assert.deepEqual(original.results[index].tangentCalls, [argumentsByFov.get(sample.fov)]);
  assert.equal(original.results[index].rendererCallbacks, 1);
  // The render pass's ComputeRenderSize at 24 bits, with the default appTan
  // model (x87-tan.md) against the hardware tangent of the 24-bit argument;
  // the coordinates stay CreateMasterFrame's.
  const result = original.results[index];
  assert.deepEqual(result.passTangentCalls, [passArgumentsByFov.get(sample.fov)], `${sample.name}: pass appTan argument`);
  assert.equal(result.passRendererCallbacks, 1);
  const passFrame = {};
  atPass(() => writeWindowSceneFrame(W, passFrame, {...sample, width: sample.pass[0], height: sample.pass[1]}));
  assert.deepEqual(Array.from({length: 12}, (_, i) => bits32(passFrame[0x34 + i * 4])), result.passCoordsBits, `${sample.name}: pass coords`);
  assert.deepEqual([0xb8, 0xbc, 0xc8, 0xcc, 0xdc].map(offset => bits32(passFrame[offset])), result.passSizeBits,
    `${sample.name}: pass size/projection at 24 bits`);
  if (result.passSizeBits[4] !== result.sizeBits[4] && sample.pass[0] === sample.width) passDiffers++;
}
// The default tangent leaf (docs/x87-tan.md) admits the external FOV and
// reproduces the original projection without the measured service.
const external = samples.findIndex(sample => sample.externalTan);
assert.equal(bits32(buildWindowSceneFrame(samples[external]).projectionZ), original.results[external].sizeBits[4],
  'default appTan model: external FOV projection');
for (const renderMode of [13, 14, 15])
  assert.throws(() => buildWindowSceneFrame({...samples[0], renderMode}), /Orthographic/);
console.log(`Window scene frame: ${samples.length} original Engine cases (each also through the render pass's ComputeRenderSize at 0x007f; `
  + `${passDiffers} projections differ from 0x037f at the same size), ${Object.keys(tangents).length} real-x87 appTan qwords, all consumed fields bit-exact`);
