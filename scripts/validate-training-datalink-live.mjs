/** Validate all authored Training DataLink admissions and the live queue. */
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
  randomSeed: 1,
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

// Every map trigger must enter through its exact catalog tag and expose the
// resolved original package objects plus its route-specific content/audio.
for (const route of catalog.routes) {
  game.reset();player=game.player.collisionActor;
  events.length = 0;
  const trigger = triggerFor(route);
  assert.ok(trigger, `missing live ${route.trigger.name}`);
  if (route.trigger.checkFlag)
    game.doors.scriptRuntime.triggerActions.flagBase.setBool(route.trigger.checkFlag, true);
  assert.equal(runtime.processEvent(trigger, 'Touch', [player]), true);
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

  // One complete route proves the source-authored Speech -> End transition.
  // PlayNextEvent must first leave lastEvent=Speech/currentEvent=End, then the
  // prepared PlayEvent.SetupEvent + inherited SetupEventEnd path must pass
  // EA_End through ProcessAction, clear currentEvent, and only then enter the
  // DataLinkPlay termination body.
  if (route === catalog.routes[0]) {
    tickUntil(() => events.some(event => event.kind === 'ending' && event.tag === route.dataLinkTag), 2400);
    assert.deepEqual(events.filter(event => event.tag === route.dataLinkTag).map(event => event.kind),
      ['started', 'speech', 'ending'], 'public DataLink lifecycle event order is preserved');
    const ending = events.find(event => event.kind === 'ending' && event.tag === route.dataLinkTag);
    assert.ok(ending?.trace, 'termination publishes the original end transition trace');
    assert.deepEqual(ending.trace.map(edge => edge.stage),
      ['end-setup', 'end-action', 'end-null'],
      'original DataLink end edges occur in source order');
    const setup = ending.trace.find(edge => edge.stage === 'end-setup');
    assert.ok(setup, 'original PlayNextEvent reached the End setup edge');
    assert.equal(setup.lastEvent?.index, route.chain.speechEvent.exportIndex,
      'PlayNextEvent records the resolved Speech as lastEvent');
    assert.equal(setup.currentEvent?.index, route.chain.endEvent.exportIndex,
      'PlayNextEvent leaves the resolved End as currentEvent during setup');

    const action = ending.trace.find(edge => edge.stage === 'end-action');
    assert.ok(action, 'prepared ProcessAction reached the End action edge');
    assert.equal(action.action, 'EA_End');
    assert.equal(action.actionValue, 8, 'SetupEventEnd returned the original EA_End enum value');
    assert.equal(action.currentEvent?.index, route.chain.endEvent.exportIndex);

    const cleared = ending.trace.find(edge => edge.stage === 'end-null');
    assert.ok(cleared, 'EA_End cleared currentEvent before termination');
    assert.equal(cleared.currentEvent, null);
    assert.equal(cleared.lastEvent?.index, route.chain.endEvent.exportIndex,
      'ProcessAction records End before entering TerminateConversation');
    assert.equal(runtime.namedReference(play, 'currentEvent').get(), null);
    assert.equal(runtime.namedReference(play, 'lastEvent').get(), null,
      'inherited TerminateConversation clears the event history fields after the transition');
  }
}

// The boundary remains explicit for a name that is outside the 18 authored
// map routes; it must not fabricate a conversation or presentation.
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

console.log('Live Training DataLinks passed: all 18 catalog routes admitted with resolved Conversation/Speech/End identities, installed SetSpeaker assigned the canonical portrait, the prepared Speech-to-End PlayNextEvent/SetupEvent/EA_End lifecycle completed before original termination, exact route content/audio/timing published, unknown tags rejected, and the one-active-play queue advanced through original HUD destruction, PopDataLink, and fresh shell construction.');
