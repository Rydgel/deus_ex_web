/** Original-DLL and ScriptRuntime validation for Conversation.BindEvents and
 * Conversation.BindActorEvents (ConSys natives 2052/2053).
 *
 * The event-specific virtual BindActor bodies are a separate native boundary;
 * this validator supplies an explicit callback fixture so it can verify the
 * surrounding DConversation loops without inventing subclass behavior.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readClass } from '../src/unreal/classes.mjs';
import { readObject } from '../src/unreal/objects.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import { ScriptRuntime } from '../src/runtime/script-runtime.mjs';
import { propertyReference } from '../src/runtime/script-values.mjs';
import {
  CONVERSATION_ACTOR_CLASS_ORDER,
  CONVERSATION_EVENT_FUNCTIONS,
  CONVERSATION_EVENT_NATIVE_INDICES,
  bindActorEventsNative,
  createConversationEventsNativeService,
  prepareConversationEventFunctions,
} from '../src/runtime/script-conversation-events.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const files = [];
for (const name of await readdir(path.join(root, 'System')))
  files.push({ path: `System/${name}`, read: () => readFile(path.join(root, 'System', name)) });
const assets = new AssetStore(files);
const conSys = await assets.get('ConSys');
const conText = await assets.get('DeusExConText');

function sourceFor(asset, classPath) {
  const index = asset.exportsByPath.get(classPath);
  assert.ok(index, `missing original ${asset.name}.${classPath}`);
  const metadata = readClass(asset, index);
  assert.ok(metadata.scriptText, `${asset.name}.${classPath} has no TextBuffer`);
  const reader = readObject(asset.pkg, asset.bytes, metadata.scriptText).reader;
  reader.u32();
  reader.u32();
  return reader.string(asset.pkg.version);
}

function bytesAt(bytes, offset, length) {
  return [...bytes.subarray(offset, offset + length)];
}

function expectBytes(bytes, offset, expected, label) {
  assert.deepEqual(bytesAt(bytes, offset, expected.length), expected, label);
}

const conversationSource = sourceFor(conSys, 'conversation');
assert.match(conversationSource,
  /intrinsic\(2052\)\s+final\s+function\s+BindEvents\s*\(\s*Actor\s+conBoundActors\[10\]\s*,\s*Actor\s+invokeActor\s*\)/i);
assert.match(conversationSource,
  /intrinsic\(2053\)\s+final\s+function\s+BindActorEvents\s*\(\s*Actor\s+actorToBind\s*\)/i);

for (const item of CONVERSATION_EVENT_FUNCTIONS) {
  const index = conSys.exportsByPath.get(item.path);
  assert.ok(index, `missing original ${item.path}`);
  const metadata = readFunctionMetadata(conSys, index);
  assert.equal(metadata.nativeIndex, item.nativeIndex, `${item.path} native index`);
  assert.equal(metadata.scriptSize, item.size, `${item.path} script size`);
}

const dllPath = path.join(root, 'System', 'ConSys.dll');
const dll = new Uint8Array(await readFile(dllPath));
assert.equal(createHash('sha256').update(dll).digest('hex'),
  'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa',
  'installed ConSys.dll hash');

// PE .text starts at file offset 0x1000, so these file offsets are the
// recovered RVAs used by the disassembly. The slices pin the exact memset,
// class-pass call setup, virtual BindActor dispatch, fixed-array write loop,
// and duplicate-actor path.
expectBytes(dll, 0xfec0, [
  0x83, 0xec, 0x18, 0x8b, 0x44, 0x24, 0x1c, 0x53, 0x56, 0x57,
  0x6a, 0x28, 0x6a, 0x00, 0x8b, 0xd9, 0x50, 0xff, 0x15, 0x3c, 0x31, 0x01, 0x10,
], 'DConversation::BindEvents memset prologue');
expectBytes(dll, 0xff2e, [0x50, 0x51, 0x52, 0x8b, 0xcb, 0xe8, 0xb8, 0x01, 0x00, 0x00],
  'DConversation::BindEvents first actor call');
expectBytes(dll, 0xff89, [
  0xa1, 0x54, 0x31, 0x01, 0x10, 0xc7, 0x44, 0x24, 0x18,
  0xff, 0xff, 0xff, 0xff, 0x85, 0xc0, 0x89, 0x44, 0x24, 0x14,
], 'DConversation::BindEvents second class pass');
expectBytes(dll, 0x10032, [
  0xa1, 0x50, 0x31, 0x01, 0x10, 0xc7, 0x44, 0x24, 0x20,
  0xff, 0xff, 0xff, 0xff, 0x85, 0xc0, 0x89, 0x44, 0x24, 0x1c,
], 'DConversation::BindEvents third class pass');
expectBytes(dll, 0x10114, [
  0x68, 0xcc, 0xe1, 0x01, 0x10, 0x50, 0xff, 0x15, 0xd0, 0x30, 0x01, 0x10,
  0x83, 0xc4, 0x08, 0x85, 0xc0, 0x74, 0x6f,
], 'DConversation::BindEventsToActor empty-name gate');
expectBytes(dll, 0x10174, [
  0x8b, 0x06, 0x53, 0x57, 0x55, 0x8b, 0xce, 0xff, 0x50, 0x58,
  0x84, 0xc0, 0x74, 0x0d, 0x8b, 0x4c, 0x24, 0x14, 0x57, 0x51,
  0x8b, 0xcb, 0xe8, 0x11, 0x00, 0x00, 0x00,
], 'DConversation::BindEventsToActor virtual BindActor');
expectBytes(dll, 0x101a0, [
  0x56, 0x8b, 0x74, 0x24, 0x0c, 0x57, 0x8b, 0x7c, 0x24, 0x0c,
  0x33, 0xc0, 0x8b, 0xd7, 0x8b, 0x0a, 0x3b, 0xce, 0x74, 0x15,
  0x85, 0xc9, 0x74, 0x0e, 0x40, 0x83, 0xc2, 0x04, 0x83, 0xf8, 0x0a, 0x7c, 0xed,
  0x5f, 0x5e, 0xc2, 0x08, 0x00, 0x89, 0x34, 0x87, 0x5f, 0x5e, 0xc2, 0x08, 0x00,
], 'DConversation::AddBoundActor');
expectBytes(dll, 0x101d0, [
  0x53, 0x8b, 0xd9, 0x56, 0x8b, 0x73, 0x58, 0x85, 0xf6, 0x74, 0x17,
  0x57, 0x8b, 0x7c, 0x24, 0x10, 0x8b, 0x06, 0x53, 0x57, 0x57,
  0x8b, 0xce, 0xff, 0x50, 0x58, 0x8b, 0x76, 0x38, 0x85, 0xf6, 0x75, 0xef,
  0x5f, 0x5e, 0x5b, 0xc2, 0x04, 0x00,
], 'DConversation::BindActorEvents');
expectBytes(dll, 0x10780, [
  0xa1, 0x40, 0x31, 0x01, 0x10, 0x81, 0xec, 0x04, 0x04, 0x00, 0x00,
  0x33, 0xd2, 0x53, 0x56, 0x8b, 0xb4, 0x24, 0x10, 0x04, 0x00, 0x00,
], 'execBindEvents wrapper');
expectBytes(dll, 0x10840, [
  0x51, 0x56, 0x8b, 0x74, 0x24, 0x0c, 0x33, 0xd2, 0xc7, 0x44, 0x24, 0x04,
  0x00, 0x00, 0x00, 0x00,
], 'execBindActorEvents wrapper');

// Prepare the installed native UFunctions through ScriptRuntime. The native
// callback below is the only host implementation: the VM still resolves the
// original records and invokes them by native index.
let nativeCalls = [];
let nativeService;
const runtime = new ScriptRuntime(assets, {
  boundaryNatives:[2052,2053],
  native: call => {
    nativeCalls.push(call);
    return nativeService(call);
  },
});
const prepared = await prepareConversationEventFunctions(runtime, { conSys });
assert.equal(prepared.size, CONVERSATION_EVENT_FUNCTIONS.length);
for (const item of CONVERSATION_EVENT_FUNCTIONS) {
  const key = `consys.${item.path}`;
  const record = prepared.get(key);
  assert.ok(record, `prepared ${key}`);
  assert.equal(record.function.script.nativeIndex, item.nativeIndex);
}

// Mission00's canonical package exports exercise reference identity and the
// real Conversation.eventList -> ConEventSpeech -> ConEventEnd chain. Only
// tagged logical fields are prepared; no native constructor is claimed here.
const conversation = await runtime.objects.resolve(conText, 1926);
const speech = runtime.namedReference(await runtime.prepareObject(conversation), 'eventList').get();
assert.equal(conversation.name, 'Conversation57');
assert.equal(speech.name, 'ConEventSpeech79');
await runtime.prepareObject(speech);
const ending = runtime.namedReference(speech, 'nextEvent').get();
assert.equal(ending?.name, 'ConEventEnd77');
await runtime.prepareObject(ending);

const actors = {
  first: { name: 'FirstPawn', className: 'Pawn', BindName: 'Shared' },
  second: { name: 'SecondPawn', className: 'Pawn', BindName: 'Shared' },
  player: { name: 'PlayerPawn', className: 'PlayerPawn', BindName: 'Shared' },
  decoration: { name: 'Decoration0', className: 'Decoration', BindName: 'Other' },
  none: { name: 'NoBinding', className: 'Pawn', BindName: '' },
};
const globalObjects = [null, actors.first, actors.second, actors.player, actors.decoration, actors.none];
const read = (object, field) => {
  if (object === conversation || object === speech || object === ending)
    return runtime.namedReference(object, field).get();
  return object[field];
};
const reference = value => value;
const isA = (object, classToken) => {
  return classToken === 'Pawn'
    ? object.className === 'Pawn' || object.className === 'PlayerPawn'
    : object.className === classToken;
};
const arrayReads = [];
const arrayWrites = [];
const readArray = (array, index) => {
  arrayReads.push(index);
  return array[index];
};
const writeArray = (array, index, value) => {
  arrayWrites.push([index, value]);
  array[index] = value;
};
const binderCalls = [];
const bindActor = details => {
  binderCalls.push(details);
  // This controlled fixture exercises the true branch only for Speech. The
  // actual Speech/End native bodies are a separate explicit callback service.
  return details.event === speech;
};
// The adapter is installed only after the canonical objects and explicit
// services are prepared. Runtime's native callback closes over this binding,
// while preparation above still occurs through the original UFunctions.
nativeService = createConversationEventsNativeService({
  read,
  write: () => {},
  isA,
  reference,
  objects: globalObjects,
  bindActor,
  readArray,
  writeArray,
});

// Native adapter uses VM-style references for both the out array and actor.
let output = Array(10).fill(actors.first);
const arrayReference = propertyReference({type:'object',arrayDim:10,elementSize:4},
  () => output, value => { arrayWrites.push(value); output = value; });
const actorReference = {
  reference: true,
  get: () => actors.first,
  set: () => {},
};
const bindEvents = prepared.get('consys.conversation.bindevents');
assert.equal(runtime.callFunction(bindEvents, conversation, 2,
  index => index === 0 ? arrayReference : actorReference), undefined);
assert.deepEqual(output, [actors.first, actors.decoration, ...Array(8).fill(null)]);
assert.deepEqual(nativeCalls.map(call => call.index), [CONVERSATION_EVENT_NATIVE_INDICES.BindEvents]);
assert.equal(binderCalls.length, 4); // First actor and different-name decoration; shared-name others skipped.
assert.ok(binderCalls.every(call => call.conversation === conversation));
assert.ok(binderCalls.every(call => call.mode === 'BindEvents'));
assert.ok(binderCalls.every(call => call.firstActor === actors.first));
assert.deepEqual(binderCalls.map(call => [call.secondActor.name, call.event.name]), [
  ['FirstPawn', 'ConEventSpeech79'], ['FirstPawn', 'ConEventEnd77'],
  ['Decoration0', 'ConEventSpeech79'], ['Decoration0', 'ConEventEnd77'],
]);
assert.equal(arrayWrites.length, 12); // memset ten slots plus two first-time inserts.
assert.equal(arrayReads.length, 0); // Typed lvalues use VM storage, not the raw fixture-array service.

const bindActorEvents = prepared.get('consys.conversation.bindactorevents');
const actorEventsReference = { reference: true, get: () => actors.second, set: () => {} };
assert.equal(runtime.callFunction(bindActorEvents, conversation, 1, () => actorEventsReference), undefined);
assert.equal(nativeCalls.at(-1).index, CONVERSATION_EVENT_NATIVE_INDICES.BindActorEvents);
const actorEventCalls = binderCalls.slice(-2);
assert.equal(actorEventCalls.length, 2);
assert.ok(actorEventCalls.every(call => call.mode === 'BindActorEvents'));
assert.ok(actorEventCalls.every(call => call.firstActor === actors.second && call.secondActor === actors.second));

// Direct null-event invocation reaches the original early return and does no
// event callback work, while the exact fixed array remains initialized by the
// BindEvents path above.
const emptyConversation = { eventList: null };
const emptyCalls = [];
bindActorEventsNative({
  conversation: emptyConversation,
  actorToBind: null,
  read,
  write: () => {},
  reference,
  bindActor: call => emptyCalls.push(call),
});
assert.deepEqual(emptyCalls, []);

assert.deepEqual(CONVERSATION_ACTOR_CLASS_ORDER, ['Pawn', 'Decoration', 'PlayerPawn']);
console.log('ConSys conversation events validated: original source/metadata, hash-pinned ' +
  '2052/2053 wrappers and bodies, canonical Mission00 Conversation57 event chain, ' +
  'three-pass BindEvents fixed-array behavior, and BindActorEvents duplicate-actor dispatch passed. ' +
  'Event subclass bodies remain an explicit binder boundary.');
