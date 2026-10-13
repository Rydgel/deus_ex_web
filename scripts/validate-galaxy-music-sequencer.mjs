#!/usr/bin/env node
/** The Rust Galaxy module player (native/galaxy-kernel/src/sequencer.rs)
 * against the original Galaxy.dll player running under Unicorn
 * (scripts/native-galaxy-music-sequencer-oracle.py), tick by tick.
 *
 * Cases (docs/galaxy-music/sequencer.md, docs/galaxy-music.md "Phase 2"):
 *   - every DX song x sections 0..5, played until the first order wrap or
 *     backward jump plus 64 ticks (sections past a song's last order take
 *     glxControlMusic's 0x11 path);
 *   - a same-song section switch after 400 callbacks, and a switch to a
 *     section past the end;
 *   - Title for 300 callbacks, UnregisterMusic, then Intro (chained state);
 *   - three counter phases (voice update before, after and with the tick);
 *   - the phase-1 synthetic modules and the sequencer modules of
 *     scripts/galaxy-music-synthetic.mjs (effects, Amiga slides, envelopes,
 *     order and row edge cases), with heap reads checked.
 * Each case is a program of library calls; the oracle runs it, the Rust
 * kernel replays the same calls through the galaxy_seq_* exports with the
 * oracle's callback counts, and the per-tick SHA-256 digests of the trace
 * (globals, music voice records, the 14 inner-kernel arguments, refill
 * posts) must be equal. On a mismatch the first differing group is decoded
 * from both sides and diffed field by field.
 *
 * Also checked: the pan table under PC 64/53/24 and the 1112 .rdata table
 * dwords against the kernel's; instruction coverage of the original player
 * functions with a reason for every unreached run; mutants 101..109, each of
 * which some case must catch.
 *
 *   node scripts/validate-galaxy-music-sequencer.mjs [--refresh] [--jobs N]
 *        [--cases REGEX] [--oracle-only] [--no-mutants]
 *
 * Oracle outputs are cached per case under .cache/galaxy-music/sequencer-corpus
 * (keyed by the oracle and loader scripts, the DLL, the program and the module
 * hashes); stale cases run over up to --jobs (default 4) oracle processes,
 * logging to sequencer-corpus/logs. A cold run takes about 20 minutes with four
 * processes (about 1.2 GB each); a cached one about 5. Needs NATIVE_PROBE_PYTHON (default
 * .cache/native-probe-env/bin/python) and src/runtime/galaxy-kernel.wasm
 * (npm run build:wasm).
 *
 * The cache is per checkout (.cache is untracked): a worktree whose .cache lacks
 * galaxy-music/ runs cold, and one without a recorded time in
 * .cache/validator-timings.json gets the sweep runner's ten-minute default limit.
 * The oracle seconds recorded per case in the cache sum to 4561 s (238 cases, the
 * longest 144 s), 1141 s on four processes by the longest-first split above (a
 * sweep on this host measured 874 s), and the cached part takes 310 s here (390 s
 * recorded): 20 to 24 minutes cold. Neither has changed since 2026-10-06 (the
 * oracle, loader and case list are unchanged), so a sweep failure at ten minutes
 * is a cold cache or a missing recorded time, not a slowdown. The line below is
 * the limit the runner (scripts/run-validators.mjs) allows a cold run.
 *
 * runner-timeout: 2400 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWriteStream, existsSync} from 'node:fs';
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {musicExports} from '../src/unreal/music-module.mjs';
import {syntheticModules, sequencerModules} from './galaxy-music-synthetic.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const ORACLE = 'scripts/native-galaxy-music-sequencer-oracle.py';
const LOADER = 'scripts/native-galaxy-music-oracle.py';
const CACHE = '.cache/galaxy-music/sequencer-corpus';
const OUT = `${CACHE}/oracle`;
const GALAXY = '606e71d13bbd3c4db2460aabcf60d87b1c79bb49d77725cf9e087513c7d06353';
const EFFECTS_CHANNELS = 16, SAMPLE_VOLUME = 127, MUSIC_VOLUME = 76;
const PC = 64; // the oracle's glxInit runs under FPCW 0x037f; the game's PC is open
const FULL = 256;
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const jobs = Math.max(1, Number(option('--jobs', 4)));
const caseFilter = option('--cases', null);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// Rust faults for the original's faults (oracle fault kinds).
const FAULT = {read: 0x106, spin: 0x108, memory: 0x109};
const MUTANTS = {
  tickBeforeVoiceUpdate: 101, noPatternEndPass: 102, nullPatternWaits: 103, keyOffKeepsVoice: 104,
  panSlew256: 105, linearLowBits: 106, runWithoutPlusOne: 107, arpeggioSwap: 108, panTablePc53: 109,
};

// Unreached instruction runs of the original player functions (run start ->
// reason). Any other unreached run fails the validator, as does a listed run
// that a case now reaches.
const MIDI = 'MIDI player mode only: the IT loader always sets player mode bit 1 (tracker), 0x1062a30f';
const EFFECTS = 'effects voices only (glxStartSample path, not translated): no effect voice plays in a music case';
const UNREACHED = {
  0x10614ebf: `${MIDI} (key off jumps the volume envelope to its sustain point)`,
  0x10614f39: `${MIDI} (key off, pitch envelope sustain)`,
  0x10614f9c: `${MIDI} (key off, pan envelope sustain)`,
  0x106151ce: `${EFFECTS}: the stream refill post needs an active voice below the first music voice`,
  0x1061532d: 'pan slew: every music pan write (8xx, E8x, sample default pan, order-0 reset) sets +0x14 and +0x16 together, ' +
    'so the ±0x200 slew never runs for music (mutant panSlew256 is equivalent here)',
  0x1061544e: 'sample Type bit 7 clear: the IT loader always sets it (0x106297f0), so a key-off voice keeps its loop',
  0x10615529: 'sample Type bit 7 clear (as 0x1061544e)',
  0x10615560: `${EFFECTS}: the end-of-voice callback needs +0x11 bit 1, which music voices never carry`,
  0x1061580d: 'track handler of player mode 4 (0x10615a60): not set by the IT loader (kernel: UNSUPPORTED_HANDLER)',
  0x10615822: 'track handler of player mode 0 (0x106168b0, MIDI): not set by the IT loader (kernel: UNSUPPORTED_HANDLER)',
  0x1061591d: `${MIDI} (tick periods at order 0)`,
  0x10616ff8: 'dead clamp: the channel is flag & 0x1f, never above 0x20',
  0x10617194: 'sample articulation pointer (+0x40) set: the IT loader leaves it 0',
  0x10617696: 'dead: command 6 tests tick 0 again after returning on tick 0 (a copy of command 4\'s memory merge)',
  0x106178aa: 'Galaxy command C (set volume): no IT effect translates to it (it-loader §7)',
  0x106179a9: 'Galaxy E5x (finetune): no IT effect translates to it (S2x is dropped)',
  0x10617bf6: `${MIDI} (Fxx tick periods)`,
  0x10617dd2: 'note delay with a sample articulation pointer: the IT loader leaves it 0',
  0x10617f5f: 'music volume ramp: DX calls glxSetMusicVolume with rate 0 only (0x106062b5, 0x10606697)',
  0x10617f8b: 'music volume ramp (as 0x10617f5f)',
  0x10617fc9: 'music volume ramp step: rate 0 leaves the step 0, and current = target',
  0x10617fec: 'effects volume ramp: DX calls glxSetSampleVolume with rate 0 only (0x1060625e, 0x10606441, 0x10606562)',
  0x10618018: 'effects volume ramp (as 0x10617fec)',
  0x10618056: 'effects volume ramp step (as 0x10617fc9)',
  0x10618092: 'channel volume ramp: +0x41 (MIDI channel volume target) never changes for IT music',
  0x106180b0: 'channel volume ramp (as 0x10618092)',
  0x106180d8: 'channel volume ramp (as 0x10618092)',
  0x106183fb: 'glxStopMusic with no channels while playing: a start needs channels, and glxUnloadMusic refuses while playing',
  0x10612306: 'glxStartMusic while playing: Update calls glxStopMusic first (0x1060a822)',
  0x1060d127: 'glxControlMusic(2, N < 0): Update passes SongSection zero-extended (0x1060a85a)',
  0x1060eb8e: 'glxSetMusicVolume with a rate: DX passes 0',
  0x1060ebb5: 'glxSetMusicVolume above 0x7f: DX passes ftol(fade·MusicVolume/255·127) ≤ 127',
  0x1060ec2e: 'glxSetSampleVolume with a rate: DX passes 0',
  0x1060ec55: 'glxSetSampleVolume above 0x7f (as 0x1060ebb5)',
  0x10604239: 'DX callback with a voice: only the end-of-voice callback (+0x11 bit 1, effects voices) passes one',
};
// Mutants no case can catch, with the unreached run that shows why.
const EQUIVALENT = {panSlew256: 0x1061532d};

// ---- modules and cases ---------------------------------------------------------

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

async function writeModules(dir, modules) {
  await mkdir(dir, {recursive: true});
  const wanted = new Set(modules.map(m => `${m.name}.it`));
  for (const f of await readdir(dir)) if (!wanted.has(f)) await rm(path.join(dir, f));
  for (const m of modules) {
    const file = path.join(dir, `${m.name}.it`);
    if (!existsSync(file) || sha(await readFile(file)) !== sha(m.bytes)) await writeFile(file, m.bytes);
  }
}

const play = (module, section, run, extra = {}) => ({
  program: [{op: 'load', module}, {op: 'start', section}, {op: 'pin', voiceCounter: 0, tickCounter: 0}, {op: 'ahead', value: 1}, run],
  ...extra,
});
const untilLoop = (cap = 40000) => ({op: 'run', until: 'loop', margin: 64, cap});

function buildCases(songs, synthetic) {
  const cases = [];
  for (const s of songs) for (let section = 0; section < 6; section++) cases.push({name: `${s.name}.s${section}`, ...play(s.name, section, untilLoop())});
  const head = (module, section) => [{op: 'load', module}, {op: 'start', section}, {op: 'pin', voiceCounter: 0, tickCounter: 0}, {op: 'ahead', value: 1}];
  cases.push({name: 'UNATCO_Music.switch0to3', program: [...head('UNATCO_Music', 0), {op: 'run', callbacks: 400}, {op: 'start', section: 3}, untilLoop()]});
  cases.push({name: 'Intro_Music.switchPastEnd', program: [...head('Intro_Music', 0), {op: 'run', callbacks: 400}, {op: 'start', section: 200}, untilLoop()]});
  cases.push({name: 'Title-Intro.chain', program: [...head('Title_Music', 0), {op: 'run', callbacks: 300}, {op: 'unload'},
    {op: 'load', module: 'Intro_Music'}, {op: 'start', section: 0}, untilLoop()]});
  // A section > 0 start after another song: speed 48 / tempo 120 from the
  // reset, and Title's tick period (nothing recomputes it until an Fxx).
  cases.push({name: 'Title-Endgame1s4.chain', program: [...head('Title_Music', 0), {op: 'run', callbacks: 300}, {op: 'unload'},
    {op: 'load', module: 'Endgame1_Music'}, {op: 'start', section: 4}, {op: 'run', callbacks: 1500}]});
  // The console's MUSICORDER n: glxControlMusic(1, atoi(n)), relative when negative.
  const order = arg => ({op: 'control', cmd: 1, arg});
  cases.push({name: 'Intro_Music.musicorder', program: [...head('Intro_Music', 0), {op: 'run', callbacks: 300}, order(5),
    {op: 'run', callbacks: 300}, order(-1), {op: 'run', callbacks: 300}, order(-20), {op: 'run', callbacks: 200}, order(100),
    {op: 'run', callbacks: 200}, order(0), {op: 'run', callbacks: 200}]});
  // Loop flag 0 (glxControlMusic(3, 0)): no DX caller, but the translated
  // branches (B jumping backwards refused, the order walk at the end) run here.
  cases.push({name: 'Sequencer_Linear.loopFlag0', checkReads: true, program: [{op: 'load', module: 'Sequencer_Linear'},
    {op: 'start', section: 0}, {op: 'control', cmd: 3, arg: 0}, {op: 'pin', voiceCounter: 0, tickCounter: 0}, {op: 'ahead', value: 1},
    {op: 'run', callbacks: 900}]});
  const phases = [['voiceFirst', 0x00012345, 0x0100abcd, 'Intro_Music'], ['tickFirst', 0x02008000, 0x0000c000, 'Endgame1_Music'],
    ['sameChunk', 0x0000ffff, 0x0000ffff, 'Lebedev_Music']];
  for (const [phase, voice, tick, song] of phases) {
    cases.push({name: `${song}.phase-${phase}`, program: [{op: 'load', module: song}, {op: 'start', section: 0},
      {op: 'pin', voiceCounter: voice, tickCounter: tick}, {op: 'ahead', value: 1}, {op: 'run', callbacks: 2000}]});
  }
  // SBx's order-- looks like a backward jump to 'until loop', so the loop on a
  // last row runs a fixed time instead (long enough for its third pass).
  const runs = {Sequencer_LoopLastRow: {op: 'run', callbacks: 600}};
  for (const m of synthetic) cases.push({name: m.name, ...play(m.name, 0, runs[m.name] ?? untilLoop(2000), {checkReads: true})});
  // MusicVolume 255 (music master 127): voice levels above 16384, where the
  // pan table's last entry (32767 at PC 64, 32766 at PC 53) changes B at pan 0.
  const loud = play('Sequencer_Linear', 0, untilLoop(2000), {checkReads: true});
  loud.program[0].musicVolume = 127;
  cases.push({name: 'Sequencer_Linear.volume127', ...loud});
  return cases;
}

// ---- oracle ----------------------------------------------------------------------

async function caseInfo(name, dir = OUT) {
  const file = path.join(dir, `${name}.json`);
  return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : null;
}

function fresh(info, c, hashes, moduleHashes) {
  return info && info.galaxy === GALAXY && info.oracle === hashes.oracle && info.loader === hashes.loader &&
    JSON.stringify(info.program) === JSON.stringify(c.program) && Boolean(info.checkReads) === Boolean(c.checkReads) &&
    c.program.filter(s => s.op === 'load').every(s => info.moduleSha256?.[s.module] === moduleHashes[s.module]) &&
    existsSync(path.join(OUT, `${c.name}.dig`));
}

function runOracle(names, outDir, extra, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [ORACLE, gameDirectory(), `${CACHE}/modules,${CACHE}/synthetic`, `${CACHE}/cases.json`, outDir,
      '--cases', names.join(','), ...extra], {stdio: ['ignore', 'ignore', 'pipe']});
    const file = createWriteStream(log);
    let tail = '';
    child.stderr.on('data', chunk => {
      file.write(chunk);
      tail = (tail + chunk).slice(-4000);
      for (const line of String(chunk).split('\n').filter(Boolean)) console.log(`  [${path.basename(log, '.log')}] ${line}`);
    });
    child.on('close', code => { file.end(); code === 0 ? resolve() : reject(new Error(`oracle exited ${code}:\n${tail}`)); });
  });
}

async function ensureOracle(cases, hashes, moduleHashes) {
  const stale = [];
  for (const c of cases) {
    const info = await caseInfo(c.name);
    if (args.includes('--refresh') || !fresh(info, c, hashes, moduleHashes) || !existsSync(path.join(OUT, 'oracle.json'))) {
      stale.push({c, cost: info?.seconds ?? (c.checkReads ? 3 : 15)});
    }
  }
  if (!stale.length) return 0;
  stale.sort((a, b) => b.cost - a.cost);
  const bins = Array.from({length: Math.min(jobs, stale.length)}, () => ({names: [], cost: 0}));
  for (const s of stale) { const bin = bins.reduce((a, b) => (b.cost < a.cost ? b : a)); bin.names.push(s.c.name); bin.cost += s.cost; }
  await mkdir(`${CACHE}/logs`, {recursive: true});
  const started = Date.now();
  console.log(`oracle: ${stale.length} stale cases over ${bins.length} processes (estimated ${Math.max(...bins.map(b => b.cost)).toFixed(0)} s each)`);
  await Promise.all(bins.map((b, i) => runOracle(b.names, OUT, [], `${CACHE}/logs/oracle-${i}.log`)));
  console.log(`oracle: done in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  return stale.length;
}

// ---- Rust replay -----------------------------------------------------------------

const kernel = async () => (await WebAssembly.instantiate(await readFile('src/runtime/galaxy-kernel.wasm'))).instance.exports;

/** Replay a case: the oracle's program with its callback counts. Returns the
 * per-group digests, the fault and the callbacks completed, and optionally the
 * raw records of one group. */
