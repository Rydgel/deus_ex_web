/** Stage 6, row 6.6.1 (docs/stage-6-exit-criteria.md, docs/stage-6-chains.md): one run in Play from New Game to an ending, each mission entered from the
 * previous mission's exit with no save loaded: the mission chains (scripts/chains/missionNN.mjs) joined, mission 1's New Game start kept, every later mission's
 * slot start and every chain's exit `save` left out (the chain of mission N starts where mission N-1's ends, which is the save it pinned). Compared: the travel
 * text of each mission change with the original's text of the same change, the `exit` leg of that mission's capture (.work/chains/mNN/result.json; each
 * capture starts from the previous chain's exit save, whose own exit text equality is the evidence that it holds the original's state).
 *
 * runner-timeout: 7200
 *
 *   node --max-old-space-size=16384 scripts/validate-full-run.mjs [--missions 01,02,...] [--json out.json]
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
const captures = {};
for (const mission of missions) {
  const stored = await readIfExists(`${captureDirectory(mission)}result.json`);
  if (!stored) { console.log(`SKIP validate-full-run: mission ${mission} has no original capture (scripts/chain-capture-all.mjs)`); process.exit(0); }
  captures[mission] = JSON.parse(stored);
}

// the joined chain: mission 1 as it is; each later mission without its start; no exit saves; snapshot and leg labels prefixed by the mission
const steps = [];
for (const mission of missions) {
  const chain = await loadChain(mission);
  for (const step of chain.steps) {
    if (step.op === 'save' || (step.op === 'start' && mission !== missions[0])) continue;
    steps.push(step.op === 'snap' || step.op === 'travel' || step.op === 'state'
      ? { ...step, label: `m${mission}:${step.label ?? `to-${step.to}`}` } : step);
  }
}
const { runChainInPlay } = await import('./chain-play.mjs');
const play = await runChainInPlay({ mission: 'full', steps }, { log: line => { if (process.argv.includes('--verbose')) console.log(`  play: ${line}`); } });
if (option('json', null)) await writeFile(option('json'), JSON.stringify({ ...play, session: undefined, saveDirectory: undefined }, null, 1));

const failures = [];
for (const mission of missions) {
  const want = captures[mission].legs.find(leg => leg.label === 'exit');
  const got = play.legs.find(leg => leg.label === `m${mission}:exit`);
  if (!want) { console.log(`mission ${mission}: its capture has no exit leg (an ending chain ends in the endgame)`); continue; }
  if (!got) { failures.push(`mission ${mission}: the run made no exit map change`); continue; }
  const { difference } = await compareTravelTexts(want.text, got.text);
  if (difference) failures.push(`mission ${mission}: the exit text differs from the original's: ${JSON.stringify(difference)}`);
  console.log(`mission ${mission}: ${got.from} -> ${got.to}${difference ? ' (DIFFER)' : ' equal'}`);
}
console.log(failures.length ? `FAIL validate-full-run: ${failures.join('; ')}` : `PASS validate-full-run: New Game to ${play.legs.at(-1)?.to ?? '?'} in one run, ${missions.length} missions' exit texts equal the original's`);
process.exit(failures.length ? 1 : 0);
