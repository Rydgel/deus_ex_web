/** A restored level's non-actor objects across repeated visits (docs/travel.md "Play, step 3"), headless, on the Training pair.
 *
 * Mission 4's chain stopped Play on the fourth entry into 04_NYC_Street (`Package identity was already resolved: 04_nyc_street.deusexgoal0`): Play filed every
 * object a restore had made, reached or not, with the package as Outer, so each leave filed the previous visit's goals again (dead since the arrival:
 * DeusExGameInfo.Login's ResetPlayerToDefaults unlinked them from the re-possessed pawn and the travel import gave it new ones) and two such sets named
 * DeusExGoal0 met in one file. The original's SavePackage(GLevel->GetOuter(), GLevel, 0)
 * exports only what the Level reaches: in the 257 saved levels of .work/travel and .work/internet-saves every DeusExGoal, DeusExNote, NanoKeyInfo, ConHistory,
 * ConHistoryEvent, DeusExLog, DataVaultImageNote and Flag* export is referenced by another export's tagged property (level-save.mjs).
 *
 * The run: 00_Training (goals added through the original DeusExPlayer.AddGoal), LocalTravel to 00_TrainingCombat and back three times, so Training is
 * entered cold and then restored three times (the chain's Street: legs 3, 5, 7 and 9). After each leave, Save\Current\00_training.dxs:
 *   - no two exports share a path (what the restore's identity binding requires);
 *   - its DeusExGoal exports are the player's goal list when it left, no more (the file's count against the live FirstGoal..next chain);
 *   - every goal, note and conversation-history export is referenced by another export's tagged object property (the original files' invariant).
 * After each arrival: the player's goals (name, text, primary, completed) are the ones that left, in order.
 * God mode at the arrivals: a fresh level's player is a new pawn (ReducedDamageType '' whatever the last level's was: not a travel property); a restored
 * level's player is the saved pawn re-possessed (GameInfo.Login's PawnList match; measured: the chain-m15e1 capture's arrival into the filed
 * 15_Area51_final logs `Possessed PlayerPawn: JCDentonMale 15_Area51_final.JCDentonMale2`), so it has the ReducedDamageType it was filed with: no script
 * writes the property but God and an armor's protection (Engine/PlayerPawn.uc, Engine/Inventory.uc; ResetPlayerToDefaults leaves it). The restored case is derived (the measured arrival's
 * pawn was filed without God mode, so it shows the re-possession, not God kept): labelled, not measured.
 *
 *   node scripts/validate-travel-restore-objects.mjs */
import { readdir, readFile } from 'node:fs/promises';
import '../scripts/census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { openSession } from './census-stage5-session.mjs';
import { createSaveDirectory } from '../src/runtime/save-directory.mjs';
import { parsePackage } from '../src/unreal/package.mjs';
import { readObject } from '../src/unreal/objects.mjs';

let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-travel-restore-objects: no installed game data'); process.exit(0); }
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };

const A = '00_Training', B = '00_TrainingCombat', FILE = '00_training.dxs';
const SCRIPT_OBJECTS = /^(DeusExGoal|DeusExNote|NanoKeyInfo|ConHistory|ConHistoryEvent)$/;
const NATIVE_PAYLOADS = /^(Level|Model|Polys|LevelSummary|EventManager|AIEventType|AISenderEvent|AIReceiverEvent)$/;
const directory = createSaveDirectory();
let session = null;
/** The next level's session replaces the last one (census-stage5-session.mjs dispose, as chain-play.mjs does). */
async function open(map, travel) {
  session?.dispose();
  session = null;
  for (let i = 0; i < 2; i++) await new Promise(resolve => setImmediate(resolve));
  session = await openSession(map, assets, { travel, saveDirectory: directory });
  return session.c;
}
const goalsOf = c => {
  const list = [];
  for (let goal = c.read(c.player(), 'FirstGoal'); goal && list.length < 64; goal = c.read(goal, 'next'))
    list.push(`${c.read(goal, 'goalName')}|${c.read(goal, 'text')}|${Number(c.read(goal, 'bPrimaryGoal'))}|${Number(c.read(goal, 'bCompleted'))}`);
  return list;
};
const rdt = c => { const value = String(c.read(c.player(), 'ReducedDamageType') ?? 'None'); return value === 'None' ? '' : value; };   // NAME_None reads 'None'
const call = (c, name, args) => c.game.hud.scoped(() => c.runtime.callFunction(c.runtime.lookup(c.player(), name), c.player(), args.length, i => args[i]));
function addGoal(c, name, text, primary) {
  const goal = call(c, 'AddGoal', [name, primary]);
  if (!goal) throw new Error(`AddGoal(${name}) returned None`);
  c.game.hud.scoped(() => c.runtime.callFunction(c.runtime.lookup(goal, 'SetText'), goal, 1, () => text));
}
const god = c => { c.runtime.writeNamed(c.player(), 'bCheatsEnabled', true); c.exec('God'); c.frames(2); };

