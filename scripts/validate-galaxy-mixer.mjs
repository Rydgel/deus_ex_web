#!/usr/bin/env node
/** Galaxy's software mixer (phase 3, docs/galaxy-music/mixer.md) in the Rust
 * kernel (native/galaxy-kernel/src/mixer.rs) against the original SSE kernel,
 * conversion and renderer running under Unicorn
 * (scripts/native-galaxy-music-sequencer-oracle.py --real-kernel), bit for bit:
 *
 * - songs: the renderer's int16 output of both buses on a 1-second ring, per
 *   20 ms callback, plus the six float32 buses after each mixer call of the
 *   first callbacks, plus the sequencer trace (which must also equal the stub
 *   mode's); then the browser path galaxy_render against the same bus-A PCM;
 * - fabricated programs: direct kernel calls (8/16-bit, steps 0x10000, 0x8000,
 *   odd low bits, negative, counts 0..9 and 511..513 at aligned and odd bus
 *   offsets, gain words, surround, prefilled buses with denormals), direct
 *   conversions (rounding ties, saturation, NaN/inf/out-of-range, denormals,
 *   store and saturating add), and renderer runs with synthetic voices (loops,
 *   ping-pong, one-shot ends, key-off release, pans, ramps, sends, v = 0 skips,
 *   saturation on both buses, request sizes, count-0 runs at odd offsets,
 *   48 voices);
 * - the same kernel and conversion programs on the host CPU (the original
 *   templates in a 32-bit process, scripts/native-galaxy-mixer-hw.c), when
 *   `gcc -m32` works, to show Unicorn executes them exactly;
 * - instruction coverage of the templates and the renderer, unreached runs
 *   explained;
 * - mutants 201..204 (full step, round half away, f64 arithmetic, no
 *   saturation), each of which must be caught.
 *
 * With --sweep, also every song and section on the Rust kernel alone
 * (SWEEP_CALLBACKS callbacks each through galaxy_render): no fault, no read of
 * a never-written sample tail, and the render cost per 20 ms callback.
 *
 *   node scripts/validate-galaxy-mixer.mjs [--refresh] [--songs a,b] [--no-hw] [--sweep]
 *
 * Needs NATIVE_PROBE_PYTHON (default .cache/native-probe-env/bin/python), the
 * IT modules in .cache/galaxy-music/modules and src/runtime/galaxy-kernel.wasm
 * (cargo build of native/galaxy-kernel for wasm32-unknown-unknown). Oracle
 * outputs are cached in .cache/galaxy-music/mixer, keyed by the oracle
 * scripts and the case list. */
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const ORACLE = 'scripts/native-galaxy-music-sequencer-oracle.py';
const ORACLE_DEPS = [ORACLE, 'scripts/native-galaxy-music-oracle.py', 'scripts/native-collision-oracle.py'];
const HW_SOURCE = 'scripts/native-galaxy-mixer-hw.c';
const CACHE = '.cache/galaxy-music/mixer';
const MODULES = '.cache/galaxy-music/modules';
const WASM = 'src/runtime/galaxy-kernel.wasm';
const args = process.argv.slice(2);
const sha = bytes => createHash('sha256').update(bytes).digest();
const hex = bytes => Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length).toString('hex');

const CALLBACK_FRAMES = 882, CALLBACK_BYTES = 3528, RING_SIZE = 176400;
const RING_A0 = RING_SIZE - CALLBACK_BYTES / 2, RING_D = RING_SIZE / 2;
const PCM_FULL = 64, BUS_WINDOW = 8; // as in the oracle
const BUS_BYTES = 0x1040, BUS_FLOATS = BUS_BYTES / 4, VOICE = 0xa0;
const FAB = 0x50000000, FAB_SIZE = 0x100000;
const PIN_HIGH = 0x7fff0000; // no voice update or tick inside a fabricated program
const AHEAD = 7056;
const MUTANTS = {201: 'full step (no & ~1)', 202: 'round half away from zero', 203: 'f64 arithmetic', 204: 'no saturation'};

// ---- cases ------------------------------------------------------------------------

function songCase(name, module, section, callbacks, voiceCounter = 0, tickCounter = 0) {
  return {name, song: true, program: [{op: 'load', module}, {op: 'start', section},
    {op: 'pin', voiceCounter, tickCounter}, {op: 'ahead', value: AHEAD}, {op: 'run', callbacks}]};
}

const SONGS = [
  songCase('intro-s0', 'Intro_Music', 0, 2000),
  songCase('intro-s0-phase', 'Intro_Music', 0, 400, 0x123456, 0x2c0000),
  songCase('title-s0', 'Title_Music', 0, 500),
  songCase('unatco-s0', 'UNATCO_Music', 0, 500),
  songCase('hongkong-s0', 'HongKong_Music', 0, 500),
  songCase('lebedev-s0', 'Lebedev_Music', 0, 500),
  songCase('endgame1-s0', 'Endgame1_Music', 0, 500),
  songCase('area51-s0', 'Area51_Music', 0, 500),
  // Original edge behaviour found by the corpus sweep (--sweep):
  // a backward loop starting at the sample's first frame: the kernel's step & ~1
  // drift reads before the sample allocation (HAZARD_FOREIGN_READ);
  songCase('navalbase-s0', 'NavalBase_Music', 0, 400),
  songCase('oceanlab2-s2', 'OceanLab2_Music', 2, 250),
  // a 9xx offset below a backward ping-pong loop start: a negative run count moves the
  // bus pointers ~54 KB back and the next run writes over the buses (HAZARD_BUS_UNDERRUN).
  songCase('quotes-s4', 'Quotes_Music', 4, 250),
];

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
}
const pick = (r, list) => list[r() % list.length];

