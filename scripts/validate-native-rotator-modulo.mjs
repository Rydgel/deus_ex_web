/** Validate Core.Object ==/!=/%/>>(vector,rotator)/*(rotator,float)/-(rotator)/+=/-= against the original DLLs. */

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
  path.resolve('scripts/native-rotator-modulo-oracle.py'), root,
], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));

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
assert.deepEqual(oracle.tokens, {
  FloatConst: '0x1e', VectorConst: '0x23', RotatorConst: '0x22',
  LocalVariable: '0x0', EndFunctionParms: '0x16',
});

// name: [index, thunk, body, Core.u path, serialized script, parameter rows
//        [name,type,out,return], declaration regex, code pins]
const NATIVES = {
  req: [142, 0x10102b30, 0x10139400, 'object.equalequal_rotatorrotator',
    [0x29, 0x41, 0x03, 0x29, 0x40, 0x03],
    [['A', 'struct', false, false], ['B', 'struct', false, false],
      ['ReturnValue', 'bool', true, true]],
    /native\(142\)\s+static final operator\(24\)\s+bool\s+==\s*\(\s*rotator\s+A,\s*rotator\s+B\s*\)/,
    // Three plain CMP dword pairs (pitch, yaw, roll — the pop esi between
    // them shifts the [esp+x] slots); equal stores dword 1, the jne tail
    // stores dword 0.
    [[0x1013944d, '3bd0'], [0x1013945a, '3bc1'], [0x10139466, '3bc8'],
      [0x1013946e, 'b801000000'], [0x10139473, '8902'],
      [0x1013947f, '33c0'], [0x10139481, '8901']]],
  mod: [173, 0x101031d9, 0x10135020, 'object.percent_floatfloat',
    [0x29, 0x75, 0x03, 0x29, 0x76, 0x03],
    [['A', 'float', false, false], ['B', 'float', false, false],
      ['ReturnValue', 'float', true, true]],
    /native\(173\)\s+static final operator\(18\)\s+float\s+%\s*\(\s*float\s+A,\s*float\s+B\s*\)/,
    // fld B -> fstp qword, then fld A -> fstp qword (cdecl fmod(A, B)), one
    // fstp dword result store.
    [[0x1013506c, 'd944240c'], [0x10135077, 'dd1c24'],
      [0x1013507a, 'd944240c'], [0x10135084, 'dd1c24'],
      [0x10135087, 'e871c7fcff'], [0x10135093, 'd91a']]],
  rne: [203, 0x10102086, 0x101394f0, 'object.notequal_rotatorrotator',
    [0x29, 0x44, 0x03, 0x29, 0x45, 0x03],
    [['A', 'struct', false, false], ['B', 'struct', false, false],
      ['ReturnValue', 'bool', true, true]],
    /native\(203\)\s+static final operator\(26\)\s+bool\s+!=\s*\(\s*rotator\s+A,\s*rotator\s+B\s*\)/,
    // Same three CMPs; equal stores dword 0, the jne tail stores dword 1.
    [[0x1013953d, '3bd0'], [0x1013954a, '3bc1'], [0x10139556, '3bc8'],
      [0x1013955e, '33c0'], [0x10139560, '8902'],
      [0x1013956c, 'b801000000'], [0x10139571, '8901']]],
  rrotate: [276, 0x10101cc6, 0x101380e0, 'object.greatergreater_vectorrotator',
    [0x29, 0x74, 0x03, 0x29, 0x70, 0x03],
    [['A', 'struct', false, false], ['B', 'struct', false, false],
      ['ReturnValue', 'struct', true, true]],
    /native\(276\)\s+static final operator\(22\)\s+vector\s+>>\s*\(\s*vector\s+A,\s*rotator\s+B\s*\)/,
    // Identity FCoords rep-movsd from 0x101b3230; per-angle quantized-sine
    // indexes (a+0x4000)>>2 & a>>2 against the runtime-filled 0x101b32a4
    // table; three calls to the FCoords transform; the closing dot block's
    // fmul/faddp chain ends in three fstp dword stores.
    [[0x10138131, '8d9000400000'], [0x10138137, 'c1fa02'],
      [0x1013813a, 'be30321b10'], [0x10138145, '81e2ff3f0000'],
      [0x10138150, 'f3a5'], [0x10138155, '8d0c95a4321b10'],
      [0x10138152, 'c1f802'], [0x1013819c, 'd9e0'],
      [0x101381db, 'e817a6fcff'], [0x10138274, 'e87ea5fcff'],
      [0x10138319, 'e8d9a4fcff'], [0x1013835d, 'd84a0c'],
      [0x1013837d, 'dec3'], [0x1013837f, 'dec5'], [0x10138381, 'dec2'],
      [0x1013839e, 'd91f'], [0x101383a0, 'd95f04'], [0x101383a3, 'd95f08']]],
  rmulf: [287, 0x10101f64, 0x101395e0, 'object.multiply_rotatorfloat',
    [0x29, 0x79, 0x02, 0x29, 0x78, 0x02],
    [['A', 'struct', false, false], ['B', 'float', false, false],
      ['ReturnValue', 'struct', true, true]],
    /native\(287\)\s+static final operator\(16\)\s+rotator\s+\*\s*\(\s*rotator\s+A,\s*float\s+B\s*\)/,
    // fild pitch -> fmul f32 scalar -> _ftol, per component; the low DWORD
    // of each int64 is stored.
    [[0x10139627, 'db442408'], [0x1013962f, 'd84c2418'],
      [0x10139636, 'e885580300'], [0x1013963b, 'db44240c'],
      [0x10139641, 'd84c2418'], [0x10139645, 'e876580300'],
      [0x1013964a, 'db442410'], [0x10139650, 'd84c2418'],
      [0x10139654, 'e867580300'], [0x1013965d, '8932'],
      [0x1013965f, '897a04'], [0x10139664, '894208']]],
  fmulr: [288, 0x10101c12, 0x101396d0, 'object.multiply_floatrotator',
    [0x29, 0x7c, 0x02, 0x29, 0x7d, 0x02],
    [['A', 'float', false, false], ['B', 'struct', false, false],
      ['ReturnValue', 'struct', true, true]],
    /native\(288\)\s+static final operator\(16\)\s+rotator\s+\*\s*\(\s*float\s+A,\s*rotator\s+B\s*\)/,
    // Same per-component fild/fmul/_ftol; the float operand is evaluated
    // first into [esp+8] and the rotator into [esp+0xc].
    [[0x10139717, 'db44240c'], [0x1013971f, 'd84c2408'],
      [0x10139726, 'e895570300'], [0x1013972b, 'db442410'],
      [0x10139731, 'd84c2408'], [0x10139735, 'e886570300'],
      [0x1013973a, 'db442414'], [0x10139740, 'd84c2408'],
      [0x10139744, 'e877570300'], [0x1013974d, '8932'],
      [0x1013974f, '897a04'], [0x10139754, '894208']]],
  rsub: [317, 0x1010164a, 0x10139bb0, 'object.subtract_rotatorrotator',
    [0x29, 0x61, 0x02, 0x29, 0x60, 0x02],
    [['A', 'struct', false, false], ['B', 'struct', false, false],
      ['ReturnValue', 'struct', true, true]],
    /native\(317\)\s+static final operator\(20\)\s+rotator\s+-\s*\(\s*rotator\s+A,\s*rotator\s+B\s*\)/,
    // Three independent dword SUBs (pitch, yaw, roll) — mod-2^32 wrap, no
    // angle normalization.
    [[0x10139c05, '2bca'], [0x10139c0b, '2bc6'], [0x10139c11, '2bd6'],
      [0x10139c17, '8906'], [0x10139c19, '894e04'], [0x10139c1c, '895608']]],
  raddeq: [318, 0x10102059, 0x10139c90, 'object.addequal_rotatorrotator',
    [0x29, 0x64, 0x02, 0x29, 0x65, 0x02],
    [['A', 'struct', true, false], ['B', 'struct', false, false],
      ['ReturnValue', 'struct', true, true]],
    /native\(318\)\s+static final operator\(34\)\s+rotator\s+\+=\s*\(\s*out\s+rotator\s+A,\s*rotator\s+B\s*\)/,
    // GPropAddr cleared, first operand evaluated as an lvalue, edi =
    // GPropAddr with the stack temporary as fallback; three dword ADDs
    // write back through edi, then the three words copy to the result.
    [[0x10139c95, 'c705f8321e1000000000'], [0x10139cbe, '8b3df8321e10'],
      [0x10139cc6, '7504'], [0x10139cc8, '8d7c2414'],
      [0x10139cf2, '8b37'], [0x10139cf4, '03f2'], [0x10139cfa, '8937'],
      [0x10139d03, '03c8'], [0x10139d05, '894f04'],
      [0x10139d0f, '03c1'], [0x10139d11, '894708'],
      [0x10139d19, '8902'], [0x10139d1f, '894a04'], [0x10139d23, '894208']]],
  rsubeq: [319, 0x10102a2c, 0x10139d90, 'object.subtractequal_rotatorrotator',
    [0x29, 0x59, 0x02, 0x29, 0x58, 0x02],
    [['A', 'struct', true, false], ['B', 'struct', false, false],
      ['ReturnValue', 'struct', true, true]],
    /native\(319\)\s+static final operator\(34\)\s+rotator\s+-=\s*\(\s*out\s+rotator\s+A,\s*rotator\s+B\s*\)/,
    // Same GPropAddr handoff; the three component ops are SUBs.
    [[0x10139d95, 'c705f8321e1000000000'], [0x10139dbe, '8b3df8321e10'],
      [0x10139dc6, '7504'], [0x10139dc8, '8d7c2414'],
      [0x10139df2, '8b37'], [0x10139df4, '2bf2'], [0x10139dfa, '8937'],
      [0x10139e03, '2bc8'], [0x10139e05, '894f04'],
      [0x10139e0f, '2bc1'], [0x10139e11, '894708'],
      [0x10139e19, '8902'], [0x10139e1f, '894a04'], [0x10139e23, '894208']]],
};

