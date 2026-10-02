#!/usr/bin/env node
/** The Rust Galaxy module loader (native/galaxy-kernel) against the original
 * glxLoadMusic in Galaxy.dll (scripts/native-galaxy-music-oracle.py), byte for
 * byte, on all 35 DX songs, fresh and chained (each load after the original
 * glxUnloadMusic of the previous song), and on synthetic IT modules that
 * drive the branches the songs never reach (scripts/galaxy-music-synthetic.mjs).
 *
 * Also checked: the hazard flags against what the oracle measured (slack
 * reads, short reads, fill-dependent bytes), instruction coverage of the
 * original loader functions with every unreached run explained, and
 * translation mutants that the comparison must catch.
 *
 *   node scripts/validate-galaxy-music-loader.mjs [--refresh] [--oracle-only]
 *
 * Oracle dumps are cached under .cache/galaxy-music (keyed by the oracle
 * script, DLL and module hashes); --refresh reruns it. Needs
 * NATIVE_PROBE_PYTHON (default .cache/native-probe-env/bin/python) and
 * `npm run build:wasm` for src/runtime/galaxy-kernel.wasm. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {musicExports} from '../src/unreal/music-module.mjs';
import {loadGalaxyKernel, glxdSections, HAZARD, MUTANT} from '../src/runtime/galaxy-music-loader.mjs';
import {syntheticModules, faultingModules} from './galaxy-music-synthetic.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const ORACLE = 'scripts/native-galaxy-music-oracle.py';
const CACHE = '.cache/galaxy-music';
const GALAXY = '606e71d13bbd3c4db2460aabcf60d87b1c79bb49d77725cf9e087513c7d06353';
const args = process.argv.slice(2);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// Unreached instruction runs of the original loader functions (run start
// address -> reason). Any other unreached run fails the validator.
const UNREACHED = {
  0x10618bef: 'null stream (0x11): Update always passes &Mem (0x1060a77e)',
  0x10618c05: 'module already loaded (1): Update unregisters the previous song first (update-transition §2.1); the gate is translated',
  0x10618c1c: 'reset returned 2 (music playing): needs the player running (phase 2); translated',
  0x10618c2d: 'Flags bit 0 (stdio stream): Update passes GLX_LOADFROMMEMORY only',
  0x10618cb1: 'MIDI loader: not IT (UNSUPPORTED_FORMAT)',
  0x10618cd6: 'MTM loader: not IT (UNSUPPORTED_FORMAT)',
  0x10618cf8: 'FAR loader: not IT (UNSUPPORTED_FORMAT)',
  0x10618d2b: 'RIFF AM, S3M, PTM, ULT, XM, 669, STM, MOD loaders: not IT (UNSUPPORTED_FORMAT)',
  0x1060e970: 'reset: music playing (2), phase 2; translated',
  0x106289af: 'malloc failure (9): out of memory, not modeled',
  0x106289d0: 'malloc failure (9): out of memory, not modeled',
  0x106289ee: 'malloc failure (9): out of memory, not modeled',
  0x10628a0f: 'malloc failure (9): out of memory, not modeled',
  0x10628a83: 'dead: GV clamp after movsx byte (never > 0x7f)',
  0x10628cb8: 'malloc failure (9): out of memory, not modeled',
  0x10628f54: 'dead: pitch node (sbyte << 7) never exceeds 0x7fff',
  0x1062926e: 'realloc failure (9): out of memory, not modeled',
  0x10629667: 'malloc failure (9): out of memory, not modeled',
  0x10629adf: 'malloc failure (0xa): out of pattern memory, not modeled',
  0x1062fb44: 'sample Volume > 0x7fff: the IT conversion already clamps it',
  0x1062fb84: 'malloc failure (0xb): out of sample memory, not modeled',
  0x1062fbd4: 'stereo de-interleave: the IT loader never sets Type 0x40 (UNSUPPORTED_CODING)',
  0x1062fc86: 'delta decoding: the IT loader never sets Type 0x01 (UNSUPPORTED_CODING)',
  0x10618aac: 'seek whence 2 / unknown whence: the IT loader seeks with whence 0 and 1 only',
  0x106194ee: 'glxUnloadMusic while playing (2): phase 2; translated',
};

async function writeIfChanged(file, bytes) {
  if (existsSync(file) && sha(await readFile(file)) === sha(bytes)) return;
  await writeFile(file, bytes);
}

/** The 35 songs' Music export bytes, as Update hands them to glxLoadMusic. */
async function songModules() {
  const dir = path.join(gameDirectory(), 'Music');
  const names = (await readdir(dir)).filter(n => /\.umx$/i.test(n)).sort();
  const store = new AssetStore(names.map(n => ({path: `Music/${n}`, read: () => readFile(path.join(dir, n))})));
  const out = [];
  for (const n of names) {
    const exports = musicExports(await store.get(n.replace(/\.umx$/i, '')));
    assert.equal(exports.length, 1, `${n}: one Music export`);
    out.push({name: n.replace(/\.umx$/i, ''), bytes: exports[0].bytes});
  }
  return out;
}

