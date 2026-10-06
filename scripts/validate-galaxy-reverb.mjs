#!/usr/bin/env node
/** Galaxy's effects reverb (docs/galaxy-music/reverb.md) in the Rust kernel
 * (native/galaxy-kernel/src/reverb.rs) against the original code:
 *
 * 1. FCOS and the low-pass coefficient on this host's real x87: the
 *    original setup 0x106109f0 run natively (scripts/native-galaxy-reverb-hw.c
 *    maps Galaxy.dll at its base) for every CutoffHz the subsystem can hand
 *    it (0..44100, at 44100 Hz) under control word 0x037f: the FCOS input,
 *    its result and the stored k and 1 - k against the model's. The same
 *    sweep under 0x027f and 0x007f is reported (the model is the 64-bit one).
 * 2. The setup's whole parameter block (taps, gains, coefficients, output
 *    gain, result) for the reverb zones of the shipped maps (class defaults
 *    applied, built by galaxy-audio.mjs's Update reverb tail) and for random
 *    and edge blocks, natively.
 * 3. The SSE kernel 0x10622d33 natively: sequences of calls on contexts from
 *    those setups, random sends and dry buses (denormals, zeros, large
 *    values), every call's dry output and context header, then the whole
 *    context with its delay lines.
 * 4. The setter glxSetSampleReverb 0x106113d0 and the renderer's hook under
 *    Unicorn (scripts/native-galaxy-effects-oracle.py, FCOS's result taken
 *    from step 1): install, change, free; voices mixed with the reverb, both
 *    buses' PCM per callback and the browser path.
 *
 *   node scripts/validate-galaxy-reverb.mjs [--refresh]
 *
 * Needs gcc -m32 on x86 Linux (steps 1-3 skip loudly without it). */
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';

const CACHE = '.cache/galaxy-reverb';
const HW = path.join(CACHE, 'galaxy-reverb-hw');
const WASM = 'src/runtime/galaxy-kernel.wasm';
const args = process.argv.slice(2);
const CTX = 0x60188, BLOCK = 0x6c, HEADER = 0xc8;
let failures = 0;
const fail = msg => { failures++; console.log(`FAIL ${msg}`); };
const f32bits = v => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b.readUInt32LE(); };
const hex = b => Buffer.from(b).toString('hex');

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
}

// ---- the native harness ----------------------------------------------------------------
await mkdir(CACHE, {recursive: true});
const build = spawnSync('gcc', ['-m32', '-O1', '-o', HW, 'scripts/native-galaxy-reverb-hw.c'], {encoding: 'utf8'});
const hardware = build.status === 0;
if (!hardware) console.log(`SKIP hardware steps: gcc -m32 failed (${(build.stderr || build.error?.message || '').split('\n')[0]})`);
const dll = path.join(gameDirectory(), 'System', 'Galaxy.dll');

/** Run a harness script (Buffer parts); returns the records [{tag, payload}]. */
async function harness(name, parts) {
  const script = path.join(CACHE, `${name}.script`), out = path.join(CACHE, `${name}.out`);
  await writeFile(script, Buffer.concat(parts));
  const run = spawnSync(HW, [dll, script, out], {encoding: 'utf8', maxBuffer: 1 << 20});
  if (run.status !== 0) throw new Error(`reverb harness failed (${run.status}): ${run.stderr}`);
  const bytes = await readFile(out), records = [];
  for (let at = 0; at < bytes.length;) {
    const len = bytes.readUInt32LE(at + 1);
    records.push({tag: String.fromCharCode(bytes[at]), payload: bytes.subarray(at + 5, at + 5 + len)});
    at += 5 + len;
  }
  return records;
}
const u32 = (...v) => Buffer.from(new Uint32Array(v).buffer);

