#!/usr/bin/env node
/** Galaxy's output buffer replayed from a capture of the running original
 * (Stage 4 gate row 4.3.7, check 3 `galaxy-output-replay`,
 * docs/audio-output-scope.md §5.2, §6). The capture
 * (scripts/galaxy-output-capture.sh replay: `dx-live-win.exe galaxy capture`,
 * DeusEx.exe started under the debugger, so the record begins before
 * glxInit) holds, in event order, every library call the subsystem made,
 * every timer callback's cursor pair, Lock results, R, heads, `ahead` and
 * an FNV-1a of each copied staging segment, and the stream decoder thread's
 * messages with each MPEG decoder call's arguments, answer and output bytes.
 *
 * The replay drives the translated library (native/galaxy-kernel) from
 * `Library::new` with the same calls in the same order: glxInit's
 * EffectsChannels, the output open (PC 53, the measured pan table), the
 * setters, glxLoadMusic and glxLoadSample on the captured bytes (an MPEG
 * load becomes the stand-in record, fed by the capture's decoder answers),
 * the music and sample calls, Update's inline stores, the reverb blocks; each
 * timer callback with the captured cursors and Lock results; each decoder
 * message where the original handled it (after the callback it fell inside),
 * with the original decoder's output. It fails at the first difference:
 *  - each callback's R, heads before and after, `ahead`, the FNV-1a of the
 *    two copied segments (every byte the callback copies into the
 *    DirectSound buffer, at its ring position) and, at a resync, of the whole
 *    staging ring it copies; the first 24 callbacks' segments byte for byte;
 *  - glxLoadMusic's status, each WAV load's record, glxStartSample's and
 *    glxControlVoice's results;
 *  - each decoder message against the replay's own refill posts, and each
 *    decoder call's arguments (source offset, Remaining, Chunk).
 *
 *   node scripts/validate-galaxy-output-replay.mjs [--capture .work/audio-output/replay-training.bin]
 */
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';

const argv = process.argv.slice(2);
const capture = argv.includes('--capture') ? argv[argv.indexOf('--capture') + 1] : '.work/audio-output/replay-training.bin';
if (!existsSync(capture)) {
  console.log(`SKIP validate-galaxy-output-replay: no capture at ${capture} (scripts/galaxy-output-capture.sh replay, with the CrossOver bottle free)`);
  process.exit(0);
}
const {MUSIC_PAN_PC} = await import('../src/viewer/galaxy-music-output.mjs');
const GX = {INIT: 1, CHANNELS: 2, OPEN: 3, SAMPLE_VOLUME: 4, MUSIC_VOLUME: 5, LOAD_MUSIC: 6, LOAD_MUSIC_RESULT: 7, UNLOAD_MUSIC: 8,
  START_MUSIC: 9, STOP_MUSIC: 10, CONTROL_MUSIC: 11, CLEAR_ACTIVE: 12, BREAK: 13, LOAD_SAMPLE: 14, LOAD_SAMPLE_RESULT: 15,
  START_SAMPLE: 16, START_SAMPLE_RESULT: 17, CONTROL_SAMPLE: 18, CONTROL_VOICE: 19, CONTROL_VOICE_RESULT: 20, STOP_SAMPLE: 21,
  SAMPLE_REVERB: 22, UNLOAD_SAMPLE: 23, UPDATE_LOCK: 24, UPDATE_UNLOCK: 25,
  CB_POSITION: 30, CB_LOCK: 31, CB_LOST: 32, CB_COPIED: 33, CB_RESYNC: 34, CB_END: 35,
  DEC_MESSAGE: 40, DEC_CALL: 41, DEC_END: 42, END: 99};
const NAMES = Object.fromEntries(Object.entries(GX).map(([k, v]) => [v, k]));
const DSERR_BUFFERLOST = 0x88780096, SLACK = 1024, FULL_SEGMENTS = 24;
const fnv = (bytes, h = 0x811c9dc5) => { for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0; return h >>> 0; };

