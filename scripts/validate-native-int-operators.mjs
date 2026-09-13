/** Validate Core.Object int/byte operator natives against the original DLL. */

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
const python = process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const oracle = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-int-operators-oracle.py'), root,
], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));

const CORE_HASH = '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4';
const coreDll = await readFile(`${root}/System/Core.dll`);
const coreU = await readFile(`${root}/System/Core.u`, 'utf8');
assert.equal(createHash('sha256').update(coreDll).digest('hex'), CORE_HASH, 'Core.dll hash');
assert.deepEqual(oracle.hashes, { 'Core.dll': CORE_HASH });
assert.equal(oracle.addresses.evaluatorTable, '0x101f41b8');
assert.equal(oracle.addresses.propAddr, '0x101e32f8');
assert.equal(oracle.addresses.propObject, '0x101e32c0');
assert.deepEqual(oracle.tokens, {
  IntConst: '0x1d', IntConstByte: '0x24', IntToByte: '0x3d',
  LocalVariable: '0x0', EndFunctionParms: '0x16',
});

// name: [index, thunk, body, Core.u path, precedence, serialized script,
//        parameter rows [name,type,out,return], declaration regex, code pins]
const NATIVES = {
  addEqualByteByte: [135, 0x101011bd, 0x10132f50, 'object.addequal_bytebyte', 34,
    [0x29, 0x60, 0x01, 0x29, 0x61, 0x01],
    [['A', 'byte', true, false], ['B', 'byte', false, false], ['ReturnValue', 'byte', true, true]],
    /native\(135\)\s+static final operator\(34\)\s+byte\s+\+=\s*\(\s*out byte A,\s*byte B\s*\)/,
    [[0x10132fc0, '02c2'], [0x10132fc2, '8807'], [0x10132f64, 'c705f8321e1000000000']]],
  subtractSubtractPreByte: [138, 0x101016e0, 0x101331d0, 'object.subtractsubtract_prebyte', 0,
    [0x29, 0x6b, 0x01],
    [['A', 'byte', true, false], ['ReturnValue', 'byte', true, true]],
    /native\(138\)\s+static final preoperator\s+byte\s+--\s*\(\s*out byte A\s*\)/,
    [[0x10133213, 'fec9'], [0x10133215, '8808'], [0x101331e3, 'c705f8321e1000000000']]],
  addAddByte: [139, 0x1010189d, 0x10133290, 'object.addadd_byte', 0,
    [0x29, 0x6e, 0x01],
    [['A', 'byte', true, false], ['ReturnValue', 'byte', true, true]],
    /native\(139\)\s+static final postoperator\s+byte\s+\+\+\s*\(\s*out byte A\s*\)/,
    [[0x101332dd, 'fec0'], [0x101332a3, 'c705f8321e1000000000']]],
  subtractSubtractByte: [140, 0x10103215, 0x10133350, 'object.subtractsubtract_byte', 0,
    [0x29, 0x71, 0x01],
    [['A', 'byte', true, false], ['ReturnValue', 'byte', true, true]],
    /native\(140\)\s+static final postoperator\s+byte\s+--\s*\(\s*out byte A\s*\)/,
    [[0x1013339d, 'fec8'], [0x10133363, 'c705f8321e1000000000']]],
  complementPreInt: [141, 0x10102a68, 0x10133410, 'object.complement_preint', 0,
    [0x29, 0x74, 0x01],
    [['A', 'int', false, false], ['ReturnValue', 'int', true, true]],
    /native\(141\)\s+static final preoperator\s+int\s+~\s*\(\s*int A\s*\)/,
    [[0x10133448, 'f7d1']]],
  subtractPreInt: [143, 0x10103323, 0x10133590, 'object.subtract_preint', 0,
    [0x29, 0x77, 0x01],
    [['A', 'int', false, false], ['ReturnValue', 'int', true, true]],
    /native\(143\)\s+static final preoperator\s+int\s+-\s*\(\s*int A\s*\)/,
    [[0x101335c8, 'f7d9']]],
  shiftLeftIntInt: [148, 0x101020f4, 0x10133990, 'object.lessless_intint', 22,
    [0x29, 0x4a, 0x02, 0x29, 0x4b, 0x02],
    [['A', 'int', false, false], ['B', 'int', false, false], ['ReturnValue', 'int', true, true]],
    /native\(148\)\s+static final operator\(22\)\s+int\s+<<\s*\(\s*int A,\s*int B\s*\)/,
    [[0x101339ef, 'd3e2']]],
  shiftRightIntInt: [149, 0x101030d5, 0x10133a60, 'object.greatergreater_intint', 22,
    [0x29, 0x4e, 0x02, 0x29, 0x4f, 0x02],
    [['A', 'int', false, false], ['B', 'int', false, false], ['ReturnValue', 'int', true, true]],
    /native\(149\)\s+static final operator\(22\)\s+int\s+>>\s*\(\s*int A,\s*int B\s*\)/,
    [[0x10133abf, 'd3fa']]],
  andIntInt: [156, 0x1010324c, 0x10134010, 'object.and_intint', 28,
    [0x29, 0x6e, 0x02, 0x29, 0x6f, 0x02],
    [['A', 'int', false, false], ['B', 'int', false, false], ['ReturnValue', 'int', true, true]],
    /native\(156\)\s+static final operator\(28\)\s+int\s+&\s*\(\s*int A,\s*int B\s*\)/,
    [[0x10134068, '23d0']]],
  xorIntInt: [157, 0x10102482, 0x101340e0, 'object.xor_intint', 28,
    [0x29, 0x72, 0x02, 0x29, 0x73, 0x02],
    [['A', 'int', false, false], ['B', 'int', false, false], ['ReturnValue', 'int', true, true]],
    /native\(157\)\s+static final operator\(28\)\s+int\s+\^\s*\(\s*int A,\s*int B\s*\)/,
    [[0x10134138, '33d0']]],
  orIntInt: [158, 0x101024c8, 0x101341b0, 'object.or_intint', 28,
    [0x29, 0x76, 0x02, 0x29, 0x77, 0x02],
    [['A', 'int', false, false], ['B', 'int', false, false], ['ReturnValue', 'int', true, true]],
    /native\(158\)\s+static final operator\(28\)\s+int\s+\|\s*\(\s*int A,\s*int B\s*\)/,
    [[0x10134208, '0bd0']]],
  addAddPreInt: [163, 0x101012e4, 0x10134660, 'object.addadd_preint', 0,
    [0x29, 0x4a, 0x03],
    [['A', 'int', true, false], ['ReturnValue', 'int', true, true]],
    /native\(163\)\s+static final preoperator\s+int\s+\+\+\s*\(\s*out int A\s*\)/,
    [[0x101346a6, '41'], [0x101346a7, '8908'], [0x10134676, 'c705f8321e1000000000']]],
  subtractSubtractPreInt: [164, 0x10101537, 0x10134720, 'object.subtractsubtract_preint', 0,
    [0x29, 0x4d, 0x03],
    [['A', 'int', true, false], ['ReturnValue', 'int', true, true]],
    /native\(164\)\s+static final preoperator\s+int\s+--\s*\(\s*out int A\s*\)/,
    [[0x10134766, '49'], [0x10134767, '8908'], [0x10134736, 'c705f8321e1000000000']]],
  shiftRightUIntInt: [196, 0x101021e9, 0x101334c0, 'object.greatergreatergreater_intint', 22,
    [0x29, 0x52, 0x02, 0x29, 0x53, 0x02],
    [['A', 'int', false, false], ['B', 'int', false, false], ['ReturnValue', 'int', true, true]],
    /native\(196\)\s+static final operator\(22\)\s+int\s+>>>\s*\(\s*int A,\s*int B\s*\)/,
    [[0x1013351f, 'd3ea']]],
};
const OUT_PARAM = new Set([135, 138, 139, 140, 163, 164]);
const BYTE_RESULT = new Set([135, 138, 139, 140]);

