/** Focused original-evidence validator for ConSys conversation construction.
 * It validates package class metadata/source, ConSys constructor and
 * registration bytes, DConListItem allocation/link writes, and keeps the
 * DataLinkPlay inherited-constructor boundary explicit. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { readClass } from '../src/unreal/classes.mjs';
import { readObject } from '../src/unreal/objects.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import {
  CONSYS_NATIVE_CONSTRUCTION,
  DATALINK_PLAY_CONSTRUCTION,
  conSysNativeConstruction,
} from '../src/runtime/script-conversation-construction.mjs';
import { gameDirectory } from './game-directory.mjs';
import { entryOf } from '../src/unreal/objects.mjs';

const root = gameDirectory();
const files = [];
for (const directory of ['Maps', 'System']) {
  for (const name of await readdir(path.join(root, directory))) {
    files.push({
      path: `${directory}/${name}`,
      read: () => readFile(path.join(root, directory, name)),
    });
  }
}
const assets = new AssetStore(files);
const deusEx = await assets.get('DeusEx');
const conSys = await assets.get('ConSys');

function classRecord(asset, classPath) {
  const index = asset.exportsByPath.get(classPath.toLowerCase());
  assert.ok(index, `missing original class ${asset.name}.${classPath}`);
  const metadata = readClass(asset, index);
  return { index, entry: metadata.entry, metadata };
}

function sourceFor(asset, classPath) {
  const record = classRecord(asset, classPath);
  assert.ok(record.metadata.scriptText, `${asset.name}.${classPath} has no TextBuffer`);
  const reader = readObject(asset.pkg, asset.bytes, record.metadata.scriptText).reader;
  reader.u32();
  reader.u32();
  return { ...record, source: reader.string(asset.pkg.version) };
}

function declaration(source) {
  const match = source.match(/class\s+[A-Za-z0-9_]+[\s\S]*?;/i);
  assert.ok(match, 'class declaration is present');
  return match[0];
}

function bytesAt(bytes, offset, length) {
  return [...bytes.subarray(offset, offset + length)];
}

function expectBytes(bytes, offset, expected, label) {
  assert.deepEqual(bytesAt(bytes, offset, expected.length), expected, label);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const dataLink = sourceFor(deusEx, 'datalinkplay');
const conPlayBase = sourceFor(deusEx, 'conplaybase');
assert.equal(dataLink.index, DATALINK_PLAY_CONSTRUCTION.packageExport);
assert.equal(entryOf(dataLink).flags, DATALINK_PLAY_CONSTRUCTION.exportFlags);
assert.equal(entryOf(dataLink).superIndex, DATALINK_PLAY_CONSTRUCTION.superPackageExport);
assert.equal(dataLink.metadata.classFlags, DATALINK_PLAY_CONSTRUCTION.serializedClassFlags);
assert.equal(declaration(dataLink.source).replace(/\s+/g, ' ').trim(),
  DATALINK_PLAY_CONSTRUCTION.scriptDeclaration);
assert.doesNotMatch(declaration(dataLink.source), /\bnative\b/i);
assert.match(declaration(conPlayBase.source), /class\s+ConPlayBase\s+expands\s+Actor\s*;/i);
assert.doesNotMatch(declaration(conPlayBase.source), /\bnative\b/i);
assert.equal(DATALINK_PLAY_CONSTRUCTION.nativeConstructor, null);
assert.equal(DATALINK_PLAY_CONSTRUCTION.nativeVtable, null);

const conObject = sourceFor(conSys, 'conobject');
const conversation = sourceFor(conSys, 'conversation');
const conListItem = sourceFor(conSys, 'conlistitem');
assert.equal(conObject.index, 6);
assert.equal(conversation.index, 30);
assert.equal(conListItem.index, 83);
assert.equal(entryOf(conObject).flags, 0x040f0004);
assert.equal(entryOf(conversation).flags, 0x040f0004);
assert.equal(entryOf(conListItem).flags, 0x040f0004);
assert.equal(entryOf(conObject).superIndex, -4);
assert.equal(entryOf(conversation).superIndex, 6);
assert.equal(entryOf(conListItem).superIndex, 6);
assert.equal(conObject.metadata.within, -4);
assert.equal(conversation.metadata.within, -4);
assert.equal(conListItem.metadata.within, -4);
assert.equal(conObject.metadata.classFlags, 0x113);
assert.equal(conversation.metadata.classFlags, 0x112);
assert.equal(conListItem.metadata.classFlags, 0x112);
assert.match(declaration(conObject.source), /abstract\s+native\s+noexport/i);
assert.match(declaration(conversation.source), /native\s+noexport/i);
assert.match(declaration(conListItem.source), /native\s+noexport/i);

const nativeMethods = {
  createflagref: [2050, 10],
  createconcamera: [2051, 0],
  bindevents: [2052, 10],
  bindactorevents: [2053, 5],
  clearbindevents: [2054, 0],
  getspeechaudio: [2055, 5],
  getspeechlength: [2056, 5],
};
for (const [name, [nativeIndex, scriptSize]] of Object.entries(nativeMethods)) {
  const index = conSys.exportsByPath.get(`conversation.${name}`);
  assert.ok(index, `missing ConSys.Conversation.${name}`);
  const metadata = readFunctionMetadata(conSys, index);
  assert.equal(metadata.nativeIndex, nativeIndex, `Conversation.${name} native index`);
  assert.equal(metadata.scriptSize, scriptSize, `Conversation.${name} script size`);
}

const dllPath = path.join(root, 'System', 'ConSys.dll');
const dll = new Uint8Array(await readFile(dllPath));
assert.equal(hash(dll), CONSYS_NATIVE_CONSTRUCTION.dllSha256, 'ConSys.dll hash');

// Null-guarded InternalConstructor thunks: test ecx and jump to the concrete body.
expectBytes(dll, 0x1370, [0x8b, 0x4c, 0x24, 0x04, 0x85, 0xc9, 0x74, 0x05,
  0xe9, 0x03, 0x00, 0x00, 0x00], 'DConObject InternalConstructor');
expectBytes(dll, 0x26d0, [0x8b, 0x4c, 0x24, 0x04, 0x85, 0xc9, 0x74, 0x05,
  0xe9, 0x43, 0xca, 0x00, 0x00], 'DConversation InternalConstructor');
expectBytes(dll, 0x2e60, [0x8b, 0x4c, 0x24, 0x04, 0x85, 0xc9, 0x74, 0x05,
  0xe9, 0x53, 0xbe, 0x00, 0x00], 'DConListItem InternalConstructor');

// Concrete bodies call Core UObject::UObject through IAT +0x13080 and write
// only the recovered vtable/default-field stores.
expectBytes(dll, 0x1380, [0x56, 0x8b, 0xf1, 0xff, 0x15, 0x80, 0x30, 0x01, 0x10,
  0xc7, 0x06, 0xc4, 0x31, 0x01, 0x10, 0x8b, 0xc6, 0x5e, 0xc3], 'DConObject body');
expectBytes(dll, 0xf120, [0x56, 0x8b, 0xf1, 0xff, 0x15, 0x80, 0x30, 0x01, 0x10,
  0xc7, 0x06, 0xc4, 0x33, 0x01, 0x10, 0x8b, 0xc6, 0x5e, 0xc3], 'DConversation body');
expectBytes(dll, 0xecc0, [0x56, 0x8b, 0xf1, 0xff, 0x15, 0x80, 0x30, 0x01, 0x10,
  0x33, 0xc0, 0xc7, 0x06, 0x6c, 0x34, 0x01, 0x10,
  0x89, 0x46, 0x28, 0x89, 0x46, 0x2c, 0x8b, 0xc6, 0x5e, 0xc3], 'DConListItem body');

// Registration snippets include the native-constructor pointer, raw flags,
// class names/package/config text, static class address, and exact instance size.
expectBytes(dll, 0xec1b, [0x68, 0x60, 0x2e, 0x00, 0x10, 0x68, 0x04, 0x40, 0x08, 0x04],
  'DConListItem registration constructor/flags');
expectBytes(dll, 0xec25, [0x68, 0x6c, 0xd1, 0x01, 0x10, 0x68, 0x90, 0xd9, 0x01, 0x10,
  0x68, 0x46, 0xd9, 0x01, 0x10], 'DConListItem registration texts');
expectBytes(dll, 0xec50, [0x6a, 0x30, 0x56, 0x89, 0x57, 0x08,
  0xb9, 0xe0, 0x68, 0x02, 0x10], 'DConListItem registration size/class');
expectBytes(dll, 0xecfb, [0x68, 0x70, 0x13, 0x00, 0x10, 0x68, 0x04, 0x40, 0x08, 0x04],
  'DConObject registration constructor/flags');
expectBytes(dll, 0xed05, [0x68, 0x6c, 0xd1, 0x01, 0x10, 0x68, 0x90, 0xd9, 0x01, 0x10,
  0x68, 0x62, 0xd9, 0x01, 0x10], 'DConObject registration texts');
expectBytes(dll, 0xed2c, [0x6a, 0x28, 0x56, 0x89, 0x57, 0x08,
  0xb9, 0xe0, 0x6d, 0x02, 0x10], 'DConObject registration size/class');
expectBytes(dll, 0xf07b, [0x68, 0xd0, 0x26, 0x00, 0x10, 0x68, 0x04, 0x40, 0x08, 0x04],
  'DConversation registration constructor/flags');
expectBytes(dll, 0xf085, [0x68, 0x6c, 0xd1, 0x01, 0x10, 0x68, 0x90, 0xd9, 0x01, 0x10,
  0x68, 0x2e, 0xdb, 0x01, 0x10], 'DConversation registration texts');
expectBytes(dll, 0xf0af, [0x56, 0x6a, 0x78, 0x56, 0x89, 0x57, 0x08,
  0xb9, 0xe8, 0x77, 0x02, 0x10], 'DConversation registration size/class');

// operator new forwards the class and StaticAllocateObject call; binding then
// requests 0x30 bytes, invokes the constructor, and links con/next at +0x28/+0x2c.
expectBytes(dll, 0x2dc0, [0xa1, 0x28, 0x30, 0x01, 0x10, 0x8b, 0x54, 0x24, 0x10,
  0x6a, 0x00, 0x8b, 0x08], 'DConListItem operator new');
expectBytes(dll, 0x10ca6, [0x50, 0x6a, 0x30], 'BindConversations allocation size');
expectBytes(dll, 0x10cb5, [0x8b, 0xc8, 0xe8, 0x04, 0xe0, 0xff, 0xff],
  'BindConversations constructor call');
expectBytes(dll, 0x10cc0, [0x8b, 0x48, 0x1c, 0x89, 0x70, 0x28, 0x83, 0xc9, 0x04,
  0x89, 0x48, 0x1c, 0x8b, 0x8f, 0xdc, 0x02, 0x00, 0x00],
  'BindConversations field/link writes');

assert.equal(conSysNativeConstruction('ConListItem').fields.con, 0x28);
assert.equal(conSysNativeConstruction('ConListItem').fields.next, 0x2c);
assert.equal(conSysNativeConstruction('Conversation').instanceSize, 0x78);
assert.equal(conSysNativeConstruction('ConObject').vtable, 0x100131c4);
assert.equal(DATALINK_PLAY_CONSTRUCTION.status, 'source-backed-inherited-actor-constructor');

console.log('ConSys construction contract validated: ConObject, Conversation, and ConListItem class metadata, ' +
  'null-guarded native constructors/vtables, UClass registration arguments, and the original BindConversations ' +
  'allocation/link path. DataLinkPlay inherited construction is validated separately.');
