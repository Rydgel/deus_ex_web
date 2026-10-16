#!/usr/bin/env node
/** Play's Galaxy output with the original's two ring heads (Stage 4 gate row
 * 4.3.7, check 4 `galaxy-output-play`, docs/audio-output-scope.md §6): the
 * AudioWorklet processor (src/viewer/galaxy-music-worklet.mjs) under Node,
 * pulled in 128-frame quanta, plays the secondary buffer of the translated
 * timer callback 0x106142a0 (native/galaxy-kernel/src/output.rs, oracle-checked
 * by validate-galaxy-output-callback.mjs) with its own consumption position as
 * the play cursor and play + lead as the write cursor, so D = 7,056 + lead.
 *
 * For each lead (the worklet's WRITE_LEAD, a labelled placeholder until the
 * poll of the running original measures it, and 1764 to show the placement
 * follows D):
 *  1. the worklet's output equals a reference loop on a second kernel
 *     instance that runs one callback every 882 frames of play cursor
 *     (3528·k, 3528·k + lead), applies the same batches after the same
 *     callbacks and reads the secondary buffer at the play position, frame
 *     for frame (the worklet's quantum splitting, cursor bookkeeping and
 *     int16 / 32768 conversion);
 *  2. in that loop, after every callback, the secondary buffer equals the
 *     staging ring over the 882 frames the cursor plays next: the output is
 *     render_ring's staging ring read at the play position;
 *  3. one batch starts an effect (a constant 16-bit sample at its own rate,
 *     so its frames do not depend on the mixer's segmenting) and the song
 *     Intro_Music: the effect sounds from absolute frame 882·(c − 1) + D/4,
 *     the song's first frame (the music-only render of the coincident-head
 *     path, galaxy_render, with the same frames mixed before it) at
 *     882·(c − 1) + 44100, c the callbacks done when the batch landed: the
 *     effect sounds size − D bytes before the song's first frame; nothing
 *     sounds between the effect's end and the song;
 *  4. the worklet counts one resync (the first callback), no fault, no
 *     underrun.
 *
 *   node scripts/validate-galaxy-output-play.mjs
 */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gameDirectory} from './game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {createMusicLibraryProxy, createSampleRegistry, driveMusicLibrary, VOICE_BASE, VOICE_SIZE} from '../src/runtime/galaxy-music-library.mjs';

globalThis.sampleRate = 44100;
globalThis.AudioWorkletProcessor = class { constructor() { const channel = new MessageChannel(); this.port = channel.port1; this.pagePort = channel.port2; } };
const worklet = await import('../src/viewer/galaxy-music-worklet.mjs');
const wasm = await readFile(new URL('../src/runtime/galaxy-kernel.wasm', import.meta.url));
const game = gameDirectory();
const assets = new AssetStore(['Music/Intro_Music.umx'].map(path => ({path, read: () => readFile(`${game}/${path}`)})));
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const SIZE = 176400, FRAMES = SIZE / 4, CB = worklet.CALLBACK_FRAMES, LATENCY_BYTES = 7056, AHEAD = 176400 - 882 * 4;
const EFFECT_FRAMES = 4410, EFFECT_VALUE = 8192;

/** A RIFF WAVE: 16-bit mono PCM at 44100 Hz, `frames` samples of `value`. */
function constantWave(frames, value) {
  const data = Buffer.alloc(2 * frames);
  for (let i = 0; i < frames; i++) data.writeInt16LE(value, 2 * i);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(44100, 4); fmt.writeUInt32LE(88200, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
  const chunk = (id, body) => { const h = Buffer.alloc(8); h.write(id, 0, 'latin1'); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body]); };
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), chunk('fmt ', fmt), chunk('data', data)]);
  const head = Buffer.alloc(8); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length, 4);
  return new Uint8Array(Buffer.concat([head, body]));
}

async function instance() { return (await WebAssembly.instantiate(wasm, {})).instance.exports; }

/** The worklet, pulled in quanta; returns its output stream (int16 stereo) and
 * each batch message with the callbacks done when it was applied. */
