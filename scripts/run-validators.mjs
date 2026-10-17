#!/usr/bin/env node
/**
 * Run every scripts/validate-*.mjs across a process pool.
 *
 * The validators are independent processes that each shell out to their own
 * oracle, so the sweep is embarrassingly parallel; run serially it takes about
 * half an hour.  Report directories are per-validator, and the two validators
 * that share reports/movement/mover-move write disjoint filenames, so no pair
 * writes the same path.
 *
 *   node scripts/run-validators.mjs [--jobs N] [--filter substring] [--serial]
 *        [--mem-budget MiB] [--mem-cap MiB] [--timeout seconds]
 * Defaults to four validator jobs (the preferred local sweep size).
 *
 * Timings are cached in .cache/validator-timings.json and used to schedule the
 * slowest validators first, which is what keeps the tail short.  NATIVE_PROBE_
 * PYTHON is set automatically when the probe environment exists.
 *
 * Memory is bounded.  Several validators build whole levels and peak at 3–4 GiB,
 * and longest-first scheduling starts them together; unbounded, four jobs on a
 * 16 GiB machine swapped for tens of GiB.  Each validator runs in its own
 * process group, and the runner samples the group's memory footprint (on macOS
 * `top`'s MEM, which counts compressed and swapped pages; RSS hides them under
 * pressure).  A validator starts only when the reservations of the running ones
 * (the larger of each one's current footprint and its recorded peak) plus its own
 * recorded peak fit the budget, so heavy validators never overlap past it.  A
 * group over the per-validator cap is killed and fails.  A validator with no or
 * a stale recorded peak can still push the running total past the budget; the
 * most recently started group is then killed and requeued to run alone.  On
 * macOS the kernel's pressure level (kern.memorystatus_vm_pressure_level) also
 * counts memory held outside the sweep: at warning new validators start only
 * within half the budget, and at critical the latest is requeued the same way.  Peaks
 * are cached in .cache/validator-memory.json.
 *
 * Time is bounded too.  A validator still running after the larger of ten
 * minutes and four times its recorded time is killed and fails, with a `ps`
 * snapshot of its process group (state, cpu time, children such as an oracle)
 * so the hang leaves evidence; unbounded, one stuck process held a sweep's
 * last slot for forty minutes.  --timeout overrides the limit (0 disables it).
 * A validator whose honest cold run is longer than ten minutes (an oracle
 * corpus it rebuilds when its cache is cold) declares so in its first 8 KiB,
 * on a line `runner-timeout: <seconds>` after ` * ` or `// `; the limit is then
 * the largest of that, ten minutes and four times its recorded time.
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const serial = argv.includes('--serial');
const jobs = serial ? 1 : Math.max(1, Number(flag('--jobs', 4)));
const filter = flag('--filter', null);
const timingsPath = path.join(root, '.cache', 'validator-timings.json');
const memoryPath = path.join(root, '.cache', 'validator-memory.json');
const physicalMiB = os.totalmem() / 1048576;
const budget = Number(flag('--mem-budget', Math.round(Math.min(8192, physicalMiB / 2))));
const cap = Number(flag('--mem-cap', Math.round(Math.min(6144, budget))));
// Reservation for a validator with no recorded peak.
const unknownPeak = 1536;
// `ps` RSS is cheap and sampled often, so a runaway is caught within half a
// second; `top`'s footprint costs about a second of system time and refreshes
// every sixth sample.  Between refreshes a process's footprint is estimated as
// its last footprint plus its RSS growth since then.
const samplePeriod = 500, footprintEvery = 6;
const timeoutFlag = flag('--timeout', null);

const probe = path.join(root, '.cache', 'native-probe-env', 'bin', 'python');
const env = { ...process.env };
if (!env.NATIVE_PROBE_PYTHON && existsSync(probe))
  env.NATIVE_PROBE_PYTHON = path.relative(root, probe);
// The sweep is already CPU-saturated, so a pooled oracle must not multiply
// the runner's jobs by a second full cpu count.  Only a handful of validators
// carry a pooled oracle, so each one gets a bounded share — floor(cpus/jobs),
// with the divisor capped at five — that shrinks the critical-path sweep without
// starving the rest of the pool.  Standalone oracle runs keep the
// unrestricted default; NATIVE_ORACLE_JOBS=1 forces the serial path.
if (!env.NATIVE_ORACLE_JOBS)
  env.NATIVE_ORACLE_JOBS = String(Math.max(1, Math.floor(os.cpus().length / Math.min(jobs, 5))));

const readCache = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
const timings = readCache(timingsPath), peaks = readCache(memoryPath);
const saveCaches = () => {
  mkdirSync(path.dirname(timingsPath), { recursive: true });
  writeFileSync(timingsPath, JSON.stringify(timings, null, 2) + '\n');
  writeFileSync(memoryPath, JSON.stringify(peaks, null, 2) + '\n');
};

const SWEEP_EXCLUDED = new Set(['validate-stage4-acceptance.mjs', 'validate-stage5-acceptance.mjs', 'validate-stage5-live.mjs']);
const all = (await readdir(path.join(root, 'scripts')))
  .filter(name => name.startsWith('validate-') && name.endsWith('.mjs'))
  .filter(name => !filter || name.includes(filter))
  // The Stage 4 and Stage 5 gates compose other validators and the census (about an hour at two jobs, docs/stage-4-exit-criteria.md): they run on their own, or when --filter names them.
  // validate-stage5-live.mjs is one of the Stage 5 gate's proof checks: it needs --scene and the stored original of that scene.
  .filter(name => !SWEEP_EXCLUDED.has(name) || (filter && name.includes(filter)));
// Longest-known-first: an unknown validator sorts to the front so it is
// measured early rather than becoming a late straggler.
all.sort((a, b) => (timings[b] ?? Infinity) - (timings[a] ?? Infinity));

const queue = [...all], running = new Map(), results = [];
// macOS memory pressure: 1 normal, 2 warning, 4 critical.
const readPressure = async () => process.platform !== 'darwin' ? 1
  : Number((await run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])).stdout) || 1;
let pressure = await readPressure().catch(() => 1);
const solo = new Set();
let failures = 0;
const started = Date.now();
const pad = n => String(n).padStart(3);
const predicted = name => solo.has(name) ? budget : Math.min(peaks[name] ?? unknownPeak, cap);
const reservation = job => Math.max(job.current, predicted(job.name));
// `runner-timeout: <seconds>` in a validator's header (see the file comment).
const declared = new Map();
const declaredTimeout = name => {
  if (!declared.has(name)) {
    let seconds = 0;
    try {
      const head = readFileSync(path.join(root, 'scripts', name), 'utf8').slice(0, 8192);
      seconds = Number(/^[ \t]*(?:\*|\/\/)[ \t]*runner-timeout:[ \t]*(\d+)\b/m.exec(head)?.[1] ?? 0);
    } catch { /* an unreadable file fails when it starts */ }
    declared.set(name, seconds * 1000);
  }
  return declared.get(name);
};
const timeLimit = name => timeoutFlag !== null ? Number(timeoutFlag) * 1000
  : Math.max(600_000, declaredTimeout(name), 4 * (timings[name] ?? 0));

