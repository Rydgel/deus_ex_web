#!/usr/bin/env node
/** Galaxy's DirectSound timer callback 0x106142a0 (Stage 4 gate row 4.3.7,
 * check 1 `galaxy-output-callback`, docs/audio-output-scope.md §6): the Rust
 * translation (native/galaxy-kernel/src/output.rs) against the original
 * callback running under Unicorn (scripts/native-galaxy-output-oracle.py)
 * with the real renderer, mixer and SSE kernel behind both and the same
 * scripted secondary buffer, bit for bit:
 *
 * - the first callback (heads seated at the cursors, the resync, the whole
 *   buffer copied, the zero-length locks of its normal render), steady state
 *   with jittered and odd cursors, wraps of both heads at the ring's end, a
 *   cursor jump of more than a ring, DSERR_BUFFERLOST on each Lock (Restore,
 *   Play, retry), other Lock and GetCurrentPosition failures, an underrun
 *   resync (a fabricated small `ahead`), the MUSICORDER resync with effect
 *   voices playing, coincident cursors, the closed output, other latencies,
 *   and seeded random programs;
 * - per callback: every secondary-buffer call with its arguments and
 *   results (each Lock's range and split, each Unlock), the heads A and B,
 *   `ahead`, R, and digests of the secondary buffer and the staging ring
 *   (every copied byte); the mixer trace (M/R/K/U/T) and the end state;
 * - instruction coverage of the callback, unreached runs explained;
 * - mutants 401..405, each of which must be caught.
 *
 *   node scripts/validate-galaxy-output-callback.mjs [--refresh] [--cases a,b]
 *
 * Needs NATIVE_PROBE_PYTHON, the IT modules in .cache/galaxy-music/modules
 * (validate-galaxy-music-loader.mjs writes them) and
 * src/runtime/galaxy-kernel.wasm. Oracle outputs are cached in
 * .cache/galaxy-output, keyed by the oracle scripts, the samples and the cases. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeSoundResource} from '../src/runtime/script-sound-resource.mjs';
import {gameDirectory} from './game-directory.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const ORACLE = 'scripts/native-galaxy-output-oracle.py';
const ORACLE_DEPS = [ORACLE, 'scripts/native-galaxy-effects-oracle.py', 'scripts/native-galaxy-music-sequencer-oracle.py',
  'scripts/native-galaxy-music-oracle.py', 'scripts/native-collision-oracle.py'];
const CACHE = '.cache/galaxy-output';
const SAMPLES = path.join(CACHE, 'samples');
const MODULES = '.cache/galaxy-music/modules';
const WASM = 'src/runtime/galaxy-kernel.wasm';
const args = process.argv.slice(2);
const sha = bytes => createHash('sha256').update(bytes).digest();
const SIZE = 176400, STEP = 3528, LATENCY_BYTES = 7056;
const VOICE = 0xa0;
const DS_OK = 0, DSERR_BUFFERLOST = 0x88780096, DSERR_INVALIDPARAM = 0x80070057, E_FAIL = 0x80004005;
const NULL_REGION = 0xffffffff;
const MUTANTS = {401: 'cursors not masked', 402: 'the resync returns', 403: 'ahead tested unsigned',
  404: 'BUFFERLOST not retried', 405: 'heads re-seated only at the first callback'};

// ---- samples ----------------------------------------------------------------------------

const NAMES = ['DeusExSounds.Generic.AlarmUnitHum', 'Ambient.Ambient.BabyCrying', 'DeusExSounds.Weapons.PlasmaRifleFire',
  'DeusExSounds.Generic.Beep1', 'MoverSFX.Door.MetalDoorClose'];

/** The WAV payloads of NAMES (Package.Group.Name, case-insensitive). */
async function waves() {
  const root = gameDirectory(), want = new Map(NAMES.map(n => [n.toLowerCase(), n])), out = new Map();
  const files = ['System/DeusExSounds.u', 'Sounds/Ambient.uax', 'Sounds/MoverSFX.uax'].map(f => ({path: path.join(root, f), read: () => readFile(path.join(root, f))}));
  const assets = new AssetStore(files);
  for (const name of ['DeusExSounds', 'Ambient', 'MoverSFX']) {
    const asset = await assets.get(name);
    for (const entry of asset.pkg.exports) {
      if (entry.className !== 'Sound') continue;
      const key = [...asset.exportsByPath].find(([, i]) => asset.pkg.exports[i - 1] === entry)?.[0];
      const full = `${name}.${key ?? entry.objectName}`.toLowerCase();
      if (!want.has(full)) continue;
      const decoded = decodeSoundResource({pkg: asset.pkg, bytes: asset.bytes, entry});
      const start = entry.serialOffset + decoded.lazy.inlineOffset;
      out.set(want.get(full), asset.bytes.slice(start, start + decoded.lazy.byteCount));
    }
  }
  for (const n of NAMES) if (!out.has(n)) throw new Error(`no shipped sound ${n}`);
  return out;
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
}
const pick = (r, list) => list[r() % list.length];

