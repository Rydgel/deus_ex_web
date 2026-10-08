/** Validate Core.Object float/vector operator natives against the original DLL. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import { compileFunction, primitiveNativeIndices } from '../src/runtime/script-vm.mjs';
import { vectorToRotator } from '../src/runtime/script-decoration-primitives.mjs';
import { gameDirectory } from './game-directory.mjs';
import { setX87Precision as setRenderPassPrecision } from '../src/runtime/script-vm.mjs';
// ORACLE_CW=0x007f runs the oracle at the render pass's control word and the
// VM at x87 precision control 24 (docs/render-pass-precision.md "UnrealScript
// in the render pass").
if (Number(process.env.ORACLE_CW) === 0x7f) setRenderPassPrecision(24);

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
  // The operators the VMs compute with host arithmetic and the x87 NaN rules
  // (script-vm.mjs x87arith, interp.rs x87_nan): each is FLD m32, one x87
  // FMUL/FDIV/FADD/FSUB, FSTP m32 (214: FDIVR m64 1.0, FMUL st(1) per component).
  ...Object.fromEntries([
    ['multiplyFloatFloat', 171, 0x10101efb, 0x10134e80, 'multiply_floatfloat', 16, [0x29, 0x6d, 0x03, 0x29, 0x6e, 0x03], '\\*', 'float A', 'float B',
      [[0x10134ecc, 'd944240c'], [0x10134ed7, 'd84c2404'], [0x10134ee0, 'd91a']]],
    ['divideFloatFloat', 172, 0x10102c0c, 0x10134f50, 'divide_floatfloat', 16, [0x29, 0x71, 0x03, 0x29, 0x72, 0x03], '\\/', 'float A', 'float B',
      [[0x10134f9c, 'd9442404'], [0x10134fa0, 'd874240c'], [0x10134fb0, 'd91a']]],
    ['addFloatFloat', 174, 0x101020cc, 0x10135100, 'add_floatfloat', 20, [0x29, 0x79, 0x03, 0x29, 0x7a, 0x03], '\\+', 'float A', 'float B',
      [[0x1013514c, 'd944240c'], [0x10135157, 'd8442404'], [0x10135160, 'd91a']]],
    ['subtractFloatFloat', 175, 0x1010265d, 0x101351d0, 'subtract_floatfloat', 20, [0x29, 0x7d, 0x03, 0x29, 0x7e, 0x03], '-', 'float A', 'float B',
      [[0x1013521c, 'd9442404'], [0x10135227, 'd864240c'], [0x10135230, 'd91a']]],
    ['multiplyEqualFloatFloat', 182, 0x101021f3, 0x101358e0, 'multiplyequal_floatfloat', 34, [0x29, 0x5d, 0x04, 0x29, 0x5e, 0x04], '\\*=', 'out float A', 'float B',
      [[0x101358f7, 'c705f8321e1000000000'], [0x10135945, 'd9442410'], [0x10135949, 'd80f'], [0x10135956, 'd917'], [0x10135958, 'd91a']]],
    ['addEqualFloatFloat', 184, 0x101024dc, 0x10135aa0, 'addequal_floatfloat', 34, [0x29, 0x65, 0x04, 0x29, 0x66, 0x04], '\\+=', 'out float A', 'float B',
      [[0x10135ab7, 'c705f8321e1000000000'], [0x10135b05, 'd9442410'], [0x10135b09, 'd807'], [0x10135b16, 'd917'], [0x10135b18, 'd91a']]],
    ['subtractEqualFloatFloat', 185, 0x10101645, 0x10135b80, 'subtractequal_floatfloat', 34, [0x29, 0x69, 0x04, 0x29, 0x6a, 0x04], '-=', 'out float A', 'float B',
      [[0x10135b97, 'c705f8321e1000000000'], [0x10135be5, 'd907'], [0x10135be7, 'd8642410'], [0x10135bf6, 'd917'], [0x10135bf8, 'd91a']]],
    ['multiplyVectorFloat', 212, 0x10103247, 0x101377e0, 'multiply_vectorfloat', 16, [0x29, 0x10, 0x29, 0x0f], '\\*', 'vector A', 'float B',
      [[0x1013782a, 'd84c2420'], [0x10137836, 'd95c2404'], [0x1013783e, 'd84c2420'], [0x10137854, 'd84c241c'], [0x1013785f, 'd95c2408']]],
    ['multiplyFloatVector', 213, 0x10102897, 0x101378d0, 'multiply_floatvector', 16, [0x29, 0x4c, 0x04, 0x29, 0x48, 0x04], '\\*', 'float A', 'vector B',
      [[0x1013791a, 'd84c2404'], [0x1013792e, 'd84c2404'], [0x10137944, 'd84c2400'], [0x1013794f, 'd95c240c']]],
    ['divideVectorFloat', 214, 0x10101c8f, 0x10137ab0, 'divide_vectorfloat', 16, [0x29, 0x47, 0x04, 0x29, 0x43, 0x04], '\\/', 'vector A', 'float B',
      [[0x10137afa, 'dc3da8651710'], [0x10137b10, 'd8c9'], [0x10137b12, 'd95c2400'], [0x10137b1a, 'd8c9'], [0x10137b2e, 'd8c9'], [0x10137b3b, 'ddd8']]],
    ['addVectorVector', 215, 0x101029a5, 0x10137bb0, 'add_vectorvector', 20, [0x29, 0x40, 0x04, 0x29, 0x7c, 0x03], '\\+', 'vector A', 'vector B',
      [[0x10137bf2, 'd8442410'], [0x10137c06, 'd8442420'], [0x10137c1c, 'd8442420'], [0x10137c27, 'd95c2408']]],
    ['subtractVectorVector', 216, 0x10101992, 0x10137ca0, 'subtract_vectorvector', 20, [0x29, 0x7f, 0x03, 0x29, 0x78, 0x03], '-', 'vector A', 'vector B',
      [[0x10137ce2, 'd864241c'], [0x10137cf6, 'd8642420'], [0x10137d0c, 'd8642420'], [0x10137d17, 'd95c2408']]],
    ['addEqualVectorVector', 223, 0x10101447, 0x10138b10, 'addequal_vectorvector', 34, [0x29, 0x55, 0x03, 0x29, 0x54, 0x03], '\\+=', 'out vector A', 'vector B',
      [[0x10138b15, 'c705f8321e1000000000'], [0x10138b6b, 'd807'], [0x10138b78, 'd91f'], [0x10138b7e, 'd84704'], [0x10138b88, 'd84708']]],
  ].map(([name, index, thunk, body, export_, precedence, script, op, a, b, pins]) => {
    const type = t => t.endsWith('vector A') || t === 'vector B' ? 'struct' : 'float';
    const result = a.endsWith('vector A') || b === 'vector B' ? 'vector' : 'float';
    return [name, [index, thunk, body, `object.${export_}`, precedence, script,
      [['A', type(a), a.startsWith('out'), false], ['B', type(b), false, false], ['ReturnValue', result === 'vector' ? 'struct' : 'float', true, true]],
      new RegExp(`native\\(${index}\\)\\s+static final operator\\(${precedence}\\)\\s+${result}\\s+${op}\\s*\\(\\s*${a.replace(' ', '\\s+')},\\s*${b.replace(' ', '\\s+')}\\s*\\)`),
      pins]];
  })),
  vectorSize: [225, 0x10102d88, 0x10138d10, 'object.vsize', 0,
    [0x29, 0x76, 0x04],
    [['A', 'struct', false, false], ['ReturnValue', 'float', true, true]],
    /native\(225\)\s+static final function\s+float\s+VSize\s*\(\s*vector A\s*\)/,
    [[0x10138d3d, 'd8c9'], [0x10138d41, 'd8cb'], [0x10138d4a, 'dec1'], [0x10138d57, 'dec1'], [0x10138d59, 'dd1c24'],
      [0x10138d60, 'e855a5fcff'], [0x10138d6c, 'd919']]],
};
const OUT_PARAM = new Set([182, 184, 185, 221, 222, 223, 224]);

// The vector-to-rotator cast (token 0x50's evaluator) is checked apart:
// it has no Core.u function export.
const CAST = { index: 0x50, thunk: 0x1010329c, body: 0x10136f90 };
assert.deepEqual(oracle.addresses.natives, {
  ...Object.fromEntries(Object.entries(NATIVES).map(
    ([name, [index, thunk, body]]) => [name, { index, thunk: `0x${thunk.toString(16)}`, body: `0x${body.toString(16)}` }])),
  vectorToRotator: { index: CAST.index, thunk: `0x${CAST.thunk.toString(16)}`, body: `0x${CAST.body.toString(16)}` },
});
assert.equal(coreDll[CAST.thunk - IMAGE_BASE], 0xe9, 'cast 0x50: thunk jump opcode');
assert.equal(CAST.thunk + 5 + coreDll.readInt32LE(CAST.thunk - IMAGE_BASE + 1), CAST.body, 'cast 0x50: thunk target');
// The body's one call: FVector::Rotation through its thunk 0x10102888.
assert.equal(coreDll.subarray(0x10136fd3 - IMAGE_BASE, 0x10136fd8 - IMAGE_BASE).toString('hex'), 'e8b0b8fcff', 'cast 0x50: FVector::Rotation call');

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
let casts = 0;
for (const original of oracle.cases) {
  if (original.native === 'vectorToRotator') {
    // Step consumes the operand and nothing else; the rotator is copied out.
    assert.equal(original.codeAdvance, 1, `${original.name}: FFrame cursor advance`);
    assert.deepEqual(original.events, original.operands, `${original.name}: operand evaluation`);
    assert.deepEqual(vectorToRotator(original.operands[0].map(f32)), original.resultBits.map(v => v | 0), `${original.name}: VM result`);
    casts++;
    continue;
  }
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
      receiver[String.fromCharCode(65 + i)] = Array.isArray(op) ? op.map(f32) : f32(op);
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
    // Array.isArray, not [A].flat(): copying into a new double Array can store a NaN canonically.
    assert.deepEqual((Array.isArray(receiver.A) ? receiver.A : [receiver.A]).map(v => nanNorm(bitsOf(v))), variableBits.map(nanNorm),
      `${original.name}: lvalue mutation`);
  } else if (OUT_PARAM.has(index)) {
    assert.equal(propAddr, 0, `${original.name}: temporary fallback`);
    assert.deepEqual(variableBits, variableBits.map(() => 0xa5a5a5a5),
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

assert.ok(casts >= 10, 'the vector-to-rotator cast cases ran');
console.log(`Original Core float/vector operators and the vector-to-rotator cast passed ${oracle.cases.length} arithmetic, comparison, extended-precision, NaN-payload, out-parameter, operand-order, and FFrame cursor cases.`);
