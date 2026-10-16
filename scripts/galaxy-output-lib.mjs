/** Shared parts of the Galaxy output validators (validate-galaxy-output-callback.mjs,
 * validate-galaxy-ring-voice.mjs): the shipped WAVs they load, the oracle run
 * with its cache key, and the Rust replay of an oracle program through the
 * kernel's exports with the same digest groups as the Python oracles
 * (native-galaxy-output-oracle.py, native-galaxy-ring-oracle.py). */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeSoundResource} from '../src/runtime/script-sound-resource.mjs';
import {gameDirectory} from './game-directory.mjs';

export const SIZE = 176400, STEP = 3528, LATENCY_BYTES = 7056, VOICE = 0xa0, NULL_REGION = 0xffffffff;
export const DS_OK = 0, DSERR_BUFFERLOST = 0x88780096, DSERR_INVALIDPARAM = 0x80070057, E_FAIL = 0x80004005;
export const RING_POOL = 0x68000000, RING_STRIDE = 0x10020, RING_ALLOC = 0x1001f;
export const sha = bytes => createHash('sha256').update(bytes).digest();
export const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };

/** The WAV payloads of `names` (Package.Group.Name, case-insensitive). */
export async function waves(names) {
  const root = gameDirectory(), want = new Map(names.map(n => [n.toLowerCase(), n])), out = new Map();
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
  for (const n of names) if (!out.has(n)) throw new Error(`no shipped sound ${n}`);
  return out;
}

export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
}
export const pick = (r, list) => list[r() % list.length];

/** Runs `oracle` on `list` unless `cache` holds outputs for the same oracle
 * scripts, samples and cases. */
export async function runOracle({oracle, deps, cache, list, samples, refresh = false, modules = '.cache/galaxy-music/modules'}) {
  const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
  const samplesDir = path.join(cache, 'samples');
  await mkdir(samplesDir, {recursive: true});
  const key = createHash('sha256');
  for (const f of [oracle, ...deps]) key.update(await readFile(f));
  for (const [name, bytes] of samples) {
    key.update(name); key.update(bytes);
    const file = path.join(samplesDir, `${name}.wav`);
    if (!existsSync(file)) await writeFile(file, bytes);
  }
  const casesJson = JSON.stringify(list.map(({name, program}) => ({name, program})));
  key.update(casesJson);
  const digest = key.digest('hex'), keyFile = path.join(cache, 'key.txt');
  if (!refresh && existsSync(keyFile) && (await readFile(keyFile, 'utf8')) === digest) return;
  await writeFile(path.join(cache, 'cases.json'), casesJson);
  console.log(`oracle: ${list.length} cases ...`);
  execFileSync(python, [oracle, gameDirectory(), modules, samplesDir, path.join(cache, 'cases.json'), cache],
    {stdio: ['ignore', 'inherit', 'inherit']});
  await writeFile(keyFile, digest);
}

