import { playerMove } from './player-move.mjs';
import { moveSmooth } from './move-smooth.mjs';
import { moveTranslatingMover } from './mover-move.mjs';
import { playerBlockedBy, checkPlayerEncroachment } from './check-encroachment.mjs';
import { beginTouch, endTouch, isOverlapping } from './actor-touch.mjs';
import { farMoveActor } from './relocation.mjs';
import { pointRegion, setActorZone, dryPlayerZoneCallbacks } from './zone.mjs';
import { scriptTrace } from './script-trace.mjs';
import { createSceneEvents } from './scene-events.mjs';
import { addPawn, removePawn } from './pawn-list.mjs';
import { finishMoverNotify, moverFinishBounds } from './mover-finish.mjs';
import { moveActorRiders } from './move-riders.mjs';
import { setBase as setActorBase } from './walking-callbacks.mjs';
import { collisionFlagsFrom, writeCollisionFlags } from './map-actor-native.mjs';

/** Compose independently evidenced routines for the declared dry player/door
 * scene. Unsupported script, RNG and startup branches remain explicit. */
export function bindPlayerScene(player,collision,{model,actors,nonColliding=[],zoneActors,levelValues,timeSeconds,surfaceTextures}) {
  const f=Math.fround;
  let source=player.collisionActor;
  const worldActor=collision.queries.levelInfo;
  worldActor.values={...levelValues};
  // Late-bound so the scene can route an unhandled actor event into the door
  // runtime's VM (the general scene-event router), which is created after this
  // scene (game.mjs wires it). See docs/scene-events.md.
  const hooks={dispatchEvent:null};
  const fixtureDispatch=createSceneEvents(()=>source,{deferMissionEvent:(target,event)=>{
    player.unimplementedPhysicsEffects.add(`${target.name}.${event} mission script`);
  },dispatchEvent:(target,event,args)=>{
    if(!hooks.dispatchEvent)throw Error(`Scene event dispatch is not linked: ${target?.name??'actor'}.${event}`);
    return hooks.dispatchEvent(target,event,args);
  }});
  // Live Play runs the original callback bodies, including player and trigger
  // overrides. The bounded Stage-2 callback fixture is only used before a VM
  // is linked; it must not catch/defer a failure on the live route.
  const dispatch=(target,event,args)=>hooks.dispatchEvent
    ? hooks.dispatchEvent(target,event,args)?.result : fixtureDispatch(target,event,args);
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
    actorLeaving(zone,actor){if(hooks.dispatchEvent)return dispatch(zone,'ActorLeaving',[actor]);zoneSupported(zone);if(actor===source)dry.actorLeaving(zone,actor);else if(!actor.movingBrush)unsupported('non-mover ActorLeaving');},
    actorEntered(zone,actor){if(hooks.dispatchEvent)return dispatch(zone,'ActorEntered',[actor]);zoneSupported(zone);if(actor===source)dry.actorEntered(zone,actor);else if(!actor.movingBrush)unsupported('non-mover ActorEntered');},
    zoneChange(actor,zone){if(hooks.dispatchEvent)return dispatch(actor,'ZoneChange',[zone]);zoneSupported(zone);if(actor===source)dry.zoneChange(actor,zone);else if(!actor.movingBrush)unsupported('non-mover ZoneChange');},
    footZoneChange:(actor,zone)=>hooks.dispatchEvent?dispatch(actor,'FootZoneChange',[zone]):dry.footZoneChange(actor,zone),
    headZoneChange:(actor,zone)=>hooks.dispatchEvent?dispatch(actor,'HeadZoneChange',[zone]):dry.headZoneChange(actor,zone),
  };
  const updateZone=(actor,test,force)=>setActorZone(actor,zoneWorld,test,force);
  const touch=(a,b)=>beginTouch(a,b,dispatch),untouch=(a,b,suppress)=>endTouch(a,b,suppress,dispatch);
  // The recursive rider MoveActor (bIgnoreBases=1) for one based actor.
  const riderMove=(other,riderDelta,riderRot)=>{
    if(other===source)return move(riderDelta,riderRot,{ignoreBases:true});
    if(other.isPawn){
      if(typeof hooks.movePawn!=='function')throw Error('map pawn rider MoveActor is not linked');
      return hooks.movePawn(other,riderDelta,riderRot,{ignoreBases:true});
    }
    if(typeof hooks.moveRider!=='function')throw Error('rider MoveActor is not linked');
    return hooks.moveRider(other,riderDelta,riderRot);
  };
  const ridersFor=base=>({
      actors:level.actors,
      baseOf:other=>other.base!==undefined?other.base:null,
      location:other=>other.position,
      rotation:other=>other.rotation??[0,0,0],
      isPawn:other=>Boolean(other.controlledPlayer||other.lineage?.includes('engine.pawn')),
      addViewRotationYaw:(other,dyaw)=>{
        if(!other.viewRotation)return;
        other.viewRotation=[other.viewRotation[0],(other.viewRotation[1]+dyaw)|0,other.viewRotation[2]];
      },
      moveActor:riderMove,
      actorLocation:()=>base.position,
      actorRotation:()=>base.rotation,
  });
  const move=(delta,rotation=null,{ignoreBases=false}={})=>playerMove(source,delta,{worldActor,ignoreBases,
    multiLineCheck:q=>collision.queries.multiLineCheck(q),removeActor:a=>collision.queries.removeActor(a),addActor:a=>collision.queries.addActor(a),
    dispatch,isBlockedBy:playerBlockedBy,isOverlapping,beginTouch:touch,endTouch:untouch,setActorZone:updateZone,
    // CreateKeyRing SetBase(Self) gives the player a based rider. The recovered
    // MoveActor rider section must run once StandingCount is nonzero.
    moveRiders:(src,finalDelta,rot)=>moveActorRiders(source,finalDelta,rot,ridersFor(source)),
  },rotation);
  player.nativeMove=move;
  const level={editor:false,netMode:0,actors:[worldActor,...actors,source],
    // Native graph slots read by native dispatch (Level.Model, null demo driver):
    // the original Play path has no demo recorder attached.
    model, demoRecDriver: null, timeSeconds,
    // UModel's transient FZoneProperties.LastRenderTime, separate from the
    // ZoneInfo actor field. Original BSP/portal visibility feedback remains
    // unsupported; never manufacture visible zones from a simulation tick.
    zoneLastRenderTimes:new Float32Array(model.zones.length),
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
    // FarMoveActor detaches based children (the key ring) through SetBase(child, None).
    setBase:(child,target,notify)=>setActorBase(child,target,dispatch,notify),setActorZone:updateZone,
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
  const moveMover=(mover,delta,rotation=null)=>{
    const result=moveTranslatingMover(mover,delta,{rotation,
      moveRiders:(riderDelta,riderRotation)=>moveActorRiders(mover,riderDelta,riderRotation,ridersFor(mover)),
      encroachmentCheck:(actor,position,rotation,extra)=>collision.queries.actorEncroachmentCheck(actor,position,rotation,extra).map(h=>h.actor),
      moveSmooth(actor,requested){
        if(actor!==source&&actor.isPawn){
          if(typeof hooks.moveSmoothPawn!=='function')throw Error('map pawn moveSmooth is not linked');
          return hooks.moveSmoothPawn(actor,requested);
        }
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
  // execMove forwards the live ULevel::MoveActor slot. The recovered brush
  // entry handles translations; rotation-changing/flagged branches stay explicit.
  level.moveActor=(actor,delta,rotation,hit,test,ignorePawns,ignoreBases,noFail)=>{
    // SetBasedPawnSize's Move and UpdateRotation's SetRotation use the same
    // zero-flag MoveActor entry. The latter's zero Delta still runs the rider
    // pass when picked-up inventory gives the player a StandingCount.
    if (actor === source && !test && !ignorePawns && !ignoreBases && !noFail)
      return move(delta,rotation).success;
    if (!actor.movingBrush && delta.every(value=>value===0)
        && !test && !ignorePawns && !ignoreBases && !noFail) {
      if(typeof hooks.rotateMapActor!=='function')throw Error('map SetRotation MoveActor is not linked');
      return hooks.rotateMapActor(actor,rotation).success;
    }
    // A map pawn's zero-flag MoveActor (ScriptedPawn.SetBasedPawnSize's Move)
    // runs the recovered body on its pawn physics view.
    if (actor.isPawn && !test && !ignorePawns && !ignoreBases && !noFail) {
      if(typeof hooks.movePawn!=='function')throw Error('map pawn MoveActor is not linked');
      return hooks.movePawn(actor,delta,rotation);
    }
    if (!actor.movingBrush || test || ignorePawns || ignoreBases || noFail)
      throw new Error('MoveActor scene branch is not linked');
    return moveMover(actor,delta,rotation);
  };

  const prepareActor=actor=>{
    const v=actor.values;
    actor.worldActor=worldActor;actor.touching=[0,1,2,3].map(i=>actors.find(a=>a.index===v[i?`Touching[${i}]`:'Touching'])??null);
    actor.isPawn=actor.lineage?.includes('engine.pawn')??false;
    actor.radius=v.CollisionRadius??0;actor.height=v.CollisionHeight??0;actor.rotation=v.Rotation??[0,0,0];
    actor.physics=v.Physics??0;actor.pawnFlags=v.bIsPlayer?2:0;actor.standingCount=v.StandingCount??0;
    actor.static=Boolean(v.bStatic);actor.movable=Boolean(v.bMovable);
    // Reload restores bDeleteMe before changeActor re-adds this map export;
    // AddActor otherwise correctly skips the previous session's dead actor.
    actor.actorFlags=((actor.actorFlags&~0x80)|(v.bDeleteMe?0x80:0))>>>0;
    // The +0x1dc word and its per-bit copies (map-actor-native.mjs). The
    // rebuilt hash registers every serialized collider, so the restored word
    // matches it; FarMoveActor's bJustTeleported/OldLocation return to the
    // serialized fields.
    writeCollisionFlags(actor,collisionFlagsFrom(v));
    if(!actor.isPawn&&!actor.movingBrush){delete actor.motionFlags;delete actor.oldLocation;}
    actor.waitingPawn=actors.find(a=>a.index===v.WaitingPawn)??null;
    actor.marker=actors.find(a=>a.index===v.MyMarker)??null;
    if(actor.movingBrush)updateZone(actor,false,true);
  };
  return {dispatch,level,hooks,
    // The LoadMap Login path retires the browser placeholder before original
    // SpawnActor allocates its replacement. Preserve map-export array slots.
    detachPlayerIdentity(){
      const old=source;
      collision.queries.removeActor(old);player.actorRegistered=false;
      removePawn(level,old);
      for(let i=0;i<level.actors.length;i++)if(level.actors[i]===old)level.actors[i]=null;
      for(const viewport of level.engine?.client?.viewports??[])if(viewport.actor===old)viewport.actor=null;
      if(collision.playerActor===old)collision.playerActor=null;
      return old;
    },
    bindPlayerIdentity(actor,values=player.defaults){
      player.bindCollisionIdentity(actor,values);
      source=actor;collision.playerActor=actor;
      Object.assign(actor,{worldActor,standingCount:values.StandingCount??0,touching:[null,null,null,null],
        isPawn:true,pawnFlags:values.bIsPlayer?2:0,
        actorFlags:(values.bStatic?1:0)|(values.bMovable?0x80000:0)|(values.bCollideWhenPlacing?0x20000:0),
        mass:values.Mass,warping:false,specialGoal:values.SpecialGoal??null});
      writeCollisionFlags(actor,collisionFlagsFrom(values));
      return actor;
    },
    reset(){
    worldActor.values={...levelValues};
    level.pawnList=null;
    // prepareActor restores serialized collision fields (radius/height) on
    // actors that registerActors already re-registered with their live
    // collisionValues transform — the hash requires the registered transform
    // to still be live at removal, so each restore runs inside changeActor's
    // remove-mutate-re-add (level-queries.mjs).
    for(const actor of actors)collision.queries.changeActor(actor,()=>prepareActor(actor));
    // Non-colliding exports reload outside the hash: drop a registration a
    // script's SetCollision added, then restore the serialized word.
    for(const actor of nonColliding){if(actor.flags&1)collision.queries.removeActor(actor);prepareActor(actor);}
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
