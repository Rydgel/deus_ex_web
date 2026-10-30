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
 *   LightSwitch0's ScaleGlow (Training's own class, collected on the Island) reads its package default 1 in Training again;
 * - resources (migration step 4b): of the resources both hold before a map change (textures, sounds, meshes, fonts, music, palettes, keyed
 *   by package, class, group and name), the original's collected ones are new generations or gone in Play (its graph record and registry
 *   record), and its kept ones are the same records;
 * - packages: of the top-level packages both hold before a map change (Play: a graph linker, a registry record or an identity of the
 *   package, or the level), Play unloads the ones the original unloads and keeps the others;
 * - spawned names (migration step 5, one LoadMap per arrival): MakeUniqueObjectName's per-class counters live with the process's classes,
 *   so Play's live Shadow, NanoKeyRing, AugmentationManager, SkillManager, BarkManager and LaserProxy names are among the dump's (which also
 *   lists actors destroyed and not yet collected) and the highest number is the dump's (Shadow 1..19, 20..72, 73..91).
 *
 *   node scripts/validate-process-collection.mjs [--captures .work/travel/gc2] */
import {exportsHaveObject} from '../src/runtime/linker-exports.mjs';
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
const RESOURCE_KINDS = new Set(['Texture', 'Palette', 'Sound', 'Music', 'LodMesh', 'Mesh', 'Font', 'FireTexture', 'WaterTexture', 'WaveTexture', 'WetTexture',
  'IceTexture', 'FractalTexture', 'ScriptedTexture']);
