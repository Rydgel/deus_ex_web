import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createPlayerSequenceFixture } from './native-player-sequence-fixture.mjs';
import { runScriptPawnPhysics } from '../src/runtime/script-pawn-physics.mjs';
import { pointRegion } from '../src/runtime/zone.mjs';

// Reuse the existing original sequence captures. ScriptRuntime.readNamed
// returns FVector copies, so this field store clones each vector read and
// write; returning mutable fixture arrays would hide discarded component
// assignments in native-derived physics code. Script events retain the same
// explicit no-op boundary as native-player-sequence-oracle.py.
const folders=['00_Training','01_NYC_UNATCOIsland','00_Training-stairs'];
let totalFrames=0,totalQueries=0;
for(const folder of folders){
 const dir=`reports/movement/player-sequence/${folder}`;
 const scene=JSON.parse(await readFile(`${dir}/scene.json`,'utf8'));
 const cases=JSON.parse(await readFile(`${dir}/cases.json`,'utf8'));
 const oracle=JSON.parse(await readFile(`${dir}/original.json`,'utf8'));
 for(let ci=0;ci<cases.length;ci++){
  const c=cases[ci],expected=oracle.results[ci]; if(expected.unsupported)continue;
  const {player,collision}=createPlayerSequenceFixture(scene),actor=player.collisionActor,values=actor.values;
  actor.lineage=['deusex.jcdentonmale','engine.playerpawn','engine.pawn','engine.actor'];
  values.Player={};
  const world=collision.queries.levelInfo;world.values={...scene.zoneValues};
  const zoneActors=scene.zones.map(name=>name?collision.actors.find(a=>a.id===name)??null:null);
  // The fixture's typed model (scene.json holds the object form)
  const model=collision.bsp.model;
  const level={hash:collision.queries,model,netMode:0,surfaceTexture:scene.textures,
    pointRegion:p=>pointRegion(model,p,world,zoneActors)};
  const aliases={
   Location:['position',v=>v],Rotation:['rotation',v=>v],Velocity:['velocity',v=>v],
   Physics:['physics',v=>Number(v)],Base:['base',v=>v],OldLocation:['oldLocation',v=>v],
   CollisionRadius:['radius',v=>v],CollisionHeight:['height',v=>v],BaseEyeHeight:['baseEyeHeight',v=>v],EyeHeight:['eyeHeight',v=>v],
  };
  const field=(obj,name)=>({get(){
    if(obj===actor&&aliases[name]){const value=obj[aliases[name][0]];return Array.isArray(value)?value.map(Math.fround):value;}
    if(obj===actor&&name==='Region')return {'engine.actor.pointregion.zone':obj.region.zone,'engine.actor.pointregion.ileaf':obj.region.leaf,'engine.actor.pointregion.zonenumber':obj.region.zoneNumber};
    if(obj===actor&&name==='FootRegion')return {'engine.actor.pointregion.zone':obj.footRegion.zone,'engine.actor.pointregion.ileaf':obj.footRegion.leaf,'engine.actor.pointregion.zonenumber':obj.footRegion.zoneNumber};
    if(obj===actor&&name==='HeadRegion')return {'engine.actor.pointregion.zone':obj.headRegion.zone,'engine.actor.pointregion.ileaf':obj.headRegion.leaf,'engine.actor.pointregion.zonenumber':obj.headRegion.zoneNumber};
    const value=obj.values?.[name];return Array.isArray(value)?value.map(Math.fround):value;
   },set(value){
    if(obj===actor&&aliases[name]){obj[aliases[name][0]]=aliases[name][1](value);return;}
    if(obj===actor&&['Region','FootRegion','HeadRegion'].includes(name)){
      const key=name[0].toLowerCase()+name.slice(1);obj[key]={zone:value['engine.actor.pointregion.zone']??null,leaf:value['engine.actor.pointregion.ileaf']??-1,zoneNumber:value['engine.actor.pointregion.zonenumber']??0};return;
    }
    (obj.values??=Object.create(null))[name]=Array.isArray(value)?value.map(Math.fround):value;
   }});
  const services={field,read:(obj,n)=>field(obj,n).get(),write:(obj,n,v)=>field(obj,n).set(Array.isArray(v)?v.map(Math.fround):v),
   isA:(obj,n)=>Boolean(obj?.lineage?.includes(n)),level,worldActor:world,
   zoneFields:z=>z?.values??z??{},dispatch:()=>undefined,isProbing:()=>false,
   moveRider:()=>{throw Error('unexpected rider in sequence fixture')},random:()=>player.nativeRandom()};
  collision.queries.changeActor(actor,()=>{actor.position=c.position.map(Math.fround);actor.height=Math.fround(c.height??43);actor.radius=20;}); actor.velocity=(c.velocity??[0,0,0]).map(Math.fround);
  actor.physics=c.physics??1;
  actor.oldLocation=[...actor.position];actor.base=world;actor.baseEyeHeight=values.BaseEyeHeight;
  values.Acceleration=(c.acceleration??[0,0,0]).map(Math.fround);
  values.GroundSpeed=Math.fround(c.groundSpeed??values.GroundSpeed);
  values.AvgPhysicsTime=0;values.MoveTimer=0;values.PendingTouch=null;values.Destination??=[0,0,0];values.DesiredRotation??=[0,0,0];
  // Native query oracle records line calls by method plus returned hit.
  const query=[];const line=level.hash.lineCheck.bind(level.hash);
  level.hash.lineCheck=(start,end,extent,flags,extra=0,source)=>{const hit=line(start,end,extent,flags,extra,source);query.push({start:[...start],end:[...end],extent:[...extent],flags,extra,time:hit.time,normal:hit.normal,actor:hit.actor===world?'$world':hit.actor?.id??hit.actor?.name??null});return hit;};
  for(let fi=0;fi<c.frames;fi++){
    runScriptPawnPhysics(actor,c.dt,services);
   const actual={position:actor.position,velocity:actor.velocity,physics:actor.physics},want=Object.fromEntries(['position','velocity','physics'].map(k=>[k,expected.frames[fi][k]]));
   assert.deepEqual(actual,want,`${folder}/${c.name} frame ${fi}`);
  }
  const nativeLines=expected.queries.filter(q=>q.line).map(q=>{const out={...q.line,time:q.result.time,normal:q.result.normal,actor:q.result.actor};delete out.source;if(!out.actor)delete out.normal;return out;});
  const actualLines=query.map(q=>{const out={...q};if(!out.actor)delete out.normal;return out;});
  assert.deepEqual(actualLines,nativeLines,`${folder}/${c.name} line queries`);
  totalFrames+=c.frames;totalQueries+=query.length;
  console.log(`${folder}/${c.name}: ${c.frames} frames, ${query.length} line queries matched`);
 }
}
console.log(JSON.stringify({totalFrames,totalQueries}));
