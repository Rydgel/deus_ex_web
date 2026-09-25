/** Live-world `Actor.Destroy` in Play.
 *
 * Walking the authored Training route reaches `OrdersTrigger2`, whose original
 * `OrdersTrigger.Touch` calls `Destroy()` because `bTriggerOnceOnly` is set.
 * Before this wiring the request stopped at `DestroyActor requires validate`
 * and paused Play, which disabled every later interaction including door use.
 *
 * This check exercises the recovered `ULevel::DestroyActor` order
 * (docs/script-destroy.md) on the real live level: the host eligibility gate,
 * `Destroyed`, the combined Owner/Touching scan, collision-hash removal, the
 * actor-array slot, `bDeleteMe`, the Core object-flag transitions and the
 * deferred chain — plus the browser reset ledger (docs/script-world-destroy.md).
 * Requires the local game install.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({ path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`) });
const assets = new AssetStore(files);
const mapAsset = await assets.get('00_Training');
const game = await createGame(decodeMap(mapAsset.bytes), mapAsset, assets, { randomSeed: 1 });
const runtime = game.doors.scriptRuntime.runtime;
const player = game.player.collisionActor;
const level = runtime.levelFor(player);
const ref = (actor, name) => runtime.namedReference(actor, name);


// Original PickupDistributor.PostPostBeginPlay ends with Destroy(), after
// the shadow startup pass. Compare the complete reset-time chain with fresh
// startup. The only serialized map actor allowed in the chain is that
// distributor. Every other entry must be a runtime-spawned actor already out
// of Level.Actors: startup Shadows (KillShadow) and the host reload's teardown
// of the previous run's spawns — Shadows, NPC inventory, the distributed key,
// and the GameInfo/Mutator/GameReplicationInfo LoadMap and InitGame spawned
// (script-loadmap-game.mjs reload). Boot runs the startup passes twice
// (setup, then reset), so that teardown is in the boot chain too.
const distributorExport = mapAsset.pkg.exports.findIndex(entry =>
  entry.name === 'PickupDistributor0' && entry.className === 'PickupDistributor') + 1;
assert.ok(distributorExport > 0, 'Training contains its original PickupDistributor0');
const serializedMapActor = actor => Number.isInteger(actor.index) && mapAsset.pkg.exports[actor.index - 1]?.name === actor.name;
function startupDeletedChain() {
  const seen = new Set(), signature = [];
  let distributors = 0;
  for (let actor = level.pendingDeleted; actor; actor = ref(actor, 'Deleted').get()) {
    assert.equal(seen.has(actor), false, 'the deferred chain must not cycle');
    seen.add(actor);
    const key = runtime.instance(actor).cls.record.key;
    if (key === 'deusex.pickupdistributor') {
      assert.equal(actor.index, distributorExport, 'only the authored distributor destroys itself at startup');
      assert.equal(actor.name, 'PickupDistributor0');
      distributors++;
    } else {
      assert.equal(serializedMapActor(actor), false, `serialized ${actor.name} must not join the startup chain`);
      assert.notEqual(actor, ref(level.actors[0], 'Game').get(), 'the live LoadMap GameInfo is never torn down');
    }
    assert.equal(ref(actor, 'bDeleteMe').get(), true, 'every deferred entry is pending deletion');
    assert.equal(level.actors.includes(actor), false, 'startup-deleted actors are absent after partition');
    signature.push(`${key}:${ref(actor, 'Owner').get()?.name ?? 'None'}`);
  }
  assert.equal(distributors, 1, 'original PickupDistributor destroys itself exactly once per startup');
  assert.equal(signature[0]?.split(':')[0], 'deusex.pickupdistributor',
    'PostPostBeginPlay distributor destruction follows the shadow startup pass');
  return signature;
}
const freshStartupDeletedChain = startupDeletedChain();

// -- The authored one-shot trigger -------------------------------------------
const trigger = level.actors.find(actor => actor?.name === 'OrdersTrigger2');
assert.ok(trigger, '00_Training must contain OrdersTrigger2');
assert.equal(runtime.instance(trigger).cls.record.name, 'OrdersTrigger');
assert.equal(ref(trigger, 'bTriggerOnceOnly').get(), true, 'OrdersTrigger.Touch only destroys a one-shot trigger');
assert.equal(ref(trigger, 'Event').get(), 'mibwalker');
assert.equal(ref(trigger, 'bCollideActors').get(), true);
assert.equal(ref(trigger, 'bStatic').get(), false);
assert.equal(ref(trigger, 'bNoDelete').get(), false);
assert.equal(ref(trigger, 'Role').get(), 4, 'ROLE_Authority is required by the recovered play gate');
const slot = level.actors.indexOf(trigger);
assert.ok(slot > 0, 'the trigger occupies a live Level.Actors slot');

// The map export supplies the Core UObject record this destruction walks.
const nativeObject = runtime.instance(trigger).nativeObject;
const exportEntry = mapAsset.pkg.exports[trigger.index - 1];
assert.equal(nativeObject.name, exportEntry.name);
assert.equal(nativeObject.flags >>> 0, exportEntry.flags >>> 0, 'ObjectFlags come from the original export table');
assert.equal(nativeObject.identity, trigger);
// No measured GObjObjects capture is installed in Play, so the slot stays
// unknown rather than invented; -1 would mean "unregistered" to Core.
assert.equal(nativeObject.index, null);

// A ray that crosses the actor's registered cylinder from outside it. The hash
// is the authority the live traces read, so its registration is observable here.
const inCollisionHash = actor => {
  const centre = actor.position, reach = (actor.radius ?? 0) + 64;
  return game.collision.queries.multiLineCheck({
    start: [centre[0], centre[1] - reach, centre[2]], end: [centre[0], centre[1] + reach, centre[2]],
    extent: [0, 0, 0], checkActors: 1, worldActor: game.collision.queries.levelInfo, extra: 0,
  }).some(hit => hit.actor === actor);
};
assert.equal(inCollisionHash(trigger), true, 'the live trigger starts registered in the level collision hash');

// -- Host eligibility boundary ------------------------------------------------
// A Pawn reaches the unresolved APlayerPawn/UNetConnection decision, so the
// adapter must raise its explicit unsupported-branch error, never destroy.
assert.throws(() => runtime.destroyActor(player, false),
  /Unsupported original DestroyActor branch: host eligibility validation/);
assert.equal(ref(player, 'bDeleteMe').get(), false, 'a refused request leaves the actor untouched');
assert.ok(level.actors.includes(player));

// -- Normal movement runs the original Touch -> Destroy chain ------------------
const events = [];
const processEvent = runtime.processEvent.bind(runtime);
runtime.processEvent = (actor, event, args) => {
  if (actor === trigger || (event === 'UnTouch' && args?.[0] === trigger)) events.push(`${actor?.name}.${event}`);
  return processEvent(actor, event, args);
};
const input = { forward: 1, right: 0, yaw: game.player.yaw, pitch: 0, jump: false, crouch: false, walk: false };
// Live map pawns tick now, and their script bodies can join the ULevel
// deferred-destroy chain mid-session (e.g. ScriptedPawn KillShadow on an
// AttachDecal failure). Deleted is the chain head before this destruction's
// prepend — capture the head each tick so the assert names the real prior
// entry instead of assuming this is the session's first destruction.
let opened = false, frames = 0, headBefore = null;
while (level.actors[slot] !== null && frames++ < 1200) {
  headBefore = level.pendingDeleted;
  game.tick(1 / 120, input);
  if (!opened && game.interaction.frobTarget?.name === 'DeusExMover16') { game.use(); opened = true; }
}
assert.ok(frames < 1200, 'walking the authored route reaches OrdersTrigger2');
assert.deepEqual(events, ['OrdersTrigger2.Touch', 'OrdersTrigger2.Destroyed'],
  'the original Touch body destroys the trigger, and Destroyed is the only destruction callback it reaches');
runtime.processEvent = processEvent;

// -- Recovered DestroyActor effects -------------------------------------------
assert.equal(level.actors[slot], null, 'the saved Level.Actors slot is cleared');
assert.equal(ref(trigger, 'bDeleteMe').get(), true);
assert.equal(inCollisionHash(trigger), false, 'FCollisionHash::RemoveActor ran before the array removal');
assert.equal(player.touching.includes(trigger), false, 'EndTouch(other, 1) cleared the toucher side');
assert.deepEqual(trigger.touching, [null, null, null, null]);
// Core ConditionalDestroy sets 0x00800000, UObject::Destroy then sets 0x80000000.
assert.equal(nativeObject.flags >>> 0, ((exportEntry.flags | 0x00800000 | 0x80000000) >>> 0));
assert.equal(nativeObject.linker, null);
// Play prepends the target to the ULevel deferred chain; Deleted keeps the
// previous head (a shadow destroyed by live pawn startup/ticks, or null).
assert.equal(level.pendingDeleted, trigger);
assert.equal(ref(trigger, 'Deleted').get(), headBefore);

// A repeated request on an already-deleting actor is idempotent and returns
// true before looking up an actor-array slot it no longer has.
assert.equal(runtime.destroyActor(trigger, false), true);
assert.equal(level.pendingDeleted, trigger, 'the idempotent path does not re-enter the chain');

// Play continues past the point the unwired request used to pause it.
const before = game.player.position[0];
for (let i = 0; i < 600; i++) game.tick(1 / 120, input);
assert.ok(game.player.position[0] > before, 'movement continues after the live destruction');

// -- Player start restores the serialized map state ---------------------------
game.reset();
assert.equal(level.actors[slot], trigger, 'reset returns the actor to its original slot');
assert.equal(ref(trigger, 'bDeleteMe').get(), false);
assert.equal(nativeObject.flags >>> 0, exportEntry.flags >>> 0);
// The ledger clears session-one destruction. Original startup then recreates
// the shadow failures and PickupDistributor0's PostPostBeginPlay destruction.
assert.deepEqual(startupDeletedChain(), freshStartupDeletedChain,
  'reset reproduces the exact fresh-startup deferred class/owner sequence');
assert.equal(inCollisionHash(trigger), true, 'the scene reset rebuilt the collision hash registration');

let second = 0, reopened = false;
while (level.actors[slot] !== null && second++ < 1200) {
  game.tick(1 / 120, input);
  if (!reopened && game.interaction.frobTarget?.name === 'DeusExMover16') { game.use(); reopened = true; }
}
assert.equal(second, frames, 'the new session reproduces the same destruction frame');

console.log(`Live Actor.Destroy validated: OrdersTrigger2.Touch destroyed its one-shot trigger after ${frames} ` +
  `fixed frames through the recovered ULevel::DestroyActor order (Destroyed, EndTouch(other,1), ` +
  `FCollisionHash::RemoveActor, slot ${slot} cleared, bDeleteMe, ObjectFlags ` +
  `0x${(exportEntry.flags >>> 0).toString(16)} -> 0x${((exportEntry.flags | 0x00800000 | 0x80000000) >>> 0).toString(16)}, ` +
  `deferred chain head), refused the Pawn branch explicitly, stayed idempotent, and reset restored the map state.`);