// ---- cases -------------------------------------------------------------------------------

const [HUM, BABY, PLASMA, BEEP, DOOR] = NAMES;
const prefix = (extra = []) => [{op: 'sampleVolume', volume: 127, mode: 0}, ...NAMES.map(sample => ({op: 'loadSample', sample})), ...extra];
const voices = [
  {op: 'startSample', voice: 1, sample: HUM, freq: 22050, vol: 0x7fff, pan: 0x3000},
  {op: 'startSample', voice: 2, sample: BABY, freq: 16000, vol: 0x6000, pan: 0x5000},
  {op: 'startSample', voice: 3, sample: PLASMA, freq: 44100, vol: 0x7fff, pan: 0x4000}];
const music = [{op: 'load', module: 'Intro_Music'}, {op: 'start', section: 0}];
const cb = (play, write, more = {}) => ({op: 'dsCallback', play: play >>> 0, write: write >>> 0, ...more});

/** Callbacks from `play` advancing by `steps` (an array or a function of the
 * index), the write cursor `lead(i)` bytes ahead. Returns [ops, last play]. */
function steady(play, count, step = () => STEP, lead = () => 1764) {
  const ops = [];
  for (let i = 0; i < count; i++) {
    ops.push(cb(play % SIZE, (play + lead(i)) % SIZE));
    play += step(i);
  }
  return [ops, play];
}

