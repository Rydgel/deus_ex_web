/** Validate the recovered USound serializer and lifetime contract. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

import {gameDirectory} from './game-directory.mjs';
import {
  SOUND_LIFECYCLE_CONTRACT,
  deleteSoundLifecycle,
  destroySoundLifecycle,
  serializeSoundHelperLifecycle,
  serializeSoundLifecycle,
} from '../src/runtime/script-sound-lifecycle.mjs';

const root = path.resolve(process.argv[2] ?? gameDirectory());

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function imageLayout(bytes, label) {
  const peOffset = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString('ascii', peOffset, peOffset + 4), 'PE\0\0', `${label} PE signature`);
  const coff = peOffset + 4;
  const sectionCount = bytes.readUInt16LE(coff + 2);
  const optionalSize = bytes.readUInt16LE(coff + 16);
  const optional = coff + 20;
  const imageBase = bytes.readUInt32LE(optional + 28);
  const sectionTable = optional + optionalSize;
  const sections = [];
  for (let i = 0; i < sectionCount; i += 1) {
    const offset = sectionTable + i * 40;
    sections.push({
      name: bytes.toString('ascii', offset, offset + 8).replace(/\0.*$/, ''),
      virtualSize: bytes.readUInt32LE(offset + 8),
      virtualAddress: bytes.readUInt32LE(offset + 12),
      rawSize: bytes.readUInt32LE(offset + 16),
      rawPointer: bytes.readUInt32LE(offset + 20),
    });
  }
  return {imageBase, sections};
}

function imageOffset(bytes, address, label) {
  const layout = imageLayout(bytes, label);
  const rva = address - layout.imageBase;
  assert.ok(Number.isInteger(rva) && rva >= 0, `${label} address is in image`);
  const section = layout.sections.find(candidate => (
    rva >= candidate.virtualAddress &&
    rva < candidate.virtualAddress + Math.max(candidate.virtualSize, candidate.rawSize)
  ));
  assert.ok(section, `${label} address 0x${address.toString(16)} maps to a PE section`);
  const offset = section.rawPointer + (rva - section.virtualAddress);
  assert.ok(offset >= 0 && offset < bytes.length, `${label} address maps into file`);
  return offset;
}

function imageDword(bytes, address, label) {
  const offset = imageOffset(bytes, address, label);
  assert.ok(offset + 4 <= bytes.length, `${label} dword is within file`);
  return bytes.readUInt32LE(offset);
}

function expectImageBytes(bytes, address, expected, label) {
  const offset = imageOffset(bytes, address, label);
  assert.deepEqual([...bytes.subarray(offset, offset + expected.length)], expected, label);
}

const corePath = path.join(root, 'System', 'Core.dll');
const enginePath = path.join(root, 'System', 'Engine.dll');
const [coreBytes, engineBytes] = await Promise.all([
  readFile(corePath),
  readFile(enginePath),
]);
const coreHash = sha256(coreBytes);
const engineHash = sha256(engineBytes);
assert.equal(coreHash, '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
  'Core.dll hash');
assert.equal(engineHash, '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
  'Engine.dll hash');

// FArchive's two lazy-loader virtual entries are the concrete ownership edge
// reached by FSoundData::~FSoundData.  Check both the specialized measuring
// table and the exported base table, then check their no-op bodies.
const archiveTables = {
  measuring: 0x10177640,
  base: 0x101751f8,
};
for (const [name, table] of Object.entries(archiveTables)) {
  assert.equal(imageDword(coreBytes, table + 0x38, `${name} AttachLazyLoader slot`), 0x10101325);
  assert.equal(imageDword(coreBytes, table + 0x3c, `${name} DetachLazyLoader slot`), 0x101022d4);
}
expectImageBytes(coreBytes, 0x10106a40, [0xc2, 0x04, 0x00], 'AttachLazyLoader body');
expectImageBytes(coreBytes, 0x10106a60, [0xc2, 0x04, 0x00], 'DetachLazyLoader body');

// Native instruction spans pin the flag-pointer prologue/normal epilogue,
// FSoundData's +0x04 archive dispatch and clear order, the generic array
// helper ABI, and the deleting-wrapper cookie arguments.
expectImageBytes(engineBytes, 0x1036f92c, [
  0xa1, 0xc0, 0x9c, 0x59, 0x10, 0x8b, 0x08, 0x89, 0x4d, 0xec,
  0x8b, 0x15, 0xc0, 0x9c, 0x59, 0x10, 0xc7, 0x02, 0x01, 0x00, 0x00, 0x00,
], 'USound::Serialize GLazyLoad pointer prologue');
expectImageBytes(engineBytes, 0x1036f9ad, [
  0x8b, 0x0d, 0xc0, 0x9c, 0x59, 0x10, 0x8b, 0x55, 0xec, 0x89, 0x11,
], 'USound::Serialize normal GLazyLoad restoration');
expectImageBytes(engineBytes, 0x1030ca7c, [
  0x8b, 0x4e, 0x04, 0x33, 0xdb, 0x89, 0x5d, 0xfc, 0x3b, 0xcb,
  0xc6, 0x45, 0xfc, 0x01, 0x74, 0x06, 0x8b, 0x01, 0x56, 0xff, 0x50, 0x3c,
], 'FSoundData archive-owner DetachLazyLoader dispatch');
expectImageBytes(engineBytes, 0x1030cb3d, [
  0x89, 0x1e, 0x89, 0x5e, 0x08, 0x89, 0x5e, 0x04,
], 'FSoundData array clear order');
expectImageBytes(engineBytes, 0x104134fd, [
  0x8b, 0x75, 0x0c, 0x8b, 0xc6, 0x0f, 0xaf, 0x45, 0x10,
  0x01, 0x45, 0x08, 0x83, 0x65, 0xfc, 0x00, 0xff, 0x4d, 0x10,
], 'native array destruction helper count ABI');
expectImageBytes(engineBytes, 0x1031cc05, [
  0x56, 0x8b, 0xf1, 0xf6, 0xc3, 0x02, 0x74, 0x30, 0x8b, 0x46, 0xfc,
  0x57, 0x8d, 0x7e, 0xfc, 0x68, 0x5d, 0x3a, 0x30, 0x10, 0x50,
  0x6a, 0x54, 0x56,
], 'USound deleting-wrapper cookie and array-helper arguments');

function makeSound({archiveOwner = null, data = 0x2400, num = 4, max = 8} = {}) {
  return {
    vtable: 0,
    formatName: {index: 1, name: 'wav'},
    serializedByteCount: num,
    allocationHeader: 0x1ff0,
    allocationCount: 1,
    soundData: {
      vtable: 0,
      externalService: archiveOwner,
      array: {data, num, max},
    },
  };
}

// No-helper branch: UObject, live FName&, CountBytes and normal flag restore.
const serializerCalls = [];
const serializerSound = makeSound({num: 17, max: 24});
const serializerArchive = {ar0c: 0, ar10: 0, version: 68, serializationFlag: 9};
const serializerResult = serializeSoundLifecycle(serializerSound, serializerArchive, {
  uobjectSerialize: () => serializerCalls.push('uobject'),
  serializeName: reference => {
    serializerCalls.push('name');
    assert.equal(reference.get(), serializerSound.formatName);
    reference.set({index: 2, name: 'ogg'});
  },
  countBytes: (archive, count, maximum) => {
    serializerCalls.push(['count', count, maximum]);
    assert.equal(archive, serializerArchive);
  },
});
assert.deepEqual(serializerCalls, ['uobject', 'name', ['count', 17, 17]]);
assert.deepEqual(serializerSound.formatName, {index: 2, name: 'ogg'});
assert.equal(serializerArchive.serializationFlag, 9);
assert.equal(serializerResult.branch.branch, 'count-bytes');

// Direct helper gate: when +0x0c is nonzero, +0x10 must not be read.  This
// call also exercises the version-68 raw offset, Attach and Seek order.
const gateReads = [];
const gateCalls = [];
const gateResult = serializeSoundHelperLifecycle(makeSound({num: 0, max: 0}), {}, {
  readArchiveWord: (archive, offset) => {
    gateReads.push(offset);
    if (offset === 0x0c) return 1;
    if (offset === 0x04) return 68;
    throw new Error(`unexpected archive read +0x${offset.toString(16)}`);
  },
  serializeRaw: (archive, holder, width) => {
    assert.equal(width, 4);
    holder.value = 0x340;
    gateCalls.push('serialize');
  },
  attachLazyLoader: () => gateCalls.push('attach'),
  seek: (archive, offset) => gateCalls.push(['seek', offset]),
  serializationFlag: {value: 1},
});
assert.deepEqual(gateReads, [0x0c, 0x04]);
assert.deepEqual(gateCalls, ['serialize', 'attach', ['seek', 0x340]]);
assert.equal(gateResult.branch.offset, 0x340);

// Native callback failure leaves GLazyLoad set to one: only the normal native
// epilogue visibly restores the saved value in this recovered body.
const failedArchive = {ar0c: 0, ar10: 0, version: 68, serializationFlag: 4};
assert.throws(() => serializeSoundLifecycle(makeSound(), failedArchive, {
  uobjectSerialize: () => { throw new Error('adapter failure'); },
}), /adapter failure/);
assert.equal(failedArchive.serializationFlag, 1);

// Complete destruction: the FSoundData +0x04 archive edge precedes array
// Remove/free/clears, and the UObject base destructor follows all of them.
const destructionCalls = [];
const archiveOwner = {kind: 'FArchive'};
const destroyedSound = makeSound({archiveOwner, data: 0x2a00, num: 7, max: 9});
const destructionResult = destroySoundLifecycle(destroyedSound, {
  conditionalDestroy: () => destructionCalls.push('conditional'),
  detachLazyLoader: (archive, data) => {
    destructionCalls.push('detach');
    assert.equal(archive, archiveOwner);
    assert.equal(data, destroyedSound.soundData);
  },
  arrayRemove: array => {
    destructionCalls.push('remove');
    array.num = 0;
  },
  allocatorFree: pointer => {
    destructionCalls.push(['free', pointer]);
    assert.equal(pointer, 0x2a00);
  },
  baseDestructor: () => destructionCalls.push('base'),
});
assert.deepEqual(destructionCalls, ['conditional', 'detach', 'remove', ['free', 0x2a00], 'base']);
assert.deepEqual(destroyedSound.soundData.array, {data: 0, num: 0, max: 0});
assert.equal(destructionResult.soundData.archiveOwner, archiveOwner);

// Array deleting-wrapper branch: cookie address and cookie count are distinct
// native values, and bit 0x1 frees the cookie only after helper completion.
const deleteCalls = [];
const deleteSound = makeSound();
const deleteResult = deleteSoundLifecycle(deleteSound, 0x3, {
  allocationCount: () => 2,
  arrayDestructor: (value, size, count, thunk) => {
    deleteCalls.push(['array', value, size, count, thunk]);
  },
  allocatorFree: pointer => deleteCalls.push(['free', pointer]),
});
assert.deepEqual(deleteCalls, [
  ['array', deleteSound, 0x54, 2, 0x10303a5d],
  ['free', 0x1ff0],
]);
assert.equal(deleteResult.branch, 'array');
assert.equal(deleteResult.allocationHeader, 0x1ff0);
assert.equal(deleteResult.allocationCount, 2);

console.log(JSON.stringify({
  packageRoot: root,
  binaries: {Core: coreHash, Engine: engineHash},
  archiveVtables: Object.fromEntries(Object.entries(archiveTables).map(([name, table]) => [name, {
    attach: imageDword(coreBytes, table + 0x38, `${name} AttachLazyLoader slot`),
    detach: imageDword(coreBytes, table + 0x3c, `${name} DetachLazyLoader slot`),
  }])),
  serializer: {
    branch: serializerResult.branch,
    calls: serializerCalls.map(call => Array.isArray(call) ? call.slice(0) : call),
    formatName: serializerSound.formatName,
    normalFlag: serializerArchive.serializationFlag,
    failedFlag: failedArchive.serializationFlag,
  },
  helperGate: {reads: gateReads, calls: gateCalls, offset: gateResult.branch.offset},
  destruction: {calls: destructionCalls, cleared: destroyedSound.soundData.array},
  deletingArray: {calls: deleteCalls, allocationHeader: deleteResult.allocationHeader,
    allocationCount: deleteResult.allocationCount},
  status: 'contract-validated against hash-verified original bytes and adapter traces; original native execution is not claimed',
}, null, 2));
