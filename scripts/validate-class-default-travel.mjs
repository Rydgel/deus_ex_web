/** Class defaults across a travel (docs/travel.md "Class defaults across a travel"). The original keeps every class and its Defaults for the
 * process's life, so a console SET's class-default write (UObject::GlobalSetProperty, ImportText into Class->Defaults, Core 0x101524b1..0x101524ca)
 * is the default the next level is built from: LoadMap constructs the map's exports from it and applies their serialized properties over it, Login
 * spawns the player from it, and a loaded game's saved pawn (whose file omits a property equal to its default) gets it. Play builds a runtime per level,
 * so the travel request carries the written defaults (ScriptRuntime.classDefaultsForTravel) and the next runtime writes them into each class as the class
 * is serialized (ScriptClassLoader.applyCarriedDefaults).
 *
 * The run: the logo map DX (its player, a JCDentonMale; PlayerStart1), four SETs, `LocalTravel 00_Training`, then `SaveGame 7` and `LoadGame 7` there.
 *
 * Checks, in the arrival (a new session built from the request, as the page's worker and the chain harness build it):
 * - the request survives structuredClone (it crosses the page/worker boundary) and lists the written defaults;
 * - the player Login spawned has ReducedDamageType All (`set DeusEx.JCDentonMale ReducedDamageType All`; JCDentonMale is a script class);
 * - Training's PlayerStart1, which does not serialize ExtraCost, has the carried 55 (`set Engine.PlayerStart ExtraCost 55`; a native class), while
 *   PlayerStart1's serialized visitedWeight keeps the map's 10000000 over the carried default 4321 (`set Engine.PlayerStart visitedWeight 4321`):
 *   the carry is the class default exports are constructed from, not a write onto the instances;
 * - `set Engine.NavigationPoint ExtraCost 99`, typed after PlayerStart was linked: NavigationPoint's default is 99, PlayerStart keeps its own 55;
 *   a PathNode (a NavigationPoint subclass the logo map never linked) is serialized in Training from the carried NavigationPoint Defaults and has 99
 *   (Play's lazy class load; which subclasses the original had loaded before the SET is unverified: docs/travel.md);
 * - after SaveGame/LoadGame in Training, the loaded game's player (the saved pawn) still has ReducedDamageType All.
 *
 *   node scripts/validate-class-default-travel.mjs */
import './census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { loadAssets, typeLine } from './chain-play.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createSaveDirectory } from '../src/runtime/save-directory.mjs';

try { gameDirectory(); } catch { console.log('SKIP validate-class-default-travel: no installed game data'); process.exit(0); }
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };
const assets = await loadAssets();
const directory = createSaveDirectory();
let session = null, c = null;
// one level at a time, as the chain harness and the page's map host replace a session (census-stage5-session.mjs dispose)
const open = async (map, options) => {
  session?.dispose(); session = null; c = null;
  for (let i = 0; i < 2; i++) await new Promise(resolve => setImmediate(resolve));
  session = await openSession(map, assets, { saveDirectory: directory, ...options });
  c = session.c;
};
const linked = key => [...c.runtime.linkedClasses].find(cls => cls.record.key === key) ?? null;
const classDefault = (key, name) => {
  const cls = linked(key);
  if (!cls) return `(${key} not linked)`;
  return c.runtime.classDefaultReference(cls, c.runtime.lookupMember(cls, 'fields', name)).get();
};
const frames = (n, label) => {
  for (let i = 0; i < n; i++) { c.frames(1); const request = c.takeTravel(); if (request) return request; }
  throw new Error(`${label}: no travel request after ${n} frames`);
};
const arrive = async request => open(request.map, { travel: { snapshotSource: () => null, arrival: request, lastURL: request.lastURL } });

await open('DX', { travel: { snapshotSource: () => null } });
c.frames(60);
const before = {
  reducedDamageType: c.read(c.player(), 'ReducedDamageType'), extraCost: classDefault('engine.playerstart', 'ExtraCost'),
  visitedWeight: classDefault('engine.playerstart', 'visitedWeight'), navExtraCost: classDefault('engine.navigationpoint', 'ExtraCost'),
};
console.log('DX before', JSON.stringify(before));
check(before.reducedDamageType === 'None' && before.extraCost === 0 && before.navExtraCost === 0 && before.visitedWeight !== 4321,
  `the package defaults before the SETs: ${JSON.stringify(before)}`);
for (const line of ['set DeusEx.JCDentonMale ReducedDamageType All', 'set Engine.PlayerStart ExtraCost 55', 'set Engine.PlayerStart visitedWeight 4321',
  'set Engine.NavigationPoint ExtraCost 99']) { typeLine(c, line); c.frames(2); }
const dxStart = c.actor('PlayerStart1');
const dx = { player: c.read(c.player(), 'ReducedDamageType'), start: c.read(dxStart, 'ExtraCost'), startDefault: classDefault('engine.playerstart', 'ExtraCost'),
  navDefault: classDefault('engine.navigationpoint', 'ExtraCost') };
