#!/usr/bin/env node
/** Stage 5 acceptance gate (docs/stage-5-exit-criteria.md): the roadmap's "Done when" for section 5 as a finite list of scenarios on Training and Liberty Island.
 *
 * The gate composes what exists; it implements no proof itself. Per criterion (scripts/stage5-criteria.mjs):
 *   - the census (scripts/census-stage5.mjs) drives the scenario in Play through the player's own inputs: plays, pause (the boundary), no-effect or undriven;
 *   - the proof checks (validators run as child processes, or rows of the Stage 4 report) say whether the result equals the original's.
 * A row is PASS only if the census plays it and every proof check passes. A row with no proof check is MISSING (`need` says what would prove it); a row whose census
 * pauses or does nothing is FAIL (the boundary is printed); one the census cannot start is UNDRIVEN; EXCLUDED rows name the stage that owns them. The gate never starts
 * DeusEx.exe: original results are read from the stores the proof checks name.
 *
 *   node scripts/validate-stage5-acceptance.mjs [--only regex] [--census file.json] [--report [file]] [--markdown [file]] [--list] [--stage4-report file.json] [--write-doc]
 *        [--jobs N] [--mem-budget MiB] [--mem-cap MiB] [--logs dir]
 *
 * --census reads a census run instead of running one (the census takes about 25 minutes); --report prints the scoreboard and exits 0, writing the JSON report to the
 * file when one follows; --markdown re-renders the criteria tables of a report (--write-doc puts them into docs/stage-5-exit-criteria.md); --list prints the rows.
 * Exit status 1 while any criterion is not PASS (EXCLUDED apart).
 *
 * --jobs N (default 1) runs the proof checks N at a time, and with N > 1 beside the census (a check of a row the census does not play still runs; only the rows it
 * plays count them). The live replays are safe side by side: each writes only its own scene's files, and the map's play-population.json is written once, by
 * validate-stage5-live.mjs --prepare per map before the pool starts (docs/stage-5-exit-criteria.md "Running"). The pool takes the longest checks first (the
 * last run's time, .cache/stage5-gate-timings.json, else the scene's ticks), never two runs of one scene at once (its replay and its --frames replay share the
 * scene's files), and bounds memory by each check's whole process tree (Chromium included, which Playwright starts in its own process group):
 * a check starts only while the pool's reservations (each check's last peak, .cache/stage5-gate-memory.json, else its map's median; PSS on Linux) and the
 * census fit under --mem-budget (default 16384 MiB, at most half the RAM; an Island replay holds about 7 GB, a Training one about 4); past the budget the
 * newest check is stopped and queued again to run with less beside it, and a check whose tree passes --mem-cap (default 20480 MiB: swm1's, 2,400 ticks,
 * passes 12 GiB) fails. Rows are reported in their order, and a validator several rows name runs once. Each check's whole output goes to
 * <dir>/<check>.log (--logs, default .work/stage5-gate-logs): two runs' logs compare scene by scene. */
import {execFileSync, spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CLAUSES, CRITERIA, injectTables, renderTables} from './stage5-criteria.mjs';
import {SCENES} from './validate-stage5-live.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : (argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[i + 1]); };
const only = flag('only') && flag('only') !== true ? new RegExp(flag('only')) : null;
const rows = CRITERIA.filter(row => !only || only.test(`${row.id} ${row.scene} ${row.claim} ${row.census ?? ''}`));

const jobs = Math.max(1, Number(flag('jobs', 1)) || 1);
const budget = Number(flag('mem-budget', Math.round(Math.min(16384, os.totalmem() / 2 / 1048576)))), cap = Number(flag('mem-cap', 20480));
const logs = path.resolve(root, typeof flag('logs') === 'string' ? flag('logs') : '.work/stage5-gate-logs');
const env = {...process.env,
  NATIVE_PROBE_PYTHON: process.env.NATIVE_PROBE_PYTHON ?? (existsSync(path.join(root, '.cache/native-probe-env/bin/python')) ? path.join(root, '.cache/native-probe-env/bin/python') : '')};

