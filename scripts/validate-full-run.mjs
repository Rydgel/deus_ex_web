/** Stage 6, row 6.6.1 (docs/stage-6-exit-criteria.md, docs/stage-6-chains.md): one run in Play from New Game to an ending, each mission entered from the
 * previous mission's exit with no save loaded: the mission chains (scripts/chains/missionNN.mjs) joined, mission 1's New Game start kept, every later mission's
 * slot start left out (the chain of mission N starts where mission N-1's ends, which is the save it pinned). The exit `save` steps stay: saving loads nothing,
 * and `saveCount` is a travel property (DeusExPlayer.uc:333) that each SaveGame raises, so the captures, each started from the previous chain's save, carry
 * one more per mission (saveTime, also travel, is compared for presence only: travel-text.mjs TIME_PROPERTIES). Compared: the travel
 * text of each mission change with the original's text of the same change, the `exit` leg of that mission's capture (.work/chains/mNN/result.json; each
 * capture starts from the previous chain's exit save, whose own exit text equality is the evidence that it holds the original's state).
 *
 * runner-timeout: 7200
 *
 *   node --max-old-space-size=16384 scripts/validate-full-run.mjs [--missions 01,02,...] [--json out.json] [--play-only]
 *
 * SKIPs while a mission has no chain or no capture. Long: the whole campaign's maps in one process (about 60 levels, each disposed of before the next). */
import { existsSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { gameDirectory } from './game-directory.mjs';
import { loadChain, captureDirectory, readIfExists } from './chain-lib.mjs';
import { compareTravelTexts } from './chain-conversations.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
try { gameDirectory(); } catch { console.log('SKIP validate-full-run: no installed game data'); process.exit(0); }
const missions = option('missions', null)?.split(',')
  ?? readdirSync(new URL('./chains/', import.meta.url)).map(name => /^mission(\d\d)\.mjs$/.exec(name)?.[1]).filter(id => id && id !== '00').sort();
if (missions[0] !== '01') { console.log(`SKIP validate-full-run: the run starts with mission 1's New Game (missions: ${missions.join(',')})`); process.exit(0); }
// --play-only: the joined run in Play alone (no capture needed), reporting each mission change: that one process reaches the ending without a stop
const playOnly = process.argv.includes('--play-only');
const captures = {};
for (const mission of playOnly ? [] : missions) {
  const stored = await readIfExists(`${captureDirectory(mission)}result.json`);
  if (!stored) { console.log(`SKIP validate-full-run: mission ${mission} has no original capture (scripts/chain-capture-all.mjs)`); process.exit(0); }
  captures[mission] = JSON.parse(stored);
}

// the joined chain: mission 1 as it is; each later mission without its start; snapshot, state and leg labels prefixed by the mission
const steps = [];
for (const mission of missions) {
  const chain = await loadChain(mission);
  for (const step of chain.steps) {
    if (step.op === 'start' && mission !== missions[0]) continue;
    steps.push(step.op === 'snap' || step.op === 'travel' || step.op === 'state'
      ? { ...step, label: `m${mission}:${step.label ?? `to-${step.to}`}` } : step);
  }
}
// --from run.json: the comparison over a stored run (a `--json` file of this script), without playing the campaign again (a new capture of one mission)
let play;
if (option('from', null)) play = JSON.parse(await (await import('node:fs/promises')).readFile(option('from'), 'utf8'));
else {
  const { runChainInPlay } = await import('./chain-play.mjs');
  play = await runChainInPlay({ mission: 'full', steps }, { log: line => { if (process.argv.includes('--verbose')) console.log(`  play: ${line}`); } });
  if (option('json', null)) await writeFile(option('json'), JSON.stringify({ ...play, session: undefined, saveDirectory: undefined }, null, 1));
}

if (playOnly) {
  for (const leg of play.legs.filter(leg => leg.label.endsWith(':exit') || leg.label.includes('endgame') || leg.label.includes('dxonly'))) console.log(`${leg.label}: ${leg.from} -> ${leg.to}, ${leg.text.length} bytes`);
  console.log(`PLAY-ONLY validate-full-run: New Game to ${play.legs.at(-1)?.to ?? '?'} in one run, ${play.legs.length} map changes, ${Object.keys(play.snaps).length} snapshots`);
  process.exit(0);
}
const failures = [];
for (const mission of missions) {
  const want = captures[mission].legs.find(leg => leg.label === 'exit');
  const got = play.legs.find(leg => leg.label === `m${mission}:exit`);
  if (!want) { console.log(`mission ${mission}: its capture has no exit leg (an ending chain ends in the endgame)`); continue; }
  if (!got) { failures.push(`mission ${mission}: the run made no exit map change`); continue; }
  // A flag's FName spelling is its first registration in the process (docs/script-names.md "Spelling across levels"): this run is one process from New
  // Game, each capture a fresh one started from the previous chain's save, so their name tables have different histories and a flag name's case is not
  // compared here (mission 14's DL_Start_Played: the capture spelled dl_start_Played); the per-mission rows compare it, each from the same start
  const caseless = text => text.replace(/^FlagName=(.*)$/gm, (line, name) => `FlagName=${name.toLowerCase()}`);
  const { difference } = await compareTravelTexts(caseless(want.text), caseless(got.text));
  if (difference) failures.push(`mission ${mission}: the exit text differs from the original's: ${JSON.stringify(difference)}`);
  console.log(`mission ${mission}: ${got.from} -> ${got.to}${difference ? ' (DIFFER)' : ' equal'}`);
}
console.log(failures.length ? `FAIL validate-full-run: ${failures.join('; ')}` : `PASS validate-full-run: New Game to ${play.legs.at(-1)?.to ?? '?'} in one run, ${missions.length} missions' exit texts equal the original's`);
process.exit(failures.length ? 1 : 0);
