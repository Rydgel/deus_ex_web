/**
 * Focused original-DLL and canonical-object validator for
 * DConversationList::BindConversations / PurgeBoundConversations.
 *
 * The installed package supplies the native/noexport class and mission-list
 * records.  The host fixture below supplies only the services absent from the
 * package loader: canonical field access for a live Actor, ConListItem
 * StaticAllocateObject/constructor, and the deleting destructor.  No
 * UnrealScript body is copied into this validator.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readClass } from '../src/unreal/classes.mjs';
import { readObject } from '../src/unreal/objects.mjs';
import { ScriptRuntime } from '../src/runtime/script-runtime.mjs';
import {
  CONVERSATION_LIST_FIELDS,
  CONVERSATION_LIST_NATIVE_ADDRESSES,
  CONVERSATION_LIST_NATIVE_CONTRACT,
  CONVERSATION_LIST_NATIVE_FLAGS,
  ConversationListNativeBoundaryError,
  asciiCaseEqual,
  bindConversationsNative,
  caseSensitiveContains,
  conversationListNativeContract,
  purgeBoundConversationsNative,
} from '../src/runtime/script-native-conversation-list.mjs';
import { conSysNativeConstruction } from '../src/runtime/script-conversation-construction.mjs';
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
  return { index, entry: asset.pkg.exports[index - 1], metadata, source: reader.string(asset.pkg.version) };
}

function bytesAt(bytes, offset, length) {
  return [...bytes.subarray(offset, offset + length)];
}

function expectBytes(bytes, offset, expected, label) {
  assert.deepEqual(bytesAt(bytes, offset, expected.length), expected, label);
}

const listClass = sourceFor(conSys, 'conversationlist');
const conItemClass = sourceFor(conSys, 'conitem');
const listItemClass = sourceFor(conSys, 'conlistitem');
assert.equal(listClass.index, 393);
assert.equal(conItemClass.index, 87);
assert.equal(listItemClass.index, 83);
for (const record of [listClass, conItemClass, listItemClass]) {
  assert.equal(record.entry.flags, 0x040f0004, `${record.entry.name} export flags`);
  assert.equal(record.entry.superIndex, 6, `${record.entry.name} superclass`);
  assert.equal(record.metadata.classFlags, 0x112, `${record.entry.name} class flags`);
  assert.match(record.source, /class\s+\w+\s+extends\s+ConObject\s+native\s+noexport\s*;/i);
}
assert.match(listClass.source, /var\s+ConItem\s+conversations\s*;/i);
assert.match(conItemClass.source, /var\s+ConObject\s+conObject\s*;/i);
assert.match(conItemClass.source, /var\s+ConItem\s+next\s*;/i);
assert.match(listItemClass.source, /var\s+Conversation\s+con\s*;/i);
assert.match(listItemClass.source, /var\s+ConListItem\s+next\s*;/i);

const dll = new Uint8Array(await readFile(path.join(root, 'System', 'ConSys.dll')));
assert.equal(createHash('sha256').update(dll).digest('hex'),
  'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa',
  'installed ConSys.dll hash');

// Bind prologue, `_Bark` GNames/appStrstr lookup, full gate transition, and
// the constructor/link sequence are pinned to the recovered image bytes.
expectBytes(dll, 0x10b70, [
  0x51, 0x53, 0x55, 0x8b, 0x69, 0x28, 0x56, 0x57,
  0x8b, 0x7c, 0x24, 0x18, 0x57, 0x89, 0x4c, 0x24, 0x14,
  0xe8, 0x6a, 0x01, 0x00, 0x00, 0x85, 0xed, 0x0f, 0x84,
], 'BindConversations save/purge prologue');
expectBytes(dll, 0x10b91, [
  0x8b, 0x0d, 0x24, 0x31, 0x01, 0x10, 0x68, 0x30, 0xdc, 0x01, 0x10,
  0x8b, 0x46, 0x28, 0x8b, 0x11, 0x8b, 0x04, 0x82, 0x83, 0xc0, 0x0c,
  0x50, 0xff, 0x15, 0x48, 0x31, 0x01, 0x10, 0x83, 0xc4, 0x08,
], 'BindConversations GNames/appStrstr `_Bark` gate');
expectBytes(dll, 0x10bb3, [
  0x8b, 0x46, 0x48, 0x0f, 0x95, 0xc3, 0x85, 0xc0, 0x74, 0x05,
], 'BindConversations bark bool and owner read');
expectBytes(dll, 0x10c30, [
  0x8b, 0x87, 0xbc, 0x02, 0x00, 0x00, 0x85, 0xc0, 0x74, 0x08,
  0x8b, 0x87, 0xb8, 0x02, 0x00, 0x00, 0xeb, 0x05,
], 'BindConversations first normal BarkBindName read');
expectBytes(dll, 0x10c88, [
  0x8b, 0x4e, 0x74, 0x6a, 0x00, 0x41, 0x51, 0x89, 0x4e, 0x74,
  0x8b, 0xcc, 0x6a, 0x00, 0xff, 0x15, 0xe0, 0x30, 0x01, 0x10,
  0x8b, 0x4c, 0x24, 0x18, 0xff, 0x15, 0x44, 0x31, 0x01, 0x10,
  0x50, 0x6a, 0x30, 0xe8, 0x12, 0x21, 0xff, 0xff, 0x83, 0xc4, 0x10,
], 'BindConversations count/NAME_None/Outer/allocation');
expectBytes(dll, 0x10cc0, [
  0x8b, 0x48, 0x1c, 0x89, 0x70, 0x28, 0x83, 0xc9, 0x04,
  0x89, 0x48, 0x1c, 0x8b, 0x8f, 0xdc, 0x02, 0x00, 0x00,
  0x89, 0x48, 0x2c, 0x89, 0x87, 0xdc, 0x02, 0x00, 0x00,
], 'BindConversations ConListItem flags and prepend writes');
expectBytes(dll, 0x10cf0, [
  0x53, 0x8b, 0x5c, 0x24, 0x08, 0x8b, 0x8b, 0xdc, 0x02, 0x00, 0x00,
  0x85, 0xc9, 0x74, 0x2a, 0x56, 0x8b, 0x41, 0x28, 0x8b, 0x50, 0x74,
  0x4a, 0x89, 0x50, 0x74, 0x8b, 0x71, 0x2c, 0x85, 0xc9, 0x74, 0x07,
  0x8b, 0x01, 0x6a, 0x01, 0xff, 0x50, 0x0c, 0x85, 0xf6, 0x8b, 0xce,
  0x75, 0xe2, 0x89, 0xb3, 0xdc, 0x02, 0x00, 0x00, 0x5e, 0x5b, 0xc2, 0x04, 0x00,
], 'PurgeBoundConversations decrement/destructor/clear');

assert.deepEqual(CONVERSATION_LIST_NATIVE_ADDRESSES, {
  BindConversations: 0x10010b70,
  PurgeBoundConversations: 0x10010cf0,
});
assert.equal(conversationListNativeContract(0x10010b70),
  CONVERSATION_LIST_NATIVE_CONTRACT.BindConversations);
assert.equal(conversationListNativeContract(0x10010cf0),
  CONVERSATION_LIST_NATIVE_CONTRACT.PurgeBoundConversations);
assert.throws(() => conversationListNativeContract(0x10000000), RangeError);

const conListItemConstruction = conSysNativeConstruction('ConListItem');
assert.equal(conListItemConstruction.instanceSize, 0x30);
assert.equal(conListItemConstruction.operatorNew, 0x10002dc0);
assert.equal(conListItemConstruction.constructor, 0x1000ecc0);
assert.equal(conListItemConstruction.vtable, 0x1001346c);
assert.deepEqual(conListItemConstruction.fields, { con: 0x28, next: 0x2c });
assert.deepEqual(CONVERSATION_LIST_NATIVE_FLAGS, {
  objectFlagsAfterBindOr: 0x4,
  deletingDestructorFlags: 0x1,
});

// Confirm the installed Mission00 object uses the exact canonical field names
// consumed by the service before exercising a synthetic live Actor chain.
const missionListIndex = conText.pkg.exports.findIndex(e =>
  e.name === 'ConList_Mission00' && e.className === 'ConversationList') + 1;
assert.ok(missionListIndex > 0, 'Mission00 ConversationList export');
const missionListRaw = readObject(conText.pkg, conText.bytes, missionListIndex).values;
assert.ok(Number.isInteger(missionListRaw.conversations) && missionListRaw.conversations > 0,
  'Mission00 conversations head');
const missionItemIndex = missionListRaw.conversations;
const missionItemEntry = conText.pkg.exports[missionItemIndex - 1];
assert.equal(missionItemEntry.className, 'ConItem');
const missionItemRaw = readObject(conText.pkg, conText.bytes, missionItemIndex).values;
assert.ok(Number.isInteger(missionItemRaw.ConObject) && missionItemRaw.ConObject > 0,
  'Mission00 ConObject reference');

// ScriptRuntime prepares the canonical Conversation and ConversationList
// identities.  Native object construction and Actor storage remain explicit
// fixture services because loaded native payload/lifecycle is a separate
// boundary.
const runtime = new ScriptRuntime(assets);
const canonicalList = await runtime.objects.resolve(conText, missionListIndex);
assert.equal(await runtime.prepareObject(canonicalList), canonicalList);
const canonicalOuter = runtime.namedReference(canonicalList, CONVERSATION_LIST_FIELDS.outer).get();
const conversationIndex = conText.exportsByPath.get('conversation57');
const normalConversation = await runtime.objects.resolve(conText, conversationIndex);
assert.equal(await runtime.prepareObject(normalConversation), normalConversation);
const barkConversationIndex = conText.exportsByPath.get('conversation1');
const barkConversation = await runtime.objects.resolve(conText, barkConversationIndex);
assert.equal(await runtime.prepareObject(barkConversation), barkConversation);
const rejectedBarkIndex = conText.exportsByPath.get('conversation2');
const rejectedBarkConversation = await runtime.objects.resolve(conText, rejectedBarkIndex);
assert.equal(await runtime.prepareObject(rejectedBarkConversation), rejectedBarkConversation);
const otherConversationIndex = conText.exportsByPath.get('conversation3');
const otherConversation = await runtime.objects.resolve(conText, otherConversationIndex);
assert.equal(await runtime.prepareObject(otherConversation), otherConversation);

// Controlled values select one normal, one bark, and one normal-owner bark
// rejection while retaining canonical loaded Conversation identities.
runtime.namedReference(normalConversation, 'conName').set('NormalLine');
runtime.namedReference(normalConversation, 'conOwnerName').set('JCDenton');
runtime.namedReference(normalConversation, 'ownerRefCount').set(1);
runtime.namedReference(barkConversation, 'conName').set('Jaime_Bark');
runtime.namedReference(barkConversation, 'conOwnerName').set('BarkGuy');
runtime.namedReference(barkConversation, 'ownerRefCount').set(0);
runtime.namedReference(rejectedBarkConversation, 'conName').set('Normal_Bark');
runtime.namedReference(rejectedBarkConversation, 'conOwnerName').set('JCDenton');
runtime.namedReference(rejectedBarkConversation, 'ownerRefCount').set(0);
runtime.namedReference(otherConversation, 'conName').set('OtherLine');
runtime.namedReference(otherConversation, 'conOwnerName').set('OtherActor');
runtime.namedReference(otherConversation, 'ownerRefCount').set(0);

const source0 = { kind: 'ConItem', name: 'source0' };
const source1 = { kind: 'ConItem', name: 'source1' };
const source2 = { kind: 'ConItem', name: 'source2' };
const source3 = { kind: 'ConItem', name: 'source3' };
const oldItem = { kind: 'ConListItem', name: 'oldItem' };
const list = { kind: 'ConversationList', name: 'hostList' };
const actor = { kind: 'Actor', name: 'hostActor' };
const hostFields = new Map([
  [source0, { ConObject: normalConversation, Next: source1 }],
  [source1, { ConObject: barkConversation, Next: source2 }],
  [source2, { ConObject: rejectedBarkConversation, Next: source3 }],
  [source3, { ConObject: otherConversation, Next: null }],
  [oldItem, { con: normalConversation, next: null, ObjectFlags: 0x20 }],
  [list, { conversations: source0, Outer: canonicalOuter }],
  [actor, { BindName: 'JCDenton', BarkBindName: 'BarkGuy', ConListItems: oldItem }],
]);
const trace = [];
const read = (object, field) => {
  trace.push(['read', object, field]);
  const fields = hostFields.get(object);
  if (fields) return fields[field];
  return runtime.namedReference(object, field).get();
};
const write = (object, field, value) => {
  trace.push(['write', object, field, value]);
  const fields = hostFields.get(object);
  if (fields) fields[field] = value;
  else runtime.namedReference(object, field).set(value);
};
const reference = value => value;
const allocated = [];
const deleted = [];
const allocate = details => {
  trace.push(['allocate', details]);
  assert.equal(details.classRecord, conListItemConstruction);
  assert.equal(details.className, 'ConListItem');
  assert.equal(details.classPackage, 'ConSys');
  assert.equal(details.size, 0x30);
  assert.equal(details.outer, canonicalOuter);
  assert.equal(details.name, 'None');
  assert.equal(details.flags, 0);
  assert.equal(details.operatorNew, 0x10002dc0);
  allocated.push({ kind: 'ConListItem', name: `bound${allocated.length}` });
  hostFields.set(allocated.at(-1), { ObjectFlags: 0, con: null, next: null });
  return allocated.at(-1);
};
const construct = details => {
  trace.push(['construct', details]);
  assert.equal(details.object, allocated.at(-1));
  assert.equal(details.constructor, 0x1000ecc0);
  assert.equal(details.vtable, 0x1001346c);
  hostFields.get(details.object).ObjectFlags = 0;
  hostFields.get(details.object).con = null;
  hostFields.get(details.object).next = null;
};
const deleteObject = details => {
  trace.push(['delete', details]);
  deleted.push(details);
  assert.equal(details.flags, 1);
  assert.equal(details.virtualSlot, 0x0c);
  assert.equal(details.kind, 'deleting-destructor');
};

const report = bindConversationsNative({
  list,
  actor,
  read,
  write,
  reference,
  allocate,
  construct,
  deleteObject,
});
assert.equal(report.purge.deleted.length, 1, 'purge runs before binding');
assert.deepEqual(report.matched.map(item => item.conversation), [normalConversation, barkConversation]);
assert.equal(report.matched[0].gate, 'normal');
assert.equal(report.matched[1].gate, 'bark');
assert.deepEqual(report.skipped.map(item => item.gate), ['normal-reject-bark', 'no-owner-match']);
assert.deepEqual(report.publishedOrder, [allocated[1], allocated[0]]);
assert.equal(hostFields.get(actor).ConListItems, allocated[1]);
assert.equal(hostFields.get(allocated[1]).next, allocated[0]);
assert.equal(hostFields.get(allocated[0]).next, null);
assert.equal(runtime.namedReference(normalConversation, 'ownerRefCount').get(), 1,
  'normal count decremented by purge then incremented by bind');
assert.equal(runtime.namedReference(barkConversation, 'ownerRefCount').get(), 1);
assert.equal(runtime.namedReference(rejectedBarkConversation, 'ownerRefCount').get(), 0);
assert.equal(hostFields.get(allocated[0]).ObjectFlags, 4);
assert.equal(hostFields.get(allocated[1]).ObjectFlags, 4);
assert.equal(deleted.length, 1);
assert.equal(deleted[0].object, oldItem);

// The owner count write precedes all allocation/constructor/link activity for
// each match, and the native Outer read occurs before operator new.
const firstAllocation = trace.findIndex(entry => entry[0] === 'allocate');
const firstCountWrite = trace.findIndex(entry => entry[0] === 'write' &&
  entry[2] === 'ownerRefCount' && entry[1] === normalConversation);
const firstOuterRead = trace.findIndex(entry => entry[0] === 'read' &&
  entry[1] === list && entry[2] === 'Outer');
assert.ok(firstCountWrite >= 0 && firstCountWrite < firstOuterRead && firstOuterRead < firstAllocation);
const firstConstruct = trace.findIndex(entry => entry[0] === 'construct');
const firstFlagRead = trace.findIndex(entry => entry[0] === 'read' && entry[1] === allocated[0] &&
  entry[2] === 'ObjectFlags');
assert.ok(firstAllocation < firstConstruct && firstConstruct < firstFlagRead);

// Native allocation failure is explicit and leaves the already incremented
// ownerRefCount in place; there is no host rollback or fabricated list item.
const failedConversationIndex = conText.exportsByPath.get('conversation3');
const failedConversation = await runtime.objects.resolve(conText, failedConversationIndex);
assert.equal(await runtime.prepareObject(failedConversation), failedConversation);
runtime.namedReference(failedConversation, 'conName').set('FailureLine');
runtime.namedReference(failedConversation, 'conOwnerName').set('FailActor');
runtime.namedReference(failedConversation, 'ownerRefCount').set(0);
const failedSource = { kind: 'ConItem', name: 'failedSource' };
const failedList = { kind: 'ConversationList', name: 'failedList' };
const failedActor = { kind: 'Actor', name: 'failedActor' };
const failedFields = new Map([
  [failedSource, { ConObject: failedConversation, Next: null }],
  [failedList, { conversations: failedSource, Outer: canonicalOuter }],
  [failedActor, { BindName: 'FailActor', BarkBindName: '', ConListItems: null }],
]);
const failedRead = (object, field) => failedFields.has(object)
  ? failedFields.get(object)[field]
  : runtime.namedReference(object, field).get();
const failedWrite = (object, field, value) => {
  if (failedFields.has(object)) failedFields.get(object)[field] = value;
  else runtime.namedReference(object, field).set(value);
};
assert.throws(() => bindConversationsNative({
  list: failedList,
  actor: failedActor,
  read: failedRead,
  write: failedWrite,
  reference,
  allocate: () => null,
  construct: () => { throw new Error('constructor must not run after null allocation'); },
  deleteObject,
}), error => error instanceof ConversationListNativeBoundaryError &&
  error.code === 'CONVERSATION_LIST_ALLOCATE');
assert.equal(runtime.namedReference(failedConversation, 'ownerRefCount').get(), 1);
assert.equal(failedFields.get(failedActor).ConListItems, null);

// Purge's empty path still writes None to the actor head, while requiring no
// destructor callback because no deleting-destructor call is reached.
const emptyActor = { kind: 'Actor', name: 'emptyActor' };
const emptyFields = new Map([[emptyActor, { ConListItems: null }]]);
let emptyWrites = 0;
purgeBoundConversationsNative({
  actor: emptyActor,
  read: (object, field) => emptyFields.get(object)[field],
  write: (object, field, value) => { emptyWrites++; emptyFields.get(object)[field] = value; },
  reference,
});
assert.equal(emptyWrites, 1);
assert.equal(emptyFields.get(emptyActor).ConListItems, null);

assert.equal(asciiCaseEqual('jCdEnToN', 'JCDENTON'), true);
assert.equal(caseSensitiveContains('Jaime_Bark', '_Bark'), true);
assert.equal(caseSensitiveContains('Jaime_bark', '_Bark'), false);
console.log('ConSys native conversation-list contract validated: package class/field metadata, hash-pinned ' +
  'BindConversations/PurgeBoundConversations instructions, canonical Mission00 identities, purge-first ' +
  'ownerRefCount order, BarkBindName/_Bark gates, ConListItem construction/linking, explicit allocation ' +
  'failure, deleting-destructor flags, and empty purge clearing.');
