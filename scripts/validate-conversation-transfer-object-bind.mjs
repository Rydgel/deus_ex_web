/** Validate ConEventTransferObject::BindActor and a shipped DataLink binding route. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { AssetStore } from '../src/unreal/assets.mjs';
import { readClass } from '../src/unreal/classes.mjs';
import { readObject, exportAt } from '../src/unreal/objects.mjs';
import { readFieldLinks, readPropertyMetadata } from '../src/unreal/script-metadata.mjs';
import { ScriptRuntime } from '../src/runtime/script-runtime.mjs';
import {
  CONVERSATION_TRANSFER_OBJECT_BIND as contract,
  bindConversationTransferObjectActor,
} from '../src/runtime/script-conversation-transfer-object-bind.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const system = path.join(root, 'System');
const files = [];
for (const name of await readdir(system))
  files.push({ path: `System/${name}`, read: () => readFile(path.join(system, name)) });
const assets = new AssetStore(files);
const [conSys, deusEx, conText] = await Promise.all([
  assets.get('ConSys'), assets.get('DeusEx'), assets.get('DeusExConText'),
]);

assert.equal(createHash('sha256').update(conSys.bytes).digest('hex'), contract.packageSha256);
const entry = exportAt(conSys.pkg, contract.classExport);
assert.equal(entry.path, 'ConEventTransferObject');
assert.equal(entry.className, 'Class');
assert.equal(entry.superIndex, 2);
assert.equal(entry.flags, 0x040f0004);
const metadata = readClass(conSys, contract.classExport);
assert.equal(metadata.classFlags, 0x112);
assert.equal(metadata.scriptText, contract.scriptTextExport);
const sourceObject = readObject(conSys.pkg, conSys.bytes, metadata.scriptText);
sourceObject.reader.u32();
sourceObject.reader.u32();
const source = sourceObject.reader.string(conSys.pkg.version);
assert.match(source, /class\s+ConEventTransferObject\s+extends\s+ConEvent\s+native\s+noexport/i);
for (const declaration of [
  /var\s+String\s+objectName\s*;/i,
  /var\s+Class<Inventory>\s+giveObject\s*;/i,
  /var\s+int\s+transferCount\s*;/i,
  /var\s+Actor\s+fromActor\s*;/i,
  /var\s+String\s+fromName\s*;/i,
  /var\s+Actor\s+toActor\s*;/i,
  /var\s+String\s+toName\s*;/i,
  /var\s+String\s+failLabel\s*;/i,
]) assert.match(source, declaration);

const properties = [];
for (let index = metadata.children; index; index = readFieldLinks(conSys, index).nextRef) {
  const propertyEntry = exportAt(conSys.pkg, index);
  if (!propertyEntry.className.endsWith('Property')) continue;
  const property = readPropertyMetadata(conSys, index);
  properties.push([index, propertyEntry.name, propertyEntry.className, property.arrayDim]);
}
assert.deepEqual(properties, [
  [219, 'ObjectName', 'StrProperty', 1],
  [220, 'giveObject', 'ClassProperty', 1],
  [221, 'transferCount', 'IntProperty', 1],
  [222, 'fromActor', 'ObjectProperty', 1],
  [223, 'fromName', 'StrProperty', 1],
  [224, 'toActor', 'ObjectProperty', 1],
  [225, 'toName', 'StrProperty', 1],
  [226, 'failLabel', 'StrProperty', 1],
]);

const dll = new Uint8Array(await readFile(path.join(system, 'ConSys.dll')));
assert.equal(createHash('sha256').update(dll).digest('hex'), contract.dllSha256);
const u16 = offset => dll[offset] | (dll[offset + 1] << 8);
const u32 = offset => (dll[offset] | (dll[offset + 1] << 8) |
  (dll[offset + 2] << 16) | (dll[offset + 3] << 24)) >>> 0;
const pe = u32(0x3c), coff = pe + 4, optional = coff + 20;
assert.deepEqual([...dll.subarray(pe, pe + 4)], [0x50, 0x45, 0, 0]);
assert.equal(u16(optional), 0x10b);
const imageBase = u32(optional + 28);
assert.equal(imageBase, 0x10000000);
const sections = [];
const optionalSize = u16(coff + 16);
for (let index = 0; index < u16(coff + 2); index++) {
  const section = optional + optionalSize + index * 40;
  sections.push({ virtualAddress: u32(section + 12), rawSize: u32(section + 16),
    rawOffset: u32(section + 20) });
}
function rvaOffset(rva) {
  for (const section of sections)
    if (rva >= section.virtualAddress && rva < section.virtualAddress + section.rawSize)
      return section.rawOffset + rva - section.virtualAddress;
  throw new Error(`Unbacked ConSys RVA 0x${rva.toString(16)}`);
}
const bytesAt = (address, length) => dll.subarray(rvaOffset(address - imageBase),
  rvaOffset(address - imageBase) + length);
const u32At = address => u32(rvaOffset(address - imageBase));
function asciiAtRva(rva, skip = 0) {
  let offset = rvaOffset(rva) + skip, end = offset;
  while (dll[end] !== 0) end++;
  return new TextDecoder('ascii').decode(dll.subarray(offset, end));
}
function utf16At(address) {
  let offset = rvaOffset(address - imageBase), value = '';
  while (u16(offset) !== 0) { value += String.fromCharCode(u16(offset)); offset += 2; }
  return value;
}
const expectBytes = (address, expected, label) =>
  assert.deepEqual([...bytesAt(address, expected.length)], expected, label);

const exportDirectory = rvaOffset(u32(optional + 96));
const functionCount = u32(exportDirectory + 20), nameCount = u32(exportDirectory + 24);
const functionsRva = u32(exportDirectory + 28), namesRva = u32(exportDirectory + 32);
const ordinalsRva = u32(exportDirectory + 36), exportsByName = new Map();
for (let index = 0; index < nameCount; index++) {
  const name = asciiAtRva(u32(rvaOffset(namesRva + index * 4)));
  const ordinal = u16(rvaOffset(ordinalsRva) + index * 2);
  assert.ok(ordinal < functionCount);
  exportsByName.set(name, imageBase + u32(rvaOffset(functionsRva + ordinal * 4)));
}
assert.equal(exportsByName.get('??_7DConEventTransferObject@@6B@'), contract.vtable);
assert.equal(u32At(contract.vtable + contract.vtableSlot), contract.nativeBody);

const importsByIat = new Map();
for (let descriptor = rvaOffset(u32(optional + 104));; descriptor += 20) {
  const originalThunk = u32(descriptor), libraryNameRva = u32(descriptor + 12);
  const firstThunk = u32(descriptor + 16);
  if (originalThunk === 0 && libraryNameRva === 0 && firstThunk === 0) break;
  const library = asciiAtRva(libraryNameRva), lookup = originalThunk || firstThunk;
  for (let index = 0;; index++) {
    const value = u32(rvaOffset(lookup + index * 4));
    if (value === 0) break;
    const name = (value & 0x80000000) !== 0 ? `#${value & 0xffff}` : asciiAtRva(value, 2);
    importsByIat.set(imageBase + firstThunk + index * 4, { library, name });
  }
}
const expectImport = (address, name) => assert.deepEqual(importsByIat.get(address),
  { library: 'Core.dll', name });
expectImport(0x10013000, '?CreatePackage@UObject@@SAPAVUPackage@@PAV1@PBG@Z');
expectImport(0x100130d0, '?appStricmp@@YAHPBG0@Z');
expectImport(0x100130b4, '?PrivateStaticClass@UClass@@0V1@A');
expectImport(0x100130d4,
  '?StaticLoadObject@UObject@@SAPAV1@PAVUClass@@PAV1@PBG2KPAVUPackageMap@@@Z');

const body = bytesAt(contract.nativeBody, contract.nativeBodySize);
assert.equal(createHash('sha256').update(body).digest('hex'), contract.nativeBodySha256);
expectBytes(0x1000bc47,
  [0x68,0x60,0xd3,0x01,0x10,0x8b,0xf1,0x6a,0x00,0xc6,0x44,0x24,0x1b,0x00,
    0xff,0x15,0x00,0x30,0x01,0x10], 'CreatePackage precedes actor comparison');
expectBytes(0x1000bc63,
  [0x8b,0x46,0x5c,0x83,0xc4,0x08,0x85,0xc0,0x74,0x05,0x8b,0x4e,0x58],
  'fromName +0x58/+0x5c');
expectBytes(0x1000bca3,
  [0x8b,0x43,0x50,0x83,0xe0,0x04,0x3c,0x04,0x74,0x33],
  'from bark match bFirstPerson mask');
expectBytes(0x1000bce0, [0x89,0x7e,0x54,0xc6,0x44,0x24,0x13,0x01],
  'fromActor write and bound result');
expectBytes(0x1000bce8,
  [0x8b,0x46,0x6c,0x85,0xc0,0x74,0x05,0x8b,0x4e,0x68],
  'toName +0x68/+0x6c');
expectBytes(0x1000bd59, [0x89,0x7e,0x64,0xb3,0x01], 'toActor write and true result');
expectBytes(0x1000bd64,
  [0x8b,0x46,0x44,0x85,0xc0,0x74,0x05,0x8b,0x46,0x40,0xeb,0x05,
    0xb8,0xcc,0xe1,0x01,0x10], 'ObjectName +0x40/+0x44 after comparisons');
expectBytes(0x1000bd79,
  [0x6a,0x00,0x6a,0x02,0x6a,0x00,0x50,0xa1,0xb4,0x30,0x01,0x10,0x52,0x50,
    0xff,0x15,0xd4,0x30,0x01,0x10], 'StaticLoadObject argument order');
expectBytes(0x1000bd90,
  [0x89,0x46,0x4c,0x8a,0xc3,0x5f,0x5e,0x5d,0x5b,0x83,0xc4,0x08,0xc2,0x0c,0x00],
  'giveObject store, bool result and cleanup');
expectBytes(contract.clearBody,
  [0x33,0xc0,0x89,0x41,0x54,0x89,0x41,0x64,0x89,0x41,0x4c,0xc3],
  'ClearBindActors clears fromActor, toActor and giveObject');
assert.equal(utf16At(0x1001d360), contract.packageName);

// Pin every shipped DataLink TransferObject reference in this package. These
// are all DataVaultImage deliveries to JCDenton and have no fail label.
const authored = [];
for (let eventExport = 1; eventExport <= conText.pkg.exports.length; eventExport++) {
  if (exportAt(conText.pkg, eventExport).className !== 'ConEventTransferObject') continue;
  const event = readObject(conText.pkg, conText.bytes, eventExport).values;
  if (!Number.isInteger(event.Conversation) || event.Conversation <= 0) continue;
  const conversation = readObject(conText.pkg, conText.bytes, event.Conversation).values;
  if (!conversation.bDataLinkCon) continue;
  authored.push({ eventExport, conversationExport: event.Conversation,
    conName: conversation.conName, ...event });
}
authored.sort((left, right) => left.eventExport - right.eventExport);
assert.equal(authored.length, 10);
assert.deepEqual(authored.map(item => item.conName).sort(), [
  'DL_Alleys', 'DL_Choice', 'DL_Downloaded', 'DL_Final_Morgan', 'DL_LebedevKill',
  'DL_Rooftops', 'DL_cathedralfirst', 'DL_intro_cathedral', 'DL_no_carla', 'DL_tong1',
].sort());
for (const event of authored) {
  assert.match(event.ObjectName, /^Image/);
  assert.equal(event.toName, 'JCDenton');
  assert.equal(event.transferCount, 1);
  assert.equal(event.failLabel, undefined);
}

// Route DL_Rooftops through the installed Conversation.BindActorEvents host
// bridge and ScriptRuntime's exact class dispatch. In an InfoLink the remote
// Alex actor need not be present; binding JCDenton therefore sets only toActor.
const runtimeCalls = [];
let imageClass;
const runtime = new ScriptRuntime(assets, { conversationLifecycle: {
  transferObject: {
    classRef: { key: 'core.uclass.private-static-class' },
    createPackage(request) {
      runtimeCalls.push(['CreatePackage', request]);
      return { key: 'deusex.package' };
    },
    staticLoadObject(request) {
      runtimeCalls.push(['StaticLoadObject', request]);
      return imageClass.record;
    },
  },
} });
const get = (object, field) => runtime.namedReference(object, field).get();
const set = (object, field, value) => runtime.namedReference(object, field).set(value);
const conversation = await runtime.prepareObject(await runtime.objects.resolve(conText, 1430));
const event = await runtime.prepareObject(await runtime.objects.resolve(conText, 7448));
imageClass = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('image02_nyc_warehouse'));
const playerClass = await runtime.loadClass(deusEx, deusEx.exportsByPath.get('deusexplayer'));
const player = { name: 'DL_Rooftops JCDenton' };
runtime.attach(player, playerClass);
set(player, 'BindName', 'JCDenton');
set(player, 'BarkBindName', '');
assert.equal(get(conversation, 'conName'), 'DL_Rooftops');
assert.equal(get(conversation, 'bDataLinkCon'), true);
assert.equal(get(event, 'ObjectName'), 'Image02_NYC_Warehouse');
assert.equal(get(event, 'fromName'), 'AlexJacobson');
assert.equal(get(event, 'toName'), 'JCDenton');
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
assert.equal(get(event, 'fromActor'), null);
assert.strictEqual(get(event, 'toActor'), player);
assert.strictEqual(get(event, 'giveObject'), imageClass.record);
assert.deepEqual(runtimeCalls.map(call => call[0]), ['CreatePackage', 'StaticLoadObject']);
set(event, 'nextEvent', originalNext);
set(conversation, 'eventList', originalHead);

// Directly pin the bool result that BindActorEvents intentionally discards.
const directEvent = {
  ObjectName: 'Image02_NYC_Warehouse', giveObject: null,
  fromName: 'AlexJacobson', fromActor: null, toName: 'JCDenton', toActor: null,
};
const directPlayer = { BindName: 'JCDenton', BarkBindName: '' };
assert.equal(bindConversationTransferObjectActor({
  event: directEvent, firstActor: directPlayer, secondActor: directPlayer,
  conversation: { bFirstPerson: false },
  read: (object, field) => object[field],
  write: (object, field, value) => { object[field] = value; },
  classRef: { key: 'core.class' },
  createPackage: () => ({ key: 'deusex' }),
  staticLoadObject: () => imageClass.record,
}), true);
assert.equal(directEvent.fromActor, null);
assert.strictEqual(directEvent.toActor, directPlayer);

console.log('Original ConEventTransferObject passed package/DLL hashes, class/property/vtable/body/import ' +
  'checks, all 10 shipped DataLink references, and the installed DL_Rooftops JCDenton bind route.');