// Every child's whole process tree: `ps` pid, ppid and RSS, the descendants found by parent links (Playwright's Chromium has its own process group).
// A process's memory is its PSS on Linux (/proc/<pid>/smaps_rollup: a replay's Chromium processes share pages, and their RSS sum counts them
// each time, about a quarter more than the tree holds), its RSS elsewhere.
const tree = () => {
  const stdout = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], {encoding: 'utf8'});
  const children = new Map(), rss = new Map();
  for (const line of stdout.trim().split('\n')) {
    const [pid, ppid, kib] = line.trim().split(/\s+/).map(Number);
    rss.set(pid, kib / 1024);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const descendants = pid => [pid, ...(children.get(pid) ?? []).flatMap(descendants)];
  const pss = pid => { try { return Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))[1]) / 1024; } catch { return rss.get(pid) ?? 0; } };
  const size = pid => descendants(pid).reduce((n, p) => n + (process.platform === 'linux' ? pss(p) : rss.get(p) ?? 0), 0);
  return {descendants, size};
};
// (synchronous: the signal handler exits right after it)
const killTree = pid => {
  let pids = [pid];
  try { pids = tree().descendants(pid); } catch { /* ps failed: the root alone */ }
  for (const p of pids.reverse()) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
};

// The last run's time and memory peak of each check (the pool's order and reservations).
const timingsPath = path.join(root, '.cache/stage5-gate-timings.json'), memoryPath = path.join(root, '.cache/stage5-gate-memory.json');
const readCache = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
const timings = readCache(timingsPath), peaks = readCache(memoryPath);
const saveCaches = () => {
  mkdirSync(path.dirname(timingsPath), {recursive: true});
  writeFileSync(timingsPath, JSON.stringify(timings, null, 1) + '\n');
  writeFileSync(memoryPath, JSON.stringify(peaks, null, 1) + '\n');
};

// The pool: a check waits for a slot, for its scene's other run to end, and for room under the memory budget.
const queue = [], running = new Set();
let census = null, finished = 0, total = 0;
const reservation = job => Math.max(job.current, job.predicted);
const pump = () => {
  let reserved = [...running].reduce((n, job) => n + reservation(job), census?.current ?? 0);
  while (running.size < jobs) {
    const busy = new Set([...running].map(job => job.scene).filter(Boolean));
    const index = queue.findIndex(job => !(job.scene && busy.has(job.scene)) && (!running.size || reserved + job.predicted <= budget));
    if (index === -1) break;
    const [job] = queue.splice(index, 1);
    reserved += job.predicted;
    start(job);
  }
};
const start = job => {
  job.begin = Date.now(); job.current = 0; job.peak = 0; job.out = '';
  job.proc = spawn(job.command, job.args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env});
  running.add(job);
  job.proc.stdout.on('data', d => { job.out += d; }); job.proc.stderr.on('data', d => { job.out += d; });
  job.timer = setTimeout(() => { job.killed = `timeout ${job.limitSeconds}s`; killTree(job.proc.pid); }, job.limitSeconds * 1000);
  job.proc.on('exit', code => {
    clearTimeout(job.timer);
    running.delete(job);
    const seconds = Math.round((Date.now() - job.begin) / 1000);
    if (job.requeued) {
      // stopped for the budget: it runs again with the whole budget reserved, so with less beside it
      console.log(`[${String(finished).padStart(3)}/${total}] back ${seconds}s ${job.label} (${job.requeued})`);
      job.requeued = null; job.killed = null; job.predicted = budget;
      queue.unshift(job); pump(); return;
    }
    if (job.killed) code = code || 137;
    finished++;
    if (!job.killed) timings[job.key] = seconds;
    peaks[job.key] = Math.round(job.peak);
    saveCaches();
    mkdirSync(logs, {recursive: true});
    writeFileSync(path.join(logs, `${job.key.replace(/^validate-|\.mjs/g, '').replace(/[^\w.-]+/g, '_')}.log`), job.out);
    console.log(`[${String(finished).padStart(3)}/${total}] ${code === 0 && !/^SKIP/m.test(job.out) ? 'ok  ' : 'FAIL'} ${String(seconds).padStart(4)}s ${(job.peak / 1024).toFixed(1)}G ${job.label}`);
    job.resolve({code, out: job.killed ? `${job.out}\n${job.killed}` : job.out, seconds});
    pump();
  });
};
const monitor = setInterval(() => {
  if (!running.size && !census) return;
  try {
    const {size} = tree();
    let sum = census ? (census.current = size(census.pid)) : 0;
    for (const job of running) {
      if (job.killed || job.requeued) continue;
      job.current = size(job.proc.pid); job.peak = Math.max(job.peak, job.current); sum += job.current;
      if (job.current > cap) { job.killed = `memory cap: ${Math.round(job.current)} MiB > ${cap} MiB`; killTree(job.proc.pid); }
    }
    const live = [...running].filter(job => !job.killed && !job.requeued).sort((a, b) => b.begin - a.begin);
    if (sum > budget && live.length > 1) { live[0].requeued = `the pool's ${Math.round(sum)} MiB > ${budget} MiB`; killTree(live[0].proc.pid); }
  } catch { /* the next sample retries */ }
  pump();
}, 1000);
const stopAll = signal => { for (const job of running) killTree(job.proc.pid); if (census) killTree(census.pid); process.exit(130); };
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stopAll(signal));

