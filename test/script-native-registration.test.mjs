import test from 'node:test';
import assert from 'node:assert/strict';
import {ScriptObjectRegistry} from '../src/runtime/script-object-construction.mjs';
import {createScriptNames} from '../src/runtime/script-names.mjs';
import {createScriptObjectLookup} from '../src/runtime/script-object-lookup.mjs';
import {createScriptPackageFactory} from '../src/runtime/script-package-construction.mjs';
import {createScriptNativeRegistration, NATIVE_REGISTRATION, CORE_CLASS_CONSTRUCTORS} from '../src/runtime/script-native-registration.mjs';
import {constructNativeScriptClass} from '../src/runtime/script-native-class-construction.mjs';
import {registerScriptClass} from '../src/runtime/script-class-registration.mjs';
import {loadConfig} from '../src/runtime/script-config.mjs';

function fixture({objectGate = 0} = {}) {
  const none={index:0,flags:0,hashNext:null,text:'None'};
  const names=createScriptNames({names:[none],buckets:Array(0x1000).fill(null),allocator:{free:()=>{}}});
  names.buckets[names.hashBucket('None')]=none;
  const registry=new ScriptObjectRegistry();
  const globals={
    [NATIVE_REGISTRATION.objectGate]:objectGate,
    [NATIVE_REGISTRATION.registrationGate]:1,
    [NATIVE_REGISTRATION.registrationDepth]:0,
    [NATIVE_REGISTRATION.registrationHead]:null,
  };
  return {names,registry,globals};
}

test('native UObject construction queues in LIFO order and registers package/name/find/array/hash in order',()=>{
  const {names,registry,globals}=fixture(), coreObjectClass={superClass:null}, events=[], nested=[];
  const corePackageClass={superClass:coreObjectClass};
  const lookup=createScriptObjectLookup({names,registry,coreObjectClass,corePackageClass});
  const packages=createScriptPackageFactory({lookup,packageClass:corePackageClass});
  let adapter;
  const packageObject={index:-1,name:'Core',nameIndex:names.intern('Core').index,
    outer:null,objectClass:corePackageClass};
  registry.add(packageObject);
  adapter=createScriptNativeRegistration({
    registry,names,globals,coreObjectClass,
    createPackage:({outer,name,object})=>{
      assert.equal(outer,null);assert.equal(name,'Core');assert.equal(object.index,-1);
      return packages({outer,name});
    },
    staticFindObject:({classRef,outer,name,exactClass})=>{
      assert.equal(classRef,null);assert.equal(outer,packageObject);assert.equal(exactClass,0);
      return lookup.staticFindObject({classRef,outer,name,exactClass});
    },
    virtualRegister:(object)=>{
      events.push(`virtual:${object.name}`);
      if (object.name === 'Second') nested.push(adapter.processRegistrants());
      adapter.registerUObject(object);
    },
    onStep:({step})=>events.push(step),
  });
  const cls={name:'Core.Class'};
  const first=adapter.constructUObject({}, {objectClass:cls,nameText:'First',outerText:'Core',flags:1,
    nativeInstanceConstructor:CORE_CLASS_CONSTRUCTORS.instance,staticConstructor:CORE_CLASS_CONSTRUCTORS.static});
  const second=adapter.constructUObject({}, {objectClass:cls,nameText:'Second',outerText:'Core',flags:2});
  assert.equal(first.index,-1);assert.equal(first.flags,0x04000001);
  assert.equal(globals[NATIVE_REGISTRATION.registrationHead],second);

  const processed=adapter.processRegistrants();
  assert.deepEqual(processed,[second,first]);
  assert.deepEqual(nested,[[]]);
  assert.deepEqual(events,[
    'virtual:Second','createPackage','internName','staticFindObject','addObject','hashObject',
    'virtual:First','createPackage','internName','staticFindObject','addObject','hashObject',
  ]);
  assert.equal(registry.objects[0],packageObject);
  assert.equal(registry.objects[1],second);assert.equal(registry.objects[2],first);
  assert.equal(second.outer,packageObject);assert.equal(second.nameIndex,names.find('Second'));
  assert.equal(first.nativeInstanceConstructor,CORE_CLASS_CONSTRUCTORS.instance);
  assert.equal(first.staticConstructor,CORE_CLASS_CONSTRUCTORS.static);
  assert.equal(adapter.registrationDepth,0);assert.equal(adapter.queueHead,null);

  const beforeRepeat=events.length;
  assert.equal(adapter.conditionalRegister(second),undefined);
  assert.equal(events.length,beforeRepeat);

  const bad=fixture({objectGate:1});
  const strict=createScriptNativeRegistration({
    ...bad,coreObjectClass,
    createPackage:()=>packageObject,staticFindObject:()=>null,virtualRegister:()=>{},
  });
  assert.throws(()=>strict.constructUObject({}, {objectClass:cls,nameText:'Bad',outerText:'Core'}),/102a2648/);
  assert.equal(bad.globals[NATIVE_REGISTRATION.registrationHead],null);
});

