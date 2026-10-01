/** Report-only Stage 3 census beyond Training: every single-player map.
 *
 * Each map boots in its own child process through Play's createGame (the
 * original LoadMap startup and Login), ticks 10 s, performs a Player-start
 * reload, and ticks 10 s more (scripts/training-probe-lib.mjs, idle group).
 * The census records boot failures, script preparation failures, map actors
 * excluded from the LoadMap passes, failures Play swallows into npcFailures,
 * tick errors and the unsupported natives reached. It groups them across maps
 * so a boundary family can be closed for every map at once.
 *
 * --continue (the default here) returns the declared zero value from an
 * unsupported native so one run lists the whole frontier; values after such a
 * return are not original behavior. Pass --strict to stop at the first
 * boundary as Play does.
 *
 *   node scripts/census-map-startup.mjs [--jobs 3] [--only regex] [--strict] [--groups idle|converse]
 *        [--mem-cap MiB] [--time-limit s] [--json .cache/map-startup-census.json] [--reuse]
 *
 * Multiplayer maps (DXMP_*) are excluded: multiplayer is deferred. */
import {spawn, execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {root, runTrainingProbes} from './training-probe-lib.mjs';
import {gameDirectory} from './game-directory.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i === -1 ? fallback : argv[i + 1]; };

if (argv.includes('--child')) {
  const groups = (flag('--groups') ?? 'idle').split(',');
  const result = await runTrainingProbes({groups, finalIdle: groups.includes('idle'), map: flag('--map'),
    continueMode: !argv.includes('--strict'), log: () => {}});
  writeFileSync(flag('--out'), JSON.stringify(result));
  process.exit(0);
}

const out = path.resolve(root, flag('--json', '.cache/map-startup-census.json'));
const work = `${out}.maps`;
mkdirSync(work, {recursive: true});
const filter = flag('--only') ? new RegExp(flag('--only'), 'i') : null;
const maps = readdirSync(path.join(gameDirectory(), 'Maps')).filter(name => name.toLowerCase().endsWith('.dx'))
  .map(name => name.slice(0, -3)).filter(name => !/^DXMP_/i.test(name)).filter(name => !filter || filter.test(name)).sort();
const jobs = Number(flag('--jobs', 3)), capMiB = Number(flag('--mem-cap', 5120)), limit = Number(flag('--time-limit', 900)) * 1000;
const self = fileURLToPath(import.meta.url), started = Date.now();

function runMap(map) {
  // --reuse re-aggregates a previous run's per-map results (e.g. after a
  // classification change) instead of booting the map again.
  const saved = path.join(work, `${map}.json`);
  if (argv.includes('--reuse') && existsSync(saved))
    return Promise.resolve({map, seconds: 0, peakMiB: 0, crash: null, data: JSON.parse(readFileSync(saved, 'utf8'))});
  return new Promise(resolve => {
    const file = path.join(work, `${map}.json`);
    rmSync(file, {force: true});
    const begin = Date.now();
    const args = ['--max-old-space-size=6144', self, '--child', '--map', map, '--out', file, ...(argv.includes('--strict') ? ['--strict'] : []),
      ...(flag('--groups') ? ['--groups', flag('--groups')] : [])];
    const proc = spawn(process.execPath, args, {stdio: ['ignore', 'ignore', 'pipe']});
    let stderr = '', peak = 0, killed = null;
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    const watch = setInterval(() => {
      try {
        const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(proc.pid)], {encoding: 'utf8'})) / 1024;
        peak = Math.max(peak, rss);
        if (rss > capMiB && !killed) { killed = `memory ${Math.round(rss)} MiB`; proc.kill('SIGKILL'); }
      } catch { /* exited */ }
      if (Date.now() - begin > limit && !killed) { killed = `time ${limit / 1000}s`; proc.kill('SIGKILL'); }
    }, 500);
    proc.on('exit', code => {
      clearInterval(watch);
      const seconds = Math.round((Date.now() - begin) / 1000), peakMiB = Math.round(peak);
      let data = null;
      if (!killed && code === 0 && existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8'));
      const crash = killed ? `killed: ${killed}` : data ? null : `child exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`;
      console.log(`${map}: ${crash ?? summarize(data).status} (${seconds}s, ${peakMiB} MiB)`);
      resolve({map, seconds, peakMiB, crash, data});
    });
  });
}

