/** Validate Core.Object Sqrt/Normal/GetAxes/Smerp/MirrorVectorByNormal against the original DLL. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import { compileFunction, primitiveNativeIndices } from '../src/runtime/script-vm.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const oracle = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-normal-axes-oracle.py'), root,
], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));

const CORE_HASH = '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4';
const coreDll = await readFile(`${root}/System/Core.dll`);
const coreU = await readFile(`${root}/System/Core.u`, 'utf8');
assert.equal(createHash('sha256').update(coreDll).digest('hex'), CORE_HASH, 'Core.dll hash');
assert.deepEqual(oracle.hashes, { 'Core.dll': CORE_HASH });
assert.equal(oracle.addresses.evaluatorTable, '0x101f41b8');
assert.equal(oracle.addresses.propAddr, '0x101e32f8');
assert.equal(oracle.addresses.propObject, '0x101e32c0');
assert.equal(oracle.addresses.f64One, '0x101765a8');
assert.equal(oracle.addresses.f64Threshold, '0x101765d8');
assert.equal(oracle.addresses.f64Three, '0x10177f90');
assert.deepEqual(oracle.tokens, {
  FloatConst: '0x1e', VectorConst: '0x23', RotatorConst: '0x22',
  LocalVariable: '0x0', EndFunctionParms: '0x16',
});

// The embedded doubles the bodies read: 1.0 (SafeNormal FDIVR), 1e-08
// (SafeNormal FCOMP threshold) and 3.0 (Smerp's cubic coefficient).
const IMAGE_BASE = 0x10100000;
assert.equal(coreDll.subarray(0x101765a8 - IMAGE_BASE, 0x101765b0 - IMAGE_BASE).toString('hex'),
  '000000000000f03f', 'embedded double 1.0');
assert.equal(coreDll.subarray(0x101765d8 - IMAGE_BASE, 0x101765e0 - IMAGE_BASE).toString('hex'),
  '3a8c30e28e79453e', 'embedded double 1e-08');
assert.equal(coreDll.subarray(0x10177f90 - IMAGE_BASE, 0x10177f98 - IMAGE_BASE).toString('hex'),
  '0000000000000840', 'embedded double 3.0');

// name: [index, thunk, body, Core.u path, serialized script, parameter rows
//        [name,type,out,return], declaration regex, code pins]
const NATIVES = {
  sqrt: [193, 0x101027c0, 0x10136140, 'object.sqrt',
    [0x29, 0x35],
    [['A', 'float', false, false], ['ReturnValue', 'float', true, true]],
    /native\(193\)\s+static final function\s+float\s+Sqrt\s*\(\s*float A\s*\)/,
    [[0x1013616f, 'd944240c'], [0x10136174, 'dd1c24'], [0x10136186, 'd919']]],
  normal: [226, 0x10101730, 0x10138de0, 'object.normal',
    [0x29, 0x74, 0x04],
    [['A', 'struct', false, false], ['ReturnValue', 'struct', true, true]],
    /native\(226\)\s+static final function\s+vector\s+Normal\s*\(\s*vector A\s*\)/,
    [[0x10138dfc, 'ff1495b8411f10'], [0x10138e13, 'e8a8a3fcff'],
      [0x10138e1f, '890a'], [0x10138e24, '894a04'], [0x10138e2a, '894208']]],
  getAxes: [229, 0x10102d06, 0x10139e90, 'object.getaxes',
    [0x29, 0x5c, 0x02, 0x29, 0x5d, 0x02, 0x29, 0x55, 0x02, 0x29, 0x4f, 0x03],
    [['A', 'struct', false, false], ['X', 'struct', true, false],
      ['Y', 'struct', true, false], ['Z', 'struct', true, false]],
    /native\(229\)\s+static final function\s+GetAxes\s*\(\s*rotator A,\s*out vector X,\s*out vector Y,\s*out vector Z\s*\)/,
    [[0x10139ed2, '893df8321e10'], [0x10139ee2, 'a1f8321e10'], [0x10139ee9, '7406'],
      [0x10139f04, '893df8321e10'], [0x10139f3d, '893df8321e10'],
      [0x10139f7e, 'be30321b10'], [0x10139f8b, 'f3a5'],
      [0x10139fb5, 'd90495a4321b10'], [0x10139fcf, 'd9048da4321b10']]],
  smerp: [248, 0x10101587, 0x10136710, 'object.smerp',
    [0x29, 0x75, 0x04, 0x29, 0x54, 0x04, 0x29, 0x0e],
    [['Alpha', 'float', false, false], ['A', 'float', false, false],
      ['B', 'float', false, false], ['ReturnValue', 'float', true, true]],
    /native\(248\)\s+static final function\s+float\s+Smerp\s*\(\s*float Alpha,\s*float A,\s*float B\s*\)/,
    [[0x10136787, 'dec9'], [0x10136793, 'dc0d907f1710'], [0x1013679d, 'd8ca'],
      [0x101367a3, 'dcc0'], [0x101367a5, 'dee9'], [0x101367ab, 'd864240c'],
      [0x101367af, 'dec9'], [0x101367b1, 'd844240c'], [0x101367b5, 'd919']]],
  mirror: [300, 0x10101d2f, 0x101392a0, 'object.mirrorvectorbynormal',
    [0x29, 0x4e, 0x03, 0x29, 0x4c, 0x03],
    [['Vect', 'struct', false, false], ['Normal', 'struct', false, false],
      ['ReturnValue', 'struct', true, true]],
    /native\(300\)\s+static final function\s+vector\s+MirrorVectorByNormal\s*\(\s*vector Vect,\s*vector Normal\s*\)/,
    [[0x101392ee, 'e8cd9efcff'], [0x10139304, 'dcc0'], [0x10139317, 'd95c2420'],
      [0x10139341, 'd95c2438'], [0x10139345, 'd84c2438'], [0x10139351, 'd95c242c'],
      [0x1013935d, 'd95c2430'], [0x10139365, 'd8e1'], [0x10139375, 'd864242c'],
      [0x10139381, 'd8642430'], [0x1013938d, '8911']]],
};

// The helpers the bodies call: SafeNormal (thiscall through thunk
// 0x101031c0) is shared by Normal and MirrorVectorByNormal; the CRT sqrt
// thunk 0x101032ba reaches the x87 FSQRT body used by Sqrt and SafeNormal.
const HELPERS = {
  safeNormal: [0x101031c0, 0x10144be0,
    [[0x10144bee, 'd9c0'], [0x10144bf6, 'dec1'], [0x10144bfc, 'dec1'],
      [0x10144c04, 'dd542404'], [0x10144c08, 'dc1dd8651710'], [0x10144c10, 'f6c401'],
      [0x10144c13, '7415'], [0x10144c39, 'dc3da8651710'], [0x10144c46, 'd9c0'],
      [0x10144c48, 'd80e'], [0x10144c4a, 'd918'], [0x10144c58, 'd95808']]],
  crtSqrt: [0x101032ba, 0x10123290, [[0x10123294, 'd9fa']]],
};

assert.deepEqual(oracle.addresses.natives, Object.fromEntries(Object.entries(NATIVES).map(
  ([name, [index, thunk, body]]) => [name, { index, thunk: `0x${thunk.toString(16)}`, body: `0x${body.toString(16)}` }],
)));

// Each thunk is an image RVA that jumps to the body; the pinned bytes are
// the x87 semantic instructions, the GPropAddr clear/read pattern in
// GetAxes, and the vector result copies.
for (const [name, [index, thunk, body, , , , , pins]] of Object.entries(NATIVES)) {
  assert.equal(coreDll[thunk - IMAGE_BASE], 0xe9, `${name}: thunk jump opcode`);
  const rel = coreDll.readInt32LE(thunk - IMAGE_BASE + 1);
  assert.equal(thunk + 5 + rel, body, `${name}: thunk target`);
  for (const [address, hex] of pins)
    assert.equal(coreDll.subarray(address - IMAGE_BASE, address - IMAGE_BASE + hex.length / 2).toString('hex'), hex,
      `${name}: instruction at ${address.toString(16)}`);
}
for (const [name, [thunk, body, pins]] of Object.entries(HELPERS)) {
  assert.equal(coreDll[thunk - IMAGE_BASE], 0xe9, `${name}: thunk jump opcode`);
  const rel = coreDll.readInt32LE(thunk - IMAGE_BASE + 1);
  assert.equal(thunk + 5 + rel, body, `${name}: thunk target`);
  for (const [address, hex] of pins)
    assert.equal(coreDll.subarray(address - IMAGE_BASE, address - IMAGE_BASE + hex.length / 2).toString('hex'), hex,
      `${name}: instruction at ${address.toString(16)}`);
}

const files = [];
for (const name of await readdir(`${root}/System`))
  files.push({ path: name, read: () => readFile(`${root}/System/${name}`) });
const core = await new AssetStore(files).get('Core');

for (const [name, [index, , , path, script, params, decl]] of Object.entries(NATIVES)) {
  assert.match(coreU, decl, `${name}: Core.u declaration`);
  const exportIndex = core.exportsByPath.get(path);
  assert.ok(exportIndex, `${name}: missing export ${path}`);
  const metadata = readFunctionMetadata(core, exportIndex);
  assert.equal(metadata.nativeIndex, index, `${name}: native index`);
  assert.deepEqual([...metadata.scriptBytes], script, `${name}: script bytes`);
  assert.deepEqual(metadata.parameters.map(p => [p.name, p.type, p.out, p.return]), params,
    `${name}: parameters`);
  assert.ok(primitiveNativeIndices.includes(index), `${name}: native ${index} is linked`);
}

// Float32 operands cross as bit patterns.  Vector and rotator literals
// serialize consecutive words; non-finite operands cannot appear in
// serialized constants (the package reader rejects them) so those cases
// evaluate the original value through an instance-variable reference.
const view = new DataView(new ArrayBuffer(16));
const f32 = bits => (view.setUint32(0, bits >>> 0, true), view.getFloat32(0, true));
const bitsOf = value => (view.setFloat32(0, value, true), view.getUint32(0, true));
// JavaScript cannot hold a signaling NaN — any store quiets it — so NaN
// results compare after folding in the quiet bit.
const nanNorm = bits => (bits >>> 23 & 0xff) === 0xff && (bits & 0x7fffff) ? (bits | 0x400000) >>> 0 : bits >>> 0;
const finite = bits => (bits >>> 23 & 0xff) !== 0xff;

const variable = index => ({ bytes: [0x01, index], cost: 5 });
const floatLiteral = bits => {
  view.setUint32(0, bits >>> 0, true);
  return { bytes: [0x1e, view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)], cost: 5 };
};
const vectorLiteral = bits => {
  for (const [i, b] of bits.entries()) view.setUint32(i * 4, b >>> 0, true);
  return { bytes: [0x23, ...Array.from({ length: 12 }, (_, i) => view.getUint8(i))], cost: 13 };
};
const rotatorLiteral = value => {
  for (const [i, v] of value.entries()) view.setInt32(i * 4, v | 0, true);
  return { bytes: [0x22, ...Array.from({ length: 12 }, (_, i) => view.getUint8(i))], cost: 13 };
};
const field = i => String.fromCharCode(65 + i);   // operand index -> A,B,C,D
const operand = (kind, words, i) => {
  if (kind === 'rotator') return rotatorLiteral(words);
  if (kind === 'float') return finite(words) ? floatLiteral(words) : variable(i + 1);
  return words.every(finite) ? vectorLiteral(words) : variable(i + 1);
};
const fixture = (index, args) => compileFunction({
  pkg: { imports: [], exports: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] },
  entry: { path: `Fixture.Native${index}` },
  bytes: Uint8Array.from([0x04, ...(index > 0xff ? [0x60 | (index >> 8), index & 0xff] : [index]),
    ...args.flatMap(arg => arg.bytes), 0x16]),
  size: 3 + (index > 0xff ? 1 : 0) + args.reduce((n, arg) => n + arg.cost, 0),
});

// kind names in the oracle operand rows; each oracle operand is a bit word
// (float), a three-word vector/lvector, or a three-int rotator.
for (const original of oracle.cases) {
  const index = NATIVES[original.native][0];
  assert.equal(original.index, index, `${original.name}: index`);
  assert.equal(original.codeAdvance, original.operands.length + 1,
    `${original.name}: FFrame cursor advance`);
  assert.deepEqual(original.events, original.operands,
    `${original.name}: left-to-right operand evaluation`);
  assert.ok(original.resultTail.every(byte => byte === 0x7f),
    `${original.name}: result store width`);

  const receiver = {};
  const args = [];
  for (const [i, op] of original.operands.entries()) {
    if (original.lvalue[i]) {
      args.push(variable(i + 1));
      receiver[field(i)] = op.map(f32);
    } else {
      const kind = original.native === 'getAxes' && i === 0 ? 'rotator'
        : Array.isArray(op) ? 'vector' : 'float';
      args.push(operand(kind, op, i));
      if (args.at(-1).bytes[0] === 0x01)
        receiver[field(i)] = Array.isArray(op) ? op.map(f32) : f32(op);
    }
  }
  const result = fixture(index, args).run(receiver);
  // Signaling NaN operands are quieted by the JavaScript number load before
  // the VM sees them, so for those cases the oracle also ran the original
  // body on the quieted operand bits; jsResultBits/jsOutBits are the correct
  // expectation for what the VM can observe.
  const resultBits = original.jsResultBits ?? original.resultBits;
  const outBits = original.jsOutBits ?? original.outBits;
  const propAddr = original.jsPropAddr ?? original.propAddr;
  if (index === 229) {
    // GetAxes is void: the original never touches the result pointer, so the
    // oracle's 0x7f-sentinelled buffer comes back unmodified.
    assert.equal(result, undefined, `${original.name}: void result`);
    assert.deepEqual(resultBits, [0x7f7f7f7f, 0x7f7f7f7f, 0x7f7f7f7f],
      `${original.name}: result buffer untouched`);
  } else if (resultBits.length === 1)
    assert.equal(nanNorm(bitsOf(result)), nanNorm(resultBits[0]), `${original.name}: VM result`);
  else
    assert.deepEqual(result.map(v => nanNorm(bitsOf(v))), resultBits.map(nanNorm), `${original.name}: VM result`);

  // Each lvalue operand published its own variable through GPropAddr; the
  // receiver field must now hold the oracle's bits for that position.  A
  // non-lvalue out position leaves the receiver untouched (the original
  // wrote to a discarded stack temporary).
  for (const [i, flag] of original.lvalue.entries()) {
    if (flag) {
      assert.ok(outBits[String(i)], `${original.name}: out operand ${i} captured`);
      assert.deepEqual(receiver[field(i)].map(v => nanNorm(bitsOf(v))), outBits[String(i)].map(nanNorm),
        `${original.name}: out operand ${i} mutation`);
    } else if (original.native === 'getAxes' && i > 0) {
      assert.equal(receiver[field(i)], undefined, `${original.name}: temporary fallback ${i}`);
    }
  }
  if (original.native === 'getAxes')
    assert.equal(propAddr === 0, !original.lvalue[3],
      `${original.name}: trailing GPropAddr state`);
  else
    assert.equal(propAddr, 0xdeadbeef, `${original.name}: no GPropAddr use`);
}

// The VM evaluates native operands left to right through the same property
// getters the original FFrame Step order produces.
const evaluation = [];
const receiver = {};
for (const [name, value] of [['A', [1, -2, 3]], ['B', [0, 1, 0]]]) {
  Object.defineProperty(receiver, name, {
    enumerable: true,
    get() { evaluation.push(name); return value; },
  });
}
assert.deepEqual(fixture(300, [variable(1), variable(2)]).run(receiver), [1, 2, 3],
  'fixture mirror of A against B');
assert.deepEqual(evaluation, ['A', 'B'], 'VM evaluates MirrorVectorByNormal operands left to right');

console.log(`Original Core Sqrt/Normal/GetAxes/Smerp/MirrorVectorByNormal passed ${oracle.cases.length} bit-exact, threshold, association, reciprocal, rounding-placement, NaN-payload, out-parameter, operand-order, and FFrame cursor cases.`);
