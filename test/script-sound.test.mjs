import test from 'node:test';
import assert from 'node:assert/strict';
import {checkActorHearSound,execActorPlaySound} from '../src/runtime/script-sound.mjs';

test('original sound dispatch preserves argument/event order and live listener traversal',()=>{
  const f=Math.fround,events=[],reads=[],evaluated=[];
  const info={kind:'Engine.LevelInfo',NetMode:0,PawnList:null};
  const level={Actors:[info],DemoRecDriver:{ServerConnection:null},Model:{},Engine:{Client:null}};
  const emitter={XLevel:level,Level:info,ObjectIndex:7,Location:[0,0,0],Owner:null,
    TransientSoundVolume:1,TransientSoundRadius:0};
  const pawn=()=>({kind:'Engine.PlayerPawn',ViewTarget:null,Location:[1,0,0],
    XLevel:level,bIsPlayer:true,NextPawn:null});
  const first=pawn(),removed=pawn(),inserted=pawn(),sound={kind:'Sound'};
  info.PawnList=first;first.NextPawn=removed;
  const services={
    read:(object,name)=>{reads.push(name);return object[name];},
    isA:(object,name)=>object.kind===name,
    frameFunctionFlags:()=>null,
    fastLineCheck:(model,start,end)=>{
      assert.equal(model,level.Model);assert.deepEqual(start,[1,0,0]);assert.deepEqual(end,[0,0,0]);return true;
    },
    processNativeEvent:(receiver,name,args)=>{
      events.push({receiver,name,args:args.slice()});
      if(name==='DemoPlaySound'){
        emitter.ObjectIndex=12;
        args[2]=900; // Temporary event parameters do not alias execPlaySound locals.
      }else if(receiver===first)first.NextPawn=inserted;
    },
  };
  const call={receiver:emitter,argumentCount:6,evaluateArgument:index=>{
    evaluated.push(index);
    if(index===0){emitter.TransientSoundVolume=2;return sound;}
    if(index===1){emitter.TransientSoundVolume=3;return undefined;}
    if(index===2){assert.equal(reads.at(-1),'TransientSoundVolume');return undefined;}
    if(index===3){emitter.TransientSoundRadius=-2;return true;}
    if(index===4){assert.equal(reads.at(-1),'TransientSoundRadius');return undefined;}
    return undefined;
  }};
  const result=execActorPlaySound(call,services);
  assert.deepEqual(evaluated,[0,1,2,3,4,5]);
  assert.equal(result.result,195); // (post-demo global Index12 <<4) + Slot1*2 +1.
  assert.deepEqual(result.arguments,[sound,1,3,1,800,1]);
  assert.deepEqual(events.map(event=>event.name),['DemoPlaySound','ClientHearSound','ClientHearSound']);
  assert.deepEqual(result.listeners.map(entry=>entry.listener),[first,inserted]);
  assert.deepEqual(events[1].args,[emitter,195,sound,[0,0,0],[300,800,100]]);

  // Null Sound still reads optional defaults, then preserves Result and skips world services.
  reads.length=0;
  assert.deepEqual(execActorPlaySound({receiver:emitter,argumentCount:1,evaluateArgument:()=>null},{read:services.read}),{resultWritten:false});
  assert.deepEqual(reads,['TransientSoundVolume','TransientSoundRadius']);

  // Simulated UFunction selects viewports even at NetMode0; live append is observed.
  level.DemoRecDriver=null;first.bIsPlayer=false;inserted.bIsPlayer=false;
  const client={Viewports:[{Actor:first}]};level.Engine.Client=client;
  services.frameFunctionFlags=()=>0x100;
  events.length=0;
  services.processNativeEvent=(receiver,name,args)=>{
    events.push({receiver,name,args});
    if(receiver===first)client.Viewports=[...client.Viewports,{Actor:inserted}];
  };
  assert.deepEqual(execActorPlaySound({receiver:emitter,argumentCount:1,evaluateArgument:()=>sound},services)
    .listeners.map(entry=>entry.listener),[first,inserted]);

  // ViewTarget drives distance; the initial gate is strict, and occlusion checks Owner.
  const target={Location:[1,0,0]};first.ViewTarget=target;first.Location=[9999,0,0];
  // float32(1.3f * original radius constant) is exactly1.
  assert.equal(f(f(1.3)*0.7692307829856873),1);
  assert.equal(checkActorHearSound(emitter,first,1,sound,[100,1,100],f(1.3),services).reason,'distance');
  target.Location=[0.4,0,0];emitter.Owner=first;
  services.fastLineCheck=(model,start,end)=>{
    assert.deepEqual(start,[f(.4),0,0]);assert.deepEqual(end,[0,0,0]);
    emitter.Location=[2,0,0];return false;
  };
  events.length=0;
  const params=[100,1,100];
  assert.equal(checkActorHearSound(emitter,first,1,sound,params,f(.325),services).heard,true);
  assert.deepEqual(events[0].args[3],[2,0,0]);
  assert.deepEqual(events[0].args[4],[f(100*0.3499999940395355),1,100]);
  assert.deepEqual(params,[100,1,100]);
  emitter.Location=[0,0,0];emitter.Owner=null;
  assert.equal(checkActorHearSound(emitter,first,1,sound,params,f(.325),services).reason,'occlusion');
});
