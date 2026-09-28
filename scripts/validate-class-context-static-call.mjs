/** `ClassExpr.static.F()` in Play: execClassContext on the class default object.
 *
 * Core's execClassContext (0x1012edb0) evaluates the class expression, asserts
 * Defaults.Num() == GetPropertiesSize(), then steps the rest of the expression
 * with this = Defaults.GetData() (+0x4d4): the class default object.
 * InitClassDefaultObject (0x10152300) leaves that object's header zeroed
 * except Class and Index (-1), so a static call resolves in the class scope
 * (no StateFrame) and `Default.Class` reads the class itself.
 *
 * The one class-context static call reachable in single-player is
 * PlayerPawn.ReceiveLocalizedMessage's `Message.Static.ClientReceive(...)`,
 * reached from GameInfo.Killed -> BroadcastLocalizedMessage(DeathMessageClass)
 * when the player dies. This dispatches the original ReceiveLocalizedMessage
 * event on JC with Training's DeathMessageClass and checks the default-object
 * receiver, its class-scope lookup and `Default.Class`. */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1});
const runtime = game.doors.scriptRuntime.runtime, player = game.player.collisionActor;
const get = (object, name) => runtime.readNamed(object, name);

const levelInfo = get(player, 'Level'), gameInfo = get(levelInfo, 'Game');
const message = get(gameInfo, 'DeathMessageClass');
assert.equal(message?.kind, 'Class', 'GameInfo.DeathMessageClass is a class value');
assert.equal(message.key, 'engine.localmessage', 'Training\'s DeathMessageClass default is class\'LocalMessage\'');

// Record ClientReceive's receiver and what its body reads through it.
const calls = [];
const callFunction = runtime.callFunction.bind(runtime);
runtime.callFunction = (record, receiver, ...rest) => {
  if (/^engine\.localmessage\./.test(record.key)) calls.push({key: record.key, receiver});
  return callFunction(record, receiver, ...rest);
};
runtime.processEvent(player, 'ReceiveLocalizedMessage', [message, 2, null, null, null]);
runtime.callFunction = callFunction;

assert.equal(runtime.lastRuntimeError ?? null, null, 'the original ReceiveLocalizedMessage body completes');
assert.deepEqual(calls.map(call => call.key), ['engine.localmessage.clientreceive'],
  'Message.Static.ClientReceive runs the class-scope ClientReceive');
const [{receiver}] = calls;
assert.ok(receiver === message, 'the static call runs on the class default object named by the class context');
assert.equal(runtime.lookup(receiver, 'GetString').key, 'engine.localmessage.getstring',
  'Static.GetString inside the static body resolves in the class scope');
const classField = runtime.lookupMember(message.linkedClass, 'fields', 'Class');
assert.ok(runtime.defaultReference(receiver, classField).get() === message,
  'Default.Class on the default object is the class (InitClassDefaultObject stores Class)');
const nameField = runtime.lookupMember(message.linkedClass, 'fields', 'Name');
assert.throws(() => runtime.defaultReference(receiver, nameField).get(), /header storage is not bound/,
  'other default-object header fields stay an explicit boundary');

const classDefault = name => runtime.defaultValue(message.linkedClass, runtime.lookupMember(message.linkedClass, 'fields', name));
const branches = {bBeep: classDefault('bBeep'), bIsConsoleMessage: classDefault('bIsConsoleMessage')};
console.log(`Class-context static call: ReceiveLocalizedMessage(${message.key}, 2) ran ClientReceive on the class default ` +
  `object (Default.Class = ${message.key}; class-scope GetString); defaults ${JSON.stringify(branches)}.`);
