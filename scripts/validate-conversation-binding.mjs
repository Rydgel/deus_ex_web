/** Focused validation of DeusEx conversation binding (ConBindEvents) against the
 * original 00_Training data. Verifies the conOwnerName<->BindName rule: the two
 * UNATCO training instructors bind their MunitionsTrooper conversations, while
 * decorations (the LightSwitch and friends) bind nothing. Evidence and model:
 * docs/script-conversation-binding.md. Requires the local game install. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { readObject } from '../src/unreal/objects.mjs';
import { loadMissionConversations, matchConversations } from '../src/runtime/script-conversation-binding.mjs';
import {
  STATIC_LOAD_OBJECT_CONTRACT,
  STATIC_LOAD_LIFECYCLE_CONTRACT,
  staticLoadObject,
} from '../src/runtime/script-static-load-object.mjs';
import {
  RESOLVE_NAME_NATIVE_CONTRACT,
  resolveNameNative,
} from '../src/runtime/script-resolve-name.mjs';
import { gameDirectory } from './game-directory.mjs';
import {ScriptObjectRegistry} from '../src/runtime/script-object-construction.mjs';
import {createScriptNames} from '../src/runtime/script-names.mjs';
import {createScriptObjectLookup} from '../src/runtime/script-object-lookup.mjs';

const root = gameDirectory();
const files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`))
    files.push({ path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`) });
const assets = new AssetStore(files);

const mapAsset = await assets.get('00_Training');
const map = decodeMap(mapAsset.bytes);
const levelInfo = map.actors.find(actor => actor?.className === 'DeusExLevelInfo');
const missionNumber = levelInfo?.values?.missionNumber ?? 0; // unauthored -> class default 0
assert.equal(missionNumber, 0);

const conversations = await (async () => loadMissionConversations(await assets.get('DeusExConText'), missionNumber))();
assert.equal(conversations.length, 470); // the full Mission00 list

// The MunitionsTrooper conversations bound to the two UNATCO instructors.
const bindName = 'MunitionsTrooper';
const bound = matchConversations(bindName, conversations);
console.log('MunitionsTrooper binds:', bound.map(c => `${c.object}:${c.conName}`).join(', '));
assert.deepEqual(bound.map(c => c.conName), ['MunitionsTrooperFrob', 'MunitionsTrooperTake']);
assert.ok(bound.every(c => c.bInvokeFrob && c.bInvokeBump && c.bInvokeRadius));

// Every training actor's binding, keyed by BindName. Decorations bind nothing.
const troopers = map.actors.filter(a => a?.values?.BindName === bindName);
assert.deepEqual(troopers.map(a => a.name).sort(), ['UNATCOTroop0', 'UNATCOTroop3']);
for (const trooper of troopers)
  assert.deepEqual(matchConversations(trooper.values.BindName, conversations).map(c => c.conName),
    ['MunitionsTrooperFrob', 'MunitionsTrooperTake']);

// The LightSwitch and other decorations have BindName None -> no conversations.
const lightSwitch = map.actors.find(a => a?.name === 'LightSwitch0');
assert.deepEqual(matchConversations(lightSwitch?.values?.BindName, conversations), []);
const decorations = map.actors.filter(a => a?.values && /Light|Switch|Decoration|Furniture/i.test(a.className));
for (const decoration of decorations)
  assert.deepEqual(matchConversations(decoration.values.BindName, conversations), []);

// Summary: which training actors bind at least one conversation.
const boundActors = new Map();
for (const actor of map.actors) {
  if (!actor?.values) continue;
  const list = matchConversations(actor.values.BindName, conversations);
  if (list.length) boundActors.set(actor.name, { bindName: actor.values.BindName, count: list.length });
}
console.log('Training actors with bound conversations:',
  [...boundActors].map(([name, info]) => `${name}(${info.bindName}):${info.count}`).join(', '));

// Runtime path: the native ConBindEvents (2101) links ConListItems in the Play
// host. Reuse the training game host and exercise both branches on the attached
// LightSwitch decoration instance.
const { createGame } = await import('../src/viewer/game.mjs');
const game = await createGame(map, mapAsset, assets, { randomSeed: 1 });
const runtime = game.doors.scriptRuntime.runtime;
const canonicalList=await runtime.prepareConversations(missionNumber);
const canonicalOuter=runtime.namedReference(canonicalList,'Outer').get();

// The binding wrapper's load callback must enter the recovered StaticLoadObject
// path. Build the already-loaded linker from the real ConversationList export
// and import metadata rather than accepting a path-only canonical-list hit.
const contextAsset=canonicalList.asset;
const listExportIndex=canonicalList.index;
const listEntry=contextAsset.pkg.exports[listExportIndex-1];
assert.ok(listEntry, 'ConversationList export metadata is present');
assert.equal(listEntry.name, 'ConList_Mission00');
assert.equal(listEntry.path, 'ConList_Mission00');
assert.equal(listEntry.className, 'ConversationList');
assert.equal(listEntry.classIndex, -24);
assert.equal(listEntry.outer, 0); // UE1 package root export
const serializedList=readObject(contextAsset.pkg, contextAsset.bytes, listExportIndex);
assert.equal(serializedList.values.conversations, 50330);

const packageNameIndices=new Map(contextAsset.pkg.names.map((entry,index)=>[entry.name,index]));
const packageNameIndex=text=>{
  const index=packageNameIndices.get(text);
  assert.ok(Number.isInteger(index), `Missing original package FName ${text}`);
  return index;
};
const listNameIndex=packageNameIndex(listEntry.name);
const classNameIndex=packageNameIndex('ConversationList');
const classOuterNameIndex=packageNameIndex('ConSys');
const classImport=contextAsset.pkg.imports[-listEntry.classIndex-1];
assert.deepEqual(classImport, {
  classPackage:'Core', className:'Class', outer:-1, name:'ConversationList',
  path:'ConSys.ConversationList',
});
const classOuterImport=contextAsset.pkg.imports[-classImport.outer-1];
assert.deepEqual(classOuterImport, {
  classPackage:'Core', className:'Package', outer:0, name:'ConSys', path:'ConSys',
});

// These are canonical ScriptObjects identities prepared by the runtime. The
// read service uses package-name indices as a consistent fixture namespace for
// class, export and import names. Native loaded tables use global FName indices;
// this fixture does not claim the package-local numbers are original GNames slots.
const classRef=runtime.instance(canonicalList).cls.record;
const classResource=runtime.resources?.resources.get(classRef.key);
assert.ok(classResource, 'ConversationList class resource is prepared');
const classOuter=classResource.outer;
assert.equal(classRef.key, 'consys.conversationlist');
assert.equal(classOuter?.key, 'package:consys');
assert.equal(canonicalOuter?.key, 'package:deusexcontext');

const linkerExportIndex=listExportIndex-1;
// Preserve the raw UE1 export Outer index. FindExportIndex receives requested
// Outer=-1 from the original resolver as a wildcard, so its record comparison
// must still accept this root export's original Outer=0.
const linkerOuterIndex=listEntry.outer;
assert.equal(linkerOuterIndex, 0);
const exportRecord={
  classIndex:listEntry.classIndex,
  outerIndex:linkerOuterIndex,
  nameIndex:listNameIndex,
  object:canonicalList,
  nextHash:-1,
};
const linker={
  label:'LinkerLoad(DeusExConText)',
  outer:canonicalOuter,
  reader:{label:'LinkerReader(DeusExConText)'},
};
const loadState={nest:0,registrationQueueHead:null,loadedMax:0,loaderCleanupState:0};
const loadedObjects=[];
const staticServiceCalls=[];
const resolveTrace=[];
const staticImportReads=[];
const staticHashBuckets=[];
const staticLoads=[];
const staticLogReceiver={label:'GWarn'};
const expectedBucket=(classNameIndex*7+classOuterNameIndex*31+listNameIndex)&0xff;

const readStatic=(object,field)=>{
  if(object===classRef){
    if(field==='nameIndex')return classNameIndex;
    if(field==='outer')return classOuter;
  }
  if(object===classOuter){
    if(field==='nameIndex')return classOuterNameIndex;
    if(field==='outer')return null;
  }
  if(object===canonicalOuter){
    if(field==='nameIndex')return packageNameIndex('DeusExConText');
    if(field==='outer')return null;
  }
  return object?.[field];
};

// Existing package lookup fixture used by Core CreatePackage. The registry
// object carries an explicit native Core.Package class; its identity points to
// the runtime-prepared canonicalOuter package boundary.
const registry=new ScriptObjectRegistry();
const names=createScriptNames({allocator:{free:()=>{throw new Error('Unexpected name release');}}});
names.intern('None',2);
const corePackageClass=runtime.resources.nativeClass('Core.Package');
const coreObjectClass=runtime.resources.nativeClass('Core.Object');
const outer={identity:canonicalOuter,index:-1,outer:null,name:'DeusExConText',
  nameIndex:names.intern('DeusExConText').index,objectClass:corePackageClass};
registry.add(outer);
const lookup=createScriptObjectLookup({registry,names,corePackageClass,coreObjectClass});
const resolveServices={
  trace:resolveTrace,
  copyString:({source,maxLength})=>{
    assert.equal(maxLength,RESOLVE_NAME_NATIVE_CONTRACT.maxNameLength);
    staticServiceCalls.push('ResolveName.appStrcpy');
    return source;
  },
  createPackage:({outer:currentOuter,name})=>{
    assert.equal(currentOuter,null);
    assert.equal(name,'DeusExConText');
    // Core CreatePackage recursively calls ResolveName(1,0), then performs
    // StaticFindObject(Core.Package,NULL,name,0). No allocation fallback is
    // allowed in this initialized existing-package fixture.
    const nestedOuter={get:()=>currentOuter,set:()=>{throw new Error('Nested ResolveName changed package Outer');}};
    let nestedNameValue=name;
    const nestedName={get:()=>nestedNameValue,set:value=>{nestedNameValue=value;}};
    assert.equal(resolveNameNative(nestedOuter,nestedName,{
      create:1,throwOnConfigMissing:0,services:resolveServices,
    }),true);
    assert.equal(nestedOuter.get(),null);
    assert.equal(nestedName.get(),name);
    const existing=lookup.staticFindObject({
      classRef:corePackageClass,outer:null,name:nestedName.get(),exactClass:0,
    });
    assert.equal(existing,outer);
    assert.equal(existing.identity,canonicalOuter);
    return existing.identity;
  },
  corePackageClass,
  coreObjectClass,
};

const staticServices={
  loadState,
  loadedObjects,
  read:readStatic,
  resolveName:(outerRef,nameRef,options)=>{
    assert.deepEqual(options,{create:1,throwOnConfigMissing:1});
    assert.equal(outerRef.get(),null);
    assert.equal(nameRef.get(),'DeusExConText.ConList_Mission00');
    staticServiceCalls.push('ResolveName');
    const result=resolveNameNative(outerRef,nameRef,{...options,services:resolveServices});
    assert.equal(result,true);
    assert.equal(outerRef.get(),canonicalOuter);
    assert.equal(nameRef.get(),listEntry.name);
    return result;
  },
  loaders:[linker],
  readPackageExtension:()=>'',
  copyString:({source})=>{
    assert.equal(source,'');
    staticServiceCalls.push('appStrcpy');
    return source;
  },
  findName:(text,mode)=>{
    assert.equal(text,listEntry.name);
    assert.equal(mode,1);
    staticServiceCalls.push('FName');
    return listNameIndex;
  },
  readHashHead:(candidate,bucket)=>{
    assert.equal(candidate,linker);
    assert.equal(bucket,expectedBucket);
    staticHashBuckets.push(bucket);
    return linkerExportIndex;
  },
  readExport:(candidate,index)=>{
    assert.equal(candidate,linker);
    assert.equal(index,linkerExportIndex);
    return exportRecord;
  },
  readImportWord:(candidate,byteOffset)=>{
    assert.equal(candidate,linker);
    const stride=STATIC_LOAD_OBJECT_CONTRACT.importRecordStride;
    const fieldOffset=byteOffset%stride;
    assert.ok(fieldOffset===8||fieldOffset===12,
      `unexpected original import-table field offset 0x${fieldOffset.toString(16)}`);
    const importIndex=Math.floor(byteOffset/stride);
    const entry=contextAsset.pkg.imports[importIndex];
    assert.ok(entry,`missing original import record ${importIndex+1}`);
    const value=fieldOffset===8 ? entry.outer : packageNameIndex(entry.name);
    staticImportReads.push({byteOffset,importIndex,fieldOffset,value});
    return value;
  },
  createExport:({linker:actualLinker,index,classRef:actualClass,record,existing})=>{
    assert.equal(actualLinker,linker);
    assert.equal(index,linkerExportIndex);
    assert.equal(actualClass,classRef);
    assert.equal(record,exportRecord);
    assert.equal(existing,canonicalList);
    staticServiceCalls.push('CreateExport');
    return existing;
  },
  logReceiver:staticLogReceiver,
  logEndLoad:({receiver,name,formatPointer,native})=>{
    assert.equal(receiver,staticLogReceiver);
    assert.equal(name,STATIC_LOAD_LIFECYCLE_CONTRACT.endLoadLogName);
    assert.equal(formatPointer,STATIC_LOAD_LIFECYCLE_CONTRACT.endLoadLogFormat);
    assert.equal(native,STATIC_LOAD_OBJECT_CONTRACT.endLoadBody);
    staticServiceCalls.push('Logf');
  },
  reallocLoaded:({array,elementSize,num,max,tag,native})=>{
    assert.equal(array,loadedObjects);
    assert.equal(elementSize,STATIC_LOAD_LIFECYCLE_CONTRACT.loadedArrayElementSize);
    assert.equal(num,0);
    assert.equal(max,0);
    assert.equal(tag,STATIC_LOAD_LIFECYCLE_CONTRACT.loadedArrayReallocTag);
    assert.equal(native,STATIC_LOAD_OBJECT_CONTRACT.endLoadBody);
    staticServiceCalls.push('FArrayRealloc');
  },
  staticFindObject:()=>assert.fail('StaticFindObject path was unexpectedly reached'),
};

// Explicit native allocation/name/Outer fixture. The rest of the loaded Play
// world is not claimed to have completed native registry bootstrap.
const released=[];
runtime.conversationLifecycle={
  load:request=>{
    assert.deepEqual(request,{classKey:'consys.conversationlist',outer:null,
      path:'DeusExConText.ConList_Mission00',filename:null,flags:2,sandbox:null});
    const loaded=staticLoadObject({
      classRef,
      outer:request.outer,
      name:request.path,
      filename:request.filename,
      flags:request.flags,
      sandbox:request.sandbox,
    },staticServices);
    staticLoads.push(loaded);
    return loaded.object;
  },
  nativeOuter:value=>{assert.equal(value,canonicalOuter);return outer;},
  construction:{
    validate:args=>args.cls===runtime.conversationItemClass&&args.outer===outer&&args.template===null,
    registry,findObject:lookup.findObject,internName:name=>names.intern(name),
    initNativeProperties:()=>{}, // ConListItem has only its two reflected pointer members.
  },
  release:{gates:{[0x102a2644]:true,[0x101e5550]:false},registry,
    isValid:object=>registry.objects[object.index]===object,
    freeStateFrame:()=>{throw new Error('ConListItem has no execution frame');},
    freeObject:object=>{object.released=true;released.push(object);},
  },
};
const level = runtime.levelFor(game.player.collisionActor);
const switchActor = level.actors.find(a => a?.index === lightSwitch.index);

// BindName None -> ConBindEvents leaves ConListItems at the original None.
assert.equal(runtime.namedReference(switchActor, 'ConListItems').get(), null);
runtime.invokeNative({ index: 2101, receiver: switchActor, argumentCount: 0, evaluateArgument: () => undefined });
assert.equal(runtime.namedReference(switchActor, 'ConListItems').get(), null);

// The positive path on the same attached instance: as MunitionsTrooper it links
// the Frob -> Take ConListItem chain, each item's `con` the matched conversation.
// Live pawns have already run their own PostPostBeginPlay ConBindEvents, so the
// shared Conversation objects may carry ambient owner references; the bind
// contract this checks is the exact +1 this actor's bind adds.
const ref=(object,key)=>runtime.namedReference(object,key);
const ambientCon = conName => {
  for (const actor of level.actors) {
    if (!actor || actor === switchActor) continue;
    let items;
    try { items = ref(actor, 'ConListItems').get(); } catch { continue; }
    for (let item = items; item; item = ref(item, 'next').get()) {
      const con = ref(item, 'con').get();
      if (ref(con, 'conName').get() === conName) return con;
    }
  }
  return null;
};
const ambientFirst = ambientCon('MunitionsTrooperFrob'), ambientSecond = ambientCon('MunitionsTrooperTake');
const firstBase = ambientFirst ? ref(ambientFirst, 'ownerRefCount').get() : 0;
const secondBase = ambientSecond ? ref(ambientSecond, 'ownerRefCount').get() : 0;
const savedBind = runtime.namedReference(switchActor, 'BindName').get();
runtime.namedReference(switchActor, 'BindName').set('MunitionsTrooper');
runtime.invokeNative({ index: 2101, receiver: switchActor, argumentCount: 0, evaluateArgument: () => undefined });
const chain = runtime.namedReference(switchActor, 'ConListItems').get();
const next=ref(chain,'next').get();
const firstCon=ref(chain,'con').get(),secondCon=ref(next,'con').get();
assert.deepEqual([ref(firstCon,'conName').get(),ref(secondCon,'conName').get(),ref(next,'next').get()],
  ['MunitionsTrooperFrob', 'MunitionsTrooperTake', null]);
if (ambientFirst) assert.equal(firstCon, ambientFirst, 'the bind resolves the same shared Conversation the live pawn owns');
if (ambientSecond) assert.equal(secondCon, ambientSecond, 'the bind resolves the same shared Conversation the live pawn owns');
assert.equal(ref(firstCon,'ownerRefCount').get(),firstBase+1);
assert.equal(ref(secondCon,'ownerRefCount').get(),secondBase+1);
for(const item of [chain,next]){
  assert.equal(runtime.instance(item).cls.record.key,'consys.conlistitem');
  assert.equal(runtime.instance(item).nativeObject.nativeVtable,0x1001346c);
  assert.equal(ref(item,'Outer').get(),canonicalOuter);
  assert.equal(ref(item,'ObjectFlags').get(),4);
}
runtime.namedReference(switchActor, 'BindName').set(savedBind);
runtime.invokeNative({index:2101,receiver:switchActor,argumentCount:0});
assert.equal(ref(switchActor,'ConListItems').get(),null);
assert.equal(ref(firstCon,'ownerRefCount').get(),firstBase);
assert.equal(ref(secondCon,'ownerRefCount').get(),secondBase);
assert.equal(released.length,2);
assert.deepEqual(registry.freeIndices,released.map(object=>object.index));
assert.ok(released.every(object=>object.flags===0x80800004&&registry.objects[object.index]===null));

// Each ConBindEvents call (None, positive, and the final purge) went through
// the same initialized linker/export and the empty outermost lifecycle.
assert.equal(staticLoads.length,3);
const staticOps=['StaticLoadObject','BeginLoad','ResolveName','GetPackageLinker',
  'appStrcpy','FName','FindExportIndex','CreateExport','EndLoad','Logf','FArrayRealloc'];
for(const loaded of staticLoads){
  assert.equal(loaded.object,canonicalList);
  assert.deepEqual(loaded.events.map(event=>event.op),staticOps);
  const begin=loaded.events.find(event=>event.op==='BeginLoad');
  const end=loaded.events.find(event=>event.op==='EndLoad');
  assert.deepEqual({before:begin.before,after:begin.after},{before:0,after:1});
  assert.deepEqual({before:end.before,after:end.after},{before:1,after:0});
  const exportEvent=loaded.events.find(event=>event.op==='CreateExport');
  assert.equal(exportEvent.existing,canonicalList);
}
assert.deepEqual(staticHashBuckets,[expectedBucket,expectedBucket,expectedBucket]);
const classImportOuterOffset=-STATIC_LOAD_OBJECT_CONTRACT.importRecordStride*listEntry.classIndex-0x14;
const classImportNameOffset=-STATIC_LOAD_OBJECT_CONTRACT.importRecordStride*listEntry.classIndex-0x10;
const classOuterNameOffset=-STATIC_LOAD_OBJECT_CONTRACT.importRecordStride*classImport.outer-0x10;
const expectedImportReads=[
  {byteOffset:classImportOuterOffset,importIndex:-listEntry.classIndex-1,fieldOffset:8,value:classImport.outer},
  {byteOffset:classOuterNameOffset,importIndex:-classImport.outer-1,fieldOffset:12,value:classOuterNameIndex},
  {byteOffset:classImportNameOffset,importIndex:-listEntry.classIndex-1,fieldOffset:12,value:classNameIndex},
];
assert.deepEqual(staticImportReads,Array.from({length:3},()=>expectedImportReads).flat());
assert.deepEqual(staticServiceCalls,[
  'ResolveName','ResolveName.appStrcpy','appStrcpy','FName','CreateExport','Logf','FArrayRealloc',
  'ResolveName','ResolveName.appStrcpy','appStrcpy','FName','CreateExport','Logf','FArrayRealloc',
  'ResolveName','ResolveName.appStrcpy','appStrcpy','FName','CreateExport','Logf','FArrayRealloc',
]);
assert.deepEqual(resolveTrace.filter(event=>event.op==='ResolveNameEnter').map(event=>({
  name:event.name,create:event.create,throwOnConfigMissing:event.throwOnConfigMissing,
})),[
  {name:'DeusExConText.ConList_Mission00',create:1,throwOnConfigMissing:1},
  {name:'DeusExConText',create:1,throwOnConfigMissing:0},
  {name:'DeusExConText.ConList_Mission00',create:1,throwOnConfigMissing:1},
  {name:'DeusExConText',create:1,throwOnConfigMissing:0},
  {name:'DeusExConText.ConList_Mission00',create:1,throwOnConfigMissing:1},
  {name:'DeusExConText',create:1,throwOnConfigMissing:0},
]);
assert.equal(resolveTrace.filter(event=>event.op==='CreatePackageEnter').length,3);
assert.equal(loadState.nest,0);
assert.equal(loadState.loadedMax,0);
assert.equal(loadState.loaderCleanupState,0);
assert.deepEqual(loadedObjects,[]);

console.log(`ConBindEvents binding validated: Mission00 has ${conversations.length} conversations; ` +
  `${boundActors.size} training actors bind by BindName, decorations bind none; ` +
  `native 2101 selects the mission list, constructs typed ConListItems and purges through native release services.`);
