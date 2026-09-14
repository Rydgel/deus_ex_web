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
 *
 * Timings are cached in .cache/validator-timings.json and used to schedule the
 * slowest validators first, which is what keeps the tail short.  NATIVE_PROBE_
 * PYTHON is set automatically when the probe environment exists.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const serial = argv.includes('--serial');
const jobs = serial ? 1 : Math.max(1, Number(flag('--jobs', os.cpus().length)));
const filter = flag('--filter', null);
const timingsPath = path.join(root, '.cache', 'validator-timings.json');

const probe = path.join(root, '.cache', 'native-probe-env', 'bin', 'python');
const env = { ...process.env };
if (!env.NATIVE_PROBE_PYTHON && existsSync(probe))
  env.NATIVE_PROBE_PYTHON = path.relative(root, probe);

let timings = {};
try { timings = JSON.parse(readFileSync(timingsPath, 'utf8')); } catch { /* first run */ }

const all = (await readdir(path.join(root, 'scripts')))
  .filter(name => name.startsWith('validate-') && name.endsWith('.mjs'))
  .filter(name => !filter || name.includes(filter));
// Longest-known-first: an unknown validator sorts to the front so it is
// measured early rather than becoming a late straggler.
all.sort((a, b) => (timings[b] ?? Infinity) - (timings[a] ?? Infinity));

const results = [];
let next = 0, failures = 0;
const started = Date.now();
const pad = n => String(n).padStart(3);

const runOne = name => new Promise(resolve => {
  const begin = Date.now();
  const child = spawn(process.execPath, [path.join('scripts', name)],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  child.on('close', code => {
    const ms = Date.now() - begin;
    timings[name] = ms;
    const skipped = /^SKIP /m.test(out);
    results.push({ name, code, ms, out, err, skipped });
    if (code !== 0) failures++;
    const tag = code !== 0 ? 'FAIL' : skipped ? 'skip' : 'ok  ';
    console.log(`[${pad(results.length)}/${all.length}] ${tag} ${(ms / 1000).toFixed(1)}s  ${name}`);
    resolve();
  });
});

const worker = async () => { while (next < all.length) await runOne(all[next++]); };
await Promise.all(Array.from({ length: Math.min(jobs, all.length) }, worker));

mkdirSync(path.dirname(timingsPath), { recursive: true });
writeFileSync(timingsPath, JSON.stringify(timings, null, 2) + '\n');

const wall = (Date.now() - started) / 1000;
const cpu = results.reduce((n, r) => n + r.ms, 0) / 1000;
for (const r of results.filter(r => r.code !== 0)) {
  console.log(`\n=== FAILED ${r.name} (exit ${r.code}) ===`);
  console.log((r.err || r.out).split('\n').slice(0, 25).join('\n'));
}
const slow = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);
console.log(`\nslowest: ${slow.map(r => `${r.name.replace(/^validate-|\.mjs$/g, '')} ${(r.ms / 1000).toFixed(0)}s`).join(', ')}`);
const skips = results.filter(r => r.skipped).length;
console.log(`${results.length - failures - skips} passed, ${skips} skipped, ${failures} failed `
  + `in ${wall.toFixed(1)}s wall (${cpu.toFixed(0)}s cpu, ${jobs} jobs, speedup ${(cpu / wall).toFixed(1)}x)`);
process.exit(failures ? 1 : 0);