// ---- the Rust kernel ----------------------------------------------------------------------
const {instance} = await WebAssembly.instantiate(await readFile(WASM));
const x = instance.exports;
x.galaxy_reset(16);
x.galaxy_seq_setup(64);
const mem = () => new Uint8Array(x.memory.buffer);
const rustCos = hf => { const p = x.galaxy_reverb_cos(hf); return Buffer.from(mem().subarray(p, p + 24)); };
function rustSetup(block) {
  mem().set(block, x.galaxy_reverb_block());
  const result = x.galaxy_reverb_setup();
  const p = x.galaxy_reverb_ctx();
  return {result, header: Buffer.from(mem().subarray(p, p + HEADER))};
}

/** A glxReverb as Update builds it: Volume, HFDamp, six (Time, Gain). */
function block({volume = 100 / 255, hf = 6000, delays = [[0.04, 150 / 255], [0.068, 70 / 255], [0.001, 0.001], [0.001, 0.001], [0.001, 0.001], [0.001, 0.001]]} = {}) {
  const b = Buffer.alloc(BLOCK);
  b.writeFloatLE(volume, 0xc); b.writeFloatLE(hf, 0x10);
  delays.forEach(([t, g], i) => { b.writeFloatLE(t, 0x34 + 8 * i); b.writeFloatLE(g, 0x38 + 8 * i); });
  return b;
}

// ---- 1. FCOS sweep -------------------------------------------------------------------------
const results = {};
if (hardware) {
  const LAST = 44100, template = block();
  const sweeps = {};
  for (const cw of [0x037f, 0x027f, 0x007f]) {
    const records = await harness(`sweep-${cw.toString(16)}`, [u32(4, cw, 0, LAST), template]);
    const rows = [];
    for (let i = 0; i < records.length; i += 3) rows.push({x: records[i].payload.subarray(0, 10), cos: records[i].payload.subarray(10, 20),
      status: records[i].payload.readUInt16LE(20), k: records[i + 1].payload.readUInt32LE(0), oneMinusK: records[i + 2].payload.readUInt32LE(0)});
    if (rows.length !== LAST + 1) throw new Error(`sweep ${cw.toString(16)}: ${rows.length} rows`);
    sweeps[cw] = rows;
  }
  const rows = sweeps[0x037f];
  let xDiff = 0, kDiff = 0, faults = 0;
  const exceptions = [];
  for (let cutoff = 0; cutoff <= LAST; cutoff++) {
    const hw = rows[cutoff], hf = f32bits(cutoff), model = rustCos(hf);
    if (Buffer.compare(model.subarray(0, 10), hw.x)) { if (xDiff++ < 5) fail(`cutoff ${cutoff}: FCOS input ${hex(model.subarray(0, 10))} vs ${hex(hw.x)}`); }
    const fault = model.readUInt32LE(20);
    if (fault) faults++;
    else if (Buffer.compare(model.subarray(10, 20), hw.cos)) exceptions.push({cutoff, x: hex(hw.x), hw: hex(hw.cos), model: hex(model.subarray(10, 20))});
    const b = Buffer.from(template); b.writeFloatLE(cutoff, 0x10);
    const {header} = rustSetup(b);
    if (header.readUInt32LE(0x68) !== hw.k || header.readUInt32LE(0x80) !== hw.oneMinusK) {
      if (kDiff++ < 5) fail(`cutoff ${cutoff}: k ${header.readUInt32LE(0x68).toString(16)} / ${hw.k.toString(16)}, 1-k ${header.readUInt32LE(0x80).toString(16)} / ${hw.oneMinusK.toString(16)}`);
    }
  }
  if (xDiff) fail(`${xDiff} FCOS inputs differ`);
  if (kDiff) fail(`${kDiff} coefficients differ`);
  if (faults) fail(`${faults} cosines the model refused`);
  // The hardware FCOS is not correctly rounded; the model's cosine is. What
  // the original keeps, k and 1 - k, must be equal at every input (above).
  await writeFile(path.join(CACHE, 'fcos-differences.json'), JSON.stringify(exceptions, null, 1));
  // |hardware - model| in absolute terms: the significand difference scaled
  // by the (equal) exponent; near cos = 0 FCOS's reduction error dominates.
  const ext = h => { const b = Buffer.from(h, 'hex'); return {sig: b.readBigUInt64LE(0), exp: (b.readUInt16LE(8) & 0x7fff) - 16383 - 63}; };
  let worst = -Infinity, worstUlps = 0;
  for (const e of exceptions) {
    const a = ext(e.hw), b = ext(e.model);
    if (a.exp !== b.exp) { worst = Infinity; continue; }
    const d = Number(a.sig > b.sig ? a.sig - b.sig : b.sig - a.sig);
    worst = Math.max(worst, Math.log2(d) + a.exp); worstUlps = Math.max(worstUlps, d);
  }
  const statusWords = new Set(rows.map(r => r.status.toString(16)));
  const pc = cw => sweeps[cw].filter((r, i) => r.k !== rows[i].k || r.oneMinusK !== rows[i].oneMinusK).length;
  results.sweep = {cutoffs: LAST + 1, xDiff, kDiff, faults, exceptions: exceptions.length, statusWords: [...statusWords],
    pc53Differs: pc(0x027f), pc24Differs: pc(0x007f)};
  console.log(`FCOS sweep (CutoffHz 0..${LAST}, cw 0x037f, real x87): inputs ${xDiff ? 'DIFFER' : 'equal'}, ` +
    `${LIST(exceptions.length)} FCOS results off the correctly rounded cosine (at most 2^${worst.toFixed(1)} absolute, ${worstUlps} units in the last place near cos = 0), ${faults} undecided; ` +
    `k and 1-k ${kDiff ? 'DIFFER' : 'equal at every input'}; ` +
    `status words ${[...statusWords].join(',')}; under 0x027f k differs from 0x037f at ${results.sweep.pc53Differs} cutoffs, under 0x007f at ${results.sweep.pc24Differs}`);
}
function LIST(n) { return n === 0 ? 'no' : String(n); }

