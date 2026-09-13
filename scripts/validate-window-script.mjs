/** Focused original ProcessScript lookup/event boundary comparisons. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {processWindowScript} from '../src/runtime/script-window-script.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory();
const native=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON||'.cache/native-probe-env/bin/python',
  ['scripts/native-window-script-oracle.py',root],{encoding:'utf8'}));
for(const [name,checked,found,scriptable] of [
  ['checkedFound',1,true,true],['uncheckedFound',0,true,true],
  ['uncheckedMissing',0,false,true],['checkedDisabled',1,true,false],
]){
  const original=native.cases[name],object={},record={},events=[];
  processWindowScript({object,event:'InitWindow',thirdArgument:checked},{
    isScriptable:()=>{events.push({op:'isScriptable',value:scriptable});return scriptable;},
    findFunction:args=>{events.push({op:'findFunction',...args});return found?record:null;},
    processEvent:args=>events.push({op:'processEvent',...args}),
  });
  const normalized=events.map(entry=>({...entry,
    ...(entry.object?{object:original.object}:{}),
    ...(entry.event?{event:original.name}:{}),
    ...(entry.record?{record:original.function}:{}),
    ...(Object.hasOwn(entry,'parameters')?{parameters:0,result:0}:{}),
  }));
  assert.deepEqual(normalized,original.events,name);
}

// Actual original Window.InitWindow is empty; its prepared body is still
// called through the shared ProcessEvent path with the selected UFunction.
const assets=new AssetStore((await readdir(path.join(root,'System'))).map(name=>({
  path:'System/'+name,read:()=>readFile(path.join(root,'System',name)),
})));
let scriptable=true;
const runtime=new ScriptRuntime(assets,{windowLifecycle:{isScriptable:()=>scriptable}});
const extension=await assets.get('Extension');
const windowClass=await runtime.loadClass(extension,extension.exportsByPath.get('window'));
const object={};runtime.attach(object,windowClass);
const init=await runtime.prepareFunction(extension,extension.exportsByPath.get('window.initwindow'));
assert.equal(init.name,'InitWindow');
assert.equal(init.function.parameters.length,0);
let events=0;
let executions=0;
const executeScript=runtime.executeScript.bind(runtime);
runtime.executeScript=(...args)=>{executions++;return executeScript(...args);};
const processEvent=runtime.processEvent.bind(runtime);
runtime.processEvent=(receiver,name,args,result,record)=>{
  assert.equal(receiver,object);assert.equal(record,init);
  events++;
  return processEvent(receiver,name,args,result,record);
};
runtime.processWindowScript({object,event:'InitWindow',thirdArgument:1,parameters:null});
assert.equal(events,1);
assert.equal(executions,1);
scriptable=false;
runtime.processWindowScript({object,event:'InitWindow',thirdArgument:1,parameters:null});
assert.equal(events,1);
runtime.processWindowScript({object,event:'InitWindow',thirdArgument:0,parameters:null});
assert.equal(events,2,'unchecked lookup bypasses GIsScriptable');
assert.equal(executions,1,'Core ProcessEvent still rereads GIsScriptable and skips execution');
let scriptableReads=0;
runtime.windowLifecycle.isScriptable=()=>++scriptableReads===1;
runtime.processWindowScript({object,event:'InitWindow',thirdArgument:1,parameters:null});
assert.equal(scriptableReads,2,'checked lookup and Core ProcessEvent perform separate global reads');
assert.equal(events,3);assert.equal(executions,1);
console.log('Window ProcessScript verified: original checked/unchecked lookup, scriptability/null gates, '+
  'exact event pointer/arguments and prepared Window.InitWindow through shared ProcessEvent.');
