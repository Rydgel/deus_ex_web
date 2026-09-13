/** Validate Core.Object float/vector operator natives against the original DLL. */

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
  path.resolve('scripts/native-float-vector-operators-oracle.py'), root,
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
assert.deepEqual(oracle.tokens, {
  IntConst: '0x1d', FloatConst: '0x1e', VectorConst: '0x23',
  LocalVariable: '0x0', EndFunctionParms: '0x16',
});

// The 222 body divides the embedded double 1.0 by the divisor (FDIVR keeps
// the reciprocal in 80-bit); pin that constant word too.
const IMAGE_BASE = 0x10100000;
assert.equal(coreDll.subarray(0x101765a8 - IMAGE_BASE, 0x101765b0 - IMAGE_BASE).toString('hex'),
  '000000000000f03f', 'embedded double 1.0');

// name: [index, thunk, body, Core.u path, precedence, serialized script,
//        parameter rows [name,type,out,return], declaration regex, code pins]
const NATIVES = {
  square: [194, 0x1010136b, 0x101361f0, 'object.square', 0,
    [0x29, 0x6f, 0x04],
    [['A', 'float', false, false], ['ReturnValue', 'float', true, true]],
    /native\(194\)\s+static final function\s+float\s+Square\s*\(\s*float A\s*\)/,
    [[0x10136219, 'd9442404'], [0x10136224, 'd84c2404'], [0x1013622d, 'd919']]],
  subtractPreVector: [211, 0x101030e4, 0x10137710, 'object.subtract_prevector', 0,
    [0x29, 0x50, 0x04],
    [['A', 'struct', false, false], ['ReturnValue', 'struct', true, true]],
    /native\(211\)\s+static final preoperator\s+vector\s+-\s*\(\s*vector A\s*\)/,
    [[0x10137737, 'd9e0'], [0x1013774d, 'd9e0'], [0x1013775e, 'd9e0'], [0x10137740, 'd95c2404']]],
  equalEqualVectorVector: [217, 0x10101663, 0x10138430, 'object.equalequal_vectorvector', 24,
    [0x29, 0x73, 0x03, 0x29, 0x6c, 0x03],
    [['A', 'struct', false, false], ['B', 'struct', false, false], ['ReturnValue', 'bool', true, true]],
    /native\(217\)\s+static final operator\(24\)\s+bool\s+==\s*\(\s*vector A,\s*vector B\s*\)/,
    [[0x10138475, 'd85c2410'], [0x1013847e, 'dfe0'], [0x10138480, 'f6c440'], [0x10138498, 'd85c2414']]],
  notEqualVectorVector: [218, 0x10102379, 0x10138530, 'object.notequal_vectorvector', 26,
    [0x29, 0x6f, 0x03, 0x29, 0x6b, 0x03],
    [['A', 'struct', false, false], ['B', 'struct', false, false], ['ReturnValue', 'bool', true, true]],
    /native\(218\)\s+static final operator\(26\)\s+bool\s+!=\s*\(\s*vector A,\s*vector B\s*\)/,
    [[0x10138575, 'd85c2410'], [0x1013857e, 'dfe0'], [0x10138580, 'f6c440'], [0x10138598, 'd85c2414']]],
  dotVectorVector: [219, 0x10102874, 0x10138630, 'object.dot_vectorvector', 16,
    [0x29, 0x68, 0x03, 0x29, 0x67, 0x03],
    [['A', 'struct', false, false], ['B', 'struct', false, false], ['ReturnValue', 'float', true, true]],
    /native\(219\)\s+static final operator\(16\)\s+float\s+Dot\s*\(\s*vector A,\s*vector B\s*\)/,
    [[0x1013866e, 'd9442418'], [0x10138672, 'd84c240c'], [0x10138686, 'dec1'], [0x10138694, 'dec1'], [0x10138696, 'd91a']]],
  multiplyEqualVectorFloat: [221, 0x1010261c, 0x10138810, 'object.multiplyequal_vectorfloat', 34,
    [0x29, 0x64, 0x03, 0x29, 0x5c, 0x03],
    [['A', 'struct', true, false], ['B', 'float', false, false], ['ReturnValue', 'struct', true, true]],
    /native\(221\)\s+static final operator\(34\)\s+vector\s+\*=\s*\(\s*out vector A,\s*float B\s*\)/,
    [[0x10138815, 'c705f8321e1000000000'], [0x10138877, 'd80f'], [0x10138884, 'd91f'], [0x1013888b, 'd95f04'], [0x10138891, 'd95f08']]],
  divideEqualVectorFloat: [222, 0x10102da1, 0x10138a10, 'object.divideequal_vectorfloat', 34,
    [0x29, 0x5f, 0x03, 0x29, 0x53, 0x04],
    [['A', 'struct', true, false], ['B', 'float', false, false], ['ReturnValue', 'struct', true, true]],
    /native\(222\)\s+static final operator\(34\)\s+vector\s+\/=\s*\(\s*out vector A,\s*float B\s*\)/,
    [[0x10138a15, 'c705f8321e1000000000'], [0x10138a73, 'dc3da8651710'], [0x10138a86, 'd80f'], [0x10138a88, 'd91f']]],
  subtractEqualVectorVector: [224, 0x1010120d, 0x10138c10, 'object.subtractequal_vectorvector', 34,
    [0x29, 0x51, 0x03, 0x29, 0x57, 0x03],
    [['A', 'struct', true, false], ['B', 'struct', false, false], ['ReturnValue', 'struct', true, true]],
    /native\(224\)\s+static final operator\(34\)\s+vector\s+-=\s*\(\s*out vector A,\s*vector B\s*\)/,
    [[0x10138c15, 'c705f8321e1000000000'], [0x10138c69, 'd8642408'], [0x10138c78, 'd91f'], [0x10138c8b, 'd95f08']]],
  minIntInt: [249, 0x1010190b, 0x10134a20, 'object.min', 0,
    [0x29, 0x59, 0x03, 0x29, 0x5a, 0x03],
    [['A', 'int', false, false], ['B', 'int', false, false], ['ReturnValue', 'int', true, true]],
    /native\(249\)\s+static final function\s+int\s+Min\s*\(\s*int A,\s*int B\s*\)/,
    [[0x10134a7b, '3bc1'], [0x10134a7e, '7f0a'], [0x10134a84, '8902'], [0x10134a8e, '8908']]],
  multiplyVectorVector: [296, 0x10102ffe, 0x101379c0, 'object.multiply_vectorvector', 16,
    [0x29, 0x4b, 0x04, 0x29, 0x44, 0x04],
    [['A', 'struct', false, false], ['B', 'struct', false, false], ['ReturnValue', 'struct', true, true]],
    /native\(296\)\s+static final operator\(16\)\s+vector\s+\*\s*\(\s*vector A,\s*vector B\s*\)/,
    [[0x101379fe, 'd944241c'], [0x10137a02, 'd84c2410'], [0x10137a0e, 'd95c2404'], [0x10137a24, 'd95c2404'], [0x10137a37, 'd95c2408']]],
};
const OUT_PARAM = new Set([221, 222, 224]);

