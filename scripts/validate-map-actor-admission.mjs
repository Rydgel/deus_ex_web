/** Standalone map-actor admission: the two `ULinkerLoad::CreateExport` gates
 * (docs/script-create-export.md) applied to the real Training map.
 *
 * - `0x1012e278`-`0x1012e283`: `Export.ObjectFlags & ContextFlags` — the local
 *   game linker runs with GIsClient|GIsServer (0x30000), so exports carrying
 *   only RF_LoadForEdit are refused before construction.
 * - `0x1012e2fd`-`0x1012e318`: `LoadClass->Name == NAME_Camera` — refused
 *   regardless of flags.
 *
 * A refused export is never constructed: its `Level.Actors` slot resolves to
 * null, it never joins PawnList or the collision hash, and its startup —
 * including `Pawn.PreBeginPlay`'s `PlayerReplicationInfo` spawn for the
 * PlayerPawn-ancestry cameras — never runs. Evidence:
 * docs/script-map-actors.md, docs/script-npc-startup-animation.md. */
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {mapExportAdmitted} from '../src/runtime/script-map-properties.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({path: path.join(directory, name), read: () => readFile(path.join(root, directory, name))});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const map = decodeMap(asset.bytes);

// ---- Gate semantics on synthetic exports -------------------------------
// ContextFlags gate: RF_LoadForEdit-only flags refuse any class.
assert.equal(mapExportAdmitted({exports: [{flags: 0x2340000, className: 'Actor'}]}, 1), false,
  'an RF_LoadForEdit-only export is refused regardless of class');
// NAME_Camera gate: a Camera-class export is refused even with flags that
// would otherwise pass the standalone context.
assert.equal(mapExportAdmitted({exports: [{flags: 0x30000, className: 'Camera'}]}, 1), false,
  'the NAME_Camera gate refuses a flag-admitted Camera-class export');
assert.equal(mapExportAdmitted({exports: [{flags: 0x30000, className: 'Pawn'}]}, 1), true,
  'a flag-admitted non-Camera export is constructed');
assert.throws(() => mapExportAdmitted({exports: []}, 5), /Invalid map export/,
  'an out-of-range reference is still an error, not a refused export');

// ---- Real Training census ----------------------------------------------
// The serialized Level.Actors array splits exactly into the standalone
// load's admitted and refused sets — no name list is consulted.
const refusedClasses = new Map();
let serializedLive = 0, serializedNull = 0;
for (const ref of map.level.actors) {
  if (ref === 0) { serializedNull++; continue; }
  if (mapExportAdmitted(map.pkg, ref)) serializedLive++;
  else {
    const cls = map.pkg.exports[ref - 1].className;
    refusedClasses.set(cls, (refusedClasses.get(cls) ?? 0) + 1);
  }
}
assert.deepEqual([...refusedClasses].sort(), [['Brush', 992], ['Camera', 4]],
  'standalone Training refuses exactly the Brush and Camera exports');
assert.equal(serializedLive, 312, 'admitted serialized actor count');

// ---- Live integration ----------------------------------------------------
const game = await createGame(map, asset, assets, {randomSeed: 1});
const {runtime, npcPawns, npcFailures} = game.doors.scriptRuntime;
const level = runtime.levelFor(game.player.collisionActor);
const clsKey = actor => {
  try { return runtime.instance(actor).cls.record.key; } catch { return null; }
};
const priCount = () => level.actors.filter(a => a && clsKey(a) === 'engine.playerreplicationinfo').length;

