/** Validate the recovered ConEventMoveCamera BindActor and DataLinkPlay edge.
 *
 * This is the one generic conversation event slice admitted here.  It pins
 * the installed native vtable/body, the original ConSys declaration, and the
 * authored Mission00 Conversation0/M00MeetPage MoveCamera -> Speech edge.
 * DataLinkPlay's source groups ET_MoveCamera with the no-op setup cases, so
 * the prepared SetupEvent must leave its local action at EA_NextEvent (0),
 * which the original ProcessAction then applies to currentEvent.nextEvent.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readClass } from '../src/unreal/classes.mjs';
import { readObject } from '../src/unreal/objects.mjs';
import { refValue } from '../src/runtime/script-vm.mjs';
import { ScriptRuntime } from '../src/runtime/script-runtime.mjs';
import {
  CONVERSATION_BASE_BIND,
  CONVERSATION_MOVE_CAMERA_BIND,
  bindConversationMoveCameraActor,
  conversationMoveCameraBindNativeContract,
  isConversationBaseBindClass,
  isConversationMoveCameraBindClass,
} from '../src/runtime/script-conversation-base-bind.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const files = [];
for (const name of await readdir(path.join(root, 'System')))
  files.push({path: `System/${name}`, read: () => readFile(path.join(root, 'System', name))});
const assets = new AssetStore(files);
const conSys = await assets.get('ConSys');
const conText = await assets.get('DeusExConText');
const deusEx = await assets.get('DeusEx');

function sourceFor(asset, index) {
  const metadata = readClass(asset, index);
  assert.ok(metadata.scriptText, `${asset.name}.${index} has a TextBuffer`);
  const reader = readObject(asset.pkg, asset.bytes, metadata.scriptText).reader;
  reader.u32();
  reader.u32();
  return {metadata, source: reader.string(asset.pkg.version)};
}

function get(runtime, object, name) {
  return runtime.namedReference(object, name).get();
}

function set(runtime, object, name, value) {
  runtime.namedReference(object, name).set(value);
}

// ConSys.u: class export 24 and TextBuffer export 312 are the installed
// original records for this exact event class.
const moveClassIndex = conSys.exportsByPath.get('coneventmovecamera');
assert.equal(moveClassIndex, 24, 'ConSys.ConEventMoveCamera export');
const moveSource = sourceFor(conSys, moveClassIndex);
assert.equal(moveSource.metadata.classFlags, 0x112);
assert.equal(moveSource.metadata.scriptText, 312);
assert.match(moveSource.source,
  /class\s+ConEventMoveCamera\s+extends\s+ConEvent[\s\S]*?native[\s\S]*?noexport/i);

// Source evidence fixes both the event enum value and the setup/action order.
const dataLinkPlaySource = await readFile(
  path.join(process.cwd(), '.cache', 'reference', 'DataLinkPlay.uc'), 'utf8');
const conPlayBaseSource = await readFile(
  path.join(process.cwd(), '.cache', 'reference', 'ConPlayBase.uc'), 'utf8');
assert.match(conPlayBaseSource, /EA_NextEvent\s*,/);
assert.match(conPlayBaseSource, /ET_MoveCamera\s*,\s*\/\/\s*6/);
assert.match(dataLinkPlaySource,
  /case\s+ET_MoveCamera:[\s\S]*?case\s+ET_Choice:[\s\S]*?case\s+ET_Trade:[\s\S]*?break;/);
assert.match(dataLinkPlaySource,
  /case\s+EA_NextEvent:[\s\S]*?currentEvent\s*=\s*currentEvent\.nextEvent;[\s\S]*?GotoState\s*\(\s*'PlayEvent'\s*\)/);

// Hash-pinned native evidence. The body is at VMA 0x100098f0 and is reached
// through ConEventMoveCamera's exported vtable slot +0x58.
const dllPath = path.join(root, 'System', 'ConSys.dll');
const dll = new Uint8Array(await readFile(dllPath));
assert.equal(createHash('sha256').update(dll).digest('hex'),
  'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa',
  'installed ConSys.dll hash');
const u16 = offset => dll[offset] | (dll[offset + 1] << 8);
const u32 = offset => (dll[offset] | (dll[offset + 1] << 8) |
  (dll[offset + 2] << 16) | (dll[offset + 3] << 24)) >>> 0;
const pe = u32(0x3c);
assert.deepEqual([...dll.subarray(pe, pe + 4)], [0x50, 0x45, 0, 0], 'PE signature');
const coff = pe + 4;
const sectionCount = u16(coff + 2);
const optionalSize = u16(coff + 16);
const optional = coff + 20;
assert.equal(u16(optional), 0x10b, 'ConSys PE32');
const imageBase = u32(optional + 28);
assert.equal(imageBase, 0x10000000, 'ConSys image base');
const sections = [];
for (let index = 0; index < sectionCount; index++) {
  const section = optional + optionalSize + index * 40;
  sections.push({
    virtualAddress: u32(section + 12),
    virtualSize: u32(section + 8),
    rawOffset: u32(section + 20),
    rawSize: u32(section + 16),
  });
}
function rvaOffset(rva) {
  for (const section of sections) {
    const size = Math.max(section.virtualSize, section.rawSize);
    if (rva >= section.virtualAddress && rva < section.virtualAddress + size)
      return section.rawOffset + rva - section.virtualAddress;
  }
  throw new Error(`RVA outside installed ConSys sections: 0x${rva.toString(16)}`);
}
function readRva(rva) { return u32(rvaOffset(rva)); }
function bytesAtRva(rva, length) {
  return [...dll.subarray(rvaOffset(rva), rvaOffset(rva) + length)];
}
function expectBytesRva(rva, expected, label) {
  assert.deepEqual(bytesAtRva(rva, expected.length), expected, label);
}
const exportDirectoryRva = u32(optional + 96);
const exportDirectory = rvaOffset(exportDirectoryRva);
const exportFunctionCount = u32(exportDirectory + 20);
const exportNameCount = u32(exportDirectory + 24);
const exportFunctionsRva = u32(exportDirectory + 28);
const exportNamesRva = u32(exportDirectory + 32);
const exportOrdinalsRva = u32(exportDirectory + 36);
const exportNames = new Map();
function readCStringRva(rva) {
  const offset = rvaOffset(rva);
  let end = offset;
  while (end < dll.length && dll[end] !== 0) end++;
  return new TextDecoder('ascii').decode(dll.subarray(offset, end));
}
for (let index = 0; index < exportNameCount; index++) {
  const name = readCStringRva(readRva(exportNamesRva + index * 4));
  const ordinal = u16(rvaOffset(exportOrdinalsRva) + index * 2);
  assert.ok(ordinal < exportFunctionCount, `ConSys export ordinal ${name}`);
  exportNames.set(name, imageBase + readRva(exportFunctionsRva + ordinal * 4));
}
const moveVtable = exportNames.get('??_7DConEventMoveCamera@@6B@');
assert.equal(moveVtable, 0x10013b08, 'MoveCamera exported vtable');
assert.equal(readRva(moveVtable - imageBase + CONVERSATION_MOVE_CAMERA_BIND.vtableSlot),
  CONVERSATION_MOVE_CAMERA_BIND.nativeBody, 'MoveCamera BindActor vtable target');
expectBytesRva(CONVERSATION_MOVE_CAMERA_BIND.nativeBody - imageBase,
  CONVERSATION_MOVE_CAMERA_BIND.bodyBytes, 'MoveCamera BindActor body');
assert.equal(CONVERSATION_MOVE_CAMERA_BIND.argumentBytes, 0xc);
assert.notEqual(CONVERSATION_MOVE_CAMERA_BIND.nativeBody, CONVERSATION_BASE_BIND.nativeBody,
  'MoveCamera has a distinct vtable target');

// The exact binder is no-read/false, while the inherited helper continues to
// reject this distinct override. This keeps the generic event boundary narrow.
assert.equal(isConversationMoveCameraBindClass('ConSys.ConEventMoveCamera'), true);
assert.equal(isConversationBaseBindClass('ConSys.ConEventMoveCamera'), false);
assert.equal(bindConversationMoveCameraActor({classKey: 'ConSys.ConEventMoveCamera'}), false);
assert.equal(conversationMoveCameraBindNativeContract('ConSys.ConEventMoveCamera').nativeBody,
  CONVERSATION_MOVE_CAMERA_BIND.nativeBody);

// Resolve the authored Mission00 object graph and retain canonical identities.
const runtime = new ScriptRuntime(assets);
const conversation = await runtime.prepareObject(await runtime.objects.resolve(conText, 989));
assert.equal(conversation.index, 989);
assert.equal(conversation.name, 'Conversation0');
assert.equal(get(runtime, conversation, 'conName'), 'M00MeetPage');
const comment = get(runtime, conversation, 'eventList');
assert.equal(comment.index, 50101, 'M00MeetPage first event');
await runtime.prepareObject(comment);
const move = get(runtime, comment, 'nextEvent');
assert.equal(move.index, 50071, 'M00MeetPage MoveCamera export');
await runtime.prepareObject(move);
const speech = get(runtime, move, 'nextEvent');
assert.equal(speech.index, 50044, 'M00MeetPage Speech export after MoveCamera');
await runtime.prepareObject(speech);
assert.equal(get(runtime, move, 'eventType'), 6);
assert.equal(get(runtime, move, 'cameraPosition'), 2);
assert.equal(get(runtime, move, 'cameraTransition'), 255);
assert.equal(get(runtime, move, 'Conversation'), conversation);
const moveClassKey = runtime.instance(move).cls.record.key;
assert.equal(moveClassKey, 'consys.coneventmovecamera');
assert.equal(bindConversationMoveCameraActor({classKey: moveClassKey}), false);

// Execute the installed DataLinkPlay.PlayEvent.SetupEvent body directly at
// the canonical MoveCamera. Its unsupported-case local stays zero, and the
// original ProcessAction receives EA_NextEvent then advances to Speech.
const dataLinkClass = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('datalinkplay'));
const play = {name: 'Canonical Mission00 MoveCamera fixture'};
runtime.attach(play, dataLinkClass);
for (const [name, value] of [
  ['con', conversation],
  ['currentEvent', move],
  ['lastEvent', null],
  ['dataLink', null],
  ['bSilent', true],
  ['bEndTransmission', false],
  ['eventTimer', 0],
  ['lastSpeechTextLength', 0],
]) set(runtime, play, name, value);
const functionAt = name => runtime.prepareFunction(deusEx, deusEx.exportsByPath.get(name));
const setupEvent = await functionAt('datalinkplay.playevent.setupevent');
const processAction = await functionAt('datalinkplay.processaction');
await runtime.prepareState(deusEx, deusEx.exportsByPath.get('datalinkplay.playevent'));
assert.equal(runtime.gotoState(play, 'PlayEvent'), true);

const processEdges = [];
const processKey = processAction.key;
const observeProcessAction = call => {
  const values = Array.from({length: call.argumentCount}, (_, index) => call.evaluateArgument(index));
  processEdges.push({
    action: refValue(values[0]),
    label: refValue(values[1]),
  });
  runtime.boundaryFunctions.delete(processKey);
  try {
    return runtime.callFunction(processAction, call.receiver, call.argumentCount,
      index => values[index], call);
  } finally {
    runtime.boundaryFunctions.set(processKey, observeProcessAction);
  }
};
runtime.boundaryFunctions.set(processKey, observeProcessAction);
assert.equal(runtime.callFunction(setupEvent, play, 0), undefined);
assert.deepEqual(processEdges, [{action: 0, label: ''}],
  'MoveCamera no-op setup reaches ProcessAction(EA_NextEvent)');
assert.equal(get(runtime, play, 'lastEvent'), move,
  'ProcessAction records canonical MoveCamera as lastEvent');
assert.equal(get(runtime, play, 'currentEvent'), speech,
  'ProcessAction advances canonical MoveCamera to Speech');
assert.equal(runtime.instance(play).state.stateNode.record.key, 'deusex.datalinkplay.playevent');

console.log('ConEventMoveCamera passed: hash-pinned false-return binder, canonical Mission00 Conversation0/M00MeetPage export 50071 -> Speech export 50044, and original PlayEvent.SetupEvent -> ProcessAction(EA_NextEvent) lifecycle verified.');