function replay(x, c, info, modules, {mutant = 0, capture = -1} = {}) {
  x.galaxy_set_mutant(mutant);
  x.galaxy_reset(EFFECTS_CHANNELS);
  x.galaxy_seq_setup(PC);
  x.galaxy_seq_trace(1);
  const digests = [];
  let captured = null;
  const drain = () => {
    const n = x.galaxy_trace_groups_len();
    if (!n) return;
    const groups = new Uint32Array(x.memory.buffer, x.galaxy_trace_groups_ptr(), n).slice();
    const mem = new Uint8Array(x.memory.buffer), buf = x.galaxy_trace_ptr();
    let start = 0;
    for (const end of groups) {
      const bytes = mem.subarray(buf + start, buf + end);
      if (digests.length === capture) captured = bytes.slice();
      digests.push(createHash('sha256').update(bytes).digest().subarray(0, 8));
      start = end;
    }
    x.galaxy_trace_consume();
  };
  const runs = info.steps.filter(s => 'run' in s).map(s => s.run);
  let fault = 0;
  for (const step of c.program) {
    if (step.op === 'load') {
      const bytes = modules.get(step.module);
      const ptr = x.galaxy_input(bytes.length);
      new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
      x.galaxy_seq_load(bytes.length, SAMPLE_VOLUME, step.musicVolume ?? MUSIC_VOLUME);
    } else if (step.op === 'unload') x.galaxy_seq_unload();
    else if (step.op === 'start') x.galaxy_seq_start(EFFECTS_CHANNELS, step.section);
    else if (step.op === 'control') x.galaxy_seq_control(step.cmd, step.arg);
    else if (step.op === 'pin') x.galaxy_seq_pin(step.voiceCounter >>> 0, step.tickCounter >>> 0);
    else if (step.op === 'ahead') x.galaxy_seq_ahead(step.value);
    else if (step.op === 'run') {
      if (!runs.length) break; // the oracle stopped at a fault before this step
      // The oracle's faulting callback is not counted in its run; replay it too.
      let n = runs.shift() + (info.fault && !runs.length ? 1 : 0);
      while (n > 0 && !fault) {
        const k = Math.min(n, 64);
        fault = x.galaxy_seq_callbacks(k);
        drain();
        n -= k;
      }
      if (fault) break;
    }
  }
  x.galaxy_seq_end();
  drain();
  return {digests, fault, callbacks: x.galaxy_seq_callback_count(), captured};
}

