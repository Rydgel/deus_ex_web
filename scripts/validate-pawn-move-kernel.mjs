/** The Rust pawn MoveActor (native/script-vm/src/move_pawn.rs, host
 * move-pawn-kernel.mjs, docs/rust-core.md B4) against its JavaScript
 * reference on both maps' running simulations.
 *
 * Each map runs bench-sim twice with the same workload: once with the kernel
 * on and MOVE_PAWN_DIFFERENTIAL=1 (every completed Rust move's selected hit,
 * time and displacement are compared with `moveQuery` on the same hits, and
 * a mismatch throws), once with MOVE_PAWN_KERNEL=js. The two runs must end
 * with the same digest at every checkpoint and no errors, the differential
 * must have completed moves and handed none back, and every declined call
 * must be the controlled player's (its Base and Touching stay bound until
 * stage 1e-6). Two scenario pairs on Island follow: collision-bits (the
 * block test) and pawn-push-floor (the two returns that leave MoveActor's
 * Hit unwritten, with the differential's hitUntouched check). The native
 * movement oracles (validate-native-move,
 * -player-move, -walking, -walking-callbacks, -steps, -set-rotation-riders,
 * -far-move-scene) exercise the same path through the pawn view. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pawn-move-kernel-'));
const ARGS = ['--bypass', '--continue', '--render-feedback', '--warm', '60', '--ticks', '120', '--digest-every', '10'];
function run(map, tag, env, extra = []) {
  const out = join(dir, `${map}-${tag}.json`);
  const child = spawnSync(process.execPath, ['scripts/bench-sim.mjs', '--map', map, ...ARGS, ...extra, '--json', out],
    {env: {...process.env, ...env}, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 << 20});
  assert.equal(child.status, 0, `${map} ${tag}: bench-sim exited ${child.status}\n${child.stderr?.slice(-2000)}`);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  const line = child.stderr.split('\n').find(l => l.startsWith('pawn move differential:'));
  return {report, differential: line ? JSON.parse(line.slice(line.indexOf('{'))) : null};
}
try {
  for (const map of ['01_NYC_UNATCOIsland', '00_Training']) {
    const rust = run(map, 'rust', {MOVE_PAWN_DIFFERENTIAL: '1'});
    const js = run(map, 'js', {MOVE_PAWN_KERNEL: 'js'});
    assert.deepEqual(rust.report.errors ?? {}, {}, `${map}: errors with the kernel`);
    assert.deepEqual(js.report.errors ?? {}, {}, `${map}: errors without the kernel`);
    assert.equal(rust.report.digest, js.report.digest, `${map}: final digest`);
    assert.deepEqual(rust.report.digests, js.report.digests, `${map}: checkpoint digests`);
    const d = rust.differential;
    assert(d, `${map}: no differential summary`);
    assert(d.calls > 0, `${map}: the kernel completed no move`);
    assert.equal(d.handedBack, 0, `${map}: hand-backs`);
    for (const key of Object.keys(d.declinedBy ?? {}))
      assert(/ JCDentonMale\d+$/.test(key), `${map}: a declined move that is not the controlled player's: ${key}`);
    console.log(`${map}: ${d.calls} Rust moves (${d.tiny} tiny, ${d.blocked} blocked), ${d.declined} declined (player), ` +
      `digest ${rust.report.digest} on both paths, ${rust.report.digests.length} checkpoints`);
  }
  // The block test on a pawn source (Engine.dll 0x103996aa..0x1039978a: the candidate's bit is bBlockActors for a pawn, bBlockPlayers for a controlled
  // player or a Projectile): the collision-bits scenario flips the bits of the map's colliding actors among actors-only, players-only and both
  // while the pawns are pushed into them. The Rust body must select the same hits as the reference (digests and checkpoints equal); with the
  // earlier rule in Rust only (the candidate's bBlockPlayers for every source) the digest differs. The reference itself is checked against the
  // original's MoveActor under Unicorn in validate-native-move-query (760 cases).
  {
    const map = '01_NYC_UNATCOIsland', scenario = ['--scenario', 'scripts/scenarios/collision-bits.mjs'];
    const rust = run(map, 'bits-rust', {MOVE_PAWN_DIFFERENTIAL: '1'}, scenario);
    const js = run(map, 'bits-js', {MOVE_PAWN_KERNEL: 'js'}, scenario);
    assert.deepEqual(rust.report.errors ?? {}, js.report.errors ?? {}, `${map} collision bits: the boundaries reached differ`);
    assert.equal(rust.report.digest, js.report.digest, `${map} collision bits: final digest`);
    assert.deepEqual(rust.report.digests, js.report.digests, `${map} collision bits: checkpoint digests`);
    const d = rust.differential;
    assert(d && d.calls > 0 && d.blocked > 0, `${map} collision bits: the scenario reached no blocked Rust move`);
    assert.equal(d.handedBack, 0, `${map} collision bits: hand-backs`);
    console.log(`${map} (collision bits): ${d.calls} Rust moves (${d.blocked} blocked), digest ${rust.report.digest} on both paths`);
  }
  // The two returns that leave MoveActor's Hit unwritten (0x10399145 bStatic or !bMovable, 0x10399228 a sub-threshold Delta),
  // which the maps' own moves never reach in the Rust host: the pawn-push-floor scenario pushes each walking pawn straight down
  // into its floor through moveSmoothPawn (its zero slide's second MoveActor returns early and HitWall reads the first hit) and
  // moves it once with bMovable cleared. The differential holds the Rust body's hitUntouched word to the reference's conditions
  // on every completed call; that check, not the digest, is the evidence here: Island's walking pawns leave the digested state
  // as it was after HitWall (the digests are the same with moveActorHit's hitUntouched forced off). The digests must still agree.
  // The reference itself is checked against the original's moveSmooth in validate-native-mover-push (the pawn-floor scene).
  {
    const map = '01_NYC_UNATCOIsland', scenario = ['--scenario', 'scripts/scenarios/pawn-push-floor.mjs'];
    const rust = run(map, 'push-rust', {MOVE_PAWN_DIFFERENTIAL: '1'}, scenario);
    const js = run(map, 'push-js', {MOVE_PAWN_KERNEL: 'js'}, scenario);
    assert.deepEqual(rust.report.errors ?? {}, js.report.errors ?? {}, `${map} floor push: the boundaries reached differ`);
    assert.equal(rust.report.digest, js.report.digest, `${map} floor push: final digest`);
    assert.deepEqual(rust.report.digests, js.report.digests, `${map} floor push: checkpoint digests`);
    const d = rust.differential;
    assert(d && d.untouched > 0 && d.calls > d.untouched, `${map} floor push: the scenario reached no early return in Rust`);
    assert.equal(d.handedBack, 0, `${map} floor push: hand-backs`);
    console.log(`${map} (floor push): ${d.calls} Rust moves (${d.untouched} with the Hit unwritten), digest ${rust.report.digest} on both paths`);
  }
} finally {
  rmSync(dir, {recursive: true, force: true});
}