console.log('DX after the SETs', JSON.stringify(dx));
check(dx.player === 'All' && dx.start === 99 && dx.startDefault === 55 && dx.navDefault === 99, `the SETs in DX: ${JSON.stringify(dx)}`);

typeLine(c, 'LocalTravel 00_Training');
const toTraining = frames(10, 'LocalTravel 00_Training');
let cloned = null;
try { cloned = structuredClone(toTraining); } catch (error) { check(false, `the request does not survive structuredClone: ${error.message}`); }
const carried = new Map((toTraining.classDefaults ?? []).map(entry => [`${entry.cls} ${entry.field}`, JSON.stringify(entry.values)]));
console.log('carried', JSON.stringify([...carried]));
check(carried.get('deusex.jcdentonmale engine.pawn.reduceddamagetype') === '[[0,"All"]]', 'the request carries JCDentonMale ReducedDamageType All');
check(carried.get('engine.playerstart engine.navigationpoint.extracost') === '[[0,55]]', 'the request carries PlayerStart ExtraCost 55 (kept by PlayerStart when NavigationPoint was set)');
check(carried.get('engine.navigationpoint engine.navigationpoint.extracost') === '[[0,99]]', 'the request carries NavigationPoint ExtraCost 99');

await arrive(cloned ?? toTraining);
const trainingStart = c.actor('PlayerStart1');
const pathNode = c.byClass('PathNode')[0];
const training = {
  player: c.read(c.player(), 'ReducedDamageType'),
  startExtraCost: c.read(trainingStart, 'ExtraCost'), startVisitedWeight: c.read(trainingStart, 'visitedWeight'),
  startDefaultVisitedWeight: classDefault('engine.playerstart', 'visitedWeight'), startDefaultExtraCost: classDefault('engine.playerstart', 'ExtraCost'),
  navDefault: classDefault('engine.navigationpoint', 'ExtraCost'), pathNode: pathNode ? c.read(pathNode, 'ExtraCost') : null,
  pathNodeSerializesExtraCost: pathNode ? (pathNode.properties ?? []).some(p => p.name.toLowerCase() === 'extracost') : null,
  startSerializes: (trainingStart.properties ?? []).map(p => p.name),
};
console.log('00_Training arrival', JSON.stringify(training));
check(training.player === 'All', `Login's player in 00_Training has ReducedDamageType ${training.player} (expected All)`);
check(!training.startSerializes.some(name => name.toLowerCase() === 'extracost') && training.startExtraCost === 55,
  `Training's PlayerStart1 (ExtraCost not serialized) has ExtraCost ${training.startExtraCost} (expected the carried 55)`);
check(training.startSerializes.includes('visitedWeight') && training.startVisitedWeight === 10000000 && training.startDefaultVisitedWeight === 4321,
  `Training's PlayerStart1 keeps its serialized visitedWeight over the carried default: ${training.startVisitedWeight}, default ${training.startDefaultVisitedWeight}`);
check(training.navDefault === 99 && training.startDefaultExtraCost === 55, `NavigationPoint/PlayerStart ExtraCost defaults ${training.navDefault}/${training.startDefaultExtraCost} (expected 99/55)`);
check(training.pathNodeSerializesExtraCost === false && training.pathNode === 99, `a PathNode's ExtraCost ${training.pathNode} (expected 99, inherited from the carried NavigationPoint Defaults)`);

// a loaded game in the same process: the saved pawn's file omits ReducedDamageType (equal to its default when saved), and the class default it is loaded over is the carried All
c.frames(120);
c.game.hud.scoped(() => c.game.hud.host.consoleCommands.consoleCommand(c.player(), 'SaveGame 7'));
c.frames(5);
check(directory.files('Save0007').length > 0, 'SaveGame 7 wrote Save0007');
c.exec('LoadGame 7');
const loadGame = frames(10, 'LoadGame 7');
check(Boolean(loadGame.loadgame) && Array.isArray(loadGame.classDefaults), 'LoadGame 7 is a loaded game that carries the class defaults');
await arrive(loadGame);
const loaded = { player: c.read(c.player(), 'ReducedDamageType'), visitedWeightDefault: classDefault('engine.playerstart', 'visitedWeight') };
console.log('loaded game', JSON.stringify(loaded));
check(loaded.player === 'All', `the loaded game's player has ReducedDamageType ${loaded.player} (expected All)`);
check(loaded.visitedWeightDefault === 4321, `the loaded game's PlayerStart visitedWeight default ${loaded.visitedWeightDefault} (expected 4321)`);
session?.dispose();

if (failures.length) { console.log(`FAIL validate-class-default-travel:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log('PASS validate-class-default-travel: SET class defaults reach the next level (Login\'s player, unserialized map properties, a loaded game), serialized map properties keep the map\'s values');