/** null if the replay equals the oracle, else {group, why}. */
function compare(rust, info, theirs) {
  const total = theirs.length / 8;
  const limit = info.fault ? info.fault.group : total;
  for (let g = 0; g < Math.min(limit, rust.digests.length); g++) {
    if (Buffer.compare(Buffer.from(rust.digests[g]), theirs.subarray(8 * g, 8 * g + 8))) return {group: g, why: `group ${g} differs`};
  }
  if (info.fault) {
    const want = FAULT[info.fault.kind];
    if (rust.fault !== want || rust.callbacks !== info.fault.callback || rust.digests.length !== total) {
      return {group: Math.min(limit, rust.digests.length), why: `original faults (${info.fault.kind}: ${info.fault.detail}) in callback ` +
        `${info.fault.callback}, group ${info.fault.group}; Rust fault 0x${rust.fault.toString(16)} after ${rust.callbacks} callbacks, ${rust.digests.length} groups`};
    }
    return null;
  }
  if (rust.fault) return {group: rust.digests.length - 1, why: `Rust fault 0x${rust.fault.toString(16)} after ${rust.callbacks} callbacks; the original has none`};
  if (rust.digests.length !== total) return {group: Math.min(total, rust.digests.length), why: `${rust.digests.length} groups vs original ${total}`};
  return null;
}