assert.deepEqual(oracle.addresses.natives, Object.fromEntries(Object.entries(NATIVES).map(
  ([name, [index, thunk, body]]) => [name, { index, thunk: `0x${thunk.toString(16)}`, body: `0x${body.toString(16)}` }],
)));

// Each thunk is at an image RVA that jumps to the body; the pinned bytes are
// the x87 semantic instructions and the GPropAddr clear in the out bodies.
for (const [name, [index, thunk, body, , , , , , pins]] of Object.entries(NATIVES)) {
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

for (const [name, [index, , , path, precedence, script, params, decl]] of Object.entries(NATIVES)) {
  assert.match(coreU, decl, `${name}: Core.u declaration`);
  const exportIndex = core.exportsByPath.get(path);
  assert.ok(exportIndex, `${name}: missing export ${path}`);
  const metadata = readFunctionMetadata(core, exportIndex);
  assert.equal(metadata.nativeIndex, index, `${name}: native index`);
  assert.equal(metadata.operatorPrecedence, precedence, `${name}: precedence`);
  assert.deepEqual([...metadata.scriptBytes], script, `${name}: script bytes`);
  assert.deepEqual(metadata.parameters.map(p => [p.name, p.type, p.out, p.return]), params,
    `${name}: parameters`);
  assert.ok(primitiveNativeIndices.includes(index), `${name}: native ${index} is linked`);
}

// Float32 operands cross as bit patterns.  Vector literals serialize three
// consecutive float32s; non-finite operands cannot appear in serialized
// constants (the package reader rejects them) so those cases evaluate the
// original value through an instance-variable reference instead.
const view = new DataView(new ArrayBuffer(12));
const f32 = bits => (view.setUint32(0, bits >>> 0, true), view.getFloat32(0, true));
const bitsOf = value => (view.setFloat32(0, value, true), view.getUint32(0, true));
// JavaScript cannot hold a signaling NaN — any store quiets it — so NaN
// results compare after folding in the quiet bit.
const nanNorm = bits => (bits >>> 23 & 0xff) === 0xff && (bits & 0x7fffff) ? (bits | 0x400000) >>> 0 : bits >>> 0;
const finite = bits => (bits >>> 23 & 0xff) !== 0xff;

const variable = index => ({ bytes: [0x01, index], cost: 5 });
const intLiteral = i => ({ bytes: [0x1d, i & 0xff, (i >> 8) & 0xff, (i >> 16) & 0xff, (i >> 24) & 0xff], cost: 5 });
const floatLiteral = bits => {
  view.setUint32(0, bits >>> 0, true);
  return { bytes: [0x1e, view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)], cost: 5 };
};
const vectorLiteral = bits => {
  for (const [i, b] of bits.entries()) view.setUint32(i * 4, b >>> 0, true);
  return { bytes: [0x23, ...Array.from({ length: 12 }, (_, i) => view.getUint8(i))], cost: 13 };
};
const operand = (kind, words, i) => {
  if (kind === 'int') return intLiteral(words | 0);
  if (kind === 'float') return finite(words) ? floatLiteral(words) : variable(i + 1);
  return words.every(finite) ? vectorLiteral(words) : variable(i + 1);
};
const fixture = (index, args) => compileFunction({
  pkg: { imports: [], exports: [{ name: 'A' }, { name: 'B' }] },
  entry: { path: `Fixture.Native${index}` },
  bytes: Uint8Array.from([0x04, ...(index > 0xff ? [0x60 | (index >> 8), index & 0xff] : [index]),
    ...args.flatMap(arg => arg.bytes), 0x16]),
  size: 3 + (index > 0xff ? 1 : 0) + args.reduce((n, arg) => n + arg.cost, 0),
});