/** A check in the pool: its key (the dedup and the caches'), its scene (one run of a scene at a time) and its expected time (the longest first). */
const exec = (command, args, {limitSeconds = 1800, key, label = key, scene = null, estimate = 60} = {}) => new Promise(resolve => {
  // (a check never run reserves the median peak of its map's checks, an Island replay's about 7 GB and a Training one's 4: the largest, swm1's 13 GB, would
  // leave room for one Island replay at a time; one that grows past its reservation is caught by the measured total)
  const map = scene ? SCENES[scene]?.map : null;
  const mapPeaks = Object.entries(peaks).filter(([other]) => map && SCENES[/--scene (\S+)/.exec(other)?.[1]]?.map === map).map(([, peak]) => peak).sort((a, b) => a - b);
  const job = {command, args, limitSeconds, key, label, scene, resolve, seconds: timings[key] ?? estimate,
    predicted: Math.min(peaks[key] ?? mapPeaks[mapPeaks.length >> 1] ?? 4096, budget)};
  total++;
  // (longest first with --jobs > 1; one at a time, the rows' order)
  const index = jobs > 1 ? queue.findIndex(other => other.seconds < job.seconds) : -1;
  queue.splice(index === -1 ? queue.length : index, 0, job);
});

if (flag('list')) {
  for (const row of rows) console.log(`${row.id} [${row.ev}] ${row.census ?? '-'} ${row.excluded ? `EXCLUDED: ${row.excluded}` : `proof: ${row.proof.length ? row.proof.map(p => p.name ?? p.ids).join(', ') : 'none'} | need: ${row.need}`}`);
  process.exit(0);
}

// --- markdown from a report -----------------------------------------------------------------------------------------------------------------------
const reportPath = typeof flag('report') === 'string' ? flag('report') : path.join(root, '.work/stage5-gate.json');
if (flag('markdown') || flag('write-doc')) {
  const file = typeof flag('markdown') === 'string' ? flag('markdown') : reportPath;
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const tables = renderTables(row => { const r = report.rows[row.id]; return r ? r.status : 'MISSING'; });
  if (flag('write-doc')) {
    const doc = path.join(root, 'docs/stage-5-exit-criteria.md');
    writeFileSync(doc, injectTables(readFileSync(doc, 'utf8'), tables));
    console.log(`criteria tables written to ${doc}`);
  } else console.log(tables);
  process.exit(0);
}