// ---- record decoding and diffs ---------------------------------------------------

const GLOBALS = [
  ['channels', 1], ['playing', 1], ['songLength', 1], ['firstMusicVoice', 1], ['playerMode', 1], ['order', 1], ['row', 1],
  ['lastRow', 1], ['tickInRow', 2], ['speed', 2], ['tempo', 2], ['initialSpeed', 2], ['initialTempo', 2], ['patternDelay', 1],
  ['breakFlag', 1], ['skipRows', 1], ['loopFlag', 1], ['pattern', 4], ['loopRow', 1], ['loopCounter', 1], ['minPeriod', 2],
  ['maxPeriod', 2], ['musicMaster', 1], ['musicTarget', 1], ['musicStep', 1], ['sfxMaster', 1], ['sfxTarget', 1], ['sfxStep', 1],
  ['tickCount', 4], ['voiceCounter', 4], ['voicePeriod', 4], ['tickCounter', 4], ['tickPeriod', 4], ['rate', 4],
  ['framesMixed', 4], ['ahead', 4], ['kernelMode', 1], ['outputFormat', 1],
];
const GLOBALS_SIZE = GLOBALS.reduce((n, [, w]) => n + w, 0);
const VOICE_FIELDS = Object.entries({
  0x00: 'fourcc', 0x04: 'size', 0x0c: 'note', 0x0d: 'instrument', 0x0e: 'sample', 0x0f: 'active', 0x10: 'enabled', 0x11: 'flags',
  0x12: 'chanGain', 0x14: 'pan', 0x16: 'panTarget', 0x18: 'velocity', 0x1a: 'gain', 0x1c: 'send2', 0x1e: 'send1', 0x20: 'block',
  0x24: 'volEnv', 0x26: 'volEnvDelta', 0x28: 'volEnvTick', 0x2a: 'fade', 0x2c: 'volEnvPoint', 0x2d: 'pitEnvPoint', 0x2e: 'pitFade',
  0x30: 'pitEnvTick', 0x32: 'pitEnvDelta', 0x34: 'pitEnv', 0x36: 'panEnv', 0x38: 'panEnvDelta', 0x3a: 'panEnvTick', 0x3c: 'panFade',
  0x3e: 'panEnvPoint', 0x3f: 'chanVol', 0x40: 'chanVolStep', 0x41: 'chanVolTarget', 0x42: 'sampleRecord', 0x46: 'pos', 0x4a: 'frac',
  0x4c: 'format', 0x4e: 'start', 0x52: 'loopStart', 0x56: 'loopEnd', 0x5a: 'end', 0x5e: 'c5', 0x62: 'step', 0x66: 'volume',
  0x68: 'baseVolume', 0x6a: 'period', 0x6c: 'basePeriod', 0x6e: 'vibDepth', 0x70: 'vibSpeed', 0x72: 'vibPhase', 0x74: 'vibWave',
  0x75: 'tremWave', 0x76: 'tremPhase', 0x78: 'tremSpeed', 0x7a: 'tremDepth', 0x7c: 'portaTarget', 0x7e: 'portaSpeed',
  0x80: 'arpeggio', 0x82: 'vibMemory', 0x83: 'tremMemory', 0x84: 'portaMemory', 0x85: 'offsetMemory', 0x86: 'cmd', 0x87: 'param',
  0x88: 'tail',
}).map(([o, n]) => [Number(o), n]);
const K_ARGS = ['voice', 'dry', 'send1', 'send2', 'count', 'pos', 'frac', 'step', 'B', 'A', 'send1B', 'send1A', 'send2B', 'send2A', 'mode'];

