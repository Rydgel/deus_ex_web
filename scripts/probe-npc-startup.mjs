/** Startup-chain probe: run the recovered LoadMap event order for one NPC
 * against the live Play host, preparing functions on demand and reporting the
 * exact remaining boundary. Not a validator — an investigation tool. */
import {readdir,readFile} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(`${root}/${directory}`))
    files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1});
const runtime=game.doors.scriptRuntime.runtime,level=runtime.levelFor(game.player.collisionActor);
level.engine.client.decals=true;
const get=(actor,name)=>runtime.namedReference(actor,name).get();
const set=(actor,name,value)=>runtime.namedReference(actor,name).set(value);

const actorName=process.argv[2]??'jaimereyes0';
const actor=await runtime.objects.resolve(asset,asset.exportsByPath.get(actorName.toLowerCase()));
console.log('actor:',actor.name,'class:',runtime.instance(actor).cls.record.key);

// Prepare-on-demand driver: when the VM reports an unprepared original
// function or state, prepare it and retry. Bounded iteration.
const prepared=new Set();
async function prepareKey(key){
  if(prepared.has(key))return false;prepared.add(key);
  const dot=key.indexOf('.'),rest=key.slice(dot+1),pkg=key.slice(0,dot);
  const original=await assets.get(pkg==='deusex'?'DeusEx':pkg[0].toUpperCase()+pkg.slice(1));
  const index=original.exportsByPath.get(rest);
  if(!index){console.log('  cannot resolve export for',key);return false;}
  const record=await runtime.objects.resolve(original,index);
  if(record.kind==='State')await runtime.prepareState(original,index);
  else await runtime.prepareFunction(original,index);
  console.log('  prepared',key);
  return true;
}
async function runEvent(name){
  for(let attempt=0;attempt<40;attempt++){
    try{runtime.processEvent(actor,name);return {ok:true};}
    catch(error){
      const m=String(error.message);
      const fm=m.match(/Original (?:function|event|state) is not prepared: ([a-z0-9._]+)/i);
      if(fm&&await prepareKey(fm[1]))continue;
      return {ok:false,error:m};
    }
  }
  return {ok:false,error:'prepare loop did not converge'};
}

// Isolated fixture state like the boundary validator: original serialized
// empty PawnList (Play pre-populates it for collision/perception).
for(const a of level.actors.filter(a=>a?.lineage?.includes('engine.pawn')))set(a,'NextPawn',null);
level.pawnList=null;

const inst=runtime.instance(actor);
// The VM advances the state cursor before dispatch, so a "not prepared" throw
// inside state code would skip that statement permanently on retry — and a
// state transition that throws inside BeginState sets the state node before
// the event dispatch, so a retry skips BeginState entirely. The original
// links everything at load; pre-prepare every scripted method and state on
// the class chain BEFORE running the startup events.
const prepareMember=async method=>{
  if(method.kind==='State'||method.function)return;
  const index=method.asset.exportsByPath.get(method.key.slice(method.key.indexOf('.')+1));
  if(index!=null){await runtime.prepareFunction(method.asset,index);console.log('  prepared',method.key);}
};
for(let cls=inst.cls;cls&&cls.record.key!=='core.object';cls=cls.base){
  for(const method of cls.methods?.values()??[])await prepareMember(method);
  for(const state of cls.states?.values()??[]){
    if(state.kind!=='State')continue;
    const node=await runtime.prepareState(state.asset,state.asset.exportsByPath.get(state.key.slice(state.key.indexOf('.')+1)));
    console.log('  prepared state',state.key);
    for(const method of node.methods?.values()??[])await prepareMember(method);
  }
}

for(const phase of ['InitExecution','PreBeginPlay','BeginPlay','PostBeginPlay','SetInitialState','PostPostBeginPlay']){
  if(phase==='InitExecution'){runtime.initExecution(actor);console.log('InitExecution OK');continue;}
  const r=await runEvent(phase);
  if(!r.ok){console.log(`${phase} FAILED: ${r.error}`);break;}
  console.log(`${phase} OK`);
}
console.log('--- state ---');
for(const n of ['bInitialized','Physics','AnimSequence','AnimFrame','AnimRate','TweenTime','Orders','OrderActor','bDeleteMe','Shadow','ConListItems','state']){
  try{
    const v=get(actor,n);
    console.log(n+':',v?.name??v?.key??v);
  }catch(e){console.log(n+': <'+e.message.slice(0,60)+'>');}
}
console.log('stateNode:',inst.state?.stateNode?.record?.key,'latent:',inst.state?.latent,'code:',inst.state?.code);
// Mesh payload: the Play host decodes the LodMesh when the NPC preview is
// built; prepare it here so animation natives can resolve sequences.
await runtime.prepareMesh(actor);
// Full standalone Actor.Tick (animation phase before ProcessState, like the
// original). The level adapter inherits the live scene level's actor/model/
// pawnList fields and exposes ULevel::TimeSeconds as the original double.
const sceneLevel=runtime.levelFor(actor);
const unsupportedTick=name=>{throw new Error(`Standalone Actor.Tick service not linked: ${name}`);};
const tickLevel=Object.create(sceneLevel);
Object.assign(tickLevel,{netMode:0,demoRecDriver:null,tickTag:0,deferredHead:null,inTick:0});
Object.defineProperty(tickLevel,'timeSeconds',{get:()=>sceneLevel.timeSeconds()});
tickLevel.zoneLastRenderTime=()=>unsupportedTick('zone LastRenderTime');
const tickOptions={level:tickLevel,tickType:2,
  allocateDeferredActor:()=>unsupportedTick('deferred actor allocation'),
  readInput:()=>unsupportedTick('player input'),
  farMoveActor:()=>unsupportedTick('farMoveActor'),
};
const ticks=Number(process.argv[3]??20);
for(let i=0;i<ticks;i++){
  try{
    runtime.processActorTick(actor,1/60,tickOptions);
  }catch(error){
    const m=String(error.message);
    const fm=m.match(/Original (?:function|event|state) is not prepared: ([a-z0-9._]+)/i);
    if(fm&&await prepareKey(fm[1])){i--;continue;}
    console.log(`tick ${i} FAILED: ${m}`);break;
  }
  if(i%20===19||i<12)console.log(`tick ${i}: z=${get(actor,'Location')?.[2]?.toFixed(3)} vz=${get(actor,'Velocity')?.[2]?.toFixed(2)} phys=${get(actor,'Physics')} base=${get(actor,'Base')?.name??get(actor,'Base')} seq=${get(actor,'AnimSequence')?.name??get(actor,'AnimSequence')} frame=${get(actor,'AnimFrame')} state=${inst.state?.stateNode?.record?.key} latent=${inst.state?.latent}`);
}
console.log('--- after ticks ---');
for(const n of ['bInitialized','Physics','AnimSequence','AnimFrame','AnimRate','AnimTween','TweenTime','bPlaying','Orders','OrderActor','bDeleteMe','ConListItems']){
  try{console.log(n+':',get(actor,n)?.name??get(actor,n)?.key??get(actor,n));}catch(e){console.log(n+': <'+e.message.slice(0,60)+'>');}
}
console.log('stateNode:',inst.state?.stateNode?.record?.key,'latent:',inst.state?.latent);
