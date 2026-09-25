/** Stage 3 acceptance gate: Training conformance (docs/stage-3-exit-criteria.md).
 *
 * Boots 00_Training through Play's createGame, checks its LoadMap startup,
 * ticks it, drives every census interaction probe through Play's public
 * entries with a Player-start reset after each, and ticks once more after the
 * last reset. Unsupported natives throw exactly as they do in Play (no
 * --continue). It reports each exit criterion and exits nonzero while any is
 * unmet, so this validator stays red until Stage 3 is done:
 *
 *   1. startup — no script preparation failure, no map actor excluded from the
 *      LoadMap event passes, and no boundary during boot or any reset startup
 *      (including failures Play catches into npcFailures);
 *   2. tick — the two 10 s idle legs (after boot and after the last reset) end
 *      on no boundary;
 *   3. interactions — every probe completes and closes its screen, with only
 *      the explicit out-of-Stage-3 boundaries below; families not yet probed
 *      keep the criterion open;
 *   4. lifecycle — every SpawnActor request goes through the one general body
 *      (script-spawn.mjs); the run lists each class it spawned and fails on a
 *      spawn that threw. Destroy/CleanupDestroyed and resource loading are not
 *      measured yet and keep the criterion open;
 *   5. host substitutes are not measured by this run and keep the gate open.
 *
 * It also prints every non-primitive native the run reached, so the reachable
 * native tail is a measured number rather than an estimate.
 *
 *   node scripts/validate-stage3-training-conformance.mjs [--report] [--only regex]
 *        [--json .cache/stage3-training-conformance.json] [--mem-cap MiB]
 *
 * --report prints the same scoreboard and exits 0. */
import {writeFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROBE_GROUPS, root, runChildWithWatchdog, runTrainingProbes} from './training-probe-lib.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i === -1 ? fallback : argv[i + 1]; };

// Boundaries outside Stage 3 that a probe may end on. Each names its stage.
const ALLOWED = Object.freeze([
  {stage: 6, reason: 'map travel (Teleporter -> GameInfo.SendPlayer)',
    test: record => record.kind === 'native' && record.name === 'engine.playerpawn.clienttravel'},
  {stage: 6, reason: 'saved games (QuickSave)',
    test: record => record.kind === 'native' && record.index === 3011},
]);
// Authored Training interactions the probe engine does not drive yet.
const UNPROBED = Object.freeze([
  'Fire/AltFire with each Training weapon under the real tick scheduler',
]);
// Exit criteria this run does not measure.
const UNMEASURED = Object.freeze([
  {criterion: 4, text: 'lifecycle generality: DestroyActor/CleanupDestroyed and resource load on the general route (SpawnActor is measured below)'},
  {criterion: 5, text: 'no host substitutes (not audited by this run; GameInfo, the player and Player start now come from LoadMap/Login)'},
]);

if (!argv.includes('--child')) await parent();
else await child();

async function child() {
  const result = await runTrainingProbes({groups: PROBE_GROUPS, finalIdle: true, only: flag('--only')});
  writeFileSync(flag('--out'), JSON.stringify(result));
  process.exit(0);
}

