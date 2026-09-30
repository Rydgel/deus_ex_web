/** The Rust walking loop (native/script-vm/src/walk_loop.rs, host
 * walk-loop-kernel.mjs, docs/rust-core.md B5) against its JavaScript
 * reference on the branches the maps alone do not reach.
 *
 * validate-walk-loop-kernel runs the maps as they are; in 300 ticks their
 * pawns stand or patrol on flat ground, so stepUp, HitWall, the sloped-wall
 * re-probe, the bCanJump=false retreat and the fall transitions never run.
 * This validator runs both maps with the walk-branches scenario
 * (scripts/scenarios/walk-branches.mjs): every walking map pawn is pushed
 * along a rotating heading into walls, steps, other pawns and off ledges,
 * with jumping forbidden on a third of the phases and the sloped-wall flag
 * raised periodically. The inputs are the same on both paths, so the
 * digests must agree at every checkpoint and the boundaries reached (a
 * retreat's FarMoveActor reaches the EncroachingOn return-value event,
 * which the runtime cannot dispatch from native code yet) must be the same
 * ones with the same counts; no walking call may be handed back; and the
 * counted branches must include those the scenario exists for. The counts
 * are printed; a zero names a branch still covered only by the reference's
 * own oracles (validate-native-walking and its family). */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'walk-loop-branches-'));
const ARGS = ['--bypass', '--continue', '--render-feedback', '--warm', '30', '--ticks', '300', '--digest-every', '25',
  '--scenario', 'scripts/scenarios/walk-branches.mjs'];
// The branches the scenario is built to reach: on every map, and on at
// least one (a retreat on Island ends in the EncroachingOn boundary).
const REQUIRED = ['moves', 'stepUps', 'hitWalls', 'slopeProbes', 'nudges'];
const REQUIRED_ANY = ['retreats', 'farMoves', 'mayFalls', 'fallingEvents', 'physicsSets'];
const reached = new Set();
function run(map, tag, env) {
  const out = join(dir, `${map}-${tag}.json`);
  const child = spawnSync(process.execPath, ['scripts/bench-sim.mjs', '--map', map, ...ARGS, '--json', out],
    {env: {...process.env, ...env}, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 << 20});
  assert.equal(child.status, 0, `${map} ${tag}: bench-sim exited ${child.status}\n${child.stderr?.slice(-2000)}`);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  const line = child.stderr.split('\n').find(l => l.startsWith('walk loop differential:'));
  return {report, differential: line ? JSON.parse(line.slice(line.indexOf('{'))) : null};
}
try {
  for (const map of ['00_Training', '01_NYC_UNATCOIsland']) {
    const rust = run(map, 'rust', {WALK_LOOP_DIFFERENTIAL: '1'});
    const js = run(map, 'js', {WALK_LOOP_KERNEL: 'js'});
    assert.deepEqual(rust.report.errors ?? {}, js.report.errors ?? {}, `${map}: the boundaries reached differ`);
    assert.equal(rust.report.digest, js.report.digest, `${map}: final digest`);
    assert.deepEqual(rust.report.digests, js.report.digests, `${map}: checkpoint digests`);
    const d = rust.differential;
    assert(d, `${map}: no differential summary`);
    assert(d.calls > 0, `${map}: the kernel completed no walking call`);
    assert.equal(d.handedBack, 0, `${map}: hand-backs`);
    assert.equal(d.handedBackMoves, 0, `${map}: MoveActor bodies handed back inside the loop`);
    for (const key of Object.keys(d.declinedBy ?? {}))
      assert(/ JCDentonMale\d+$/.test(key), `${map}: a declined call that is not the controlled player's: ${key}`);
    for (const key of REQUIRED) assert(d[key] > 0, `${map}: the scenario did not reach ${key}`);
    for (const key of REQUIRED_ANY) if (d[key] > 0) reached.add(key);
    const {calls, handedBack, declined, declinedBy, prelude, ...branches} = d;
    const unreached = Object.keys(branches).filter(key => branches[key] === 0);
    console.log(`${map}: ${calls} Rust walking calls, ${declined} declined (player), ` +
      `digest ${rust.report.digest} on both paths, ${rust.report.digests.length} checkpoints\n` +
      `  branches: ${JSON.stringify(branches)}\n  not reached: ${unreached.join(', ') || 'none'}\n` +
      `  boundaries on both paths: ${JSON.stringify(rust.report.errors ?? {})}`);
  }
  for (const key of REQUIRED_ANY) assert(reached.has(key), `no map reached ${key}`);
} finally {
  rmSync(dir, {recursive: true, force: true});
}