// ---- the capture ----------------------------------------------------------------------------
const raw = await readFile(capture);
const records = [];
for (let at = 0; at + 12 <= raw.length;) {
  const type = raw.readUInt32LE(at), len = raw.readUInt32LE(at + 4), tid = raw.readUInt32LE(at + 8);
  records.push({type, tid, payload: raw.subarray(at + 12, at + 12 + len)});
  at += 12 + len;
}
const words = (p, n = p.length >> 2) => Array.from({length: n}, (_, i) => p.readUInt32LE(4 * i));

// ---- the replay -------------------------------------------------------------------------------
const {instance} = await WebAssembly.instantiate(await readFile('src/runtime/galaxy-kernel.wasm'));
const x = instance.exports;
const input = bytes => { const at = x.galaxy_input(bytes.length); new Uint8Array(x.memory.buffer, at, bytes.length).set(bytes); };
const handles = new Map();  // original glxSample address -> the model's
const stats = {callbacks: 0, resyncs: 0, bytes: 0, full: 0, wavLoads: 0, mpegLoads: 0, music: 0, starts: 0, controls: 0, polls: 0,
  stops: 0, reverbs: 0, messages: 0, decoderCalls: 0, mismatches: 0};
const fail = (i, what) => {
  const r = records[i];
  console.log(`FAIL record ${i} (${NAMES[r?.type] ?? r?.type}, thread ${r?.tid}): ${what}`);
  process.exit(1);
};
const fault = (i, what) => { const f = x.galaxy_fault(); if (f) fail(i, `${what}: kernel fault 0x${f.toString(16)}` +
  (f === 0x154 ? ` (decoder call: replay ${[0, 1, 2].map(k => x.galaxy_ring_mismatch(k) | 0)}, capture ${[3, 4, 5].map(k => x.galaxy_ring_mismatch(k) | 0)})` : '')); };
let started = false, timer = null, decoder = null, callback = null, lastSampleInput = null;
const deferred = [];  // decoder messages handled while a callback was open: delivered after it
let fullLeft = FULL_SEGMENTS;

function deliver(message, i) {
  const [msg, w, l] = message.words;
  if (msg !== 0x400) return;
  const pw = x.galaxy_ring_next(0) >>> 0, pl = x.galaxy_ring_next(1) >>> 0;
  if (pw !== w || pl !== l) fail(i, `decoder message (${w}, ${l}) but the replay's next post is (${pw === 0xffffffff ? 'none' : `${pw}, ${pl}`})`);
  for (const call of message.calls) {
    const [, src, remaining, , dst2, chunk, consumed, produced, n1, n2] = call.words;
    const base = message.sourceOf?.(call.words[0]) ?? 0;
    input(call.bytes);
    x.galaxy_ring_record_push((src - base) >>> 0, remaining | 0, chunk | 0, consumed | 0, produced | 0, n1, n1 + n2);
    stats.decoderCalls++;
  }
  if (!x.galaxy_ring_deliver_one()) fault(i, 'decoder message');
  const left = x.galaxy_ring_record_left();
  if (left) fail(i, `${left} captured decoder calls of this message not taken by the replay`);
  stats.messages++;
}
const sources = new Map();  // original record address -> its +0x44 (the decoder's source base)