assert.deepEqual(oracle.addresses.natives, Object.fromEntries(Object.entries(NATIVES).map(
  ([name, [index, thunk, body]]) => [name, { index, thunk: `0x${thunk.toString(16)}`, body: `0x${body.toString(16)}` }],
)));

// Each thunk is at an image RVA that jumps to the body; the pinned bytes are
// the semantic instructions and the GPropAddr clear in the out-param bodies.
const IMAGE_BASE = 0x10100000;
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

// Fixture expressions.  SerializeExpr expands each object reference to four
// bytes of script, so the variable expression costs five expanded bytes and
// the IntConst/IntConstByte literals cost five and two.
const variable = index => ({ bytes: [0x01, index], cost: 5 });
const intLiteral = i => ({ bytes: [0x1d, i & 0xff, (i >> 8) & 0xff, (i >> 16) & 0xff, (i >> 24) & 0xff], cost: 5 });
const byteLiteral = b => ({ bytes: [0x24, b & 0xff], cost: 2 });
const fixture = (index, args) => compileFunction({
  pkg: { imports: [], exports: [{ name: 'A' }, { name: 'B' }] },
  entry: { path: `Fixture.Native${index}` },
  bytes: Uint8Array.from([0x04, index, ...args.flatMap(arg => arg.bytes), 0x16]),
  size: 3 + args.reduce((n, arg) => n + arg.cost, 0),
});