// --- the census -----------------------------------------------------------------------------------------------------------------------------------
const slugs = [...new Set(rows.map(row => row.census).filter(Boolean))];
let censusResult = {}, censusRun = null;
if (slugs.length) {
  const given = flag('census');
  if (given && given !== true) censusResult = JSON.parse(readFileSync(given, 'utf8'));
  else {
    mkdirSync(path.join(root, '.work'), {recursive: true});
    const out = path.join(root, '.work/stage5-census.json');
    console.log(`census: ${slugs.length} scenarios${jobs > 1 ? `, beside the proof checks (${jobs} jobs)` : ''}...`);
    // (outside the pool's slots; its process tree's memory counts against the budget)
    censusRun = new Promise(resolve => {
      const started = Date.now();
      const proc = spawn(process.execPath, ['scripts/census-stage5.mjs', '--only', slugs.join(','), '--json', out, '--update'], {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env});
      census = {pid: proc.pid, current: 0};
      let text = '';
      proc.stdout.on('data', d => { text += d; }); proc.stderr.on('data', d => { text += d; });
      const timer = setTimeout(() => killTree(proc.pid), 3600 * 1000);
      proc.on('exit', () => {
        clearTimeout(timer); census = null; pump();
        console.log(`census: ${Math.round((Date.now() - started) / 1000)}s`);
        if (!existsSync(out)) { console.error(text.split('\n').slice(-15).join('\n')); for (const job of running) killTree(job.proc.pid); process.exit(2); }
        resolve(JSON.parse(readFileSync(out, 'utf8')));
      });
    });
    if (jobs === 1) censusResult = await censusRun;
  }
}

// --- proof checks ---------------------------------------------------------------------------------------------------------------------------------
let stage4 = null;
const stage4Row = id => {
  const file = flag('stage4-report');
  if (!file || file === true || !existsSync(file)) return null;
  stage4 ??= JSON.parse(readFileSync(file, 'utf8'));
  return (stage4.criteria ?? stage4.rows ?? [])[id] ?? (Array.isArray(stage4.criteria) ? stage4.criteria.find(r => r.id === id) : null);
};
// A validator several rows name (a live scene that proves two rows) runs once per gate run; its result is the same for each.
const validatorRuns = new Map();
async function runProof(check) {
  if (check.type === 'validator') {
    const key = [check.name, ...(check.args ?? [])].join(' ');
    // (a live scene's runs share its files: --scene names it; the O3 checks name a census scene, whose files are their own)
    const sceneIndex = check.name === 'validate-stage5-live.mjs' ? (check.args ?? []).indexOf('--scene') : -1, scene = sceneIndex >= 0 ? check.args[sceneIndex + 1] : null;
    const shots = scene && check.args.includes('--frames') ? Object.values(SCENES[scene]?.shots ?? {}) : null;
    const estimate = scene ? 30 + (shots ? shots.reduce((n, tick) => n + 30 + tick / 20, 0) : (SCENES[scene]?.ticks ?? 900) / 20) : 60;
    if (!validatorRuns.has(key)) validatorRuns.set(key, exec(process.execPath, [`scripts/${check.name}`, ...(check.args ?? [])], {limitSeconds: check.limitSeconds ?? 1800, key, scene, estimate}));
    const run = await validatorRuns.get(key);
    if (run.code === 0 && !/^SKIP/m.test(run.out)) return {ok: true, note: `${check.name} ${run.seconds}s`};
    return {ok: false, note: `${check.name}: ${(/^SKIP.*$/m.exec(run.out)?.[0] ?? run.out.trim().split('\n').slice(-2).join(' | ')).slice(0, 160)}`};
  }
  if (check.type === 'stage4') {
    const missing = check.ids.filter(id => (stage4Row(id)?.status ?? null) !== 'PASS');
    return missing.length ? {ok: false, note: `Stage 4 rows not PASS or no report: ${missing.join(', ')}`} : {ok: true, note: `Stage 4 ${check.ids.join(', ')}`};
  }
  return {ok: false, note: `unknown check type ${check.type}`};
}

