import assert from 'node:assert/strict';
import test from 'node:test';
import {compileFunction} from '../src/runtime/script-vm.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {execObjectLog,OBJECT_LOG_CONTRACT} from '../src/runtime/script-log.mjs';

test('Object.Log preserves left-to-right arguments, ScriptLog default, and %s text',()=>{
  const evaluations=[],events=[];
  const result=execObjectLog({argumentCount:1,evaluateArgument(index){
    evaluations.push(index);return 'prefix\0suffix';
  }},{logDevice:event=>events.push(event)});
  assert.equal(result,undefined);
  assert.deepEqual(evaluations,[0]);
  assert.deepEqual(events,[{text:'prefix',tag:'ScriptLog',tagIndex:0x302}]);

  evaluations.length=0;events.length=0;
  execObjectLog({argumentCount:2,evaluateArgument(index){
    evaluations.push(index);
    return index===0?{reference:true,get:()=> 'message'}:{reference:true,get:()=> 'Log'};
  }},{logDevice:event=>events.push(event)});
  assert.deepEqual(evaluations,[0,1]);
  assert.deepEqual(events,[{text:'message',tag:'Log',tagIndex:null}]);
});

test('Object.Log requires a synchronous GLog boundary and evaluates before checking it',()=>{
  const evaluations=[];
  assert.throws(()=>execObjectLog({argumentCount:2,evaluateArgument(index){
    evaluations.push(index);return index?'Tag':'Text';
  }}),/synchronous GLog output device/);
  assert.deepEqual(evaluations,[0,1]);
  assert.throws(()=>execObjectLog({argumentCount:1,evaluateArgument:()=>42},{logDevice:()=>{}}),/typed string/);
  assert.throws(()=>execObjectLog({argumentCount:2,evaluateArgument:()=> 'bad\0name'},
    {logDevice:()=>{}}),/resolved logical FName/);
  assert.throws(()=>execObjectLog({argumentCount:1,evaluateArgument:()=>''},
    {logDevice:()=>Promise.resolve()}),/synchronous GLog/);
  assert.throws(()=>execObjectLog({argumentCount:0,evaluateArgument:()=>''},{logDevice:()=>{}}),/requires a string/);
  assert.throws(()=>execObjectLog({argumentCount:3,evaluateArgument:()=>''},{logDevice:()=>{}}),/optional name tag/);
});

test('VM and ScriptRuntime dispatch native 231 through the log device boundary',()=>{
  const events=[];
  const runtime=new ScriptRuntime({}, {logDevice:event=>events.push(event)});
  runtime.invokeNative({index:231,receiver:{},argumentCount:1,evaluateArgument:()=> 'runtime'});
  assert.deepEqual(events,[{text:'runtime',tag:OBJECT_LOG_CONTRACT.defaultTag,tagIndex:0x302}]);

  const vm=compileFunction({pkg:{imports:[],exports:[]},entry:{path:'Fixture.Log'},
    bytes:Uint8Array.from([0x04,0x60,0xe7,0x1f,65,0,0x16]),size:7});
  const evaluations=[];
  const result=vm.run({}, {}, {invokeNative:call=>{
    return runtime.invokeNative({index:call.index,receiver:call.receiver,
      argumentCount:call.argumentCount,evaluateArgument:index=>{
        evaluations.push(index);return call.evaluateArgument(index);
      }});
  }});
  assert.equal(result,undefined);
  // The VM's native expression literal is evaluated once by the runtime
  // boundary; the shared device sees the same void native call.
  assert.deepEqual(evaluations,[0]);
  assert.deepEqual(events,[
    {text:'runtime',tag:OBJECT_LOG_CONTRACT.defaultTag,tagIndex:0x302},
    {text:'A',tag:OBJECT_LOG_CONTRACT.defaultTag,tagIndex:0x302},
  ]);
});
