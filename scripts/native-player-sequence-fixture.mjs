/** Physics-only counterpart of native-player-sequence-oracle.py.
 * The oracle loads the serialized collision scene, not LoadMap/actor startup;
 * its script-event leaf does not execute gameplay. Keep that same boundary
 * here instead of constructing an unrelated complete script world per case.
 */
import {CollisionWorld} from '../src/runtime/collision.mjs';
import {Player} from '../src/runtime/player.mjs';
import {bindPlayerScene} from '../src/runtime/player-scene.mjs';
import {createNativeRng} from '../src/runtime/rng.mjs';
import {typedSceneModels} from './native-model.mjs';
import {modelFromObjects} from '../src/unreal/bsp-model.mjs';

export function createPlayerSequenceFixture(saved) {
  const scene=structuredClone(saved);
  typedSceneModels(scene);
  // The sequence oracle supplies Model.Zones separately from nativeModel's
  // geometry projection; null zone actors resolve to its LevelInfo fallback.
  scene.model.zones=modelFromObjects({zones:scene.zones.map(()=>({}))}).zones;
  const collision=new CollisionWorld(scene.model);
  const savedPlayer=scene.actors.find(actor=>actor.id==='$player');
  if(!savedPlayer)throw new Error('Sequence scene requires its original $player fixture');
  const actors=scene.actors.filter(actor=>actor!==savedPlayer);
  const byId=new Map(actors.map(actor=>[actor.id,actor]));
  for(const actor of actors){
    const values=actor.values;
    actor.name=actor.id;
    actor.className=actor.lineage?.[0]?.split('.').at(-1)??actor.kind;
    actor.lineage??=['engine.actor',...(actor.kind==='Pawn'?['engine.pawn']:actor.kind==='Mover'?['engine.mover','engine.brush']:[])];
    actor.position=[...values.Location];actor.rotation=values.Rotation??[0,0,0];
    actor.radius=values.CollisionRadius??0;actor.height=values.CollisionHeight??0;
    actor.movingBrush=Boolean(actor.model);actor.projectile=false;actor.blocking=Boolean(actor.collisionBits&8);
    actor.owner=byId.get(actor.owner)??null;actor.base=null;
    actor.flags=actor.collisionBits;
    if(actor.movingBrush)collision.movers.push(actor);else collision.actors.push(actor);
  }
  collision.registerActors(actors);
  const player=new Player(collision,scene.pawnValues,savedPlayer.values.Location,()=>scene.zoneValues);
  Object.assign(player.collisionActor,{id:'$player',name:'$player',lineage:['deusex.jcdentonmale','engine.playerpawn','engine.pawn','engine.actor'],
    values:{...scene.pawnValues,get Location(){return player.position;},get CollisionRadius(){return player.radius;},
      get CollisionHeight(){return player.height;},get Velocity(){return player.velocity;}}});
  const world=collision.queries.levelInfo;
  const zones=scene.zones.map(name=>name?{name,className:'ZoneInfo',values:{}}:null);
  const bound=bindPlayerScene(player,collision,{model:scene.model,actors,zoneActors:zones,
    levelValues:scene.zoneValues,timeSeconds:()=>0,surfaceTextures:scene.textures});
  // Original oracle event trampoline is a no-op. No VM, actor startup, or
  // trigger activation may alter these isolated native physics inputs.
  bound.hooks.dispatchEvent=()=>({handled:true,result:undefined});
  bound.reset();
  // native-mover-move-oracle installs +0x28=0x80000 on every fixture actor;
  // NativeLevel installs exactly collisionBits, without inferring defaults.
  for(const actor of [...actors,player.collisionActor]){
    actor.actorFlags=0x80000;actor.static=false;actor.movable=true;
    if(actor!==player.collisionActor)actor.base=null;
    actor.standingCount=0;actor.touching=[null,null,null,null];
    actor.flags=actor===player.collisionActor?savedPlayer.collisionBits:actor.collisionBits;
    actor.pawnFlags=actor===player.collisionActor?0x1002:0;
    actor.motionFlags=0;
  }
  player.nativeRandom=createNativeRng(1).frand;
  player.textureForHit=hit=>{
    if(hit.actor!==world||hit.primitive!==scene.model)return null;
    if(!scene.model.nodes.has(hit.item))throw new Error('Original world ray returned an invalid surface node');
    return scene.textures[scene.model.nodes.surface(hit.item)]??null;
  };
  return {player,collision};
}