// Packages whose lifetime Play does not model, each with its reason: the comparison leaves them out.
const UNMODELLED_PACKAGES = new Map();
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
// the original's resources and top-level packages at a stop: "package|class|group|name" -> ptr, and the set of package names
const dumpObjects = stop => {
  const rows = new Map();
  for (const line of readFileSync(join(captures, `${stop}.gflags.txt`), 'utf8').split('\n')) {
    const m = /^slot\s+\d+ index\s+\d+ (\S+?)\.(\S+) ptr (0x\w+) flags 0x\w+ outer (0x\w+)/.exec(line);
    if (m) rows.set(m[3], { cls: m[1], name: m[2], outer: m[4] });
  }
  const resources = new Map(), packages = new Set();
  for (const [ptr, row] of rows) {
    if (row.outer === '0x00000000') { if (row.cls === 'Package') packages.add(row.name.toLowerCase()); continue; }
    if (!RESOURCE_KINDS.has(row.cls)) continue;
    let top = row, group = '';
    const outer = rows.get(row.outer);
    if (outer && outer.outer !== '0x00000000') group = outer.name;
    for (let i = 0; i < 64 && top.outer !== '0x00000000'; i++) top = rows.get(top.outer) ?? { name: '?', outer: '0x00000000' };
    resources.set(`${top.name}|${row.cls}|${group}|${row.name}`.toLowerCase(), ptr);
  }
  return { resources, packages };
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
// the resources Play holds at a stop: "package|class|group|name" -> {graph, registry} (the graph's record the tracker holds, the registry's)
const playResources = () => {
  const loader = session.c.runtime.classLoader, graph = loader.graph, out = new Map();
  const kindOf = record => graph.nameText(graph.slotOf(graph.classRecordOf(record), 0x20));
  const keyOf = (pkg, kind, group, name) => `${pkg}|${kind}|${group}|${name}`.toLowerCase();
  for (const record of loader.originalLoads.held()) {
    const kind = kindOf(record);
    if (!RESOURCE_KINDS.has(kind)) continue;
    const linker = graph.slotOf(record, 0x10), entry = linker?.asset?.pkg.exports.at(graph.slotOf(record, 0x14));
    if (!entry) continue;
    const path = entry.path.split('.');
    const key = keyOf(linker.asset.name, kind, path.length > 1 ? path.at(-2) : '', path.at(-1));
    out.set(key, { ...out.get(key), graph: record });
  }
  for (const resource of session.c.runtime.process.resources?.resources.values() ?? []) {
    if (!RESOURCE_KINDS.has(resource.kind)) continue;
    const path = resource.path.split('.');
    const key = keyOf(resource.asset.name, resource.kind, path.length > 1 ? path.at(-2) : '', path.at(-1));
    out.set(key, { ...out.get(key), registry: resource });
  }
  return out;
};
// the top-level packages Play's process holds at a stop: a graph linker with a loaded export, a registry record, an identity, or the asset
// store's bytes (a level's texture packages: the world reads them)
const STOP_LEVELS = { dx: 'dx', training: '00_training', island: '01_nyc_unatcoisland', training2: '00_training' };
const playPackages = stop => {
  const process = session.c.runtime.process, graph = process.classLoader.graph, out = new Set();
  for (const [name, linker] of graph.linkers) if (exportsHaveObject(linker.exports)) out.add(name);
  for (const resource of process.resources?.resources.values() ?? []) if (resource.asset?.name) out.add(resource.asset.name.toLowerCase());
  for (const identity of process.packageObjects.values()) if (identity.asset?.name) out.add(identity.asset.name.toLowerCase());
  for (const name of process.assets.ready.keys()) out.add(name);
  out.add(STOP_LEVELS[stop]);   // the level's linker is live
  return out;
};
const stops = new Map();
// spawned names at a stop: class -> the numbers of its objects named <Class><N>, in the dump and among Play's live actors
const NAMED = ['Shadow', 'NanoKeyRing', 'AugmentationManager', 'SkillManager', 'BarkManager', 'LaserProxy'];
const dumpNames = stop => {
  const text = readFileSync(join(captures, `${stop}.gflags.txt`), 'utf8'), out = {};
  for (const cls of NAMED) out[cls] = [...text.matchAll(new RegExp(`^slot +\\d+ index +\\d+ ${cls}\\.${cls}(\\d+) `, 'gm'))].map(m => Number(m[1]));
  return out;
};
const playNames = () => Object.fromEntries(NAMED.map(cls => [cls, session.c.byClass(cls).map(actor => Number(/(\d+)$/.exec(String(actor?.name ?? ''))?.[1] ?? NaN))]));
const takeStop = stop => {
  const play = playClasses(), original = dumpClasses(stop);
  const names = { play: playNames(), original: dumpNames(stop) };
  for (const cls of NAMED) {
    const mine = names.play[cls], theirs = new Set(names.original[cls]);
    const ok = mine.every(n => theirs.has(n)) && (!mine.length || Math.max(...mine) === Math.max(...theirs));
    check(ok, `${stop}: ${cls} names ${JSON.stringify(mine.sort((a, b) => a - b))} in Play, the original's ${JSON.stringify([...theirs].sort((a, b) => a - b))}`);
  }
  notes.push(`${stop}: Shadow ${(n => n.length ? `${Math.min(...n)}..${Math.max(...n)}` : 'none alive')(names.play.Shadow)}, LaserProxy ${(n => n.length ? `${Math.min(...n)}..${Math.max(...n)}` : 'none')(names.play.LaserProxy)}, AugmentationManager ${names.play.AugmentationManager.join(',')}`);
  stops.set(stop, { play, original, resources: playResources(), packages: playPackages(stop), dump: dumpObjects(stop) });
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
// resources and packages, at each map change
for (let i = 1; i < STOPS.length; i++) {
  const a = stops.get(STOPS[i - 1]), b = stops.get(STOPS[i]), label = `${STOPS[i - 1]} -> ${STOPS[i]}`;
  if (!a || !b) continue;
  const wrong = [];
  let kept = 0, collected = 0;
  for (const [key, ptr] of a.dump.resources) {
    const before = a.resources.get(key);
    if (!before) continue;
    const originalKept = b.dump.resources.get(key) === ptr, after = b.resources.get(key);
    const same = Boolean(after) && ['graph', 'registry'].every(side => !before[side] || !after[side] || before[side] === after[side]) &&
      ['graph', 'registry'].some(side => before[side] && before[side] === after[side]);
    if (originalKept && !same) wrong.push(`${key} (kept in the original, ${after ? 'a new generation' : 'collected'} in Play)`);
    if (!originalKept && same) wrong.push(`${key} (collected in the original, kept in Play)`);
    if (originalKept) kept++; else collected++;
  }
  check(!wrong.length, `${label}: ${wrong.length} resources whose fate differs: ${wrong.slice(0, 12).join(' ')}`);
  notes.push(`${label}: of the resources both hold, ${kept} kept and ${collected} collected, in both`);
  const both = [...a.packages].filter(name => a.dump.packages.has(name) && !UNMODELLED_PACKAGES.has(name));
  const differ = both.filter(name => b.dump.packages.has(name) !== b.packages.has(name));
  check(!differ.length, `${label}: packages held differently: ${differ.map(name => `${name} (${b.dump.packages.has(name) ? 'kept' : 'unloaded'} in the original)`).join(' ')}`);
  notes.push(`${label}: of the ${both.length} packages both hold, the original and Play unload ${both.filter(name => !b.dump.packages.has(name)).sort().join(', ') || 'none'}`);
}
for (const [name, reason] of UNMODELLED_PACKAGES) notes.push(`not compared: package ${name}, ${reason}`);
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
console.log(`PASS ${NAME}: over gc2's DX.dx, 00_Training, 01_NYC_UNATCOIsland and 00_Training in one process, Play holds the original's classes at each stop, each map change collects the original's and keeps the original's generations, the SETs survive or revert as the original's do, and spawned objects take the original's names`);
process.exit(0);