/** Six buses of float32 bit patterns: ordinary values, denormals, signed zeros, tiny and large normals. */
function busFill(r, zero = false) {
  const u = new Uint32Array(6 * BUS_FLOATS), f = new Float32Array(u.buffer);
  if (zero) return new Uint8Array(u.buffer);
  for (let i = 0; i < u.length; i++) {
    const sign = r() & 0x80000000, kind = r() % 10;
    if (kind < 6) f[i] = Math.fround((r() % 80001) - 40000 + (r() % 65536) / 65536);
    else if (kind === 6) u[i] = sign | (r() & 0x7fffff); // denormal (or zero)
    else if (kind === 7) u[i] = sign;
    else if (kind === 8) u[i] = sign | ((97 + r() % 14) << 23) | (r() & 0x7fffff); // 2^-30..2^-17
    else u[i] = sign | ((140 + r() % 20) << 23) | (r() & 0x7fffff); // 2^13..2^32
  }
  return new Uint8Array(u.buffer);
}

/** 64 KB of sample memory with extreme bytes and words sprinkled in. */
function sampleFill(r) {
  const b = new Uint8Array(0x10000);
  for (let i = 0; i < b.length; i++) b[i] = r() & 0xff;
  for (let i = 0; i < 400; i++) {
    const at = (r() % (b.length / 2)) * 2;
    const w = pick(r, [0x8000, 0x7fff, 0x0000, 0xffff, 0x8001]);
    b[at] = w & 0xff; b[at + 1] = w >> 8;
    b[r() % b.length] = pick(r, [0x80, 0x7f, 0x00, 0xff]);
  }
  return b;
}

const STEPS = [0x10000, 0x8000, 0x10001, 0x17fff, 0xffff, 3, 1, 0x2fffe, 0x18000, 0x4001, 0x7fffe,
  -0x8000, -0x10001, -0x17fff, -0x10000, -3, -0x2ffff];
const GAINS = [0, 1, -1, 0x7fff, 0x8000, 0x4000, 0x12345678, 0xffff8000, 0x00017fff, 23169, 31752];

function kernelArgs(r, count, wide) {
  const step = pick(r, STEPS) >>> 0, frac = pick(r, [0, 1, 0x8000, 0xffff, 0x1235, r() & 0xffff]);
  const base = FAB + 0x8000 + (r() % 129) - 64;
  const pos = wide ? (base >>> 1) : base;
  const gains = Array.from({length: 6}, () => (r() % 3 ? pick(r, GAINS) : r()) >>> 0);
  const mode = (wide ? 1 : 0) | (r() & 4) | (r() & 2) | (r() % 7 === 0 ? 0x10 : 0);
  return [count, pos >>> 0, frac >>> 0, step, ...gains, mode];
}

function kernelProgram(seed, zeroBuses) {
  const r = rng(seed), program = [{op: 'data', address: FAB, hex: hex(sampleFill(r))}, {op: 'buses', hex: hex(busFill(r, zeroBuses))}];
  for (const wide of [0, 1]) {
    for (const count of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 511, 512, 513]) {
      for (const offset of [0, 1, 2, 3]) {
        program.push({op: 'kernel', music: r() & 1, offset: 8 * offset, args: kernelArgs(r, count, wide)});
      }
    }
  }
  for (let i = 0; i < 150; i++) {
    const offset = r() % 8, count = r() % (517 - offset);
    program.push({op: 'kernel', music: r() & 1, offset: 8 * offset, args: kernelArgs(r, count, r() & 1)});
  }
  return program;
}

const f32bits = x => new Uint32Array(new Float32Array([x]).buffer)[0];
const SPECIAL = [0, 0x80000000, f32bits(0.5), f32bits(-0.5), f32bits(1.5), f32bits(-1.5), f32bits(2.5), f32bits(-2.5),
  f32bits(3.5), f32bits(-3.5), 0x3effffff, 0x3f000001, f32bits(32766.5), f32bits(32767), f32bits(32767.5), f32bits(32768),
  f32bits(-32768), f32bits(-32768.5), f32bits(-32769), f32bits(65535.5), f32bits(1e9), f32bits(-1e9), 0x4effffff,
  f32bits(2147483648), f32bits(-2147483648), 0xcf000001, 0x7f800000, 0xff800000, 0x7fc00000, 0xffc00000, 0x7f800001,
  1, 0x007fffff, 0x80000001, f32bits(1e-30), f32bits(4194303.5), f32bits(-4194304.5), f32bits(8388607.5),
  f32bits(16777216), f32bits(-0.49999997), f32bits(1e-7), f32bits(-12345.5), f32bits(12346.5)];

function convertProgram(seed) {
  const r = rng(seed), u = new Uint32Array(6 * BUS_FLOATS);
  for (let i = 0; i < u.length; i++) {
    u[i] = i < SPECIAL.length * 2 ? SPECIAL[i % SPECIAL.length] : r() % 3 ? f32bits(((r() % 140000) - 70000) / 2) : r();
  }
  for (let i = 0; i < SPECIAL.length; i++) u[BUS_FLOATS + 2 * i + 1] = SPECIAL[i]; // bus 1 lane 1
  const program = [{op: 'buses', hex: hex(new Uint8Array(u.buffer))}];
  const words = [0, 1, 0xffff, 0x7fff, 0x8000, 32000, 0x10000 - 32000, 16384, 0x7f00];
  for (const fmt of [0x07, 0x47, 0x06, 0x46, 0x87, 0xc7]) {
    for (const frames of [0, 1, 2, 3, 4, 5, 7, 8, 9, 17, 100, 520]) {
      for (const first of [0, 1, 3, 37]) {
        if (first + frames > 520) continue;
        const dst = new Uint16Array(2 * frames + 4);
        for (let i = 0; i < dst.length; i++) dst[i] = r() % 2 ? pick(r, words) : r() & 0xffff;
        program.push({op: 'convert', bus: r() % 6, first, frames, fmt, hex: hex(new Uint8Array(dst.buffer))});
      }
    }
  }
  return program;
}