function summarize(data) {
  const errors = data.records.filter(record => record.kind === 'error' || record.kind === 'swallowed');
  const natives = data.records.filter(record => record.kind === 'native');
  const excluded = data.startup?.excluded ?? [];
  const clean = !data.bootError && !errors.length && !natives.length && !excluded.length && !data.startup?.prepFailures?.length;
  return {status: data.bootError ? `BOOT ${data.bootError.slice(0, 120)}` : clean ? 'clean' :
    `${errors.length} error/swallowed, ${new Set(natives.map(n => n.index)).size} unsupported natives, ${excluded.length} excluded`,
    errors, natives, excluded, clean};
}

// Boundary families that belong to a later roadmap stage (docs/roadmap.md,
// docs/stage-3-exit-criteria.md). Everything unmatched is Stage 3 work. Each
// pattern names its evidence so a classification is reviewable, not a
// tolerance by convenience.
const LATER_STAGES = Object.freeze([
  {stage: 5, reason: 'AI navigation/latent movement natives (docs/script-pawn-nav.md unported workers)',
    test: key => /^native (504|506|508|518|523|524|525|526|708|712) /.test(key)},
  // Pawn.ReachablePathnodes (iterator 1004) walks the navigation network.
  {stage: 5, reason: 'AI navigation iterator: Pawn.ReachablePathnodes (1004)',
    test: key => /Original iterator native is not implemented: ReachablePathnodes/.test(key)},
  {stage: 5, reason: 'swimming: APawn::performPhysics PHYS_Swimming (roadmap Stage 5 movement)',
    test: key => /performPhysics Physics=Swimming\b/.test(key)},
  // physProjectile (docs/projectile.md), physPathing for PHYS_Interpolating
  // (docs/pathing.md) and the full physMovingBrush (docs/doors.md) are
  // implemented: their boundaries now count as failures.
  {stage: 4, reason: 'root-window raw background drawing (UI presentation)',
    test: key => /XRootWindow::DrawRawBackground/.test(key)},
  // ConPlay's third-person conversation: CreateConCamera (2051) and the
  // ConWindow speech font chosen from "GetCurrentRes" (roadmap Stage 4:
  // conversation screens and camera behavior).
  {stage: 4, reason: 'third-person conversation camera and ConWindow presentation',
    test: key => /native N ConSys\.Conversation\.CreateConCamera|native 2051 |UWindowsViewport::Exec GetCurrentRes/.test(key)},
  // VisibleCollidingActors (312: FCollisionHash::ActorRadiusCheck, hash
  // vtable +0x18, then IsA/bHidden/FastLineCheck per link, exec 0x103e55b0)
  // is reached only from HurtRadius-style explosion/proximity damage.
  {stage: 5, reason: 'explosion/proximity damage: VisibleCollidingActors (312) from HurtRadius',
    test: key => /Original iterator native is not implemented: VisibleCollidingActors/.test(key)},
  {stage: 6, reason: 'map travel / saved games',
    test: key => /clienttravel|native 3011 /i.test(key)},
  // A pre-placed actor's global GObjObjects index depends on the session's
  // whole load history (Entry, menus, maps reached by travel). Every
  // single-player map's pawns are measured for a fresh open from Training's
  // console (docs/object-index-captures.md); other actors and other histories
  // stay unmeasured. PlaySound's channel id (ObjectIndex<<4|slot<<1|noOverride)
  // needs it.
  {stage: 6, reason: 'session-dependent global UObject index of an unmeasured actor (pawns are captured per map)',
    test: key => /PlaySound requires the registered global UObject index/.test(key)},
]);
const stageOf = key => LATER_STAGES.find(entry => entry.test(key.replace(/^(BOOT |\[swallowed\] |CRASH )/, ''))) ?? null;

const queue = [...maps], results = [];
await Promise.all(Array.from({length: Math.min(jobs, queue.length)}, async () => {
  while (queue.length) results.push(await runMap(queue.shift()));
}));
results.sort((a, b) => a.map.localeCompare(b.map));

