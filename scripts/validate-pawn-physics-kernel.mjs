/** A walking, swimming or flying pawn's APawn::performPhysics in Rust
 * (native/script-vm/src/pawn_phys.rs, swim.rs and fly.rs, host
 * pawn-physics-kernel.mjs, docs/rust-core.md B6a, B6b and B6d) against its
 * JavaScript reference (script-pawn-physics.mjs `runScriptPawnPhysics`,
 * flying.mjs `physFlying`, swimming.mjs `physSwimming`), `PAWN_PHYSICS=js`.
 *
 * Both maps run twice per scenario with the same inputs:
 * scripts/scenarios/fly-branches.mjs (every map pawn flies into walls,
 * floors, ceilings and corners, with DesiredRotation turning) and
 * scripts/scenarios/walk-branches.mjs (the walking loop's branches); Island
 * also with scripts/scenarios/swim-branches.mjs (its spawned fish driven
 * into the shore, the floor and the surface, buoyant and in a current).
 * The digests must agree at every checkpoint and the boundaries reached
 * must be the same; the host must decline no call; and the Rust-side
 * counts must include physicsRotation's MoveActor, every physFlying
 * branch (blocked moves, stepUp, the HitWall slide and TwoWallAdjust) and
 * physSwimming's (blocked moves, stepUp, the slide, the ZoneVelocity
 * current, the head-out damping, Swim's findWaterLine and air time, the
 * exit into PHYS_Falling with its falling tail, the kept Velocity.Z). The
 * counts are printed. This checks the transcription against the
 * reference; the reference's own evidence is validate-native-flying,
 * validate-native-swimming and the walking oracles. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pawn-physics-kernel-'));
const ARGS = ['--bypass', '--continue', '--render-feedback', '--warm', '30'];
// pawn_phys.rs PP_COUNTS (swim.rs SW_* from 9).
const COUNTS = ['rotations', 'rotationMoves', 'postTouches', 'flights', 'flightBlocked', 'flightStepUps', 'flightWalls',
  'flightSlides', 'flightTwoWalls', 'swims', 'swimHeadDamps', 'swimCurrents', 'swimBlocked', 'swimStepUps', 'swimWalls',
  'swimSlides', 'swimTwoWalls', 'swimExits', 'swimWaterLines', 'swimAir', 'swimKeepZ', 'swimToFalling', 'swimRises',
  'swimFallTails', 'swimFlyTails', 'swimWaterFallbacks'];
const REQUIRED = ['rotations', 'rotationMoves', 'flights', 'flightBlocked', 'flightStepUps', 'flightWalls', 'flightSlides', 'flightTwoWalls',
  'swims', 'swimHeadDamps', 'swimCurrents', 'swimBlocked', 'swimStepUps', 'swimWalls', 'swimSlides', 'swimExits', 'swimWaterLines',
  'swimAir', 'swimKeepZ', 'swimToFalling', 'swimFallTails'];
const totals = Object.fromEntries(COUNTS.map(key => [key, 0]));
const RUNS = [
  ...['fly-branches', 'walk-branches'].flatMap(name => ['00_Training', '01_NYC_UNATCOIsland'].map(map =>
    ({map, name, ticks: '300', every: '25'}))),
  {map: '01_NYC_UNATCOIsland', name: 'swim-branches', ticks: '600', every: '50'},
];
function run({map, name, ticks, every}, tag, env) {
  const out = join(dir, `${map}-${name}-${tag}.json`);
  const args = ['scripts/bench-sim.mjs', '--map', map, ...ARGS, '--ticks', ticks, '--digest-every', every,
    '--scenario', `scripts/scenarios/${name}.mjs`, '--json', out];
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {env: {...process.env, ...env}, stdio: ['ignore', 'ignore', 'pipe']});
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => {
      assert.equal(status, 0, `${map} ${name} ${tag}: bench-sim exited ${status}\n${stderr.slice(-2000)}`);
      const report = JSON.parse(readFileSync(out, 'utf8'));
      const line = stderr.split('\n').find(l => l.startsWith('pawn physics kernel:'));
      resolve({report, stats: line ? JSON.parse(line.slice(line.indexOf('{'))) : null});
    });
  });
}
try {
  for (const spec of RUNS) {
    const {map, name} = spec;
    const [rust, js] = await Promise.all([run(spec, 'rust', {PAWN_PHYSICS_STATS: '1'}), run(spec, 'js', {PAWN_PHYSICS: 'js'})]);
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
  for (const key of REQUIRED) assert(totals[key] > 0, `no run reached ${key}`);
  const unreached = COUNTS.filter(key => totals[key] === 0);
  console.log(`pawn physics kernel: digests equal on every map and scenario; not reached: ${unreached.join(', ') || 'none'}`);
} finally {
  rmSync(dir, {recursive: true, force: true});
}