// Fabricated renderer programs: synthetic voices over FAB sample blocks.
const BLOCK16 = FAB + 0x20000, BLOCK8 = FAB + 0x30000, SQUARE16 = FAB + 0x40000, RAND16 = FAB + 0x50000;
function sampleBlocks(r) {
  const out = [];
  const w16 = new Int16Array(8192), b8 = new Int8Array(8192), sq = new Int16Array(8192), rnd = new Int16Array(8192);
  for (let i = 0; i < 8192; i++) {
    w16[i] = Math.round(30000 * Math.sin(i / 7.3) + 2000 * Math.sin(i / 1.1));
    b8[i] = Math.round(120 * Math.sin(i / 5.1)) + ((r() % 7) - 3);
    sq[i] = (Math.floor(i / 50) % 2) ? -32768 : 32767;
    rnd[i] = r() & 0xffff;
  }
  for (const [address, a] of [[BLOCK16, w16], [BLOCK8, b8], [SQUARE16, sq], [RAND16, rnd]]) {
    out.push({op: 'data', address, hex: hex(new Uint8Array(a.buffer))});
  }
  return out;
}

/** A raw voice record (sequencer.md §4) for a sample block; frames are relative to the block. */
function voice(o) {
  const b = new Uint8Array(VOICE), v = new DataView(b.buffer);
  const wide = o.wide ?? true, unit = wide ? o.block >>> 1 : o.block;
  const w16 = (at, x) => v.setUint16(at, x & 0xffff, true), w32 = (at, x) => v.setUint32(at, x >>> 0, true);
  w32(0, 0x43494f56); w32(4, 0x98);
  b[0xc] = o.note ?? 0x3c; b[0xf] = o.active ?? 1; b[0x10] = o.enabled ?? 1; b[0x11] = o.music === false ? 8 : 0x80;
  w16(0x12, o.chanVol ?? 0x4e20); w16(0x14, o.pan ?? 0x4000); w16(0x16, o.panTarget ?? o.pan ?? 0x4000);
  w16(0x18, 0x7fff); w16(0x1a, 0x7fff); w16(0x1c, o.send2 ?? 0); w16(0x1e, o.send1 ?? 0x28);
  w16(0x24, 0x7fff); w16(0x2a, 0x7fff); w16(0x2e, 0x7fff); w16(0x36, o.panEnv ?? 0); w16(0x3c, o.panSep ?? 0x7fff);
  b[0x3f] = b[0x41] = 100;
  const loop = o.loop ?? [0, 0];
  w32(0x46, unit + (o.pos ?? 0)); w16(0x4a, o.frac ?? 0);
  w16(0x4c, (wide ? 4 : 0) | (o.loop ? 8 : 0) | (o.pingpong ? 0x10 : 0) | (o.release ? 0 : 0x80));
  w32(0x4e, unit); w32(0x52, unit + loop[0]); w32(0x56, unit + loop[1]); w32(0x5a, unit + (o.end ?? 8000));
  if (o.swapped) { w32(0x52, unit + loop[1]); w32(0x56, unit + loop[0]); }
  w32(0x5e, 44100); w32(0x62, o.step ?? 0x10000); w16(0x66, o.vol ?? 0x7fff); w16(0x68, o.vol ?? 0x7fff);
  return {op: 'voice', slot: o.slot, hex: hex(b)};
}

const poke = (address, width, value) => ({op: 'poke', address, width, value});
const pin = {op: 'pin', voiceCounter: PIN_HIGH, tickCounter: PIN_HIGH};

function renderProgram(seed, channels, voices, renders, extra = []) {
  const r = rng(seed);
  const program = [...sampleBlocks(r), poke(0x10698348, 1, channels), poke(0x10697cf0, 1, 76), poke(0x1069817c, 1, 127),
    {op: 'ahead', value: AHEAD}, {op: 'ring', size: 4000, fill: 0}, ...extra, ...voices.map(voice)];
  for (const x of renders) program.push(...(x.op ? [x] : [pin, {op: 'render', ...x}]));
  return program;
}

/** Consecutive renders of `frames` each, both heads advancing on a 4000-byte ring. */
function renders(list, a = 3000, b = 1000, size = 4000) {
  return list.map(frames => {
    const x = {posA: a, posB: b, lenA: 4 * frames, lenB: 4 * frames};
    a = (a + 4 * frames) % size; b = (b + 4 * frames) % size;
    return x;
  });
}

function randomVoices(r, slots, music) {
  return slots.map(slot => {
    const wide = r() % 2 === 1, len = 200 + r() % 3000;
    const ls = r() % (len - 40), le = ls + 8 + r() % (len - ls - 8);
    const looped = r() % 3 !== 0, pingpong = looped && r() % 2 === 0;
    const step = pick(r, [0x10000, 0x8000, 0x10001, 0x17fff, 0x4001, 0x20000 + (r() & 0xffff), r() % 0x30000 + 1, 0xc000]);
    return {slot, music, wide, block: wide ? pick(r, [BLOCK16, SQUARE16, RAND16]) : BLOCK8, end: len, loop: looped ? [ls, le] : undefined,
      pingpong, pos: r() % (looped ? le : len), frac: r() & 0xffff, step, pan: r() % 0x8000 | (r() % 9 === 0 ? 0x8000 : 0),
      panTarget: r() % 4 === 0 ? r() % 0x8000 : undefined, vol: r() % 6 === 0 ? 0 : r() & 0x7fff, chanVol: r() & 0x7fff,
      send1: r() & 0x7f, send2: r() & 0x7f, note: r() % 5 === 0 ? 0xbc : 0x3c, release: r() % 4 === 0};
  });
}