// ---- 2. the setup's parameter block ------------------------------------------------------
/** Update's reverb block (galaxy-audio.mjs, verified against the original by
 * validate-galaxy-music-update.mjs) for a zone's effective values. */
const {createGalaxyAudio} = await import('../src/runtime/galaxy-audio.mjs');
function updateBlock(zone) {
  let out = null;
  const listener = {Region: {'engine.actor.pointregion.zone': zone}};
  const audio = createGalaxyAudio({effectsChannels: 16, ambientFactor: 0.7, dopplerSpeed: 6500, soundVolume: 204, speechVolume: 255,
    useSurround: 0, reverseStereo: 0, useReverb: 1}, {listener: () => ({actor: listener, viewTarget: null}),
    read: (object, name) => name === 'Location' ? [0, 0, 0] : name === 'ShowFlags' ? 0 : object[name],
    library: {lock() {}, unlock() {}, setSampleReverb: words => { out = Buffer.from(words.buffer, words.byteOffset, BLOCK); return 0; }}});
  audio.update(0, {origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1]});
  return out;
}
/** Every reverb zone of the shipped maps, class defaults applied. */
async function shippedZones() {
  const {AssetStore} = await import('../src/unreal/assets.mjs');
  const {ClassDefaults} = await import('../src/unreal/classes.mjs');
  const {decodeMap} = await import('../src/unreal/map.mjs');
  const root = gameDirectory(), files = [];
  for (const d of ['Maps', 'System']) for (const n of await readdir(path.join(root, d))) files.push({path: `${d}/${n}`, read: () => readFile(path.join(root, d, n))});
  const assets = new AssetStore(files), defaults = new ClassDefaults(assets), zones = [];
  for (const name of (await readdir(path.join(root, 'Maps'))).filter(n => /\.dx$/i.test(n)).map(n => n.slice(0, -3))) {
    const asset = await assets.get(name), map = decodeMap(asset.bytes);
    for (const actor of map.actors) {
      if (!/zone|levelinfo/i.test(actor.className ?? '')) continue;
      const v = await defaults.forActor(asset, actor);
      if (!v.bReverbZone) continue;
      const arr = key => [0, 1, 2, 3, 4, 5].map(i => v[i ? `${key}[${i}]` : key] ?? 0);
      zones.push({map: name, actor: actor.name, zone: {bReverbZone: true, MasterGain: v.MasterGain ?? 0, CutoffHz: v.CutoffHz ?? 0,
        Delay: arr('Delay'), Gain: arr('Gain')}});
    }
  }
  return zones;
}
const zones = await shippedZones();
const distinct = new Map();
for (const z of zones) { const b = updateBlock(z.zone); const k = hex(b); if (!distinct.has(k)) distinct.set(k, {block: b, zones: []}); distinct.get(k).zones.push(`${z.map}.${z.actor}`); }
const blocks = [...distinct.values()].map(d => ({label: d.zones.join(' '), block: d.block}));
const r2 = rng(7);
for (let i = 0; i < 400; i++) {
  const zone = {bReverbZone: true, MasterGain: 1 + r2() % 255, CutoffHz: (r2() % 50000) - 2000,
    Delay: Array.from({length: 6}, () => r2() % 256), Gain: Array.from({length: 6}, () => r2() % 256)};
  blocks.push({label: `random ${i}`, block: updateBlock(zone)});
}
// Edge blocks the setup tests but Update never builds (Volume past 1 or
// below -1, HFDamp above the rate, zero times, NaN).
for (const [label, b] of [['volume 1.0', block({volume: 1})], ['volume > 1', block({volume: 1.0000001})], ['volume -1', block({volume: -1})],
  ['volume < -1', block({volume: -1.5})], ['hf above rate', block({hf: 44101})], ['hf = rate', block({hf: 44100})],
  ['zero times', block({delays: Array.from({length: 6}, () => [0, 0.5])})], ['gain 0', block({delays: Array.from({length: 6}, () => [0.01, 0])})],
  ['volume NaN', block({volume: NaN})], ['times 0.34', block({delays: Array.from({length: 6}, () => [0.34, 0.999])})]])
  blocks.push({label, block: b});
