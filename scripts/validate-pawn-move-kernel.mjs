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
 * stage 1e-6). The native movement oracles (validate-native-move,
 * -player-move, -walking, -walking-callbacks, -steps, -set-rotation-riders,
 * -far-move-scene) exercise the same path through the pawn view. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pawn-move-kernel-'));
const ARGS = ['--bypass', '--continue', '--render-feedback', '--warm', '60', '--ticks', '120', '--digest-every', '10'];
function run(map, tag, env) {
  const out = join(dir, `${map}-${tag}.json`);
  const stderr = execFileSync(process.execPath, ['scripts/bench-sim.mjs', '--map', map, ...ARGS, '--json', out],
    {env: {...process.env, ...env}, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 << 20});
  const report = JSON.parse(readFileSync(out, 'utf8'));
  const line = stderr.split('\n').find(l => l.startsWith('pawn move differential:'));
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
} finally {
  rmSync(dir, {recursive: true, force: true});
}
