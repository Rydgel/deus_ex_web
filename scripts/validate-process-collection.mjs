/** LoadMap's collection over the process's classes (docs/class-graph-design.md, migration step 4a; script-process-collection.mjs),
 * against the original's registry dumps of the probe gc2 (`.work/travel/gc2`, outside Git; docs/class-lifetime.md "Frozen arrivals
 * and class defaults: gc2"). Play replays gc2's steps in one script process (census-stage5-session.mjs openSession: each travel
 * arrival attaches to the process of the level left): DX, `set LevelInfo bPlayersOnly True`, `open 00_Training`, the two SETs,
 * `open 01_NYC_UNATCOIsland`, `open 00_Training`.
 *
 * Checks, at each of the dump's stops (DX.dx, Training, the Island, Training again):
 * - the classes Play holds (the original-loaded tracker's, original-loaded.mjs) are the dump's, but for the classes a DLL registered
 *   and never loaded (flags without the 0x70000 load-context bits);
 * - each map change keeps, collects and loads the dump's classes;
 * - generations: a class the original holds at every stop between two stops, at one address, is the same class in Play (its graph
 *   record, so its Defaults and ClassUnique counter); one the original collected in between is a new generation in Play too (Training's
 *   own classes on the return);
 * - the SETs typed in Training: PathNode's ExtraCost (a native class, kept) reads 77 on the Island and in Training again, and
 *   LightSwitch0's ScaleGlow (Training's own class, collected on the Island) reads its package default 1 in Training again.
 *
 *   node scripts/validate-process-collection.mjs [--captures .work/travel/gc2] */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import './census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { loadAssets, typeLine } from './chain-play.mjs';
import { openSession } from './census-stage5-session.mjs';

const NAME = 'validate-process-collection';
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const captures = option('captures', '.work/travel/gc2');
const STOPS = ['dx', 'training', 'island', 'training2'];
// a class whose object came from its package carries the load context bits (RF_LoadForClient|Server|Edit); a registered one does not
const LOAD_CONTEXT = 0x00070000;

try { gameDirectory(); } catch { console.log(`SKIP ${NAME}: no installed game data`); process.exit(0); }
const missing = STOPS.map(stop => join(captures, `${stop}.gflags.txt`)).filter(file => !existsSync(file));
if (missing.length) { console.log(`SKIP ${NAME}: no original capture (${missing.join(', ')}; scripts/travel-probe.sh gc2)`); process.exit(0); }

const failures = [], notes = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };
// the original's classes at a stop: "package.class" -> {ptr, flags}
const dumpClasses = stop => {
  const out = new Map();
  for (const line of readFileSync(join(captures, `${stop}.gflags.txt`), 'utf8').split('\n')) {
    const m = /^slot\s+\d+ index\s+\d+ Class\.(\S+) ptr (0x\w+) flags 0x(\w+) outer 0x\w+ (\S*)/.exec(line);
    if (m) out.set(`${m[4]}.${m[1]}`.toLowerCase(), { ptr: m[2], flags: parseInt(m[3], 16) });
  }
  return out;
};

const assets = await loadAssets();
let session = null;
// the classes Play holds at a stop: "package.class" -> graph record
const playClasses = () => {
  const loader = session.c.runtime.classLoader, graph = loader.graph, out = new Map();
  for (const record of loader.originalLoads.held())
    if (graph.nameText(graph.slotOf(graph.classRecordOf(record), 0x20)) === 'Class') out.set(graph.fullName(record).toLowerCase(), record);
  for (const [key, record] of graph.staticRecords) if (!out.has(key.toLowerCase())) out.set(key.toLowerCase(), record);
  return out;
};
const stops = new Map();
const takeStop = stop => {
  const play = playClasses(), original = dumpClasses(stop);
  stops.set(stop, { play, original });
  const extra = [...play.keys()].filter(key => !original.has(key));
  const lacking = [...original].filter(([key, value]) => !play.has(key) && (value.flags & LOAD_CONTEXT)).map(([key]) => key);
  check(!extra.length, `${stop}: ${extra.length} classes Play holds that the original does not: ${extra.slice(0, 10).join(' ')}`);
  check(!lacking.length, `${stop}: ${lacking.length} loaded classes of the original that Play does not hold: ${lacking.slice(0, 10).join(' ')}`);
  const collection = session.c.runtime && session.collections?.();
  notes.push(`${stop}: Play holds ${play.size} classes, the original ${original.size}${collection ? `; ${collection}` : ''}`);
};
const frames = n => session.c.frames(n);
const travel = async map => {
  typeLine(session.c, `open ${map}`);
  let request = null;
  for (let i = 0; i < 10 && !request; i++) { frames(1); request = session.c.takeTravel(); }
  if (!request) throw new Error(`open ${map} made no travel request`);
  session.dispose(); session = null;
  for (let i = 0; i < 2; i++) await new Promise(resolve => setImmediate(resolve));
  session = await openSession(request.map, assets, { travel: { snapshotSource: () => null, arrival: request, lastURL: request.lastURL } });
  const doors = session.c.game.doors.scriptRuntime;
  session.collections = () => {
    const arrival = doors.arrivalCollection;
    return `collected at the arrival ${arrival?.purged ?? 0} records (${arrival?.classes.length ?? 0} classes)`;
  };
};
const readAll = (cls, field) => session.c.byClass(cls).map(actor => session.c.read(actor, field));