// Memory in MiB of every process in each running validator's group.
const units = { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024 };
const toMiB = text => { const m = /^([\d.]+)([BKMG])/.exec(text); return m ? Number(m[1]) * units[m[2]] : 0; };
const footprints = new Map(); // pid -> {footprint, rss} at the last `top` refresh
let samples = 0, refreshing = false;
// Runs beside the RSS samples so the cap check never waits for `top`.
const refreshFootprints = async groups => {
  refreshing = true;
  try {
    const args = ['-l', '1', '-stats', 'pid,mem'];
    for (const pid of groups.keys()) args.push('-pid', String(pid));
    const top = await run('top', args, { maxBuffer: 1 << 20 });
    for (const line of top.stdout.split('\n')) {
      const [pid, mem] = line.trim().split(/\s+/);
      const entry = groups.get(Number(pid));
      if (entry && mem) footprints.set(Number(pid), { footprint: toMiB(mem), rss: entry.rss });
    }
    pressure = await readPressure();
  } catch { /* the next refresh retries */ }
  refreshing = false;
};
const sample = async () => {
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,pgid=,rss=']);
  const groups = new Map();
  for (const line of stdout.trim().split('\n')) {
    const [pid, pgid, rss] = line.trim().split(/\s+/).map(Number);
    if (running.has(pgid)) groups.set(pid, { pgid, rss: rss / 1024 });
  }
  for (const pid of footprints.keys()) if (!groups.has(pid)) footprints.delete(pid);
  if (process.platform === 'darwin' && groups.size && !refreshing && samples++ % footprintEvery === 0)
    refreshFootprints(groups);
  const totals = new Map();
  for (const [pid, { pgid, rss }] of groups) {
    const known = footprints.get(pid);
    const mib = known ? known.footprint + Math.max(0, rss - known.rss) : rss;
    totals.set(pgid, (totals.get(pgid) ?? 0) + mib);
  }
  return totals;
};

const kill = (job, reason) => {
  if (job.killed) return;
  job.killed = reason;
  try { process.kill(-job.child.pid, 'SIGKILL'); } catch { /* already gone */ }
};

let wake = null;
const signal = () => { const w = wake; wake = null; w?.(); };
const wait = () => new Promise(resolve => { wake = resolve; setTimeout(signal, samplePeriod); });

