// Collects every number and snippet the promo shows, straight from the repo,
// its git history and the local original installation, into ad/build/facts.json.
// Claims in the video must trace to this file or to cited project docs.
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AssetStore} from '../../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../../src/unreal/script-metadata.mjs';
import {decodeScript} from '../../src/unreal/bytecode.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const out = path.join(repo, 'ad/build/facts.json');
const sh = (cmd, args) => execFileSync(cmd, args, {cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20});

// --- git history
const log = sh('git', ['log', '--reverse', '--format=%ad|%s', '--date=short']).trim().split('\n').map(line => {
  const [date, ...rest] = line.split('|');
  return {date, subject: rest.join('|')};
});
const perDay = {};
for (const {date} of log) perDay[date] = (perDay[date] ?? 0) + 1;
const first = log[0].date, last = log.at(-1).date;
const days = Math.round((Date.parse(last) - Date.parse(first)) / 86400000) + 1;
let insertions = 0, deletions = 0;
for (const line of sh('git', ['log', '--shortstat', '--format=']).split('\n')) {
  const ins = /(\d+) insertion/.exec(line), del = /(\d+) deletion/.exec(line);
  if (ins) insertions += Number(ins[1]);
  if (del) deletions += Number(del[1]);
}
const calendar = [];
for (let t = Date.parse(first); t <= Date.parse(last); t += 86400000) {
  const date = new Date(t).toISOString().slice(0, 10);
  calendar.push({date, commits: perDay[date] ?? 0});
}

// --- code and evidence counts
function walk(dir, test, acc = []) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, test, acc);
    else if (test(entry.name)) acc.push(p);
  }
  return acc;
}
const lines = files => files.reduce((sum, file) => sum + readFileSync(file, 'utf8').split('\n').length, 0);
const srcFiles = walk(path.join(repo, 'src'), name => /\.(mjs|js)$/.test(name));
const scriptNames = readdirSync(path.join(repo, 'scripts'));
const code = {
  runtimeModules: srcFiles.length,
  runtimeLines: lines(srcFiles),
  validators: scriptNames.filter(name => name.startsWith('validate-')).length,
  nativeOracles: scriptNames.filter(name => name.startsWith('validate-native')).length,
  docs: readdirSync(path.join(repo, 'docs')).filter(name => name.endsWith('.md')).length,
  docLines: lines(walk(path.join(repo, 'docs'), name => name.endsWith('.md'))),
  unitTests: readdirSync(path.join(repo, 'test')).filter(name => name.endsWith('.test.mjs')).length,
};

// --- original data: package header of DeusEx.u and the DeusExMover.Frob bytecode
const game = ['Deus Ex GOTY Edition', 'game'].map(dir => path.join(repo, dir)).find(dir => existsSync(path.join(dir, 'System')));
const systemFiles = readdirSync(path.join(game, 'System')).map(name => ({path: name, read: () => readFileSync(path.join(game, 'System', name))}));
const assets = new AssetStore(systemFiles);
const deusEx = await assets.get('DeusEx');
const header = [...readFileSync(path.join(game, 'System/DeusEx.u')).subarray(0, 64)].map(b => b.toString(16).padStart(2, '0'));
const pkg = {
  file: 'System/DeusEx.u', version: deusEx.pkg.version, names: deusEx.pkg.names.length,
  exports: deusEx.pkg.exports.length, imports: deusEx.pkg.imports.length, header,
};

const TOKENS = {0x00: 'LocalVariable', 0x01: 'InstanceVariable', 0x02: 'DefaultVariable', 0x04: 'Return', 0x05: 'Switch',
  0x06: 'Jump', 0x07: 'JumpIfNot', 0x08: 'Stop', 0x09: 'Assert', 0x0a: 'Case', 0x0b: 'Nothing', 0x0c: 'LabelTable',
  0x0d: 'GotoLabel', 0x0e: 'EatString', 0x0f: 'Let', 0x10: 'DynArrayElement', 0x11: 'New', 0x12: 'ClassContext',
  0x13: 'MetaCast', 0x14: 'LetBool', 0x16: 'EndFunctionParms', 0x17: 'Self', 0x18: 'Skip', 0x19: 'Context',
  0x1a: 'ArrayElement', 0x1b: 'VirtualFunction', 0x1c: 'FinalFunction', 0x1d: 'IntConst', 0x1e: 'FloatConst',
  0x1f: 'StringConst', 0x20: 'ObjectConst', 0x21: 'NameConst', 0x22: 'RotationConst', 0x23: 'VectorConst',
  0x24: 'ByteConst', 0x25: 'IntZero', 0x26: 'IntOne', 0x27: 'True', 0x28: 'False', 0x29: 'NativeParm',
  0x2a: 'NoObject', 0x2c: 'IntConstByte', 0x2d: 'BoolVariable', 0x2e: 'DynamicCast', 0x2f: 'Iterator',
  0x30: 'IteratorPop', 0x31: 'IteratorNext', 0x32: 'StructCmpEq', 0x33: 'StructCmpNe', 0x36: 'StructMember',
  0x38: 'GlobalFunction'};
