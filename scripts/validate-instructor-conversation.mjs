/** Focused validation of the Training munitions-instructor conversation
 * selection, entered through the same public interaction path as Play
 * (ScriptedPawn.Frob -> DeusExPlayer.StartConversation). Evidence and boundary
 * chain: docs/script-instructor-conversation.md. Requires the local install.
 *
 * What this asserts, all through the original bytecode over the attached
 * conversation object graph (no host reimplementation of the selection):
 *   - Both instructors (UNATCOTroop0/UNATCOTroop3, BindName MunitionsTrooper)
 *     bind MunitionsTrooperFrob then MunitionsTrooperTake.
 *   - GetActiveConversation selects MunitionsTrooperFrob when
 *     MunitionsTrooperReady is false and MunitionsTrooperTake when it is true
 *     (the authored ConFlagRef gate), for the invoking instructor.
 *   - A public Frob dispatch runs the whole StartConversation gate chain
 *     (CanStartConversation, CanConverse, GetActiveConversation, the
 *     participant IsSpeakingActor test) and reaches the recovered
 *     `Spawn(class'ConPlay')` boundary with the correct conversation selected —
 *     the first-person ConPlay presentation is the explicit remaining boundary.
 *   - The ConEventRandomLabel head cycles A1..A5 (the authored greeting).
 *   - Public game.reset() restores the fresh selection.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { gameDirectory } from './game-directory.mjs';

const IM_FROB = 1; // EInvokeMethod { IM_Bump=0, IM_Frob=1, ... } (DeusExPlayer.uc:308)
const root = gameDirectory();
const files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({ path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`) });
const assets = new AssetStore(files);
const mapAsset = await assets.get('00_Training');
const map = decodeMap(mapAsset.bytes);
const { createGame } = await import('../src/viewer/game.mjs');
const game = await createGame(map, mapAsset, assets, { randomSeed: 1 });
const runtime = game.doors.scriptRuntime.runtime;
const deusEx = await assets.get('DeusEx');
const level = runtime.levelFor(game.player.collisionActor);
const player = game.player.collisionActor;
const live = name => level.actors.find(a => a?.index === map.actors.find(x => x?.name === name)?.index) ?? null;
const troop3 = live('UNATCOTroop3'), troop0 = live('UNATCOTroop0');
assert.ok(troop3 && troop0, 'both instructors are live');
const ref = (o, k) => runtime.namedReference(o, k);
const conNameOf = con => con == null ? null : ref(con, 'conName').get();

// 1. Both instructors bind Frob then Take (shared BindName, prepend order).
for (const [nm, t] of [['UNATCOTroop3', troop3], ['UNATCOTroop0', troop0]]) {
  const bound = [];
  for (let item = ref(t, 'ConListItems').get(); item; item = ref(item, 'next').get())
    bound.push(conNameOf(ref(item, 'con').get()));
  assert.deepEqual(bound, ['MunitionsTrooperFrob', 'MunitionsTrooperTake'], `${nm} binds Frob then Take`);
}

// Both instructors expose the same two conversations to the runtime's face
// preparation, keyed by BindName, not by conversation name.
const faceNames = game.doors.scriptRuntime.faceConversations.conversations.map(c => c.conName);
assert.ok(faceNames.includes('MunitionsTrooperFrob') && faceNames.includes('MunitionsTrooperTake'),
  'both instructor conversations are prepared for live play');

const noInput = { forward: 0, strafe: 0, turn: 0, lookUp: 0, jump: false, crouch: false, fire: false, altFire: false };
for (let i = 0; i < 200; i++) game.tick(1 / 60, noInput); // land + reach a conversable state
assert.equal(ref(troop3, 'bCanConverse').get(), true, 'the instructor reaches a conversable state');

const flagBase = ref(player, 'flagBase').get();
const setReady = value => flagBase.setBool('MunitionsTrooperReady', value);
const clearReady = () => flagBase.entries.delete('munitionstrooperready');

// GetActiveConversation runs the real selection bytecode for a given instructor.
const getActive = await runtime.prepareFunction(deusEx, deusEx.exportsByPath.get('deusexplayer.getactiveconversation'));
function selectFor(instructor) {
  const result = runtime.callFunction(getActive, player, 2, i => [instructor, IM_FROB][i]);
  const con = result?.reference ? result.get() : result;
  return conNameOf(con);
}

// 2. Flag-gated selection for the near instructor (UNATCOTroop3).
clearReady();
assert.equal(selectFor(troop3), 'MunitionsTrooperFrob', 'flag false -> Frob greeting');
setReady(true);
assert.equal(selectFor(troop3), 'MunitionsTrooperTake', 'flag true -> Take (surrender gear)');
clearReady();
assert.equal(selectFor(troop3), 'MunitionsTrooperFrob', 'clearing the flag restores Frob');

// 3. The whole public Frob path runs and reaches the ConPlay spawn boundary
// with the correct conversation selected. Capture the selected conversation
// from the participant IsSpeakingActor test the real StartConversation runs.
let selectedCon = null;
const originalCall = runtime.callFunction.bind(runtime);
runtime.callFunction = (record, receiver, ac, ev, ctx) => {
  if (record?.key === 'consys.conversation.isspeakingactor') selectedCon = receiver;
  return originalCall(record, receiver, ac, ev, ctx);
};
function frobReachesConPlay(instructor) {
  selectedCon = null;
  ref(player, 'conPlay').set(null);
  let boundary = null;
  try { game.doors.scriptRuntime.dispatchEvent(instructor, 'Frob', [player, null]); }
  catch (e) { boundary = e.message; }
  return { boundary, selected: conNameOf(selectedCon) };
}
clearReady();
let r3 = frobReachesConPlay(troop3);
assert.match(r3.boundary ?? '', /unprepared Actor subclass: deusex\.conplay/,
  'the Frob path reaches the recovered Spawn(class\'ConPlay\') boundary');
assert.equal(r3.selected, 'MunitionsTrooperFrob', 'the public Frob selected the Frob conversation');

// 4. The other instructor (participant identity). Reposition the player next to
// UNATCOTroop0 for the height/line-of-sight gate (a debug reposition for test
// setup; the flow itself is unchanged), then run the same public path.
const t0 = ref(troop0, 'Location').get();
game.collision.queries.changeActor(player, () => { game.player.position = [t0[0] - 70, t0[1], t0[2] + 10]; });
for (let i = 0; i < 5; i++) game.tick(1 / 60, noInput);
clearReady();
assert.equal(selectFor(troop0), 'MunitionsTrooperFrob', 'UNATCOTroop0 selects Frob when flag false');
setReady(true);
assert.equal(selectFor(troop0), 'MunitionsTrooperTake', 'UNATCOTroop0 selects Take when flag true');
clearReady();
const r0 = frobReachesConPlay(troop0);
assert.match(r0.boundary ?? '', /unprepared Actor subclass: deusex\.conplay/, 'UNATCOTroop0 Frob reaches ConPlay spawn');
assert.equal(r0.selected, 'MunitionsTrooperFrob', 'UNATCOTroop0 Frob selected its own Frob conversation');
runtime.callFunction = originalCall;

// 5. The greeting's ConEventRandomLabel cycles A1..A5 (the authored line set).
const frobCon = game.doors.scriptRuntime.faceConversations.conversations
  .find(c => c.conName === 'MunitionsTrooperFrob').conversation;
const randomLabelHead = ref(frobCon, 'eventList').get();
assert.equal(runtime.instance(randomLabelHead).cls.record.key, 'consys.coneventrandomlabel');
const picks = [];
for (let i = 0; i < 5; i++) picks.push(runtime.invokeNative({ index: 2062, receiver: randomLabelHead, argumentCount: 0, evaluateArgument: () => undefined }));
assert.deepEqual(picks, ['A1', 'A2', 'A3', 'A4', 'A5'], 'the greeting cycles the five authored labels in order');

// 6. Public reset restores the fresh selection (flag false -> Frob).
game.reset();
for (let i = 0; i < 200; i++) game.tick(1 / 60, noInput);
clearReady();
const afterReset = live('UNATCOTroop3');
assert.equal(selectFor(afterReset), 'MunitionsTrooperFrob', 'a fresh interaction after reset selects Frob again');

console.log('Instructor conversation selection validated through the public Frob path: ' +
  'both instructors bind Frob->Take, GetActiveConversation picks Frob/Take by the MunitionsTrooperReady ' +
  'flag, the full StartConversation gate chain reaches Spawn(class\'ConPlay\') with the right conversation, ' +
  'the greeting cycles A1..A5, and reset restores the fresh selection.');