let sampling = false;
const monitor = setInterval(async () => {
  if (sampling || !running.size) return;
  sampling = true;
  try {
    const totals = await sample();
    let total = 0;
    for (const job of running.values()) {
      job.current = totals.get(job.child.pid) ?? 0;
      job.peak = Math.max(job.peak, job.current);
      total += job.current;
      if (job.current > cap) kill(job, `memory cap: ${job.current.toFixed(0)} MiB > ${cap} MiB`);
      const limit = timeLimit(job.name), elapsed = Date.now() - job.begin;
      if (limit > 0 && elapsed > limit && !job.killed) {
        const { stdout } = await run('ps', ['-A', '-o', 'pid=,pgid=,stat=,time=,rss=,command=']).catch(() => ({ stdout: '' }));
        const group = stdout.split('\n').filter(line => Number(line.trim().split(/\s+/)[1]) === job.child.pid);
        job.timedOut = true;
        kill(job, `timeout: ${(elapsed / 1000).toFixed(0)}s > ${(limit / 1000).toFixed(0)}s; process group (pid pgid stat time rss command):\n${group.join('\n')}`);
      }
    }
    const live = [...running.values()].filter(job => !job.killed).sort((a, b) => b.begin - a.begin);
    if (total > budget && live.length > 1)
      kill(live[0], `requeue: sweep total ${total.toFixed(0)} MiB > ${budget} MiB`);
    else if (pressure >= 4 && live.length > 1)
      kill(live[0], 'requeue: system memory pressure critical');
  } catch { /* the next sample retries */ }
  sampling = false;
  signal();
}, samplePeriod);

const start = name => {
  const begin = Date.now();
  const child = spawn(process.execPath, [path.join('scripts', name)],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const job = { name, child, begin, current: 0, peak: 0, killed: null, out: '', err: '' };
  running.set(child.pid, job);
  child.stdout.on('data', d => { job.out += d; });
  child.stderr.on('data', d => { job.err += d; });
  child.on('close', code => {
    running.delete(child.pid);
    const ms = Date.now() - begin;
    if (job.killed?.startsWith('requeue')) {
      solo.add(name);
      queue.unshift(name);
      console.log(`[   /${all.length}] back ${(ms / 1000).toFixed(1)}s  ${name} (${job.killed})`);
      signal();
      return;
    }
    if (job.killed) { code = code || 137; job.err = `${job.killed}\n${job.err}`; }
    peaks[name] = Math.round(job.killed && !job.timedOut ? cap : job.peak);
    if (!job.killed) timings[name] = ms;
    saveCaches();
    const skipped = /^SKIP /m.test(job.out);
    results.push({ name, code, ms, out: job.out, err: job.err, skipped, peak: job.peak });
    if (code !== 0) failures++;
    const tag = code !== 0 ? 'FAIL' : skipped ? 'skip' : 'ok  ';
    console.log(`[${pad(results.length)}/${all.length}] ${tag} ${(ms / 1000).toFixed(1)}s ${(job.peak / 1024).toFixed(1)}G  ${name}`);
    signal();
  });
};

const stopAll = sig => {
  for (const job of running.values()) kill(job, `runner ${sig}`);
  process.exit(130);
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stopAll(sig));

console.log(`${all.length} validators, ${jobs} jobs, memory budget ${budget} MiB, per-validator cap ${cap} MiB`);
while (queue.length || running.size) {
  let reserved = [...running.values()].reduce((n, job) => n + reservation(job), 0);
  while (queue.length && running.size < jobs) {
    // Longest-first among the validators whose recorded peak fits.
    const limit = pressure >= 2 ? budget / 2 : budget;
    const index = running.size ? queue.findIndex(name => reserved + predicted(name) <= limit) : 0;
    if (index === -1) break;
    const [name] = queue.splice(index, 1);
    reserved += predicted(name);
    start(name);
  }
  await wait();
}
clearInterval(monitor);
saveCaches();

const wall = (Date.now() - started) / 1000;
const cpu = results.reduce((n, r) => n + r.ms, 0) / 1000;
for (const r of results.filter(r => r.code !== 0)) {
  console.log(`\n=== FAILED ${r.name} (exit ${r.code}) ===`);
  console.log((r.err || r.out).split('\n').slice(0, 25).join('\n'));
}
const slow = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);
console.log(`\nslowest: ${slow.map(r => `${r.name.replace(/^validate-|\.mjs$/g, '')} ${(r.ms / 1000).toFixed(0)}s`).join(', ')}`);
const heavy = [...results].sort((a, b) => b.peak - a.peak).slice(0, 5);
console.log(`largest: ${heavy.map(r => `${r.name.replace(/^validate-|\.mjs$/g, '')} ${(r.peak / 1024).toFixed(1)}G`).join(', ')}`);
const skips = results.filter(r => r.skipped).length;
console.log(`${results.length - failures - skips} passed, ${skips} skipped, ${failures} failed `
  + `in ${wall.toFixed(1)}s wall (${cpu.toFixed(0)}s cpu, ${jobs} jobs, speedup ${(cpu / wall).toFixed(1)}x)`);
process.exit(failures ? 1 : 0);