test('original Core.Object registration composes the native constructor, name lookup, defaults and all three Link layers', () => {
  const {names, registry, globals} = fixture();
  const coreClass = {nativeAddress: 0x101f1c18};
  const coreObject = {nativeAddress: 0x1029e0d0, nativeSlots: new Map()};
  const corePackageClass = {nativeAddress: 0x1029b8e0, superClass: coreObject};
  const packageObject = {index: -1, name: 'Core', nameIndex: names.intern('Core').index,
    outer: null, objectClass: corePackageClass};
  registry.add(packageObject);
  const lookup = createScriptObjectLookup({names, registry, coreObjectClass: coreObject, corePackageClass});
  const packages = createScriptPackageFactory({lookup, packageClass: corePackageClass});
  // Allocated native UClass hash storage is uninitialized until UState::Link.
  for (let offset = 0x84; offset < 0x484; offset += 4)
    coreObject.nativeSlots.set(offset, {value: undefined, width: 4});
  let registration, registered;
  registration = createScriptNativeRegistration({
    names, registry, globals, coreObjectClass: coreObject,
    createPackage: packages,
    staticFindObject: lookup.staticFindObject,
    virtualRegister(object) {
      registered = registerScriptClass(object, {
        registration,
        classLink: {globalLinkGate: 0},
        loadConfig(data, propagate, cls, filename, {classRecord}) {
          assert.strictEqual(data, classRecord.defaultBuffer.data);
          // Original Core.Object flags 0x13 return at LoadConfig's 0x4 gate.
          // Only that reached graph slot is bound; GConfig must not be touched.
          const graph = {slotOf(record, offset) {
            assert.strictEqual(record, classRecord);
            assert.equal(offset, 0x484);
            return record.classFlags;
          }};
          return loadConfig(graph, null, {cls: classRecord}, {
            propagate, cls: cls || null, filename: filename || null,
          });
        },
        writeDefaultHeader(data, header) {
          const memory = new DataView(data.buffer, data.byteOffset, data.byteLength);
          memory.setUint32(0, header.vtable, true);
          memory.setInt32(4, header.index, true);
          memory.setUint32(0x24, header.class.nativeAddress, true);
        },
      });
    },
  });
  // Inputs from the original Core.Object static class constructor.
  constructNativeScriptClass(coreObject, {
    registration, coreClass, instanceSize: 0x28, classFlags: 1,
    superClass: coreObject, withinClass: coreObject, guid: [0, 0, 0, 0],
    nameText: 'Object', packageText: 'Core', configText: 'System',
    objectFlags: 0x04084004, instanceConstructor: 0x101017da, staticConstructor: 0x10101041,
  });
  assert.equal(coreObject.nativeSlots.get(0x84).value, undefined);
  assert.deepEqual(registration.processRegistrants(), [coreObject]);
  assert.equal(lookup.findObject(packageObject, 'Object'), coreObject);
  assert.equal(coreObject.nameIndex, names.find('Object'));
  assert.equal(coreObject.nativeSlots.get(0x40).value, coreObject.nameIndex);
  assert.equal(coreObject.classConfigName.index, names.find('System'));
  assert.equal(coreObject.defaultBuffer.size, 0x28);
  assert.equal(coreObject.classFlags, 0x13);
  const defaults = new DataView(coreObject.defaultBuffer.data.buffer);
  assert.equal(defaults.getUint32(0, true), 0x101758f4);
  assert.equal(defaults.getInt32(4, true), -1);
  assert.equal(defaults.getUint32(0x24, true), 0x1029e0d0);
  for (let offset = 0x84; offset < 0x484; offset += 4)
    assert.equal(coreObject.nativeSlots.get(offset).value, 0);
  for (const head of [0x58, 0x5c, 0x60, 0x64, 0x68])
    assert.equal(coreObject.nativeSlots.get(head).value, null);
  assert.equal(registered.operations.at(-1).operation, 'load-localized');
});
