/** Validate Core.Object </<=/>=(string)/Asc/^^//=(int,float)/*=(vector) and
 * Cos/Tan/Atan against the original DLLs — plus the Sin (187) audit, whose
 * pre-existing f(Math.sin) binding is reported, not changed. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import { compileFunction, primitiveNativeIndices } from '../src/runtime/script-vm.mjs';
import { scriptStringText } from '../src/runtime/script-string-operations.mjs';
import { gameDirectory } from './game-directory.mjs';
import { setX87Precision as setRenderPassPrecision } from '../src/runtime/script-vm.mjs';
// ORACLE_CW=0x007f runs the oracle at the render pass's control word and the
// VM at x87 precision control 24 (docs/render-pass-precision.md "UnrealScript
// in the render pass").
if (Number(process.env.ORACLE_CW) === 0x7f) setRenderPassPrecision(24);

const root = gameDirectory();
const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const oracle = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-string-transcendental-oracle.py'), root,
], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));

const CORE_HASH = '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4';
const MSVCRT_HASH = 'e390b0529fb9ee1214bb68302a4658b578134d92ab76bc5eb48f3badd843d210';
const coreDll = await readFile(`${root}/System/Core.dll`);
const msvcrtDll = await readFile(`${root}/System/MSVCRT.dll`);
const coreU = await readFile(`${root}/System/Core.u`, 'utf8');
assert.equal(createHash('sha256').update(coreDll).digest('hex'), CORE_HASH, 'Core.dll hash');
assert.equal(createHash('sha256').update(msvcrtDll).digest('hex'), MSVCRT_HASH, 'MSVCRT.dll hash');
assert.deepEqual(oracle.hashes, { 'Core.dll': CORE_HASH, 'MSVCRT.dll': MSVCRT_HASH });
assert.equal(oracle.addresses.evaluatorTable, '0x101f41b8');
assert.equal(oracle.addresses.propAddr, '0x101e32f8');
assert.equal(oracle.addresses.propObject, '0x101e32c0');
assert.equal(oracle.addresses.emptyString, '0x101ef654');
assert.deepEqual(oracle.addresses.appStrcmp, { thunk: '0x101012c1', body: '0x10123540' });
assert.deepEqual(oracle.tokens, {
  FloatConst: '0x1e', IntConst: '0x1d', StringConst: '0x1f', VectorConst: '0x23',
  LocalVariable: '0x0', EndFunctionParms: '0x16',
});

// name: [index, thunk, body, Core.u path, serialized script, parameter rows
//        [name,type,out,return], declaration regex, code pins]
const NATIVES = {
  slt: [115, 0x1010153c, 0x1013ae20, 'object.less_strstr',
    [0x29, 0x4d, 0x02, 0x29, 0x75, 0x01],
    [['A', 'string', false, false], ['B', 'string', false, false],
      ['ReturnValue', 'bool', true, true]],
    /native\(115\)\s+static final operator\(24\)\s+bool\s+<\s*\(\s*string\s+A,\s*string\s+B\s*\)/,
    // Two FString temporaries evaluated left-to-right; each is substituted
    // with the runtime empty buffer 0x101ef654 when its ArrayNum is zero;
    // call the appStrcmp thunk and setl on the signed result.
    [[0x1013ae67, 'ff1495b8411f10'], [0x1013aead, '7505'],
      [0x1013aeaf, 'b954f61e10'], [0x1013aec0, 'b854f61e10'],
      [0x1013aec7, 'e8f563fcff'], [0x1013aed7, '0f9cc2'],
      [0x1013aeda, '8910']]],
  sle: [120, 0x10102bb2, 0x1013b1c0, 'object.lessequal_strstr',
    [0x29, 0x51, 0x02, 0x29, 0x54, 0x02],
    [['A', 'string', false, false], ['B', 'string', false, false],
      ['ReturnValue', 'bool', true, true]],
    /native\(120\)\s+static final operator\(24\)\s+bool\s+<=\s*\(\s*string\s+A,\s*string\s+B\s*\)/,
    // Same shape; setle at 0x1013b277.
    [[0x1013b207, 'ff1495b8411f10'], [0x1013b24d, '7505'],
      [0x1013b24f, 'b954f61e10'], [0x1013b260, 'b854f61e10'],
      [0x1013b267, 'e85560fcff'], [0x1013b277, '0f9ec2'],
      [0x1013b27a, '8910']]],
  sge: [121, 0x1010309e, 0x1013b390, 'object.greaterequal_strstr',
    [0x29, 0x6a, 0x01, 0x29, 0x69, 0x01],
    [['A', 'string', false, false], ['B', 'string', false, false],
      ['ReturnValue', 'bool', true, true]],
    /native\(121\)\s+static final operator\(24\)\s+bool\s+>=\s*\(\s*string\s+A,\s*string\s+B\s*\)/,
    // Same shape; setge at 0x1013b447.
    [[0x1013b3d7, 'ff1495b8411f10'], [0x1013b41d, '7505'],
      [0x1013b41f, 'b954f61e10'], [0x1013b430, 'b854f61e10'],
      [0x1013b437, 'e8855efcff'], [0x1013b447, '0f9dc2'],
      [0x1013b44a, '8910']]],
  xor: [131, 0x1010288d, 0x10132b90, 'object.xorxor_boolbool',
    [0x29, 0x50, 0x01, 0x29, 0x51, 0x01],
    [['A', 'bool', false, false], ['B', 'bool', false, false],
      ['ReturnValue', 'bool', true, true]],
    /native\(131\)\s+static final operator\(30\)\s+bool\s+\^\^\s*\(\s*bool\s+A,\s*bool\s+B\s*\)/,
    // test/sete on each dword operand, then xor — logical inequality after
    // zero-truth coercion.
    [[0x10132be6, '85c0'], [0x10132bf3, '0f94c2'], [0x10132bf8, '85f6'],
      [0x10132bfa, '0f94c0'], [0x10132bfd, '33d0'], [0x10132c00, '8911']]],
  diveq: [160, 0x10102d6a, 0x10134370, 'object.divideequal_intfloat',
    [0x29, 0x7e, 0x02, 0x29, 0x7f, 0x02],
    [['A', 'int', true, false], ['B', 'float', false, false],
      ['ReturnValue', 'int', true, true]],
    /native\(160\)\s+static final operator\(34\)\s+int\s+\/=\s*\(\s*out\s+int\s+A,\s*float\s+B\s*\)/,
    // GPropAddr cleared, first operand lvalue-evaluated, edi = GPropAddr or
    // the stack temporary; fcomp of the divisor against the embedded 0.0 at
    // 0x101765c4 with a C3 test — equal OR unordered jumps to 0x10134401
    // which flds the same 0.0 and _ftol-stores 0 to BOTH out and result.
    // Otherwise fild edi / fdiv f32 / call the _ftol thunk; eax (the low
    // DWORD) writes back to both.
    [[0x10134391, '893df8321e10'], [0x101343a3, '3bc7'], [0x101343a7, '7504'],
      [0x101343a9, '8d7c2408'], [0x101343d7, 'd81dc4651710'],
      [0x101343e1, 'dfe0'], [0x101343e3, 'f6c440'], [0x101343e6, '7519'],
      [0x101343e8, 'db07'], [0x101343ea, 'd8742410'],
      [0x101343ee, 'e8cdaa0300'], [0x101343f7, '8907'], [0x101343fb, '8902'],
      [0x10134401, 'd905c4651710'], [0x10134407, 'e8b4aa0300'],
      [0x10134410, '8907'], [0x10134414, '8902']]],
  asc: [237, 0x10101c76, 0x1013c630, 'object.asc',
    [0x29, 0x71, 0x04],
    [['S', 'string', false, false], ['ReturnValue', 'int', true, true]],
    /native\(237\)\s+static final function\s+int\s+Asc\s*\(\s*string\s+S\s*\)/,
    // ArrayNum==0 substitutes 0x101ef654; the result is MOVZX of the first
    // UTF-16 unit.
    [[0x1013c674, 'ff1495b8411f10'], [0x1013c68c, '7505'],
      [0x1013c68e, 'b854f61e10'], [0x1013c699, '668b08'],
      [0x1013c69c, '890a']]],
  muleq: [297, 0x1010245a, 0x10138910, 'object.multiplyequal_vectorvector',
    [0x29, 0x5b, 0x03, 0x29, 0x58, 0x03],
    [['A', 'struct', true, false], ['B', 'struct', false, false],
      ['ReturnValue', 'struct', true, true]],
    /native\(297\)\s+static final operator\(34\)\s+vector\s+\*=\s*\(\s*out\s+vector\s+A,\s*vector\s+B\s*\)/,
    // GPropAddr handoff like the other out-vector operators; per component
    // fld arg1 / fmul [edi] / fstp [edi], then the three mutated words copy
    // to the result.
    [[0x10138915, 'c705f8321e1000000000'], [0x1013893e, '8b3df8321e10'],
      [0x10138946, '7504'], [0x10138948, '8d7c2414'],
      [0x10138967, 'd9442408'], [0x1013896b, 'd80f'], [0x10138978, 'd91f'],
      [0x1013897a, 'd944240c'], [0x1013897e, 'd84f04'], [0x10138981, 'd95f04'],
      [0x10138984, 'd9442410'], [0x10138988, 'd84f08'], [0x1013898b, 'd95f08'],
      [0x10138993, '8902'], [0x1013899a, '894a04'], [0x1013899d, '894208']]],
  sin: [187, 0x10102388, 0x10135d20, 'object.sin',
    [0x29, 0x70, 0x04],
    [['A', 'float', false, false], ['ReturnValue', 'float', true, true]],
    /native\(187\)\s+static final function\s+float\s+Sin\s*\(\s*float\s+A\s*\)/,
    // fld f32 -> fstp qword widen -> call thunk 0x101033a0 -> 0x10123240
    // (fld qword; fsin; ret) -> one fstp f32 store.
    [[0x10135d4f, 'd944240c'], [0x10135d54, 'dd1c24'],
      [0x10135d5a, 'e841d6fcff'], [0x10135d66, 'd919']]],
  cos: [188, 0x10101faa, 0x10135dd0, 'object.cos',
    [0x29, 0x73, 0x04],
    [['A', 'float', false, false], ['ReturnValue', 'float', true, true]],
    /native\(188\)\s+static final function\s+float\s+Cos\s*\(\s*float\s+A\s*\)/,
    // call thunk 0x101019b0 -> 0x10123250 (fld qword; fcos; ret).
    [[0x10135dff, 'd944240c'], [0x10135e04, 'dd1c24'],
      [0x10135e0a, 'e8a1bbfcff'], [0x10135e16, 'd919']]],
  tan: [189, 0x101022ed, 0x10135e80, 'object.tan',
    [0x29, 0x79, 0x01],
    [['A', 'float', false, false], ['ReturnValue', 'float', true, true]],
    /native\(189\)\s+static final function\s+float\s+Tan\s*\(\s*float\s+A\s*\)/,
    // call thunk 0x101025c2 -> 0x10123260 (fld qword; fptan; fstp st(0);
    // ret) — the fstp pops the 1.0 FPTAN pushes over its result.
    [[0x10135eaf, 'd944240c'], [0x10135eb4, 'dd1c24'],
      [0x10135eba, 'e803c7fcff'], [0x10135ec6, 'd919']]],
  atan: [190, 0x10102126, 0x10135f30, 'object.atan',
    [0x29, 0x70, 0x01],
    [['A', 'float', false, false], ['ReturnValue', 'float', true, true]],
    /native\(190\)\s+static final function\s+float\s+Atan\s*\(\s*float\s+A\s*\)/,
    // call thunk 0x1010122b -> 0x10123270 (fld qword; fld1; fpatan; ret).
    [[0x10135f5f, 'd944240c'], [0x10135f64, 'dd1c24'],
      [0x10135f6a, 'e8bcb2fcff'], [0x10135f76, 'd919']]],
};

// Helpers the bodies reach: appStrcmp forwards to the shipped MSVCRT
// wcscmp through IAT 0x102ab4ec; the four transcendental thunks run the
// x87 instructions directly; /= calls the shipped _ftol thunk.
const HELPERS = {
  strcmpThunk: [0x101012c1, 0x10123540,
    [[0x10123540, '8b442408'], [0x10123544, '8b4c2404'],
      [0x1012354a, 'ff15ecb42a10'], [0x10123553, 'c3']]],
  ftolThunk: [0x1016eec0, null, [[0x1016eec0, 'ff25b8b42a10']]],
  fsinHelper: [0x101033a0, 0x10123240,
    [[0x10123240, 'dd442404'], [0x10123244, 'd9fe'], [0x10123246, 'c3']]],
  fcosHelper: [0x101019b0, 0x10123250,
    [[0x10123250, 'dd442404'], [0x10123254, 'd9ff'], [0x10123256, 'c3']]],
  fptanHelper: [0x101025c2, 0x10123260,
    [[0x10123260, 'dd442404'], [0x10123264, 'd9f2'], [0x10123266, 'ddd8'],
      [0x10123268, 'c3']]],
  fpatanHelper: [0x1010122b, 0x10123270,
    [[0x10123270, 'dd442404'], [0x10123274, 'd9e8'], [0x10123276, 'd9f3'],
      [0x10123278, 'c3']]],
};

assert.deepEqual(oracle.addresses.natives, Object.fromEntries(Object.entries(NATIVES).map(
  ([name, [index, thunk, body]]) => [name, { index, thunk: `0x${thunk.toString(16)}`, body: `0x${body.toString(16)}` }],
)));

const IMAGE_BASE = 0x10100000;
for (const [name, [index, thunk, body, , , , , pins]] of Object.entries(NATIVES)) {
  assert.equal(coreDll[thunk - IMAGE_BASE], 0xe9, `${name}: thunk jump opcode`);
  const rel = coreDll.readInt32LE(thunk - IMAGE_BASE + 1);
  assert.equal(thunk + 5 + rel, body, `${name}: thunk target`);
  for (const [address, hex] of pins)
    assert.equal(coreDll.subarray(address - IMAGE_BASE, address - IMAGE_BASE + hex.length / 2).toString('hex'), hex,
      `${name}: instruction at ${address.toString(16)}`);
}
for (const [name, [thunk, body, pins]] of Object.entries(HELPERS)) {
  assert.equal(coreDll[thunk - IMAGE_BASE], thunk === 0x1016eec0 ? 0xff : 0xe9, `${name}: thunk opcode`);
  if (body !== null) {
    const rel = coreDll.readInt32LE(thunk - IMAGE_BASE + 1);
    assert.equal(thunk + 5 + rel, body, `${name}: thunk target`);
  }
  for (const [address, hex] of pins)
    assert.equal(coreDll.subarray(address - IMAGE_BASE, address - IMAGE_BASE + hex.length / 2).toString('hex'), hex,
      `${name}: instruction at ${address.toString(16)}`);
}

// The two IAT slots reached by the compare and /= bodies must name the
// shipped-MSVCRT routines the oracle executes: wcscmp (0x102ab4ec) and
// _ftol (0x102ab4b8).
function peImports(dll) {
  const pe = dll.readUInt32LE(60), opt = pe + 24;
  const base = dll.readUInt32LE(opt + 28);
  const importRva = dll.readUInt32LE(opt + 96 + 8);
  const section = opt + dll.readUInt16LE(pe + 20);
  const count = dll.readUInt16LE(pe + 6);
  const sections = [];
  for (let i = 0; i < count; i++)
    sections.push({ virtual: dll.readUInt32LE(section + i * 40 + 12),
      raw: dll.readUInt32LE(section + i * 40 + 20), rsize: dll.readUInt32LE(section + i * 40 + 16) });
  const off = rva => {
    for (const s of sections) if (rva >= s.virtual && rva - s.virtual < s.rsize) return s.raw + rva - s.virtual;
    return rva;
  };
  const cstr = o => dll.toString('ascii', o, dll.indexOf(0, o));
  const result = new Map();
  for (let d = off(importRva); dll.readUInt32LE(d + 12); d += 20) {
    const original = dll.readUInt32LE(d), iat = dll.readUInt32LE(d + 16);
    const name = cstr(off(dll.readUInt32LE(d + 12))).toLowerCase();
    for (let i = 0; ; i++) {
      const entry = dll.readUInt32LE(off((original || iat) + i * 4));
      if (!entry) break;
      const sym = entry & 0x80000000 ? `ord${entry & 0xffff}` : cstr(off(entry + 2));
      result.set(base + iat + i * 4, [name, sym]);
    }
  }
  return result;
}
const imports = peImports(coreDll);
assert.deepEqual(imports.get(0x102ab4ec), ['msvcrt.dll', 'wcscmp'], 'wcscmp IAT slot');
assert.deepEqual(imports.get(0x102ab4b8), ['msvcrt.dll', '_ftol'], '_ftol IAT slot');

const files = [];
for (const name of await readdir(`${root}/System`))
  files.push({ path: name, read: () => readFile(`${root}/System/${name}`) });
const core = await new AssetStore(files).get('Core');

for (const [name, [index, , , path2, script, params, decl]] of Object.entries(NATIVES)) {
  assert.match(coreU, decl, `${name}: Core.u declaration`);
  const exportIndex = core.exportsByPath.get(path2);
  assert.ok(exportIndex, `${name}: missing export ${path2}`);
  const metadata = readFunctionMetadata(core, exportIndex);
  assert.equal(metadata.nativeIndex, index, `${name}: native index`);
  assert.deepEqual([...metadata.scriptBytes], script, `${name}: script bytes`);
  assert.deepEqual(metadata.parameters.map(p => [p.name, p.type, p.out, p.return]), params,
    `${name}: parameters`);
  assert.ok(primitiveNativeIndices.includes(index), `${name}: native ${index} is linked`);
}

// Float32 operands cross as bit patterns fed through an instance-variable
// reference (serialized literals reject non-finite patterns).  Strings
// cross the same way — serialized string constants hold only single-byte
// units, so variables carry every case.  Signaling-NaN operands quiet on
// the JavaScript number load; the oracle reran those bodies on the quieted
// bits (js* fields).
const view = new DataView(new ArrayBuffer(16));
const f32 = bits => (view.setUint32(0, bits >>> 0, true), view.getFloat32(0, true));
const bitsOf = value => (view.setFloat32(0, value, true), view.getUint32(0, true));
const finite = bits => (bits >>> 23 & 0xff) !== 0xff;

const variable = index => ({ bytes: [0x01, index], cost: 5 });
const floatLiteral = bits => {
  view.setUint32(0, bits >>> 0, true);
  return { bytes: [0x1e, view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)], cost: 5 };
};
const intLiteral = value => {
  view.setInt32(0, value | 0, true);
  return { bytes: [0x1d, view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)], cost: 5 };
};
const vectorLiteral = bits => {
  for (const [i, b] of bits.entries()) view.setUint32(i * 4, b >>> 0, true);
  return { bytes: [0x23, ...Array.from({ length: 12 }, (_, i) => view.getUint8(i))], cost: 13 };
};
const field = i => String.fromCharCode(65 + i);
// Operand kind per native/position — the oracle only knows bit patterns.
const KIND = {
  slt: ['string', 'string'], sle: ['string', 'string'], sge: ['string', 'string'],
  xor: ['bool', 'bool'], diveq: ['int', 'float'], asc: ['string'],
  muleq: ['vector', 'vector'],
  sin: ['float'], cos: ['float'], tan: ['float'], atan: ['float'],
};
const fixture = (index, args) => compileFunction({
  pkg: { imports: [], exports: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] },
  entry: { path: `Fixture.Native${index}` },
  bytes: Uint8Array.from([0x04, ...(index > 0xff ? [0x60 | (index >> 8), index & 0xff] : [index]),
    ...args.flatMap(arg => arg.bytes), 0x16]),
  size: 3 + (index > 0xff ? 1 : 0) + args.reduce((n, arg) => n + arg.cost, 0),
});

// Raw FString storage that the logical JavaScript string adapter cannot
// represent: an ArrayNum of zero maps to the substituted empty text; a
// valid buffer maps to its units (the first NUL terminates the logical
// text).  A null data pointer with a nonzero ArrayNum is left for the
// oracle alone — the emulated zero page answers it where the real game
// reads process memory.
const fstringJs = op => {
  if (typeof op === 'string') return { value: op };
  if (op.units === null) return null;
  return { value: op.num === 0 ? '' : String.fromCharCode(...op.units) };
};

const TRANSCENDENTAL = new Set(['sin', 'cos', 'tan', 'atan']);
let emulatorOnly = 0;
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
  let representable = true;
  for (const [i, op] of original.operands.entries()) {
    const kind = KIND[original.native][i];
    if (kind === 'string') {
      const text = fstringJs(op);
      if (text === null) { representable = false; break; }
      args.push(variable(i + 1));
      receiver[field(i)] = text.value;
    } else if (original.lvalue[i]) {
      args.push(variable(i + 1));
      receiver[field(i)] = kind === 'vector' ? op.map(f32) : op;
    } else if (kind === 'bool') {
      // The body's dword test makes any nonzero pattern true; the VM's bool
      // operand carries the same truth through Boolean().
      args.push(variable(i + 1));
      receiver[field(i)] = op !== 0;
    } else if (kind === 'vector') {
      args.push(op.every(finite) ? vectorLiteral(op) : variable(i + 1));
      if (!op.every(finite)) receiver[field(i)] = op.map(f32);
    } else if (kind === 'float') {
      args.push(finite(op) ? floatLiteral(op) : variable(i + 1));
      if (!finite(op)) receiver[field(i)] = f32(op);
    } else {
      args.push(intLiteral(op));
    }
  }
  if (!representable) {
    // {ptr:0, num:5} reached wcscmp/[0] reads on the emulated zero page —
    // the nonzero results prove the substitution keys on ArrayNum, not the
    // data pointer.  The substituted-empty result is what the operator
    // would have returned had the pointer been consulted.
    const empty = original.native === 'asc' ? 0
      : { slt: 1, sle: 1, sge: 0 }[original.native];
    assert.ok(original.resultBits[0] !== empty,
      `${original.name}: num!=0 with null data pointer is not the empty-substituted path`);
    continue;
  }

  const result = fixture(index, args).run(receiver);
  // Signaling NaN operands quiet on the JavaScript number load; for those
  // cases the oracle reran the body on the quieted bits (js* fields).
  const resultBits = original.jsResultBits ?? original.resultBits;
  const outBits = original.jsOutBits ?? original.outBits;
  const propAddr = original.jsPropAddr ?? original.propAddr;

  if (TRANSCENDENTAL.has(original.native)) {
    // 187-190 run x87 FSIN/FCOS/FPTAN/FPATAN.  Unicorn's softfloat implements
    // those four instructions by round-tripping through a host double, so its
    // VALUES are not the original's — the NaN sign, the +-inf result, the
    // inclusive 2^63 boundary and FPTAN's out-of-range result all disagree
    // with silicon (measured: tools/x87-transcendental-probe.c).  The
    // structural facts above (index, FFrame cursor advance, operand order,
    // result store width) are integer/memory behavior the emulator does model,
    // so they stay asserted here; the result values are validated against real
    // hardware by scripts/validate-x87-transcendental-hardware.mjs.
    emulatorOnly++;
  } else if (['slt', 'sle', 'sge', 'xor'].includes(original.native)) {
    assert.equal(result ? 1 : 0, resultBits[0], `${original.name}: VM result`);
  } else if (['asc', 'diveq'].includes(original.native)) {
    assert.equal((result | 0) >>> 0, resultBits[0], `${original.name}: VM result`);
  } else if (original.native === 'muleq') {
    assert.deepEqual(result.map(bitsOf), resultBits, `${original.name}: VM result`);
  } else {
    assert.equal(bitsOf(result), resultBits[0], `${original.name}: VM result`);
  }

  // An lvalue operand published its variable through GPropAddr and the
  // receiver field must hold the oracle's mutated words; a non-lvalue
  // first operand only mutates a discarded stack temporary.
  for (const [i, flag] of original.lvalue.entries()) {
    if (flag) {
      assert.ok(outBits[String(i)], `${original.name}: out operand ${i} captured`);
      const width = KIND[original.native][i] === 'vector' ? 3 : 1;
      const actual = KIND[original.native][i] === 'vector'
        ? receiver[field(i)].map(bitsOf)
        : [(receiver[field(i)] | 0) >>> 0];
      assert.deepEqual(actual, outBits[String(i)].slice(0, width),
        `${original.name}: out operand ${i} mutation`);
    } else if (i === 0 && (original.native === 'diveq' || original.native === 'muleq')) {
      // The out position took the stack-temporary fallback: no receiver
      // field was ever bound for it.
      assert.equal(receiver[field(i)], undefined, `${original.name}: temporary fallback ${i}`);
    }
  }
  if (original.native === 'diveq' || original.native === 'muleq')
    assert.equal(propAddr === 0, !original.lvalue[0], `${original.name}: GPropAddr handoff`);
  else
    assert.equal(propAddr, 0xdeadbeef, `${original.name}: no GPropAddr use`);
}

// The VM evaluates native operands left to right through the same property
// getters the original FFrame Step order produces.
{
  const evaluation = [];
  const receiver = {};
  for (const [name, value] of [['A', 'abc'], ['B', 'abd']]) {
    Object.defineProperty(receiver, name, {
      enumerable: true,
      get() { evaluation.push(name); return value; },
    });
  }
  assert.equal(fixture(115, [variable(1), variable(2)]).run(receiver), true,
    'fixture string compare of A,B');
  assert.deepEqual(evaluation, ['A', 'B'], 'VM evaluates string operands left to right');
}

// Malformed calls keep the unbound-native fallback: a shape that cannot be
// the declared signature is handed to services.native, not computed.
assert.throws(() => fixture(115, [variable(1), variable(2)]).run({ A: 1, B: 'x' }),
  /native 115/, 'string compare rejects a non-string operand');
assert.equal(fixture(115, [variable(1), variable(2)]).run({ A: 1, B: 'x' }, {},
  { native: () => 'fallback' }), 'fallback', 'malformed call reaches services.native');
assert.throws(() => fixture(160, [variable(1), variable(2)]).run({ A: 'x', B: 2 }),
  /native 160/, 'diveq rejects a non-number operand');
assert.throws(() => fixture(297, [variable(1), variable(2)]).run({ A: [1, 2], B: [1, 2, 3] }),
  /native 297/, 'muleq rejects a short vector');

// The transcendental sweep is retained as a CROSS-CHECK, not as an authority.
// Below the measured 2^26 argument-reduction bound the emulator's libm-derived
// result and the VM's Math.* result must agree exactly — that is the range the
// game actually uses, and a regression there would show up here.  Outside it
// the two legitimately part company: above 2^26 the VM refuses (the x87's
// 66-bit pi reduction is not reproduced), and for non-finite or |x| >= 2^63
// operands the emulator's own edges are wrong.  Real-hardware values are
// asserted by scripts/validate-x87-transcendental-hardware.mjs.
const SWEEP_NATIVE = { sin: 187, cos: 188, tan: 189, atan: 190 };
const sweepLog = {};
for (const name of ['sin', 'cos', 'tan', 'atan']) {
  const { count, data } = oracle.sweep[name];
  const buffer = Buffer.from(data, 'base64');
  assert.equal(buffer.length, count * 8, `${name}: sweep pair count`);
  const vm = fixture(SWEEP_NATIVE[name], [variable(1)]);
  const receiver = {};
  let refused = 0, emulatorEdge = 0, checked = 0;
  for (let i = 0; i < count; i++) {
    const input = buffer.readUInt32LE(i * 8), expected = buffer.readUInt32LE(i * 8 + 4);
    const x = f32(input);
    receiver.A = x;
    let got;
    try { got = bitsOf(vm.run(receiver)); }
    catch (error) {
      assert.ok(Number.isFinite(x) && Math.abs(x) >= 2 ** 26 && Math.abs(x) < 2 ** 63,
        `${name}: refused an operand inside the supported range at 0x${input.toString(16)}: ${error.message}`);
      refused++; continue;
    }
    if (!Number.isFinite(x) || Math.abs(x) >= 2 ** 63) { emulatorEdge += got !== expected ? 1 : 0; continue; }
    checked++;
    assert.equal(got, expected,
      `${name}: in-range divergence at 0x${input.toString(16)} -> VM 0x${got.toString(16)} emulator 0x${expected.toString(16)}`);
  }
  assert.ok(checked > 0, `${name}: sweep produced no in-range samples`);
  sweepLog[name] = { count, checked, refused, emulatorEdge };
}
console.log('transcendental cross-check (emulator agrees below 2^26): '
  + ['sin', 'cos', 'tan', 'atan'].map(n => `${n} ${sweepLog[n].checked} in-range, `
      + `${sweepLog[n].refused} refused, ${sweepLog[n].emulatorEdge} emulator-edge`).join('; '));

console.log(`Original Core </<=/>=(string)/Asc/^^//=/*=(vector) natives passed ${oracle.cases.length - emulatorOnly} `
  + `bit-exact cases; ${emulatorOnly} Sin/Cos/Tan/Atan cases checked structurally only `
  + '(values -> validate-x87-transcendental-hardware.mjs).');