/** The kernel's trace in digest groups, as the oracles close them. */
export class Groups {
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

/** The program of case `c` through the kernel `x`: the oracles' ops and records. */
export function replay(x, c, samples, modules, mutant, {keep = 256} = {}) {
  x.galaxy_set_mutant(mutant);
  x.galaxy_reset(16);
  x.galaxy_seq_setup(64);
  x.galaxy_output_open(40);
  x.galaxy_seq_trace(1);
  x.galaxy_output_log(1);
  const g = new Groups(x), addr = new Map(), secondaries = [];
  g.keep = keep;
  const stats = {callbacks: 0, resyncs: 0, locks: 0, lost: 0, split: 0, renders: 0, bytes: 0, peak: 0, messages: 0, hazards: 0,
    ring: new Map()};
  // Per voice slot of a ring voice: the read head of its first refill post,
  // the first fill's write position, each message's fill, the end, and the
  // callback after which Active was clear.
  const field = (slot, o, w = 4) => { const v = new DataView(x.memory.buffer, x.galaxy_voices_ptr() + slot * VOICE, VOICE); return w === 4 ? v.getUint32(o, true) : w === 2 ? v.getUint16(o, true) : v.getUint8(o); };
  const check = what => { const f = x.galaxy_fault(); if (f) throw new Error(`${c.name} ${what}: fault 0x${f.toString(16)}`); };
  const table = () => Buffer.from(new Uint8Array(x.memory.buffer, x.galaxy_voices_ptr(), 32 * VOICE));
  const voicesRecord = result => Buffer.concat([u32(result), table()]);
  const ptr = slot => slot == null ? 0 : 0x1068dca0 + slot * VOICE;
  const input = bytes => { const at = x.galaxy_input(bytes.length); new Uint8Array(x.memory.buffer, at, bytes.length).set(bytes); };
  const deliver = () => {
    while (x.galaxy_ring_posts()) {
      const w = x.galaxy_ring_next(0) >>> 0, p = x.galaxy_ring_next(1) >>> 0;
      const before = w < 32 ? field(w, 0x88) : 0;
      x.galaxy_ring_deliver_one();
      check(`decoder message (${w}, ${p})`);
      if (w < 32) {
        const m = stats.ring.get(w) ?? {starts: 0, posts: 0, firstRead: null, firstWrite: null, filled: 0, fills: [], end: null, silentAfter: null};
        const after = field(w, 0x88), type = field(w, 0x4c, 2);
        m.posts++;
        if (before === 0x10000) { m.firstRead = p; m.firstWrite = after; m.starts++; }
        const fill = before === 0x10000 ? null : (after - before + 0x10000) % 0x10000;
        if (fill !== null) { m.filled += fill; if (m.fills.length < 6) m.fills.push(fill); }
        if (m.end === null && !(type & 0x88)) m.end = {read: p, write: after, sample: (field(w, 0x5a) - field(w, 0x52)) >>> 0};
        stats.ring.set(w, m);
      }
      const parts = [u32(w), u32(p), table()];
      for (let slot = 0; slot < 256; slot++) {
        const r = x.galaxy_ring_bytes(slot);
        if (r) parts.push(u32(slot), sha(new Uint8Array(x.memory.buffer, r, RING_ALLOC)).subarray(0, 16));
      }
      g.pull(); g.record('D', Buffer.concat(parts)); g.close();
      stats.messages++;
    }
  };
  for (const s of c.program) {
    if (s.op === 'loadSample') {
      const bytes = samples.get(s.sample);
      input(bytes);
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
    } else if (s.op === 'hostRingSample') {
      const pcm = Buffer.from(s.pcm, 'hex'), frames = pcm.length / 2 / s.channels;
      const handle = x.galaxy_sample_host(s.rate, frames, s.channels) >>> 0;
      input(pcm);
      if (x.galaxy_sample_attach(handle, pcm.length) >>> 0 !== handle) check('attach');
      check('hostRingSample');
      addr.set(s.name, handle);
      g.pull(); g.record('H', Buffer.concat([u32(handle), Buffer.from(new Uint8Array(x.memory.buffer, x.galaxy_sample_record(handle), 0x48))])); g.close();
    } else if (s.op === 'startSample') {
      const result = x.galaxy_sample_start(s.voice, s.sample ? (addr.get(s.sample) ?? 0) : 0, s.freq, s.vol, s.pan, s.flags ?? 0) >>> 0;
      check('startSample'); g.pull(); g.record('V', voicesRecord(result)); g.close();
    } else if (s.op === 'controlSample') {
      const result = x.galaxy_sample_control(ptr(s.slot), s.freq, s.vol, s.pan) >>> 0;
      check('controlSample'); g.pull(); g.record('V', voicesRecord(result)); g.close();
    } else if (s.op === 'stopSample') {
      const result = x.galaxy_sample_stop(ptr(s.slot)) >>> 0;
      check('stopSample'); g.pull(); g.record('V', voicesRecord(result)); g.close();
    } else if (s.op === 'controlVoice') {
      const result = x.galaxy_voice_control(ptr(s.slot), s.cmd, s.p1 ?? 0, s.p2 ?? 0) >>> 0;
      check('controlVoice'); g.pull(); g.record('V', voicesRecord(result)); g.close();
    } else if (s.op === 'sampleVolume') {
      const result = x.galaxy_set_sample_volume(s.volume, s.mode) >>> 0;
      g.pull(); g.record('V', voicesRecord(result)); g.close();
    } else if (s.op === 'load') {
      const module = modules[s.module];
      input(module);
      x.galaxy_seq_load(module.length, 127, 76); g.pull();
    } else if (s.op === 'start') { x.galaxy_seq_start(16, s.section); g.pull(); }
    else if (s.op === 'control') { x.galaxy_seq_control(s.cmd, s.arg); g.pull(); }
    else if (s.op === 'poke') { if (!x.galaxy_poke(s.address, s.value)) throw new Error(`poke ${s.address.toString(16)}`); }
    else if (s.op === 'openFlag') { if (!x.galaxy_poke(0x10698394, s.value)) throw new Error('poke 0x10698394'); }
    else if (s.op === 'deliver') deliver();
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
      for (const [slot, m] of stats.ring) if (m.end && m.silentAfter === null && !field(slot, 0x0f, 1)) m.silentAfter = stats.callbacks;
      deliver();
    } else throw new Error(`op ${s.op}`);
  }
  stats.hazards = x.galaxy_mixer_hazards();
  x.galaxy_seq_end(); g.pull();
  return {digests: g.digests, records: g.records, stats, secondaries};
}