// Group boundaries across maps: a family closes for every map at once.
const families = new Map();
const note = (key, map, detail) => {
  const entry = families.get(key) ?? {key, maps: new Set(), hits: 0, detail};
  entry.maps.add(map); entry.hits++; families.set(key, entry);
};
// EPhysics values keep their names: the stage table tells swimming (3) and
// interpolating (8) apart from other physics modes.
const PHYSICS_NAMES = ['None', 'Walking', 'Falling', 'Swimming', 'Flying', 'Rotating', 'Projectile', 'Rolling',
  'Interpolating', 'MovingBrush', 'Spider', 'Trailer'];
// Engine Actor iterator natives (Actor.uc) keep their names as well.
const ITERATOR_NAMES = {304: 'AllActors', 305: 'ChildActors', 306: 'BasedActors', 307: 'TouchingActors',
  309: 'TraceActors', 310: 'RadiusActors', 311: 'VisibleActors', 312: 'VisibleCollidingActors', 321: 'CollidingActors',
  1004: 'ReachablePathnodes'};
const normalize = text => String(text).replace(/Physics=(\d+)\b/g, (_, n) => `Physics=${PHYSICS_NAMES[n] ?? n}`)
  .replace(/iterator native is not implemented: (\d+)/g, (_, n) => `iterator native is not implemented: ${ITERATOR_NAMES[n] ?? n}`)
  .replace(/\b\d+(\.\d+)?\b/g, 'N').replace(/[A-Za-z_]+\d+\b/g, m => m.replace(/\d+$/, '#')).slice(0, 160);
const perMap = results.map(({map, seconds, peakMiB, crash, data}) => {
  if (crash) { note(`CRASH ${normalize(crash)}`, map); return {map, seconds, peakMiB, status: crash}; }
  const s = summarize(data);
  if (data.bootError) note(`BOOT ${normalize(data.bootError)}`, map);
  for (const record of s.errors) note(`${record.kind === 'swallowed' ? '[swallowed] ' : ''}${normalize(record.message)}`, map);
  for (const record of s.natives) note(`native ${record.index} ${record.name ?? '?'} from ${record.caller ?? '?'}`, map);
  for (const label of s.excluded) note(`excluded ${label.split(':')[0]}`, map);
  for (const failure of data.startup?.prepFailures ?? []) note(`prepare ${normalize(failure.message)}`, map);
  return {map, seconds, peakMiB, status: s.status, clean: s.clean};
});
const ranked = [...families.values()].sort((a, b) => b.maps.size - a.maps.size || b.hits - a.hits)
  .map(entry => ({key: entry.key, maps: entry.maps.size, hits: entry.hits, examples: [...entry.maps].slice(0, 6),
    stage: stageOf(entry.key)?.stage ?? 3}));
// A map is Stage 3 complete when every boundary it reaches belongs to a later stage.
const stage3Open = new Set();
for (const family of families.values()) if (!stageOf(family.key)) for (const map of family.maps) stage3Open.add(map);
for (const entry of perMap) entry.stage3Complete = !stage3Open.has(entry.map);
const summary = {maps: results.length, clean: perMap.filter(m => m.clean).length,
  stage3Complete: perMap.filter(m => m.stage3Complete).length,
  crashed: perMap.filter(m => /^killed|^child/.test(m.status)).length, boot: perMap.filter(m => /^BOOT/.test(m.status)).length,
  seconds: Math.round((Date.now() - started) / 1000), continue: !argv.includes('--strict')};
writeFileSync(out, JSON.stringify({summary, perMap, families: ranked}, null, 1) + '\n');
console.log(`\nMap startup census: ${summary.maps} maps, ${summary.clean} clean, ${summary.stage3Complete} Stage 3 complete ` +
  `(only later-stage boundaries), ${summary.boot} boot failures, ${summary.crashed} crashed/killed, ${summary.seconds}s` +
  `${summary.continue ? ' (--continue)' : ''}`);
for (const stage of [3, 4, 5, 6]) {
  const list = ranked.filter(family => family.stage === stage && !family.key.startsWith('[swallowed]'));
  if (!list.length) continue;
  console.log(`\nStage ${stage}${stage === 3 ? ' (open)' : ''} boundary families by map count:`);
  for (const family of list.slice(0, 40))
    console.log(`  ${String(family.maps).padStart(3)} maps  ${family.key}  e.g. ${family.examples.slice(0, 3).join(', ')}`);
}
console.log(`\nWrote ${path.relative(root, out)}`);