// The checks of every row the census plays (all rows' at once with --jobs > 1, the census still running): queued in row order, run by the pool, reported in row order.
const plays = row => !row.excluded && censusResult[row.census]?.status === 'plays';
const sceneOf = check => check.name === 'validate-stage5-live.mjs' ? check.args[check.args.indexOf('--scene') + 1] : null;
const replayed = rows.filter(row => (jobs > 1 || plays(row)) && row.proof.some(sceneOf));
if (replayed.length) {
  // the one file every replay of a map reads, written once per map before any replay starts (validate-stage5-live.mjs --prepare)
  const firstScene = new Map();
  for (const scene of replayed.flatMap(row => row.proof.map(sceneOf)).filter(Boolean)) if (SCENES[scene] && !firstScene.has(SCENES[scene].map)) firstScene.set(SCENES[scene].map, scene);
  for (const [map, scene] of firstScene) {
    const run = await new Promise(resolve => {
      const proc = spawn(process.execPath, ['scripts/validate-stage5-live.mjs', '--scene', scene, '--prepare'], {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env});
      let text = ''; proc.stdout.on('data', d => { text += d; }); proc.stderr.on('data', d => { text += d; });
      proc.on('exit', code => resolve({code, text}));
    });
    if (run.code !== 0) console.log(`prepare ${map}: ${run.text.trim().split('\n').slice(-3).join(' | ')}`);
  }
}
const pending = new Map(rows.filter(row => !row.excluded && row.proof.length && (jobs > 1 || plays(row))).map(row => [row.id, Promise.all(row.proof.map(runProof))]));
pump();
if (censusRun && jobs > 1) censusResult = await censusRun;
const report = {date: new Date().toISOString().slice(0, 10), rows: {}};
for (const row of rows) {
  const entry = report.rows[row.id] = {id: row.id, clause: row.clause, ev: row.ev, census: row.census, notes: []};
  if (row.excluded) { entry.status = 'EXCLUDED'; entry.notes.push(row.excluded); continue; }
  const c = censusResult[row.census];
  if (!c) { entry.status = 'UNDRIVEN'; entry.notes.push('the census has no result for this row'); continue; }
  entry.census_status = c.status; if (c.message) entry.notes.push(c.message);
  if (c.status === 'undriven') { entry.status = 'UNDRIVEN'; continue; }
  if (c.status !== 'plays') { entry.status = 'FAIL'; entry.notes.unshift(`census ${c.status}`); continue; }
  if (!row.proof.length) { entry.status = 'MISSING'; entry.notes.push(`no proof check: ${row.need}`); continue; }
  const results = await pending.get(row.id);
  entry.status = results.every(r => r.ok) ? 'PASS' : 'FAIL';
  entry.notes.push(...results.map(r => `${r.ok ? 'ok' : 'FAIL'} ${r.note}`));
}
await Promise.all(pending.values());
clearInterval(monitor);

mkdirSync(path.dirname(reportPath), {recursive: true});
writeFileSync(reportPath, JSON.stringify(report, null, 1));
const words = ['PASS', 'FAIL', 'MISSING', 'UNDRIVEN', 'EXCLUDED'];
console.log('\n| Clause | ' + words.join(' | ') + ' |\n| --- | ' + words.map(() => '---:').join(' | ') + ' |');
for (const [n, name] of Object.entries(CLAUSES).concat([[7, 'Excluded']])) {
  const mine = Object.values(report.rows).filter(r => r.clause === Number(n));
  if (mine.length) console.log(`| 5.${n} ${name} | ${words.map(w => mine.filter(r => r.status === w).length).join(' | ')} |`);
}
const all = Object.values(report.rows);
console.log(`| **Total** | ${words.map(w => all.filter(r => r.status === w).length).join(' | ')} |`);
for (const r of all.filter(r => r.status !== 'PASS' && r.status !== 'EXCLUDED')) console.log(`${r.id.padEnd(7)} ${r.status.padEnd(9)} ${r.census ?? '-'} ${r.notes.join(' / ').slice(0, 170)}`);
const open = all.filter(r => r.status !== 'PASS' && r.status !== 'EXCLUDED').length;
console.log(open ? `\nstage 5 gate: ${open} of ${all.filter(r => r.status !== 'EXCLUDED').length} criteria open` : '\nstage 5 gate: every criterion passes');
if (!flag('report')) process.exit(open ? 1 : 0);
