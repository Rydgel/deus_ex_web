#!/usr/bin/env node
/** Galaxy's output in the running original against Play's constants (Stage 4
 * gate row 4.3.7, check 2 `galaxy-output-poll`, docs/audio-output-scope.md
 * §5.1, §6): the stored poll of 00_Training (scripts/galaxy-output-capture.sh:
 * `dx-live-win.exe galaxy poll`, read only, at the first frame and again after
 * a map load from the console), and Play's output open as the worklet makes
 * it (galaxy_host_open with MUSIC_PAN_PC, galaxy_output_open with the
 * installed Latency, WRITE_LEAD). It fails when any of these differs:
 *
 *  - D = (B − A) mod size: one value in every sample of both polls (the
 *    output is opened once per session: SetViewport keeps it at a map load,
 *    and the two polls must be of two levels), equal to 7,056 + WRITE_LEAD;
 *  - the output path (DirectSound, 1), WAVEFORMATEX (PCM, 2 ch, 44,100 Hz,
 *    16-bit), the format bits, the open flag, the kernel mode (the SSE row),
 *    MMX/SSE/3DNow, the output rate, the latency, the effect slots: Play's;
 *  - the 3D type 0 and the subsystem's 3D voices (+0x74) 0: the exclusion of
 *    hardware 3D voices;
 *  - the pan table at [0x10698390]: one of the three precision variants word
 *    for word, and that variant is MUSIC_PAN_PC (Play's table equals it too);
 *  - the MXCSR of the game's other threads (the winmm timer thread among
 *    them): control bits 0x1f80, the SSE kernel's assumption.
 * Reported, not compared (host timing, scope §7 item 6): the bytes each
 * callback rendered (R, A's increments), the callback intervals, `ahead`.
 *
 *   node scripts/validate-galaxy-output-poll.mjs [--store .work/audio-output]
 */
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const store = argv.includes('--store') ? argv[argv.indexOf('--store') + 1] : '.work/audio-output';
const LATENCY_BYTES = 7056;
const {WRITE_LEAD} = await import('../src/viewer/galaxy-music-worklet.mjs');
const {MUSIC_PAN_PC} = await import('../src/viewer/galaxy-music-output.mjs');

const polls = ['training-load1', 'training-load2'];
// The store lives outside Git (the main checkout's .work): a checkout without it skips (the sweep's SKIP line).
const missing = polls.flatMap(name => ['json', 'pan.bin', 'poll.txt'].map(ext => `${name}.${ext}`)).filter(f => !existsSync(path.join(store, f)));
if (missing.length) {
  console.log(`SKIP validate-galaxy-output-poll: ${store} lacks ${missing.join(', ')} (run scripts/galaxy-output-capture.sh with the CrossOver bottle free)`);
  process.exit(0);
}

// Play's output open, as the worklet makes it.
const {instance} = await WebAssembly.instantiate(await readFile('src/runtime/galaxy-kernel.wasm'));
const x = instance.exports;
assert.equal(x.galaxy_host_open(16, MUSIC_PAN_PC, 176400 - 882 * 4), 0, 'the host open');
x.galaxy_output_open(40);
const play = {kernelMode: x.galaxy_output_state(7), formatBits: x.galaxy_output_state(8), latency: x.galaxy_output_state(9),
  rate: x.galaxy_output_state(10), avgBytes: x.galaxy_output_state(11), alignWord: x.galaxy_output_state(12) >>> 0,
  open: x.galaxy_output_state(13), effectSlots: x.galaxy_output_state(14), size: x.galaxy_output_state(0)};
const tableOf = pc => Buffer.from(new Uint8Array(x.memory.buffer, x.galaxy_pan_table_ptr(pc), 0x10000));
const variants = Object.fromEntries([24, 53, 64].map(pc => [pc, tableOf(pc)]));

