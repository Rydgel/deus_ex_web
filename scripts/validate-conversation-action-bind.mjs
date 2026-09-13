/** Validate shared ConEventAnimation/ConEventTrade BindActor against the
 * unchanged original ConSys body and installed class TextBuffers. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {access, readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readClass} from '../src/unreal/classes.mjs';
import {readObject} from '../src/unreal/objects.mjs';
import {readFieldLinks, readPropertyMetadata} from '../src/unreal/script-metadata.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {CONVERSATION_BASE_BIND} from '../src/runtime/script-conversation-base-bind.mjs';
import {
  CONVERSATION_ACTION_BIND,
  asciiCaseEqual,
  bindConversationAction,
} from '../src/runtime/script-conversation-action-bind.mjs';
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
  const reader = readObject(conSys.pkg, conSys.bytes, metadata.scriptText).reader;
  reader.u32();
  reader.u32();
  return reader.string(conSys.pkg.version);
}

function property(index, expectedPath) {
  const entry = conSys.pkg.exports[index - 1];
  assert.equal(entry?.path, expectedPath);
  assert.equal(entry?.className, expectedPath.endsWith('Name') ? 'StrProperty' : 'ObjectProperty');
  return readPropertyMetadata(conSys, index);
}

const animationSource = sourceFor(362);
const tradeSource = sourceFor(373);
assert.match(animationSource, /class\s+ConEventAnimation\s+extends\s+ConEvent[\s\S]*?native[\s\S]*?noexport/i);
assert.match(animationSource, /var\s+Actor\s+eventOwner\s*;/i);
assert.match(animationSource, /var\s+String\s+eventOwnerName\s*;/i);
assert.match(tradeSource, /class\s+ConEventTrade\s+extends\s+ConEvent[\s\S]*?native[\s\S]*?noexport/i);
assert.match(tradeSource, /var\s+Actor\s+eventOwner\s*;/i);
assert.match(tradeSource, /var\s+String\s+eventOwnerName\s*;/i);
assert.equal(readClass(conSys, 362).classFlags, 0x112);
assert.equal(readClass(conSys, 373).classFlags, 0x112);
assert.equal(property(276, 'ConEventAnimation.eventOwner').type, 'object');
assert.equal(property(277, 'ConEventAnimation.eventOwnerName').type, 'string');
assert.equal(property(227, 'ConEventTrade.eventOwner').type, 'object');
assert.equal(property(228, 'ConEventTrade.eventOwnerName').type, 'string');

const dllPath = path.join(root, 'System', 'ConSys.dll');
const dll = new Uint8Array(await readFile(dllPath));
assert.equal(createHash('sha256').update(dll).digest('hex'),
  'f20c4d8904d17057318999c18673d82e2ccc3f7c1041eb3c0327eb731b3a8efa');

function bytesAt(offset, length) { return [...dll.subarray(offset, offset + length)]; }
function expectBytes(offset, expected, label) {
  assert.deepEqual(bytesAt(offset, expected.length), expected, label);
}

// RVA and file offsets coincide for this .text section in the installed PE.
expectBytes(0x71b0, [
  0x53, 0x8b, 0x5c, 0x24, 0x0c, 0x56, 0x8b, 0xf1, 0x57,
  0x8b, 0x46, 0x48, 0x85, 0xc0, 0x74, 0x05, 0x8b, 0x4e, 0x44,
  0xeb, 0x05, 0xb9, 0xcc, 0xe1, 0x01, 0x10,
], 'shared action-bind prologue and bark-name fallback');
expectBytes(0x71e1, [
  0x8b, 0x3d, 0xd0, 0x30, 0x01, 0x10, 0x51, 0x50, 0xff, 0xd7,
  0x83, 0xc4, 0x08, 0x85, 0xc0, 0x75, 0x0f,
], 'action-bind appStricmp call and bark branch');
expectBytes(0x71f2, [
  0x8b, 0x44, 0x24, 0x18, 0x8b, 0x48, 0x50, 0x83, 0xe1, 0x04,
  0x80, 0xf9, 0x04, 0x74, 0x33,
], 'Conversation native bit-four gate');
expectBytes(0x7201, [
  0x8b, 0x46, 0x48, 0x85, 0xc0, 0x74, 0x05, 0x8b, 0x4e, 0x44,
  0xeb, 0x05, 0xb9, 0xcc, 0xe1, 0x01, 0x10,
  0x8b, 0x83, 0xb0, 0x02, 0x00, 0x00, 0x85, 0xc0, 0x74, 0x08,
  0x8b, 0x83, 0xac, 0x02, 0x00, 0x00,
], 'normal BindName reread and zero-length fallback');
expectBytes(0x7234, [
  0x89, 0x5e, 0x40, 0x5f, 0x5e, 0xb0, 0x01, 0x5b, 0xc2, 0x0c, 0x00,
], 'eventOwner write and true return');

const python = process.env.NATIVE_PROBE_PYTHON || path.resolve('.cache/native-probe-env/bin/python');
await access(python);
const native = JSON.parse(execFileSync(python, [
  path.resolve('scripts/native-conversation-action-bind-oracle.py'), root,
], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024}));
assert.deepEqual(native.emptyLiteralBytes, [0, 0, 0, 0, 0, 0, 0, 0],
  'mapped 0x1001e1cc is empty zero-filled TCHAR storage');
assert.equal(native.addresses.emptyLiteral, 0x1001e1cc);
assert.equal(native.addresses.compareIat, 0x100130d0);
assert.equal(native.addresses.body, CONVERSATION_ACTION_BIND.nativeBody);

// Link layout from the actual Children order, not guessed C++ field labels.
const prefix = [];
for (let index = readClass(conSys, 30).children; index && prefix.length < 7;
    index = readFieldLinks(conSys, index).nextRef) {
  const entry = conSys.pkg.exports[index - 1];
  if (!entry.className.endsWith('Property')) continue;
  const metadata = readPropertyMetadata(conSys, index);
  assert.equal(metadata.arrayDim, 1);
  prefix.push([index, entry.path, entry.className]);
}
assert.deepEqual(prefix, [
  [123, 'Conversation.conName', 'NameProperty'],
  [347, 'Conversation.Description', 'StrProperty'],
  [334, 'Conversation.CreatedBy', 'StrProperty'],
  [330, 'Conversation.conOwnerName', 'StrProperty'],
  [311, 'Conversation.bDataLinkCon', 'BoolProperty'],
  [310, 'Conversation.bDisplayOnce', 'BoolProperty'],
  [309, 'Conversation.bFirstPerson', 'BoolProperty'],
]);
assert.deepEqual(native.conversationPrefixLayout, [
  ['conName', 0x28, 4, null], ['Description', 0x2c, 12, null],
  ['CreatedBy', 0x38, 12, null], ['conOwnerName', 0x44, 12, null],
  ['bDataLinkCon', 0x50, 4, 1], ['bDisplayOnce', 0x50, 4, 2],
  ['bFirstPerson', 0x50, 4, 4],
].map(([name, offset, elementSize, bitMask]) => ({name, offset, elementSize, bitMask})));

const expected = {
  ordinary: {
    result: true, owner: 'candidate',
    comparisons: [
      {left: 'normal', right: 'Normal', equal: true},
      {left: 'normal', right: 'Normal', equal: true},
    ],
    writes: [{offset: 0x40, value: 'candidate', size: 4}],
  },
  bark: {
    result: true, owner: 'candidate',
    comparisons: [{left: 'barkalias', right: 'BarkAlias', equal: true}],
    writes: [{offset: 0x40, value: 'candidate', size: 4}],
  },
  miss: {
    result: false, owner: 'seed',
    comparisons: [
      {left: 'Bark', right: '', equal: false},
      {left: 'Normal', right: '', equal: false},
    ],
    writes: [],
  },
};

function translated(caseName) {
  const spec = {
    ordinary: {eventOwnerName: 'Normal', BarkBindName: 'normal', BindName: 'normal', bFirstPerson: false},
    bark: {eventOwnerName: 'BarkAlias', BarkBindName: 'barkalias', BindName: 'Other', bFirstPerson: true},
    miss: {eventOwnerName: '', BarkBindName: 'Bark', BindName: 'Normal', bFirstPerson: false},
  }[caseName];
  const candidate = {BindName: spec.BindName, BarkBindName: spec.BarkBindName};
  const event = {eventOwnerName: spec.eventOwnerName, eventOwner: 'seed'};
  const conversation = {bFirstPerson: spec.bFirstPerson};
  const reads = [];
  const comparisons = [];
  const writes = [];
  const read = (object, field) => {
    reads.push(field);
    return object[field];
  };
  const equalText = (left, right, details) => {
    comparisons.push({left, right, gate: details.gate});
    return asciiCaseEqual(left, right);
  };
  const result = bindConversationAction({event, firstActor: {ignored: true}, secondActor: candidate,
    conversation, read, write: (object, field, value) => {
      writes.push({field, value});
      object[field] = value;
    }, equalText});
  return {result, event, candidate, reads, comparisons, writes};
}

for (const className of ['animation', 'trade']) {
  const classNative = native.classes[className];
  assert.equal(classNative.vtable, CONVERSATION_ACTION_BIND.vtables[className]);
  assert.equal(classNative.slot, CONVERSATION_ACTION_BIND.nativeBody,
    `${className} vtable +0x58 selects shared body`);
  for (const caseName of Object.keys(expected)) {
    const nativeCase = classNative.cases[caseName];
    const js = translated(caseName);
    const exp = expected[caseName];
    assert.equal(nativeCase.result, exp.result, `${className}/${caseName} native result`);
    assert.equal(nativeCase.owner, exp.owner, `${className}/${caseName} native owner`);
    assert.deepEqual(nativeCase.comparisons, exp.comparisons,
      `${className}/${caseName} native comparison order`);
    assert.deepEqual(nativeCase.writes, exp.writes,
      `${className}/${caseName} native eventOwner writes`);
    assert.equal(js.result, exp.result, `${className}/${caseName} translated result`);
    assert.equal(js.event.eventOwner, exp.owner === 'candidate' ? js.candidate : 'seed');
    assert.deepEqual(js.comparisons.map(({left, right}) => ({left, right, equal: asciiCaseEqual(left, right)})),
      exp.comparisons, `${className}/${caseName} translated comparison order`);
    assert.deepEqual(js.writes.map(({field, value}) => ({offset: field === 'eventOwner' ? 0x40 : -1,
      value: value === js.candidate ? 'candidate' : value, size: 4})), exp.writes,
    `${className}/${caseName} translated eventOwner writes`);
    assert.deepEqual(js.reads, caseName === 'bark'
      ? ['eventOwnerName', 'BarkBindName', 'bFirstPerson']
      : caseName === 'ordinary'
        ? ['eventOwnerName', 'BarkBindName', 'bFirstPerson', 'eventOwnerName', 'BindName']
        : ['eventOwnerName', 'BarkBindName', 'eventOwnerName', 'BindName'],
      `${className}/${caseName} typed read order`);
  }
}

// Execute original BindActorEvents2053 through shared runtime dispatch and
// actual loaded class fields. These are initialized logical fixtures; no
// native construction or complete conversation playback is claimed.
const runtime = new ScriptRuntime(assets);
const engine = await assets.get('Engine');
const conClass = await runtime.loadClass(conSys, 30);
const actorClass = await runtime.loadClass(engine, engine.exportsByPath.get('actor'));
const con = {}, actor = {};
runtime.attach(con, conClass); runtime.attach(actor, actorClass);
const field = (object, name) => runtime.namedReference(object, name);
const invoke = await runtime.prepareFunction(conSys, conSys.exportsByPath.get('conversation.bindactorevents'));
for (const classIndex of [362, 373]) {
  const event = {};
  runtime.attach(event, await runtime.loadClass(conSys, classIndex));
  field(con, 'eventList').set(event);
  field(event, 'eventOwnerName').set('BarkAlias');
  field(actor, 'BarkBindName').set('barkalias');
  field(actor, 'BindName').set('Other');
  field(con, 'bFirstPerson').set(false);
  runtime.callFunction(invoke, con, 1, () => actor);
  assert.equal(field(event, 'eventOwner').get(), null, 'ordinary conversation rejects bark-only match');
  field(con, 'bFirstPerson').set(true);
  runtime.callFunction(invoke, con, 1, () => actor);
  assert.equal(field(event, 'eventOwner').get(), actor, 'typed first-person flag enables original bark binding');
}
// Exercise the new class-dispatch boundary through the same original event
// walker. Distinct no-op classes must remain linked and leave their fields intact.
for (const entry of CONVERSATION_BASE_BIND.inheritedClasses) {
  const event = {};
  runtime.attach(event, await runtime.loadClass(conSys, entry.classExport));
  field(con, 'eventList').set(event);
  field(event, 'NextEvent').set(null);
  runtime.callFunction(invoke, con, 1, () => actor);
  assert.equal(field(con, 'eventList').get(), event, `${entry.key} preserves the event list`);
  assert.equal(field(event, 'NextEvent').get(), null, `${entry.key} preserves the next event`);
}

console.log('Original ConSys shared ConEventAnimation/ConEventTrade BindActor passed: ' +
  'both +0x58 vtables, bark bit-four gate, normal fallback, zero-filled empty TCHAR, and owner writes.');
console.log('Core property Link identifies bFirstPerson at +0x50 mask4; original 2053 uses both typed event classes.');
console.log('Original 2053 dispatch also reaches all thirteen verified inherited BindActor classes.');
console.log('Unsupported boundaries remain explicit: animation/trade action execution and event construction.');
