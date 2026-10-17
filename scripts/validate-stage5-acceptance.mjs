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
 *
 * --census reads a census run instead of running one (the census takes about 15 minutes); --report prints the scoreboard and exits 0, writing the JSON report to the
 * file when one follows; --markdown re-renders the criteria tables of a report (--write-doc puts them into docs/stage-5-exit-criteria.md); --list prints the rows.
 * Exit status 1 while any criterion is not PASS (EXCLUDED apart). */
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CLAUSES, CRITERIA, injectTables, renderTables} from './stage5-criteria.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : (argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[i + 1]); };
const only = flag('only') && flag('only') !== true ? new RegExp(flag('only')) : null;
const rows = CRITERIA.filter(row => !only || only.test(`${row.id} ${row.scene} ${row.claim} ${row.census ?? ''}`));

const exec = (command, args, {limitSeconds = 1800} = {}) => new Promise(resolve => {
  const started = Date.now();
  const proc = spawn(command, args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env,
    NATIVE_PROBE_PYTHON: process.env.NATIVE_PROBE_PYTHON ?? (existsSync(path.join(root, '.cache/native-probe-env/bin/python')) ? path.join(root, '.cache/native-probe-env/bin/python') : '')}});
  let out = '';
  proc.stdout.on('data', d => { out += d; }); proc.stderr.on('data', d => { out += d; });
  const timer = setTimeout(() => proc.kill('SIGKILL'), limitSeconds * 1000);
  proc.on('exit', code => { clearTimeout(timer); resolve({code, out, seconds: Math.round((Date.now() - started) / 1000)}); });
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
let census = {};
if (slugs.length) {
  const given = flag('census');
  if (given && given !== true) census = JSON.parse(readFileSync(given, 'utf8'));
  else {
    mkdirSync(path.join(root, '.work'), {recursive: true});
    const out = path.join(root, '.work/stage5-census.json');
    console.log(`census: ${slugs.length} scenarios...`);
    const run = await exec(process.execPath, ['scripts/census-stage5.mjs', '--only', slugs.join(','), '--json', out, '--update'], {limitSeconds: 3600});
    if (!existsSync(out)) { console.error(run.out.split('\n').slice(-15).join('\n')); process.exit(2); }
    census = JSON.parse(readFileSync(out, 'utf8'));
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
async function runProof(check) {
  if (check.type === 'validator') {
    const run = await exec(process.execPath, [`scripts/${check.name}`, ...(check.args ?? [])], {limitSeconds: check.limitSeconds ?? 1800});
    if (run.code === 0 && !/^SKIP/m.test(run.out)) return {ok: true, note: `${check.name} ${run.seconds}s`};
    return {ok: false, note: `${check.name}: ${(/^SKIP.*$/m.exec(run.out)?.[0] ?? run.out.trim().split('\n').slice(-2).join(' | ')).slice(0, 160)}`};
  }
  if (check.type === 'stage4') {
    const missing = check.ids.filter(id => (stage4Row(id)?.status ?? null) !== 'PASS');
    return missing.length ? {ok: false, note: `Stage 4 rows not PASS or no report: ${missing.join(', ')}`} : {ok: true, note: `Stage 4 ${check.ids.join(', ')}`};
  }
  return {ok: false, note: `unknown check type ${check.type}`};
}

const report = {date: new Date().toISOString().slice(0, 10), rows: {}};
for (const row of rows) {
  const entry = report.rows[row.id] = {id: row.id, clause: row.clause, ev: row.ev, census: row.census, notes: []};
  if (row.excluded) { entry.status = 'EXCLUDED'; entry.notes.push(row.excluded); continue; }
  const c = census[row.census];
  if (!c) { entry.status = 'UNDRIVEN'; entry.notes.push('the census has no result for this row'); continue; }
  entry.census_status = c.status; if (c.message) entry.notes.push(c.message);
  if (c.status === 'undriven') { entry.status = 'UNDRIVEN'; continue; }
  if (c.status !== 'plays') { entry.status = 'FAIL'; entry.notes.unshift(`census ${c.status}`); continue; }
  if (!row.proof.length) { entry.status = 'MISSING'; entry.notes.push(`no proof check: ${row.need}`); continue; }
  const results = [];
  for (const check of row.proof) results.push(await runProof(check));
  entry.status = results.every(r => r.ok) ? 'PASS' : 'FAIL';
  entry.notes.push(...results.map(r => `${r.ok ? 'ok' : 'FAIL'} ${r.note}`));
}

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
