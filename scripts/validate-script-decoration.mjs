/** Execute original Plant2's inherited Bump/Timer scripts. External sound,
 * AI calls are recorded host boundaries, not playback or
 * decoration physics implementations. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {refValue} from '../src/runtime/script-vm.mjs';
import {updateActorTimer} from '../src/runtime/script-timers.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory();
const assets=new AssetStore((await readdir(`${root}/System`)).map(name=>({path:name,read:()=>readFile(`${root}/System/${name}`)})));
const deus=await assets.get('DeusEx'),calls=[],level={editor:false};
const runtime=new ScriptRuntime(assets,{levelFor:()=>level,native:call=>{
  const args=Array.from({length:call.argumentCount},(_,i)=>refValue(call.evaluateArgument(i)));
  calls.push({index:call.index,args});
  if(call.index===264)return 99;
  if(call.index===714)return null;
  if(call.index===265||call.index===715)return;
  throw new Error(`Unimplemented decoration validation boundary ${call.index}`);
}});
const plantClass=await runtime.loadClass(deus,deus.exportsByPath.get('plant2'));
const playerClass=await runtime.loadClass(deus,deus.exportsByPath.get('jcdentonmale'));
const plant={},player={};runtime.attach(plant,plantClass);runtime.attach(player,playerClass);
const bump=await runtime.prepareFunction(deus,deus.exportsByPath.get('deusexdecoration.bump'));
await runtime.prepareFunction(deus,deus.exportsByPath.get('deusexdecoration.timer'));
const ref=(actor,name)=>runtime.namedReference(actor,name);
ref(plant,'Location').set([0,0,0]);ref(plant,'Rotation').set([0,0,0]);
ref(player,'Location').set([40,10,0]);ref(player,'Velocity').set([111,-23,17]);
assert.equal(ref(plant,'Mass').get(),50);assert.equal(ref(plant,'bPushable').get(),true);
assert.equal(ref(plant,'Physics').get(),2);assert.equal(ref(player,'Mass').get(),150);
runtime.processEvent(plant,'Bump',[player]);
assert.deepEqual(ref(plant,'Velocity').get(),[111,-23,17]);
assert.equal(ref(plant,'Instigator').get(),player);
assert.equal(ref(plant,'bPushSoundPlaying').get(),true);assert.equal(ref(plant,'pushSoundId').get(),99);
assert.equal(ref(plant,'TimerRate').get(),Math.fround(.2));assert.equal(ref(plant,'bTimerLoop').get(),false);
assert.deepEqual(calls.map(call=>call.index),[264,714]);
assert.equal(calls[0].args[0].key,'deusexsounds.generic.pushmetal');
assert.equal(calls[0].args[4],128);assert.deepEqual(calls[1].args,['LoudNoise',1,undefined,128]);
// Vector.Rotation's original DLL result for [40,10,0] is [0,2555,0].
// The original body then truncates 2555 * float32(0.025) to yaw 63.
assert.deepEqual(ref(plant,'Rotation').get(),[0,63,0]);
assert.deepEqual(ref(plant,'Location').get(),[0,0,0]);
updateActorTimer(runtime.timerState(plant),Math.fround(.2),()=>runtime.processEvent(plant,'Timer'));
assert.deepEqual(calls.slice(2).map(call=>call.index),[265,715]);
assert.deepEqual(calls[2].args,[99]);assert.deepEqual(calls[3].args,['LoudNoise',1]);
assert.equal(ref(plant,'bPushSoundPlaying').get(),false);assert.equal(ref(plant,'TimerRate').get(),0);
// The source's carried-object early return uses the same cast and identity.
ref(player,'CarriedDecoration').set(plant);calls.length=0;
runtime.callFunction(bump,plant,1,()=>player);assert.deepEqual(calls,[]);
assert.equal(runtime.castObject(player,plantClass.record,'dynamic'),null);
assert.equal(runtime.castObject(playerClass.record,playerClass.base.record,'meta'),playerClass.record);
assert.equal(runtime.castObject(player,null,'dynamic'),player);
assert.equal(runtime.castObject(playerClass.record,null,'meta'),null);
console.log('Original Plant2 Bump velocity/instigator/timer/native-call order, Timer cleanup, carried-object early return and linked cast boundaries passed.');