// The helpers the bodies reach: the shipped-MSVCRT _ftol import thunk
// (287/288), the fmod thunk chain ending at the shipped _CIfmod (173), and
// the shared FCoords helpers 276 composes with.
const HELPERS = {
  ftolThunk: [0x1016eec0, null, [[0x1016eec0, 'ff25b8b42a10']]],
  fmodThunk: [0x101017fd, 0x10123230, [[0x10123230, 'dd442404'],
    [0x10123234, 'dd44240c'], [0x10123238, 'e9d7bc0400']]],
  cifmodThunk: [0x1016ef14, null, [[0x1016ef14, 'ff25f0b42a10']]],
  vectorCtor: [0x10102860, 0x10117690, [[0x101176a6, 'c20c00']]],
  coordsCtor: [0x10102af4, 0x10118990, [[0x10118999, '8b31'], [0x101189a9, '8b4c240c']]],
  coordsTransform: [0x101027f7, 0x1011a710,
    [[0x1011a736, 'd822'], [0x1011a73a, 'd86204'], [0x1011a73f, 'd86208'],
      [0x1011a746, 'd84a0c'], [0x1011a766, 'dec3'], [0x1011a768, 'dec5'],
      [0x1011a76a, 'dec2'], [0x1011a787, 'd91f'],
      [0x1011a789, 'd95f04'], [0x1011a78c, 'd95f08']]],
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
  assert.equal(coreDll[thunk - IMAGE_BASE], thunk === 0x1016eec0 || thunk === 0x1016ef14 ? 0xff : 0xe9,
    `${name}: thunk opcode`);
  if (body !== null) {
    const rel = coreDll.readInt32LE(thunk - IMAGE_BASE + 1);
    assert.equal(thunk + 5 + rel, body, `${name}: thunk target`);
  }
  for (const [address, hex] of pins)
    assert.equal(coreDll.subarray(address - IMAGE_BASE, address - IMAGE_BASE + hex.length / 2).toString('hex'), hex,
      `${name}: instruction at ${address.toString(16)}`);
}

