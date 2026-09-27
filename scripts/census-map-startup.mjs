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
 *   node scripts/census-map-startup.mjs [--jobs 3] [--only regex] [--strict]
 *        [--mem-cap MiB] [--time-limit s] [--json .cache/map-startup-census.json]
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
  const result = await runTrainingProbes({groups: ['idle'], finalIdle: true, map: flag('--map'),
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
  return new Promise(resolve => {
    const file = path.join(work, `${map}.json`);
    rmSync(file, {force: true});
    const begin = Date.now();
    const args = ['--max-old-space-size=6144', self, '--child', '--map', map, '--out', file, ...(argv.includes('--strict') ? ['--strict'] : [])];
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
const normalize = text => String(text).replace(/\b\d+(\.\d+)?\b/g, 'N').replace(/[A-Za-z_]+\d+\b/g, m => m.replace(/\d+$/, '#')).slice(0, 160);
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
  .map(entry => ({key: entry.key, maps: entry.maps.size, hits: entry.hits, examples: [...entry.maps].slice(0, 6)}));
const summary = {maps: results.length, clean: perMap.filter(m => m.clean).length,
  crashed: perMap.filter(m => /^killed|^child/.test(m.status)).length, boot: perMap.filter(m => /^BOOT/.test(m.status)).length,
  seconds: Math.round((Date.now() - started) / 1000), continue: !argv.includes('--strict')};
writeFileSync(out, JSON.stringify({summary, perMap, families: ranked}, null, 1) + '\n');
console.log(`\nMap startup census: ${summary.maps} maps, ${summary.clean} clean, ${summary.boot} boot failures, ` +
  `${summary.crashed} crashed/killed, ${summary.seconds}s${summary.continue ? ' (--continue)' : ''}`);
console.log('\nBoundary families by map count:');
for (const family of ranked.slice(0, 40)) console.log(`  ${String(family.maps).padStart(3)} maps  ${family.key}  e.g. ${family.examples.slice(0, 3).join(', ')}`);
console.log(`\nWrote ${path.relative(root, out)}`);
