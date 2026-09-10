import test from 'node:test';
import assert from 'node:assert/strict';
import {execScriptSpawn} from '../src/runtime/script-spawn.mjs';

test('execSpawn samples defaults in original order and applies Tag after native startup',()=>{
  const caller={Location:[1,2,3],Rotation:[4,5,6],Instigator:null};
  const cls={},owner={},instigator={},level={},created={Tag:'CameraPoint'},order=[];
  const result=execScriptSpawn({receiver:caller,argumentCount:5,evaluateArgument(index){
    order.push(index);
    if(index===0)return cls;
    if(index===1)return owner;
    if(index===2){caller.Location=[10,20,30];return 'ScriptTag';}
    if(index===3){caller.Location=[100,200,300];caller.Rotation=[40,50,60];return undefined;}
    caller.Rotation=[400,500,600];caller.Instigator=instigator;return undefined;
  }},{read:(actor,name)=>actor[name],write:(actor,name,value)=>{order.push(name);actor[name]=value;},
    levelFor:()=>{order.push('level');return level;},spawnActor:args=>{
      order.push('startup');assert.deepEqual(args,{cls,level,name:'None',owner,instigator,location:[10,20,30],rotation:[40,50,60]});
      assert.equal(created.Tag,'CameraPoint');return created;
    }});
  assert.equal(result,created);assert.equal(created.Tag,'ScriptTag');
  assert.deepEqual(order,[0,1,2,3,4,'level','startup','Tag']);
});

test('execSpawn null class evaluates remaining arguments but never resolves a level',()=>{
  const order=[];
  assert.equal(execScriptSpawn({receiver:{},argumentCount:5,evaluateArgument:index=>{order.push(index);return index===0?null:undefined;}},
    {read:()=>[0,0,0],levelFor:()=>{throw new Error('must not resolve level');}}),null);
  assert.deepEqual(order,[0,1,2,3,4]);
});
