// Fire.dll's UFireTexture::ConstantTimeTick against fire-texture.mjs. The
// oracle (native-fire-texture-oracle.py) runs the hash-pinned DLL on
// fabricated textures and module state; after every tick the pixels, the
// sparks, the fields and the random generator must match byte for byte.
//
//   node scripts/validate-native-fire-texture.mjs [--only name-regex]
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {fireConstantTimeTick} from '../src/runtime/fire-texture.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const only = option('only', null);
let seed = 0xf12e;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
const bytes = (n, f = () => random() & 255) => Uint8Array.from({length: n}, f);
const hex = array => Buffer.from(array).toString('hex');
const unhex = text => Uint8Array.from(Buffer.from(text, 'hex'));

function makeCase(name, {uBits, vBits, rising = 1, sparks = [], ticks = 4, fields = {}, pixels = null, renderTable = null}) {
  const uSize = 1 << uBits, vSize = 1 << vBits;
  const sine = bytes(256), sineClamped = bytes(256), sineSigned = bytes(256);
  return {name, ticks, pentiumPro: 1,
    sine: hex(sine), sineClamped: hex(sineClamped), sineSigned: hex(sineSigned),
    random: hex(bytes(512)), randomIndex: (random() & 0xff) & 0xfc,
    renderTable: hex(renderTable ?? bytes(1028)), pixels: hex(pixels ?? bytes(uSize * vSize)),
    sparks: hex(Uint8Array.from(sparks.flat())),
    fields: {UBits: uBits, VBits: vBits, USize: uSize, VSize: vSize, UMask: uSize - 1, VMask: vSize - 1,
      GlobalPhase: random() & 0xffff, AuxPhase: random() & 255, FX_Frequency: random() & 255, bRising: rising,
      SparksLimit: Math.max(4, sparks.length), ActiveSparkNum: sparks.length, StarStatus: 0, ...fields}};
}

const cases = [];
for (const [uBits, vBits] of [[3, 3], [4, 3], [3, 5], [5, 5], [6, 4], [4, 7]])
  for (const rising of [1, 0])
    for (const pentiumPro of [1, 0])
      cases.push({...makeCase(`update ${rising ? 'rising' : 'still'} ${pentiumPro ? 'ppro' : 'p5'} ${1 << uBits}x${1 << vBits}`,
        {uBits, vBits, rising}), pentiumPro});
const selected = only ? cases.filter(c => new RegExp(only).test(c.name)) : cases;

const dir = path.resolve('reports/rendering');
await mkdir(dir, {recursive: true});
const casesPath = path.join(dir, 'fire-texture-cases.json');
await writeFile(casesPath, JSON.stringify(selected));
const {stdout} = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  ['scripts/native-fire-texture-oracle.py', gameDirectory(), casesPath], {maxBuffer: 512 * 1024 * 1024});
const native = JSON.parse(stdout);

const mismatches = [];
selected.forEach((c, i) => {
  const globals = {sine: unhex(c.sine), sineClamped: unhex(c.sineClamped), sineSigned: unhex(c.sineSigned),
    random: new DataView(unhex(c.random).buffer), randomIndex: c.randomIndex};
  const f = c.fields;
  const texture = {uBits: f.UBits, uSize: f.USize, vSize: f.VSize, uMask: f.UMask, vMask: f.VMask,
    globalPhase: f.GlobalPhase, auxPhase: f.AuxPhase, fxFrequency: f.FX_Frequency, bRising: f.bRising,
    sparksLimit: f.SparksLimit, activeSparkNum: f.ActiveSparkNum, starStatus: f.StarStatus,
    sparks: unhex(c.sparks), renderTable: unhex(c.renderTable), pixels: unhex(c.pixels)};
  try {
    native.results[i].steps.forEach((expected, step) => {
      fireConstantTimeTick(texture, globals);
      const where = `${c.name} tick ${step}`;
      assert.equal(hex(texture.pixels), expected.pixels, `${where}: pixels`);
      assert.equal(hex(texture.sparks.subarray(0, expected.sparks.length / 2)), expected.sparks, `${where}: sparks`);
      assert.equal(texture.globalPhase, expected.fields.GlobalPhase, `${where}: GlobalPhase`);
      assert.equal(texture.auxPhase, expected.fields.AuxPhase, `${where}: AuxPhase`);
      assert.equal(texture.activeSparkNum, expected.fields.ActiveSparkNum, `${where}: ActiveSparkNum`);
      assert.equal(texture.starStatus, expected.fields.StarStatus, `${where}: StarStatus`);
      assert.equal(hex(new Uint8Array(globals.random.buffer, 0, 256)), expected.random, `${where}: random`);
      assert.equal(globals.randomIndex, expected.randomIndex, `${where}: random index`);
    });
  } catch (error) {
    mismatches.push({name: c.name, message: error.message.split('\n')[0].slice(0, 300)});
  }
});
console.log(JSON.stringify({cases: selected.length, mismatches: mismatches.length, first: mismatches.slice(0, 5)}, null, 1));
assert.equal(mismatches.length, 0);
