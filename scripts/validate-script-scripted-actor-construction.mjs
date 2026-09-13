/** Validate the original DataLinkPlay scripted-Actor construction contract. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

import {AssetStore} from '../src/unreal/assets.mjs';
import {ClassDefaults, readClass} from '../src/unreal/classes.mjs';
import {readObject} from '../src/unreal/objects.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {
  DATALINK_PLAY_CONSTRUCTION,
  SCRIPTED_ACTOR_CONSTRUCTION,
  resolveInheritedActorConstructor,
  verifyDataLinkPlayDefaults,
} from '../src/runtime/script-scripted-actor-construction.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory();
const files = [];
for (const directory of ['System', 'Maps']) {
  for (const name of await readdir(path.join(root, directory))) {
    files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
  }
}
const assets = new AssetStore(files);
const deusEx = await assets.get('DeusEx');
const engine = await assets.get('Engine');

function classRecord(asset, classPath) {
  const index = asset.exportsByPath.get(classPath.toLowerCase());
  assert.ok(index, `missing original class ${asset.name}.${classPath}`);
  return {index, metadata: readClass(asset, index)};
}

function sourceFor(asset, classPath) {
  const record = classRecord(asset, classPath);
  assert.ok(record.metadata.scriptText, `${asset.name}.${classPath} has no source TextBuffer`);
  const reader = readObject(asset.pkg, asset.bytes, record.metadata.scriptText).reader;
  reader.u32();
  reader.u32();
  return {...record, source: reader.string(asset.pkg.version)};
}

function declaration(source) {
  const match = source.match(/class\s+[A-Za-z0-9_]+[\s\S]*?;/i);
  assert.ok(match, 'class declaration is present');
  return match[0].replace(/\s+/g, ' ').trim();
}

function expectBytes(bytes, offset, expected, label) {
  assert.deepEqual([...bytes.subarray(offset, offset + expected.length)], expected, label);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const dataLink = sourceFor(deusEx, 'DataLinkPlay');
const conPlayBase = sourceFor(deusEx, 'ConPlayBase');
const actor = classRecord(engine, 'Actor');

assert.equal(dataLink.index, DATALINK_PLAY_CONSTRUCTION.packageExport);
assert.equal(dataLink.metadata.entry.flags, DATALINK_PLAY_CONSTRUCTION.exportFlags);
assert.equal(dataLink.metadata.base, DATALINK_PLAY_CONSTRUCTION.superPackageExport);
assert.equal(dataLink.metadata.classFlags, DATALINK_PLAY_CONSTRUCTION.serializedClassFlags);
assert.equal(declaration(dataLink.source), DATALINK_PLAY_CONSTRUCTION.scriptDeclaration);
assert.doesNotMatch(declaration(dataLink.source), /\bnative\b/i);

assert.equal(conPlayBase.metadata.entry.flags, 0x000f0004);
assert.equal(conPlayBase.metadata.base, -3);
assert.equal(conPlayBase.metadata.classFlags, 0x32);
assert.equal(declaration(conPlayBase.source), 'class ConPlayBase expands Actor;');
assert.doesNotMatch(declaration(conPlayBase.source), /\bnative\b/i);

assert.equal(actor.index, SCRIPTED_ACTOR_CONSTRUCTION.engineActor.packageExport);
assert.equal(actor.metadata.entry.flags, SCRIPTED_ACTOR_CONSTRUCTION.engineActor.exportFlags);
assert.equal(actor.metadata.base, -3);
assert.equal(actor.metadata.classFlags, SCRIPTED_ACTOR_CONSTRUCTION.engineActor.serializedClassFlags);

for (const source of [dataLink.source, conPlayBase.source]) {
  assert.doesNotMatch(source,
    /\b(?:event|simulated\s+event|function)\s+(?:Spawned|PreBeginPlay|BeginPlay|PostBeginPlay|PostPostBeginPlay|SetInitialState)\b/i,
    'DataLinkPlay/ConPlayBase do not override Actor startup events');
}

const defaults = new ClassDefaults(assets);
const dataLinkDefaults = await defaults.get(deusEx, dataLink.index);
verifyDataLinkPlayDefaults(dataLinkDefaults);
for (const name of DATALINK_PLAY_CONSTRUCTION.zeroWhenAbsent) {
  assert.equal(Object.hasOwn(dataLinkDefaults, name), false, `${name} remains absent from authored scalar defaults`);
  assert.equal(dataLinkDefaults[name] ?? false, false, `${name} is zero after native initialization`);
}
assert.equal(dataLinkDefaults.bHidden, true);
assert.equal(dataLinkDefaults.bMovable, true);
assert.equal(dataLinkDefaults.bDetectable, true);
assert.equal(dataLinkDefaults.Role, 4);
assert.equal(dataLinkDefaults.RemoteRole, 1);
assert.equal(dataLinkDefaults.CollisionRadius, 22);
assert.equal(dataLinkDefaults.CollisionHeight, 22);
assert.equal(dataLinkDefaults.bGameRelevant, undefined);

const runtime = new ScriptRuntime(assets);
const infoIndex = deusEx.exportsByPath.get('datalinkplay.s_infolinknames');
assert.ok(infoIndex, 'missing DataLinkPlay.S_InfoLinkNames');
const infoRecord = await runtime.objects.resolve(deusEx, infoIndex);
const infoLayout = await runtime.structLayout(infoRecord);
assert.equal(infoLayout.propertiesSize, SCRIPTED_ACTOR_CONSTRUCTION.layout.infoLinkNamesStructSize);

// PropertiesSize and member offsets are supplied by the existing linked
// property machinery. This validator checks the recovered constants/schema;
// it does not reimplement UStruct::Link arithmetic in JavaScript.
assert.equal(SCRIPTED_ACTOR_CONSTRUCTION.layout.actorPropertiesSize, 0x318);
assert.equal(SCRIPTED_ACTOR_CONSTRUCTION.layout.conPlayBasePropertiesSize, 0x3c0);
assert.equal(SCRIPTED_ACTOR_CONSTRUCTION.layout.dataLinkPlayPropertiesSize, 0x5ac);
assert.equal(DATALINK_PLAY_CONSTRUCTION.fields.find(field => field.name === 'infoLinkNames').elementSize, 0x18);
assert.equal(DATALINK_PLAY_CONSTRUCTION.fields.find(field => field.name === 'infoLinkNames').arrayDim, 17);
assert.deepEqual(DATALINK_PLAY_CONSTRUCTION.fields.slice(-3).map(field => field.name),
  ['dataLinkQueue', 'DataLinkTrigger', 'EndTransmission']);

const coreBytes = new Uint8Array(await readFile(path.join(root, 'System', 'Core.dll')));
assert.equal(sha256(coreBytes), SCRIPTED_ACTOR_CONSTRUCTION.binaries.core.sha256);
expectBytes(coreBytes, 0x27a20,
  [0x55, 0x8b, 0xec, 0x6a, 0xff, 0x68, 0x30, 0x10, 0x17, 0x10],
  'UClass::Bind body');
expectBytes(coreBytes, 0x27a50,
  [0xe8, 0xb8, 0xa6, 0xfd, 0xff, 0xa1, 0x44, 0x55, 0x1e, 0x10],
  'UClass::Bind calls UField::Bind then reads global gate');
expectBytes(coreBytes, 0x27a84,
  [0x8b, 0x86, 0xe0, 0x04, 0x00, 0x00, 0x85, 0xc0],
  'UClass::Bind ClassConstructor slot');
expectBytes(coreBytes, 0x27a92,
  [0xf7, 0x46, 0x1c, 0x00, 0x00, 0x00, 0x04, 0x0f, 0x84],
  'UClass::Bind native flag gate');
expectBytes(coreBytes, 0x27b53,
  [0x8b, 0x17, 0x8b, 0xcf, 0xff, 0x52, 0x5c, 0x8b, 0x87, 0xe0, 0x04, 0x00, 0x00,
    0x89, 0x86, 0xe0, 0x04, 0x00, 0x00],
  'UClass::Bind recursively binds Super and copies ClassConstructor');
expectBytes(coreBytes, 0x26060,
  [0x55, 0x8b, 0xec, 0x6a, 0xff, 0x68, 0xa7, 0x0f, 0x17, 0x10],
  'UStruct::Link body');
expectBytes(coreBytes, 0x2609d,
  [0x8b, 0x03, 0x89, 0x7b, 0x3c, 0xff, 0x50, 0x68],
  'UStruct::Link resets PropertiesSize and calls GetInheritanceSuper');
expectBytes(coreBytes, 0x260c0,
  [0x8b, 0x10, 0x8b, 0xc8, 0xff, 0x52, 0x64, 0x83, 0xc0, 0x03, 0x24, 0xfc, 0x89, 0x43, 0x3c],
  'UStruct::Link reads/aligns Super PropertiesSize');
expectBytes(coreBytes, 0x26105,
  [0x8b, 0x46, 0x48, 0x0f, 0xaf, 0x4e, 0x34, 0x03, 0xc8, 0x8b, 0xfe, 0x89, 0x4b, 0x3c],
  'UStruct::Link updates running size from Offset and ElementSize*ArrayDim');
expectBytes(coreBytes, 0xf7c0, [0x8b, 0x41, 0x3c, 0xc3], 'GetPropertiesSize body');
expectBytes(coreBytes, 0x27800,
  [0x55, 0x8b, 0xec, 0x6a, 0xff, 0x68, 0x26, 0x10, 0x17, 0x10],
  'UClass::Register body');
expectBytes(coreBytes, 0x27e30,
  [0x55, 0x8b, 0xec, 0x6a, 0xff, 0x68, 0x6d, 0x10, 0x17, 0x10],
  'UClass::Link body');

const engineBytes = new Uint8Array(await readFile(path.join(root, 'System', 'Engine.dll')));
assert.equal(sha256(engineBytes), SCRIPTED_ACTOR_CONSTRUCTION.binaries.engine.sha256);
expectBytes(engineBytes, 0x5ed30,
  [0x56, 0x57, 0x8b, 0x3d, 0xfc, 0x99, 0x59, 0x10, 0x33, 0xc0,
    0x57, 0x68, 0xab, 0x2d, 0x30, 0x10,
    0x68, 0x04, 0x40, 0x08, 0x04],
  'AActor registration constructor and flags');
expectBytes(engineBytes, 0x5ed6b,
  [0x68, 0x00, 0x08, 0x00, 0x00, 0x68, 0x18, 0x03, 0x00, 0x00,
    0x56, 0x89, 0x57, 0x08, 0xb9, 0xf0, 0xcd, 0x57, 0x10],
  'AActor registration size and static class');
expectBytes(engineBytes, 0x23530,
  [0x8b, 0x4c, 0x24, 0x04, 0x85, 0xc9, 0x74, 0x05, 0xe9, 0xf4, 0xfe, 0xfd, 0xff, 0xc3],
  'AActor InternalConstructor thunk');
expectBytes(engineBytes, 0x2356f,
  [0xff, 0x15, 0x58, 0x9b, 0x59, 0x10, 0xc7, 0x44, 0x24, 0x18, 0x00, 0x00, 0x00, 0x00],
  'AActor calls UObject constructor');
expectBytes(engineBytes, 0x2357d,
  [0x8d, 0x77, 0x68, 0xbb, 0x04, 0x00, 0x00, 0x00],
  'AActor FName member constructor loop');
expectBytes(engineBytes, 0x23593,
  [0x8d, 0xb7, 0x6c, 0x02, 0x00, 0x00, 0xbb, 0x04, 0x00, 0x00, 0x00],
  'AActor FPlane member constructor loop');
expectBytes(engineBytes, 0x235b0,
  [0xc7, 0x07, 0xdc, 0x68, 0x42, 0x10, 0x8b, 0xc7],
  'AActor installs its vtable');

const actorRecord = {
  key: 'engine.actor', nativeConstructor: SCRIPTED_ACTOR_CONSTRUCTION.engineActor.internalConstructor,
  nativeVtable: SCRIPTED_ACTOR_CONSTRUCTION.engineActor.vtable,
};
const conRecord = {key: 'deusex.conplaybase', nativeConstructor: null};
const dataLinkRecord = {key: 'deusex.datalinkplay', nativeConstructor: null};
const inherited = resolveInheritedActorConstructor({actor: actorRecord, conPlayBase: conRecord, dataLinkPlay: dataLinkRecord});
assert.equal(inherited.inherited, true);
assert.equal(inherited.constructor, 0x10302dab);
assert.equal(inherited.constructorBody, 0x10323550);
assert.equal(inherited.nativeVtable, 0x104268dc);
assert.throws(() => resolveInheritedActorConstructor({
  actor: {...actorRecord, nativeConstructor: 0x1234}, conPlayBase: conRecord, dataLinkPlay: dataLinkRecord,
}), /ClassConstructor/);
assert.throws(() => resolveInheritedActorConstructor({
  actor: actorRecord, conPlayBase: conRecord, dataLinkPlay: {...dataLinkRecord, key: 'engine.camerapoint'},
}), /deusex\.datalinkplay/);

console.log('Scripted Actor construction contract validated: Core UClass::Bind inheritance, AActor registration/constructor, ' +
  'linked PropertiesSize constants (ConPlayBase 0x3c0, DataLinkPlay 0x5ac), authored defaults, and inherited Actor startup source.');
