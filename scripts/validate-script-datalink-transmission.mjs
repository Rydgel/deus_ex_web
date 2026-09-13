/**
 * Original DataLink validation.
 *
 * This validator does not call a JavaScript StartConversation replacement. It
 * prepares the installed UFunctions, prepares canonical Conversation and
 * ConEventSpeech objects, executes the original DataLinkPlay.SetConversation,
 * queue/selection/state gates and verifies the exact Mission00 DL_Start
 * records and typed speech binding. ConSys 2052/2053 execute the recovered
 * bodies against an explicit object-array fixture. The normal StartConversation
 * display path also executes the original RootWindow/HUD bodies and stops at
 * the first unsupported child-allocation native; unexpected natives fail.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readClass } from '../src/unreal/classes.mjs';
import { readObject } from '../src/unreal/objects.mjs';
import { ScriptRuntime } from '../src/runtime/script-runtime.mjs';
import { refValue } from '../src/runtime/script-vm.mjs';
import { createScriptNames } from '../src/runtime/script-names.mjs';
import { createScriptTriggers } from '../src/runtime/script-triggers.mjs';
import { bindSpeechActor, clearSpeechActors } from '../src/runtime/script-conversation-speech.mjs';
import { clearConversationEvents } from '../src/runtime/script-conversation-clear.mjs';
import { WINDOW_SIZE_OFFSETS } from '../src/runtime/script-window-size.mjs';
import {
  DATALINK_NATIVE_INDICES,
  DATALINK_FUNCTIONS,
  CONVERSATION_SCRIPT_FUNCTIONS,
  loadDataLinkMissionDescriptors,
  prepareDataLinkFunctions,
} from '../src/runtime/script-datalink-transmission.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const files = [];
for (const directory of ['System']) {
  for (const name of await readdir(root + '/' + directory)) {
    const path = directory + '/' + name;
    files.push({ path, read: () => readFile(root + '/' + path) });
  }
}
const assets = new AssetStore(files);
const deusEx = await assets.get('DeusEx');
const conSys = await assets.get('ConSys');
const conText = await assets.get('DeusExConText');

function sourceFor(asset, classPath) {
  const classIndex = asset.exportsByPath.get(classPath);
  assert.ok(classIndex, 'missing original class ' + asset.name + '.' + classPath);
  const metadata = readClass(asset, classIndex);
  assert.ok(metadata.scriptText, asset.name + '.' + classPath + ' has no TextBuffer');
  const reader = readObject(asset.pkg, asset.bytes, metadata.scriptText).reader;
  reader.u32();
  reader.u32();
  return reader.string(asset.pkg.version);
}

const playerSource = sourceFor(deusEx, 'deusexplayer');
const triggerSource = sourceFor(deusEx, 'datalinktrigger');
const rootWindowSource = sourceFor(deusEx, 'deusexrootwindow');
const hudSource = sourceFor(deusEx, 'deusexhud');
assert.match(playerSource, /function\s+Bool\s+StartDataLinkTransmission\s*\(/i);
assert.match(playerSource, /if\s*\(\s*Level\.bPlayersOnly\s*\)/i);
assert.match(playerSource, /activeDataLink\s*=\s*GetActiveDataLink\(datalinkName\)/i);
assert.match(playerSource, /datalinkPlay\.SetConversation\(activeDataLink\)/i);
assert.match(playerSource, /datalinkPlay\.SetTrigger\(datalinkTrigger\)/i);
assert.match(playerSource, /datalinkPlay\.StartConversation\(Self\)/i);
assert.match(playerSource, /datalinkPlay\.Destroy\(\)/i);
assert.match(playerSource, /function\s+Conversation\s+GetActiveDataLink\s*\(/i);
assert.match(playerSource, /con\.bDisplayOnce/i);
assert.match(playerSource, /con\.conName\s*\$\s*"_Played"/i);
assert.match(playerSource, /CheckFlagRefs\(\s*con\.flagRefList\s*\)/i);
assert.match(triggerSource, /player\.StartDataLinkTransmission\(String\(datalinkTag\),\s*Self\)/i);
assert.match(triggerSource, /function\s+DatalinkFinished\s*\(/i);
assert.match(rootWindowSource,
  /function\s+DeusExBaseWindow\s+GetTopWindow\s*\(\)[\s\S]*?winCount\s*>\s*0[\s\S]*?winStack\[winCount-1\][\s\S]*?return\s+None/i);
assert.match(hudSource, /function\s+HUDInfoLinkDisplay\s+CreateInfoLinkWindow\s*\(/i);
assert.match(hudSource,
  /infolink\s*=\s*HUDInfoLinkDisplay\s*\(\s*NewChild\s*\(\s*Class'HUDInfoLinkDisplay'\s*\)\s*\)/i);
assert.match(hudSource, /msgLog\.Hide\s*\(\)/i);
assert.match(hudSource, /infolink\.AskParentForReconfigure\s*\(\)/i);
assert.equal(deusEx.exportsByPath.get('deusexrootwindow.gettopwindow'), 14052);
assert.equal(deusEx.exportsByPath.get('deusexhud.createinfolinkwindow'), 19623);

// Explicit initialized host fixtures exercise the original selection body.
// This table is not a claim about original process startup/name indices.
const names = createScriptNames({allocator:{free:()=>{throw new Error('Unexpected name release');}}});
names.intern('None',2);
const nameCalls = [];
const nativeCalls = [];
const windowSizeCalls = [];
const windowDimensions = new WeakMap();
const triggerNatives = createScriptTriggers();
const globalObjects = [];
const level = {actors:[]};
const windowConstructions = [];
const windowConstructionBoundary = new Error('Original native window construction is unbound');
const windowErrorDevice = {name: 'GError'};
const windowParents = new WeakMap();
const windowTypes = new WeakMap();
const hierarchyReads = [];
const runtime = new ScriptRuntime(assets, {
  conversationObjects:()=>globalObjects,
  windowLifecycle:{
    errorDevice:windowErrorDevice,
    isScriptable:()=>true,
    hierarchy:{
      readParent:object=>{hierarchyReads.push(object);return windowParents.get(object);},
      readType:object=>windowTypes.get(object),
    },
    size:{
      read:(object,offset)=>windowDimensions.get(object)?.get(offset)??-1,
      write:(object,offset,_kind,value)=>{
        if(!windowDimensions.has(object))windowDimensions.set(object,new Map());
        windowDimensions.get(object).set(offset,value);
      },
      askParentForReconfigure:({object,width,height})=>windowSizeCalls.push({object,args:[width,height]}),
    },
    staticConstructObject:request=>{
      windowConstructions.push(request);
      throw windowConstructionBoundary;
    },
  },
  levelFor:()=>level,
  nameServices:{internName:(text,mode)=>{
    nameCalls.push([text,mode]);
    return names.intern(text,mode).name;
  }},
  native: call => {
    nativeCalls.push(call.index);
    const result = triggerNatives.handleNative(call);
    if(result.handled)return result.value;
    throw new Error('Unexpected native ' + call.index + ' while validating prepared DataLink bytecode');
  },
});
const prepared = await prepareDataLinkFunctions(runtime, { deusEx, conSys });
assert.equal(prepared.size, DATALINK_FUNCTIONS.length + CONVERSATION_SCRIPT_FUNCTIONS.length + 5);
for (const item of DATALINK_FUNCTIONS) {
  const asset = await assets.get(item.asset);
  const index = asset.exportsByPath.get(item.path);
  const key = (asset.name + '.' + item.path).toLowerCase();
  assert.equal(prepared.get(key)?.index, index, 'prepared original ' + item.path);
}

const descriptors = loadDataLinkMissionDescriptors(conText, 0);
assert.equal(descriptors.length, 470);
const dlStart = descriptors.find(item => String(item.conName).toLowerCase() === 'dl_start');
assert.ok(dlStart, 'Mission00 DL_Start descriptor');
assert.equal(dlStart.ref, 1926);
assert.equal(dlStart.conOwnerName, 'JCDenton');
assert.equal(dlStart.bDataLinkCon, true);
assert.equal(dlStart.bDisplayOnce, true);
assert.equal(dlStart.flagRefList, undefined);
assert.equal(dlStart.eventListRef, 32934);

// Canonical logical objects carry class defaults and inherited properties. The
// parser above keeps absent authored fields undefined rather than guessing a
// bool; the VM object preparation supplies the original class value.
const conversation = await runtime.objects.resolve(conText, dlStart.ref);
assert.equal(await runtime.prepareObject(conversation), conversation);
assert.equal(runtime.namedReference(conversation, 'conName').get(), 'DL_Start');
assert.equal(runtime.namedReference(conversation, 'conOwnerName').get(), 'JCDenton');
assert.equal(runtime.namedReference(conversation, 'bDataLinkCon').get(), true);
assert.equal(runtime.namedReference(conversation, 'bDisplayOnce').get(), true);

const event = await runtime.objects.resolve(conText, dlStart.eventListRef);
assert.equal(await runtime.prepareObject(event), event);
assert.equal(runtime.namedReference(event, 'speakerName').get(), 'JaimeReyes');
assert.equal(runtime.namedReference(event, 'speakingToName').get(), 'JCDenton');

// Execute original DataLinkPlay.SetConversation and SetTrigger bytecode.
const playClass = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('datalinkplay'));
const play = {};
runtime.attach(play, playClass);
const setConversation = prepared.get('deusex.datalinkplay.setconversation');
const setTrigger = prepared.get('deusex.datalinkplay.settrigger');
assert.equal(runtime.callFunction(setConversation, play, 1, () => conversation), true);
assert.equal(runtime.namedReference(play, 'con').get(), conversation);
assert.equal(runtime.namedReference(play, 'startCon').get(), conversation);
const trigger = { name: 'DataLinkTrigger23' };
assert.equal(runtime.callFunction(setTrigger, play, 1, () => trigger), undefined);
assert.equal(runtime.namedReference(play, 'datalinkTrigger').get(), trigger);

// The noninitial SetConversation path mutates the queue before checking the
// window. A null dataLink therefore returns false even after a successful push.
const queueConversations = await Promise.all(descriptors.filter(item=>item.ref!==dlStart.ref).slice(0,9)
  .map(item=>runtime.objects.resolve(conText,item.ref)));
const queue = runtime.namedReference(play,'dataLinkQueue');
const push = value=>runtime.callFunction(prepared.get('deusex.datalinkplay.pushdatalink'),play,1,()=>value);
assert.equal(push(conversation),false,'startCon cannot be queued');
assert.equal(runtime.callFunction(setConversation,play,1,()=>queueConversations[0]),false);
assert.equal(queue.get()[0],queueConversations[0],'queue mutation precedes missing-window failure');
assert.equal(push(queueConversations[0]),false,'duplicate is rejected');
for(const value of queueConversations.slice(1,8))assert.equal(push(value),true);
assert.equal(push(queueConversations[8]),false,'fixed eight-slot queue is full');
assert.deepEqual(queue.get(),queueConversations.slice(0,8));
assert.equal(runtime.callFunction(prepared.get('deusex.datalinkplay.popdatalink'),play),queueConversations[0]);
assert.deepEqual(queue.get(),[...queueConversations.slice(1,8),null]);
runtime.callFunction(prepared.get('deusex.datalinkplay.insertdatalink'),play,1,()=>queueConversations[8]);
assert.deepEqual(queue.get(),[queueConversations[8],...queueConversations.slice(1,8)]);

// Empty linked flag refs are a real CheckFlagRefs VM case: the original loop
// returns true without asking FlagBase for a fabricated missing flag.
const playerClass = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('deusexplayer'));
const player = {};
runtime.attach(player, playerClass);
const checkFlagRefs = prepared.get('deusex.deusexplayer.checkflagrefs');
assert.equal(runtime.callFunction(checkFlagRefs, player, 1, () => null), true);

// These are typed logical fixtures, not native constructors or a loaded Play
// window. The original function must preserve both readiness gates before it
// reads the prepared Conversation through its ConListItem chain.
const getActive = prepared.get('deusex.deusexplayer.getactivedatalink');
const select = name=>runtime.callFunction(getActive,player,1,()=>name);
assert.equal(select('dl_start'),null);
triggerNatives.bindPlayerFlagBase(runtime,player);
assert.equal(select('dl_start'),null);
assert.equal(nameCalls.length,0);
const extension = await assets.get('Extension');
await runtime.prepareFunction(extension,extension.exportsByPath.get('extensionobject.stringtoname'));
await runtime.prepareFunction(extension,extension.exportsByPath.get('flagbase.getbool'));
const windowClass = await runtime.loadClass(deusEx,deusEx.exportsByPath.get('deusexrootwindow'));
const rootWindow = {};
runtime.attach(rootWindow,windowClass);
const hudClass = await runtime.loadClass(deusEx,deusEx.exportsByPath.get('deusexhud'));
const hud = {};
runtime.attach(hud,hudClass);
assert.equal(runtime.instance(rootWindow).cls.record.key,'deusex.deusexrootwindow');
assert.equal(runtime.instance(hud).cls.record.key,'deusex.deusexhud');
runtime.namedReference(rootWindow,'hud').set(hud);
windowParents.set(hud,rootWindow);
windowParents.set(rootWindow,null);
windowTypes.set(rootWindow,3); // explicit initialized native root fixture
runtime.namedReference(rootWindow,'parentPawn').set(player);
const rootWindowStack = runtime.namedReference(rootWindow,'winStack');
const rootWindowCount = runtime.namedReference(rootWindow,'winCount');
const emptyRootWindowStack = rootWindowStack.get();
assert.deepEqual(emptyRootWindowStack,Array(6).fill(null));
const getTopWindow = prepared.get('deusex.deusexrootwindow.gettopwindow');
assert.ok(getTopWindow,'prepared original DeusExRootWindow.GetTopWindow');
assert.equal(runtime.callFunction(getTopWindow,rootWindow),null);
const topWindow = {};
runtime.attach(topWindow,await runtime.loadClass(deusEx,deusEx.exportsByPath.get('deusexbasewindow')));
const nonEmptyRootWindowStack = emptyRootWindowStack.slice();
nonEmptyRootWindowStack[0] = topWindow;
rootWindowStack.set(nonEmptyRootWindowStack);
rootWindowCount.set(1);
assert.equal(runtime.callFunction(getTopWindow,rootWindow),topWindow,
  'GetTopWindow returns the typed top of the original fixed stack');
rootWindowStack.set(emptyRootWindowStack);
rootWindowCount.set(0);
runtime.namedReference(player,'rootWindow').set(rootWindow);
const listItemClass = await runtime.loadClass(conSys,conSys.exportsByPath.get('conlistitem'));
const listItem = {};
runtime.attach(listItem,listItemClass);
runtime.namedReference(listItem,'con').set(conversation);
runtime.namedReference(player,'conListItems').set(listItem);
assert.equal(select('dl_start'),conversation,'original Caps comparison selects canonical conversation');
assert.deepEqual(nameCalls,[['DL_Start_Played',1]]);
triggerNatives.flagBase.setBool('DL_Start_Played',true);
assert.equal(select('DL_START'),null,'original display-once gate rejects a played conversation');
triggerNatives.flagBase.setBool('DL_Start_Played',false);
assert.equal(select('Dl_StArT'),conversation);

// Use an authored, nonempty original flag-reference chain for the other
// selection predicate. It is prepared lazily without manufacturing defaults.
const flagged = descriptors.find(item=>item.flagRefList?.length>0);
assert.ok(flagged,'original mission has a flagged conversation');
for(const item of flagged.flagRefList){
  await runtime.prepareObject(await runtime.objects.resolve(conText,item.ref));
  triggerNatives.flagBase.setBool(item.flagName,Boolean(item.value));
}
const flagHead = await runtime.objects.resolve(conText,flagged.flagRefListRef);
assert.equal(runtime.callFunction(checkFlagRefs,player,1,()=>flagHead),true);
const first = flagged.flagRefList[0];
triggerNatives.flagBase.setBool(first.flagName,!Boolean(first.value));
assert.equal(runtime.callFunction(checkFlagRefs,player,1,()=>flagHead),false);

// The original ConPlayBase body rejects a player whose current native state
// is Dying before it calls ConSys. Install that already-linked state directly:
// state-entry callbacks and death behavior are not part of this query fixture.
const dyingRecord = runtime.lookupMember(playerClass,'states','Dying');
assert.ok(dyingRecord);
const dyingState = await runtime.prepareState(dyingRecord.asset,dyingRecord.index);
runtime.instance(player).state.setStateNode(dyingState);
assert.equal(runtime.invokeNative({index:284,receiver:player,argumentCount:0}),'Dying');
assert.equal(runtime.callFunction(prepared.get('deusex.conplaybase.startconversation'),play,1,()=>player),false);
runtime.instance(player).state.setStateNode(null);
assert.equal(runtime.invokeNative({index:284,receiver:player,argumentCount:0}),'DeusExPlayer');
assert.equal(runtime.invokeNative({index:281,receiver:player,argumentCount:1,evaluateArgument:()=> 'PlayerPawn'}),true);

// The concrete Speech79 native binder writes the same canonical event used by
// the VM. Actors here retain original class defaults; allocation remains scoped
// to logical fixtures, as above.
const jaime = {};
runtime.attach(jaime,await runtime.loadClass(deusEx,deusEx.exportsByPath.get('jaimereyes')));
const fields={read:(o,k)=>runtime.namedReference(o,k).get(),write:(o,k,v)=>runtime.namedReference(o,k).set(v)};
assert.equal(fields.read(jaime,'BindName'),'JaimeReyes');
assert.equal(fields.read(player,'BindName'),'JCDenton');
assert.equal(bindSpeechActor({event,firstActor:null,secondActor:jaime,...fields}),true);
assert.equal(bindSpeechActor({event,firstActor:null,secondActor:player,...fields}),true);
assert.equal(fields.read(event,'speaker'),jaime);
assert.equal(fields.read(event,'speakingTo'),player);
await runtime.prepareObject(fields.read(event,'nextEvent'));
const checkActors=prepared.get('consys.conversation.checkactors');
const checkDistances=prepared.get('consys.conversation.checkactordistances');
assert.equal(runtime.callFunction(checkActors,conversation),true);
fields.write(jaime,'Location',[0,0,0]);
fields.write(player,'Location',[400,0,0]);
assert.equal(runtime.callFunction(checkDistances,conversation,1,()=>player),true,'player is excluded');
assert.equal(runtime.callFunction(checkDistances,conversation,1,()=>null),false);
fields.write(player,'Location',[300.9,0,0]);
assert.equal(runtime.callFunction(checkDistances,conversation,1,()=>null),true,'VSize converts to int before comparing with 300');
clearConversationEvents(conversation,fields);
assert.equal(fields.read(event,'speaker'),jaime,'ClearBindEvents preserves actor fields in the original DLL');
assert.equal(fields.read(event,'speakingTo'),player);
clearSpeechActors(event,fields);
assert.equal(fields.read(event,'speaker'),null);
assert.equal(fields.read(event,'speakingTo'),null);
assert.equal(runtime.callFunction(checkActors,conversation),false);

// Positive original ConPlayBase.StartConversation, including native writes
// through its actual Actor[10] property and the original AllActors body.
// These arrays are controlled fixtures, not the original live registry.
const info = {};
runtime.attach(info,await runtime.loadClass(deusEx,deusEx.exportsByPath.get('deusexlevelinfo')));
fields.write(info,'missionNumber',0);
fields.write(info,'MissionLocation','Training');
level.actors.push(info,player,jaime,play);
globalObjects.push(null,conversation,event,fields.read(event,'nextEvent'),jaime,player,info,play);
assert.equal(runtime.callFunction(prepared.get('deusex.conplaybase.startconversation'),play,1,()=>player),true);
assert.deepEqual(fields.read(play,'ConActorsBound'),[jaime,player,...Array(8).fill(null)]);
assert.equal(fields.read(event,'speaker'),jaime);
assert.equal(fields.read(event,'speakingTo'),player);
assert.equal(fields.read(play,'player'),player);
assert.equal(fields.read(play,'invokeActor'),null);
assert.equal(fields.read(play,'missionNumber'),0);
assert.equal(fields.read(play,'MissionLocation'),'Training');
assert.equal(fields.read(play,'saveRadiusDistance'),fields.read(conversation,'radiusDistance'));
assert.equal(fields.read(play,'rootWindow'),rootWindow);
assert.equal(fields.read(play,'bConversationStarted'),true);
runtime.callFunction(prepared.get('consys.conversation.clearbindevents'),conversation);
assert.equal(fields.read(event,'speaker'),jaime);
assert.equal(fields.read(event,'speakingTo'),player);

// Exercise the normal DataLinkPlay.StartConversation presentation path after
// the already-verified ConPlayBase gate. With a null player.conPlay and an
// empty canonical root-window stack, the original GetTopWindow returns None,
// then shared Window.NewChild reaches its original StaticConstructObject leaf.
// Do not substitute a window for the still-unbound native construction graph.
const playerConPlay = runtime.namedReference(player,'conPlay');
playerConPlay.set(null);
runtime.namedReference(play,'dataLink').set(null);
assert.equal(playerConPlay.get(),null);
assert.equal(rootWindowCount.get(),0);
const createInfoLinkWindow = prepared.get('deusex.deusexhud.createinfolinkwindow');
assert.ok(createInfoLinkWindow,'prepared original DeusExHUD.CreateInfoLinkWindow');
const startConversation = prepared.get('deusex.datalinkplay.startconversation');
assert.ok(startConversation,'prepared original DataLinkPlay.StartConversation');
const firstUnsupportedCall = nativeCalls.length;
assert.throws(
  () => runtime.callFunction(startConversation,play,1,()=>player),
  error => error === windowConstructionBoundary,
  'normal StartConversation reaches Window.NewChild StaticConstructObject',
);
assert.deepEqual(nativeCalls.slice(firstUnsupportedCall),[],
  'shared Window.NewChild handles 1410 before reaching its construction service');
assert.equal(windowConstructions.length,1);
assert.equal(windowConstructions[0].classObject,
  await runtime.objects.resolve(deusEx,deusEx.exportsByPath.get('hudinfolinkdisplay')));
assert.equal(windowConstructions[0].outer,hud);
assert.equal(windowConstructions[0].name,'None');
assert.equal(windowConstructions[0].flags,0);
assert.equal(windowConstructions[0].template,null);
assert.equal(windowConstructions[0].error,windowErrorDevice);
assert.equal(runtime.namedReference(hud,'infolink').get(),null,
  'CreateInfoLinkWindow does not publish infolink before NewChild succeeds');

// Isolate the next native->script boundary with a typed child fixture. This
// does not substitute that fixture for native allocation in StartConversation.
const infoLinkFixture = {};
runtime.attach(infoLinkFixture,await runtime.loadClass(deusEx,deusEx.exportsByPath.get('hudinfolinkdisplay')));
windowParents.set(infoLinkFixture,hud);
const themeManager = {}, hudTheme = {};
runtime.attach(themeManager,await runtime.loadClass(deusEx,deusEx.exportsByPath.get('colorthememanager')));
runtime.attach(hudTheme,await runtime.loadClass(deusEx,deusEx.exportsByPath.get('colorthemehud_default')));
runtime.namedReference(player,'ThemeManager').set(themeManager);
runtime.namedReference(themeManager,'currentHUDTheme').set(hudTheme);
const beforeInitCalls=nativeCalls.length;
const beforeHierarchyReads=hierarchyReads.length;
assert.throws(()=>runtime.processWindowScript({object:infoLinkFixture,event:'InitWindow',
  parameters:null,thirdArgument:1}),
  error=>/Original function is not prepared: deusEx\.hudinfolinkdisplay\.createcontrols/i.test(error?.message));
assert.deepEqual(nativeCalls.slice(beforeInitCalls),[],
  'shared native1431 handles SetSize before the explicit CreateControls boundary');
assert.deepEqual(windowSizeCalls,[{object:infoLinkFixture,args:[431,114]}]);
assert.equal(windowDimensions.get(infoLinkFixture).get(WINDOW_SIZE_OFFSETS.width),431);
assert.equal(windowDimensions.get(infoLinkFixture).get(WINDOW_SIZE_OFFSETS.height),114);
assert.deepEqual(hierarchyReads.slice(beforeHierarchyReads),[infoLinkFixture,hud,rootWindow]);
assert.equal(runtime.namedReference(infoLinkFixture,'player').get(),player,
  'original HUDBaseWindow.InitWindow assigns the canonical root parentPawn before StyleChanged');
const colorChannels = value => ['r','g','b','a'].map(name=>value['core.object.color.'+name]);
const authoredTheme = readClass(deusEx,deusEx.exportsByPath.get('colorthemehud_default')).values;
for(const [field,color] of [['colBackground','Colors'],['colBorder','Colors[1]'],
  ['colText','Colors[8]'],['colHeaderText','Colors[7]'],['colName','Colors[7]'],
  ['colLine','Colors[8]'],['colCursor','Colors[7]'],['colQueued','Colors[8]']]){
  assert.deepEqual(colorChannels(runtime.namedReference(infoLinkFixture,field).get()),authoredTheme[color],
    'original style event assigns authored '+field);
}
assert.equal(runtime.namedReference(infoLinkFixture,'bDrawBorder').get(),
  runtime.namedReference(player,'bHUDBordersVisible').get());

assert.equal(DATALINK_NATIVE_INDICES.BindEvents, 2052);
assert.equal(DATALINK_NATIVE_INDICES.BindActorEvents, 2053);
console.log('DataLink original VM validation passed: ' + prepared.size + ' original function/native records prepared; ' +
  'Mission00 has 470 descriptors; canonical Conversation57/ConEventSpeech79 resolved; ' +
  'original SetConversation, fixed queue, SetTrigger, nonempty CheckFlagRefs and GetActiveDataLink gates executed; ' +
  'typed GetTopWindow returned its stack top; normal StartConversation reached Window.NewChild StaticConstructObject through shared native1410 after ' +
  'original ConPlayBase.StartConversation returned true with native-bound actors and mission fields; '+
  'isolated InfoLink InitWindow assigned authored theme colors and native SetSize(431,114) before the explicit CreateControls boundary.');
