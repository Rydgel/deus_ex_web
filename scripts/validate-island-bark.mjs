/** An NPC bark in Play through the original BarkManager path
 * (docs/script-conversation-binding.md, "Loaded graph").
 *
 * 01_NYC_UNATCOIsland, with the player placed in front of ComputerSecurity1
 * as validate-terminals-play.mjs approaches it: Terrorist18 (BarkBindName
 * Terrorist) sees the player, and ScriptedPawn.Attacking calls
 * DeusExPlayer.StartAIBarkConversation -> BarkManager.StartBark. StartBark
 * finds Terrorist_BarkTargetAcquired in the pawn's ConListItems, and
 * ConPlayBark.GetBarkSpeech walks its eventList from a ConEventRandomLabel
 * head. Before the mission list's load attached its whole graph, that read
 * threw "Object is not attached to script runtime:
 * deusexcontext.coneventrandomlabel1085" at tick ~527.
 *
 * Checks:
 *  - The list's prepared graph is exactly the closure of the serialized
 *    ObjectProperty references from ConList_Mission01 (what IndexToObject and
 *    EndLoad load), computed here from the package bytes.
 *  - 620 ticks after the placement run without error.
 *  - The bark starts: a current bark slot holds Terrorist18,
 *    Terrorist_BarkTargetAcquired and BM_TargetAcquired; GetSpeechAudio found
 *    the speech's sound (PlaySound's channel id, assigned only in that branch,
 *    is nonzero, and the duration is GetSpeechLength's, not the text pause);
 *    and the HUD bark display shows one item whose text is a ConSpeech of that
 *    conversation. */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {readObject} from '../src/unreal/objects.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get('01_NYC_UNATCOIsland');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime, W = game.hud.host.W, player = game.player.collisionActor;
const paint = () => game.hud.commands(1432, 1268, {location: game.player.eye, rotation: game.player.viewRotation, fov: 75});
const input = createPlayerInputFixture(game, {paint});
const rd = (object, name) => runtime.readNamed(object, name);

// The mission list's load: every export reached through serialized
// ObjectProperty references (the exports' Outers are the package root).
const conText = await assets.get('DeusExConText'), pkg = conText.pkg;
const listIndex = conText.exportsByPath.get('conlist_mission01');
const closure = new Set([listIndex]);
for (const queue = [listIndex]; queue.length;) {
  const index = queue.pop();
  assert.equal(pkg.exports[index - 1].outer, 0);
  for (const property of readObject(pkg, conText.bytes, index).properties)
    if (property.type === 5 && property.value > 0 && !closure.has(property.value)) { closure.add(property.value); queue.push(property.value); }
}
const prepared = runtime.conversationListObjects.get('deusexcontext.conlist_mission01');
assert.deepEqual(new Set(prepared.map(object => object.index)), closure, 'the prepared list graph is its serialized closure');
const exportNamed = name => runtime.objects.resolve(conText, conText.exportsByPath.get(name));
const [barkConversation, randomLabel] = await Promise.all([exportNamed('conversation1810'), exportNamed('coneventrandomlabel1085')]);
assert.equal(rd(barkConversation, 'conName'), 'Terrorist_BarkTargetAcquired');
assert.equal(rd(barkConversation, 'eventList'), randomLabel);
assert.ok(runtime.instances.has(randomLabel), 'the bark ConEventRandomLabel is attached at load');

input.tick(30);
const level = runtime.levelFor(player);
const computer = level.actors.find(a => a?.name === 'ComputerSecurity1');
const at = rd(computer, 'Location'), yaw = rd(computer, 'Rotation')[1] * Math.PI / 32768;
runtime.farMoveActor(player, [at[0] + Math.cos(yaw) * 56, at[1] + Math.sin(yaw) * 56, at[2]], 0, 1);

const barkManager = rd(player, 'BarkManager');
const field = (info, name) => info[`deusex.barkmanager.barkinfo.${name}`];
const hud = rd(rd(player, 'rootWindow'), 'hud'), barkDisplay = rd(hud, 'barkDisplay');
let bark = null;
for (let tick = 0; tick < 620; tick++) {
  input.tick(1);
  if (bark) continue;
  const slot = rd(barkManager, 'currentBarks').find(info => field(info, 'barkpawn'));
  if (!slot) continue;
  const winBarks = rd(barkDisplay, 'winBarks'), item = W.ptr(winBarks, 0x13c);
  bark = {tick, pawn: field(slot, 'barkpawn').name, conName: field(slot, 'conname'), mode: field(slot, 'barkmode'),
    duration: field(slot, 'barkduration'), soundId: field(slot, 'playingsoundid'), count: rd(barkDisplay, 'barkCount'),
    text: item ? W.heap.read(rd(item, 'winBark'), 0x168, 'string') : null};
}
assert.ok(bark, 'a bark starts within 620 ticks');
assert.deepEqual([bark.pawn, bark.conName, bark.mode], ['Terrorist18', 'Terrorist_BarkTargetAcquired', 3],
  'Terrorist18 barks Terrorist_BarkTargetAcquired (BM_TargetAcquired)');
const speeches = [];
for (let event = randomLabel; event; event = rd(event, 'nextEvent')) {
  const speech = runtime.lookupMember(runtime.instance(event).cls, 'fields', 'conSpeech') && rd(event, 'conSpeech');
  if (speech) speeches.push({text: rd(speech, 'speech'), soundId: rd(speech, 'soundID')});
}
const spoken = speeches.find(speech => speech.text === bark.text);
assert.ok(spoken, `the bark display shows a speech of the conversation: ${JSON.stringify(bark.text)}`);
assert.equal(bark.count, 1, 'one bark item');
assert.notEqual(spoken.soundId, -1);
assert.notEqual(bark.soundId, 0, "GetSpeechAudio found the speech's sound and PlaySound returned its channel");
const textPause = Math.max(bark.text.length * rd(barkManager, 'perCharDelay'), rd(barkManager, 'minimumTextPause'));
assert.ok(bark.duration > 0 && bark.duration !== Math.fround(textPause), 'the duration is GetSpeechLength of the sound');
console.log(`island-bark: list graph ${closure.size} objects; tick ${bark.tick} ${bark.pawn} ${bark.conName} ` +
  `"${bark.text}" (ConAudioAIBarks_${spoken.soundId}, ${bark.duration.toFixed(3)} s, channel ${bark.soundId}); 620 ticks`);
process.exit(0);
