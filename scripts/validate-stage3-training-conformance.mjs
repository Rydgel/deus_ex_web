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
 *      (script-spawn.mjs) and none throws; DestroyActor requests are accepted
 *      on the general route with none throwing; ULevel::CleanupDestroyed runs
 *      in the level tick; no actor leaves Level.Actors without an accepted
 *      DestroyActor; a DynamicLoadObject resource loads through the shared
 *      graph's StaticLoadObject;
 *   5. host substitutes — every native that ends in a Play host callback is
 *      classified (allowed out-of-Stage-3 no-op, or a recovered body on host
 *      state), no scripted function body is replaced by a host handler, and
 *      the declared structural substitutes (DECLARED_SUBSTITUTES) are gone.
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
const UNPROBED = Object.freeze([]);

// Criterion 5: every native whose call ends in a Play host callback (the
// runtime `native` callback chain) must be classified. `allowed` natives are
// the named out-of-Stage-3 no-ops; `recovered` ones run a translated original
// body on host-owned state (the evidence is named); anything else, including
// an unlisted native, is a substitute that keeps the gate open.
const HOST_NATIVES = Object.freeze({
  264: {allowed: 4, reason: 'PlaySound: recorded audio, channel 0 (criterion 2 / Stage 4)'},
  265: {allowed: 4, reason: 'StopSound: recorded audio (Stage 4)'},
  713: {allowed: 5, reason: 'AISendEvent: UEventManager propagation (Stage 5 perception)'},
  714: {allowed: 5, reason: 'AIStartEvent: UEventManager propagation (Stage 5 perception)'},
  715: {allowed: 5, reason: 'AIEndEvent: UEventManager propagation (Stage 5 perception)'},
  716: {allowed: 5, reason: 'AIClearEvent: UEventManager propagation (Stage 5 perception)'},
  0: {allowed: 6, name: 'engine.playerpawn.clienttravel', reason: 'ClientTravel: map travel (Stage 6)'},
  3011: {allowed: 6, reason: 'SaveGame: saved games (Stage 6)'},
  283: {recovered: 'SetCollisionSize on map identities: script-actor-collision.mjs setActorCollisionSize'},
  301: {recovered: 'FinishInterpolation: execFinishInterpolation latent 302 polled on the mover bInterpolating mirror (mover-interpolation.mjs)'},
  544: {recovered: 'ResetKeyboard 0x103b96d0 -> ResetConfig(InputExt) (script-input-console.mjs)'},
  720: {recovered: 'GetPlayerPawn: native 720 XLevel->Engine->Client->Viewports pointer walk (script-triggers.mjs)'},
  724: {recovered: 'GetBoundingBox on movers: mover-finish bounds (docs/mover-finish.md); other receivers throw'},
  1052: {recovered: 'InitRootWindow 0x10037df0 -> ConstructRootWindow 0x10037e70 (script-window-host.mjs)'},
  1100: {recovered: 'FlagBase.SetBool: XFlagBase bool slice (script-triggers.mjs createFlagBase)'},
  1110: {recovered: 'FlagBase.GetBool: XFlagBase bool slice (script-triggers.mjs createFlagBase)'},
  1120: {recovered: 'FlagBase.CheckFlag 0x100247d0 (script-triggers.mjs createFlagBase)'},
  1121: {recovered: 'FlagBase.DeleteFlag: exact Name/EFlagType lookup, deleting destructor on match (exec 0x10025b40 -> 0x10024860; script-triggers.mjs createFlagBase)'},
  1124: {recovered: 'FlagBase.DeleteExpiredFlags: signed mission expiration <= criteria; zero never expires (exec 0x10025d40 -> 0x10024ac0; script-triggers.mjs createFlagBase)'},
  1125: {recovered: 'FlagBase.SetDefaultExpiration: XFlagBase bool slice (script-triggers.mjs createFlagBase)'},
  3010: {recovered: 'CreateLogObject (script-player-log.mjs)'},
  3002: {recovered: 'CreateHistoryObject exec 0x10014640, original UObject/ConHistory constructor chain (script-conplay-live.mjs; docs/script-instructor-conversation.md)'},
  3003: {recovered: 'CreateHistoryEvent exec 0x100146d0, original UObject/ConHistoryEvent constructor chain (script-conplay-live.mjs; docs/script-instructor-conversation.md)'},
  3015: {recovered: 'CreateDumpLocationObject (script-player-dump.mjs)'},
  3039: {recovered: 'DumpLocation.HasLocationBeenSaved (script-player-dump.mjs)'},
  262: {recovered: 'SetCollision on map actors: execSetCollision 0x103e1900 -> AActor::SetCollision 0x10369200 on the native +0x1dc word (script-actor-collision.mjs setActorCollision); no other receiver representation'},
  3970: {recovered: 'SetPhysics on movers: PHYS_MovingBrush while already moving-brush returns at AActor::setPhysics 0x103c9620 (equal Physics); every other attached actor runs the recovered body in script-runtime.mjs'},
});
// Scripted functions whose original body a Play host replaces
// (runtime.boundaryFunctions). None is allowed in single-player Training.
const HOST_FUNCTION_REASONS = Object.freeze({
});
// Host structures the call instrumentation cannot see. Each is a substitute
// until Play runs the original route instead.
const DECLARED_SUBSTITUTES = Object.freeze([
  'Player tick: the viewer movement port plus UpdateInHand stand in for APlayerPawn::Tick -> PlayerTick/PlayerInput/PlayerMove (game.mjs tick, player.mjs)',
  'Frob target: the host highlight trace writes FrobTarget/FrobTime instead of DeusExPlayer.HighlightCenterObject (game.mjs tickWalkingInteraction)',
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
  const lifecycle = data.lifecycle ?? {destroys: [], cleanups: {calls: 0}, loads: [], hostRemovals: []};
  // 4. Lifecycle generality on the general routes Training instantiates.
  {
    const failures = [];
    for (const entry of spawns.filter(entry => entry.failed))
      failures.push(`SpawnActor ${entry.key} threw ${entry.failed}x (first ${entry.first})`);
    if (!lifecycle.destroys.some(entry => entry.accepted)) failures.push('no DestroyActor request was accepted');
    for (const entry of lifecycle.destroys.filter(entry => entry.failed))
      failures.push(`DestroyActor ${entry.key} threw ${entry.failed}x (first ${entry.first}): ${entry.error}`);
    if (!lifecycle.cleanups.calls) failures.push('ULevel::CleanupDestroyed never ran in the level tick');
    if (lifecycle.cleanups.failed) failures.push(`CleanupDestroyed threw ${lifecycle.cleanups.failed}x: ${lifecycle.cleanups.error}`);
    for (const removal of lifecycle.hostRemovals)
      failures.push(`${removal.actor} left Level.Actors without an accepted DestroyActor (${removal.probe})`);
    if (!lifecycle.loads.some(entry => entry.key.includes('StaticLoadObject') && !entry.failed))
      failures.push('no DynamicLoadObject resource loaded through the shared graph StaticLoadObject');
    for (const entry of lifecycle.loads.filter(entry => entry.failed))
      failures.push(`DynamicLoadObject ${entry.key} threw ${entry.failed}x: ${entry.error}`);
    criteria.push({id: 4, name: 'lifecycle', failures});
  }
  // 5. Host substitutes.
  const host = data.host ?? {natives: [], functions: []};
  {
    const failures = [];
    for (const entry of host.natives) {
      const rule = HOST_NATIVES[entry.index];
      const where = `${entry.index} ${entry.name ?? '?'} x${entry.calls} (first ${entry.first}; ${entry.callers.slice(0, 2).join(', ')})`;
      if (!rule || (rule.name && rule.name !== entry.name)) failures.push(`unclassified host native ${where}`);
      else if (rule.substitute) failures.push(`host native ${where}: ${rule.substitute}`);
    }
    for (const entry of host.functions)
      failures.push(`host function ${entry.key} x${entry.calls} (first ${entry.first}): ${HOST_FUNCTION_REASONS[entry.key] ?? 'unclassified replacement of the original body'}`);
    for (const text of DECLARED_SUBSTITUTES) failures.push(`declared: ${text}`);
    criteria.push({id: 5, name: 'substitutes', failures});
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
  console.log(`\nDestroyActor (general route): ${lifecycle.destroys.length} classes, ` +
    `${lifecycle.destroys.reduce((sum, entry) => sum + entry.accepted, 0)} accepted, ` +
    `${lifecycle.destroys.reduce((sum, entry) => sum + entry.refused, 0)} refused by original gates; ` +
    `CleanupDestroyed ${lifecycle.cleanups.calls} passes, ${lifecycle.cleanups.compacted} slots compacted, ` +
    `${lifecycle.cleanups.finalized} finalized (the 128-pending finalization is covered by validate-script-cleanup)`);
  for (const entry of lifecycle.loads) console.log(`    DynamicLoadObject ${entry.key} -> ${entry.loaded} x${entry.calls}`);
  const allowedHost = host.natives.filter(entry => HOST_NATIVES[entry.index]?.allowed || HOST_NATIVES[entry.index]?.recovered);
  console.log(`\nHost-routed natives: ${host.natives.length} distinct; ${allowedHost.length} allowed or recovered on host state`);
  for (const entry of allowedHost) {
    const rule = HOST_NATIVES[entry.index];
    console.log(`    ${String(entry.index).padStart(5)} ${entry.name ?? '?'}: ${rule.allowed ? `stage ${rule.allowed} — ${rule.reason}` : rule.recovered}`);
  }
  console.log(`\nNatives reached through invokeNative: ${nonPrimitive.length} distinct, ${unsupported.length} unsupported` +
    ' (VM primitive-switch natives are not counted)');
  for (const entry of unsupported.sort((a, b) => b.probes - a.probes))
    console.log(`    ${String(entry.index).padStart(5)} ${entry.name ?? '?'}  probes=${entry.probes} first ${entry.first}`);
  console.log(`\n${pass ? 'PASS' : 'OPEN'}: Stage 3 Training gate. Wrote ${path.relative(root, out)}`);
  if (!pass && !argv.includes('--report')) process.exit(1);
}
