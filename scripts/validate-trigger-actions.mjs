/** Validate the original VM-driven Orders/Flag/Damage trigger slice and its
 * native boundaries against the installed GOTY packages. DamageTrigger follows
 * the recovered Training radiation path through body health and GM_Trench
 * PlayAnim writes, then stops at the first unsupported Human pain-sound native. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readClass } from '../src/unreal/classes.mjs';
import { readObject } from '../src/unreal/objects.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music']) {
  for (const name of await readdir(`${root}/${directory}`)) {
    const path = `${directory}/${name}`;
    files.push({ path, read: () => readFile(`${root}/${path}`) });
  }
}
const assets = new AssetStore(files);
const deusEx = await assets.get('DeusEx');
const extension = await assets.get('Extension');
const engine = await assets.get('Engine');
const core = await assets.get('Core');

function sourceFor(asset, classPath) {
  const classIndex = asset.exportsByPath.get(classPath);
  assert.ok(classIndex, `missing original class ${asset.name}.${classPath}`);
  const metadata = readClass(asset, classIndex);
  assert.ok(metadata.scriptText, `${asset.name}.${classPath} has no TextBuffer`);
  const reader = readObject(asset.pkg, asset.bytes, metadata.scriptText).reader;
  reader.u32();
  reader.u32();
  return reader.string(asset.pkg.version);
}

const source = {
  OrdersTrigger: sourceFor(deusEx, 'orderstrigger'),
  DamageTrigger: sourceFor(deusEx, 'damagetrigger'),
  FlagTrigger: sourceFor(deusEx, 'flagtrigger'),
  ScriptedPawn: sourceFor(deusEx, 'scriptedpawn'),
  DeusExPlayer: sourceFor(deusEx, 'deusexplayer'),
  Human: sourceFor(deusEx, 'human'),
  FlagBase: sourceFor(extension, 'flagbase'),
  CoreObject: sourceFor(core, 'object'),
};
assert.match(source.OrdersTrigger, /foreach\s+AllActors\s*\(class\s*'ScriptedPawn'/i);
assert.match(source.OrdersTrigger, /P\.SetOrders\(Orders,\s*ordersTag,\s*True\)/i);
assert.match(source.OrdersTrigger, /if\s*\(bTriggerOnceOnly\)\s*Destroy\(\)/i);
assert.match(source.DamageTrigger, /damagee\.TakeDamage\(damageAmount/i);
assert.match(source.DamageTrigger, /SetTimer\(damageInterval,\s*bConstantDamage\)/i);
assert.match(source.FlagTrigger, /flagBase\.SetBool\(flagName,\s*flagValue/i);
assert.match(source.FlagTrigger, /flagBase\.GetBool\(flagName\)/i);
assert.match(source.FlagTrigger, /foreach\s+AllActors\s*\(class\s*'Actor'/i);
assert.match(source.FlagTrigger, /if\s*\(bWhileStandingOnly\)/i);
assert.match(source.ScriptedPawn, /function\s+SetOrders\(Name\s+orderName/i);
assert.match(source.ScriptedPawn, /FollowOrders\(true\)/i);
assert.match(source.DeusExPlayer, /function\s+TakeDamage\(int\s+Damage/i);
assert.match(source.DeusExPlayer, /function\s+AddDamageDisplay\(name\s+damageType/i);
assert.match(source.DeusExPlayer, /function\s+bool\s+DXReduceDamage\(int\s+Damage/i);
assert.match(source.DeusExPlayer, /function\s+StopPoison\(\)/i);
assert.match(source.DeusExPlayer, /function\s+bool\s+UsingChargedPickup\(class<ChargedPickup>/i);
assert.match(source.DeusExPlayer, /function\s+SetDamagePercent\(float\s+percent\)/i);
assert.match(source.DeusExPlayer, /simulated\s+function\s+ClientFlash\(\s*float\s+scale,\s*vector\s+fog/i);
assert.match(source.DeusExPlayer, /function\s+PlayDXTakeDamageHit\(float\s+Damage/i);
assert.match(source.DeusExPlayer, /function\s+PlayHit\(float\s+Damage/i);
assert.match(source.Human, /function\s+PlayTakeHitSound\(int\s+Damage/i);
assert.match(source.Human, /AISendEvent\('LoudNoise'/i);
assert.match(source.FlagBase, /native\(1100\).*SetBool/i);
assert.match(source.FlagBase, /native\(1110\).*GetBool/i);
assert.match(source.CoreObject, /native\(123\).*operator\(26\).*bool\s+!=\s*\(\s*string\s+A\s*,\s*string\s+B\s*\)/i);

const functionSizes = {
  'orderstrigger.touch': 41,
  'orderstrigger.trigger': 39,
  'orderstrigger.startpatrolling': 68,
  'damagetrigger.timer': 80,
  'damagetrigger.touch': 69,
  'damagetrigger.untouch': 31,
  'damagetrigger.trigger': 37,
  'damagetrigger.untrigger': 35,
  'deusexplayer.takedamage': 3014,
  'deusexplayer.adddamagedisplay': 50,
  'deusexplayer.dxreducedamage': 992,
  'deusexplayer.stoppoison': 34,
  'deusexplayer.usingchargedpickup': 127,
  'deusexplayer.setdamagepercent': 45,
  'deusexplayer.clientflash': 33,
  'deusexplayer.playdxtakedamagehit': 569,
  'deusexplayer.playhit': 99,
  'human.playtakehitsound': 675,
  'flagtrigger.touch': 195,
  'flagtrigger.untouch': 208,
  'flagtrigger.trigger': 249,
  'flagtrigger.untrigger': 262,
};
const radiationChainExports = {
  'damagetrigger.timer': 15220,
  'deusexplayer.takedamage': 17205,
  'deusexplayer.adddamagedisplay': 17835,
  'deusexplayer.dxreducedamage': 17197,
  'deusexplayer.stoppoison': 17902,
  'deusexplayer.usingchargedpickup': 17001,
  'deusexplayer.setdamagepercent': 17833,
  'deusexplayer.clientflash': 17135,
  'deusexplayer.playdxtakedamagehit': 17174,
  'deusexplayer.playhit': 17166,
  'human.playtakehitsound': 16845,
};
for (const [path, expected] of Object.entries(functionSizes)) {
  const index = deusEx.exportsByPath.get(path);
  assert.ok(index, `missing original function DeusEx.${path}`);
  assert.equal(readFunctionMetadata(deusEx, index).scriptSize, expected, `DeusEx.${path} script size`);
}
for (const [path, expected] of Object.entries(radiationChainExports))
  assert.equal(deusEx.exportsByPath.get(path), expected, `DeusEx.${path} export index`);
assert.equal(readFunctionMetadata(extension, extension.exportsByPath.get('flagbase.setbool')).nativeIndex, 1100);
assert.equal(readFunctionMetadata(extension, extension.exportsByPath.get('flagbase.getbool')).nativeIndex, 1110);
assert.equal(readFunctionMetadata(engine, engine.exportsByPath.get('actor.playsound')).nativeIndex, 264);
assert.equal(readFunctionMetadata(engine, engine.exportsByPath.get('actor.aisendevent')).nativeIndex, 713);
const stringNotEqualIndex = core.exportsByPath.get('object.notequal_strstr');
assert.ok(stringNotEqualIndex, 'missing original Core.Object.NotEqual_StrStr');
assert.equal(readFunctionMetadata(core, stringNotEqualIndex).nativeIndex, 123);

// The native body evidence is pinned to the installed Extension.dll build.
// This build's .text raw offset equals its RVA, so these are direct file spans.
const extensionDll = await readFile(`${root}/System/Extension.dll`);
const engineDll = await readFile(`${root}/System/Engine.dll`);
const coreDll = await readFile(`${root}/System/Core.dll`);
const bytesAt = (bytes, rva, length) => bytes.subarray(rva, rva + length);
assert.deepEqual([...bytesAt(extensionDll, 0x239c9, 10)], [0xc7, 0x86, 0x28, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
assert.deepEqual([...bytesAt(extensionDll, 0x23c60, 3)], [0x55, 0x8b, 0xec]);
assert.deepEqual([...bytesAt(extensionDll, 0x23d0e, 9)], [0x8b, 0x45, 0x14, 0x83, 0xf8, 0xff, 0x75, 0x09, 0x8b]);
assert.deepEqual([...bytesAt(extensionDll, 0x243c0, 3)], [0x55, 0x8b, 0xec]);
assert.deepEqual([...bytesAt(extensionDll, 0x243f7, 9)], [0x8b, 0x48, 0x40, 0x8b, 0x55, 0x0c, 0x83, 0xe1, 0x01]);

// Engine native 720 is execGetPlayerPawn: the export thunk at RVA 0x28ce
// jumps to the body at RVA 0x6d2a0. The nearby 0x2e4b export is the distinct
// C++ AActor::GetPlayerPawn helper and is intentionally not used here.
assert.deepEqual([...bytesAt(engineDll, 0x28ce, 5)], [0xe9, 0xcd, 0xa9, 0x06, 0x00]);
assert.deepEqual([...bytesAt(engineDll, 0x6d2a0, 23)], [
  0x8b, 0x44, 0x24, 0x04, 0x8b, 0x50, 0x0c, 0x42, 0x89, 0x50, 0x0c,
  0x8b, 0x81, 0xac, 0x00, 0x00, 0x00, 0x33, 0xd2, 0x85, 0xc0, 0x74, 0x33,
]);
assert.deepEqual([...bytesAt(engineDll, 0x6d2b7, 42)], [
  0x8b, 0x40, 0x40, 0x85, 0xc0, 0x74, 0x23, 0x8b, 0x40, 0x44, 0x85, 0xc0,
  0x74, 0x25, 0x8b, 0x48, 0x30, 0x85, 0xc9, 0x7e, 0x15, 0x8b, 0x40, 0x2c,
  0x8b, 0x00, 0x85, 0xc0, 0x74, 0x15, 0x8b, 0x4c, 0x24, 0x08, 0x8b, 0x40,
  0x30, 0x89, 0x01, 0xc2, 0x08, 0x00,
]);

// Core native 123 is Object.NotEqual_StrStr. The export thunk at image/RVA
// 0x1010304e/0x304e jumps to the body at image/RVA 0x1013b730/0x3b730.
// The body evaluates both operands, calls appStrcmp, and normalizes the
// result to a logical bool with neg/sbb/neg before storing ReturnValue.
assert.deepEqual([...bytesAt(coreDll, 0x304e, 5)], [0xe9, 0xdd, 0x86, 0x03, 0x00]);
assert.deepEqual([...bytesAt(coreDll, 0x3b730, 23)], [
  0x6a, 0xff, 0x68, 0x78, 0x18, 0x17, 0x10, 0x64, 0xa1, 0x00, 0x00, 0x00,
  0x00, 0x50, 0x64, 0x89, 0x25, 0x00, 0x00, 0x00, 0x00, 0x83, 0xec,
]);
assert.deepEqual([...bytesAt(coreDll, 0x3b7e3, 8)], [0xf7, 0xd8, 0x1b, 0xc0, 0xf7, 0xd8, 0x89, 0x02]);

// Execute the original UFunctions in the live Play runtime. The only service
// substitutions here are the recovered Core string native, Extension.FlagBase,
// and an explicit Engine.Client / Viewports graph for native 720;
// Touch/StartPatrolling/SetOrders/FollowOrders remain VM bytecode and their
// inherited calls use the prepared records.
const mapAsset = await assets.get('00_Training');
const map = decodeMap(mapAsset.bytes);
const game = await createGame(map, mapAsset, assets, { randomSeed: 1 });
const runtime = game.doors.scriptRuntime.runtime;
const player = game.player.collisionActor;
const level = runtime.levelFor(player);
const find = name => {
  const actor = level.actors.find(candidate => candidate?.name === name);
  assert.ok(actor, `00_Training live actor ${name}`);
  return actor;
};
const orders = find('OrdersTrigger0');
const pawn = find('JaimeReyes1');
const actions = game.doors.scriptRuntime.triggerActions;
assert.ok(actions, 'createScriptDoors must expose the integrated trigger service');
assert.ok(runtime.lookup(orders, 'Touch')?.function, 'integrated host must prepare OrdersTrigger.Touch');
assert.deepEqual(actions.handleNative({ index: 720, argumentCount: 0, receiver: orders }), {
  handled: true, value: player,
});
assert.equal(game.collision.doorCallbacks.dispatch(orders, 'Touch', [player]), true);
assert.equal(runtime.namedReference(pawn, 'Orders').get(), 'Patrolling');
assert.equal(runtime.namedReference(pawn, 'OrderTag').get(), 'gunroom');
// StartUp.BeginState set bInterruptState on the live pawn, so SetState is an
// immediate GotoState here rather than a queued NextState.
assert.equal(runtime.instance(pawn).state?.stateNode?.record?.name, 'Patrolling');

const flag = find('FlagTrigger0');
assert.equal(game.collision.doorCallbacks.dispatch(flag, 'Touch', [player]), true);
assert.equal(actions.flagBase.getBool('MunitionsTrooperReady'), true);
assert.equal(game.collision.doorCallbacks.dispatch(flag, 'UnTouch', [player]), true);
assert.equal(actions.flagBase.getBool('MunitionsTrooperReady'), false);

// The selected DamageTrigger body runs the original Training radiation path.
// Standalone player startup has already created the original manager. The
// direct VM dispatch below is intentional: the scene wrapper records this same
// unsupported edge as a deferred mission effect, while the validator keeps the
// exact native caller visible and can prove all writes made before it.
const damage = find('DamageTrigger1');
const health = runtime.namedReference(player, 'Health');
const augmentationSystem = runtime.namedReference(player, 'AugmentationSystem');
const desiredFlashScale = runtime.namedReference(player, 'DesiredFlashScale');
const desiredFlashFog = runtime.namedReference(player, 'DesiredFlashFog');
const bodyParts = ['HealthHead', 'HealthTorso', 'HealthArmLeft', 'HealthArmRight', 'HealthLegLeft', 'HealthLegRight'];
for (const field of bodyParts) runtime.namedReference(player, field).set(100);
health.set(100);
desiredFlashScale.set(0);
desiredFlashFog.set([0, 0, 0]);
assert.ok(augmentationSystem.get(), 'Player startup creates AugmentationSystem before damage interaction');
const unwrappedCallFunction = runtime.callFunction;
let liveAdjustedDamage;
let liveDamageReduced;
runtime.callFunction = function captureDamageReduction(record, receiver, argumentCount, evaluateArgument, context) {
  if (record?.key !== 'deusex.deusexplayer.dxreducedamage')
    return unwrappedCallFunction.call(this, record, receiver, argumentCount, evaluateArgument, context);
  const result = unwrappedCallFunction.call(this, record, receiver, argumentCount, index => {
    const value = evaluateArgument(index);
    if (index === 3 && value?.reference)
      return { reference: true, get: value.get, set: item => { liveAdjustedDamage = item; return value.set(item); } };
    return value;
  }, context);
  liveDamageReduced = result;
  return result;
};
runtime.namedReference(damage, 'damagee').set(player);
// Human.PlayTakeHitSound gates its PlaySound on a cooldown that consumes an
// FRand() draw: `Level.TimeSeconds - LastPainSound < FRand() + 0.5` returns
// early without reaching the native. LoadMap's TimeSeconds=0 startup write
// (Engine.dll 0x1038d885) leaves this dispatch inside the window, so pin
// LastPainSound far in the past to keep the boundary deterministic instead
// of leaving it on an RNG draw.
runtime.namedReference(player, 'LastPainSound').set(-100);
let damageBoundary;
try {
  assert.throws(() => game.doors.scriptRuntime.dispatchEvent(damage, 'Timer', []), error => {
    damageBoundary = error;
    assert.match(error.message,
      /Unsupported original door native 264 PlaySound from human\.playtakehitsound/i);
    return true;
  }, 'damage dispatch stops at Human.PlayTakeHitSound PlaySound(264)');
} finally {
  runtime.callFunction = unwrappedCallFunction;
}
assert.equal(liveAdjustedDamage, 10, 'live DXReduceDamage writes adjustedDamage=10 for unowned AugEnviro');
assert.equal(liveDamageReduced, false, 'live DXReduceDamage reports no reduction for unowned AugEnviro');
assert.equal(runtime.namedReference(player, 'Health').get(), 98, 'live Radiation10 recomputes total Health from body parts');
assert.deepEqual(Object.fromEntries(bodyParts.map(field => [field, runtime.namedReference(player, field).get()])), {
  HealthHead: 100, HealthTorso: 100, HealthArmLeft: 100, HealthArmRight: 100,
  HealthLegLeft: 90, HealthLegRight: 100,
});
assert.equal(runtime.namedReference(player, 'AnimSequence').get(), 'HitLegLeft', 'Radiation10 selects the left-leg hit animation');
assert.equal(runtime.namedReference(player, 'AnimFrame').get(), -0.25, 'PlayAnim native starts HitLegLeft at its original frame');
assert.equal(runtime.namedReference(player, 'AnimRate').get(), 2.5, 'PlayAnim native applies the original HitLegLeft rate');
assert.equal(runtime.namedReference(player, 'TweenRate').get(), 2.5, 'PlayAnim native applies the authored tween time');
assert.equal(runtime.namedReference(player, 'AnimLast').get(), 0.75, 'PlayAnim native stores the authored last frame');
assert.match(damageBoundary.message, /PlaySound/);

console.log('Trigger action evidence validated: original Orders/Flag/Damage TextBuffers, function sizes, ' +
  'Core string native 123, FlagBase 1100/1110 native bodies, Engine execGetPlayerPawn 720 viewport traversal, and live original VM ' +
  'execution for 00_Training OrdersTrigger0 -> JaimeReyes1 plus FlagTrigger0 set/inverse. DamageTrigger1.Timer runs the ' +
  'source-backed Radiation10 chain through body health=98 and GM_Trench HitLegLeft PlayAnim state, then stops at ' +
  'Human.PlayTakeHitSound -> Actor.PlaySound native 264.');