function cases() {
  const out = [];
  {
    const [ops] = steady(0, 6);
    out.push({name: 'first-silent', program: prefix(ops)});
  }
  {
    const r = rng(7);
    const [ops] = steady(1000, 80, () => STEP - 24 + (r() % 13) * 4, () => 1764 + (r() % 9) * 4 - 16);
    out.push({name: 'steady-voices-music', program: prefix([...music, ...voices, ...ops])});
  }
  {
    // Both heads cross the ring's end (A's Lock splits, then B's), with odd
    // and out-of-range cursors (the % size and the block-align mask).
    const [a] = steady(SIZE - 6 * STEP, 4);
    const [b, end] = steady(SIZE - 2 * STEP + 2, 6, i => STEP + (i & 1 ? 3 : -1), () => 1765);
    const odd = [cb(SIZE + 4003, 2 * SIZE + 5001), cb(3 * SIZE + 7777, 3 * SIZE + 7777 + 1999), cb(0xfffffffe, 0xffffffff)];
    out.push({name: 'wrap-odd-cursors', program: prefix([...music, ...voices, ...a, ...b, ...odd, ...steady(end + 20000, 4)[0]])});
  }
  {
    // A jump of more than a ring: the modulo hides the lap, R is the remainder.
    const [a, p] = steady(5000, 5);
    const jumps = [cb((p + SIZE + 7000) % SIZE, (p + SIZE + 7000 + 1764) % SIZE),
      cb((p + 2 * SIZE + 7000 + 30000) % SIZE, (p + 2 * SIZE + 7000 + 30000 + 1764) % SIZE)];
    const [b] = steady(p + 2 * SIZE + 37000 + STEP, 4);
    out.push({name: 'jump-over-ring', program: prefix([...music, ...voices, ...a, ...jumps, ...b])});
  }
  {
    // The write cursor behind its usual lead, then far ahead: lenA != lenB, R = the smaller.
    const ops = [cb(0, 1764), cb(STEP, STEP + 100), cb(2 * STEP, 2 * STEP + 9000), cb(3 * STEP, 3 * STEP - 3000),
      cb(4 * STEP, 4 * STEP + 1764), cb(5 * STEP, 5 * STEP + 1764)];
    out.push({name: 'write-lead-varies', program: prefix([...voices, ...ops])});
  }
  {
    const [pre, p] = steady(2000, 3);
    const lost = [
      cb(p, p + 1764, {lock: [DSERR_BUFFERLOST]}),            // A lost, retried
      cb(p + STEP, p + STEP + 1764, {lock: [DS_OK, DSERR_BUFFERLOST]}),  // B lost, retried
      cb(p + 2 * STEP, p + 2 * STEP + 1764, {lock: [DSERR_BUFFERLOST, DSERR_BUFFERLOST, DSERR_BUFFERLOST, DS_OK]}), // A lost twice: skipped
      cb(p + 3 * STEP, p + 3 * STEP + 1764, {lock: [DSERR_INVALIDPARAM]}),  // another failure: no retry, no copy
      cb(p + 4 * STEP, p + 4 * STEP + 1764, {positionHr: E_FAIL}),        // GetCurrentPosition fails: nothing
      cb(p + 5 * STEP, p + 5 * STEP + 1764),
      cb(p + 6 * STEP, p + 6 * STEP + 1764, {lock: [DS_OK, DSERR_BUFFERLOST, DSERR_INVALIDPARAM]}),
    ];
    // The first callback's resync Lock lost, then its retry lost too.
    out.push({name: 'buffer-lost', program: prefix([...music, ...voices, cb(1000, 2764, {lock: [DSERR_BUFFERLOST]}), ...pre.slice(1), ...lost,
      ...steady(p + 7 * STEP, 3)[0]])});
    out.push({name: 'buffer-lost-resync', program: prefix([...voices, cb(1000, 2764, {lock: [DSERR_BUFFERLOST, DSERR_BUFFERLOST]}),
      ...steady(1000 + STEP, 4)[0]])});
  }
  {
    // MUSICORDER 2 (glxControlMusic(1, 2), 0x106071a8) with effect voices playing: ahead = 0, the next callback resyncs.
    const [a, p] = steady(3000, 30);
    const [b, q] = steady(p, 12);
    const [c] = steady(q, 3, () => STEP, () => 2000);
    out.push({name: 'musicorder-resync', program: prefix([...music, ...voices, ...a, {op: 'control', cmd: 1, arg: 2}, ...b,
      {op: 'control', cmd: 1, arg: 0}, ...c])});
  }
  {
    // An underrun: `ahead` (fabricated small) below what the cursors moved.
    const [a, p] = steady(8000, 6);
    const [b] = steady(p + 5000, 4);
    out.push({name: 'underrun-resync', program: prefix([...music, ...voices, ...a, {op: 'poke', address: 0x10697cdc, width: 4, value: 4000}, ...b])});
  }
  {
    // Coincident cursors (target == play): A == B after the seat, ahead 0, nothing rendered;
    // re-seated at the next callback. The closed output returns at once.
    const behind = p => (p - LATENCY_BYTES + SIZE) % SIZE;
    const ops = [cb(4000, behind(4000)), cb(4000 + STEP, behind(4000 + STEP)), cb(4000 + 2 * STEP, 4000 + 2 * STEP + 1764),
      cb(4000 + 3 * STEP, 4000 + 3 * STEP + 1764), {op: 'openFlag', value: 0}, cb(4000 + 4 * STEP, 4000 + 4 * STEP + 1764),
      {op: 'openFlag', value: 1}, cb(4000 + 5 * STEP, 4000 + 5 * STEP + 1764)];
    out.push({name: 'coincident-and-closed', program: prefix([...voices, ...ops])});
  }
  for (const latency of [5, 250, 495]) {
    const [ops] = steady(1234 * 4, 8, () => STEP, () => 1764);
    out.push({name: `latency-${latency}`, program: prefix([...voices, {...ops[0], latency}, ...ops.slice(1)])});
  }
  for (let p = 0; p < 4; p++) {
    const r = rng(900 + p), ops = [...(p & 1 ? music : [])];
    let play = r() % SIZE, lead = 1764;
    for (let i = 0; i < 60; i++) {
      const k = r() % 12;
      if (k < 2) ops.push({op: 'startSample', voice: 1 + r() % 8, sample: pick(r, NAMES), freq: pick(r, [22050, 11025, 44100, 30000]),
        vol: pick(r, [0x7fff, 0x4000, 0x80]), pan: pick(r, [0, 0x4000, 0x7fff, 0xc000])});
      else if (k === 2) ops.push({op: 'stopSample', slot: r() % 8});
      else if (k === 3 && p & 1 && r() % 3 === 0) ops.push({op: 'control', cmd: 1, arg: r() % 3});
      else {
        const more = {};
        if (r() % 9 === 0) more.lock = [pick(r, [DSERR_BUFFERLOST, DSERR_INVALIDPARAM, DS_OK])];
        if (r() % 25 === 0) { more.positionHr = E_FAIL; delete more.lock; }
        if (r() % 7 === 0) lead = pick(r, [0, 1764, 1765, 3000, 7056, 20000]);
        ops.push(cb(play % SIZE, (play + lead) % SIZE, more));
        play += pick(r, [STEP, STEP, STEP - 4, STEP + 8, 1, 0, 9000, r() % 40000]);
      }
    }
    out.push({name: `random-${p}`, program: prefix(ops)});
  }
  return out;
}

