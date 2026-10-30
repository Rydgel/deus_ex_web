#!/usr/bin/env node
/** The level's first tick ahead of the first frame (sim-session.mjs preTick, docs/first-frames.md "Ahead of the first frame") leaves every
 * frame as it was: frame-alloc-meter.mjs runs the worker's `session.frame()` from a level's start with and without `--pre-tick` (the tick
 * made before the first frame, which is then posted `preTicked` with no dt, as the page posts it) and the per-frame hashes of everything the
 * frames post must be equal. 00_Training and 03_NYC_747 (two maps, 120 frames each from tick 0). Host measurement only. */
import {spawnSync} from 'node:child_process';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pre-tick-'));
const meter = (map, extra, out) => {
  const run = spawnSync(process.execPath, ['scripts/frame-alloc-meter.mjs', '--map', map, '--frames', '120', '--warm', '0', '--out', out, ...extra],
    {encoding: 'utf8', env: {...process.env, FRAME_METER_CHILD: ''}});
  if (run.status !== 0) throw new Error(`frame-alloc-meter ${map} ${extra.join(' ')} failed:\n${run.stderr || run.stdout}`);
  return JSON.parse(readFileSync(out, 'utf8'));
};
let failed = 0;
try {
  for (const map of ['00_Training', '03_NYC_747']) {
    const plain = meter(map, [], join(dir, 'plain.json')), ahead = meter(map, ['--pre-tick'], join(dir, 'ahead.json'));
    const first = plain.hashes.findIndex((hash, index) => hash !== ahead.hashes[index]);
    if (plain.hashes.length !== 120 || first >= 0) { failed++; console.error(`${map}: frame ${first} differs with the first tick ahead of the frame`); }
    else console.log(`${map}: 120 frames identical with the first tick ahead of the first frame (${plain.digest})`);
  }
} finally { rmSync(dir, {recursive: true, force: true}); }
if (failed) process.exit(1);
console.log('pre-tick: the first tick ahead of the first frame leaves the frames unchanged');
