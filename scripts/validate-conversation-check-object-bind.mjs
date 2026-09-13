/** Validate ConEventCheckObject::BindActor against the installed ConSys image. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { AssetStore } from '../src/unreal/assets.mjs';
import { readClass } from '../src/unreal/classes.mjs';
import { readObject } from '../src/unreal/objects.mjs';
import { ScriptRuntime } from '../src/runtime/script-runtime.mjs';
import { refValue } from '../src/runtime/script-vm.mjs';
import {
  CONVERSATION_CHECK_OBJECT_BIND as contract,
  bindConversationCheckObjectActor,
} from '../src/runtime/script-conversation-check-object-bind.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const system = path.join(root, 'System');
const files = [];
for (const name of await readdir(system))
  files.push({ path: `System/${name}`, read: () => readFile(path.join(system, name)) });
const assets = new AssetStore(files);
const conSys = await assets.get('ConSys');
assert.equal(createHash('sha256').update(conSys.bytes).digest('hex'), contract.packageSha256,
  'ConSys.u hash');

const entry = conSys.pkg.exports[contract.classExport - 1];
assert.equal(entry?.path, 'ConEventCheckObject');
assert.equal(entry?.className, 'Class');
assert.equal(entry?.superIndex, 2);
assert.equal(entry?.flags, 0x040f0004);
const metadata = readClass(conSys, contract.classExport);
assert.equal(metadata.classFlags, 0x112);
assert.equal(metadata.scriptText, contract.scriptTextExport);
const sourceObject = readObject(conSys.pkg, conSys.bytes, metadata.scriptText);
sourceObject.reader.u32();
sourceObject.reader.u32();
const source = sourceObject.reader.string(conSys.pkg.version);
assert.match(source, /class\s+ConEventCheckObject\s+extends\s+ConEvent\s+native\s+noexport/i);
assert.match(source, /var\s+String\s+objectName\s*;/i);
assert.match(source, /var\s+Class<Inventory>\s+checkObject\s*;/i);
assert.match(source, /var\s+String\s+failLabel\s*;/i);

const dll = new Uint8Array(await readFile(path.join(system, 'ConSys.dll')));
assert.equal(createHash('sha256').update(dll).digest('hex'), contract.dllSha256,
  'ConSys.dll hash');
const u16 = offset => dll[offset] | (dll[offset + 1] << 8);
const u32 = offset => (dll[offset] | (dll[offset + 1] << 8) |
  (dll[offset + 2] << 16) | (dll[offset + 3] << 24)) >>> 0;
const pe = u32(0x3c);
assert.deepEqual([...dll.subarray(pe, pe + 4)], [0x50, 0x45, 0, 0]);
const coff = pe + 4;
const sectionCount = u16(coff + 2);
const optionalSize = u16(coff + 16);
const optional = coff + 20;
assert.equal(u16(optional), 0x10b, 'PE32 optional header');
const imageBase = u32(optional + 28);
assert.equal(imageBase, 0x10000000, 'ConSys image base');
const sections = [];
for (let index = 0; index < sectionCount; index++) {
  const section = optional + optionalSize + index * 40;
  sections.push({
    virtualAddress: u32(section + 12),
    rawOffset: u32(section + 20),
    rawSize: u32(section + 16),
  });
}
function rvaOffset(rva) {
  for (const section of sections) {
    if (rva >= section.virtualAddress && rva < section.virtualAddress + section.rawSize)
      return section.rawOffset + rva - section.virtualAddress;
  }
  throw new Error(`RVA is not backed by installed ConSys bytes: 0x${rva.toString(16)}`);
}
function bytesAt(address, length) {
  const offset = rvaOffset(address - imageBase);
  return dll.subarray(offset, offset + length);
}
function u32At(address) { return u32(rvaOffset(address - imageBase)); }
function asciiAtRva(rva, skip = 0) {
  let offset = rvaOffset(rva) + skip;
  let end = offset;
  while (dll[end] !== 0) end++;
  return new TextDecoder('ascii').decode(dll.subarray(offset, end));
}
function utf16At(address) {
  let offset = rvaOffset(address - imageBase);
  let value = '';
  for (let unit = u16(offset); unit !== 0; unit = u16(offset)) {
    value += String.fromCharCode(unit);
    offset += 2;
  }
  return value;
}
function expectBytes(address, expected, label) {
  assert.deepEqual([...bytesAt(address, expected.length)], expected, label);
}

// Exported vtable identity and slot target establish class-specific dispatch.
const exportDirectory = rvaOffset(u32(optional + 96));
const functionCount = u32(exportDirectory + 20);
const nameCount = u32(exportDirectory + 24);
const functionsRva = u32(exportDirectory + 28);
const namesRva = u32(exportDirectory + 32);
const ordinalsRva = u32(exportDirectory + 36);
const exportsByName = new Map();
for (let index = 0; index < nameCount; index++) {
  const name = asciiAtRva(u32(rvaOffset(namesRva + index * 4)));
  const ordinal = u16(rvaOffset(ordinalsRva) + index * 2);
  assert.ok(ordinal < functionCount);
  exportsByName.set(name, imageBase + u32(rvaOffset(functionsRva + ordinal * 4)));
}
assert.equal(exportsByName.get('??_7DConEventCheckObject@@6B@'), contract.vtable);
assert.equal(u32At(contract.vtable + contract.vtableSlot), contract.nativeBody);

// Parse the PE import address table so call operands are tied to Core symbols.
const importsByIat = new Map();
const importDirectoryRva = u32(optional + 104);
for (let descriptor = rvaOffset(importDirectoryRva);; descriptor += 20) {
  const originalThunk = u32(descriptor);
  const libraryNameRva = u32(descriptor + 12);
  const firstThunk = u32(descriptor + 16);
  if (originalThunk === 0 && libraryNameRva === 0 && firstThunk === 0) break;
  const library = asciiAtRva(libraryNameRva);
  const lookup = originalThunk || firstThunk;
  for (let index = 0;; index++) {
    const value = u32(rvaOffset(lookup + index * 4));
    if (value === 0) break;
    const name = (value & 0x80000000) !== 0 ? `#${value & 0xffff}` : asciiAtRva(value, 2);
    importsByIat.set(imageBase + firstThunk + index * 4, { library, name });
  }
}
const expectImport = (address, name) => assert.deepEqual(importsByIat.get(address),
  { library: 'Core.dll', name });
expectImport(0x100130dc, '?Left@FString@@QBE?AV1@H@Z');
expectImport(0x100130d0, '?appStricmp@@YAHPBG0@Z');
expectImport(0x10013000, '?CreatePackage@UObject@@SAPAVUPackage@@PAV1@PBG@Z');
expectImport(0x100130b4, '?PrivateStaticClass@UClass@@0V1@A');
expectImport(0x100130d4,
  '?StaticLoadObject@UObject@@SAPAV1@PAVUClass@@PAV1@PBG2KPAVUPackageMap@@@Z');

const body = bytesAt(contract.nativeBody, contract.nativeBodySize);
assert.equal(createHash('sha256').update(body).digest('hex'), contract.nativeBodySha256,
  'complete ConEventCheckObject::BindActor body');
expectBytes(0x10007c0d,
  [0x8d, 0x7b, 0x40, 0x8d, 0x44, 0x24, 0x0c, 0x6a, 0x03, 0x50, 0x8b, 0xcf,
    0xff, 0x15, 0xdc, 0x30, 0x01, 0x10], 'objectName+0x40 and FString::Left(...,3)');
expectBytes(0x10007c36,
  [0x68, 0x70, 0xd3, 0x01, 0x10, 0x50, 0xff, 0x15, 0xd0, 0x30, 0x01, 0x10],
  'NK_ appStricmp call');
expectBytes(0x10007cae, [0x89, 0x6b, 0x4c, 0xeb, 0x37], 'NK_ checkObject clear');
expectBytes(0x10007cb3,
  [0x68, 0x60, 0xd3, 0x01, 0x10, 0x55, 0xff, 0x15, 0x00, 0x30, 0x01, 0x10],
  'CreatePackage(NULL, DeusEx)');
expectBytes(0x10007cd2,
  [0x55, 0x6a, 0x02, 0x55, 0x57, 0x50, 0xa1, 0xb4, 0x30, 0x01, 0x10, 0x50,
    0xff, 0x15, 0xd4, 0x30, 0x01, 0x10], 'StaticLoadObject argument order');
expectBytes(0x10007ce7, [0x89, 0x43, 0x4c], 'loaded class store at checkObject+0x4c');
expectBytes(0x10007cf0,
  [0x32, 0xc0, 0x5b, 0x64, 0x89, 0x0d, 0x00, 0x00, 0x00, 0x00, 0x83, 0xc4,
    0x18, 0xc2, 0x0c, 0x00], 'false return and three-argument cleanup');
assert.equal(utf16At(0x1001d360), contract.packageName);
assert.equal(utf16At(0x1001d370), contract.prefix);

// Translation cases preserve branch, call order, arguments, write, and result.
const read = (object, field) => object[field];
const write = (object, field, value) => { object[field] = value; };
const nanoKey = { objectName: 'nk_TrainingDoor', checkObject: { key: 'seed' } };
assert.equal(bindConversationCheckObjectActor({ event: nanoKey, read, write }), false);
assert.equal(nanoKey.checkObject, null);
const event = { objectName: 'AugmentationCannister', checkObject: null };
const classRef = { key: 'core.class' };
const outer = { key: 'deusex' };
const loaded = { key: 'deusex.augmentationcannister' };
const calls = [];
assert.equal(bindConversationCheckObjectActor({
  event, read, write, classRef,
  createPackage(request) { calls.push(['CreatePackage', request]); return outer; },
  staticLoadObject(request) { calls.push(['StaticLoadObject', request]); return loaded; },
}), false);
assert.deepEqual(calls, [
  ['CreatePackage', { outer: null, name: 'DeusEx' }],
  ['StaticLoadObject', {
    classRef, outer, name: 'AugmentationCannister', filename: null, flags: 2, sandbox: null,
  }],
]);
assert.strictEqual(event.checkObject, loaded);

// The installed UnrealScript provides the later inventory predicate. Pin its
// source contract, then execute the package bytecode on an authored reference.
const [engine, deusEx, conText, extension] = await Promise.all([
  assets.get('Engine'), assets.get('DeusEx'), assets.get('DeusExConText'), assets.get('Extension'),
]);
const [conPlaySource, dataLinkSource, pawnSource] = await Promise.all([
  readFile(path.join(process.cwd(), '.cache/reference/ConPlayBase.uc'), 'utf8'),
  readFile(path.join(process.cwd(), '.cache/reference/DataLinkPlay.uc'), 'utf8'),
  readFile(path.join(process.cwd(), '.cache/reference/Pawn.uc'), 'utf8'),
]);
assert.match(conPlaySource,
  /function\s+EEventAction\s+SetupEventCheckObject[\s\S]*?event\.checkObject\s*==\s*None[\s\S]*?Left\(event\.objectName,\s*3\)\s*==\s*"NK_"[\s\S]*?player\.FindInventoryType\(event\.checkObject\)[\s\S]*?EA_NextEvent[\s\S]*?EA_JumpToLabel[\s\S]*?event\.failLabel/i);
assert.match(dataLinkSource,
  /case\s+ET_CheckObject:[\s\S]*?SetupEventCheckObject\(\s*ConEventCheckObject\(currentEvent\),\s*nextLabel\s*\)[\s\S]*?ProcessAction\(\s*nextAction,\s*nextLabel\s*\)/i);
assert.match(pawnSource,
  /function\s+Inventory\s+FindInventoryType\(\s*class\s+DesiredClass\s*\)[\s\S]*?for\s*\(\s*Inv\s*=\s*Inventory[\s\S]*?Inv\.class\s*==\s*DesiredClass[\s\S]*?return\s+Inv/i);

const runtime = new ScriptRuntime(assets);
const get = (object, field) => runtime.namedReference(object, field).get();
const set = (object, field, value) => runtime.namedReference(object, field).set(value);
const conversation = await runtime.prepareObject(await runtime.objects.resolve(conText, 5));
const authoredEvent = await runtime.prepareObject(await runtime.objects.resolve(conText, 2555));
assert.equal(get(conversation, 'conName'), 'MeetKaplan');
assert.equal(get(conversation, 'bDataLinkCon'), false,
  'MeetKaplan is an authored conversation reference, not a shipped DataLink route');
assert.equal(authoredEvent.name, 'ConEventCheckObject6');
assert.equal(get(authoredEvent, 'eventType'), 4);
assert.equal(get(authoredEvent, 'objectName'), 'WeaponRifle');
assert.equal(get(authoredEvent, 'failLabel'), 'NoRifle');
const nextEvent = await runtime.prepareObject(get(authoredEvent, 'nextEvent'));
assert.equal(nextEvent.index, 2556);

const weaponClass = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('weaponrifle'));
const uclassRef = { key: 'core.uclass.private-static-class' };
const deusExPackage = { key: 'deusex.package' };
const bindCalls = [];
assert.equal(bindConversationCheckObjectActor({
  event: authoredEvent, read: get, write: set, classRef: uclassRef,
  createPackage(request) { bindCalls.push(['CreatePackage', request]); return deusExPackage; },
  staticLoadObject(request) { bindCalls.push(['StaticLoadObject', request]); return weaponClass.record; },
}), false);
assert.deepEqual(bindCalls, [
  ['CreatePackage', { outer: null, name: 'DeusEx' }],
  ['StaticLoadObject', {
    classRef: uclassRef, outer: deusExPackage, name: 'WeaponRifle',
    filename: null, flags: 2, sandbox: null,
  }],
]);
assert.strictEqual(get(authoredEvent, 'checkObject'), weaponClass.record);

const playClass = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('datalinkplay'));
const playerClass = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('deusexplayer'));
const play = { name: 'MeetKaplan CheckObject play' };
const player = { name: 'MeetKaplan player' };
const rifle = { name: 'MeetKaplan rifle' };
runtime.attach(play, playClass);
runtime.attach(player, playerClass);
runtime.attach(rifle, weaponClass);
runtime.bindProperty(rifle, runtime.lookupMember(weaponClass, 'fields', 'Class'), {
  get: () => weaponClass.record,
  set: () => { throw new Error('Changing Inventory.Class is outside this reference case'); },
});
set(rifle, 'Inventory', null);
set(player, 'Inventory', rifle);
for (const [field, value] of [
  ['player', player], ['con', conversation], ['currentEvent', authoredEvent], ['lastEvent', null],
]) set(play, field, value);

const prepare = (asset, key) => runtime.prepareFunction(asset, asset.exportsByPath.get(key));
const setupEvent = await prepare(deusEx, 'datalinkplay.playevent.setupevent');
const processAction = await prepare(deusEx, 'datalinkplay.processaction');
await prepare(deusEx, 'conplaybase.setupeventcheckobject');
await prepare(engine, 'pawn.findinventorytype');
await prepare(conSys, 'conversation.geteventfromlabel');
await runtime.prepareState(deusEx, deusEx.exportsByPath.get('datalinkplay.playevent'));
assert.equal(runtime.gotoState(play, 'PlayEvent'), true);

async function prepareThroughLabel(conversationObject, label) {
  const seen = new Set();
  for (let current = get(conversationObject, 'eventList'); current;) {
    if (seen.has(current)) throw new Error(`Authored conversation has a cycle before ${label}`);
    seen.add(current);
    await runtime.prepareObject(current);
    if (get(current, 'Label').toLowerCase() === label.toLowerCase()) return current;
    current = get(current, 'nextEvent');
  }
  throw new Error(`Authored conversation label is absent: ${label}`);
}

const actionEdges = [];
const processKey = processAction.key;
let applyAction = true;
const observeProcessAction = call => {
  const values = Array.from({ length: call.argumentCount }, (_, index) =>
    refValue(call.evaluateArgument(index)));
  actionEdges.push({ action: values[0], label: values[1] });
  if (!applyAction) return undefined;
  runtime.boundaryFunctions.delete(processKey);
  try {
    return runtime.callFunction(processAction, call.receiver, call.argumentCount,
      index => values[index], call);
  } finally {
    runtime.boundaryFunctions.set(processKey, observeProcessAction);
  }
};
runtime.boundaryFunctions.set(processKey, observeProcessAction);

// Inventory present: installed SetupEvent -> SetupEventCheckObject ->
// Pawn.FindInventoryType returns the canonical rifle and ProcessAction applies
// EA_NextEvent to the authored link.
assert.equal(runtime.callFunction(setupEvent, play, 0), undefined);
assert.deepEqual(actionEdges, [{ action: 0, label: '' }]);
assert.strictEqual(get(play, 'lastEvent'), authoredEvent);
assert.strictEqual(get(play, 'currentEvent'), nextEvent);

// Inventory absent: prepare the authored prefix through NoRifle, then let the
// same installed setup and ProcessAction bodies apply GetEventFromLabel.
const noRifle = await prepareThroughLabel(conversation, 'NoRifle');
assert.equal(noRifle.index, 2559);
set(player, 'Inventory', null);
set(play, 'currentEvent', authoredEvent);
set(play, 'lastEvent', null);
applyAction = true;
assert.equal(runtime.callFunction(setupEvent, play, 0), undefined);
assert.deepEqual(actionEdges.at(-1), { action: 1, label: 'NoRifle' });
assert.strictEqual(get(play, 'currentEvent'), noRifle);
assert.strictEqual(get(play, 'lastEvent'), authoredEvent);

// Authored NanoKey reference: native BindActor clears checkObject, then the
// installed SetupEvent uses Right/StringToName and NanoKeyRing.HasKey.
const nanoConversation = await runtime.prepareObject(await runtime.objects.resolve(conText, 15));
const nanoEvent = await runtime.prepareObject(await runtime.objects.resolve(conText, 21066));
assert.equal(get(nanoConversation, 'conName'), 'ChadThankful');
assert.equal(get(nanoConversation, 'bDataLinkCon'), false,
  'ChadThankful is an authored conversation reference, not a shipped DataLink route');
assert.equal(nanoEvent.name, 'ConEventCheckObject35');
assert.equal(get(nanoEvent, 'objectName'), 'NK_Catacombs_Blastdoor02');
assert.equal(get(nanoEvent, 'failLabel'), 'NeedKey');
assert.equal(bindConversationCheckObjectActor({ event: nanoEvent, read: get, write: set }), false);
assert.strictEqual(get(nanoEvent, 'checkObject'), null);
const needKey = await prepareThroughLabel(nanoConversation, 'NeedKey');
assert.equal(needKey.index, 21101);
const nanoNextEvent = get(nanoEvent, 'nextEvent');
assert.equal(nanoNextEvent.index, 21067);

const nanoClass = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('nanokeyring'));
const keyInfoClass = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('nanokeyinfo'));
const rootClass = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('deusexrootwindow'));
const rootWindow = { name: 'ChadThankful root window' };
const keyRing = { name: 'ChadThankful key ring' };
const keyInfo = { name: 'Catacombs key' };
runtime.attach(rootWindow, rootClass);
runtime.attach(keyRing, nanoClass);
runtime.attach(keyInfo, keyInfoClass);
set(player, 'rootWindow', rootWindow);
set(player, 'KeyRing', keyRing);
set(player, 'KeyList', keyInfo);
set(keyRing, 'Owner', player);
set(keyInfo, 'KeyID', 'Catacombs_Blastdoor02');
set(keyInfo, 'NextKey', null);
runtime.nameServices = { internName: text => text };
await prepare(extension, 'extensionobject.stringtoname');
await prepare(deusEx, 'nanokeyring.haskey');
await prepare(deusEx, 'nanokeyring.getplayer');
set(play, 'con', nanoConversation);
set(play, 'currentEvent', nanoEvent);
set(play, 'lastEvent', null);
applyAction = true;
assert.equal(runtime.callFunction(setupEvent, play, 0), undefined);
assert.deepEqual(actionEdges.at(-1), { action: 0, label: '' });
assert.strictEqual(get(play, 'currentEvent'), nanoNextEvent);
assert.strictEqual(get(play, 'lastEvent'), nanoEvent);

set(player, 'KeyList', null);
set(play, 'currentEvent', nanoEvent);
set(play, 'lastEvent', null);
assert.equal(runtime.callFunction(setupEvent, play, 0), undefined);
assert.deepEqual(actionEdges.at(-1), { action: 1, label: 'NeedKey' });
assert.strictEqual(get(play, 'currentEvent'), needKey);
assert.strictEqual(get(play, 'lastEvent'), nanoEvent);

console.log('Original ConEventCheckObject passed package/DLL hashes, class/vtable/body/import ' +
  'checks, authored MeetKaplan Inventory and ChadThankful NanoKey setup branches, and the ' +
  'installed ProcessAction/GetEventFromLabel next/fail edges.');
