/** A falling or projectile non-Pawn's AActor::performPhysics in Rust
 * (native/script-vm/src/fall.rs, host actor-physics-kernel.mjs,
 * docs/rust-core.md B6c) against its JavaScript reference
 * (actor-physics.mjs `performActorPhysics`, script-actor-physics.mjs
 * `runSpawnedActorFalling` and `runActorProjectile`, falling.mjs `falling`,
 * projectile.mjs `projectile`), `ACTOR_PHYSICS=js`.
 *
 * Each run is made twice with the same inputs, on both paths at once: Island
 * as it plays (its crates float in WaterZone1), and both maps with
 * scripts/scenarios/fall-branches.mjs (every movable Decoration and
 * Inventory launched into PHYS_Falling: walls, corners, floors, bounces,
 * bobbing, spinning), once more at 20 ticks a second, where the apex
 * subdivision is reachable. The digests must agree at every checkpoint and
 * the boundaries reached must be the same; the host may decline only
 * FellOutOfWorld's zone 0; and the Rust-side counts must include every
 * integration and blocked-move branch. The counts are printed. This checks
 * the transcription against the reference; the reference's own evidence is
 * validate-native-falling and the landing oracles. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'actor-physics-kernel-'));
const ARGS = ['--bypass', '--continue', '--render-feedback', '--warm', '30', '--digest-every', '25'];
const SCENARIO = 'scripts/scenarios/fall-branches.mjs';
const PROJECTILES = 'scripts/scenarios/projectile-branches.mjs';
const RUNS = [
  {map: '01_NYC_UNATCOIsland', name: 'as played', args: ['--ticks', '300']},
  {map: '01_NYC_UNATCOIsland', name: 'fall-branches', args: ['--ticks', '300', '--scenario', SCENARIO]},
  {map: '00_Training', name: 'fall-branches', args: ['--ticks', '300', '--scenario', SCENARIO]},
  {map: '01_NYC_UNATCOIsland', name: 'fall-branches at 20 Hz', args: ['--ticks', '200', '--dt', '0.05', '--scenario', SCENARIO]},
  // PHYS_Projectile (fall.rs perform_projectile): decorations, items and spawned Tracers, Rockets and LAMs launched at walls, floors
  // and water, past MaxSpeed, bouncing, and handed to physFalling; and the Dockyard's poison gas, as played (it flies through water).
  {map: '01_NYC_UNATCOIsland', name: 'projectile-branches', args: ['--ticks', '300', '--scenario', PROJECTILES]},
  {map: '09_NYC_Dockyard', name: 'poison gas as played', args: ['--ticks', '300']},
];
// actor-physics-kernel.mjs RUST_COUNTS.
const REQUIRED = ['water', 'bobbing', 'apex', 'blocked', 'bounces', 'landings', 'walls', 'slides', 'twoWalls', 'terminal', 'tails',
  'projectiles', 'projectileHits', 'projectileFalls', 'projectileClamps', 'projectileBounces', 'projectileWater'];
// FellOutOfWorld stays the reference's.
const DECLINES = new Set(['zone 0']);
const totals = {};
function run(map, args, tag, env) {
  const out = join(dir, `${tag}.json`);
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['scripts/bench-sim.mjs', '--map', map, ...ARGS, ...args, '--json', out],
      {env: {...process.env, ...env}, stdio: ['ignore', 'ignore', 'pipe']});
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 1 << 20) stderr = stderr.slice(-(1 << 19)); });
    child.on('error', fail);
    child.on('close', status => {
      if (status !== 0) { fail(new Error(`${tag}: bench-sim exited ${status}\n${stderr.slice(-2000)}`)); return; }
      const report = JSON.parse(readFileSync(out, 'utf8'));
      const line = stderr.split('\n').find(l => l.startsWith('actor physics kernel:'));
      done({report, stats: line ? JSON.parse(line.slice(line.indexOf('{'))) : null});
    });
  });
}
try {
  for (const [i, {map, name, args}] of RUNS.entries()) {
    const [rust, js] = await Promise.all([
      run(map, args, `${i}-rust`, {ACTOR_PHYSICS_STATS: '1'}),
      run(map, args, `${i}-js`, {ACTOR_PHYSICS: 'js'}),
    ]);
    const label = `${map} ${name}`;
    assert.deepEqual(rust.report.errors ?? {}, js.report.errors ?? {}, `${label}: the boundaries reached differ`);
    assert.equal(rust.report.digest, js.report.digest, `${label}: final digest`);
    assert.deepEqual(rust.report.digests, js.report.digests, `${label}: checkpoint digests`);
    const s = rust.stats;
    assert(s?.rust, `${label}: no actor physics summary`);
    assert(s.rust.calls > 0, `${label}: no call ran in Rust`);
    for (const why of Object.keys(s.declined)) assert(DECLINES.has(why), `${label}: declined for ${why}`);
    for (const [key, value] of Object.entries(s.rust)) totals[key] = (totals[key] ?? 0) + value;
    console.log(`${label}: ${s.rust.calls} calls in Rust, digest ${rust.report.digest} on both paths ` +
      `(${rust.report.digests.length} checkpoints); declined ${JSON.stringify(s.declined)}\n  Rust counts: ${JSON.stringify(s.rust)}` +
      `\n  boundaries on both paths: ${JSON.stringify(rust.report.errors ?? {})}`);
  }
  for (const key of REQUIRED) assert(totals[key] > 0, `no run reached ${key}`);
  const unreached = Object.keys(totals).filter(key => totals[key] === 0);
  console.log(`actor physics kernel: digests equal on every run; not reached: ${unreached.join(', ') || 'none'}`);
} finally {
  rmSync(dir, {recursive: true, force: true});
}