function runCallback(cb, i) {
  // The captured Lock results: BUFFERLOST then the retry's, or the final one.
  const script = [];
  for (const site of [0, 1, 2]) {
    const lock = cb.locks.find(l => l.site === site);
    if (!lock) continue;
    if (cb.lost.includes(site)) script.push(DSERR_BUFFERLOST);
    script.push(lock.hr);
  }
  if (cb.hr) x.galaxy_output_position_result(cb.hr);
  for (const hr of script) x.galaxy_output_lock_result(hr >>> 0);
  x.galaxy_output_callback(cb.play, cb.write);
  fault(i, 'timer callback');
  stats.callbacks++;
  const size = x.galaxy_output_state(0), a = x.galaxy_output_state(1), b = x.galaxy_output_state(2), ahead = x.galaxy_output_state(3) >>> 0;
  const R = x.galaxy_output_state(4) >>> 0;
  if (cb.resync) {
    stats.resyncs++;
    const hash = x.galaxy_output_state(15) >>> 0;
    if (hash !== cb.resync.hash) fail(i, `the resync's staging ring: FNV-1a ${hash.toString(16)}, captured ${cb.resync.hash.toString(16)}`);
  }
  if (cb.copied) {
    const c = cb.copied;
    const preA = (a - R + size) % size, preB = (b - R + size) % size;
    if (R !== c.r || preA !== c.a || preB !== c.b || ahead !== c.ahead)
      fail(i, `callback ${stats.callbacks}: R ${R}, heads ${preA}/${preB}, ahead ${ahead}; captured R ${c.r}, heads ${c.a}/${c.b}, ahead ${c.ahead}`);
    const ring = new Uint8Array(x.memory.buffer, x.galaxy_output_staging(), size);
    const seg = pos => { const out = new Uint8Array(R); for (let k = 0; k < R; k++) out[k] = ring[(pos + k) % size]; return out; };
    const sa = seg(preA), sb = seg(preB);
    if (c.full) {
      for (const [mine, theirs, which] of [[sa, c.full.subarray(0, R), 'A'], [sb, c.full.subarray(R), 'B']])
        for (let k = 0; k < R; k++) if (mine[k] !== theirs[k]) fail(i, `callback ${stats.callbacks}: bus ${which} segment byte ${k} (ring ${(which === 'A' ? preA : preB) + k}): ${mine[k]}, captured ${theirs[k]}`);
      stats.full++;
    }
    if (fnv(sa) !== c.hashA || fnv(sb) !== c.hashB)
      fail(i, `callback ${stats.callbacks}: the copied segments' FNV-1a ${fnv(sa).toString(16)}/${fnv(sb).toString(16)}, captured ${c.hashA.toString(16)}/${c.hashB.toString(16)}`);
    stats.bytes += 2 * R;
  }
  if (cb.end && (cb.end[0] !== a || cb.end[1] !== b || cb.end[2] !== ahead))
    fail(i, `callback ${stats.callbacks}: heads after ${a}/${b}, ahead ${ahead}; captured ${cb.end.join('/')}`);
}