if (hardware) {
  const byCw = {};
  for (const cw of [0x037f, 0x027f, 0x007f]) {
    const records = await harness(`setup-${cw.toString(16)}`, blocks.map(b => Buffer.concat([u32(1, cw), b.block])));
    byCw[cw] = records.map(r => ({result: r.payload.readInt32LE(0), header: r.payload.subarray(4, 4 + HEADER)}));
  }
  let equal = 0;
  blocks.forEach((b, i) => {
    const hw = byCw[0x037f][i], rust = rustSetup(b.block);
    // A refused block leaves the context as it was (0xa5 in the harness).
    const same = hw.result === rust.result && (hw.result !== 0 || !Buffer.compare(hw.header, rust.header));
    if (same) equal++;
    else if (failures < 10) {
      let at = 0; while (at < HEADER && hw.header[at] === rust.header[at]) at++;
      fail(`setup ${b.label}: result ${rust.result} / ${hw.result}, context +0x${at.toString(16)}`);
    }
  });
  const differs = cw => blocks.filter((b, i) => byCw[cw][i].result !== byCw[0x037f][i].result || Buffer.compare(byCw[cw][i].header, byCw[0x037f][i].header)).length;
  results.setup = {blocks: blocks.length, shippedZones: zones.length, distinctShipped: distinct.size, equal, pc53Differs: differs(0x027f), pc24Differs: differs(0x007f)};
  console.log(`setup (real x87, cw 0x037f): ${equal}/${blocks.length} parameter blocks equal (${zones.length} reverb zones in the shipped maps, ` +
    `${distinct.size} distinct blocks; 400 random; 10 edges); vs 0x037f, ${results.setup.pc53Differs} differ under 0x027f and ${results.setup.pc24Differs} under 0x007f`);
  for (const d of distinct.values()) console.log(`  ${d.zones.length} zone(s): ${d.zones.slice(0, 4).join(', ')}${d.zones.length > 4 ? ', ...' : ''}`);
}

