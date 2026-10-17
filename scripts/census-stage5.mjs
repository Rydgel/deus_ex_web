#!/usr/bin/env node
/** Census of the Stage 5 scenarios in Play (docs/stage-5-exit-criteria.md "Census"): what each scenario of scripts/stage5-criteria.mjs does when the
 * player's own inputs drive it, headless, in one session per map with the original Player start (game.reset()) between scenarios.
 *
 * A scenario is driven the way the alterations census and the Stage 3 route do it: items come from the map's own pickups (else the console cheat the original
 * supports, `summon`), are taken with the public frob path, drawn with the digit key User.ini binds to ActivateBelt and used with the mouse buttons; the player is
 * PLACED (fixture write, never movement or a field the scenario is about) at the approach the scenario names; every frame is Play's own (sim-session: tick, sprite scan,
 * HUD). Flags change only through conversation events and triggers, health only through weapons, zones and `TakeDamage` as the original's sources call it.
 *
 * The outcome per scenario is
 *   plays       the scenario ran to its end and the effect the original defines was observed
 *   pause       Play stopped on an error (the first one, with the JS frames that threw): an unimplemented native or boundary
 *   no-effect   no error, but the effect never happened (a silent no-op is not a pass)
 *   undriven    the driver cannot start the scenario yet (what it lacks is printed)
 * EXPECTED below is the outcome of the last run; a scenario whose outcome differs fails the check, so a regrown boundary cannot go unnoticed and a fixed one must be
 * recorded. The census is class P: it never says a scenario matches the original (the gate's proof checks do).
 *
 *   node scripts/census-stage5.mjs [--only slug,slug] [--json out.json] [--print] [--mem-cap MiB] [--update]
 *
 * Each map runs in a child whose RSS the parent samples and kills past the cap (the fire-path OOM note: heap caps alone do not bound native growth). */
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {CRITERIA} from './stage5-criteria.mjs';
import {runChildWithWatchdog} from './training-probe-lib.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : (argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[i + 1]); };

/** slug -> [map, driver name, Level seconds the driver may use (informative)]. The slugs are the `census` fields of stage5-criteria.mjs. */
export const SCENARIOS = {
  'crowbar-crate': ['00_Training'], 'phase1-route': ['00_Training'], 'dark-room-aug': ['00_Training'], 'bots': ['00_Training'], 'obstacle-jump': ['00_Training'],
  'ladder': ['00_Training'], 'crate-stack': ['00_Training'], 'hazmat-swim': ['00_Training'], 'training-datalinks': ['00_Training'],
  'pistol-range': ['00_TrainingCombat'], 'rifle-scope': ['00_TrainingCombat'], 'lam-wall': ['00_TrainingCombat'], 'instructor-take': ['00_TrainingCombat'],
  'stealth-maze': ['00_TrainingFinal'], 'elevator': ['00_TrainingFinal'], 'alarm-chain': ['00_TrainingFinal'], 'meet-page-final': ['00_TrainingFinal'],
  'island-shoot-npc': ['01_NYC_UNATCOIsland'], 'island-npc-shoots-player': ['01_NYC_UNATCOIsland'], 'island-melee-ko': ['01_NYC_UNATCOIsland'], 'island-death': ['01_NYC_UNATCOIsland'],
  'island-turret': ['01_NYC_UNATCOIsland'], 'island-sight': ['01_NYC_UNATCOIsland'], 'island-hearing': ['01_NYC_UNATCOIsland'], 'island-camera': ['01_NYC_UNATCOIsland'],
  'island-laser': ['01_NYC_UNATCOIsland'], 'island-hack-panel': ['01_NYC_UNATCOIsland'], 'island-carcass': ['01_NYC_UNATCOIsland'], 'island-swim': ['01_NYC_UNATCOIsland'],
  'island-terminal': ['01_NYC_UNATCOIsland'], 'island-doors': ['01_NYC_UNATCOIsland'], 'island-items': ['01_NYC_UNATCOIsland'], 'island-movables-fall': ['01_NYC_UNATCOIsland'],
  'meet-paul': ['01_NYC_UNATCOIsland'], 'meet-filben': ['01_NYC_UNATCOIsland'], 'gunther-rescued': ['01_NYC_UNATCOIsland'], 'meet-terrorist': ['01_NYC_UNATCOIsland'],
  'overheard-barks': ['01_NYC_UNATCOIsland'], 'route-front': ['01_NYC_UNATCOIsland'], 'route-back': ['01_NYC_UNATCOIsland'], 'route-airshaft': ['01_NYC_UNATCOIsland'],
  'route-water': ['01_NYC_UNATCOIsland'], 'objective-kill': ['01_NYC_UNATCOIsland'], 'objective-spare': ['01_NYC_UNATCOIsland'], 'mission-complete': ['01_NYC_UNATCOIsland'],
  'noise-wakes-guards': ['01_NYC_UNATCOIsland'], 'light-vs-sight': ['01_NYC_UNATCOIsland'], 'explosion-world': ['01_NYC_UNATCOIsland'], 'emp-electronics': ['01_NYC_UNATCOIsland'],
  'flags-change-world': ['01_NYC_UNATCOIsland'],
};

