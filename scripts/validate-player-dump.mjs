/** Original constructor/exec comparisons plus the reflected allocation boundary.
 * File contents/SaveLocation/LoadLocation are deliberately outside this test. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {createStartupFixture} from './validate-script-startup.mjs';
import {ScriptObjectRegistry} from '../src/runtime/script-object-construction.mjs';
import {createScriptNames} from '../src/runtime/script-names.mjs';
import {createScriptObjectLookup} from '../src/runtime/script-object-lookup.mjs';
import {constructPlayerDump,hasSavedDumpLocation,preparePlayerDumpStore} from '../src/runtime/script-player-dump.mjs';
import {loadConfigCache} from '../src/runtime/config-cache.mjs';
const oracle=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON||path.resolve('.cache/native-probe-env/bin/python'),
 ['scripts/native-player-dump-oracle.py',gameDirectory()],{encoding:'utf8'}));
assert.equal(oracle.initialSavedFlag,0);
const users=[null,'Alice','x'.repeat(80)],files=[[],['training.DMP','Test Dump.dmp'],['A.DMP']];
for(let i=0;i<3;i++){
 const fields={currentDumpLocation:{'s.bdeleted':true,'s.locationid':23,'s.mapname':'old',
  's.location':[1,2,3],'s.viewrotation':[4,5,6],'s.gameversion':'old','s.title':'old','s.desc':'old'}};
 const object={};constructPlayerDump(object,{read:name=>fields[name],write:(name,value)=>fields[name]=value,
 getCurrentUser:()=>users[i]?.slice(0,63)??null,findFiles:(p,f,d)=>{assert.deepEqual([p,f,d],['*.DMP',true,false]);return files[i];}});
 const original=oracle.cases[i];
 assert.equal(object.nativeVtable,original.vtable);assert.equal(fields.currentUser,original.currentUser);
 assert.deepEqual(fields.dumpFileDirectory,original.files);
 assert.deepEqual([fields.currentDumpFileIndex,fields.currentDumpLocationIndex],original.indices);
 assert.deepEqual([fields.dumpFile,fields.dumpLocationCount,fields.player??0],original.tail);
 assert.equal(object.dumpScratch.size,0x1220);
 assert.deepEqual([0,1,255].map(savedLocationFlag=>hasSavedDumpLocation({savedLocationFlag})),original.savedReads);
 assert.equal(fields.currentDumpLocation['s.locationid'],23);assert.deepEqual(fields.currentDumpLocation['s.location'],[1,2,3]);
 for(const member of ['mapname','gameversion','title','desc'])assert.equal(fields.currentDumpLocation[`s.${member}`],'');
 const pattern=0x55555555;
 assert.deepEqual(original.structWords,[pattern,pattern,0,0,0,pattern,pattern,pattern,pattern,pattern,pattern,0,0,0,0,0,0,0,0,0]);
}
assert.equal(oracle.cases[3].null,true);assert.equal(oracle.cases[3].events.length,1);
const {runtime,assets,deusEx,level}=await createStartupFixture();
const cls=await runtime.loadClass(deusEx,deusEx.exportsByPath.get('jcdentonmale'));
const player={};runtime.attach(player,cls);runtime.levelFor=()=>level;
const registry=new ScriptObjectRegistry(),none={index:0,flags:0,hashNext:null,text:'None'};
const names=createScriptNames({names:[none],freeIndices:[],buckets:Array(4096).fill(null),allocator:{free(){throw Error('fixture free');}}});
names.buckets[names.hashBucket('None')]=none;
const outer={identity:{},index:-1,outer:null,name:'DumpFixture',nameIndex:names.intern('DumpFixture').index};registry.add(outer);
level.nativeObject={outer};const lookup=createScriptObjectLookup({registry,names});
runtime.actorLifecycle={construction:{registry,findObject:lookup.findObject,internName:name=>names.intern(name)}};
// The engine's working directory is the one holding DeusEx.u in this catalog.
const systemDirectory=deusEx.path.replaceAll('\\','/').slice(0,deusEx.path.replaceAll('\\','/').lastIndexOf('/')+1);
assets.sourceFiles.push({path:`${systemDirectory}Fixture.DMP`},{path:`${systemDirectory}Nested/Ignored.DMP`},{path:'Maps/Ignored.DMP'});
const config=await loadConfigCache(assets.configFiles);config.setString('DeusEx.DumpLocation','CurrentUser','Fixture user','User.ini');
const store=await preparePlayerDumpStore({runtime,assets,player,configCache:config});
const object=runtime.invokeNative({receiver:player,index:3015,argumentCount:0});
const read=name=>runtime.namedReference(object,name).get();
assert.equal(runtime.instance(object).nativeObject.outer,outer);assert.equal(read('currentUser'),'Fixture user');
assert.ok(read('dumpFileDirectory').includes('Fixture.DMP'));assert.ok(!read('dumpFileDirectory').includes('Ignored.DMP'));
assert.equal(runtime.invokeNative({receiver:object,index:3039,argumentCount:0}),0);
assert.throws(()=>read('currentDumpFileLocation'),/pointer representation/);
assert.equal(store.objects.size,1);
console.log('DumpLocation passed: original missing/nonempty/truncated config, empty/nonempty file lists, null allocation and saved-byte reads; registered reflected native construction.');