// ---- 3. the SSE kernel ---------------------------------------------------------------------
function frames(r, count, kind) {
  const f = new Float32Array(2 * count);
  for (let i = 0; i < f.length; i++) {
    const k = kind === 'mix' ? r() % 10 : kind;
    f[i] = k < 5 ? ((r() % 65536) - 32768) * 0.5 : k < 6 ? 0 : k < 7 ? (r() % 1000) * 2 ** -140 : k < 8 ? ((r() % 2000) - 1000) * 2 ** 10 : ((r() % 200) - 100) * 2 ** -20;
  }
  return Buffer.from(f.buffer);
}
if (hardware) {
  const contexts = [...blocks.slice(0, distinct.size), blocks[distinct.size + 3], blocks[distinct.size + 77]];
  let calls = 0, framesRun = 0, equalCalls = 0, dumps = 0, equalDumps = 0;
  for (const [n, c] of contexts.entries()) {
    const r = rng(100 + n), parts = [u32(1, 0x037f), c.block], plan = [];
    for (let i = 0; i < 44; i++) {
      const count = i < 4 ? [1, 2, 3, 511][i] : 1 + r() % 512;
      const kind = i < 34 ? 'mix' : i < 40 ? 6 : 5; // then denormal-only and zero sends (the tail decays)
      const send = frames(r, count, kind), dry = frames(r, count, 'mix');
      plan.push({count, send, dry}); parts.push(u32(2, count), send, dry);
    }
    parts.push(u32(3));
    const records = await harness(`kernel-${n}`, parts);
    rustSetup(c.block);
    const base = x.galaxy_mixer_buses();
    plan.forEach((p, i) => {
      mem().set(p.dry, base + 0x1040); mem().set(p.send, base + 3 * 0x1040);
      x.galaxy_reverb_kernel(p.count);
      const ctx = x.galaxy_reverb_ctx();
      const got = Buffer.concat([Buffer.from(mem().subarray(base + 0x1040, base + 0x1040 + 8 * p.count)), Buffer.from(mem().subarray(ctx, ctx + HEADER))]);
      calls++; framesRun += p.count;
      if (!Buffer.compare(got, records[1 + i].payload)) equalCalls++;
      else if (failures < 10) {
        let at = 0; while (got[at] === records[1 + i].payload[at]) at++;
        fail(`kernel ${c.label} call ${i} (${p.count} frames): byte ${at} (${at < 8 * p.count ? `dry frame ${at >> 3}` : `ctx +0x${(at - 8 * p.count).toString(16)}`})`);
      }
    });
    const ctx = x.galaxy_reverb_ctx();
    dumps++;
    if (!Buffer.compare(Buffer.from(mem().subarray(ctx, ctx + CTX)), records.at(-1).payload)) equalDumps++;
    else fail(`kernel ${c.label}: the whole context after the calls differs`);
  }
  results.kernel = {contexts: contexts.length, calls, frames: framesRun, equalCalls, dumps, equalDumps};
  console.log(`kernel (host SSE, MXCSR 0x1f80): ${equalCalls}/${calls} calls (${framesRun} frames, the delay lines wrapping) equal in dry output and ` +
    `context header, ${equalDumps}/${dumps} whole contexts (0x60188 bytes, the delay lines) equal`);
}

await writeFile(path.join(CACHE, 'results.json'), JSON.stringify(results, null, 1));
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('Galaxy reverb: all checks passed');
