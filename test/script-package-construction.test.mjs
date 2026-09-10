import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCRIPT_PACKAGE_CONSTRUCTION,
  constructScriptPackage,
  createScriptPackage,
} from '../src/runtime/script-package-construction.mjs';

test('CreatePackage preserves native lookup/allocation/constructor order and live vtable slot', () => {
  const packageClass = {name: 'Core.Package'};
  const originalOuter = {index: 3, name: 'Root'};
  const resolvedOuter = {index: 7, name: 'Core'};
  const calls = [];
  const fName = {index: 14, name: 'Core', entry: {index: 14}};
  const packageObject = {index: -1, nativeSlots: new Map([[0, {value: 0xfeed, width: 4}]])};
  const lookup = {
    resolveName: (outerRef, nameRef, options) => {
      calls.push(['resolveName', options]);
      assert.equal(outerRef.get(), originalOuter);
      assert.equal(nameRef.get(), 'Core.More');
      outerRef.set(resolvedOuter);
      nameRef.set('More');
      return false; // Native CreatePackage ignores this result.
    },
    staticFindObject: args => {
      calls.push(['staticFindObject', args]);
      assert.equal(args.classRef, packageClass);
      assert.equal(args.outer, resolvedOuter);
      assert.equal(args.name, 'More');
      assert.equal(args.exactClass, 0);
      return null;
    },
  };
  const result = createScriptPackage({
    outer: originalOuter,
    name: 'Core.More',
    packageClass,
    lookup,
    internName: (name, findName) => {
      calls.push(['internName', name, findName]);
      assert.equal(name, 'More');
      assert.equal(findName, SCRIPT_PACKAGE_CONSTRUCTION.findName);
      return fName;
    },
    errorDevice: {name: 'GWarn'},
    staticAllocateObject: args => {
      calls.push(['staticAllocateObject', args]);
      assert.equal(args.address, SCRIPT_PACKAGE_CONSTRUCTION.staticAllocateObject);
      assert.equal(args.classRef, packageClass);
      assert.equal(args.outer, resolvedOuter);
      assert.equal(args.name, fName);
      assert.equal(args.nameIndex, fName.index);
      assert.equal(args.size, 0x34);
      assert.equal(args.flags, 4);
      assert.equal(args.subobjectRoot, null);
      return packageObject;
    },
    bindPackage: (object, detail) => {
      calls.push(['bindPackage', object, detail]);
      assert.equal(object, packageObject);
      assert.equal(detail.address, SCRIPT_PACKAGE_CONSTRUCTION.bindPackage);
    },
  });

  assert.equal(result, packageObject);
  assert.equal(packageObject.nativeVtable, SCRIPT_PACKAGE_CONSTRUCTION.packageVtable);
  assert.equal(packageObject.nativeSlots.get(0).value, SCRIPT_PACKAGE_CONSTRUCTION.packageVtable);
  assert.deepEqual(calls.map(([kind]) => kind), [
    'resolveName', 'staticFindObject', 'internName', 'staticAllocateObject', 'bindPackage',
  ]);

  const existing = {name: 'AlreadyThere'};
  const hit = createScriptPackage({
    outer: null, name: 'AlreadyThere', packageClass, lookup: {
      resolveName: () => calls.push(['resolve-hit']),
      staticFindObject: () => existing,
    },
  });
  assert.equal(hit, existing);
  assert.throws(() => constructScriptPackage({}), /BindPackage/);
});