async function parent() {
  const out = path.resolve(root, flag('--json', '.cache/stage3-training-conformance.json'));
  mkdirSync(path.dirname(out), {recursive: true});
  const {data, seconds, peakMiB} = await runChildWithWatchdog({
    script: fileURLToPath(import.meta.url), out: `${out}.partial`, capMiB: Number(flag('--mem-cap', 6144)),
    label: 'conformance', args: flag('--only') ? ['--only', flag('--only')] : []});
  data.meta = {...data.meta, seconds, peakMiB};
  const {records, probes, startup, reached} = data;

  const startupProbe = probe => probe === 'startup' || probe === 'reboot' || probe.startsWith('reset:');
  const allowed = record => ALLOWED.find(entry => entry.test(record));
  const describe = record => record.kind === 'native'
    ? `native ${record.index} ${record.name ?? '?'} from ${record.caller || '?'}`
    : `${record.kind === 'swallowed' ? `[swallowed by ${record.actor}] ` : ''}${record.message}`;
  const distinct = list => {
    const counts = new Map();
    for (const record of list) {
      const key = describe(record);
      const entry = counts.get(key) ?? {key, count: 0, first: record.probe};
      entry.count++; counts.set(key, entry);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  };

  const criteria = [];
  // 1. Startup.
  {
    const failures = [];
    for (const {key, message} of startup.prepFailures) failures.push(`prepare ${key}: ${message}`);
    if (startup.excluded === null) failures.push('Play does not report its LoadMap startup exclusions');
    else if (startup.excluded.length) {
      const byClass = new Map();
      for (const label of startup.excluded) { const cls = label.split(':')[0]; byClass.set(cls, (byClass.get(cls) ?? 0) + 1); }
      failures.push(`${startup.excluded.length} map actors excluded from the LoadMap event passes: ` +
        [...byClass].sort((a, b) => b[1] - a[1]).map(([cls, n]) => `${cls}=${n}`).join(' '));
    }
    for (const {key, count, first} of distinct(records.filter(record => startupProbe(record.probe))))
      failures.push(`${key} (x${count}, first ${first})`);
    criteria.push({id: 1, name: 'startup', failures});
  }
  // 2. Tick.
  {
    const idle = probes.filter(probe => probe.group === 'idle');
    const failures = [];
    if (idle.length < 2 && !flag('--only')) failures.push(`expected two idle legs, ran ${idle.length}`);
    for (const {key, count, first} of distinct(records.filter(record => record.probe.startsWith('idle:'))))
      failures.push(`${key} (x${count}, first ${first})`);
    for (const probe of idle) if (probe.error) failures.push(`${probe.label}: ${probe.error}`);
    criteria.push({id: 2, name: 'tick', failures: [...new Set(failures)]});
  }
  // 3. Interactions.
  {
    const failures = [], tolerated = [];
    const interaction = records.filter(record => !startupProbe(record.probe) && !record.probe.startsWith('idle:'));
    for (const record of interaction) if (allowed(record)) tolerated.push(record);
    for (const {key, count, first} of distinct(interaction.filter(record => !allowed(record))))
      failures.push(`${key} (x${count}, first ${first})`);
    for (const probe of probes) {
      if (probe.group === 'idle') continue;
      if (probe.stillOpen) failures.push(`${probe.group}:${probe.label} left ${probe.stillOpen} open`);
      if (probe.error && !interaction.some(record => record.probe === `${probe.group}:${probe.label}`))
        failures.push(`${probe.group}:${probe.label}: ${probe.error}`);
    }
    for (const family of UNPROBED) failures.push(`not probed: ${family}`);
    criteria.push({id: 3, name: 'interactions', failures,
      tolerated: distinct(tolerated).map(({key, count}) => `${key} (x${count}; stage ${allowed(tolerated.find(record => describe(record) === key)).stage})`)});
  }
  const spawns = data.spawns ?? [];
  for (const {criterion, text} of UNMEASURED) {
    const failures = [`not measured: ${text}`];
    if (criterion === 4) for (const entry of spawns.filter(entry => entry.failed))
      failures.push(`SpawnActor ${entry.key} threw ${entry.failed}x (first ${entry.first})`);
    criteria.push({id: criterion, name: criterion === 4 ? 'lifecycle' : 'substitutes', failures});
  }

  const nonPrimitive = reached.filter(entry => entry.index !== 0 || entry.name);
  const unsupported = nonPrimitive.filter(entry => entry.unsupported);
  const pass = criteria.every(criterion => !criterion.failures.length);
  writeFileSync(out, JSON.stringify({...data, criteria, pass}, null, 1) + '\n');

  console.log(`Stage 3 Training conformance: ${probes.length} probes, ${data.meta.boots} boots, ${seconds}s, peak ${peakMiB} MiB`);
  for (const criterion of criteria) {
    console.log(`\n[${criterion.failures.length ? 'OPEN' : 'PASS'}] ${criterion.id}. ${criterion.name}` +
      (criterion.failures.length ? ` — ${criterion.failures.length} item(s)` : ''));
    for (const failure of criterion.failures.slice(0, 25)) console.log(`    ${failure.slice(0, 220)}`);
    if (criterion.failures.length > 25) console.log(`    … ${criterion.failures.length - 25} more in ${path.relative(root, out)}`);
    for (const entry of criterion.tolerated ?? []) console.log(`    tolerated: ${entry.slice(0, 200)}`);
  }
  console.log(`\nSpawnActor (general route): ${spawns.length} classes, ` +
    `${spawns.reduce((sum, entry) => sum + entry.spawned, 0)} actors spawned, ` +
    `${spawns.reduce((sum, entry) => sum + entry.rejected, 0)} rejected by original gates, ` +
    `${spawns.reduce((sum, entry) => sum + entry.failed, 0)} threw`);
  console.log(`    ${spawns.map(entry => `${entry.key}${entry.failed ? '!' : ''}`).sort().join(' ')}`);
  console.log(`\nNatives reached through invokeNative: ${nonPrimitive.length} distinct, ${unsupported.length} unsupported` +
    ' (VM primitive-switch natives are not counted)');
  for (const entry of unsupported.sort((a, b) => b.probes - a.probes))
    console.log(`    ${String(entry.index).padStart(5)} ${entry.name ?? '?'}  probes=${entry.probes} first ${entry.first}`);
  console.log(`\n${pass ? 'PASS' : 'OPEN'}: Stage 3 Training gate. Wrote ${path.relative(root, out)}`);
  if (!pass && !argv.includes('--report')) process.exit(1);
}