const levels = new Set(), Ds = new Set(), report = [];
for (const name of polls) {
  const info = JSON.parse(await readFile(path.join(store, `${name}.json`), 'utf8'));
  const rows = (await readFile(path.join(store, `${name}.poll.txt`), 'utf8')).trim().split('\n').map(l => l.split(' ').map(Number));
  const at = what => `${name}: ${what}`;
  assert.equal(info.galaxyBase, '0x10600000', at('Galaxy.dll at its preferred base'));
  // WAVEFORMATEX {wFormatTag 1, nChannels 2, nSamplesPerSec 44100, nAvgBytesPerSec 176400, nBlockAlign 4, wBitsPerSample 16, cbSize 0}.
  const wfx = Buffer.from(info.waveFormat, 'hex');
  assert.deepEqual([wfx.readUInt16LE(0), wfx.readUInt16LE(2), wfx.readUInt32LE(4), wfx.readUInt32LE(8), wfx.readUInt32LE(12)],
    [1, 2, play.rate, play.avgBytes, play.alignWord], at('WAVEFORMATEX'));
  assert.equal(info.path, 1, at('the DirectSound path (0x10698178 = 1)'));
  assert.equal(info.open, play.open, at('the open flag'));
  assert.equal(info.formatBits, play.formatBits, at('the output format bits'));
  assert.equal(info.kernelMode, play.kernelMode, at('the kernel mode (the SSE row)'));
  assert.deepEqual([info.mmx, info.sse, info.amd3dnow], [1, 1, 0], at('MMX, SSE, 3DNow as Play opens them'));
  assert.equal(info.rate, play.rate, at('the output rate'));
  assert.equal(info.latency, play.latency, at('the latency'));
  assert.equal(info.effectSlots, play.effectSlots, at('the effect slots (EffectsChannels)'));
  assert.equal(info.type3d, 0, at('no 3D hardware type'));
  assert.ok(info.subsystem, at('the live UGalaxyAudioSubsystem'));
  assert.equal(info.subsystem['+0x74'], 0, at("the subsystem's 3D voices (+0x74)"));
  assert.ok(info.player?.xlevel, at('the live player'));
  levels.add(info.player.xlevel);
  // The pan table.
  const pan = await readFile(path.join(store, `${name}.pan.bin`));
  const equal = Object.entries(variants).filter(([, t]) => t.equals(pan)).map(([pc]) => +pc);
  assert.equal(equal.length, 1, at(`the pan table is one precision variant (${equal})`));
  assert.equal(equal[0], MUSIC_PAN_PC, at(`the pan table is the PC ${equal[0]} variant; Play builds PC ${MUSIC_PAN_PC}`));
  // The threads' MXCSR (control bits; the low six are sticky exception flags).
  const others = info.threads.filter(t => t.context && !t.eips.some(([, m]) => /Render\.dll|D3DDrv\.dll|Engine\.dll|Core\.dll/.test(m)));
  assert.ok(others.length, at('threads other than the game thread'));
  for (const t of others) assert.equal(Number(t.mxcsr) & 0xffc0, 0x1f80, at(`thread ${t.tid}'s MXCSR control bits`));
  const timers = info.threads.filter(t => t.priority === 15);
  // D, R and the schedule.
  for (const r of rows) Ds.add((r[3] - r[2] + r[1]) % r[1]);
  assert.ok(rows.every(r => r[1] === play.size), at('the ring size'));
  const steps = new Map(), gaps = [];
  for (let i = 1; i < rows.length; i++) if (rows[i][2] !== rows[i - 1][2]) {
    const R = (rows[i][2] - rows[i - 1][2] + rows[i][1]) % rows[i][1];
    steps.set(R, (steps.get(R) ?? 0) + 1); gaps.push(rows[i][0]);
  }
  const intervals = gaps.slice(1).map((t, i) => (t - gaps[i]) / 1000).sort((a, b) => a - b);
  report.push(`${name}: ${rows.length} samples over ${((rows.at(-1)[0] - rows[0][0]) / 1e6).toFixed(2)} s, player ${info.player.name} ` +
    `(XLevel ${info.player.xlevel}); R per callback ${[...steps].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} bytes ×${n}`).join(', ')}; ` +
    `callback interval median ${intervals[intervals.length >> 1].toFixed(1)} ms (${intervals[0].toFixed(1)}..${intervals.at(-1).toFixed(1)}); ` +
    `pan table PC ${equal[0]}; MXCSR ${[...new Set(others.map(t => t.mxcsr))].join('/')} on ${others.length} threads ` +
    `(${timers.length} at TIME_CRITICAL), game thread control word ${info.threads.find(t => !others.includes(t))?.fpcw ?? '?'}`);
}
assert.equal(levels.size, polls.length, 'the two polls are of two levels (the map load happened)');
assert.equal(Ds.size, 1, `D is one value in every sample (${[...Ds]})`);
const [D] = Ds;
assert.equal(D, LATENCY_BYTES + WRITE_LEAD, `D ${D} = 7,056 + the write lead ${D - LATENCY_BYTES}; Play's WRITE_LEAD is ${WRITE_LEAD}`);
for (const line of report) console.log(line);
console.log(`PASS validate-galaxy-output-poll: D = ${D} bytes (write lead ${D - LATENCY_BYTES} = Play's WRITE_LEAD) in every sample of both polls ` +
  `and across the map load; DirectSound, 44,100 Hz 16-bit stereo, format bits ${play.formatBits}, SSE kernel mode 0x${play.kernelMode.toString(16)}, ` +
  `latency ${play.latency}, ${play.effectSlots} effect slots, no 3D; pan table PC ${MUSIC_PAN_PC} as Play builds it; MXCSR 0x1f80`);
