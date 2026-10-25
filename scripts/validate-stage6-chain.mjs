/** Stage 6, row 6.4.<mission>.1 (docs/stage-6-exit-criteria.md, docs/stage-6-chains.md): a mission's required chain, each step placed, run in Play through the
 * player's inputs and compared with the original's run of the same steps under Wine (scripts/chain-original.mjs; its capture is in .work/chains/m<mission>/,
 * outside Git). Compared: the flags at every snapshot of the chain (name, type, expiration, value), and the travel text each map change exported, after the
 * normalization of the travel step (pointers, instance numbers, the two frame-time properties' values): the flags with their expirations, the goals, the notes,
 * the inventory, the skills, the conversation history, everything the original carries into the next map.
 *
 * Without --mission it runs every mission that has a chain (scripts/chains/missionNN.mjs), one process each; it SKIPs a mission whose capture is not in .work/chains.
 *
 * runner-timeout: 1800
 *
 *   node scripts/validate-stage6-chain.mjs [--mission NN] [--capture]   --capture runs the original first (the Wine lock; minutes)
 *   node scripts/validate-stage6-chain.mjs --file .work/chains/census/<unit>.mjs [--capture]   a carried-flag census unit (scripts/stage6-flag-census.mjs) */
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gameDirectory } from './game-directory.mjs';
import { loadChain, captureDirectory, readIfExists, flagDifferences } from './chain-lib.mjs';
import { RANDOM_FLAGS } from './chain-conversations.mjs';
import { parseTravelText } from '../src/runtime/travel-text.mjs';
import { compareTravelTexts as compareTexts } from './chain-conversations.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
// `--file` alone (a carried-flag census unit, .work/chains/census/<unit>.mjs): the chain names its own mission, and its capture directory follows from it
const mission = option('mission', null) ?? (option('file', null) ? (await loadChain(null, option('file'))).mission : null);
if (!mission) {
  const { spawnSync } = await import('node:child_process');
  let failed = 0;
  const { readdirSync } = await import('node:fs');
  // every mission's chain (scripts/chains/missionNN.mjs; the endings, mission15e<n>, are the 6.5 rows' own runs)
  const ids = readdirSync(new URL('./chains/', import.meta.url)).map(name => /^mission(\d\d)\.mjs$/.exec(name)?.[1]).filter(Boolean).sort();
  for (const id of ids) {
    const run = spawnSync(process.execPath, ['--max-old-space-size=12288', new URL(import.meta.url).pathname, '--mission', id, ...process.argv.slice(2)], { stdio: 'inherit' });
    if (run.status !== 0) failed++;
  }
  console.log(failed ? `FAIL validate-stage6-chain: ${failed} mission(s) failed` : 'PASS validate-stage6-chain: every mission');
  process.exit(failed ? 1 : 0);
}
try { gameDirectory(); } catch { console.log(`SKIP validate-stage6-chain ${mission}: no installed game data`); process.exit(0); }
const dir = captureDirectory(mission);
if (process.argv.includes('--capture')) {
  const { runChainInOriginal } = await import('./chain-original.mjs');
  await runChainInOriginal(await loadChain(mission, option('file', null)));
}
const stored = await readIfExists(`${dir}result.json`);
if (!stored) { console.log(`SKIP validate-stage6-chain ${mission}: no original capture in .work/chains/m${mission} (outside Git; node scripts/chain-original.mjs --mission ${mission})`); process.exit(0); }
const original = JSON.parse(stored);

const { runChainInPlay } = await import('./chain-play.mjs');
const chain = await loadChain(mission, option('file', null));
const play = await runChainInPlay(chain, { log: line => { if (process.argv.includes('--verbose')) console.log(`  play: ${line}`); } });
if (option('json', null)) await writeFile(option('json'), JSON.stringify({ ...play, session: undefined, saveDirectory: undefined }, null, 1));