session = await openSession('DX', assets, { travel: { snapshotSource: () => null } });
frames(300);
takeStop('dx');
typeLine(session.c, 'set LevelInfo bPlayersOnly True');
await travel('00_Training');
frames(360);
takeStop('training');
typeLine(session.c, 'set Engine.PathNode ExtraCost 77');
typeLine(session.c, 'set DeusEx.LightSwitch ScaleGlow 0.25');
const trainingSet = { pathNode: readAll('PathNode', 'ExtraCost'), lightSwitch: readAll('LightSwitch', 'ScaleGlow') };
check(trainingSet.pathNode.length && trainingSet.pathNode.every(v => v === 77) && trainingSet.lightSwitch.every(v => v === Math.fround(0.25)),
  `the SETs in Training: ${JSON.stringify(trainingSet)}`);
await travel('01_NYC_UNATCOIsland');
frames(360);
takeStop('island');
const islandPathNodes = readAll('PathNode', 'ExtraCost');
check(islandPathNodes.length && islandPathNodes.every(v => v === 77), `the Island's PathNodes' ExtraCost: ${[...new Set(islandPathNodes)]} (the original: 77)`);
await travel('00_Training');
frames(360);
takeStop('training2');
const back = { pathNode: [...new Set(readAll('PathNode', 'ExtraCost'))], lightSwitch: [...new Set(readAll('LightSwitch', 'ScaleGlow'))] };
check(back.pathNode.length === 1 && back.pathNode[0] === 77 && back.lightSwitch.length === 1 && back.lightSwitch[0] === 1,
  `Training again: PathNode ExtraCost ${back.pathNode}, LightSwitch ScaleGlow ${back.lightSwitch} (the original: 77 and 1)`);
session.dispose();

for (let i = 1; i < STOPS.length; i++) {
  const a = stops.get(STOPS[i - 1]), b = stops.get(STOPS[i]), label = `${STOPS[i - 1]} -> ${STOPS[i]}`;
  if (!a || !b) continue;
  const loadedIn = map => new Set([...map].filter(([, value]) => value.flags & LOAD_CONTEXT).map(([key]) => key));
  const originalCollected = [...loadedIn(a.original)].filter(key => !b.original.has(key)).sort();
  const playCollected = [...a.play.keys()].filter(key => !b.play.has(key)).sort();
  check(JSON.stringify(originalCollected) === JSON.stringify(playCollected),
    `${label}: collected ${playCollected.length} in Play, ${originalCollected.length} in the original (differ: ${[...originalCollected.filter(k => !playCollected.includes(k)), ...playCollected.filter(k => !originalCollected.includes(k))].slice(0, 10).join(' ')})`);
  notes.push(`${label}: collected ${playCollected.length} (the original ${originalCollected.length})`);
}
// generations, over every pair of stops
for (let i = 0; i < STOPS.length; i++) for (let j = i + 1; j < STOPS.length; j++) {
  const between = STOPS.slice(i, j + 1).map(stop => stops.get(stop));
  if (between.some(stop => !stop)) continue;
  const [a, b] = [between[0], between.at(-1)], label = `${STOPS[i]} -> ${STOPS[j]}`, wrong = [];
  let kept = 0, renewed = 0;
  for (const [key, value] of b.original) {
    if (!a.original.has(key) || !a.play.has(key) || !b.play.has(key)) continue;
    const throughout = between.every(stop => stop.original.get(key)?.ptr === value.ptr);
    const collectedBetween = between.some(stop => !stop.original.has(key));
    if (!throughout && !collectedBetween) { wrong.push(`${key} (moved without a collection in the original)`); continue; }
    const playSame = a.play.get(key) === b.play.get(key);
    if (throughout && !playSame) wrong.push(`${key} (kept in the original, a new generation in Play)`);
    if (collectedBetween && playSame) wrong.push(`${key} (a new generation in the original, kept in Play)`);
    if (throughout) kept++; else renewed++;
  }
  check(!wrong.length, `${label}: ${wrong.length} classes whose generation differs: ${wrong.slice(0, 10).join(' ')}`);
  if (renewed) notes.push(`${label}: ${kept} classes kept, ${renewed} collected and loaded again as new generations, in both`);
}

for (const note of notes) console.log(`  ${note}`);
if (failures.length) { console.log(`FAIL ${NAME}:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log(`PASS ${NAME}: over gc2's DX.dx, 00_Training, 01_NYC_UNATCOIsland and 00_Training in one process, Play holds the original's classes at each stop, each map change collects the original's and keeps the original's generations, and the SETs survive or revert as the original's do`);
process.exit(0);