/** The outcome each scenario had at the last run: {status, message?} where `message` is a fragment of the pause's error or the reason of an undriven one. */
export const EXPECTED = {
  'crowbar-crate': {status: 'plays'},
  'phase1-route': {status: 'plays'},
  'dark-room-aug': {status: 'plays'},
  'bots': {status: 'plays'},
  'obstacle-jump': {status: 'plays'},
  'ladder': {status: 'plays'},
  'crate-stack': {status: 'plays'},
  'hazmat-swim': {status: 'plays'},
  'training-datalinks': {status: 'plays'},
  'pistol-range': {status: 'plays'},
  'rifle-scope': {status: 'plays'},
  'lam-wall': {status: 'no-effect'},
  'instructor-take': {status: 'plays'},
  'stealth-maze': {status: 'plays'},
  'elevator': {status: 'plays'},
  'alarm-chain': {status: 'no-effect'},
  'meet-page-final': {status: 'no-effect'},
  'island-shoot-npc': {status: 'plays'},
  'island-npc-shoots-player': {status: 'plays'},
  'island-melee-ko': {status: 'plays'},
  'island-death': {status: 'plays'},
  'island-turret': {status: 'plays'},
  'island-sight': {status: 'no-effect'},
  'island-hearing': {status: 'plays'},
  'island-camera': {status: 'plays'},
  'island-laser': {status: 'plays'},
  'island-hack-panel': {status: 'no-effect'},
  'island-carcass': {status: 'pause', message: 'CriticalDelete deleting destructor is not recovered for native vtable '},
  'island-swim': {status: 'plays'},
  'island-terminal': {status: 'no-effect'},
  'island-doors': {status: 'plays'},
  'island-items': {status: 'plays'},
  'island-movables-fall': {status: 'plays'},
  'meet-paul': {status: 'plays'},
  'meet-filben': {status: 'plays'},
  'gunther-rescued': {status: 'undriven', message: 'the cell door DeusExMover10 is reached by no frob approach tried (8 be'},
  'meet-terrorist': {status: 'plays'},
  'overheard-barks': {status: 'plays'},
  'route-front': {status: 'no-effect'},
  'route-back': {status: 'no-effect'},
  'route-airshaft': {status: 'plays'},
  'route-water': {status: 'plays'},
  'objective-kill': {status: 'no-effect'},
  'objective-spare': {status: 'plays'},
  'mission-complete': {status: 'plays'},
  'noise-wakes-guards': {status: 'plays'},
  'light-vs-sight': {status: 'undriven', message: 'needs a measured lit/dark pair of poses in an NPC\'s view and the NPC\'s'},
  'explosion-world': {status: 'plays'},
  'emp-electronics': {status: 'no-effect'},
  'flags-change-world': {status: 'undriven', message: 'needs GuntherFreed (see gunther-rescued) and the Filben and commander '},
};

// A scenario of a criterion row must be driven; a driven slug must belong to a row.
{
  const slugs = new Set(CRITERIA.map(row => row.census).filter(Boolean));
  for (const slug of slugs) assert.ok(SCENARIOS[slug], `row census slug ${slug} has no scenario`);
  for (const slug of Object.keys(SCENARIOS)) assert.ok(slugs.has(slug), `scenario ${slug} belongs to no criterion row`);
}

