/** Original CameraPoint metadata at the fresh construction boundary. The
 * fixture supplies a complete controlled registry/name table and native tail;
 * it does not claim map loading, SpawnActor startup or final collection. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {ScriptObjectRegistry,constructCameraPoint} from '../src/runtime/script-object-construction.mjs';
import {createScriptNames} from '../src/runtime/script-names.mjs';
import {createScriptObjectLookup} from '../src/runtime/script-object-lookup.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory();
const assets=new AssetStore((await readdir(`${root}/System`)).map(name=>({path:name,read:()=>readFile(`${root}/System/${name}`)})));
const engine=await assets.get('Engine'),runtime=new ScriptRuntime(assets);
const cls=await runtime.loadClass(engine,engine.exportsByPath.get('camerapoint'));
const outer={identity:{name:'ConstructionFixture'},index:7};
const registry=new ScriptObjectRegistry();
const template={};runtime.attach(template,cls);
const ref=(actor,name)=>runtime.namedReference(actor,name);
ref(template,'Tag').set('TemplateTag');ref(template,'BindName').set('Owned template text');
ref(template,'Location').set([11,22,33]);
ref(template,'BlendAnimSequence').set(['Walk','Run','Idle','Stop']);
ref(template,'LatentFloat').set(3.25);
// The fixture starts with the original index-zero None entry. The FName
// allocator is explicit; release is outside this construction check.
const noneEntry={index:0,flags:0,hashNext:null,text:'None'};
const names=createScriptNames({
  names:[noneEntry],
  freeIndices:[],
  buckets:Array(0x1000).fill(null),
  allocator:{free:()=>{throw new Error('Construction fixture does not model FName release');}},
});
names.buckets[names.hashBucket(noneEntry.text)]=noneEntry;
assert.equal(names.find('None'),0);
const occupied={identity:{},index:-1,name:'CameraPoint0',nameIndex:names.intern('CameraPoint0').index,
  outer,objectClass:cls};
registry.add(occupied);
const lookup=createScriptObjectLookup({registry,names,
  classOf:object=>object.objectClass.record,
  superClass:record=>record.linkedClass.base?.record??null,
});
const nativeTemplate={auxiliary:null};
const actor=runtime.constructObject(cls,{outer,template},{
  validate:args=>args.cls===cls&&args.outer===outer&&args.template===template,
  registry,
  findObject:lookup.findObject,
  internName:name=>names.intern(name),
  initNativeProperties:object=>{object.auxiliary=nativeTemplate.auxiliary;},
  nativeConstructor:constructCameraPoint,
});
const instance=runtime.instance(actor),object=instance.nativeObject;
assert.equal(object.nativeVtable,0x10427178);
assert.equal(object.index,1);assert.equal(registry.objects[1],object);
assert.equal(ref(actor,'Name').get(),'CameraPoint1');assert.equal(cls.nameCounter,2);
assert.equal(ref(actor,'Class').get(),cls.record);assert.equal(ref(actor,'Outer').get(),outer.identity);
assert.equal(ref(actor,'ObjectFlags').get(),0);assert.equal(object.stateFrame,null);assert.equal(instance.state,null);
assert.equal(ref(actor,'Tag').get(),'TemplateTag');assert.equal(ref(actor,'BindName').get(),'Owned template text');
assert.deepEqual(ref(actor,'BlendAnimSequence').get(),['Walk','Run','Idle','Stop']);
assert.equal(ref(actor,'LatentFloat').get(),3.25);
ref(actor,'Location').set([44,55,66]);assert.deepEqual(ref(template,'Location').get(),[11,22,33]);
ref(actor,'BindName').set('Instance text');assert.equal(ref(template,'BindName').get(),'Owned template text');
const state=runtime.initExecution(actor);
assert.equal(object.stateFrame,state);assert.equal(ref(actor,'ObjectFlags').get(),0x02000000);
assert.equal(state.latent,undefined);
console.log('Original CameraPoint typed template construction, name collision, registration-before-native-constructor, unchanged template data and separate frame initialization passed.');