function fabricated() {
  const out = [];
  out.push({name: 'kernel-units-a', program: kernelProgram(0x6a1, false), units: true});
  out.push({name: 'kernel-units-b', program: kernelProgram(0x7b2, false), units: true});
  out.push({name: 'kernel-units-zero', program: kernelProgram(0x8c3, true), units: true});
  out.push({name: 'convert-units', program: convertProgram(0x9d4), units: true});
  out.push({name: 'mix-basic', program: renderProgram(1, 4, [
    {slot: 16, block: BLOCK16, loop: [100, 3000], pos: 100},
  ], [...renders([882, 882]), {posA: 400, posB: 2400, lenA: 3528, lenB: 2000}])});
  out.push({name: 'mix-steps', program: renderProgram(2, 4, [
    {slot: 16, block: BLOCK16, loop: [10, 77], pos: 10, step: 0x8000},
    {slot: 17, block: BLOCK16, loop: [5, 1001], pos: 900, step: 0x10001, frac: 0x1235},
    {slot: 18, wide: false, block: BLOCK8, loop: [0, 333], pos: 7, step: 0x17fff},
    {slot: 19, wide: false, block: BLOCK8, loop: [50, 99], pos: 60, step: 0x2fffe, frac: 0xffff},
  ], renders([882, 513, 1, 7, 882]))});
  out.push({name: 'mix-pingpong-ends', program: renderProgram(3, 4, [
    {slot: 16, block: BLOCK16, loop: [20, 57], pingpong: true, pos: 20, step: 0x8001},
    {slot: 17, wide: false, block: BLOCK8, loop: [3, 40], pingpong: true, pos: 30, step: 0x13333},
    {slot: 18, wide: false, block: BLOCK8, end: 300, pos: 0, step: 0x10000}, // exact division at the end
    {slot: 19, block: BLOCK16, end: 700, pos: 0, step: 0x18000},
    {slot: 0, music: false, block: BLOCK16, loop: [100, 163], pingpong: true, pos: 150, step: 0x9000, pan: 0x1000},
    {slot: 1, music: false, block: BLOCK16, loop: [100, 400], swapped: true, pingpong: true, pos: 300, step: -0x10001 >>> 0},
  ], renders([882, 882, 882]))});
  out.push({name: 'mix-pans-sends', program: renderProgram(4, 4, [
    {slot: 16, block: BLOCK16, loop: [0, 4000], pan: 0, send2: 0x40},
    {slot: 17, block: BLOCK16, loop: [0, 4000], pan: 0x3fff, pos: 13},
    {slot: 18, block: BLOCK16, loop: [0, 4000], pan: 0x7fff, pos: 27},
    {slot: 19, block: BLOCK16, loop: [0, 4000], pan: 0xc000, pos: 99},
    {slot: 0, music: false, block: BLOCK16, loop: [0, 4000], pan: 0xd234, send1: 0x7f},
    {slot: 1, music: false, block: BLOCK16, loop: [0, 4000], pan: 0x2000, panTarget: 0x6000, send1: 0x7f, send2: 0x7f},
    {slot: 2, music: false, block: BLOCK16, loop: [0, 4000], pan: 0x7000, panTarget: 0x1000},
    {slot: 3, music: false, block: BLOCK16, loop: [0, 4000], pan: 0x4000, panEnv: 0x2000, panSep: 0x7fff},
  ], renders([882, 882, 300]))});
  out.push({name: 'mix-volume-zero', program: renderProgram(5, 4, [
    {slot: 16, block: BLOCK16, loop: [0, 4000], vol: 0},
    {slot: 17, block: BLOCK16, loop: [0, 4000], step: 0},
    {slot: 18, block: BLOCK16, loop: [0, 4000]},
    {slot: 0, music: false, block: BLOCK16, loop: [0, 4000]},
    {slot: 1, music: false, wide: false, block: BLOCK8, loop: [0, 4000], step: 0x14000},
  ], [...renders([882]), poke(0x1069817c, 1, 0), ...renders([882], 2528, 528), poke(0x1069817c, 1, 127), poke(0x10697cf0, 1, 0),
    ...renders([882], 2056, 56)])});
  out.push({name: 'mix-saturation', program: renderProgram(6, 4, [
    ...[16, 17, 18, 19].map(slot => ({slot, block: SQUARE16, loop: [0, 4000], pan: 0, chanVol: 0x7e02})),
    ...[0, 1, 2, 3, 4, 5, 6, 7].map(slot => ({slot, music: false, block: SQUARE16, loop: [0, 4000], pan: slot % 2 ? 0x7fff : 0x4000,
      chanVol: 0x7e02, pos: 25 * slot})),
  ], renders([882, 882]), [poke(0x10697cf0, 1, 127), {op: 'ring', size: 4000, fill: 0x7f00}])});
  out.push({name: 'mix-sizes', program: renderProgram(7, 4, [
    {slot: 16, block: BLOCK16, loop: [10, 77], pos: 10, step: 0x8000},
    {slot: 17, wide: false, block: BLOCK8, loop: [0, 333], pos: 7, step: 0x17fff},
    {slot: 18, block: RAND16, loop: [100, 1999], pos: 100, step: 0x10001},
    {slot: 0, music: false, block: BLOCK16, loop: [5, 1001], pos: 900, step: 0x10001},
  ], renders([1, 2, 3, 4, 5, 6, 7, 8, 511, 512, 513, 9, 17]))});
  out.push({name: 'mix-key-off', program: renderProgram(8, 4, [
    {slot: 16, block: BLOCK16, loop: [100, 200], end: 500, pos: 150, note: 0xbc, release: true}, // released: plays to the end
    {slot: 17, block: BLOCK16, loop: [100, 200], end: 500, pos: 150, note: 0xbc}, // 0x80 kept: still loops
    {slot: 18, block: BLOCK16, loop: [100, 300], swapped: true, end: 500, pos: 250, step: -0x10000 >>> 0, note: 0xbc, release: true},
  ], renders([882, 882]))});
  out.push({name: 'mix-count-zero', program: renderProgram(9, 4, [
    // A loop shorter than one step: runs of 1 frame, pos drifts past the loop end until a run has count 0
    // at an odd bus offset (the prologue still stores a frame), then pos falls back by the loop length.
    {slot: 16, wide: false, block: BLOCK8, loop: [10, 14], pos: 10, step: 0x50000},
    {slot: 17, block: BLOCK16, loop: [10, 15], pos: 10, step: 0x4ffff},
    {slot: 18, wide: false, block: BLOCK8, loop: [20, 23], pos: 20, step: 0x38000, frac: 0x4000},
  ], renders([40, 882]))});
  const r = rng(10);
  const many = [...randomVoices(r, Array.from({length: 32}, (_, i) => 16 + i), true), ...randomVoices(r, Array.from({length: 16}, (_, i) => i), false)];
  out.push({name: 'mix-48-voices', program: renderProgram(10, 32, many, renders([882, 882, 513, 3, 882]))});
  const r2 = rng(11);
  for (let p = 0; p < 3; p++) {
    const vs = [...randomVoices(r2, [16, 17, 18, 19, 20, 21], true), ...randomVoices(r2, [0, 1, 2, 3], false)];
    out.push({name: `mix-random-${p}`, program: renderProgram(12 + p, 6, vs, renders(Array.from({length: 12}, () => 1 + r2() % 900)))});
  }
  return out;
}

