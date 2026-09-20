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
  // Serialized-slot correspondence: refused -> null, admitted -> the live
  // object bound to that export index. Runtime spawns append past the
  // serialized length and are out of this assertion's scope.
  assert.equal(level.actors.length >= map.level.actors.length, true, `${label}: spawned tail appends`);
  for (let slot = 0; slot < map.level.actors.length; slot++) {
    const ref = map.level.actors[slot], live = level.actors[slot];
    if (ref === 0 || !mapExportAdmitted(map.pkg, ref)) {
      assert.equal(live, null, `${label}: slot ${slot} (${map.pkg.exports[ref - 1]?.name ?? 'zero'}) resolves to null`);
    } else {
      assert.equal(live?.index, ref, `${label}: slot ${slot} (${map.pkg.exports[ref - 1].name}) keeps its actor`);
    }
  }
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
  // The map's only PlayerPawns are the refused editor cameras, so the map
  // itself contributes zero PlayerReplicationInfo objects — nothing spawned
  // a PRI for an unadmitted actor.
  assert.equal(priCount(), 0, `${label}: no PlayerReplicationInfo was spawned`);
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
  'startup, no PlayerReplicationInfo is spawned, and two resets preserve the partition. ' +
  `Boundaries recorded only for admitted actors (${npcFailures.size} total).`);