for (const original of oracle.cases) {
  const index = NATIVES[original.native][0];
  assert.equal(original.index, index, `${original.name}: index`);
  assert.equal(original.codeAdvance, original.operands.length + 1,
    `${original.name}: FFrame cursor advance`);
  assert.deepEqual(original.events, original.operands,
    `${original.name}: left-to-right operand evaluation`);
  const args = [original.lvalue[0] ? variable(1)
    : BYTE_RESULT.has(index) ? byteLiteral(original.operands[0]) : intLiteral(original.operands[0])];
  if (original.operands.length > 1) args.push(variable(2));
  const receiver = { A: original.operands[0], B: original.operands[1] };
  assert.equal(fixture(index, args).run(receiver), original.result,
    `${original.name}: VM result`);
  if (original.lvalue[0]) {
    assert.ok(original.propAddr !== 0, `${original.name}: GPropAddr lvalue`);
    assert.equal(receiver.A, original.variable, `${original.name}: lvalue mutation`);
  } else {
    assert.equal(receiver.A, original.operands[0], `${original.name}: non-lvalue untouched`);
    if (OUT_PARAM.has(index)) {
      assert.equal(original.propAddr, 0, `${original.name}: temporary fallback`);
      assert.equal(original.variable, BYTE_RESULT.has(index) ? 0xa5 : -0x5a5a5a5b,
        `${original.name}: variable sentinel`);
    } else {
      assert.equal(original.propAddr, 0xdeadbeef, `${original.name}: no GPropAddr use`);
    }
  }
  if (BYTE_RESULT.has(index))
    assert.equal(original.resultWord >>> 8, 0x7f7f7f, `${original.name}: byte-wide result store`);
  else
    assert.equal(original.resultWord, original.result >>> 0, `${original.name}: dword result store`);
}

// The VM evaluates operator operands left to right through the same property
// getters the original FFrame Step order produces.
const evaluation = [];
const receiver = {};
for (const [name, value] of [['A', 3], ['B', 4]]) {
  Object.defineProperty(receiver, name, {
    enumerable: true,
    get() { evaluation.push(name); return value; },
  });
}
assert.equal(fixture(148, [variable(1), variable(2)]).run(receiver), 48, 'getter fixture shift');
assert.deepEqual(evaluation, ['A', 'B'], 'VM evaluates LessLess_IntInt operands left to right');
assert.equal(fixture(148, [intLiteral(0x100000001), intLiteral(4)]).run({}), 16,
  'int operands are int32 values');
assert.equal(fixture(141, [intLiteral(0x100000000)]).run({}), -1,
  'complement operand is an int32 value');

console.log(`Original Core int/byte operators passed ${oracle.cases.length} bitwise, shift, increment, decrement, out-parameter, operand-order, and FFrame cursor cases.`);