function records(bytes) {
  const out = [];
  for (let at = 0; at < bytes.length;) {
    const tag = String.fromCharCode(bytes[at]), n = bytes[at + 1] | bytes[at + 2] << 8 | bytes[at + 3] << 16 | bytes[at + 4] << 24;
    out.push({tag, payload: bytes.subarray(at + 5, at + 5 + n)});
    at += 5 + n;
  }
  return out;
}

/** Group g's records from a trace of whole groups starting at group `first`. */
function groupOf(bytes, g, first = 0) {
  const recs = records(bytes);
  let group = first, start = 0;
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].tag === 'T' || recs[i].tag === 'E') {
      if (group === g) return recs.slice(start, i + 1);
      group++; start = i + 1;
    }
  }
  return recs.slice(start);
}

const le = (b, o, w) => { let v = 0; for (let i = w - 1; i >= 0; i--) v = v * 256 + b[o + i]; return v; };
const hex = v => `0x${v.toString(16)}`;

/** Named differences between two records of the same tag. */
function fieldDiff(tag, a, b) {
  const out = [];
  if (tag === 'K' || tag === 'M' || tag === 'R' || tag === 'P' || tag === 'L' || tag === 'S') {
    const names = tag === 'K' ? K_ARGS : [];
    for (let i = 0; 4 * i < Math.max(a.length, b.length); i++) {
      const x = le(a, 4 * i, 4), y = le(b, 4 * i, 4);
      if (x !== y || a.length !== b.length) out.push(`${names[i] ?? `u32[${i}]`} ${hex(x)} vs original ${hex(y)}`);
    }
    return out;
  }
  if (a.length !== b.length) out.push(`length ${a.length} vs original ${b.length}`);
  let at = 0;
  if (tag === 'U' || tag === 'T') {
    for (const [name, w] of GLOBALS) {
      const x = le(a, at, w), y = le(b, at, w);
      if (x !== y) out.push(`${name} ${hex(x)} vs original ${hex(y)}`);
      at += w;
    }
    if (tag === 'T') {
      const fa = a[at], fb = b[at];
      if (fa !== fb) out.push(`pattern flag ${fa} vs original ${fb}`);
      for (let i = 0; fa && fb && i < 0x28; i += 4) {
        const x = le(a, at + 1 + i, 4), y = le(b, at + 1 + i, 4);
        if (x !== y) out.push(`pattern header +${hex(i)} ${hex(x)} vs original ${hex(y)}`);
      }
      at += 1 + (fa ? 0x28 : 0);
    }
  }
  const first = tag === 'E' ? 0 : a[3];
  for (let o = at; o < Math.min(a.length, b.length); o++) {
    if (a[o] === b[o]) continue;
    const rel = o - at, v = Math.floor(rel / 0xa0), off = rel % 0xa0;
    const [fo, name] = VOICE_FIELDS.filter(([k]) => k <= off).pop();
    out.push(tag === 'E' && v >= 256 ? `end state byte ${rel}: ${a[o]} vs original ${b[o]}` :
      `voice ${first + v} ${name}(+${hex(fo)}) byte +${hex(off)}: ${a[o]} vs original ${b[o]}`);
    if (out.length > 40) break;
  }
  return out;
}