// The two IAT slots the thunks jump through must name the shipped-MSVCRT
// routines the oracle executes: _ftol (0x102ab4b8) and _CIfmod
// (0x102ab4f0).  A minimal import-directory walk proves the symbols.
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
assert.deepEqual(imports.get(0x102ab4b8), ['msvcrt.dll', '_ftol'], '_ftol IAT slot');
assert.deepEqual(imports.get(0x102ab4f0), ['msvcrt.dll', '_CIfmod'], '_CIfmod IAT slot');

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

// Float32 operands cross as bit patterns.  Rotator components are int32
// words; vector components are float32 words.  Non-finite bit patterns are
// fed through an instance-variable reference (serialized literals reject
// them), which is also what makes a signaling NaN reach the VM quieted.
const view = new DataView(new ArrayBuffer(16));
const f32 = bits => (view.setUint32(0, bits >>> 0, true), view.getFloat32(0, true));
const bitsOf = value => (view.setFloat32(0, value, true), view.getUint32(0, true));
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
const field = i => String.fromCharCode(65 + i);
// Operand kind per native/position — the oracle only knows bit patterns.
const KIND = {
  req: ['rotator', 'rotator'], rne: ['rotator', 'rotator'],
  mod: ['float', 'float'], rrotate: ['vector', 'rotator'],
  rmulf: ['rotator', 'float'], fmulr: ['float', 'rotator'],
  rsub: ['rotator', 'rotator'], raddeq: ['rotator', 'rotator'], rsubeq: ['rotator', 'rotator'],
};
const fixture = (index, args) => compileFunction({
  pkg: { imports: [], exports: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] },
  entry: { path: `Fixture.Native${index}` },
  bytes: Uint8Array.from([0x04, ...(index > 0xff ? [0x60 | (index >> 8), index & 0xff] : [index]),
    ...args.flatMap(arg => arg.bytes), 0x16]),
  size: 3 + (index > 0xff ? 1 : 0) + args.reduce((n, arg) => n + arg.cost, 0),
});

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
    const kind = KIND[original.native][i];
    if (original.lvalue[i]) {
      args.push(variable(i + 1));
      receiver[field(i)] = op.slice();   // rotator lvalue: int32 words
    } else if (kind === 'rotator') {
      args.push(rotatorLiteral(op));
    } else if (kind === 'vector') {
      args.push(op.every(finite) ? vectorLiteral(op) : variable(i + 1));
      if (!op.every(finite)) receiver[field(i)] = op.map(f32);
    } else {
      args.push(finite(op) ? floatLiteral(op) : variable(i + 1));
      if (!finite(op)) receiver[field(i)] = f32(op);
    }
  }
  const result = fixture(index, args).run(receiver);
  // Signaling NaN operands quiet on the JavaScript number load; for those
  // cases the oracle reran the body on the quieted bits (js* fields).
  const resultBits = original.jsResultBits ?? original.resultBits;
  const outBits = original.jsOutBits ?? original.outBits;
  const propAddr = original.jsPropAddr ?? original.propAddr;
  if (original.native === 'req' || original.native === 'rne')
    assert.equal(result ? 1 : 0, resultBits[0], `${original.name}: VM result`);
  else if (resultBits.length === 1)
    assert.equal(nanNorm(bitsOf(result)), nanNorm(resultBits[0]), `${original.name}: VM result`);
  else if (original.native === 'rrotate')
    assert.deepEqual(result.map(v => nanNorm(bitsOf(v))), resultBits.map(nanNorm),
      `${original.name}: VM result`);
  else
    assert.deepEqual(result.map(v => (v | 0) >>> 0), resultBits.map(v => v >>> 0),
      `${original.name}: VM result`);

  // An lvalue operand published its variable through GPropAddr and the
  // receiver field must hold the oracle's mutated words; a non-lvalue
  // first operand only mutates a discarded stack temporary, so the
  // computed words still return but no receiver field changes.
  for (const [i, flag] of original.lvalue.entries()) {
    if (flag) {
      assert.ok(outBits[String(i)], `${original.name}: out operand ${i} captured`);
      assert.deepEqual(receiver[field(i)].map(v => (v | 0) >>> 0), outBits[String(i)],
        `${original.name}: out operand ${i} mutation`);
    } else if (original.native === 'raddeq' || original.native === 'rsubeq') {
      // The out position took the stack-temporary fallback: no receiver
      // field was ever bound for it.
      assert.equal(receiver[field(i)], undefined, `${original.name}: temporary fallback ${i}`);
    }
  }
  if (original.native === 'raddeq' || original.native === 'rsubeq')
    assert.equal(propAddr === 0, !original.lvalue[0],
      `${original.name}: GPropAddr handoff`);
  else
    assert.equal(propAddr, 0xdeadbeef, `${original.name}: no GPropAddr use`);
}

// The VM evaluates native operands left to right through the same property
// getters the original FFrame Step order produces.
const evaluation = [];
const receiver = {};
for (const [name, value] of [['A', [10, 20, 30]], ['B', [1, 2, 3]]]) {
  Object.defineProperty(receiver, name, {
    enumerable: true,
    get() { evaluation.push(name); return value; },
  });
}
assert.deepEqual(fixture(317, [variable(1), variable(2)]).run(receiver), [9, 18, 27],
  'fixture subtract of B from A');
assert.deepEqual(evaluation, ['A', 'B'], 'VM evaluates rotator operands left to right');

console.log(`Original Core ==/!=/%/>>/*(rotator,float)/-/+=/-= natives passed ${oracle.cases.length} bit-exact, extended-product truncation, CRT-fmod domain/NaN, GPropAddr out-mutation, quantized-sine composition, operand-order, and FFrame cursor cases.`);
