/** Focused execution of installed original bytecode, with explicit engine
 * service boundaries. No rendering, audio playback, or whole-game claim. */
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {refValue} from '../src/runtime/script-vm.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),files=[];
for(const name of await readdir(`${root}/System`))files.push({path:name,read:()=>readFile(`${root}/System/${name}`)});
const assets=new AssetStore(files),engine=await assets.get('Engine'),calls=[];
// The mover's PlaySound (264) is a recorded engine boundary here (no audio
// claim): this focused state-machine test owns 264 rather than running the full
// execActorPlaySound implementation, which needs the live level/index graph.
const runtime=new ScriptRuntime(assets,{boundaryNatives:[264],native:call=>{
  const args=Array.from({length:call.argumentCount},(_,i)=>refValue(call.evaluateArgument(i)));
  calls.push({index:call.index,args});
  if(call.index===3970){getRef(call.receiver,'Physics').set(args[0]);return;}
  if(call.index===264)return 0; // Sound engine boundary; no audio claim.
  if(call.index===301){runtime.instance(call.receiver).state.latent=302;return;}
  throw new Error(`Validation encountered unsupported native ${call.index}`);
}});
const cls=await runtime.loadClass(engine,engine.exportsByPath.get('mover'));
const actorClass=await runtime.loadClass(engine,engine.exportsByPath.get('actor'));
const mover={name:'Mover fixture'},other={name:'Other fixture'};
const state=runtime.attach(mover,cls);runtime.attach(other,actorClass);
const functions=new Map();
for(const path of ['actor.beginevent','actor.endevent','mover.triggertoggle.trigger','mover.interpolateto','mover.doopen','mover.doclose']){
  functions.set(path,await runtime.prepareFunction(engine,engine.exportsByPath.get(path)));
}
const stateNode=await runtime.prepareState(engine,engine.exportsByPath.get('mover.triggertoggle'));
state.setStateNode(stateNode);
function getRef(receiver,name){return runtime.fieldReference(receiver,runtime.lookupMember(runtime.instance(receiver).cls,'fields',name));}
async function set(receiver,name,value){const field=runtime.lookupMember(runtime.instance(receiver).cls,'fields',name);await runtime.field(field);runtime.fieldReference(receiver,field).set(value);}
for(const [name,value] of Object.entries({Location:[10,20,30],Rotation:[0,0,0],BasePos:[10,20,30],BaseRot:[0,0,0],MoveTime:1,KeyPos:[[0,0,0],[0,56,0],...Array.from({length:6},()=>[0,0,0])],Physics:9}))await set(mover,name,value);
const trigger=functions.get('mover.triggertoggle.trigger');
runtime.callFunction(trigger,mover,2,()=>other);
assert.equal(getRef(mover,'SavedTrigger').get(),other);
assert.equal(getRef(mover,'Instigator').get(),other);
assert.equal(state.execution.cursor,stateNode.labels.get('open'));
state.process(1/120);
assert.equal(state.latent,302);
assert.equal(getRef(mover,'bInterpolating').get(),true);
assert.equal(getRef(mover,'KeyNum').get(),1);
assert.equal(getRef(mover,'PhysRate').get(),1);
assert.deepEqual(getRef(mover,'OldPos').get(),[10,20,30]);
assert.deepEqual(getRef(mover,'SimInterpolate').get(),[0,100,1]);
// A second Trigger replaces the pending state continuation and executes the
// original reversal branch of InterpolateTo on the following state phase.
getRef(mover,'PhysAlpha').set(.25);
runtime.callFunction(trigger,mover,2,()=>other);
assert.equal(state.latent,0);
assert.equal(state.execution.cursor,stateNode.labels.get('close'));
state.process(1/120);
assert.equal(state.latent,302);
assert.equal(getRef(mover,'KeyNum').get(),0);
assert.equal(getRef(mover,'PhysAlpha').get(),.75);
assert.deepEqual(getRef(mover,'OldPos').get(),[10,76,30]);
assert.deepEqual(getRef(mover,'SimInterpolate').get(),[75,100,256]);
assert.deepEqual(calls.map(call=>call.index),[3970,264,301,3970,264,301]);
// Execute the same original state with its real DelayTime/Sleep branch. Poll
// wakes below half a tick and resumes DoOpen in that same ProcessState phase.
await set(mover,'DelayTime',.02);
state.gotoLabel('Open');state.process(1/120);
assert.equal(state.latent,384);
// Sleep's remaining time is Actor.LatentFloat (AActor+0xe0).
assert.equal(getRef(mover,'LatentFloat').get(),Math.fround(.02));
state.process(1/120);assert.equal(state.latent,384);
assert.equal(getRef(mover,'LatentFloat').get(),Math.fround(Math.fround(.02)-Math.fround(1/120)));
state.process(1/120);assert.equal(state.latent,302);
assert.equal(getRef(mover,'bDelaying').get(),false);
// Original native UFunction dispatch writes the same fields as script access.
const setTimer=await runtime.prepareFunction(engine,engine.exportsByPath.get('actor.settimer'));
runtime.callFunction(setTimer,other,2,index=>index===0?.25:false);
assert.equal(getRef(other,'TimerRate').get(),.25);
runtime.processActorScript(other,.25);
assert.equal(getRef(other,'TimerRate').get(),0);
assert.equal(getRef(other,'TimerCounter').get(),0);
const setInitialState=await runtime.prepareFunction(engine,engine.exportsByPath.get('actor.setinitialstate'));
runtime.processEvent(other,'SetInitialState');
assert.equal(runtime.instance(other).state.stateNode,null);
// CameraPoint's original auto Idle state begins at offset zero. Select its
// declared state and install that label without executing the next state phase.
const cameraClass=await runtime.loadClass(engine,engine.exportsByPath.get('camerapoint'));
const camera={name:'CameraPoint fixture'};
runtime.attach(camera,cameraClass);
const idle=await runtime.prepareState(engine,engine.exportsByPath.get('camerapoint.idle'));
const initialFrame=runtime.initExecution(camera);
assert.deepEqual(initialFrame.probeMask,[0xffffffff,0xffffffff]);
assert.equal(initialFrame.latent,undefined);
assert.ok(getRef(camera,'ObjectFlags').get()&0x02000000);
runtime.processEvent(camera,'SetInitialState');
assert.equal(runtime.instance(camera).state.stateNode,idle);
assert.equal(runtime.instance(camera).state.latent,0);
assert.equal(runtime.instance(camera).state.execution.cursor,0);
console.log('Original TriggerToggle → DoOpen/DoClose → InterpolateTo: parameter frames, linked fields, state labels, latent suspension and reversal passed.');
console.log('Original state Sleep branch, Actor.SetTimer and CameraPoint automatic initial-state selection passed.');