async function ensureOracle(modules, moduleDir, outDir, chain) {
  await mkdir(moduleDir, {recursive: true});
  const wanted = new Set(modules.map(m => `${m.name}.it`));
  for (const f of await readdir(moduleDir)) if (!wanted.has(f)) await rm(path.join(moduleDir, f));
  for (const m of modules) await writeIfChanged(path.join(moduleDir, `${m.name}.it`), m.bytes);
  const summaryFile = path.join(outDir, 'summary.json');
  const oracleHash = sha(await readFile(ORACLE));
  if (!args.includes('--refresh') && existsSync(summaryFile)) {
    const summary = JSON.parse(await readFile(summaryFile, 'utf8'));
    const fresh = summary.oracle === oracleHash && summary.galaxy === GALAXY && Boolean(summary.chain && Object.keys(summary.chain).length) === chain &&
      Object.keys(summary.songs).length === modules.length &&
      modules.every(m => summary.songs[m.name]?.moduleSha256 === sha(m.bytes));
    if (fresh) return summary;
  }
  const started = Date.now();
  execFileSync(python, [ORACLE, gameDirectory(), moduleDir, outDir, ...(chain ? [] : ['--no-chain'])],
    {stdio: ['ignore', 'ignore', 'ignore'], maxBuffer: 1 << 26});
  console.log(`oracle: ${modules.length} modules from ${moduleDir} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return JSON.parse(await readFile(summaryFile, 'utf8'));
}

/** First difference between two dumps, by section and offset; null if equal. */
function firstDifference(mine, theirs) {
  if (Buffer.from(mine.buffer, mine.byteOffset, mine.byteLength).equals(Buffer.from(theirs.buffer, theirs.byteOffset, theirs.byteLength))) return null;
  const a = glxdSections(mine), b = glxdSections(theirs);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (!x || !y || x.tag !== y.tag) return `section ${i}: ${x?.tag ?? 'none'} vs original ${y?.tag ?? 'none'}`;
    const key = ['INST', 'SDAT', 'PATT'].includes(x.tag) ? ` slot ${x.payload[0] | x.payload[1] << 8}` +
      (x.tag === 'SDAT' ? ` sample ${x.payload[2] | x.payload[3] << 8}` : '') : '';
    if (x.payload.length !== y.payload.length) return `${x.tag}${key}: ${x.payload.length} bytes vs original ${y.payload.length}`;
    for (let j = 0; j < x.payload.length; j++) {
      if (x.payload[j] !== y.payload[j]) return `${x.tag}${key} byte ${j}: ${x.payload[j]} vs original ${y.payload[j]}`;
    }
  }
  return 'equal sections, different framing';
}

/** Ranges the original never writes, measured by the oracle's two fills, each
 * explained by the dump itself (predicted unwritten sample tail, a sample-mode
 * instrument without IMPS, or sample bytes taken from the slack). */
function explainUninitialised(name, dump, info, fill) {
  const sections = glxdSections(dump);
  const inst = new Map(sections.filter(s => s.tag === 'INST').map(s => [s.payload[0] | s.payload[1] << 8, s.payload.subarray(6)]));
  const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tails = [];
  for (const s of sections.filter(s => s.tag === 'SDAT')) {
    const slot = s.payload[0] | s.payload[1] << 8, k = s.payload[2] | s.payload[3] << 8;
    const smp = view(inst.get(slot).subarray(0x14a + 0x48 * k));
    const kind = smp.getUint16(0x2c, true), length = smp.getUint32(0x30, true), loopEnd = smp.getUint32(0x38, true);
    const bps = kind & 4 ? 2 : 1;
    if (kind & 8 && loopEnd < length) tails.push(`${slot}/${k}:${8 + Math.max(loopEnd + 31, length) * bps}-${8 + (length + 31) * bps}`);
  }
  let bytes = 0, instrumentHoles = 0;
  const measuredTails = [];
  for (const [tag, key, ranges] of fill.uninitialised) {
    for (const [start, end] of ranges) {
      bytes += end - start;
      if (info.slackReads > 0 && tag !== 'INST') continue; // the slack's bytes propagate (HAZARD.slackRead)
      if (tag === 'SDAT') { measuredTails.push(`${key[0]}/${key[1]}:${start}-${end}`); continue; }
      if (tag === 'INST' && start >= 6 + 0x14a && end <= 6 + 0x192 && view(inst.get(key[0])).getUint16(0x148, true) === 0) {
        instrumentHoles++; continue; // sample mode without 'IMPS'
      }
      // Instrument mode after an error: realloc'd records past Samples never written.
      if (tag === 'INST' && info.status !== 0 && start >= 6 + 0x14a + 0x48 * view(inst.get(key[0])).getUint16(0x148, true)) continue;
      assert.fail(`${name}: unexplained uninitialised ${tag} ${key} [${start}, ${end})`);
    }
  }
  if (info.slackReads === 0) {
    // A short sample read (0x10) leaves that one sample's data unwritten past what was read.
    const extra = measuredTails.filter(t => !tails.includes(t));
    assert.ok(extra.length === 0 || (info.status === 0x10 && extra.length === 1), `${name}: unexplained sample bytes ${extra}`);
    assert.deepEqual(measuredTails.filter(t => tails.includes(t)), tails, `${name}: unwritten sample tails = [max(LoopEnd+31, Length), Length+31) of looped samples`);
  }
  return {bytes, tails: tails.length, instrumentHoles};
}

const songs = await songModules();
assert.equal(songs.length, 35, '35 music packages');
const synthetic = syntheticModules();
const songSummary = await ensureOracle(songs, `${CACHE}/modules`, `${CACHE}/oracle`, true);
const synthSummary = await ensureOracle(synthetic, `${CACHE}/synthetic`, `${CACHE}/oracle-synthetic`, false);
assert.ok(songs.every(s => songSummary.songs[s.name].status === 0), 'the original loads every DX song');
assert.deepEqual(songSummary.chainFinalUnload, {result: 0, liveBlocks: 0}, 'the original unload frees every block');

if (args.includes('--oracle-only')) {
  const v = Object.values(songSummary.songs);
  console.log(`oracle: ${v.length} songs, ${v.reduce((n, s) => n + s.dumpBytes, 0)} dump bytes, ` +
    `${v.reduce((n, s) => n + s.patterns, 0)} patterns, ${v.reduce((n, s) => n + s.samplesWithData, 0)} samples with data`);
  process.exit(0);
}

if (!existsSync('src/runtime/galaxy-kernel.wasm')) throw new Error('Run npm run build:wasm first (src/runtime/galaxy-kernel.wasm).');
const kernel = await loadGalaxyKernel();
const oracleDump = async (dir, name) => new Uint8Array(await readFile(path.join(CACHE, dir, `${name}.glxd`)));

/** Fresh loads of a corpus; with stopAtFirst, return at the first difference. */
async function runFresh(modules, dir, summary, {stopAtFirst = false, check = false} = {}) {
  const failures = [];
  let bytes = 0, uninitialised = 0, tails = 0, holes = 0;
  for (const m of modules) {
    kernel.reset(16); kernel.clearLogs();
    const {status, hazards} = kernel.load(m.bytes);
    const mine = kernel.lastDump(), theirs = await oracleDump(dir, m.name);
    const diff = firstDifference(mine, theirs);
    if (diff) { failures.push(`${m.name}: ${diff}`); if (stopAtFirst) break; continue; }
    bytes += mine.length;
    if (!check) continue;
    const info = summary.songs[m.name], fill = summary.fillCheck[m.name];
    assert.equal(status, info.status, `${m.name}: status`);
    const u = explainUninitialised(m.name, theirs, info, fill);
    uninitialised += u.bytes; tails += u.tails; holes += u.instrumentHoles;
    assert.equal(Boolean(hazards & HAZARD.slackRead), info.slackReads > 0, `${m.name}: slack-read hazard`);
    assert.equal(Boolean(hazards & HAZARD.shortRead), info.shortReads > 0, `${m.name}: short-read hazard`);
    assert.equal(Boolean(hazards & HAZARD.patternOverread), info.patternOverreads.length > 0, `${m.name}: pattern overread hazard`);
    assert.equal(Boolean(hazards & HAZARD.uninitInstrument), u.instrumentHoles > 0, `${m.name}: uninitialised-instrument hazard`);
    assert.equal(Boolean(hazards & HAZARD.unwrittenSampleTail), u.tails > 0, `${m.name}: unwritten sample tail`);
  }
  return {failures, bytes, uninitialised, tails, holes};
}

/** Each song after the previous one's unload, as the original chain ran. */
async function runChain({stopAtFirst = false} = {}) {
  const failures = [];
  let bytes = 0;
  kernel.reset(16);
  for (const [i, m] of songs.entries()) {
    kernel.clearLogs();
    if (i) assert.equal(kernel.unload(), 0, `unload before ${m.name}`);
    kernel.load(m.bytes);
    const mine = kernel.lastDump(), diff = firstDifference(mine, await oracleDump('oracle/chain', m.name));
    if (diff) { failures.push(`chain ${m.name}: ${diff}`); if (stopAtFirst) break; continue; }
    bytes += mine.length;
  }
  assert.equal(kernel.unload(), 0, 'final unload');
  return {failures, bytes};
}

kernel.setMutant(MUTANT.none);
const fresh = await runFresh(songs, 'oracle', songSummary, {check: true});
assert.deepEqual(fresh.failures, [], 'songs: Rust dump = original dump');
const chain = await runChain();
assert.deepEqual(chain.failures, [], 'chain: Rust dump = original dump');
const synth = await runFresh(synthetic, 'oracle-synthetic', synthSummary, {check: true});
assert.deepEqual(synth.failures, [], 'synthetic: Rust dump = original dump');
for (const f of faultingModules()) {
  kernel.reset(16);
  assert.equal(kernel.load(f.bytes).status, f.status, `${f.name}: the kernel stops where the original faults`);
}
const chainDiffs = [...new Set(Object.values(songSummary.chain).flatMap(c => c.differsFromFresh))].sort();
assert.deepEqual(chainDiffs, ['ALOG', 'ORDR', 'SCRT'], 'chained loads differ from fresh only in carried state and the unload frees');

// Instruction coverage of the original functions, songs and synthetic modules together.
const songCoverage = JSON.parse(await readFile(`${CACHE}/oracle/coverage.json`, 'utf8'));
const synthCoverage = JSON.parse(await readFile(`${CACHE}/oracle-synthetic/coverage.json`, 'utf8'));
let instructions = 0, covered = 0, songCovered = 0;
const unreached = [];
songCoverage.forEach((f, i) => {
  const hit = new Set([...f.covered, ...synthCoverage[i].covered]);
  instructions += f.instructions.length; covered += hit.size; songCovered += f.covered.length;
  let run = null;
  for (const [address, text] of f.instructions) {
    if (hit.has(address)) { run = null; continue; }
    if (!run) { run = {function: f.function, address, text, count: 0}; unreached.push(run); }
    run.count++;
  }
});
const unexplained = unreached.filter(r => !UNREACHED[r.address]);
assert.deepEqual(unexplained.map(r => `${r.function} 0x${r.address.toString(16)} ${r.text}`), [], 'every unreached run is explained');
const stale = Object.keys(UNREACHED).map(Number).filter(a => !unreached.some(r => r.address === a));
assert.deepEqual(stale.map(a => `0x${a.toString(16)}`), [], 'no explained run is reached now');

// Mutants: each must make some comparison fail.
const caught = {};
for (const [name, id] of Object.entries(MUTANT).filter(([, id]) => id)) {
  kernel.setMutant(id);
  let where = null;
  for (const [corpus, run] of [['songs', () => runFresh(songs, 'oracle', songSummary, {stopAtFirst: true})],
    ['chain', () => runChain({stopAtFirst: true})],
    ['synthetic', () => runFresh(synthetic, 'oracle-synthetic', synthSummary, {stopAtFirst: true})]]) {
    const {failures} = await run();
    if (failures.length) { where = `${corpus}: ${failures[0]}`; break; }
  }
  caught[name] = where;
}
kernel.setMutant(MUTANT.none);
assert.deepEqual(Object.entries(caught).filter(([, w]) => !w).map(([n]) => n), [], 'every mutant is caught');

const v = Object.values(songSummary.songs);
console.log(`Galaxy loader: ${songs.length} songs equal to the original fresh (${fresh.bytes} bytes) and chained ` +
  `(${chain.bytes} bytes); ${synthetic.length} synthetic modules (${synth.bytes} bytes); ` +
  `${faultingModules().length} original-fault input stops as unsupported.`);
console.log(`  songs: ${v.reduce((n, s) => n + s.patterns, 0)} patterns, ${v.reduce((n, s) => n + s.samplesWithData, 0)} samples ` +
  `(${v.reduce((n, s) => n + s.sampleBytes, 0)} bytes), ${v.reduce((n, s) => n + s.instruments, 0)} instruments; ` +
  `slack reads 0, short reads 0; ${fresh.uninitialised} never-written bytes in ${fresh.tails} looped-sample tails.`);
console.log(`  coverage: ${covered}/${instructions} original instructions (songs alone ${songCovered}); ` +
  `${unreached.length} unreached runs, all explained.`);
console.log(`  mutants caught (${Object.keys(caught).length}/${Object.keys(caught).length}):`);
for (const [n, w] of Object.entries(caught)) console.log(`    ${n}: ${w}`);