// ---- oracle --------------------------------------------------------------------------------

async function runOracle(list, samples) {
  await mkdir(SAMPLES, {recursive: true});
  const key = createHash('sha256');
  for (const f of ORACLE_DEPS) key.update(await readFile(f));
  for (const [name, bytes] of samples) {
    key.update(name); key.update(bytes);
    const file = path.join(SAMPLES, `${name}.wav`);
    if (!existsSync(file)) await writeFile(file, bytes);
  }
  const casesJson = JSON.stringify(list.map(({name, program}) => ({name, program})));
  key.update(casesJson);
  const digest = key.digest('hex'), keyFile = path.join(CACHE, 'key.txt');
  if (!args.includes('--refresh') && existsSync(keyFile) && (await readFile(keyFile, 'utf8')) === digest) return;
  await writeFile(path.join(CACHE, 'cases.json'), casesJson);
  console.log(`oracle: ${list.length} cases ...`);
  execFileSync(python, [ORACLE, gameDirectory(), MODULES, SAMPLES, path.join(CACHE, 'cases.json'), CACHE],
    {stdio: ['ignore', 'inherit', 'inherit']});
  await writeFile(keyFile, digest);
}

// ---- Rust kernel ------------------------------------------------------------------------------

class Groups {
  constructor(x) { this.x = x; this.cursor = 0; this.hash = createHash('sha256'); this.digests = []; this.records = []; this.keep = 256; }
  bytes(ptr, len) { return new Uint8Array(this.x.memory.buffer, ptr, len); }
  pull() {
    const x = this.x;
    if (!x.galaxy_trace_ptr()) return;
    const gn = x.galaxy_trace_groups_len();
    const ends = gn ? new Uint32Array(x.memory.buffer, x.galaxy_trace_groups_ptr(), gn).slice() : [];
    for (const e of ends) { this.feed(this.bytes(x.galaxy_trace_ptr() + this.cursor, e - this.cursor)); this.close(); this.cursor = e; }
    if (gn) { x.galaxy_trace_consume(); this.cursor -= ends[gn - 1]; }
    const len = x.galaxy_trace_len();
    this.feed(this.bytes(x.galaxy_trace_ptr() + this.cursor, len - this.cursor));
    this.cursor = len;
  }
  feed(bytes) { this.hash.update(bytes); if (this.digests.length < this.keep) this.records.push(Buffer.from(bytes)); }
  record(tag, payload) {
    const head = Buffer.alloc(5); head[0] = tag.charCodeAt(0); head.writeUInt32LE(payload.length, 1);
    this.feed(head); this.feed(payload);
  }
  close() { this.digests.push(this.hash.digest().subarray(0, 8)); this.hash = createHash('sha256'); }
}