if (option('markdown')) {
  // The census table of the doc from a run's JSON (--json): scenario, rows, outcome, the first pause or what was observed.
  const results = JSON.parse(readFileSync(String(option('markdown')), 'utf8'));
  const cell = text => String(text ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
  const lines = ['| Scenario | Rows | Map | Outcome | First pause, or what was observed |', '| --- | --- | --- | --- | --- |'];
  for (const slug of Object.keys(SCENARIOS)) {
    const r = results[slug]; if (!r) continue;
    const ids = CRITERIA.filter(row => row.census === slug).map(row => row.id).join(', ');
    const observed = r.message ?? (r.effect ? JSON.stringify(r.effect).replace(/"/g, '').slice(0, 150) : '');
    lines.push(`| \`${slug}\` | ${ids} | ${SCENARIOS[slug][0]} | ${r.status} | ${cell(observed)} |`);
  }
  console.log(lines.join('\n'));
  process.exit(0);
}
if (!argv.includes('--child')) await parent();
else await child();

async function parent() {
  const only = option('only') ? String(option('only')).split(',') : null;
  const ids = Object.keys(SCENARIOS).filter(slug => !only || only.includes(slug));
  const maps = [...new Set(ids.map(slug => SCENARIOS[slug][0]))];
  const results = {};
  let seconds = 0, peak = 0;
  for (const map of maps) {
    const out = path.join(root, '.work', `census-stage5-${map}.json`);
    const run = await runChildWithWatchdog({script: fileURLToPath(import.meta.url), out, capMiB: Number(option('mem-cap') ?? 8192), label: `census ${map}`,
      args: ['--map', map, '--ids', ids.filter(slug => SCENARIOS[slug][0] === map).join(',')]});
    Object.assign(results, run.data); seconds += run.seconds; peak = Math.max(peak, run.peakMiB);
  }
  if (option('json')) writeFileSync(String(option('json')), JSON.stringify(results, null, 1));
  for (const slug of ids) {
    const r = results[slug];
    console.log(`${slug.padEnd(26)} ${r.status.padEnd(9)} ${r.message ? r.message.slice(0, 150) : ''}${option('print') && r.effect ? ` ${JSON.stringify(r.effect)}` : ''}`);
  }
  const count = status => ids.filter(slug => results[slug].status === status).length;
  console.log(`census-stage5: ${ids.length} scenarios in ${seconds}s (peak ${peak} MiB): ${count('plays')} plays, ${count('pause')} pause, ${count('no-effect')} no-effect, ${count('undriven')} undriven`);
  if (option('update')) { console.log(JSON.stringify(Object.fromEntries(ids.map(slug => [slug, {status: results[slug].status, ...(results[slug].message ? {message: results[slug].message.slice(0, 90)} : {})}])), null, 1)); return; }
  const mismatches = [];
  for (const slug of ids) {
    const got = results[slug], want = EXPECTED[slug];
    if (!want) mismatches.push(`${slug}: no expectation recorded (${got.status}${got.message ? ` "${got.message.slice(0, 90)}"` : ''})`);
    else if (want.status !== got.status || (want.message && !String(got.message ?? '').includes(want.message)))
      mismatches.push(`${slug}: expected ${want.status}${want.message ? ` "${want.message}"` : ''}, got ${got.status}${got.message ? ` "${got.message.slice(0, 90)}"` : ''}`);
  }
  if (!only) for (const slug of Object.keys(EXPECTED)) if (!SCENARIOS[slug]) mismatches.push(`${slug}: expectation without a scenario`);
  assert.equal(mismatches.join('\n'), '', 'the census changed');
  console.log('PASS census-stage5');
}

async function child() {
  const map = option('map'), ids = String(option('ids')).split(',');
  const {runScenarios} = await import('./census-stage5-drivers.mjs');
  const results = await runScenarios(map, ids);
  writeFileSync(option('out'), JSON.stringify(results));
  process.exit(0);
}