// kind names in the oracle operand rows; each oracle operand is a bit word
// (int/float) or a three-word vector.
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
      receiver[String.fromCharCode(65 + i)] = Array.isArray(op) ? op.map(f32) : op;
    } else {
      args.push(operand(Array.isArray(op) ? 'vector' : index === 249 ? 'int' : 'float', op, i));
      if (args.at(-1).bytes[0] === 0x01)
        receiver[String.fromCharCode(65 + i)] = Array.isArray(op) ? op.map(f32) : f32(op);
    }
  }
  const result = fixture(index, args).run(receiver);
  // Signaling NaN operands are quieted by the JavaScript number load before
  // the VM sees them, so for those cases the oracle also ran the original
  // body on the quieted operand bits; jsResultBits/jsVariableBits are the
  // correct expectation for what the VM can observe.
  const resultBits = original.jsResultBits ?? original.resultBits;
  const variableBits = original.jsVariableBits ?? original.variableBits;
  const propAddr = original.jsPropAddr ?? original.propAddr;
  if (index === 249) assert.equal(result, resultBits[0] | 0, `${original.name}: VM result`);
  else if (index === 217 || index === 218) assert.equal(result, Boolean(resultBits[0]), `${original.name}: VM result`);
  else if (resultBits.length === 1)
    assert.equal(nanNorm(bitsOf(result)), nanNorm(resultBits[0]), `${original.name}: VM result`);
  else
    assert.deepEqual(result.map(v => nanNorm(bitsOf(v))), resultBits.map(nanNorm), `${original.name}: VM result`);

  if (original.lvalue[0]) {
    assert.notEqual(propAddr, 0, `${original.name}: GPropAddr lvalue`);
    assert.deepEqual(receiver.A.map(v => nanNorm(bitsOf(v))), variableBits.map(nanNorm),
      `${original.name}: lvalue mutation`);
  } else if (OUT_PARAM.has(index)) {
    assert.equal(propAddr, 0, `${original.name}: temporary fallback`);
    assert.deepEqual(variableBits, [0xa5a5a5a5, 0xa5a5a5a5, 0xa5a5a5a5],
      `${original.name}: variable sentinel`);
  } else {
    assert.equal(propAddr, 0xdeadbeef, `${original.name}: no GPropAddr use`);
  }
}

// The VM evaluates operator operands left to right through the same property
// getters the original FFrame Step order produces.
const evaluation = [];
const receiver = {};
for (const [name, value] of [['A', [1, 0, 0]], ['B', [0, 1, 0]]]) {
  Object.defineProperty(receiver, name, {
    enumerable: true,
    get() { evaluation.push(name); return value; },
  });
}
assert.deepEqual(fixture(219, [variable(1), variable(2)]).run(receiver), 0, 'getter fixture dot');
assert.deepEqual(evaluation, ['A', 'B'], 'VM evaluates Dot operands left to right');

console.log(`Original Core float/vector operators passed ${oracle.cases.length} arithmetic, comparison, extended-precision, NaN-payload, out-parameter, operand-order, and FFrame cursor cases.`);