function assertAdmission(label) {
  // The LoadMap tail (Engine.dll 0x1038dcd5) rebuilds Level.Actors after
  // startup: slots 0 and 1 copy verbatim, then every non-null static actor in
  // original order, then every non-null dynamic actor. Refused-export nulls
  // and actors destroyed mid-startup are compacted out, so the live array no
  // longer maps 1:1 onto the serialized slots — the checks below assert the
  // partition's real invariants instead of positional correspondence.
  const mapRefs = new Set(map.level.actors.filter(ref => ref !== 0));
  const live = level.actors.filter(actor => actor);
  const byIndex = new Map(live.filter(actor => Number.isInteger(actor.index)).map(actor => [actor.index, actor]));
  // Refused and zero-ref exports were never constructed: no live actor binds
  // their export index. Admitted actors keep their identity in the array.
  for (let slot = 0; slot < map.level.actors.length; slot++) {
    const ref = map.level.actors[slot];
    if (ref === 0 || !mapExportAdmitted(map.pkg, ref)) {
      assert.equal(byIndex.has(ref), false,
        `${label}: slot ${slot} (${map.pkg.exports[ref - 1]?.name ?? 'zero'}) never joins the live array`);
    } else if (map.pkg.exports[ref - 1].className === 'PickupDistributor') {
      // Original PickupDistributor.PostPostBeginPlay distributes keys then Destroy().
      assert.equal(byIndex.has(ref),false,`${label}: distributor destroyed after startup`);
    } else if (map.pkg.exports[ref - 1].name === 'UNATCOTroop2' && !byIndex.has(ref)) {
      // UNATCOTroop2 is Training's Test_Subject. On fresh mission entry the
      // first Mission00 timer (about 1 s) runs FirstFrame, which knocks it
      // out; ScriptedPawn.Dying then spawns its carcass and destroys the pawn
      // (docs/script-training-mission-entry.md). Once retired, its original
      // carcass must be present instead.
      assert.equal(level.actors.filter(a => a && clsKey(a) === 'deusex.unatcotroopcarcass').length, 1,
        `${label}: retired Test_Subject left exactly one original carcass`);
    } else {
      assert.equal(byIndex.get(ref)?.index, ref, `${label}: slot ${slot} (${map.pkg.exports[ref - 1].name}) keeps its actor`);
    }
  }
  // Head: slots 0 and 1 are copied verbatim (slot 1 keeps its null).
  assert.equal(level.actors[0], byIndex.get(map.level.actors[0]) ?? null, `${label}: slot 0 is the serialized LevelInfo`);
  assert.equal(level.actors[1] ?? null, map.level.actors[1] ? byIndex.get(map.level.actors[1]) ?? null : null,
    `${label}: slot 1 is verbatim`);
  // Tail: every actor at index >= 2 with a serialized bStatic lands before the
  // iFirstNetActor boundary; the rest are dynamic, in original relative order.
  const isStatic = actor => { try { return Boolean(runtime.namedReference(actor, 'bStatic').get()); } catch { return false; } };
  const firstNet = level.iFirstNetActor;
  assert.equal(Number.isInteger(firstNet), true, `${label}: iFirstNetActor recorded`);
  // ULevel::DestroyActor leaves a null slot; Login's ResetPlayerToDefaults
  // destroys the first NanoKeyRing after the LoadMap tail ran.
  const tail = level.actors.slice(2).filter(Boolean);
  const serializedTail = tail.filter(actor => mapRefs.has(actor.index));
  const expected = serializedTail.filter(isStatic).concat(serializedTail.filter(actor => !isStatic(actor)));
  assert.deepEqual(serializedTail, expected, `${label}: statics precede dynamics preserving serialized order`);
  // Dynamic-section tail order: map actors precede runtime spawns (which were
  // appended after the serialized entries pre-partition).
  const dynamicTail = level.actors.slice(firstNet).filter(Boolean);
  const lastMapIndex = dynamicTail.reduce((last, actor, i) => mapRefs.has(actor.index) ? i : last, -1);
  const firstSpawnIndex = dynamicTail.findIndex(actor => !mapRefs.has(actor.index));
  assert.ok(firstSpawnIndex === -1 || firstSpawnIndex > lastMapIndex,
    `${label}: runtime-spawned actors stay after serialized dynamics`);
  // No refused export can be a live pawn, collidable or mover: it was never
  // constructed, so it cannot join PawnList or the collision hash.
  for (const pawn of npcPawns)
    assert.equal(mapExportAdmitted(map.pkg, pawn.index), true, `${label}: ${pawn.name} is an admitted pawn`);
  for (let p = level.pawnList; p; p = p.nextPawn)
    if (p !== game.player.collisionActor)
      assert.equal(mapExportAdmitted(map.pkg, p.index), true, `${label}: PawnList ${p.name} is admitted`);
  for (const actor of [...game.collision.actors, ...game.collision.movers])
    if (Number.isInteger(actor.index))
      assert.equal(mapExportAdmitted(map.pkg, actor.index), true, `${label}: collidable ${actor.name} is admitted`);
  // The map's only PlayerPawns are the refused editor cameras, so its one
  // PlayerReplicationInfo is the Login player's — nothing spawned a PRI for an
  // unadmitted actor.
  assert.equal(priCount(), 1, `${label}: only the Login player's PlayerReplicationInfo exists`);
  const pri = level.actors.find(a => a && clsKey(a) === 'engine.playerreplicationinfo');
  assert.equal(runtime.namedReference(pri, 'Owner').get(), game.player.collisionActor, `${label}: the PRI is the player's`);
  // Every recorded startup/tick boundary belongs to an admitted actor; a
  // refused export can never reach startup to fail.
  for (const [actor] of npcFailures)
    assert.equal(mapExportAdmitted(map.pkg, actor.index), true,
      `${label}: failing actor ${actor.name} is admitted (no refused export reaches startup)`);
}

assertAdmission('load');
for (let i = 0; i < 300; i++) game.tick(1 / 60, {});
assertAdmission('300 ticks');
for (let run = 1; run <= 2; run++) {
  game.reset();
  for (let i = 0; i < 60; i++) game.tick(1 / 60, {});
  assertAdmission(`reset ${run}`);
}

console.log('Map actor admission passed: the standalone CreateExport gates refuse Training\'s 992 Brush ' +
  'and 4 Camera exports; their Level.Actors slots resolve to null, they never join PawnList/collision/' +
  'startup, the only PlayerReplicationInfo is the Login player\'s, and two resets preserve the partition. ' +
  `Boundaries recorded only for admitted actors (${npcFailures.size} total).`);
