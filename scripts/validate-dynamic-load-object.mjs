import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';

import { AssetStore } from '../src/unreal/assets.mjs';
import { readFunctionMetadata } from '../src/unreal/script-metadata.mjs';
import {
  DYNAMIC_LOAD_OBJECT_NATIVE,
  execDynamicLoadObject,
} from '../src/runtime/script-dynamic-load-object.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const python = process.env.DEUS_EX_NATIVE_PYTHON ?? '.cache/native-probe-env/bin/python';
const native = JSON.parse(execFileSync(python, [
  'scripts/native-dynamic-load-object-oracle.py', root,
], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));

assert.deepEqual(native.hashes, {
  'Core.dll': '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
  'Engine.dll': '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
});
assert.deepEqual(native.addresses, {
  execDynamicLoadObjectThunk: '0x10103201',
  execDynamicLoadObject: '0x1013eb30',
  StaticLoadObject: '0x10102a1d',
  FArrayRealloc: '0x10145440',
  GMalloc: '0x101a7c44',
  execNothing: '0x1012f660',
});
assert.deepEqual(native.tokens, {
  EndFunctionParms: '0x16',
  Nothing: '0xb',
  fixtureName: '0xe0',
  fixtureClass: '0xe1',
  fixtureMayFail: '0xe2',
});

// The package declaration and native index are independent evidence for the
// body address and optional parameter shape exercised by the DLL probe.
const files = (await readdir(`${root}/System`)).map(name => ({
  path: `System/${name}`,
  read: () => readFile(`${root}/System/${name}`),
}));
const core = await new AssetStore(files).get('Core');
const dynamicLoadIndex = core.exportsByPath.get('object.dynamicloadobject');
const metadata = readFunctionMetadata(core, dynamicLoadIndex);
assert.equal(dynamicLoadIndex, 627);
assert.equal(metadata.nativeIndex, 0);
assert.equal(metadata.functionFlags, 0x2401);
assert.equal(metadata.entry.serialSize, 33);
assert.equal(metadata.scriptSize, 15);
assert.deepEqual(metadata.parameters.map(parameter => ({
  name: parameter.name,
  type: parameter.type,
  optional: parameter.optional,
})), [
  { name: 'ObjectName', type: 'string', optional: false },
  { name: 'ObjectClass', type: 'class', optional: false },
  { name: 'MayFail', type: 'bool', optional: true },
  { name: 'ReturnValue', type: 'object', optional: false },
]);

assert.deepEqual({
  thunk: DYNAMIC_LOAD_OBJECT_NATIVE.thunk,
  body: DYNAMIC_LOAD_OBJECT_NATIVE.body,
  staticLoadThunk: DYNAMIC_LOAD_OBJECT_NATIVE.staticLoadThunk,
  baseLoadFlags: DYNAMIC_LOAD_OBJECT_NATIVE.baseLoadFlags,
  mayFailLoadFlag: DYNAMIC_LOAD_OBJECT_NATIVE.mayFailLoadFlag,
}, {
  thunk: 0x10103201,
  body: 0x1013eb30,
  staticLoadThunk: 0x10102a1d,
  baseLoadFlags: 2,
  mayFailLoadFlag: 0x2000,
});

const cases = native.cases;
assert.equal(cases.length, 6);
for (const current of cases) {
  const events = current.events;
  const expressionEvents = events.slice(0, 3).map(event => event.op);
  assert.deepEqual(expressionEvents,
    current.mayFailInput === null
      ? ['EvalName', 'EvalClass', 'EvalNothing']
      : ['EvalName', 'EvalClass', 'EvalMayFail'],
    'native evaluates arguments in declaration order');

  const staticEvent = events[3];
  assert.equal(staticEvent.op, 'StaticLoadObject');
  assert.equal(staticEvent.outer, 0);
  assert.equal(staticEvent.filename, 0);
  assert.equal(staticEvent.sandbox, 0);
  assert.equal(staticEvent.name, current.input);
  assert.equal(staticEvent.namePointer,
    current.input ? current.temporaryData : 0x101ef654,
    'native uses the allocated FString data or Core static empty string');
  assert.equal(staticEvent.class, events[1].pointer);
  assert.equal(staticEvent.flags, current.mayFailInput ? 0x2002 : 2,
    'MayFail controls only the recovered 0x2000 load flag');

  assert.equal(events[4].op, 'GMalloc.Realloc');
  assert.equal(events[4].size, 0);
  assert.equal(events[4].tag, 0x101ab50c);
  assert.equal(events[4].old, current.temporaryData,
    'FArray::Realloc receives the temporary FString data pointer');
  if (current.input) {
    assert.equal(events[5].op, 'GMalloc.Free');
    assert.equal(events[5].pointer, current.temporaryData,
      'temporary FString data is freed after the original Realloc body');
    assert.equal(events.length, 6);
  } else {
    assert.equal(events.length, 5);
  }
  assert.equal(current.codeAdvance, 4,
    'wrapper advances three expression bytes and EndFunctionParms');

  // Run the current browser adapter with the same logical inputs and compare
  // every observable edge at the recovered StaticLoadObject boundary. The
  // native EX_Nothing slot is represented by omission from the logical call;
  // both paths still produce the same default false flag.
  const classRef = { kind: 'Class', key: 'fixture.objectclass' };
  const loaded = current.result === 0 ? null : { key: 'fixture.loaded' };
  const args = [current.input, classRef];
  if (current.mayFailInput !== null) args.push(current.mayFailInput);
  const logicalEvents = [];
  const actual = execDynamicLoadObject({
    argumentCount: args.length,
    evaluateArgument: index => {
      logicalEvents.push({ op: 'EvalArgument', index });
      return args[index];
    },
  }, {
    staticLoadObject: request => {
      logicalEvents.push({ op: 'StaticLoadObject', request });
      return { object: loaded };
    },
    destroyString: value => logicalEvents.push({ op: 'DestroyString', value }),
  });
  assert.strictEqual(actual, loaded);
  assert.deepEqual(logicalEvents.map(event => event.op), [
    'EvalArgument', 'EvalArgument', ...(current.mayFailInput === null ? [] : ['EvalArgument']),
    'StaticLoadObject', 'DestroyString',
  ], 'logical adapter preserves evaluation and cleanup order');
  const logicalStatic = logicalEvents.find(event => event.op === 'StaticLoadObject');
  assert.deepEqual(logicalStatic.request, {
    classRef,
    outer: null,
    name: current.input,
    filename: null,
    flags: staticEvent.flags,
    sandbox: null,
  }, 'logical adapter matches the native StaticLoadObject request');
  assert.deepEqual(logicalEvents.at(-1), {
    op: 'DestroyString', value: current.input,
  });
}

const successful = cases.slice(0, 5);
assert.ok(successful.every(current => current.result === 536871008),
  'StaticLoadObject return pointer is copied to the native Result slot');
assert.equal(cases.at(-1).result, 0,
  'a null StaticLoadObject return is copied as null');
assert.equal(cases.at(-1).events[3].flags, 0x2002);

console.log(`Original Core execDynamicLoadObject passed ${cases.length} native FFrame/load/cleanup cases.`);