// ---- oracle ---------------------------------------------------------------------------

async function runOracle(cases) {
  await mkdir(CACHE, {recursive: true});
  const casesJson = JSON.stringify(cases.map(({name, program}) => ({name, program})));
  const key = createHash('sha256');
  for (const f of ORACLE_DEPS) key.update(await readFile(f));
  key.update(casesJson);
  const digest = key.digest('hex');
  const keyFile = path.join(CACHE, 'key.txt');
  if (!args.includes('--refresh') && existsSync(keyFile) && (await readFile(keyFile, 'utf8')) === digest) return;
  await writeFile(path.join(CACHE, 'cases.json'), casesJson);
  console.log(`oracle: ${cases.length} cases (real kernel) ...`);
  execFileSync(python, [ORACLE, gameDirectory(), MODULES, path.join(CACHE, 'cases.json'), CACHE, '--real-kernel'],
    {stdio: ['ignore', 'inherit', 'inherit']});
  await writeFile(keyFile, digest);
}

// ---- Rust kernel ------------------------------------------------------------------------

async function kernel() {
  const {instance} = await WebAssembly.instantiate(await readFile(WASM));
  return instance.exports;
}

/** Digest groups of a trace, as the oracle cuts them (tag u32 length payload records). */
class Groups {
  constructor(x) { this.x = x; this.cursor = 0; this.hash = createHash('sha256'); this.digests = []; }
  bytes(ptr, len) { return new Uint8Array(this.x.memory.buffer, ptr, len); }
  pull() {
    const x = this.x;
    if (!x.galaxy_trace_ptr()) return;
    const gn = x.galaxy_trace_groups_len();
    const ends = gn ? new Uint32Array(x.memory.buffer, x.galaxy_trace_groups_ptr(), gn).slice() : [];
    for (const e of ends) {
      this.hash.update(this.bytes(x.galaxy_trace_ptr() + this.cursor, e - this.cursor));
      this.close();
      this.cursor = e;
    }
    if (gn) { x.galaxy_trace_consume(); this.cursor -= ends[gn - 1]; }
    const len = x.galaxy_trace_len();
    this.hash.update(this.bytes(x.galaxy_trace_ptr() + this.cursor, len - this.cursor));
    this.cursor = len;
  }
  record(tag, payload) {
    const head = new Uint8Array(5);
    head[0] = tag.charCodeAt(0);
    new DataView(head.buffer).setUint32(1, payload.length, true);
    this.hash.update(head); this.hash.update(payload);
  }
  close() { this.digests.push(this.hash.digest().subarray(0, 8)); this.hash = createHash('sha256'); }
}

function fault(x, what) {
  const f = x.galaxy_fault();
  if (f) throw new Error(`${what}: fault ${f.toString(16)}`);
}

function setup(x, mutant) {
  x.galaxy_set_mutant(mutant);
  x.galaxy_reset(16);
  x.galaxy_seq_setup(64);
}

function ringBytes(x, ringPtr, pos, len, size) {
  const mem = new Uint8Array(x.memory.buffer, ringPtr, size), first = Math.min(len, size - pos);
  const out = new Uint8Array(len);
  out.set(mem.subarray(pos, pos + first)); out.set(mem.subarray(0, len - first), first);
  return out;
}

/** A song case through galaxy_render_ring: trace groups, per-callback PCM digests (A, B), bus log. */
function runSong(x, c, module, mutant, callbacks) {
  setup(x, mutant);
  x.galaxy_seq_trace(1);
  const g = new Groups(x);
  const step = op => c.program.find(s => s.op === op);
  const input = x.galaxy_input(module.length); // may grow memory: take the buffer after
  new Uint8Array(x.memory.buffer, input, module.length).set(module);
  x.galaxy_seq_load(module.length, 127, 76); g.pull();
  x.galaxy_seq_start(16, step('start').section); g.pull();
  x.galaxy_seq_pin(step('pin').voiceCounter, step('pin').tickCounter);
  x.galaxy_seq_ahead(step('ahead').value);
  x.galaxy_mixer_ring(RING_SIZE);
  x.galaxy_mixer_bus_log(1);
  let a = RING_A0, b = (RING_A0 + RING_D) % RING_SIZE;
  const pcm = [], full = [];
  let buses = null;
  for (let i = 0; i < callbacks; i++) {
    x.galaxy_mixer_ahead_now();
    const got = x.galaxy_render_ring(a, b, CALLBACK_BYTES, CALLBACK_BYTES);
    fault(x, `${c.name} callback ${i}`);
    if (got !== CALLBACK_BYTES) throw new Error(`${c.name}: renderer returned ${got}`);
    const ptr = x.galaxy_mixer_ring_ptr();
    const pa = ringBytes(x, ptr, a, CALLBACK_BYTES, RING_SIZE), pb = ringBytes(x, ptr, b, CALLBACK_BYTES, RING_SIZE);
    pcm.push(Buffer.concat([sha(pa).subarray(0, 8), sha(pb).subarray(0, 8)]));
    if (i < PCM_FULL) full.push(pa, pb);
    a = (a + CALLBACK_BYTES) % RING_SIZE; b = (b + CALLBACK_BYTES) % RING_SIZE;
    g.pull();
    if (i + 1 === BUS_WINDOW) {
      buses = new Uint8Array(x.memory.buffer, x.galaxy_mixer_bus_log_ptr(), 4 * x.galaxy_mixer_bus_log_len()).slice();
      x.galaxy_mixer_bus_log(0);
    }
  }
  x.galaxy_seq_end(); g.pull();
  return {digests: g.digests, pcm, full: Buffer.concat(full), buses, hazards: x.galaxy_mixer_hazards()};
}