async function runWorklet(lead) {
  const processor = new worklet.GalaxyMusicProcessor();
  processor.page({type: 'init', wasm: wasm.slice().buffer});
  const channel = new MessageChannel(), sent = [];
  const library = createMusicLibraryProxy((message, transfer) => { sent.push(structuredClone(message)); channel.port2.postMessage(message, transfer); },
    {samples: createSampleRegistry()});
  channel.port2.onmessage = ({data}) => library.report(data);
  processor.page({type: 'connect', port: channel.port1, effectsChannels: 16, pc: 64, ahead: AHEAD, latency: 40, writeLead: lead});
  while (!processor.open) await turn();
  await library.ready?.();
  const stream = [], left = new Float32Array(128), right = new Float32Array(128), applied = [];
  const pull = quanta => {
    for (let q = 0; q < quanta; q++) {
      processor.process([], [[left, right]]);
      const out = new Int16Array(256);
      for (let i = 0; i < 128; i++) { out[2 * i] = Math.round(left[i] * 32768); out[2 * i + 1] = Math.round(right[i] * 32768); }
      stream.push(out);
    }
  };
  const settle = async count => { while (processor.stats.batches < count) await turn(); applied.push(processor.stats.callbacks); };
  // RegisterSound's batch, then 30 quanta of silence, then one Update batch:
  // the effect's start (the channel loop), then the music section's song start.
  const effect = library.registerSample('test.constant', constantWave(EFFECT_FRAMES, EFFECT_VALUE));
  assert.ok(effect.handle, 'the constant WAV loads');
  await settle(1);
  pull(30 * Math.ceil(CB / 128));
  library.lock();
  library.startSample(1, effect.handle, 44100, 0x7fff, 0x4000);
  await driveMusicLibrary(library, assets, {song: 'Intro_Music', section: 0});
  library.unlock();
  await settle(2);
  pull(Math.ceil((applied[1] * CB + 2 * FRAMES) / 128));
  const s = processor.stats;
  assert.equal(s.error, null, s.error);
  assert.equal(s.fault, 0, `worklet fault 0x${s.fault.toString(16)}`);
  assert.equal(s.underruns, 0, 'underruns');
  assert.equal(s.resyncs, 1, 'one resync, the first callback');
  const all = new Int16Array(stream.length * 256);
  stream.forEach((q, i) => all.set(q, 256 * i));
  channel.port1.close(); channel.port2.close(); processor.port.close(); processor.pagePort.close();
  return {stream: all, messages: sent, applied, callbacks: s.callbacks, slot: 0};
}

/** The reference loop: one callback per 882 frames of play cursor, the
 * batches after the same callbacks, the secondary buffer read at the cursor. */
async function referenceLoop(lead, messages, applied, frames) {
  const x = await instance(), kernel = worklet.createMusicKernel(x);
  kernel.open(16, 64, AHEAD);
  kernel.openOutput(40);
  const out = new Int16Array(2 * frames);
  let staged = 0;
  for (let k = 0, at = 0; at < frames; k++) {
    for (let b = 0; b < messages.length; b++) if (applied[b] === k) worklet.forEachMusicOp(messages[b], (code, a, bb, module, args) => kernel.apply(code, a, bb, module, args));
    const play = (4 * CB * k) % SIZE;
    assert.equal(kernel.callback(play, (play + lead) % SIZE), 0, `reference callback ${k}: fault 0x${x.galaxy_fault().toString(16)}`);
    const secondary = new Uint8Array(x.memory.buffer, x.galaxy_output_secondary(), SIZE);
    const staging = new Uint8Array(x.memory.buffer, x.galaxy_output_staging(), SIZE);
    for (let i = 0; i < 4 * CB; i++) {
      const p = (play + i) % SIZE;
      if (secondary[p] !== staging[p]) assert.fail(`callback ${k}: secondary byte ${p} ${secondary[p]} differs from the staging ring's ${staging[p]}`);
    }
    staged++;
    const view = new Int16Array(x.memory.buffer, x.galaxy_output_secondary(), SIZE / 2);
    for (let f = 0; f < CB && at < frames; f++, at++) {
      const p = ((play >> 2) + f) % FRAMES;
      out[2 * at] = view[2 * p]; out[2 * at + 1] = view[2 * p + 1];
    }
  }
  return {out, staged};
}

