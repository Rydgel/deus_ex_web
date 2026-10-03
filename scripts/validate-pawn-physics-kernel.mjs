/** A walking or flying pawn's APawn::performPhysics in Rust
 * (native/script-vm/src/pawn_phys.rs and fly.rs, host
 * pawn-physics-kernel.mjs, docs/rust-core.md B6a and B6b) against its
 * JavaScript reference (script-pawn-physics.mjs `runScriptPawnPhysics`,
 * flying.mjs `physFlying`), `PAWN_PHYSICS=js`.
 *
 * Both maps run twice per scenario with the same inputs:
 * scripts/scenarios/fly-branches.mjs (every map pawn flies into walls,
 * floors, ceilings and corners, with DesiredRotation turning) and
 * scripts/scenarios/walk-branches.mjs (the walking loop's branches). The
 * digests must agree at every checkpoint and the boundaries reached must be
 * the same; the host must decline no call; and the Rust-side counts must
 * include physicsRotation's MoveActor and every physFlying branch: blocked
 * moves, stepUp, the HitWall slide and TwoWallAdjust. The counts are
 * printed. This checks the transcription against the reference; the
 * reference's own evidence is validate-native-flying and the walking
 * oracles. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pawn-physics-kernel-'));
const ARGS = ['--bypass', '--continue', '--render-feedback', '--warm', '30', '--ticks', '300', '--digest-every', '25'];
// pawn_phys.rs PP_COUNTS.
const COUNTS = ['rotations', 'rotationMoves', 'postTouches', 'flights', 'flightBlocked', 'flightStepUps', 'flightWalls',
  'flightSlides', 'flightTwoWalls'];
const REQUIRED = ['rotations', 'rotationMoves', 'flights', 'flightBlocked', 'flightStepUps', 'flightWalls', 'flightSlides', 'flightTwoWalls'];
const totals = Object.fromEntries(COUNTS.map(key => [key, 0]));
function run(map, scenario, tag, env) {
  const out = join(dir, `${map}-${tag}.json`);
  const child = spawnSync(process.execPath, ['scripts/bench-sim.mjs', '--map', map, ...ARGS, '--scenario', scenario, '--json', out],
    {env: {...process.env, ...env}, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 << 20});
  assert.equal(child.status, 0, `${map} ${tag}: bench-sim exited ${child.status}\n${child.stderr?.slice(-2000)}`);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  const line = child.stderr.split('\n').find(l => l.startsWith('pawn physics kernel:'));
  return {report, stats: line ? JSON.parse(line.slice(line.indexOf('{'))) : null};
}
try {
  for (const scenario of ['scripts/scenarios/fly-branches.mjs', 'scripts/scenarios/walk-branches.mjs']) {
    const name = scenario.split('/').pop().replace('.mjs', '');
    for (const map of ['00_Training', '01_NYC_UNATCOIsland']) {
      const rust = run(map, scenario, `${name}-rust`, {PAWN_PHYSICS_STATS: '1'});
      const js = run(map, scenario, `${name}-js`, {PAWN_PHYSICS: 'js'});
      assert.deepEqual(rust.report.errors ?? {}, js.report.errors ?? {}, `${map} ${name}: the boundaries reached differ`);
      assert.equal(rust.report.digest, js.report.digest, `${map} ${name}: final digest`);
      assert.deepEqual(rust.report.digests, js.report.digests, `${map} ${name}: checkpoint digests`);
      const s = rust.stats;
      assert(s, `${map} ${name}: no pawn physics summary`);
      assert(s.calls > 0, `${map} ${name}: no call ran in Rust`);
      assert.deepEqual(s.declined, {}, `${map} ${name}: declined calls`);
      const counts = Object.fromEntries(COUNTS.map((key, i) => [key, s.rust[i]]));
      for (const key of COUNTS) totals[key] += counts[key];
      console.log(`${map} ${name}: ${s.calls} calls in Rust, digest ${rust.report.digest} on both paths ` +
        `(${rust.report.digests.length} checkpoints); JavaScript hand-backs: walks ${s.walks}, flight boundaries ` +
        `${s.flyBoundaries}, rotations ${s.rotations}, tails ${JSON.stringify(s.tails)}\n  Rust counts: ${JSON.stringify(counts)}` +
        `\n  boundaries on both paths: ${JSON.stringify(rust.report.errors ?? {})}`);
    }
  }
  for (const key of REQUIRED) assert(totals[key] > 0, `no run reached ${key}`);
  const unreached = COUNTS.filter(key => totals[key] === 0);
  console.log(`pawn physics kernel: digests equal on both maps and scenarios; not reached: ${unreached.join(', ') || 'none'}`);
} finally {
  rmSync(dir, {recursive: true, force: true});
}
