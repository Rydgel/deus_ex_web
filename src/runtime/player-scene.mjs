import { playerMove } from './player-move.mjs';
import { moveSmooth } from './move-smooth.mjs';
import { moveTranslatingMover } from './mover-move.mjs';
import { playerBlockedBy, checkPlayerEncroachment } from './check-encroachment.mjs';
import { beginTouch, endTouch, isOverlapping } from './actor-touch.mjs';
import { farMoveActor } from './relocation.mjs';
import { pointRegion, setActorZone, dryPlayerZoneCallbacks } from './zone.mjs';
import { scriptTrace } from './script-trace.mjs';
import { createSceneEvents } from './scene-events.mjs';
import { addPawn } from './pawn-list.mjs';
import { finishMoverNotify, moverFinishBounds } from './mover-finish.mjs';

/** Compose independently evidenced routines for the declared dry player/door
 * scene. Unsupported script, RNG and startup branches remain explicit. */
export function bindPlayerScene(player,collision,{model,actors,zoneActors,levelValues,timeSeconds,surfaceTextures}) {
  const f=Math.fround,source=player.collisionActor;
  const worldActor=collision.queries.levelInfo;
  worldActor.values={...levelValues};
  // Late-bound so the scene can route an unhandled actor event into the door
  // runtime's VM (the general scene-event router), which is created after this
  // scene (game.mjs wires it). See docs/scene-events.md.
  const hooks={dispatchEvent:null};
  const dispatch=createSceneEvents(source,{deferMissionEvent:(target,event)=>{
    player.unimplementedPhysicsEffects.add(`${target.name}.${event} mission script`);
  },dispatchEvent:(target,event,args)=>{
    if(!hooks.dispatchEvent)throw Error(`Scene event dispatch is not linked: ${target?.name??'actor'}.${event}`);
    return hooks.dispatchEvent(target,event,args);
  }});
  const unsupported=name=>{throw Error(`Unsupported original scene callback: ${name}`);};
  const dry=dryPlayerZoneCallbacks({timeSeconds,
    makeNoise:()=>unsupported('MakeNoise on zone transition'),
    zoneEvent:()=>unsupported('ZonePlayerEvent'),
    traceWorld:(start,end)=>scriptTrace(collision.queries,source,end,start,false),
  });
  const zoneSupported=zone=>{
    if(zone!==worldActor&&!['ZoneInfo','LevelInfo','SkyZoneInfo','WaterZone'].includes(zone.className))unsupported(`${zone.name} zone class`);
  };
  const zoneWorld={levelInfo:worldActor,netMode:0,
    pointRegion:position=>pointRegion(model,position,worldActor,zoneActors),
    actorLeaving(zone,actor){zoneSupported(zone);if(actor===source)dry.actorLeaving(zone,actor);else if(!actor.movingBrush)unsupported('non-mover ActorLeaving');},
    actorEntered(zone,actor){zoneSupported(zone);if(actor===source)dry.actorEntered(zone,actor);else if(!actor.movingBrush)unsupported('non-mover ActorEntered');},
    zoneChange(actor,zone){zoneSupported(zone);if(actor===source)dry.zoneChange(actor,zone);else if(!actor.movingBrush)unsupported('non-mover ZoneChange');},
    footZoneChange:dry.footZoneChange,headZoneChange:dry.headZoneChange,
  };
  const updateZone=(actor,test,force)=>setActorZone(actor,zoneWorld,test,force);
  const touch=(a,b)=>beginTouch(a,b,dispatch),untouch=(a,b,suppress)=>endTouch(a,b,suppress,dispatch);
  const move=delta=>playerMove(source,delta,{worldActor,
    multiLineCheck:q=>collision.queries.multiLineCheck(q),removeActor:a=>collision.queries.removeActor(a),addActor:a=>collision.queries.addActor(a),
    dispatch,isBlockedBy:playerBlockedBy,isOverlapping,beginTouch:touch,endTouch:untouch,setActorZone:updateZone,
  });
  player.nativeMove=move;
  const level={editor:false,netMode:0,actors:[worldActor,...actors,source],
    // Native graph slots read by native dispatch (Level.Model, null demo driver):
    // the original Play path has no demo recorder attached.
    model, demoRecDriver: null, timeSeconds,
    // Per-surface texture records (walkingSurfaceTextures) for native 1000's
    // hit.Item -> Model->Surfs[iSurf] material lookup.
    surfaceTexture: surfaceTextures,
    // ULevel::SpawnActor asks the live level for the same BSP PointRegion used
    // by ordinary movement when it initializes a spawned actor's Region.
    pointRegion:position=>pointRegion(model,position,worldActor,zoneActors),
    get hash(){return collision.queries;},
    findSpot(extent,position,checkActors,checkFirst){
      const fitted=collision.findSpot(position,extent,checkActors,checkFirst);
      if(fitted)position.splice(0,3,...fitted);return Boolean(fitted);
    },
    checkEncroachment:(actor,position,rotation,notify)=>checkPlayerEncroachment(actor,position,rotation,notify,
      {worldActor,encroachmentCheck:(...args)=>collision.queries.actorEncroachmentCheck(...args),dispatch}),
    setBase:()=>unsupported('FarMoveActor detaching player passengers'),setActorZone:updateZone,
  };
  collision.playerActor=source;
  collision.doorCallbacks={dispatch,
    playSound:(door,name)=>{player.unimplementedPhysicsEffects.add(`${door.actor.name}.${name} audio`);},
    finishNotify:(door)=>{
      const mover=door.actor,state=mover.interpolation,v=mover.values;
      Object.assign(mover,{numKeys:v.NumKeys,encroachType:v.MoverEncroachType,key:state.key,
        basePosition:state.basePosition,baseRotation:state.rotation,keyPositions:state.keyPositions,
        keyRotations:[v.KeyRot??[0,0,0],v['KeyRot[1]']??[0,0,0]]});
      finishMoverNotify(mover,level,{dispatch,
        getBoundingBox:(actor,exact,position,rotation)=>moverFinishBounds(actor.model,actor.collisionValues??actor.values,position,rotation)});
    },
  };
  player.nativeFarMove=(pawn,position,test,noCheck)=>{
    const success=farMoveActor(level,source,position,test,noCheck);
    pawn.position=player.position.slice();pawn.justTeleported=Boolean(source.motionFlags&0x100);
    return success;
  };
  const moveMover=(mover,delta)=>{
    const result=moveTranslatingMover(mover,delta,{
      encroachmentCheck:(actor,position,rotation,extra)=>collision.queries.actorEncroachmentCheck(actor,position,rotation,extra).map(h=>h.actor),
      moveSmooth(actor,requested){
        if(actor!==source)unsupported(`${actor.name}.moveSmooth`);
        return moveSmooth(actor,requested,{dispatch,moveActor:(target,movement)=>{
          const r=move(movement);return {result:r.success,time:r.time,normal:r.hit?.normal??[0,0,0],actor:r.hit?.actor??null};
        }});
      },dispatch,removeActor:a=>collision.queries.removeActor(a),addActor:a=>collision.queries.addActor(a),
    });
    if(result&&!delta.every(v=>Math.abs(f(v))<.0001)){
      for(let i=0;i<4;i++){const other=mover.touching[i];if(other&&!isOverlapping(mover,other))untouch(mover,other,false);}
      updateZone(mover,false,false);
    }
    mover.collider.offset=mover.position.map((v,i)=>f(v-mover.values.Location[i]));
    return result;
  };
  collision.moveMover=moveMover;
  const prepareActor=actor=>{
    const v=actor.values;
    actor.worldActor=worldActor;actor.touching=[0,1,2,3].map(i=>actors.find(a=>a.index===v[i?`Touching[${i}]`:'Touching'])??null);
    actor.isPawn=actor.lineage?.includes('engine.pawn')??false;
    actor.radius=v.CollisionRadius??0;actor.height=v.CollisionHeight??0;actor.rotation=v.Rotation??[0,0,0];
    actor.physics=v.Physics??0;actor.pawnFlags=v.bIsPlayer?2:0;actor.standingCount=v.StandingCount??0;
    actor.static=Boolean(v.bStatic);actor.movable=Boolean(v.bMovable);
    actor.collideWorld=Boolean(v.bCollideWorld);actor.collideActors=Boolean(v.bCollideActors);
    actor.blockPlayers=Boolean(v.bBlockPlayers);actor.blockActors=Boolean(v.bBlockActors);
    actor.waitingPawn=actors.find(a=>a.index===v.WaitingPawn)??null;
    actor.marker=actors.find(a=>a.index===v.MyMarker)??null;
    if(actor.movingBrush)updateZone(actor,false,true);
  };
  return {dispatch,level,hooks,reset(){
    worldActor.values={...levelValues};
    level.pawnList=null;
    for(const actor of actors)prepareActor(actor);
    for(const actor of actors)if(actor.isPawn)addPawn(level,actor);
    Object.assign(source,{worldActor,standingCount:0,touching:[null,null,null,null],isPawn:true,pawnFlags:2,
      actorFlags:(player.defaults.bStatic?1:0)|(player.defaults.bMovable?0x80000:0)|(player.defaults.bCollideWhenPlacing?0x20000:0),
      collideWorld:Boolean(source.flags&2),collideActors:Boolean(source.flags&1),motionFlags:player.defaults.bJustTeleported?0x100:0,
      mass:player.defaults.Mass,warping:false,specialGoal:null});
    collision.queries.addActor(source);player.actorRegistered=true;
    addPawn(level,source);
    updateZone(source,false,true);
  }};
}