/** The music-only stream of the coincident-head path (galaxy_render, the
 * renderer's resync placement, checked against the original renderer by
 * validate-galaxy-effects.mjs) from the song batch on, after the same frames
 * mixed before it: the first callback's resync (size − D bytes) and then
 * 882 frames per callback. */
async function musicOnly(messages, applied, lead, frames) {
  const x = await instance(), kernel = worklet.createMusicKernel(x);
  kernel.open(16, 64, AHEAD);
  const before = (SIZE - (LATENCY_BYTES + lead)) / 4 + (applied[1] - 1) * CB;
  for (let done = 0; done < before;) {
    const n = Math.min(done === 0 ? (SIZE - (LATENCY_BYTES + lead)) / 4 : CB, before - done);
    assert.notEqual(x.galaxy_render(n), 0); done += n;
  }
  worklet.forEachMusicOp(messages[1], (code, a, b, module, args) => { if (code !== worklet.OPS.startSample) kernel.apply(code, a, b, module, args); });
  const out = new Int16Array(2 * frames);
  for (let at = 0; at < frames; at += CB) {
    const ptr = x.galaxy_render(CB);
    assert.notEqual(ptr, 0, `music-only render: fault 0x${x.galaxy_fault().toString(16)}`);
    out.set(new Int16Array(x.memory.buffer, ptr, 2 * CB).subarray(0, 2 * Math.min(CB, frames - at)), 2 * at);
  }
  return out;
}

const firstNonzero = (s, from = 0) => { for (let f = from; 2 * f < s.length; f++) if (s[2 * f] || s[2 * f + 1]) return f; return -1; };

for (const lead of [worklet.WRITE_LEAD, 1764]) {
  const D = LATENCY_BYTES + lead;
  const w = await runWorklet(lead);
  const frames = w.stream.length / 2;
  // 1, 2: the worklet against the reference loop.
  const ref = await referenceLoop(lead, w.messages, w.applied, frames);
  for (let i = 0; i < w.stream.length; i++) if (w.stream[i] !== ref.out[i]) assert.fail(`lead ${lead}: frame ${i >> 1} lane ${i & 1}: worklet ${w.stream[i]}, reference ${ref.out[i]}`);
  // 3: the placement of the effect and the song.
  const c = w.applied[1], effectAt = CB * (c - 1) + D / 4, songAt = CB * (c - 1) + FRAMES;
  assert.equal(firstNonzero(w.stream), effectAt, `lead ${lead}: the effect's first frame`);
  const effectEnd = (() => { let f = effectAt; while (f < frames && (w.stream[2 * f] || w.stream[2 * f + 1])) f++; return f; })();
  assert.ok(Math.abs(effectEnd - effectAt - EFFECT_FRAMES) <= 1, `lead ${lead}: the effect lasts its ${EFFECT_FRAMES} frames (${effectEnd - effectAt})`);
  const music = await musicOnly(w.messages, w.applied, lead, FRAMES);
  const musicFirst = firstNonzero(music);
  assert.ok(musicFirst >= 0 && musicFirst < FRAMES / 2, 'the song sounds within its first half second');
  assert.equal(firstNonzero(w.stream, effectEnd), songAt + musicFirst, `lead ${lead}: nothing between the effect and the song`);
  for (let t = 0; t < FRAMES && songAt + t < frames; t++) {
    if (w.stream[2 * (songAt + t)] !== music[2 * t] || w.stream[2 * (songAt + t) + 1] !== music[2 * t + 1])
      assert.fail(`lead ${lead}: song frame ${t} at absolute frame ${songAt + t}: worklet ${w.stream[2 * (songAt + t)]}/${w.stream[2 * (songAt + t) + 1]}, music-only ${music[2 * t]}/${music[2 * t + 1]}`);
  }
  console.log(`PASS lead ${lead} (D = ${D} bytes${lead === worklet.WRITE_LEAD ? ', the PLACEHOLDER lead' : ''}): ${frames} frames, ${w.callbacks} callbacks, ` +
    `equal to the reference loop; the staging ring at the cursor after ${ref.staged} callbacks; batch after callback ${c}: effect at frame ${effectAt}, ` +
    `song frame 0 at ${songAt} (first sound ${songAt + musicFirst}), ${songAt - effectAt} frames = size − D apart`);
}
console.log('validate-galaxy-output-play: PASS');