// galaxy_mixer_ring returns the pointer; the wrapper below keeps the last one.
let lastRing = 0;

/** The browser path: galaxy_render(882) per callback; bus-A digests. */
function runSongRender(x, c, module, mutant, callbacks) {
  setup(x, mutant);
  const step = op => c.program.find(s => s.op === op);
  const input = x.galaxy_input(module.length); // may grow memory: take the buffer after
  new Uint8Array(x.memory.buffer, input, module.length).set(module);
  x.galaxy_seq_load(module.length, 127, 76);
  x.galaxy_seq_start(16, step('start').section);
  x.galaxy_seq_pin(step('pin').voiceCounter, step('pin').tickCounter);
  x.galaxy_seq_ahead(step('ahead').value);
  const out = [];
  for (let i = 0; i < callbacks; i++) {
    const ptr = x.galaxy_render(CALLBACK_FRAMES);
    if (!ptr) throw new Error(`${c.name}: galaxy_render fault ${x.galaxy_fault().toString(16)}`);
    out.push(sha(new Uint8Array(x.memory.buffer, ptr, CALLBACK_BYTES)).subarray(0, 8));
  }
  return out;
}

/** A fabricated program replayed on the Rust kernel; group digests as the oracle cuts them. */
function runFabricated(x, c, mutant) {
  setup(x, mutant);
  x.galaxy_seq_trace(1);
  const g = new Groups(x);
  const fabPtr = x.galaxy_mixer_memory(FAB, FAB_SIZE);
  let ring = 0, ringSize = 0, channels = 0, first = 16, ahead = 0;
  const mem = () => new Uint8Array(x.memory.buffer);
  for (const s of c.program) {
    if (s.op === 'data') mem().set(Buffer.from(s.hex, 'hex'), fabPtr + s.address - FAB);
    else if (s.op === 'poke') {
      if (!x.galaxy_poke(s.address, s.value)) throw new Error(`poke ${s.address.toString(16)}`);
      if (s.address === 0x10698348) channels = s.value;
      if (s.address === 0x1068828d) first = s.value;
    } else if (s.op === 'voice') mem().set(Buffer.from(s.hex, 'hex'), x.galaxy_voices_ptr() + s.slot * VOICE);
    else if (s.op === 'buses') mem().set(Buffer.from(s.hex, 'hex'), x.galaxy_mixer_buses());
    else if (s.op === 'ring') {
      ringSize = s.size; ring = x.galaxy_mixer_ring(ringSize);
      new Uint16Array(x.memory.buffer, ring, ringSize / 2).fill(s.fill);
    } else if (s.op === 'pin') x.galaxy_seq_pin(s.voiceCounter, s.tickCounter);
    else if (s.op === 'ahead') { ahead = s.value; x.galaxy_seq_ahead(ahead); }
    else if (s.op === 'render') {
      x.galaxy_mixer_ahead_now();
      const got = x.galaxy_render_ring(s.posA, s.posB, s.lenA, s.lenB);
      fault(x, `${c.name} render`);
      g.pull();
      ring = x.galaxy_mixer_ring_ptr();
      const head = new Uint8Array(4); new DataView(head.buffer).setUint32(0, got, true);
      g.record('Q', Buffer.concat([head, new Uint8Array(x.memory.buffer, ring, ringSize), new Uint8Array(x.memory.buffer, x.galaxy_mixer_buses(), 6 * BUS_BYTES),
        new Uint8Array(x.memory.buffer, x.galaxy_voices_ptr(), (first + channels) * VOICE)]));
      g.close();
    } else if (s.op === 'kernel') {
      const f = x.galaxy_mixer_kernel(s.music, s.offset, ...s.args);
      if (f) throw new Error(`${c.name} kernel: fault ${f.toString(16)}`);
      const gi = s.music ? 0 : 1, base = x.galaxy_mixer_buses();
      g.pull();
      g.record('Z', Buffer.concat([0, 2, 4].map(k => new Uint8Array(x.memory.buffer, base + (gi + k) * BUS_BYTES, BUS_BYTES))));
      g.close();
    } else if (s.op === 'convert') {
      const dst = Buffer.from(s.hex, 'hex'), p = x.galaxy_mixer_scratch(dst.length / 2);
      mem().set(dst, p);
      const f = x.galaxy_mixer_convert(s.bus, s.first, s.frames, s.fmt);
      if (f) throw new Error(`${c.name} convert: fault ${f.toString(16)}`);
      g.pull();
      g.record('C', new Uint8Array(x.memory.buffer, x.galaxy_mixer_scratch_ptr(), dst.length).slice());
      g.close();
    } else throw new Error(`op ${s.op}`);
  }
  x.galaxy_seq_end(); g.pull();
  return g.digests;
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (Buffer.compare(Buffer.from(a[i]), Buffer.from(b[i]))) return i;
  return a.length === b.length ? -1 : n;
}

const chunks = (buf, size) => Array.from({length: buf.length / size}, (_, i) => buf.subarray(i * size, (i + 1) * size));

// ---- host CPU -----------------------------------------------------------------------------