for (let i = 0; i < records.length; i++) {
  const {type, tid, payload} = records[i], w = words(payload);
  switch (type) {
    case GX.INIT: break;
    case GX.CHANNELS:
      x.galaxy_reset(w[0]); x.galaxy_ring_record_mode(1); started = true; break;
    case GX.OPEN: {
      const [, rate, flags, latency] = w;
      if (rate !== 44100 || flags !== 7) fail(i, `an output open of rate ${rate} flags ${flags} (the translation opens 44100 Hz, flags 7)`);
      if (x.galaxy_seq_setup(MUSIC_PAN_PC) !== 0) fail(i, 'the output open');
      x.galaxy_output_open(latency);
      break;
    }
    case GX.SAMPLE_VOLUME: x.galaxy_set_sample_volume(w[0] | 0, w[1] | 0); break;
    case GX.MUSIC_VOLUME: x.galaxy_set_music_volume(w[0] | 0, w[1] | 0); break;
    case GX.LOAD_MUSIC: {
      const len = w[2], bytes = payload.subarray(12, 12 + len);
      if (len < SLACK) fail(i, `a glxLoadMusic of ${len} bytes (no slack)`);
      const at = x.galaxy_input(len - SLACK); new Uint8Array(x.memory.buffer, at, len).set(bytes);
      records[i].status = x.galaxy_music_load(len - SLACK) >>> 0;
      fault(i, 'glxLoadMusic');
      stats.music++;
      break;
    }
    case GX.LOAD_MUSIC_RESULT: {
      const load = records.slice(0, i).reverse().find(r => r.type === GX.LOAD_MUSIC);
      if (load.status !== w[0]) fail(i, `glxLoadMusic returned ${load.status}, the original ${w[0]}`);
      break;
    }
    case GX.UNLOAD_MUSIC: x.galaxy_music_unload(); break;
    case GX.START_MUSIC: x.galaxy_music_start(); break;
    case GX.STOP_MUSIC: x.galaxy_music_stop(); break;
    case GX.CONTROL_MUSIC: x.galaxy_music_control(w[0] | 0, w[1] | 0); break;
    case GX.CLEAR_ACTIVE: x.galaxy_music_clear_active(w[0], 32); break;
    case GX.BREAK: x.galaxy_music_break(); break;
    case GX.LOAD_SAMPLE: {
      const len = w[2]; lastSampleInput = payload.subarray(12, 12 + len);
      input(lastSampleInput);
      const handle = x.galaxy_sample_load(len) >>> 0, f = x.galaxy_fault();
      records[i].model = f === 0x130 ? 'mpeg' : handle;
      if (f === 0x130) x.galaxy_clear_fault();
      else fault(i, 'glxLoadSample');
      break;
    }
    case GX.LOAD_SAMPLE_RESULT: {
      const original = w[0], record = payload.subarray(4, 4 + 0x48), load = records.slice(0, i).reverse().find(r => r.type === GX.LOAD_SAMPLE);
      if (!original) { if (load.model && load.model !== 'mpeg') fail(i, 'the original loaded no sample, the translation did'); break; }
      const kind = record.readUInt16LE(0x2c);
      if (load.model === 'mpeg') {
        if (!(kind & 0x4000)) fail(i, `an MPEG input typed 0x${kind.toString(16)}`);
        const h = x.galaxy_sample_host(record.readUInt32LE(0x3c), 0, kind & 0x40 ? 2 : 1) >>> 0;
        input(lastSampleInput);
        x.galaxy_sample_attach(h, lastSampleInput.length);
        fault(i, 'the MPEG stand-in record');
        const mine = Buffer.from(new Uint8Array(x.memory.buffer, x.galaxy_sample_record(h), 0x48));
        for (const [o, n] of [[0, 4], [0x28, 2], [0x2a, 2], [0x2c, 2], [0x30, 4], [0x34, 4], [0x38, 4], [0x3c, 4]])
          if (mine.readUIntLE(o, n) !== record.readUIntLE(o, n)) fail(i, `the MPEG record's +0x${o.toString(16)}: ${mine.readUIntLE(o, n)}, the original's ${record.readUIntLE(o, n)}`);
        handles.set(original, h); sources.set(original, record.readUInt32LE(0x44));
        stats.mpegLoads++;
      } else {
        if (!load.model) fail(i, 'the translation loaded no sample');
        const mine = Buffer.from(new Uint8Array(x.memory.buffer, x.galaxy_sample_record(load.model), 0x48));
        for (let o = 0; o < 0x48; o += 4) if (o !== 0x44 && o !== 0x40 && mine.readUInt32LE(o) !== record.readUInt32LE(o))
          fail(i, `the WAV record's +0x${o.toString(16)}: ${mine.readUInt32LE(o).toString(16)}, the original's ${record.readUInt32LE(o).toString(16)}`);
        handles.set(original, load.model); sources.set(original, record.readUInt32LE(0x44));
        stats.wavLoads++;
      }
      break;
    }
    case GX.START_SAMPLE: {
      const [voice, sample, freq, vol, pan, flags] = w;
      if (sample && !handles.has(sample)) fail(i, `glxStartSample of an unknown sample 0x${sample.toString(16)}`);
      records[i].result = x.galaxy_sample_start(voice | 0, sample ? handles.get(sample) : 0, freq | 0, vol | 0, pan | 0, flags) >>> 0;
      fault(i, 'glxStartSample'); stats.starts++;
      break;
    }
    case GX.START_SAMPLE_RESULT: {
      const start = records.slice(0, i).reverse().find(r => r.type === GX.START_SAMPLE);
      if (start.result !== w[0]) fail(i, `glxStartSample returned 0x${start.result.toString(16)}, the original 0x${w[0].toString(16)}`);
      break;
    }
    case GX.CONTROL_SAMPLE: x.galaxy_sample_control(w[0], w[1] | 0, w[2] | 0, w[3] | 0); fault(i, 'glxControlSample'); stats.controls++; break;
    case GX.CONTROL_VOICE: records[i].result = x.galaxy_voice_control(w[0], w[1] | 0, w[2] | 0, w[3] | 0) >>> 0; fault(i, 'glxControlVoice'); stats.polls++; break;
    case GX.CONTROL_VOICE_RESULT: {
      const poll = records.slice(0, i).reverse().find(r => r.type === GX.CONTROL_VOICE);
      if (poll.result !== w[0]) fail(i, `glxControlVoice(0x${words(poll.payload)[0].toString(16)}, ${words(poll.payload)[1]}) returned ${poll.result}, the original ${w[0]}`);
      break;
    }
    case GX.STOP_SAMPLE: x.galaxy_sample_stop(w[0]); fault(i, 'glxStopSample'); stats.stops++; break;
    case GX.SAMPLE_REVERB: {
      if (!w[0]) fail(i, 'glxSetSampleReverb(NULL)');
      new Uint8Array(x.memory.buffer, x.galaxy_reverb_block(), 0x6c).set(payload.subarray(4, 4 + 0x6c));
      x.galaxy_set_sample_reverb(); fault(i, 'glxSetSampleReverb'); stats.reverbs++;
      break;
    }
    case GX.UNLOAD_SAMPLE: fail(i, 'glxUnloadSample (UnregisterSound) is not translated');
    case GX.UPDATE_LOCK: case GX.UPDATE_UNLOCK: break;
    case GX.CB_POSITION:
      if (!started) fail(i, 'a timer callback before glxInit');
      timer = tid; callback = {hr: w[0], play: w[1], write: w[2], locks: [], lost: [], copied: null, resync: null, end: null}; break;
    case GX.CB_LOCK: callback.locks.push({site: w[0], hr: w[1]}); break;
    case GX.CB_LOST: callback.lost.push({0x106143e1: 0, 0x106144d7: 1, 0x106145af: 2}[w[0]]); break;
    case GX.CB_RESYNC: callback.resync = {hash: w[4]}; break;
    case GX.CB_COPIED: callback.copied = {r: w[0], a: w[1], b: w[2], ahead: w[3], hashA: w[4], hashB: w[5],
      full: payload.length > 24 ? payload.subarray(24) : null}; break;
    case GX.CB_END:
      if (!callback) break;  // the open flag or GetCurrentPosition's early exit without a position record
      callback.end = w.slice(0, 3);
      runCallback(callback, i);
      callback = null;
      for (const message of deferred.splice(0)) deliver(message, i);
      break;
    case GX.DEC_MESSAGE: decoder = {words: w, calls: [], sourceOf: original => sources.get(original) ?? 0}; break;
    case GX.DEC_CALL: decoder?.calls.push({words: w, bytes: payload.subarray(40)}); break;
    case GX.DEC_END:
      if (!decoder) break;
      if (callback && tid !== timer) deferred.push(decoder); else deliver(decoder, i);
      decoder = null;
      break;
    case GX.END: break;
    default: fail(i, `unknown record type ${type}`);
  }
}
if (!stats.callbacks) fail(records.length - 1, 'no timer callback in the capture');
console.log(`PASS validate-galaxy-output-replay: ${records.length} records; ${stats.callbacks} timer callbacks (${stats.resyncs} resyncs), ` +
  `${stats.bytes} copied bytes equal (FNV-1a per segment, ${stats.full} callbacks byte for byte); ${stats.wavLoads} WAV and ${stats.mpegLoads} MPEG loads, ` +
  `${stats.music} music loads, ${stats.starts} starts, ${stats.controls} controls, ${stats.polls} status polls, ${stats.stops} stops, ` +
  `${stats.reverbs} reverb blocks; ${stats.messages} decoder messages, ${stats.decoderCalls} decoder calls`);
