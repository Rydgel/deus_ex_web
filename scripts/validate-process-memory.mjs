/** Memory over repeated map changes in one script process (docs/class-graph-design.md, migration step 4's gate): gc2's sequence (DX.dx,
 * `open 00_Training`, `open 01_NYC_UNATCOIsland`, `open 00_Training`, docs/class-lifetime.md) with the Island and Training round trip
 * repeated, each arrival attached to the process of the level left (census-stage5-session.mjs openSession). After a full GC at each
 * Training arrival from the second round trip on:
 * - the process holds the same state each time: classes, identities, the graph's export records and tracked objects, the resource
 *   registry's records, the asset store's packages, and the released bytes within their budget;
 * - the JS heap grows less than `--slope` MB per round trip on average (default 1.5), and ArrayBuffer memory (the packages' bytes) by less
 *   than 4 MB over the run.
 * `--maps a,b,...` opens those maps in turn instead (distinct maps: the packages each left level held are unloaded, so the bytes held
 * stay bounded by the level and the released budget) and reports the readings without the round-trip checks.
 *
 * Slow (about two minutes a round trip): not part of the sweep (run-validators.mjs SWEEP_EXCLUDED); run it by hand.
 *   node scripts/validate-process-memory.mjs [--repeat 10] [--slope 1.5] [--maps 01_NYC_UNATCOHQ,02_NYC_BatteryPark,...] */
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import './census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { loadAssets, typeLine } from './chain-play.mjs';
import { openSession } from './census-stage5-session.mjs';

const NAME = 'validate-process-memory';
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const repeat = Number(option('repeat', 10)), slope = Number(option('slope', 1.5));
const distinct = option('maps', null)?.split(',').filter(Boolean) ?? null;
try { gameDirectory(); } catch { console.log(`SKIP ${NAME}: no installed game data`); process.exit(0); }
v8.setFlagsFromString('--expose_gc');
const collectGarbage = runInNewContext('gc');

const assets = await loadAssets();
let session = null;
const readings = [];
const reading = async label => {
  const runtime = session.c.runtime, process_ = runtime.process, graph = process_.classLoader.graph;
  let exportRecords = 0;
  for (const linker of graph.linkers.values()) for (const entry of linker.exports) if (entry.object) exportRecords++;
  for (let i = 0; i < 3; i++) { collectGarbage(); await new Promise(resolve => setImmediate(resolve)); }
  const memory = process.memoryUsage();
  const row = { label, heapMB: memory.heapUsed / 1e6, arrayBuffersMB: memory.arrayBuffers / 1e6,
    state: { classes: process_.classes.size, identities: process_.packageObjects.size, exportRecords, tracked: process_.classLoader.originalLoads.size,
      registry: process_.resources?.resources.size ?? 0, packages: [...assets.ready.keys()].sort().join(' ') },
    releasedMB: assets.releasedBytes / 1e6 };
  readings.push(row);
  console.log(`  ${label}: heap ${row.heapMB.toFixed(1)} MB, ArrayBuffers ${row.arrayBuffersMB.toFixed(1)} MB (released ${row.releasedMB.toFixed(1)} MB), ` +
    `${row.state.classes} classes, ${row.state.identities} identities, ${row.state.exportRecords} export records, ${row.state.registry} registry records, ${assets.ready.size} packages`);
  return row;
};
const travel = async map => {
  typeLine(session.c, `open ${map}`);
  let request = null;
  for (let i = 0; i < 10 && !request; i++) { session.c.frames(1); request = session.c.takeTravel(); }
  if (!request) throw new Error(`open ${map} made no travel request`);
  session.dispose(); session = null;
  for (let i = 0; i < 2; i++) await new Promise(resolve => setImmediate(resolve));
  session = await openSession(request.map, assets, { travel: { snapshotSource: () => null, arrival: request, lastURL: request.lastURL } });
  session.c.frames(60);
};

session = await openSession('DX', assets, { travel: { snapshotSource: () => null } });
session.c.frames(60);
await reading('DX');
typeLine(session.c, 'set LevelInfo bPlayersOnly True');
const failures = [];
if (distinct) {
  for (const map of distinct) { await travel(map); await reading(map); }
} else {
  const trainings = [];
  await travel('00_Training');
  trainings.push(await reading('00_Training'));
  for (let round = 1; round <= repeat; round++) {
    await travel('01_NYC_UNATCOIsland');
    await reading(`01_NYC_UNATCOIsland (${round})`);
    await travel('00_Training');
    trainings.push(await reading(`00_Training (${round})`));
  }
  const steady = trainings.slice(1);
  for (const row of steady.slice(1)) {
    const differ = Object.keys(row.state).filter(key => row.state[key] !== steady[0].state[key]);
    if (differ.length) failures.push(`${row.label}: ${differ.map(key => `${key} ${JSON.stringify(steady[0].state[key])} -> ${JSON.stringify(row.state[key])}`).join('; ')}`);
  }
  const perTrip = (steady.at(-1).heapMB - steady[0].heapMB) / Math.max(1, steady.length - 1);
  if (perTrip >= slope) failures.push(`the heap grows ${perTrip.toFixed(2)} MB per round trip (bound ${slope})`);
  const buffers = steady.at(-1).arrayBuffersMB - steady[0].arrayBuffersMB;
  if (buffers >= 4) failures.push(`ArrayBuffers grow ${buffers.toFixed(1)} MB over ${steady.length - 1} round trips`);
  if (steady.some(row => row.releasedMB > assets.releasedBudget / 1e6)) failures.push('the released bytes exceed their budget');
  console.log(`  steady state: the heap ${perTrip >= 0 ? 'grows' : 'shrinks'} ${Math.abs(perTrip).toFixed(2)} MB per round trip, ArrayBuffers ${buffers.toFixed(1)} MB over ${steady.length - 1}`);
}
session.dispose();
if (failures.length) { console.log(`FAIL ${NAME}:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log(distinct ? `PASS ${NAME}: ${distinct.length} distinct maps in one process (readings above)`
  : `PASS ${NAME}: ${repeat} Island and Training round trips in one process hold the same process state at each Training arrival, the heap grows under ${slope} MB per round trip and the packages' bytes stay flat`);
process.exit(0);