async function hostCpu(units) {
  if (args.includes('--no-hw')) return {skipped: 'disabled (--no-hw)'};
  const dir = path.join(CACHE, 'hw'), bin = path.join(dir, 'galaxy-mixer-hw');
  await mkdir(dir, {recursive: true});
  const build = spawnSync('gcc', ['-m32', '-O1', '-o', bin, HW_SOURCE], {encoding: 'utf8'});
  if (build.status !== 0) return {skipped: `gcc -m32 unavailable: ${(build.stderr || build.error?.message || '').split('\n')[0]}`};
  const results = [];
  for (const c of units) {
    const parts = [];
    const u32 = (...v) => parts.push(Buffer.from(new Uint32Array(v).buffer));
    u32(0);
    for (const s of c.program) {
      if (s.op === 'data') { const b = Buffer.from(s.hex, 'hex'); u32(2, s.address, b.length); parts.push(b); }
      else if (s.op === 'buses') { u32(1); parts.push(Buffer.from(s.hex, 'hex')); }
      else if (s.op === 'kernel') u32(3, s.music, s.offset, ...s.args);
      else if (s.op === 'convert') { const b = Buffer.from(s.hex, 'hex'); u32(4, s.bus, s.first, s.frames, s.fmt, b.length); parts.push(b); }
    }
    const script = path.join(dir, `${c.name}.script`), out = path.join(dir, `${c.name}.out`);
    await writeFile(script, Buffer.concat(parts));
    const run = spawnSync(bin, [path.join(CACHE, 'native-code.bin'), script, out], {encoding: 'utf8'});
    if (run.status !== 0) throw new Error(`host CPU harness failed on ${c.name}: ${run.stderr}`);
    const bytes = await readFile(out), digests = [];
    for (let at = 0; at < bytes.length;) {
      const len = bytes.readUInt32LE(at + 1);
      digests.push(sha(bytes.subarray(at, at + 5 + len)).subarray(0, 8));
      at += 5 + len;
    }
    results.push({name: c.name, digests});
  }
  return {results};
}

// ---- coverage -------------------------------------------------------------------------------

// Unreached instruction runs (start address -> reason); any other unreached run fails.
const UNREACHED = {
  0x10614762: 'effect hooks: [0x10684ea8], [0x10688288], [0x10698388], [0x106981c8] are null for DX music (mixer.md §3)',
  0x1061476c: 'effect hook 1: null for DX', 0x10614775: 'effect hook 1: null for DX', 0x10614796: 'effect hook 2: null for DX',
  0x1061479f: 'effect hook 2: null for DX', 0x106147c0: 'effect hook 3: null for DX', 0x106147c9: 'effect hook 3: null for DX',
  0x106147ea: 'effect hook 4: null for DX', 0x106147f3: 'effect hook 4: null for DX',
  0x10623009: '8-bit output (fmt & 2 = 0): not translated (UNSUPPORTED_OUTPUT); DX opens 16-bit stereo',
};
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

// ---- main ---------------------------------------------------------------------------------

const only = args.includes('--songs') ? new Set(args[args.indexOf('--songs') + 1].split(',')) : null;
const songs = SONGS.filter(c => !only || only.has(c.name));
const fabs = fabricated();
await runOracle([...songs, ...fabs]);
const x = await kernel();
// The ring/scratch pointers move when they are resized; wrap the allocating exports.
const ringExport = x.galaxy_mixer_ring, scratchExport = x.galaxy_mixer_scratch;
let scratchPtr = 0;
const ex = Object.assign(Object.create(null), x, {
  galaxy_mixer_ring: n => (lastRing = ringExport(n)),
  galaxy_mixer_ring_ptr: () => lastRing,
  galaxy_mixer_scratch: n => (scratchPtr = scratchExport(n)),
  galaxy_mixer_scratch_ptr: () => scratchPtr,
});
const summary = JSON.parse(await readFile(path.join(CACHE, 'summary.json'), 'utf8'));
let failures = 0;
const fail = msg => { failures++; console.log(`FAIL ${msg}`); };
const modules = {};
for (const c of songs) {
  const m = c.program[0].module;
  modules[m] ??= await readFile(path.join(MODULES, `${m}.it`));
}

// 1. Songs.
const songResults = {};
for (const c of songs) {
  const callbacks = c.program.at(-1).callbacks;
  const oracleDig = chunks(await readFile(path.join(CACHE, `${c.name}.dig`)), 8);
  const oraclePcm = chunks(await readFile(path.join(CACHE, `${c.name}.pcm.dig`)), 16);
  const oracleFull = await readFile(path.join(CACHE, `${c.name}.pcm`));
  const oracleBus = await readFile(path.join(CACHE, `${c.name}.bus`));
  let rust;
  try {
    rust = runSong(ex, c, modules[c.program[0].module], 0, callbacks);
  } catch (e) {
    fail(`${c.name}: ${e.message}`); songResults[c.name] = {error: e.message}; continue;
  }
  const t = firstDiff(rust.digests, oracleDig), p = firstDiff(rust.pcm, oraclePcm);
  const busEqual = Buffer.compare(Buffer.from(rust.buses), oracleBus) === 0;
  const fullEqual = Buffer.compare(rust.full, oracleFull) === 0;
  const render = runSongRender(ex, c, modules[c.program[0].module], 0, callbacks);
  const r = firstDiff(render, oraclePcm.map(d => d.subarray(0, 8)));
  songResults[c.name] = {callbacks, ticks: oracleDig.length - 1, traceFirstDiff: t, pcmFirstDiff: p, renderFirstDiff: r,
    busEqual, fullEqual, hazards: rust.hazards};
  const label = `${c.name}: ${callbacks} callbacks, ${oracleDig.length - 1} ticks`;
  if (t >= 0) {
    // A sequencer difference is the sequencer validator's to chase; report it.
    console.log(`${label}: sequencer trace differs at group ${t} (PCM ${p < 0 ? 'equal' : `differs at callback ${p}`}) — not a mixer verdict`);
    if (c.name.startsWith('intro')) fail(`${c.name}: sequencer trace differs at group ${t}`);
    continue;
  }
  if (p >= 0 || r >= 0 || !busEqual || !fullEqual) {
    let where = '';
    if (p >= 0 && p < PCM_FULL) {
      const a = rust.full.subarray(p * 2 * CALLBACK_BYTES), o = oracleFull.subarray(p * 2 * CALLBACK_BYTES);
      for (let i = 0; i < 2 * CALLBACK_BYTES; i += 2) if (a.readInt16LE(i) !== o.readInt16LE(i)) { where = ` (bus ${i < CALLBACK_BYTES ? 'A' : 'B'} sample ${(i % CALLBACK_BYTES) / 2}: ${a.readInt16LE(i)} vs ${o.readInt16LE(i)})`; break; }
    }
    fail(`${label}: PCM ${p} render ${r} buses ${busEqual} full ${fullEqual}${where}`);
  } else console.log(`${label}: trace, PCM (both buses), buses of ${BUS_WINDOW} callbacks and galaxy_render all bit-equal${rust.hazards ? `, hazards ${rust.hazards}` : ''}`);
}