export function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (Buffer.compare(Buffer.from(a[i]), Buffer.from(b[i]))) return i;
  return a.length === b.length ? -1 : n;
}
export const chunks = (buf, size) => Array.from({length: buf.length / size}, (_, i) => buf.subarray(i * size, (i + 1) * size));

export function parseRecords(buf) {
  const out = [];
  for (let at = 0; at + 5 <= buf.length;) { const len = buf.readUInt32LE(at + 1); out.push({tag: String.fromCharCode(buf[at]), payload: buf.subarray(at + 5, at + 5 + len)}); at += 5 + len; }
  return out;
}

/** The first differing record, decoded for O, D and V. */
export function explain(oracleFull, rustRecords, group) {
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
      if (o.payload[k] === t.payload[k]) continue;
      let where = `byte ${k}`;
      if (o.tag === 'V' && k >= 4) where = `voice ${Math.floor((k - 4) / VOICE)} +0x${((k - 4) % VOICE).toString(16)}`;
      if (o.tag === 'D') where = k < 8 ? 'message' : k < 8 + 32 * VOICE ? `voice ${Math.floor((k - 8) / VOICE)} +0x${((k - 8) % VOICE).toString(16)}` : `ring list byte ${k - 8 - 32 * VOICE}`;
      if (o.tag === 'D' && k >= 8 && k < 8 + 32 * VOICE) {
        const at = k - ((k - 8) % VOICE) + ((k - 8) % VOICE & ~3);
        where += ` (dword ${o.payload.readUInt32LE(at).toString(16)} vs ${t.payload.readUInt32LE(at).toString(16)})`;
      }
      return `record ${i} (${o.tag}) ${where}: ${o.payload[k]} vs ${t.payload[k]} (lengths ${o.payload.length}/${t.payload.length})`;
    }
    return `record ${i} (${o.tag}) lengths ${o.payload.length} vs ${t.payload.length}`;
  }
  return `group ${group} (records beyond the kept window)`;
}

/** Runs of unreached instructions of a coverage entry. */
export function runs(entry) {
  const covered = new Set(entry.covered), out = [];
  let run = null;
  for (const [a, text] of entry.instructions) {
    if (covered.has(a)) { run = null; continue; }
    if (!run) out.push(run = {start: a, count: 0, first: text});
    run.count++;
  }
  return out;
}