/** The filed level against the original's invariants. */
function checkFile(tag, liveGoals) {
  const bytes = directory.readFile('Current', FILE);
  if (!check(bytes, `${tag}: Current holds no ${FILE}`)) return;
  const pkg = parsePackage(bytes);
  const paths = new Map();
  for (const entry of pkg.exports) paths.set(entry.path.toLowerCase(), (paths.get(entry.path.toLowerCase()) ?? 0) + 1);
  const twice = [...paths].filter(([, n]) => n > 1).map(([path]) => path);
  check(!twice.length, `${tag}: exports share a path: ${twice.slice(0, 8).join(', ')}`);
  const goals = pkg.exports.filter(entry => entry.className === 'DeusExGoal');
  check(goals.length === liveGoals.length, `${tag}: the file holds ${goals.length} DeusExGoal (${goals.map(g => g.path).join(', ')}), the player had ${liveGoals.length}`);
  const referenced = new Set();
  pkg.exports.forEach((entry, i) => {
    if (!entry.serialSize || NATIVE_PAYLOADS.test(entry.className)) return;
    for (const property of readObject(pkg, bytes, i + 1).properties)
      if ((property.type === 5 || property.type === 8) && property.value > 0) referenced.add(property.value);
  });
  const objects = pkg.exports.map((entry, i) => ({ entry, index: i + 1 })).filter(({ entry }) => SCRIPT_OBJECTS.test(entry.className));
  const loose = objects.filter(({ index }) => !referenced.has(index)).map(({ entry }) => entry.path);
  check(!loose.length, `${tag}: exports no export references (the original files none): ${loose.slice(0, 8).join(', ')}`);
  console.log(`${tag}: ${pkg.exports.length} exports, ${goals.length} goals (${goals.map(g => g.path).join(' ')}), ${objects.length} script objects, ${twice.length} shared paths, ${loose.length} unreferenced`);
}
function leave(c, tag, to) {
  const goals = goalsOf(c);
  c.exec(`LocalTravel ${to}`);
  c.frames(2);
  const request = c.takeTravel();
  if (!request) throw new Error(`${tag}: no travel request`);
  return { request, goals };
}
function arrive(c, tag, left, damage) {
  const goals = goalsOf(c);
  check(JSON.stringify(goals) === JSON.stringify(left.goals), `${tag}: the player's goals ${JSON.stringify(goals)}, ${JSON.stringify(left.goals)} left`);
  check(rdt(c) === damage, `${tag}: ReducedDamageType '${rdt(c)}' at the arrival, expected '${damage}'`);
  console.log(`${tag}: ${goals.length} goals, ReducedDamageType '${rdt(c)}'`);
}

let c = await open(A, {});
c.frames(90);
addGoal(c, 'ValidatorGoalOne', 'Goal one', true);
addGoal(c, 'ValidatorGoalTwo', 'Goal two', false);
god(c);                                                              // the pawn Training files has God mode on
// Each leg: the level the player goes to, ReducedDamageType expected at the arrival, then a goal added and God toggled there before the next leg.
const legs = [
  { tag: 'A -> B (cold)', to: B, damage: '' },                                                        // a new pawn: God mode is not a travel property
  { tag: 'B -> A (restored 1)', to: A, damage: 'All', goal: 'ValidatorGoalThree', toggle: true },     // the filed pawn had it; then off
  { tag: 'A -> B (restored 1)', to: B, damage: '', toggle: true },                                    // B's pawn was filed without it; then on
  { tag: 'B -> A (restored 2)', to: A, damage: '', goal: 'ValidatorGoalFour' },                       // B's God mode stays in B
  { tag: 'A -> B (restored 2)', to: B, damage: 'All' },                                               // B's pawn was filed with it
  { tag: 'B -> A (restored 3)', to: A, damage: '' },                                                  // the chain's fourth Street entry
];
for (const [i, leg] of legs.entries()) {
  const left = leave(c, leg.tag, leg.to);
  if (leg.to === B) checkFile(`leave ${i + 1} (${A} filed)`, left.goals);
  try { c = await open(left.request.map, { arrival: left.request, lastURL: left.request.lastURL }); }
  catch (error) { check(false, `${leg.tag}: the level does not open: ${error.message}`); break; }
  c.frames(30);
  check(Boolean(left.request.restore) === leg.tag.includes('restored'), `${leg.tag}: the request's restore is ${Boolean(left.request.restore)}`);
  arrive(c, leg.tag, left, leg.damage);
  if (leg.goal) addGoal(c, leg.goal, `${leg.goal} text`, false);
  if (leg.toggle) god(c);
}
session?.dispose();
if (failures.length) { console.log(`FAIL validate-travel-restore-objects:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log('PASS validate-travel-restore-objects: each filed Training holds the goals the player left with and only reached objects, under distinct paths; the goals and God mode arrive as the original carries them');
process.exit(0);
