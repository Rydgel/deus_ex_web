/** Focused original DataLinkPlay start/speech/end, native HUD/audio and queue integration. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { loadTrainingDataLinkCatalog } from '../src/runtime/script-training-datalinks.mjs';
import { createGame } from '../src/viewer/game.mjs';
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
const catalog = await loadTrainingDataLinkCatalog(assets);
assert.equal(catalog.counts.trainingTriggers, 18);

const events = [];
const game = await createGame(decodeMap(mapAsset.bytes), mapAsset, assets, {
  randomSeed: 1, presentation: true,
  onDataLinkTransmission: event => events.push(event),
});
const runtime = game.doors.scriptRuntime.runtime;
// Player start logs in a new player; re-read it after every reset.
let player = game.player.collisionActor;
const portraitAsset = await assets.get(catalog.speaker.portrait.packageName);
const portraitObject = await runtime.objects.resolve(portraitAsset, catalog.speaker.portrait.exportIndex);
const dynamicGraph = runtime.dynamicLoadGraph;
assert.strictEqual(dynamicGraph.preparedObject(catalog.speaker.portrait.objectName),
  portraitObject,'the native DynamicLoadObject path owns the prepared canonical portrait');
assert.equal(dynamicGraph.firstLoadPackages.has('infoportraits'), true,
  'the portrait package identity is ready before the native frame');
assert.equal(dynamicGraph.linkerByPackage.has('infoportraits'), false,
  'the canonical portrait linker is constructed at first StaticLoadObject');
const level = runtime.levelFor(player);
const triggerFor = route => level.actors.find(actor => actor?.name === route.trigger.name);
const eventKinds = () => events.map(event => `${event.kind}:${event.tag}`);
const tickUntil = (predicate, limit = 420) => {
  for (let index = 0; index < limit && !predicate(); index++) game.tick(1 / 120, {});
  assert.ok(predicate(), `live DataLink condition was not reached in ${limit} frames`);
};

// Catalog validation already covers all 18 original route graphs/resources.
// Cross the changed scheduler/HUD/audio boundary on the first route and the
// differently timed door route, then exercise their original queue below.
const selectedRoutes=[catalog.routeForTag('dl_start'),catalog.routeForTag('dl_door')];
for (const route of selectedRoutes) {
  console.log(`DataLink integration: ${route.dataLinkTag}`);
  if(route!==selectedRoutes[0])game.reset();
  player=game.player.collisionActor;
  events.length = 0;
  const trigger = triggerFor(route);
  assert.ok(trigger, `missing live ${route.trigger.name}`);
  if (route.trigger.checkFlag)
    game.doors.scriptRuntime.triggerActions.flagBase.setBool(route.trigger.checkFlag, true);
  assert.equal(runtime.processEvent(trigger, 'Touch', [player]), true);
  game.doors.scriptRuntime.dataLinkActive(); // read-only observer at this explicit event boundary
  assert.equal(events[0]?.kind, 'started');
  assert.equal(events[0]?.tag, route.dataLinkTag);
  assert.equal(events[0]?.trigger, trigger);
  const play = runtime.namedReference(player, 'dataLinkPlay').get();
  assert.ok(play);
  assert.equal(runtime.namedReference(play, 'con').get().index, route.conversation.exportIndex);
  assert.equal(runtime.namedReference(play, 'currentEvent').get().index,
    route.chain.speechEvent.exportIndex);
  const presentation = game.doors.scriptRuntime.dataLinkPresentation();
  assert.equal(presentation.tag, route.dataLinkTag);
  assert.equal(presentation.content.speech, route.chain.speech.text);
  assert.equal(presentation.content.speakerDisplayName, 'Jaime Reyes');
  assert.equal(presentation.audio.soundId, route.audio.soundId);
  assert.equal(presentation.audio.sha256, route.audio.sha256);
  assert.equal(presentation.audio.seconds, route.audio.seconds);
  console.log('DataLink integration: startup timer');
  tickUntil(() => events.some(event => event.kind === 'speech'));
  const shell = await game.doors.scriptRuntime.infoLinkShell();
  assert.equal(runtime.namedReference(shell.object, 'speakerPortrait').get(), portraitObject,
    'installed SetSpeaker assigns the canonical InfoPortraits.JaimeReyes object');
  assert.equal(runtime.boundaryFunctions.has('deusex.hudinfolinkdisplay.setspeaker'), false,
    'SetSpeaker itself is not replaced by a host boundary');
  assert.equal(runtime.boundaryFunctions.has('core.object.dynamicloadobject'), false,
    'DynamicLoadObject executes through its installed native wrapper');
  if (route === catalog.routes[0]) {
    assert.deepEqual(dynamicGraph.lastEvents.map(event => event.op), [
      'StaticLoadObject', 'BeginLoad', 'ResolveName', 'GetPackageLinker',
      'CreateLinkerLoad', 'FName', 'FindExportIndex', 'CreateExport', 'EndLoad',
      'Logf', 'FArrayRealloc',
    ], 'first portrait load preserves the native linker/export/end-load order');
    const linker = dynamicGraph.linkerByPackage.get('infoportraits');
    assert.equal(linker?.kind, 'ULinkerLoad');
    assert.equal(linker?.constructor?.body, 0x10160000);
    assert.equal(linker?.archive?.nativeVtable, 0x1017a430);
    assert.equal(linker?.archive?.baseVtable, 0x101751f8);
    assert.ok(linker?.reader, 'first-load ULinkerLoad has a live reader');
  }
  assert.equal(runtime.namedReference(play, 'currentEvent').get().index,
    route.chain.speechEvent.exportIndex, 'speech phase keeps the resolved Speech event');
  assert.equal(events.find(event => event.kind === 'speech')?.tag, route.dataLinkTag);

  // One complete route crosses original Timer -> WaitForSpeech.Sleep ->
  // PlayEvent -> TerminateConversation, all under the real level scheduler.
  if (route === catalog.routes[0]) {
    assert.equal(runtime.instance(play).state.stateNode.record.key,'deusex.datalinkplay.waitforspeech');
    const display=runtime.readNamed(play,'dataLink');
    assert.ok(game.doors.scriptRuntime.windowHost.owns(display),'native host owns InfoLink');
    assert.ok(game.doors.scriptRuntime.windowHost.owns(runtime.readNamed(display,'winText')),
      'native host owns ComputerWindow; there is no delegated InfoLink subtree');
    for(let frame=0;frame<24;frame++)game.tick(1/120,{});
    const host=game.doors.scriptRuntime.windowHost,textWindow=runtime.readNamed(display,'winText');
    const displayed=host.computerText(textWindow);
    assert.ok(displayed.trim().length>0,'native ComputerWindow tick consumed authored speech characters');
    assert.ok(route.chain.speech.text.startsWith(displayed.trim()),'displayed characters come from original Print queue');
    const commands=game.hud.commands(960,600,{location:game.player.eye,rotation:game.player.viewRotation,fov:75});
    assert.ok(commands.some(command=>command.texture.key===portraitObject.key),
      'native HUD draw submits the canonical portrait');
    assert.equal(runtime.boundaryFunctions.has('deusex.deusexplayer.startdatalinktransmission'),false);
    assert.equal(runtime.boundaryFunctions.has('deusex.datalinkplay.startconversation'),false);
    const requests=game.doors.scriptRuntime.liveConPlay.soundRequests.filter(x=>x.kind==='speech');
    assert.equal(requests[0].audio.soundObject,'DataLinkStart');
    assert.equal(requests[1].audio.soundId,route.audio.soundId);
    assert.equal(requests[1].audio.bytes.byteLength,route.audio.bytes.byteLength);
    console.log('DataLink integration: speech timer and latent sleep');
    tickUntil(() => events.some(event => event.kind === 'ending' && event.tag === route.dataLinkTag), 2400);
    assert.deepEqual(events.filter(event => event.tag === route.dataLinkTag).map(event => event.kind),
      ['started', 'speech', 'ending'], 'original script fields determine diagnostic lifecycle order');
    assert.equal(runtime.namedReference(play, 'currentEvent').get(), null);
    assert.equal(runtime.namedReference(play, 'lastEvent').get(), null,
      'inherited TerminateConversation clears the event history fields');
    const history=runtime.readNamed(player,'conHistory');
    assert.ok(history,'original SetupHistory/TerminateConversation saves history');
    assert.ok(runtime.readNamed(history,'firstEvent'),'original SetupEventSpeech saved the event');
  }

}

// The boundary remains explicit for a name that is outside the 18 authored
// map routes; it must not fabricate a conversation or presentation.
console.log('DataLink integration: original queue');
game.reset();player=game.player.collisionActor;
events.length = 0;
const startRecord = runtime.lookup(player, 'StartDataLinkTransmission');
assert.equal(runtime.callFunction(startRecord, player, 1, () => 'dl_not_authored'), false);
assert.equal(events.length, 0);

// A second eligible trigger queues on the one existing DataLinkPlay. The VM's
// PopDataLink body then selects the queued original Conversation after the
// first route's end delay.
const first = catalog.routeForTag('dl_start');
const second = catalog.routeForTag('dl_door');
const firstTrigger = triggerFor(first), secondTrigger = triggerFor(second);
assert.equal(runtime.processEvent(firstTrigger, 'Touch', [player]), true);
game.doors.scriptRuntime.dataLinkActive();
const firstShell = await game.doors.scriptRuntime.infoLinkShell();
assert.equal(runtime.processEvent(secondTrigger, 'Touch', [player]), true);
const play = runtime.namedReference(player, 'dataLinkPlay').get();
const queue = runtime.namedReference(play, 'dataLinkQueue').get();
assert.equal(queue[0].index, second.conversation.exportIndex);
assert.deepEqual(eventKinds(), ['started:dl_start']);
tickUntil(() => events.some(event => event.kind === 'started' && event.tag === 'dl_door'), 2400);
assert.ok(eventKinds().includes('ending:dl_start'));
const secondShell = await game.doors.scriptRuntime.infoLinkShell();
assert.notEqual(secondShell.object, firstShell.object,
  'queue advance reconstructs a fresh HUDInfoLinkDisplay');
assert.equal(firstShell.isDestroyed(firstShell.object), true,
  'queue advance destroys the previous InfoLink through the original HUD function');
for (const object of Object.values(firstShell.objects)) assert.equal(firstShell.isDestroyed(object), true);
assert.equal(secondShell.isDestroyed(secondShell.object), false);
assert.equal(runtime.namedReference(secondShell.hud, 'infoLink').get(), secondShell.object);
assert.equal(runtime.namedReference(play, 'dataLink').get(), secondShell.object);
assert.equal(game.doors.scriptRuntime.dataLinkPresentation().tag, 'dl_door');
assert.equal(game.doors.scriptRuntime.dataLinkPresentation().audio.sha256, second.audio.sha256);

console.log('Live Training DataLinks passed: start/door routes admitted with resolved Conversation/Speech/End identities, installed SetSpeaker assigned the canonical portrait, the prepared Speech-to-End PlayNextEvent/SetupEvent/EA_End lifecycle completed before original termination, canonical route metadata and native PlaySound requests recorded, unknown tags rejected, and the one-active-play queue advanced through original HUD destruction, PopDataLink, native host construction, and original timer/state scheduling.');
