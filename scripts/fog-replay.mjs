// Replays the fog kernel calls a Play session made (scripts/fog-capture-play.mjs) through the Rust loop in Node and compares each answer's hash
// and final early-out flag with the one the session recorded (from the loop at the capture's commit), then times the loop.
//
//   node scripts/fog-replay.mjs CAPTURE.json [CAPTURE2.json ...] [--path reference|blocks] [--bench [--reps 5]] [--compare]
//     --path: which kernel path answers (fog.setPath; default blocks)
//     --compare: also run the reference path on every call and compare the two byte for byte (the answer, the flag, the texels' bytes)
//     --bench: ms per replay of all distinct calls, the reference path against the chosen one, interleaved, medians of --reps
import {readFileSync} from 'node:fs';
import {loadScriptVmKernel} from '../src/runtime/script-vm-kernel.mjs';
import {squareRootTable} from '../src/runtime/dynamic-lighting.mjs';
import {hashTexels} from './fog-replay-lib.mjs';

const args = process.argv.slice(2);
const files = args.filter((a, i) => !a.startsWith('--') && !['--path', '--reps'].includes(args[i - 1]));
const option = (n, f) => { const i = args.indexOf(`--${n}`); return i < 0 ? f : args[i + 1]; };
const flag = n => args.includes(`--${n}`);
if (!files.length) throw new Error('usage: fog-replay.mjs CAPTURE.json ... [--path reference|blocks] [--compare] [--bench]');
const kernel = await loadScriptVmKernel(), fog = kernel.fog;
fog.sqrt(squareRootTable());
const bytes = text => { const b = Buffer.from(text, 'base64'); return {u32: new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), u8: new Uint8Array(b)}; };
const setPath = name => { if (fog.setPath) fog.setPath(name); else if (name !== 'reference') throw new Error('this kernel has no block path'); };
const wanted = option('path', null);

let loaded = null;
function run(capture, call, path) {
  const pack = capture.packs[call.pack];
  if (loaded !== pack) { fog.lights(pack.words32); fog.tables(pack.tables8); loaded = pack; }
  fog.grid(Uint32Array.from(call.grid));
  fog.setMiss(call.missIn);
  setPath(path);
  const texels = fog.map(call.width, call.height, pack.count);
  return {texels, miss: fog.miss()};
}

let failures = 0, calls = 0, repeated = 0, texelLights = 0;
const captures = files.map(file => {
  const capture = JSON.parse(readFileSync(file, 'utf8'));
  for (const pack of capture.packs) { pack.words32 = bytes(pack.words).u32; pack.tables8 = bytes(pack.tables).u8; }
  return capture;
});
for (const [k, capture] of captures.entries()) {
  let bad = 0;
  for (const call of capture.calls) {
    const got = run(capture, call, wanted ?? 'blocks'), pack = capture.packs[call.pack];
    const hash = hashTexels(got.texels), same = hash === call.hash && got.miss === call.missOut;
    let compared = true;
    if (flag('compare') && wanted !== 'reference') {
      const reference = run(capture, call, 'reference');
      compared = Buffer.from(reference.texels).equals(Buffer.from(got.texels)) && reference.miss === got.miss;
    }
    if (!same || !compared) { bad++; if (bad <= 3) console.log(`  FAIL ${files[k]} call place ${call.place} ${call.width}x${call.height} x${pack.count}: recorded ${same ? 'equal' : 'DIFFERS'}, reference ${compared ? 'equal' : 'DIFFERS'}`); }
    calls++; repeated += call.n; texelLights += call.width * call.height * pack.count * call.n;
  }
  failures += bad;
  console.log(`${files[k]} (${capture.map}, ${capture.engine}): ${capture.calls.length} distinct calls, ${capture.calls.reduce((n, c) => n + c.n, 0)} total: ${bad ? bad + ' DIFFER' : 'all equal'} the recorded hash and flag${flag('compare') ? ' and the reference path' : ''}`);
}
if (fog.blockStat) console.log('block path (compare run included): surfaces', fog.blockStat(0), 'declined', fog.blockStat(1), 'blocks to the scalar body', fog.blockStat(2), 'of', fog.blockStat(3), '; reruns', fog.reruns(), 'fallbacks', fog.fallbacks());
console.log(`${calls} distinct calls (${repeated} with repeats, ${texelLights} texel-lights): ${failures ? failures + ' FAILED' : 'identical'}`);

if (flag('bench')) {
  const reps = Number(option('reps', 5)), time = (path) => {
    const t = performance.now();
    for (const capture of captures) for (const call of capture.calls) run(capture, call, path);
    return performance.now() - t;
  };
  const arms = {reference: [], [wanted ?? 'blocks']: []};
  for (const path of Object.keys(arms)) time(path);
  for (let r = 0; r < reps; r++) for (const path of Object.keys(arms)) arms[path].push(time(path));
  const median = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
  for (const [path, v] of Object.entries(arms)) console.log(`${path}: median ${median(v).toFixed(1)} ms per replay of ${calls} distinct calls (runs ${v.map(x => x.toFixed(0)).join(' ')})`);
}
process.exit(failures ? 1 : 0);