const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };

function replay(x, c, samples, modules, mutant) {
  x.galaxy_set_mutant(mutant);
  x.galaxy_reset(16);
  x.galaxy_seq_setup(64);
  x.galaxy_output_open(40);
  x.galaxy_seq_trace(1);
  x.galaxy_output_log(1);
  const g = new Groups(x), addr = new Map(), stats = {callbacks: 0, resyncs: 0, locks: 0, lost: 0, split: 0, renders: 0, bytes: 0, peak: 0};
  const check = what => { const f = x.galaxy_fault(); if (f) throw new Error(`${c.name} ${what}: fault 0x${f.toString(16)}`); };
  const voicesRecord = result => Buffer.concat([u32(result), Buffer.from(new Uint8Array(x.memory.buffer, x.galaxy_voices_ptr(), 32 * VOICE))]);
  const ptr = slot => slot == null ? 0 : 0x1068dca0 + slot * VOICE;
  const secondaries = [];
  for (const s of c.program) {
    if (s.op === 'loadSample') {
      const bytes = samples.get(s.sample);
      const input = x.galaxy_input(bytes.length);
      new Uint8Array(x.memory.buffer, input, bytes.length).set(bytes);
      const result = x.galaxy_sample_load(bytes.length) >>> 0;
      check(`loadSample ${s.sample}`); g.pull();
      let payload = u32(result);
      if (result) {
        const record = Buffer.from(new Uint8Array(x.memory.buffer, x.galaxy_sample_record(result), 0x48));
        const n = x.galaxy_sample_data_len(result);
        payload = Buffer.concat([payload, record, u32(n), Buffer.from(new Uint8Array(x.memory.buffer, x.galaxy_sample_data(result), n))]);
        addr.set(s.sample, result);
      }
      g.record('W', payload); g.close();
    } else if (s.op === 'startSample') {
      const result = x.galaxy_sample_start(s.voice, s.sample ? (addr.get(s.sample) ?? 0) : 0, s.freq, s.vol, s.pan, s.flags ?? 0) >>> 0;
      check('startSample'); g.pull(); g.record('V', voicesRecord(result)); g.close();
    } else if (s.op === 'stopSample') {
      const result = x.galaxy_sample_stop(ptr(s.slot)) >>> 0;
      check('stopSample'); g.pull(); g.record('V', voicesRecord(result)); g.close();
    } else if (s.op === 'sampleVolume') {
      const result = x.galaxy_set_sample_volume(s.volume, s.mode) >>> 0;
      g.pull(); g.record('V', voicesRecord(result)); g.close();
    } else if (s.op === 'load') {
      const module = modules[s.module];
      const input = x.galaxy_input(module.length);
      new Uint8Array(x.memory.buffer, input, module.length).set(module);
      x.galaxy_seq_load(module.length, 127, 76); g.pull();
    } else if (s.op === 'start') { x.galaxy_seq_start(16, s.section); g.pull(); }
    else if (s.op === 'control') { x.galaxy_seq_control(s.cmd, s.arg); g.pull(); }
    else if (s.op === 'poke') { if (!x.galaxy_poke(s.address, s.value)) throw new Error(`poke ${s.address.toString(16)}`); }
    else if (s.op === 'openFlag') { if (!x.galaxy_poke(0x10698394, s.value)) throw new Error('poke 0x10698394'); }
    else if (s.op === 'dsCallback') {
      if (s.latency !== undefined && !x.galaxy_poke(0x1064a65c, s.latency)) throw new Error('poke 0x1064a65c');
      x.galaxy_output_log_clear();
      if (s.positionHr !== undefined) x.galaxy_output_position_result(s.positionHr >>> 0);
      for (const hr of s.lock ?? []) x.galaxy_output_lock_result(hr >>> 0);
      x.galaxy_output_callback(s.play >>> 0, s.write >>> 0);
      check('dsCallback');
      g.pull();
      const n = x.galaxy_output_log_len(), lp = x.galaxy_output_log_ptr(), log = n ? new Uint32Array(x.memory.buffer, lp, n).slice() : new Uint32Array(0);
      const size = x.galaxy_output_state(0);
      const sp = x.galaxy_output_secondary(), gp = x.galaxy_output_staging();
      const secondary = Buffer.from(new Uint8Array(x.memory.buffer, sp, SIZE));
      const staging = Buffer.from(new Uint8Array(x.memory.buffer, gp, size));
      const words = [n, ...log, x.galaxy_output_state(1), x.galaxy_output_state(2), x.galaxy_output_state(3), x.galaxy_output_state(4)];
      g.record('O', Buffer.concat([Buffer.concat(words.map(u32)), sha(secondary).subarray(0, 16), sha(staging).subarray(0, 16)]));
      g.close();
      if (secondaries.length < 24) secondaries.push(secondary);
      stats.callbacks++;
      for (let i = 0; i < log.length;) {
        const op = log[i];
        if (op === 2) { stats.locks++; if (log[i + 4] === DSERR_BUFFERLOST) stats.lost++; if (log[i + 3] & 2) stats.resyncs++; if (log[i + 8]) stats.split++; }
        i += {1: 4, 2: 9, 3: 5, 4: 4, 5: 1}[op];
      }
      const r = x.galaxy_output_state(4) >>> 0;
      if (r !== NULL_REGION) { stats.renders++; stats.bytes += r; }
      for (let k = 0; k < secondary.length; k += 2) stats.peak = Math.max(stats.peak, Math.abs(secondary.readInt16LE(k)));
    } else throw new Error(`op ${s.op}`);
  }
  x.galaxy_seq_end(); g.pull();
  return {digests: g.digests, records: g.records, stats, secondaries};
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (Buffer.compare(Buffer.from(a[i]), Buffer.from(b[i]))) return i;
  return a.length === b.length ? -1 : n;
}
const chunks = (buf, size) => Array.from({length: buf.length / size}, (_, i) => buf.subarray(i * size, (i + 1) * size));