function diffGroups(mine, theirs) {
  const lines = [];
  for (let i = 0; i < Math.max(mine.length, theirs.length) && lines.length < 60; i++) {
    const a = mine[i], b = theirs[i];
    if (!a || !b || a.tag !== b.tag) {
      lines.push(`record ${i}: ${a?.tag ?? 'none'} vs original ${b?.tag ?? 'none'}`);
      break;
    }
    if (Buffer.compare(Buffer.from(a.payload), Buffer.from(b.payload))) {
      for (const d of fieldDiff(a.tag, a.payload, b.payload)) lines.push(`record ${i} ${a.tag}: ${d}`);
    }
  }
  return lines;
}

async function diagnose(x, c, info, modules, group) {
  let theirs;
  if (group < FULL) {
    theirs = groupOf(new Uint8Array(await readFile(path.join(OUT, `${c.name}.full`))), group);
  } else {
    const dir = `${CACHE}/window`;
    await runOracle([c.name], dir, ['--window', `${group}:${group + 1}`], `${CACHE}/logs/window.log`);
    theirs = groupOf(new Uint8Array(await readFile(path.join(dir, `${c.name}.window`))), group, group);
  }
  const mine = replay(x, c, info, modules, {capture: group}).captured;
  return mine ? diffGroups(records(mine), theirs) : ['the replay has no such group'];
}