const label = node => {
  const token = node.token ?? node.op;
  if (node.op === 'native') return `Native ${node.index}`;
  if (token >= 0x39 && token < 0x60) return 'Conversion';
  return TOKENS[token] ?? `0x${Number(token).toString(16)}`;
};
// Compact UnrealScript-like rendering of a decoded expression, for display.
const BINARY = {114: '==', 119: '!=', 130: '&&', 132: '||', 242: '==', 243: '!='};
function pretty(node) {
  if (!node) return '';
  const args = () => (node.args ?? []).map(pretty).join(', ');
  switch (node.op) {
    case 'native':
      if (node.index === 129 && node.args?.length === 1) return `!${pretty(node.args[0])}`;
      if (BINARY[node.index] && node.args?.length === 2) return `${pretty(node.args[0])} ${BINARY[node.index]} ${pretty(node.args[1])}`;
      return `native${node.index}(${args()})`;
    case 'literal': return node.value === null ? 'None' : node.value === true ? 'True' : node.value === false ? 'False' : String(node.value);
    case 0x00: case 0x01: case 0x02: return node.name ?? '?';
    case 0x2d: return pretty(node.value);
    case 0x2e: return `${node.name}(${pretty(node.value)})`;
    case 0x19: return `${pretty(node.context)}.${pretty(node.value)}`;
    case 0x1b: case 0x1c: case 0x38: return `${node.name ?? 'function'}(${args()})`;
    case 0x0f: case 0x14: return `${pretty(node.left)} = ${pretty(node.right)}`;
    case 0x07: return pretty(node.value);
    case 0x04: return node.value?.op === 0x0b ? '' : pretty(node.value);
    case 0x17: return 'self';
    case 0x25: return '0';
    case 0x26: return '1';
    case 0x27: return 'True';
    case 0x28: return 'False';
    case 0x2a: return 'None';
    default: return node.name ?? '';
  }
}
const operand = node => pretty(node);
const frobIndex = deusEx.pkg.exports.findIndex(entry => entry.className === 'Function' && entry.path === 'DeusExMover.Frob');
const frob = readFunctionMetadata(deusEx, frobIndex + 1, {includeChildren: false});
const decoded = decodeScript(frob);
const bytecode = {
  function: 'DeusExMover.Frob', size: frob.size,
  bytes: [...frob.bytes.subarray(0, 48)].map(b => b.toString(16).padStart(2, '0')),
  statements: [...decoded.statements.values()].slice(0, 22).map(({node}) => ({
    offset: node.offset, token: Number(node.token ?? (node.op === 'native' ? 0x60 : node.op)), op: label(node), operand: operand(node),
    ...(node.target !== undefined ? {target: node.target} : {}),
  })),
};

// --- native: checkMove disassembly (capstone through the project's probe environment)
const python = ['.cache/native-probe-env/bin/python', 'python3'].map(p => p.startsWith('.') ? path.join(repo, p) : p).find(p => p === 'python3' || existsSync(p));
let disassembly = [];
try {
  disassembly = sh(python, ['tools/disasm-body.py', game, 'Engine.dll', '0x103c3290-0x103c3360']).split('\n')
    .filter(line => /^0x/.test(line)).map(line => {
      const [, address, bytes, text] = /^(0x[0-9a-f]+):\s+([0-9a-f]+)\s+(.*)$/.exec(line);
      return {address, bytes, text};
    });
} catch (error) { console.warn('disassembly unavailable:', error.message.split('\n')[0]); }

// --- the JavaScript translation of the same routine
const navSource = readFileSync(path.join(repo, 'src/runtime/script-pawn-nav.mjs'), 'utf8').split('\n');
const start = navSource.findIndex(line => line.startsWith('export function checkMove('));
const port = navSource.slice(start, start + 34);

// --- measured evidence quoted from project docs (see README.md, docs/lighting.md)
const evidence = {
  packagesValidated: 219, mapsDecoded: 88,
  collisionRays: 10980, extentTraces: 7320, placementChains: 402, physicsFrames: 63, physicsQueries: 2547,
  getFrameCalls: 46, trainingTriangles: 24427, trainingTextures: 70, lightingMaxMeanDiff: 2.782,
  npcMeshes: 18, propMeshes: 46, dataLinkRoutes: 18,
};

const milestones = [
  ['2026-09-09', 'Training renders in the browser, original static lighting'],
  ['2026-09-09', 'Stage 2: movement, collision, doors'],
  ['2026-09-13', 'Doors run the original DeusExMover.Frob bytecode'],
  ['2026-09-16', 'UI natives bound from Extension.dll bodies'],
  ['2026-09-18', 'NPC navigation ported, bit-exact'],
  ['2026-09-20', 'NPCs start, tick and animate live'],
  ['2026-09-21', 'Instructor conversation with original subtitles'],
  ['2026-09-23', 'Crowbar, crate fragments, original DeusExHUD'],
  ['2026-09-25', 'Main menu, console chain, real Login'],
  ['2026-09-27', 'Original level tick and DataLinkPlay'],
];

mkdirSync(path.dirname(out), {recursive: true});
const facts = {generated: new Date().toISOString(), git: {commits: log.length, first, last, days, insertions, deletions, calendar},
  code, pkg, bytecode, disassembly, port, evidence, milestones};
writeFileSync(out, JSON.stringify(facts, null, 1));
console.log(JSON.stringify({commits: log.length, days, insertions, ...code, pkg: {names: pkg.names, exports: pkg.exports, imports: pkg.imports},
  bytecode: bytecode.statements.slice(0, 8), disassembly: disassembly.length, port: port.length}, null, 1));
