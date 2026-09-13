/** Focused original comparison for Core UObject::ResolveName. */

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

import {gameDirectory} from './game-directory.mjs';
import {
  RESOLVE_NAME_NATIVE_CONTRACT,
  ResolveNameBoundaryError,
  resolveNameNative,
} from '../src/runtime/script-resolve-name.mjs';

const root = path.resolve(process.argv[2] ?? gameDirectory());
const python = process.env.DEUS_EX_NATIVE_PYTHON
  ?? process.env.NATIVE_PROBE_PYTHON
  ?? '.cache/native-probe-env/bin/python';
const native = JSON.parse(execFileSync(python, [
  'scripts/native-resolve-name-oracle.py', root,
], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000}));

assert.deepEqual(native.hashes, {
  'Core.dll': '8bf3039e14f849942ee70a95bdf26cf1f636245926e30106bbe58b7097eba7e4',
  'Engine.dll': '0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4',
});
assert.deepEqual(native.addresses, {
  ResolveNameThunk: hex(RESOLVE_NAME_NATIVE_CONTRACT.thunk),
  ResolveNameBody: hex(RESOLVE_NAME_NATIVE_CONTRACT.body),
  CreatePackageThunk: hex(RESOLVE_NAME_NATIVE_CONTRACT.createPackageThunk),
  CreatePackageBody: hex(RESOLVE_NAME_NATIVE_CONTRACT.createPackageBody),
  StaticFindObjectThunk: hex(RESOLVE_NAME_NATIVE_CONTRACT.staticFindObjectThunk),
  StaticFindObjectBody: hex(RESOLVE_NAME_NATIVE_CONTRACT.staticFindObjectBody),
  appStrnicmp: hex(RESOLVE_NAME_NATIVE_CONTRACT.appStrnicmp),
  appStrlen: hex(RESOLVE_NAME_NATIVE_CONTRACT.appStrlen),
  appStrchr: hex(RESOLVE_NAME_NATIVE_CONTRACT.appStrchr),
  appStrcpy: hex(RESOLVE_NAME_NATIVE_CONTRACT.appStrcpy),
  FNameText: hex(RESOLVE_NAME_NATIVE_CONTRACT.fNameText),
});

const packageObject = {label: 'DeusExConText'};
const packageClass = {label: 'Core.Package'};
const objectClass = {label: 'Core.Object'};
const trace = [];

const services = {
  trace,
  copyString: ({source, maxLength}) => {
    assert.equal(maxLength, RESOLVE_NAME_NATIVE_CONTRACT.maxNameLength);
    return source;
  },
  createPackage: ({outer, name}) => {
    assert.equal(name, 'DeusExConText');
    assert.equal(outer, null);

    // CreatePackage's first native call is ResolveName(&Outer,&Name,1,0).
    const nestedOuter = cell(outer);
    const nestedName = cell(name);
    resolveNameNative(nestedOuter, nestedName, {
      create: 1,
      throwOnConfigMissing: 0,
      services,
    });
    assert.equal(nestedOuter.get(), null);
    assert.equal(nestedName.get(), name);

    // Its existing-package branch then invokes StaticFindObject(Core.Package,
    // NULL, name, 0).  The callback below models that native lookup boundary;
    // its FName find-only operation is included in the same comparison trace.
    return services.staticFindObject({
      classRef: packageClass,
      outer: nestedOuter.get(),
      name: nestedName.get(),
      exactClass: 0,
    });
  },
  staticFindObject: ({classRef, outer, name, exactClass}) => {
    assert.equal(classRef, packageClass);
    assert.equal(outer, null);
    assert.equal(name, 'DeusExConText');
    assert.equal(exactClass, 0);

    trace.push({op: 'StaticFindObjectEnter', classRef: 'Core.Package', outer,
      name, exactClass});

    // StaticFindObject resolves its simple name first, then constructs
    // FName(Name, EFindName=0).  The actual object/hash lookup is represented
    // by this canonical fixture identity; no display-name scan is used.
    const nestedOuter = cell(outer);
    const nestedName = cell(name);
    resolveNameNative(nestedOuter, nestedName, {
      create: 0,
      throwOnConfigMissing: 0,
      services,
    });
    assert.equal(nestedOuter.get(), null);
    assert.equal(nestedName.get(), name);
    trace.push({op: 'FName', text: name, findMode: 0, nameIndex: 0x500});
    return packageObject;
  },
  // The object branch is not reached by this Create=1 case, but its class
  // identities are explicit so callers can reuse the same adapter for a
  // future Create=0 contract without an implicit fallback.
  corePackageClass: packageClass,
  coreObjectClass: objectClass,
};

const outerRef = cell(null);
const nameRef = cell('DeusExConText.ConList_Mission00');
const result = resolveNameNative(outerRef, nameRef, {
  create: 1,
  throwOnConfigMissing: 1,
  services,
});

assert.equal(result, true);
assert.equal(outerRef.get(), packageObject);
assert.equal(nameRef.get(), 'ConList_Mission00');
assert.equal(native.case.result, 1);
assert.equal(native.case.outer, 'DeusExConText');
assert.equal(native.case.name, 'ConList_Mission00');
assert.equal(native.case.namePointerOffset, 28);

function normalize(event) {
  if (event.op === 'StaticFindObjectEnter' && typeof event.classRef === 'string' &&
      event.classRef.startsWith('0x')) {
    return {...event, classRef: 'Core.Package'};
  }
  return event;
}

assert.deepEqual(trace.map(normalize), native.case.events.map(normalize),
  'ordinary ResolveName nested call order and mutations');

// The task intentionally leaves config/localization unbound.  This checks the
// boundary is explicit rather than allowing a guessed config value through.
assert.throws(() => resolveNameNative(cell(null), cell('ini:System.Key'), {
  create: 1,
  throwOnConfigMissing: 1,
  services,
}), error => error instanceof ResolveNameBoundaryError && error.code === 'RESOLVE_NAME_CONFIG');

// Host boundaries for this bounded ordinary adapter are explicit.  These
// cases do not claim additional native behavior; they ensure an untraced
// locale, scratch overflow, or quoted syntax cannot be accepted accidentally.
assert.throws(() => resolveNameNative(cell(null), cell('Deus\u00e9ConText.Item'), {
  create: 1,
  services,
}), error => error instanceof ResolveNameBoundaryError && error.code === 'RESOLVE_NAME_ASCII');
assert.throws(() => resolveNameNative(cell(null), cell(`${'A'.repeat(1024)}.Item`), {
  create: 1,
  services,
}), error => error instanceof ResolveNameBoundaryError && error.code === 'RESOLVE_NAME_LENGTH');
for (const quote of ['"', "'"]) {
  assert.throws(() => resolveNameNative(cell(null), cell(`DeusExConText${quote}.Item`), {
    create: 1,
    services,
  }), error => error instanceof ResolveNameBoundaryError && error.code === 'RESOLVE_NAME_QUOTED');
}

console.log(JSON.stringify({
  case: {
    result,
    outer: outerRef.get().label,
    name: nameRef.get(),
    namePointerOffset: native.case.namePointerOffset,
  },
  events: trace.length,
  native: native.addresses,
  boundaryGuards: ['ASCII', 'LENGTH', 'QUOTED'],
  unsupported: native.unsupported,
}, null, 2));

function cell(value) {
  return {
    get: () => value,
    set: next => { value = next; },
  };
}

function hex(value) {
  return `0x${value.toString(16)}`;
}
