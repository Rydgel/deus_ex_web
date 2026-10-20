import test from 'node:test';
import assert from 'node:assert/strict';
import {ScriptState} from '../src/runtime/script-state.mjs';
import {compileFunction} from '../src/runtime/script-vm.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';

const classMetadata={probeMask:[0,0],ignoreMask:[0xffffffff,0xffffffff]};
function node(name){
  const script={pkg:{version:68},entry:{path:name},bytes:Uint8Array.of(8),size:1,
    probeMask:[0x30000,0],ignoreMask:[0xffffffff,0xffffffff]};
  return {record:{name},script,compiled:compileFunction(script),labels:new Map([['begin',0]]),base:null};
}
test('state transition dispatches EndState before installing the new BeginState receiver',()=>{
  const a=node('A'),b=node('B'),events=[];
  const state=new ScriptState({}, {dispatchStateEvent:(_,name)=>events.push(`${state.stateNode.record.name}.${name}`)});
  assert.equal(state.transition(a,classMetadata),1);state.gotoLabel('Begin');state.latent=302;
  assert.equal(state.transition(b,classMetadata),1);
  assert.deepEqual(events,['A.BeginState','A.EndState','B.BeginState']);
  assert.equal(state.execution,null);assert.equal(state.latent,0);
  assert.equal(state.gotoLabel('Begin'),true);state.process(1/120);
  assert.equal(state.execution.cursor,null);
});
test('a reentrant EndState transition keeps its own state and suppresses the outer target',()=>{
  const a=node('A'),b=node('B'),c=node('C'),events=[];
  const state=new ScriptState({}, {dispatchStateEvent:(_,name)=>{
    events.push(`${state.stateNode.record.name}.${name}`);
    if(name==='EndState'){assert.equal(state.transition(c,classMetadata),1);state.gotoLabel('Begin');}
  }});
  state.transition(a,classMetadata);
  assert.equal(state.transition(b,classMetadata),2);
  assert.equal(state.stateNode,c);assert.equal(state.execution.cursor,0);
  assert.deepEqual(events,['A.BeginState','A.EndState','C.BeginState']);
});

test('Auto selects the first flagged child, then inherited states without name deduplication',()=>{
  const runtime=new ScriptRuntime({}),receiver={},a=node('A'),b=node('B'),inherited=node('A');
  for(const [index,state] of [a,b,inherited].entries()){
    state.record.key=`fixture.${index}`;state.script.probeMask=[0,0];
    runtime.states.set(state.record.key,state);
  }
  const base={metadata:classMetadata,states:new Map([['a',inherited.record]]),
    stateOrder:[{record:inherited.record,flags:2}]};
  const cls={metadata:classMetadata,base,states:new Map([['a',a.record],['b',b.record]]),
    stateOrder:[{record:b.record,flags:2},{record:a.record,flags:2}]};
  const state=runtime.attach(receiver,cls);
  assert.equal(runtime.gotoState(receiver,'Auto'),true);
  assert.equal(state.stateNode,b);assert.equal(state.execution.cursor,0);
  cls.stateOrder.forEach(entry=>{entry.flags=0;});
  assert.equal(runtime.gotoState(receiver,'Auto'),true);
  assert.equal(state.stateNode,inherited);
  base.stateOrder[0].flags=0;state.latent=384;
  assert.equal(runtime.gotoState(receiver,'Auto'),false);
  assert.equal(state.stateNode,null);assert.equal(state.latent,0);
});

// AActor::ProcessState (Engine.dll 0x103e5b60): IsPendingKill (virtual +0x2c) is tested before the latent poll and bDeleteMe before each opcode, so a destroyed actor's
// state code neither polls its latent action nor runs another statement (Stage 5 lam1: WeaponLAM's NormalFire stays in NormalFire after AnimEnd's Destroy()).
test('a destroyed actor\'s ProcessState neither polls its latent action nor runs state code',()=>{
  const a=node('A'),polled=[];let destroyed=false;
  const state=new ScriptState({}, {dispatchStateEvent:()=>{},isPendingKill:()=>destroyed,pollLatent:call=>{polled.push(call.index);state.latent=0;}});
  state.transition(a,classMetadata);state.gotoLabel('Begin');state.latent=0x181;
  destroyed=true;state.process(1/60);
  assert.deepEqual(polled,[]);assert.equal(state.latent,0x181);assert.equal(state.execution.cursor,0);
  destroyed=false;state.process(1/60);
  assert.deepEqual(polled,[0x181]);assert.equal(state.execution.cursor,null);
});
