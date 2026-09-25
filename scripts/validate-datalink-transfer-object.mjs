/** Validate the original ConPlayBase.SetupEventTransferObject route end to end.
 *
 * In the live Play world (00_Training, the same wiring the shipped Training
 * DataLinks run on) this drives the shipped DL_Rooftops DataLink transfer:
 *
 *   1. ConSys Conversation.BindActorEvents (native 2053) binds the canonical
 *      DeusExConText ConEventTransferObject export 7448 to the real player
 *      through the installed native dispatch and its transferObject lifecycle
 *      stubs, exactly as scripts/validate-conversation-transfer-object-bind.mjs
 *      pins (ConSys.dll ConEventTransferObject::BindActor 0x1000bc40: toName
 *      'JCDenton' -> toActor, fromName 'AlexJacobson' unmatched in an InfoLink,
 *      StaticLoadObject('DeusEx','Image02_NYC_Warehouse') -> giveObject).
 *   2. A real DataLinkPlay is created through the general original
 *      ULevel::SpawnActor (script-spawn.mjs spawnActor), not
 *      runtime.attach, and its ConPlayBase
 *      fields are populated the way the live lifecycle leaves them.
 *   3. The prepared ConPlayBase.SetupEventTransferObject body runs under
 *      runtime.callFunction with an out-param nextLabel cell.  Its DataLink
 *      path (no fromActor, item absent from the player's chain) executes
 *      Spawn(event.giveObject) -> Inventory.SpawnCopy -> GiveTo ->
 *      Pawn.AddInventory -> GotoState('Idle2'), then
 *      DeusExPlayer.AddImage + HUDReceivedDisplay.AddItem for the
 *      DataVaultImage branch.
 *
 * Evidence:
 *   .cache/reference/ConPlayBase.uc:22-33   EEventAction, EA_NextEvent is member 0
 *   .cache/reference/ConPlayBase.uc:542-826 SetupEventTransferObject body
 *   .cache/reference/Inventory.uc:282-345   BecomePickup/BecomeItem/GiveTo/SpawnCopy
 *   .cache/reference/Inventory.uc:604-759   auto state Pickup, BeginState/EndState
 *   .cache/reference/Inventory.uc:826-828   state Idle2
 *   .cache/reference/DeusExPlayer.uc:8686   AddImage duplicate rejection
 *   .cache/reference/Pawn.uc:664-694        FindInventoryType/AddInventory
 *   .cache/reference/HUDReceivedDisplay.uc:128 AddItem
 *   src/runtime/script-datalink-live.mjs    live spawn admission, prepared
 *                                           transfer chain, receivedItems wiring
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readObject } from '../src/unreal/objects.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { refValue } from '../src/runtime/script-vm.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music']) {
  for (const name of await readdir(`${root}/${directory}`)) {
    files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
  }
}

const assets = new AssetStore(files);
const mapAsset = await assets.get('00_Training');
const game = await createGame(decodeMap(mapAsset.bytes), mapAsset, assets, { randomSeed: 1 });
const runtime = game.doors.scriptRuntime.runtime;
const player = game.player.collisionActor;
const level = runtime.levelFor(player);
const get = (object, field) => runtime.namedReference(object, field).get();
const set = (object, field, value) => runtime.namedReference(object, field).set(value);

// Resolve the canonical shipped DL_Rooftops objects: Conversation export 1430
// and its ConEventTransferObject export 7448 (DeusExConText).
const conText = await assets.get('DeusExConText');
const conversation = await runtime.prepareObject(await runtime.objects.resolve(conText, 1430));
const event = await runtime.prepareObject(await runtime.objects.resolve(conText, 7448));
assert.equal(get(conversation, 'conName'), 'DL_Rooftops');
assert.equal(get(conversation, 'bDataLinkCon'), true, 'DL_Rooftops is an InfoLink conversation');
assert.equal(runtime.instance(event).cls.record.key, 'consys.coneventtransferobject');
assert.equal(get(event, 'ObjectName'), 'Image02_NYC_Warehouse');
assert.equal(get(event, 'fromName'), 'AlexJacobson');
assert.equal(get(event, 'toName'), 'JCDenton');
assert.equal(get(event, 'transferCount'), 1);

// The two classes the original route touches: the giveObject inventory class
// resolved by the binder's StaticLoadObject and the play actor's own class.
const deusEx = await assets.get('DeusEx');
const imageClass = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('image02_nyc_warehouse'));
const dataLinkClass = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('datalinkplay'));
assert.equal(imageClass.record.key, 'deusex.image02_nyc_warehouse');
assert.equal(dataLinkClass.record.key, 'deusex.datalinkplay');

// The direct-call dependencies are prepared by the live DataLink world
// (bindSpawnWorld prepares the whole transfer chain); keep the two records
// this validator invokes itself explicit and idempotent.
await runtime.prepareFunction(deusEx, deusEx.exportsByPath.get('conplaybase.setupeventtransferobject'));
await runtime.prepareFunction(deusEx, deusEx.exportsByPath.get('deusexplayer.addimage'));

// Wire the ConEventTransferObject BindActor StaticLoadObject services exactly
// as the bind validator does: the original native loads the authored Inventory
// class out of package DeusEx through UClass::PrivateStaticClass.
runtime.conversationLifecycle = {
  ...(runtime.conversationLifecycle ?? {}),
  transferObject: {
    classRef: { key: 'core.uclass.private-static-class' },
    createPackage: () => ({ key: 'deusex.package' }),
    staticLoadObject: () => imageClass.record,
  },
};

// Bind only the transfer event: BindActorEvents walks eventList/nextEvent, so
// temporarily replace the head chain with the single canonical event, run the
// installed native 2053, then restore the authored links.  The toName match
// itself depends on the live player's authored BindName.
assert.equal(get(player, 'BindName'), 'JCDenton', 'the toName branch requires the authored player BindName');
const originalHead = get(conversation, 'eventList');
const originalNext = get(event, 'nextEvent');
set(conversation, 'eventList', event);
set(event, 'nextEvent', null);
runtime.conversationEventNative({
  index: 2053,
  receiver: conversation,
  argumentCount: 1,
  evaluateArgument: () => player,
});
// In an InfoLink the remote Alex actor need not be on the map, so only the
// JCDenton toName branch binds; giveObject is loaded regardless of name hits.
assert.strictEqual(get(event, 'toActor'), player, 'BindActorEvents matched toName JCDenton');
assert.equal(get(event, 'fromActor'), null, 'InfoLink leaves fromActor unbound');
assert.strictEqual(get(event, 'giveObject'), imageClass.record,
  'BindActor StaticLoadObject assigned the Image02_NYC_Warehouse class');
set(event, 'nextEvent', originalNext);
set(conversation, 'eventList', originalHead);

// Spawn a real DataLinkPlay through the original admitted ULevel::SpawnActor
// subclass startup; the live lifecycle host admits exactly this class.
const play = runtime.spawnActor({
  cls: dataLinkClass.record,
  level,
  name: 'None',
  owner: null,
  instigator: null,
  location: [0, 0, 0],
  rotation: [0, 0, 0],
});
assert.ok(play, 'original ULevel::SpawnActor admitted DataLinkPlay');
assert.ok(level.actors.includes(play), 'spawned DataLinkPlay was appended to Level.Actors');

// Populate the ConPlayBase/DataLinkPlay fields the way the live lifecycle does
// for an InfoLink: the bound conversation, the player, no first-person window,
// and the current transfer event. SetupEventTransferObject does not read
// dataLink, and Play has no display outside a DataLink start, so it stays None.
const shell = await game.doors.scriptRuntime.infoLinkShell();
set(play, 'con', conversation);
set(play, 'player', player);
set(play, 'conWinThird', null);
set(play, 'dataLink', null);
set(play, 'currentEvent', event);

// The DataVaultImage branch ends at
// DeusExRootWindow(player.rootWindow).hud.receivedItems.AddItem(invItemTo,1).
// The live host wires rootWindow -> hud -> receivedItems; only fill slots a
// host could leave null, then record AddItem on the original function key.
if (get(player, 'rootWindow') === null) set(player, 'rootWindow', shell.root);
const rootWindow = get(player, 'rootWindow');
assert.ok(rootWindow, 'player.rootWindow is required by the received-items path');
if (get(rootWindow, 'hud') === null) set(rootWindow, 'hud', shell.hud);
const hud = get(rootWindow, 'hud');
assert.ok(hud, 'DeusExRootWindow.hud is required by the received-items path');
if (get(hud, 'receivedItems') === null) {
  const receivedDisplay = { name: 'HUDReceivedDisplay validator recorder' };
  runtime.attach(receivedDisplay,
    await runtime.loadClass(deusEx, deusEx.exportsByPath.get('hudreceiveddisplay')));
  set(hud, 'receivedItems', receivedDisplay);
}
const received = [];
const addItemKey = 'deusex.hudreceiveddisplay.additem';
const previousAddItem = runtime.boundaryFunctions.get(addItemKey);
// The real AddItem body reaches winTile.NewChild (Stage-4 window lifecycle), so
// the call is a recorded boundary on the original key.  Argument values are
// evaluated through refValue like every other boundary in the runtime.
runtime.boundaryFunctions.set(addItemKey, call => {
  received.push({
    item: call.argumentCount > 0 ? refValue(call.evaluateArgument(0)) : null,
    count: call.argumentCount > 1 ? refValue(call.evaluateArgument(1)) : null,
  });
});

// Drive the original ConPlayBase.SetupEventTransferObject body.  nextLabel is
// an out String parameter, so argument 1 is a caller-owned reference cell.
const setupRecord = runtime.lookup(play, 'SetupEventTransferObject');
assert.equal(setupRecord?.key, 'deusex.conplaybase.setupeventtransferobject');
const labelCell = {
  reference: {},
  _v: '',
  get() { return this._v; },
  set(value) { this._v = value; },
};
const result = runtime.callFunction(setupRecord, play, 2, index => (index === 0 ? event : labelCell));
if (previousAddItem) runtime.boundaryFunctions.set(addItemKey, previousAddItem);
else runtime.boundaryFunctions.delete(addItemKey);

// EA_NextEvent is the first EEventAction member (ConPlayBase.uc:22-33) and the
// authored failLabel is empty, so both the entry default (line 568) and the
// exit write (line 822) leave nextAction/nextLabel at EA_NextEvent/''.
assert.equal(result, 0, 'SetupEventTransferObject returns EA_NextEvent (enum member 0, ConPlayBase.uc:24)');
assert.equal(labelCell.get(), '', 'empty failLabel leaves nextLabel empty');

// DeusExPlayer.AddImage prepended the spawned image to the DataVault chain.
const firstImage = get(player, 'FirstImage');
assert.ok(firstImage, 'AddImage assigned player.FirstImage');
assert.equal(runtime.instance(firstImage).cls.record.key, 'deusex.image02_nyc_warehouse');
assert.equal(get(firstImage, 'imageDescription'), 'NYC Warehouse');

// SpawnCopy -> GiveTo -> Pawn.AddInventory effects (Inventory.uc:316-345,
// Pawn.uc:676-694): ownership, instigator and the head-of-chain link.
assert.strictEqual(get(firstImage, 'Owner'), player, 'AddInventory SetOwner(player)');
assert.strictEqual(get(firstImage, 'Instigator'), player, 'GiveTo assigns Instigator');
assert.strictEqual(get(player, 'Inventory'), firstImage, 'image is the head of the player Inventory chain');
// Pawn.AddInventory head-inserts, so the image precedes the NanoKeyRing that
// player startup's CreateKeyRing already gave JC (docs/script-nanokey.md).
const keyRing = get(player, 'KeyRing');
assert.ok(keyRing, 'player startup gave JC the NanoKeyRing first');
assert.strictEqual(get(firstImage, 'Inventory'), keyRing, 'the image is linked ahead of the startup key ring');
assert.equal(get(keyRing, 'Inventory'), null, 'the key ring still terminates the Inventory chain');

// SpawnCopy and BecomeItem field writes (Inventory.uc:298-345).
assert.equal(get(firstImage, 'bHeldItem'), true, 'SpawnCopy sets bHeldItem');
assert.equal(get(firstImage, 'RespawnTime'), 0, 'SpawnCopy clears RespawnTime');
assert.equal(get(firstImage, 'bHidden'), true, 'BecomeItem hides the carried item');
assert.equal(get(firstImage, 'bCarriedItem'), true, 'BecomeItem marks the carried item');
assert.equal(get(firstImage, 'bOnlyOwnerSee'), true, 'BecomeItem restricts visibility to the owner');

// BecomeItem's SetCollision(false,false,false) clears the collision bits and
// SetPhysics(PHYS_None) leaves Physics 0 (Inventory.uc:298-311).
assert.equal(get(firstImage, 'Physics'), 0, 'BecomeItem SetPhysics(PHYS_None)');
assert.equal(get(firstImage, 'bCollideActors'), false, 'BecomeItem SetCollision clears bCollideActors');
assert.equal(get(firstImage, 'bBlockActors'), false, 'BecomeItem SetCollision clears bBlockActors');
assert.equal(get(firstImage, 'bCollideWorld'), false,
  'bCollideWorld is clear on the carried image (Pickup.EndState clears it on the GotoState path)');

// GiveTo's GotoState('Idle2') leaves the image in the empty original state.
assert.equal(runtime.instance(firstImage).state.stateNode?.record?.name, 'Idle2',
  'GiveTo leaves the image in state Idle2 (Inventory.uc:826-828)');

// Exactly one HUDReceivedDisplay.AddItem delivery, count 1, carrying the image.
assert.equal(received.length, 1, 'DataVaultImage branch issues exactly one AddItem');
assert.strictEqual(received[0].item, firstImage, 'AddItem receives the spawned image');
assert.equal(received[0].count, 1, 'AddItem receives the authored count 1');

// SpawnCopy's ShouldRespawn false branch gives the spawned actor itself, so it
// appears in Level.Actors exactly once.
assert.equal(level.actors.filter(actor => actor === firstImage).length, 1,
  'the spawned image occupies a single Level.Actors slot');

// BecomeItem -> SetPhysics(PHYS_None) reaches the recovered FindBase tail: one
// 8-unit downward extent trace from the [0,0,0] spawn origin.  Whether it hits
// world geometry is data-dependent, so Base is legitimately either the level's
// LevelInfo (hit -> SetSupportBase -> Attach/BaseChange) or null (miss ->
// SetBase(null) -> BaseChange).  Assert only that the read is one of those two
// original outcomes; a specific value would be a fragile claim.
const baseAfterFindBase = get(firstImage, 'Base');
assert.ok(baseAfterFindBase === null || baseAfterFindBase === level.actors[0] ||
  baseAfterFindBase === level.hash?.levelInfo,
  'spawned image Base is either the LevelInfo found by FindBase or null');

// Duplicate-image branch: with the image already in the player Inventory chain
// a second SetupEventTransferObject would reach ConPlayBase.RemoveItemFromPlayer,
// which is outside the prepared subset.  Pin the equivalent original rejection
// directly instead: DeusExPlayer.AddImage returns False on a duplicate
// imageDescription and leaves the chain untouched (DeusExPlayer.uc:8686-8710).
const addImage = runtime.lookup(player, 'AddImage');
assert.equal(addImage?.key, 'deusex.deusexplayer.addimage');
assert.equal(runtime.callFunction(addImage, player, 1, () => firstImage), false,
  'AddImage rejects a duplicate DataVaultImage description');
assert.strictEqual(get(player, 'FirstImage'), firstImage, 'duplicate rejection keeps FirstImage');
assert.equal(get(firstImage, 'prevImage'), null, 'duplicate rejection keeps the list head unlinked');
assert.equal(get(firstImage, 'nextImage'), null, 'duplicate rejection keeps the single-entry chain');


// ---------------------------------------------------------------------------
// Generality: the other shipped image classes take the same route, unnamed
// ---------------------------------------------------------------------------
// Admission is now the linked DataVaultImage -> Engine.Inventory ancestry, and
// each class arrives through the recovered ULinkerLoad::CreateExport metaclass
// branch (docs/script-create-export.md), so none of these classes is named in
// the runtime.  Drive every remaining shipped reference through the same
// original body and require the same outcome.
const shipped = [];
for (let eventExport = 1; eventExport <= conText.pkg.exports.length; eventExport++) {
  if (conText.pkg.exports[eventExport - 1].className !== 'ConEventTransferObject') continue;
  const values = readObject(conText.pkg, conText.bytes, eventExport).values;
  if (!Number.isInteger(values.Conversation) || values.Conversation <= 0) continue;
  const owner = readObject(conText.pkg, conText.bytes, values.Conversation).values;
  if (!owner.bDataLinkCon) continue;
  shipped.push({ eventExport, conversationExport: values.Conversation,
    conName: owner.conName, objectName: values.ObjectName });
}
assert.equal(shipped.length, 10, 'the ten shipped DataLink TransferObject references');
const remaining = shipped.filter(entry => entry.objectName !== 'Image02_NYC_Warehouse');
assert.equal(remaining.length, 8, 'eight shipped references name a class other than Image02');
assert.equal(new Set(remaining.map(entry => entry.objectName)).size, 8,
  'and those eight name eight distinct classes');

for (const entry of remaining) {
  const transferEvent = await runtime.prepareObject(await runtime.objects.resolve(conText, entry.eventExport));
  const owner = await runtime.prepareObject(await runtime.objects.resolve(conText, entry.conversationExport));
  assert.equal(get(owner, 'conName'), entry.conName);
  const key = entry.objectName.toLowerCase();
  const cls = await runtime.loadClass(deusEx, deusEx.exportsByPath.get(key));
  assert.equal(cls.record.key, `deusex.${key}`);
  // The class this validator never names reaches the same StaticLoadObject sink.
  runtime.conversationLifecycle.transferObject.staticLoadObject = () => cls.record;

  const priorHead = get(owner, 'eventList');
  const priorNext = get(transferEvent, 'nextEvent');
  set(owner, 'eventList', transferEvent);
  set(transferEvent, 'nextEvent', null);
  runtime.conversationEventNative({ index: 2053, receiver: owner, argumentCount: 1,
    evaluateArgument: () => player });
  set(transferEvent, 'nextEvent', priorNext);
  set(owner, 'eventList', priorHead);
  assert.strictEqual(get(transferEvent, 'toActor'), player, `${entry.conName} bound toName JCDenton`);
  assert.strictEqual(get(transferEvent, 'giveObject'), cls.record,
    `${entry.conName} loaded ${entry.objectName}`);

  set(play, 'currentEvent', transferEvent);
  const delivered = [];
  runtime.boundaryFunctions.set(addItemKey, call => {
    delivered.push({
      item: call.argumentCount > 0 ? refValue(call.evaluateArgument(0)) : null,
      count: call.argumentCount > 1 ? refValue(call.evaluateArgument(1)) : null,
    });
  });
  const cell = { reference: {}, _v: '', get() { return this._v; }, set(value) { this._v = value; } };
  const action = runtime.callFunction(setupRecord, play, 2,
    index => (index === 0 ? transferEvent : cell));
  runtime.boundaryFunctions.delete(addItemKey);

  assert.equal(action, 0, `${entry.objectName} returns EA_NextEvent`);
  assert.equal(cell.get(), '', `${entry.objectName} leaves nextLabel empty`);
  const image = get(player, 'FirstImage');
  assert.equal(runtime.instance(image).cls.record.key, cls.record.key,
    `AddImage prepended the spawned ${entry.objectName}`);
  assert.strictEqual(get(image, 'Owner'), player, `${entry.objectName} AddInventory SetOwner(player)`);
  assert.strictEqual(get(player, 'Inventory'), image,
    `${entry.objectName} is the head of the player Inventory chain`);
  assert.equal(get(image, 'bCarriedItem'), true, `${entry.objectName} BecomeItem`);
  assert.equal(get(image, 'Physics'), 0, `${entry.objectName} SetPhysics(PHYS_None)`);
  assert.equal(runtime.instance(image).state.stateNode?.record?.name, 'Idle2',
    `${entry.objectName} ends in state Idle2`);
  assert.equal(delivered.length, 1, `${entry.objectName} issues exactly one AddItem`);
  assert.strictEqual(delivered[0].item, image);
  assert.equal(delivered[0].count, 1);
  assert.equal(level.actors.filter(actor => actor === image).length, 1,
    `${entry.objectName} occupies a single Level.Actors slot`);
}

// Every shipped image class now carried, each a distinct DataVault entry.
const carried = [];
for (let image = get(player, 'FirstImage'); image; image = get(image, 'nextImage')) {
  carried.push(runtime.instance(image).cls.record.key);
}
assert.equal(carried.length, 9, 'all nine shipped image classes were delivered');
assert.equal(new Set(carried).size, 9, 'each delivery is a distinct class');

console.log('DataLink TransferObject passed: original BindActorEvents bound DL_Rooftops export 7448 (toActor=player, giveObject=Image02_NYC_Warehouse), the spawned DataLinkPlay ran ConPlayBase.SetupEventTransferObject to EA_NextEvent with an empty nextLabel, the real Spawn/SpawnCopy/GiveTo/AddInventory/GotoState(\'Idle2\') chain produced the carried image with original field/state values, exactly one HUDReceivedDisplay.AddItem(1) fired, and DeusExPlayer.AddImage rejected the duplicate. The eight remaining shipped references then ran the same body for eight classes this runtime never names, admitted by linked DataVaultImage -> Engine.Inventory ancestry, leaving all nine distinct images carried.');