function parseRecords(buf) {
  const out = [];
  for (let at = 0; at + 5 <= buf.length;) { const len = buf.readUInt32LE(at + 1); out.push({tag: String.fromCharCode(buf[at]), payload: buf.subarray(at + 5, at + 5 + len)}); at += 5 + len; }
  return out;
}

/** The first differing record, decoded for O. */
function explain(oracleFull, rustRecords, group) {
  const ours = parseRecords(Buffer.concat(rustRecords)), theirs = parseRecords(oracleFull);
  for (let i = 0; i < Math.min(ours.length, theirs.length); i++) {
    const o = ours[i], t = theirs[i];
    if (o.tag === t.tag && !Buffer.compare(o.payload, t.payload)) continue;
    if (o.tag !== t.tag) return `record ${i}: tag ${o.tag} vs ${t.tag}`;
    if (o.tag === 'O') {
      const words = p => Array.from({length: (p.length - 32) / 4}, (_, k) => p.readUInt32LE(4 * k));
      return `record ${i} (O): Rust [${words(o.payload).map(w => w.toString(16)).join(' ')}] vs original [${words(t.payload).map(w => w.toString(16)).join(' ')}]` +
        `; secondary ${o.payload.subarray(-32, -16).equals(t.payload.subarray(-32, -16)) ? 'equal' : 'differs'}, staging ${o.payload.subarray(-16).equals(t.payload.subarray(-16)) ? 'equal' : 'differs'}`;
    }
    for (let k = 0; k < Math.min(o.payload.length, t.payload.length); k++) {
      if (o.payload[k] !== t.payload[k]) return `record ${i} (${o.tag}) byte ${k}: ${o.payload[k]} vs ${t.payload[k]}`;
    }
    return `record ${i} (${o.tag}) lengths ${o.payload.length} vs ${t.payload.length}`;
  }
  return `group ${group} (records beyond the kept window)`;
}

// Unreached instruction runs of the callback (start address -> reason); any other fails.
const UNREACHED = {};
function runs(entry) {
  const covered = new Set(entry.covered), out = [];
  let run = null;
  for (const [a, text] of entry.instructions) {
    if (covered.has(a)) { run = null; continue; }
    if (!run) out.push(run = {start: a, count: 0, first: text});
    run.count++;
  }
  return out;
}

