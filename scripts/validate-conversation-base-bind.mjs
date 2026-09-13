/** Validate the exact ConSys ConEvent classes that dispatch to the inherited
 * DConEvent::BindActor false/no-write body at 0x10002350. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readClass} from '../src/unreal/classes.mjs';
import {objectAt, readObject} from '../src/unreal/objects.mjs';
import {
  CONVERSATION_BASE_BIND,
  bindConversationBaseActor,
  conversationBaseBindNativeContract,
  isConversationBaseBindClass,
} from '../src/runtime/script-conversation-base-bind.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory();
const files = [];
for (const name of await readdir(path.join(root, 'System')))
  files.push({path: `System/${name}`, read: () => readFile(path.join(root, 'System', name))});
const assets = new AssetStore(files);
const conSys = await assets.get('ConSys');

function sourceFor(index) {
  const metadata = readClass(conSys, index);
  assert.ok(metadata.scriptText, `class ${index} has a TextBuffer`);
  const object = readObject(conSys.pkg, conSys.bytes, metadata.scriptText);
  object.reader.u32();
  object.reader.u32();
  return {metadata, source: object.reader.string(conSys.pkg.version)};
}

function classRecord(key) {
  const record = CONVERSATION_BASE_BIND.classes.find(item => item.key === key);
  assert.ok(record, `module class record ${key}`);
  return record;
}

// This partition is independently transcribed from the installed export
// table.  It prevents the module from silently omitting an event class.
const EXPECTED_INHERITED = [
  'ConSys.ConEventJump',
  'ConSys.ConEventAddCredits',
  'ConSys.ConEventAddGoal',
  'ConSys.ConEventAddNote',
  'ConSys.ConEventAddSkillPoints',
  'ConSys.ConEventCheckFlag',
  'ConSys.ConEventCheckPersona',
  'ConSys.ConEventChoice',
  'ConSys.ConEventComment',
  'ConSys.ConEventEnd',
  'ConSys.ConEventRandomLabel',
  'ConSys.ConEventSetFlag',
  'ConSys.ConEventTrigger',
];
const EXPECTED_OVERRIDES = [
  'ConSys.ConEventSpeech',
  'ConSys.ConEventMoveCamera',
  'ConSys.ConEventAnimation',
  'ConSys.ConEventCheckObject',
  'ConSys.ConEventTrade',
  'ConSys.ConEventTransferObject',
];
const expectedKeys = [...EXPECTED_INHERITED, ...EXPECTED_OVERRIDES];
const sorted = values => [...values].sort((a, b) => a.localeCompare(b));
assert.deepEqual(sorted(CONVERSATION_BASE_BIND.inheritedClassKeys), sorted(EXPECTED_INHERITED));
assert.deepEqual(sorted(CONVERSATION_BASE_BIND.overrideClassKeys), sorted(EXPECTED_OVERRIDES));
assert.deepEqual(sorted(CONVERSATION_BASE_BIND.classes.map(item => item.key)), sorted(expectedKeys));

// The base class itself is abstract but establishes the inherited method and
// its vtable.  Concrete dispatch below remains limited to EXPECTED_INHERITED.
const baseEntry = conSys.pkg.exports[CONVERSATION_BASE_BIND.baseClass.classExport - 1];
assert.equal(baseEntry?.path, 'ConEvent');
assert.equal(baseEntry?.className, 'Class');
assert.equal(baseEntry?.superIndex, 6);
assert.equal(baseEntry?.flags, 0x040f0004);
const baseSource = sourceFor(CONVERSATION_BASE_BIND.baseClass.classExport);
assert.equal(baseSource.metadata.classFlags, 0x113);
assert.equal(baseSource.metadata.scriptText, 328);
assert.match(baseSource.source,
  /class\s+ConEvent\s+extends\s+ConObject[\s\S]*?abstract[\s\S]*?native[\s\S]*?noexport/i);
assert.equal(objectAt(conSys.pkg, baseSource.metadata.scriptText)?.path, 'ConEvent.ScriptText');

for (const key of expectedKeys) {
  const record = classRecord(key);
  const entry = conSys.pkg.exports[record.classExport - 1];
  assert.equal(entry?.path, key.split('.')[1], `${key} class export`);
  assert.equal(entry?.className, 'Class', `${key} class kind`);
  assert.equal(entry?.superIndex, 2, `${key} superclass`);
  assert.equal(entry?.flags, 0x040f0004, `${key} export flags`);
  const source = sourceFor(record.classExport);
  assert.equal(source.metadata.classFlags, 0x112, `${key} class flags`);
  assert.equal(source.metadata.scriptText, record.scriptTextExport, `${key} TextBuffer export`);
  assert.equal(objectAt(conSys.pkg, source.metadata.scriptText)?.path,
    `${key.split('.')[1]}.ScriptText`, `${key} TextBuffer path`);
  assert.match(source.source,
    new RegExp(`class\\s+${key.split('.')[1]}\\s+extends\\s+ConEvent[\\s\\S]*?native[\\s\\S]*?noexport`, 'i'),
    `${key} source declaration`);
}

const dllPath = path.join(root, 'System', 'ConSys.dll');
const dll = new Uint8Array(await readFile(dllPath));
assert.equal(createHash('sha256').update(dll).digest('hex'),
  'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa',
  'installed ConSys.dll hash');

// Resolve PE RVAs to file offsets so the checks remain explicit about the
// original image rather than relying on this build's coincident section
// offsets.  The installed DLL is PE32.
const u16 = offset => dll[offset] | (dll[offset + 1] << 8);
const u32 = offset => (dll[offset] | (dll[offset + 1] << 8) |
  (dll[offset + 2] << 16) | (dll[offset + 3] << 24)) >>> 0;
const pe = u32(0x3c);
assert.deepEqual([...dll.subarray(pe, pe + 4)], [0x50, 0x45, 0, 0], 'PE signature');
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
function bytesAtRva(rva, length) { return [...dll.subarray(rvaOffset(rva), rvaOffset(rva) + length)]; }
function readCStringRva(rva) {
  const offset = rvaOffset(rva);
  let end = offset;
  while (end < dll.length && dll[end] !== 0) end++;
  return new TextDecoder('ascii').decode(dll.subarray(offset, end));
}
function expectBytesRva(rva, expected, label) {
  assert.deepEqual(bytesAtRva(rva, expected.length), expected, label);
}

// Read the actual export directory and resolve every `??_7DConEvent...`
// exported vtable.  This proves the class key -> vtable association before
// checking the +0x58 slot target.
const exportDirectoryRva = u32(optional + 96); // PE32 data directory 0
const exportDirectory = rvaOffset(exportDirectoryRva);
const exportFunctionCount = u32(exportDirectory + 20);
const exportNameCount = u32(exportDirectory + 24);
const exportFunctionsRva = u32(exportDirectory + 28);
const exportNamesRva = u32(exportDirectory + 32);
const exportOrdinalsRva = u32(exportDirectory + 36);
assert.ok(exportFunctionCount > 0 && exportNameCount > 0, 'ConSys export directory');
const exportsByName = new Map();
for (let index = 0; index < exportNameCount; index++) {
  const name = readCStringRva(readRva(exportNamesRva + index * 4));
  const ordinal = u16(rvaOffset(exportOrdinalsRva) + index * 2);
  assert.ok(ordinal < exportFunctionCount, `export ordinal ${name}`);
  exportsByName.set(name, imageBase + readRva(exportFunctionsRva + ordinal * 4));
}

expectBytesRva(CONVERSATION_BASE_BIND.nativeBody - imageBase,
  CONVERSATION_BASE_BIND.bodyBytes, 'DConEvent::BindActor false body');
assert.equal(CONVERSATION_BASE_BIND.vtableSlot, 0x58);
assert.equal(CONVERSATION_BASE_BIND.argumentBytes, 0xc);
for (const record of [CONVERSATION_BASE_BIND.baseClass, ...CONVERSATION_BASE_BIND.classes]) {
  assert.equal(exportsByName.get(record.nativeExport), record.vtable,
    `${record.key} exported vtable`);
  const slot = readRva(record.vtable - imageBase + CONVERSATION_BASE_BIND.vtableSlot);
  assert.equal(slot, record.slotTarget, `${record.key} BindActor slot`);
  assert.equal(record.slot, CONVERSATION_BASE_BIND.vtableSlot);
}

for (const key of EXPECTED_INHERITED) {
  const record = classRecord(key);
  assert.equal(record.slotTarget, CONVERSATION_BASE_BIND.nativeBody, `${key} inherited target`);
  assert.equal(isConversationBaseBindClass(key), true, `${key} recognized`);
  // The native body ignores receiver and all arguments; this call deliberately
  // supplies no event/actor/conversation fields and must still return false.
  assert.equal(bindConversationBaseActor({classKey: key}), false, `${key} false result`);
}
for (const key of EXPECTED_OVERRIDES) {
  const record = classRecord(key);
  assert.notEqual(record.slotTarget, CONVERSATION_BASE_BIND.nativeBody, `${key} override target`);
  assert.equal(isConversationBaseBindClass(key), false, `${key} rejected by base dispatch`);
  assert.throws(() => bindConversationBaseActor({classKey: key}), error =>
    error.code === 'CONVERSATION_BASE_BIND_OVERRIDE' && error.slotTarget === record.slotTarget,
    `${key} override remains unsupported`);
  assert.deepEqual(conversationBaseBindNativeContract(key), record);
}
assert.throws(() => bindConversationBaseActor({classKey: 'ConSys.ConEventUnknown'}), error =>
  error.code === 'CONVERSATION_BASE_BIND_CLASS');
assert.throws(() => bindConversationBaseActor({classKey: ''}), error =>
  error.code === 'CONVERSATION_BASE_BIND_CLASS_KEY');

console.log('Original ConSys inherited ConEvent BindActor passed: 13 exact class keys, ' +
  'PE export/vtable +0x58 targets, and 0x10002350 false/no-write body.');
console.log('Concrete override targets remain outside the inherited binder: ' +
  EXPECTED_OVERRIDES.join(', ') + '.');
