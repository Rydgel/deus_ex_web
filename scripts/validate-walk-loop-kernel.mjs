/** The Rust walking loop (native/script-vm/src/walk_loop.rs, host
 * walk-loop-kernel.mjs, docs/rust-core.md B5) against its JavaScript
 * reference on both maps' running simulations.
 *
 * Each map runs bench-sim twice with the same workload: once with the kernel
 * on and WALK_LOOP_DIFFERENTIAL=1 (the outcome counts), once with
 * WALK_LOOP_KERNEL=js. The two runs must end with the same digest at every
 * checkpoint and no errors, the kernel must have completed walking calls and
 * handed none back, and every declined call must be the controlled player's
 * (its Base and Touching stay bound until stage 1e-6). The branch counts are
 * printed: a zero names a branch of the loop these workloads did not reach,
 * which the digests then say nothing about. The native walking oracles
 * (validate-native-walking, -walking-callbacks, -walking-surface, -steps,
 * -velocity) exercise the JavaScript reference on scripted pawns. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'walk-loop-kernel-'));
const ARGS = ['--bypass', '--continue', '--render-feedback', '--warm', '60', '--ticks', '120', '--digest-every', '10'];
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
  for (const map of ['01_NYC_UNATCOIsland', '00_Training']) {
    const rust = run(map, 'rust', {WALK_LOOP_DIFFERENTIAL: '1'});
    const js = run(map, 'js', {WALK_LOOP_KERNEL: 'js'});
    assert.deepEqual(rust.report.errors ?? {}, {}, `${map}: errors with the kernel`);
    assert.deepEqual(js.report.errors ?? {}, {}, `${map}: errors without the kernel`);
    assert.equal(rust.report.digest, js.report.digest, `${map}: final digest`);
    assert.deepEqual(rust.report.digests, js.report.digests, `${map}: checkpoint digests`);
    const d = rust.differential;
    assert(d, `${map}: no differential summary`);
    assert(d.calls > 0, `${map}: the kernel completed no walking call`);
    assert.equal(d.handedBack, 0, `${map}: hand-backs`);
    assert(d.moves > 0, `${map}: the loop entered no MoveActor body directly`);
    for (const key of Object.keys(d.declinedBy ?? {}))
      assert(/ JCDentonMale\d+$/.test(key), `${map}: a declined call that is not the controlled player's: ${key}`);
    const {calls, handedBack, declined: n, declinedBy, prelude, ...branches} = d;
    const unreached = Object.keys(branches).filter(key => branches[key] === 0);
    console.log(`${map}: ${d.calls} Rust walking calls, ${d.declined} declined (player), ` +
      `digest ${rust.report.digest} on both paths, ${rust.report.digests.length} checkpoints\n` +
      `  branches: ${JSON.stringify(branches)}\n  not reached: ${unreached.join(', ') || 'none'}`);
  }
} finally {
  rmSync(dir, {recursive: true, force: true});
}