// ---- main -----------------------------------------------------------------------------

const songs = await songModules();
assert.equal(songs.length, 35, '35 music packages');
const synthetic = [...syntheticModules(), ...sequencerModules()];
await writeModules(`${CACHE}/modules`, songs);
await writeModules(`${CACHE}/synthetic`, synthetic);
const modules = new Map([...songs, ...synthetic].map(m => [m.name, m.bytes]));
const moduleHashes = Object.fromEntries([...modules].map(([n, b]) => [n, sha(b)]));
let cases = buildCases(songs, synthetic);
if (caseFilter) cases = cases.filter(c => new RegExp(caseFilter).test(c.name));
assert.ok(cases.length, 'no case selected');
await mkdir(OUT, {recursive: true});
await writeFile(`${CACHE}/cases.json`, JSON.stringify(buildCases(songs, synthetic)));
const hashes = {oracle: sha(await readFile(ORACLE)), loader: sha(await readFile(LOADER))};
await ensureOracle(cases, hashes, moduleHashes);
const infos = new Map();
for (const c of cases) {
  const info = await caseInfo(c.name);
  assert.ok(fresh(info, c, hashes, moduleHashes), `${c.name}: oracle output is current`);
  infos.set(c.name, info);
}
if (args.includes('--oracle-only')) process.exit(0);

if (!existsSync('src/runtime/galaxy-kernel.wasm')) throw new Error('Run npm run build:wasm first (src/runtime/galaxy-kernel.wasm).');
const x = await kernel();

// Tables: the pan table under each precision control, and the .rdata block.
const meta = JSON.parse(await readFile(path.join(OUT, 'oracle.json'), 'utf8'));
assert.equal(meta.oracle, hashes.oracle, 'oracle.json is current');
const panTables = {};
for (const pc of [64, 53, 24]) {
  const theirs = new Int16Array((await readFile(path.join(OUT, `pan-table-pc${pc}.bin`))).buffer.slice(0));
  const ptr = x.galaxy_pan_table_ptr(pc);
  const mine = new Int16Array(x.memory.buffer, ptr, 0x8000);
  const diffs = [];
  for (let i = 0; i < 0x8000; i++) if (mine[i] !== theirs[i]) diffs.push(`${hex(i)}: ${mine[i]} vs original ${theirs[i]}`);
  assert.deepEqual(diffs.slice(0, 8), [], `pan table PC ${pc}: Rust x87 model = Unicorn`);
  panTables[pc] = theirs;
}
const differing = (a, b) => a.reduce((n, v, i) => n + (v !== b[i]), 0);
const tablesTheirs = new Int32Array((await readFile(path.join(OUT, 'tables.bin'))).buffer.slice(0));
const tablesMine = new Int32Array(x.memory.buffer, x.galaxy_tables_ptr(), 1112);
const tableDiffs = [];
for (let i = 0; i < 1112; i++) if (tablesMine[i] !== tablesTheirs[i]) tableDiffs.push(`dword ${i}: ${tablesMine[i]} vs original ${tablesTheirs[i]}`);
assert.deepEqual(tableDiffs, [], '.rdata tables 0x1063daa0: generated = original');