// ---- main -----------------------------------------------------------------------------------------

const samples = await waves();
const only = args.includes('--cases') ? new Set(args[args.indexOf('--cases') + 1].split(',')) : null;
const list = cases().filter(c => !only || only.has(c.name));
await mkdir(CACHE, {recursive: true});
await runOracle(list, samples);
const {instance} = await WebAssembly.instantiate(await readFile(WASM));
const x = instance.exports;
const modules = {Intro_Music: await readFile(path.join(MODULES, 'Intro_Music.it'))};
let failures = 0;
const fail = msg => { failures++; console.log(`FAIL ${msg}`); };
const total = {callbacks: 0, resyncs: 0, locks: 0, lost: 0, split: 0, renders: 0, bytes: 0, groups: 0};
for (const c of list) {
  const oracleDig = chunks(await readFile(path.join(CACHE, `${c.name}.dig`)), 8);
  const oracleSecondary = chunks(await readFile(path.join(CACHE, `${c.name}.secondary`)), SIZE);
  let rust;
  try { rust = replay(x, c, samples, modules, 0); } catch (e) { fail(`${c.name}: ${e.message}`); continue; }
  const d = firstDiff(rust.digests, oracleDig), b = firstDiff(rust.secondaries, oracleSecondary);
  const st = rust.stats;
  for (const k of Object.keys(st)) if (k in total) total[k] += st[k];
  total.groups += oracleDig.length;
  const label = `${c.name}: ${st.callbacks} callbacks (${st.resyncs} resyncs, ${st.locks} locks, ${st.split} split, ${st.lost} lost), ` +
    `${st.renders} renders of ${st.bytes} bytes, ${oracleDig.length} groups`;
  if (d >= 0 || b >= 0) {
    const why = d >= 0 ? explain(await readFile(path.join(CACHE, `${c.name}.full`)), rust.records, d) : `secondary buffer after callback ${b}`;
    fail(`${label}: trace group ${d}: ${why}`);
  } else console.log(`${label}: bit-equal, peak |sample| ${st.peak}`);
}
console.log(`${list.length} cases, ${total.callbacks} callbacks, ${total.resyncs} resyncs, ${total.locks} locks (${total.split} split, ${total.lost} lost), ` +
  `${total.renders} renders of ${total.bytes} bytes, ${total.groups} groups`);

if (existsSync(path.join(CACHE, 'coverage.json')) && !only) {
  const coverage = JSON.parse(await readFile(path.join(CACHE, 'coverage.json'), 'utf8'));
  for (const entry of coverage) {
    if (!/callback/.test(entry.function)) continue;
    const unreached = runs(entry);
    console.log(`coverage ${entry.function}: ${entry.covered.length}/${entry.instructions.length}` +
      (unreached.length ? `; unreached: ${unreached.map(r => `${r.start.toString(16)}(${r.count}) ${UNREACHED[r.start] ?? `? ${r.first}`}`).join('; ')}` : ''));
    for (const run of unreached) if (!UNREACHED[run.start]) fail(`coverage ${entry.function}: unexplained unreached run ${run.start.toString(16)} (${run.count}: ${run.first})`);
  }
}

if (!only) {
  for (const [id, label] of Object.entries(MUTANTS)) {
    const caught = [];
    for (const c of list) {
      const oracleDig = chunks(await readFile(path.join(CACHE, `${c.name}.dig`)), 8);
      try { if (firstDiff(replay(x, c, samples, modules, +id).digests, oracleDig) >= 0) caught.push(c.name); }
      catch { caught.push(`${c.name} (fault)`); }
    }
    if (!caught.length) fail(`mutant ${id} (${label}) not caught`);
    else console.log(`mutant ${id} (${label}): caught by ${caught.length} (${caught.slice(0, 5).join(', ')}${caught.length > 5 ? ', ...' : ''})`);
  }
  x.galaxy_set_mutant(0);
}
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('Galaxy output callback: all checks passed');
