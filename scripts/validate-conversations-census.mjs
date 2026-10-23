#!/usr/bin/env node
/** Stage 6 rows 6.4.*.3: every own conversation and InfoLink of the selected missions' lists starts and runs to its end in Play, or is a named boundary.
 *
 *   node scripts/validate-conversations-census.mjs [--missions 00,01] [--jobs 2] [--slots] [--results <census json>]
 *
 * It runs scripts/census-conversations.mjs over the missions (a cold open of each owner's map; `--slots` adds the second pass from the real desktop save slots,
 * `.work/internet-saves`) or reads a finished census (`--results`), and judges each conversation:
 *   ran        started as its owner or trigger starts it and reached its end: PASS
 *   boundary   not run, and named in scripts/census-conversations-boundaries.mjs with the reason, the family the census still finds: PASS (printed)
 *   anything else (a stop of Play, or a refusal nobody has named): FAIL
 * A boundary that now runs is reported and passes (the table can shrink). The census is Play against itself (evidence class P): it finds stops, it does not
 * compare with the original; the placed-chain rows (6.4.*.1) do that for the conversations on each mission's required chain.
 *
 * Exit 0 when nothing fails; 1 otherwise. The census output (with any dialogue-derived text) stays under .work/, outside Git. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOUNDARIES, FAMILIES, kindOfFamily } from './census-conversations-boundaries.mjs';
import { familyKey, mergeResults } from './census-conversations.mjs';
import { gameDirectory } from './game-directory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const flag = name => process.argv.includes(`--${name}`);
try { gameDirectory(); } catch { console.log('SKIP validate-conversations-census: no installed game data'); process.exit(0); }

const missions = option('missions', null);
const passes = [];
if (option('results', null)) passes.push(JSON.parse(await readFile(path.resolve(REPO, option('results')), 'utf8')).results);
else {
  const run = async (label, extra) => {
    const out = path.join(REPO, '.work', `validate-census-${label}-${(missions ?? 'all').replaceAll(',', '_')}.json`);
    const args = [path.join(HERE, 'census-conversations.mjs'), '--jobs', option('jobs', '2'), '--out', out, ...(missions ? ['--missions', missions] : []), ...extra];
    const child = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'ignore', 'inherit'] });
    if (child.status !== 0 || !existsSync(out)) throw new Error(`the census (${label}) did not finish: exit ${child.status}`);
    return JSON.parse(await readFile(out, 'utf8')).results;
  };
  passes.push(await run('cold', []));
  if (flag('slots')) passes.push(await run('slots', ['--slots']));
}

const results = mergeResults(passes);
const boundaryOf = new Map();
for (const [mission, families] of Object.entries(BOUNDARIES)) for (const [family, names] of Object.entries(families)) for (const name of names) boundaryOf.set(`${mission}/${name}`, family);
let ran = 0, named = 0;
const fails = [], now = [];
for (const r of results) {
  const boundary = boundaryOf.get(`${r.mission}/${r.name}`);
  if (r.outcome === 'ran') { ran++; if (boundary) now.push(`${r.mission}/${r.name} runs now (was: ${boundary})`); continue; }
  const found = familyKey(r);
  if (boundary && (boundary === found || (kindOfFamily(boundary) === 'state' && kindOfFamily(found) === 'state'))) { named++; continue; }
  fails.push(`${r.mission}/${r.name} [${r.map}]: ${r.outcome} ${r.stop ? `[${r.stop.family}] ${String(r.stop.message).slice(0, 140)}` : ''}${boundary ? ` (named as: ${boundary})` : ' (no boundary names it)'}`);
}
const perMission = {};
for (const r of results) { const m = perMission[r.mission] ??= { ran: 0, boundary: 0, fail: 0 }; if (r.outcome === 'ran') m.ran++; else if (fails.some(f => f.startsWith(`${r.mission}/${r.name} `))) m.fail++; else m.boundary++; }
for (const [m, v] of Object.entries(perMission).sort()) console.log(`mission ${m}: ${v.ran} ran, ${v.boundary} named boundaries, ${v.fail} failing`);
for (const line of now) console.log(`note: ${line}`);
for (const line of fails) console.log(`FAIL ${line}`);
console.log(`${results.length} conversations: ${ran} ran, ${named} named boundaries (${[...new Set([...boundaryOf.values()])].length} families: ${Object.keys(FAMILIES).length} defined), ${fails.length} failing`);
if (fails.length) process.exit(1);
console.log('Conversation census passed: every own conversation and InfoLink of the selected missions ran to its end in Play or is a named boundary.');
