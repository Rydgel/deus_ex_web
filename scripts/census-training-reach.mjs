/** Report-only Training reach census (docs/stage-3-exit-criteria.md, "First step").
 *
 * Boots 00_Training, runs startup and idle level ticks, then drives each
 * interaction family through its public Play entry: every actor with a Frob
 * body through game.use() (ParseRightClick), every decoration Bump, every
 * non-pawn Touch, and each exec command bound in the installed User.ini
 * [Engine.Input]. Every probe is followed by painted level ticks, as Play runs
 * them, and a game.reset(). It prints the boundaries the probes reach, grouped
 * so a whole family can be recovered and verified together.
 *
 * --continue returns the declared zero value from an unsupported native (the
 * Play host's final "Unsupported original door native N" fallthrough) and
 * records it, so one probe lists every native its path reaches rather than only
 * the first. Values after such a return are not original behavior: this is
 * planning data for choosing families, never evidence for a translation.
 *
 *   node scripts/census-training-reach.mjs [--continue] [--all] [--groups idle,frob,bump,touch,exec,sequence] [--only regex]
 *        [--json .cache/training-reach-census.json] [--mem-cap MiB]
 *
 * Startup and pawn-tick failures that Play catches into npcFailures are listed
 * as [swallowed] boundaries (scripts/training-probe-lib.mjs).
 *
 * The census runs in a child process whose RSS the parent samples, and kills it
 * past the cap (docs: OOM fire-path note). Fire/AltFire are not probed. */
import {writeFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROBE_GROUPS, root, runChildWithWatchdog, runTrainingProbes} from './training-probe-lib.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i === -1 ? fallback : argv[i + 1]; };
const continueMode = argv.includes('--continue');
const groups = String(flag('--groups', PROBE_GROUPS.join(','))).split(',').filter(Boolean);

if (!argv.includes('--child')) await parent();
else await child();

async function parent() {
  const out = path.resolve(root, flag('--json', '.cache/training-reach-census.json'));
  mkdirSync(path.dirname(out), {recursive: true});
  const {data: census, seconds, peakMiB} = await runChildWithWatchdog({
    script: fileURLToPath(import.meta.url), out: `${out}.partial`, capMiB: Number(flag('--mem-cap', 8192)), label: 'census',
    args: ['--groups', groups.join(','), ...(continueMode ? ['--continue'] : []), ...(argv.includes('--all') ? ['--all'] : []),
      ...(flag('--only') ? ['--only', flag('--only')] : [])]});
  census.meta = {...census.meta, seconds, peakMiB};
  writeFileSync(out, JSON.stringify(census, null, 1) + '\n');
  report(census, out);
}

async function child() {
  const result = await runTrainingProbes({groups, continueMode, all: argv.includes('--all'), only: flag('--only')});
  writeFileSync(flag('--out'), JSON.stringify(result));
  process.exit(0);
}

function report(census, out) {
  const {records, probes, meta} = census;
  const natives = new Map(), errors = new Map();
  for (const record of records) {
    const bucket = record.kind === 'native' ? natives : errors;
    const key = record.kind === 'native' ? record.index : `${record.kind === 'swallowed' ? '[swallowed] ' : ''}${record.message}`;
    const entry = bucket.get(key) ?? {record, first: record.probe, probes: new Set(), callers: new Set(), hits: 0};
    entry.hits++; entry.probes.add(record.probe); if (record.caller) entry.callers.add(record.caller);
    bucket.set(key, entry);
  }
  // game.use() turns a non-pawn Frob boundary into a message, so a probe also
  // counts as ending on a boundary when it recorded a terminal error.
  const errored = new Set(records.filter(record => (record.kind === 'error' || record.kind === 'swallowed') && record.probe !== 'reboot')
    .map(record => record.probe));
  const failed = probes.filter(probe => probe.error || errored.has(`${probe.group}:${probe.label}`));
  console.log(`Training reach census${meta.continue ? ' (--continue)' : ''}: ${probes.length} probes, ` +
    `${failed.length} ended on a boundary, ${meta.boots} boots, ${meta.seconds}s, peak ${meta.peakMiB} MiB`);
  console.log(`\nUnsupported natives reached: ${natives.size}` + (meta.continue ? '' : ' (first per path; use --continue for all)'));
  const byOwner = new Map();
  for (const [index, entry] of natives) {
    const owner = entry.record.name?.split('.').slice(0, 2).join('.') ?? '?';
    (byOwner.get(owner) ?? byOwner.set(owner, []).get(owner)).push([index, entry]);
  }
  for (const [owner, list] of [...byOwner].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${owner} (${list.length})`);
    for (const [index, entry] of list.sort((a, b) => b[1].probes.size - a[1].probes.size))
      console.log(`    ${String(index).padStart(5)} ${entry.record.name ?? '?'}  probes=${entry.probes.size} hits=${entry.hits}` +
        `  first ${entry.first}  from ${[...entry.callers].slice(0, 3).join(', ')}${entry.callers.size > 3 ? ', …' : ''}`);
  }
  console.log(`\nOther boundaries: ${errors.size}`);
  for (const [message, entry] of [...errors].sort((a, b) => b[1].probes.size - a[1].probes.size))
    console.log(`  probes=${String(entry.probes.size).padStart(3)}  ${message.slice(0, 180)}\n      first ${entry.first} at ${entry.record.stack?.slice(-3).join(' < ') ?? '?'}`);
  const open = probes.filter(probe => probe.stillOpen);
  if (open.length) console.log(`\nScreens Escape did not close: ${open.map(probe => `${probe.label} (${probe.stillOpen})`).join(', ')}`);
  console.log(`\nWrote ${path.relative(root, out)}`);
}