// Replay every case.
const failures = [];
let ticks = 0, callbacks = 0, faults = 0;
for (const c of cases) {
  const info = infos.get(c.name);
  const theirs = await readFile(path.join(OUT, `${c.name}.dig`));
  const rust = replay(x, c, info, modules);
  const bad = compare(rust, info, theirs);
  ticks += info.ticks; callbacks += info.callbacks; faults += info.fault ? 1 : 0;
  if (!bad) continue;
  const lines = await diagnose(x, c, info, modules, bad.group);
  failures.push(`${c.name}: ${bad.why}\n      ${lines.join('\n      ')}`);
  console.log(`MISMATCH ${failures.at(-1)}`);
}
assert.deepEqual(failures, [], 'every case: Rust trace = original trace');

// Coverage of the original functions over all cases.
let coverageLine = 'coverage: not reported for a --cases subset';
if (!caseFilter) {
  const functions = JSON.parse(await readFile(path.join(OUT, 'coverage-functions.json'), 'utf8'));
  const hit = new Set(cases.flatMap(c => infos.get(c.name).coverage ?? []));
  let instructions = 0, covered = 0;
  const unreached = [];
  for (const f of functions) {
    let run = null;
    for (const [address, text] of f.instructions) {
      instructions++;
      if (hit.has(address)) { covered++; run = null; continue; }
      if (!run) { run = {function: f.function, address, text, count: 0}; unreached.push(run); }
      run.count++;
    }
  }
  const unexplained = unreached.filter(r => !UNREACHED[r.address]);
  assert.deepEqual(unexplained.map(r => `${r.function} 0x${r.address.toString(16)} (${r.count}) ${r.text}`), [], 'every unreached run is explained');
  const stale = Object.keys(UNREACHED).map(Number).filter(a => !unreached.some(r => r.address === a));
  assert.deepEqual(stale.map(hex), [], 'no explained run is reached now');
  coverageLine = `coverage: ${covered}/${instructions} original instructions; ${unreached.length} unreached runs, all explained`;
}

// Mutants: each must change some case's trace. Short cases first.
const caught = {};
if (!args.includes('--no-mutants')) {
  const order = [...cases].sort((a, b) => infos.get(a.name).ticks - infos.get(b.name).ticks);
  for (const [name, id] of Object.entries(MUTANTS)) {
    caught[name] = null;
    for (const c of order) {
      const info = infos.get(c.name);
      const bad = compare(replay(x, c, info, modules, {mutant: id}), info, await readFile(path.join(OUT, `${c.name}.dig`)));
      if (bad) { caught[name] = `${c.name}: ${bad.why}`; break; }
    }
    if (EQUIVALENT[name] !== undefined) {
      assert.equal(caught[name], null, `${name} is listed as equivalent but ${caught[name]}`);
      caught[name] = `equivalent: ${UNREACHED[EQUIVALENT[name]]}`;
    }
  }
  x.galaxy_set_mutant(0);
  assert.deepEqual(Object.entries(caught).filter(([, w]) => !w).map(([n]) => n), [], 'every mutant is caught');
}

console.log(`Galaxy sequencer: ${cases.length} cases equal to the original, ${ticks} ticks in ${callbacks} callbacks ` +
  `(${faults} cases end at an original fault, matched by the kernel's UNSUPPORTED_* stop).`);
console.log(`  pan tables equal at PC 64/53/24 (PC 53 differs from PC 64 at ${differing(panTables[53], panTables[64])} entries, ` +
  `PC 24 at ${differing(panTables[24], panTables[64])}); .rdata tables equal (1112 dwords).`);
console.log(`  ${coverageLine}`);
if (Object.keys(caught).length) {
  const equivalent = Object.keys(caught).filter(n => EQUIVALENT[n] !== undefined).length;
  console.log(`  mutants: ${Object.keys(caught).length - equivalent} caught, ${equivalent} equivalent for IT music:`);
  for (const [n, w] of Object.entries(caught)) console.log(`    ${n}: ${w}`);
}