/** A map's name as the comparison reads it: the filed level's URL (..\\Save\\Current\\<map>.dxs) and the .dx extension are the same map. */
// the original's URL.Map can carry a trailing blank or control character after the extension (mission 14's first capture: "14_OceanLab_Lab.dx ")
const mapName = name => String(name ?? '').replace(/[\s\u0000-\u001f]+$/, '').replace(/^.*[\\/]/, '').replace(/\.dxs?$/i, '').toLowerCase();
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };
console.log(`chain ${mission}: ${chain.steps.length} steps; Play ${play.legs.length} legs, ${Object.keys(play.snaps).length} snapshots; the original ${original.legs.length} legs, ${Object.keys(original.snaps).length} snapshots`);

// 1. the flags at each snapshot
for (const [label, want] of Object.entries(original.snaps)) {
  const got = play.snaps[label];
  if (!check(got, `snapshot ${label}: Play has none`)) continue;
  check(mapName(got.map) === mapName(want.map), `snapshot ${label}: Play is in ${got.map}, the original in ${want.map}`);
  // a flag a script draws with FRand is compared by its presence only (RANDOM_FLAGS: its value and expiration are the draw's)
  const drawn = flags => flags.map(f => { const [name, type] = f.split('|'); return RANDOM_FLAGS[name.toLowerCase()] ? `${name}|${type}|*|*` : f; });
  const d = flagDifferences(drawn(got.flags), drawn(want.flags));
  const same = !d.onlyPlay.length && !d.onlyOriginal.length;
  check(same, `snapshot ${label}: flags differ: only Play ${JSON.stringify(d.onlyPlay)}; only the original ${JSON.stringify(d.onlyOriginal)}`);
  check(got.defaultExpiration === want.defaultExpiration, `snapshot ${label}: default expiration Play ${got.defaultExpiration}, the original ${want.defaultExpiration}`);
  console.log(`snapshot ${label}: ${got.flags.length} flags${same ? ' equal' : ' (DIFFER)'}, default expiration ${got.defaultExpiration}${got.defaultExpiration === want.defaultExpiration ? '' : ` (original ${want.defaultExpiration})`}`);
}
// 1b. the states read at the steps (doors: KeyNum, bLocked)
// (only the reads the chain still makes: a read taken out of the chain, a door that closes again by itself, leaves the capture's value unread)
const reads = new Set(chain.steps.filter(step => step.op === 'state').map(step => step.label));
for (const [label, want] of Object.entries(original.states ?? {})) {
  if (!reads.has(label)) { console.log(`state ${label}: no longer read by the chain`); continue; }
  const got = play.states?.[label];
  if (!check(got, `state ${label}: Play has none`)) continue;
  const same = JSON.stringify(got) === JSON.stringify(want);
  check(same, `state ${label}: Play ${JSON.stringify(got)}, the original ${JSON.stringify(want)}`);
  console.log(`state ${label}: ${JSON.stringify(got)}${same ? ' equal' : ' (DIFFER)'}`);
}
// 2. the travel text of each map change
for (const want of original.legs) {
  const got = play.legs.find(leg => leg.label === want.label);
  if (!check(got, `leg ${want.label}: Play made no such map change`)) continue;
  if (!check(want.text, `leg ${want.label}: the capture holds no text`)) continue;
  const { difference, excused } = await compareTexts(want.text, got.text);
  check(difference === null, `leg ${want.label}: the exported text differs at line ${difference?.line}: the original ${JSON.stringify(difference?.expected)}, Play ${JSON.stringify(difference?.actual)}`);
  console.log(`leg ${want.label}: ${got.from} -> ${got.to}, ${parseTravelText(got.text).length} records${difference ? ' (DIFFER)' : ' equal'}${excused ? `, ${excused} random-label speech(es) the two runs drew differently` : ''}`);
}
for (const got of play.legs) if (!original.legs.some(leg => leg.label === got.label)) check(false, `leg ${got.label}: the original made no such map change`);
if (failures.length) { console.log(`FAIL validate-stage6-chain ${mission}:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log(`PASS validate-stage6-chain ${mission}: ${play.legs.length} legs and ${Object.keys(play.snaps).length} snapshots equal the original's`);
process.exit(0);