// 2. Fabricated programs.
const fabResults = {};
for (const c of fabs) {
  const oracleDig = chunks(await readFile(path.join(CACHE, `${c.name}.dig`)), 8);
  let rust;
  try { rust = runFabricated(ex, c, 0); } catch (e) { fail(`${c.name}: ${e.message}`); continue; }
  const d = firstDiff(rust, oracleDig);
  fabResults[c.name] = {groups: oracleDig.length, firstDiff: d};
  if (d >= 0) fail(`${c.name}: group ${d} of ${oracleDig.length} differs`);
}
const fabGroups = Object.values(fabResults).reduce((n, r) => n + r.groups, 0);
const fabEqual = Object.values(fabResults).filter(r => r.firstDiff < 0).length;
console.log(`fabricated: ${fabEqual}/${fabs.length} programs, ${fabGroups} groups bit-equal`);

// 3. Host CPU (the original templates natively) against Unicorn.
const units = fabs.filter(c => c.units);
const hw = await hostCpu(units);
if (hw.skipped) console.log(`host CPU: skipped (${hw.skipped})`);
else {
  let ops = 0;
  for (const {name, digests} of hw.results) {
    const oracleDig = chunks(await readFile(path.join(CACHE, `${name}.dig`)), 8);
    ops += digests.length;
    const d = firstDiff(digests, oracleDig.slice(0, digests.length));
    if (d >= 0 || digests.length !== oracleDig.length - 1) fail(`host CPU ${name}: differs from Unicorn at op ${d}`);
  }
  console.log(`host CPU: ${ops} kernel/conversion ops of ${hw.results.length} programs equal to Unicorn`);
}

// 4. Coverage.
const coverage = JSON.parse(await readFile(path.join(CACHE, 'coverage.json'), 'utf8'));
for (const entry of coverage.filter(e => /renderer|template/.test(e.function))) {
  const unreached = runs(entry);
  for (const run of unreached) {
    if (!UNREACHED[run.start]) fail(`coverage ${entry.function}: unexplained unreached run ${run.start.toString(16)} (${run.count}: ${run.first})`);
  }
  console.log(`coverage ${entry.function}: ${entry.covered.length}/${entry.instructions.length}` +
    (unreached.length ? `; unreached: ${unreached.map(r => `${r.start.toString(16)}(${r.count}) ${UNREACHED[r.start] ?? '?'}`).join('; ')}` : ''));
}

// 5. Corpus sweep (Rust only): faults, unwritten-tail reads, cost.
if (args.includes('--sweep')) {
  const SWEEP_CALLBACKS = 1500;
  const names = (await readdir(MODULES)).filter(n => n.endsWith('.it')).map(n => n.slice(0, -3)).sort();
  let sections = 0, faults = 0, worst = 0;
  const hazards = {1: [], 2: [], 4: []};
  const times = [];
  for (const name of names) {
    const module = await readFile(path.join(MODULES, `${name}.it`));
    for (let section = 0; section < 64; section++) {
      setup(ex, 0);
      const input = ex.galaxy_input(module.length);
      new Uint8Array(ex.memory.buffer, input, module.length).set(module);
      if (ex.galaxy_seq_load(module.length, 127, 76) !== 0) { fail(`sweep ${name}: load`); break; }
      if (ex.galaxy_seq_start(16, section) !== 0) break; // past the song length (0x11)
      ex.galaxy_seq_pin(0, 0);
      sections++;
      for (let i = 0; i < SWEEP_CALLBACKS; i++) {
        const t = performance.now();
        const ptr = ex.galaxy_render(CALLBACK_FRAMES);
        times.push(performance.now() - t);
        if (!ptr) { faults++; fail(`sweep ${name} section ${section}: fault ${ex.galaxy_fault().toString(16)} at callback ${i}`); break; }
      }
      for (const bit of [1, 2, 4]) if (ex.galaxy_mixer_hazards() & bit) hazards[bit].push(`${name}/${section}`);
    }
  }
  times.sort((a, b) => a - b);
  worst = times.at(-1);
  const list = bit => hazards[bit].length ? hazards[bit].join(' ') : 'none';
  console.log(`sweep: ${names.length} songs, ${sections} sections x ${SWEEP_CALLBACKS} callbacks: ${faults} faults; ` +
    `unwritten-tail reads: ${list(1)}; foreign reads: ${list(2)}; bus underruns: ${list(4)}; ` +
    `galaxy_render(882) median ${(1000 * times[times.length >> 1]).toFixed(0)} us, p99 ${(1000 * times[Math.floor(times.length * 0.99)]).toFixed(0)} us, max ${(1000 * worst).toFixed(0)} us`);
}

// 6. Mutants.
const intro = songs.find(c => c.name === 'intro-s0');
for (const [id, label] of Object.entries(MUTANTS)) {
  const caught = [];
  for (const c of fabs) {
    try {
      const oracleDig = chunks(await readFile(path.join(CACHE, `${c.name}.dig`)), 8);
      if (firstDiff(runFabricated(ex, c, +id), oracleDig) >= 0) caught.push(c.name);
    } catch (e) { caught.push(`${c.name} (fault)`); }
  }
  if (intro) {
    const oraclePcm = chunks(await readFile(path.join(CACHE, 'intro-s0.pcm.dig')), 16);
    const pcm = runSong(ex, intro, modules.Intro_Music, +id, 300).pcm;
    if (firstDiff(pcm, oraclePcm.slice(0, 300)) >= 0) caught.push('intro-s0');
  }
  if (!caught.length) fail(`mutant ${id} (${label}) not caught`);
  else console.log(`mutant ${id} (${label}): caught by ${caught.length} (${caught.slice(0, 6).join(', ')}${caught.length > 6 ? ', ...' : ''})`);
}
ex.galaxy_set_mutant(0);

await writeFile(path.join(CACHE, 'results.json'), JSON.stringify({songs: songResults, fabricated: fabResults}, null, 1));
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('Galaxy mixer: all checks passed');
