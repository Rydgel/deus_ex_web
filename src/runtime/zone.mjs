const f=Math.fround;
const initialRegion=zone=>({zone,leaf:-1,zoneNumber:0});

/** Original UModel.PointRegion103f5db0; zoneActors preserves Model.Zones order. */
export function pointRegion(model,position,levelInfo,zoneActors,numZones=zoneActors.length){
 if(!levelInfo)throw Error('PointRegion requires a LevelInfo fallback');
 if(!model.nodes.length)return initialRegion(levelInfo);
 const p=position.map(f);let index=0;
 for(let visits=0;visits<=model.nodes.length;visits++){
  const node=model.nodes[index];if(!node)throw Error('Invalid PointRegion BSP');
  const plane=node.plane,side=p[2]*plane[2]+p[1]*plane[1]+p[0]*plane[0]-plane[3]>=0?1:0;
  const next=side?node.front:node.back;
  if(next===-1){const zoneNumber=numZones?node.zones[side]:0;return {zone:zoneActors[zoneNumber]||levelInfo,leaf:node.leaves[side],zoneNumber};}
  index=next;
 }
 throw Error('Cyclic PointRegion BSP');
}

/** Original SetActorZone1039b940, ordinary Actor/Pawn route. Test suppresses events,
 * never region stores. World callbacks receive (zone,pawn), or (pawn,newZone)
 * for the pawn's ZoneChange/FootZoneChange/HeadZoneChange events.
 */
export function setActorZone(pawn,world,test=false,force=false){
 if(pawn.deleted)return;
 const isPawn=pawn.isPawn!==false;
 if(force){pawn.region=initialRegion(world.levelInfo);if(isPawn){pawn.footRegion=initialRegion(world.levelInfo);pawn.headRegion=initialRegion(world.levelInfo);}}
 const invoke=(name,...args)=>{if(typeof world[name]!=='function')throw Error(`SetActorZone requires ${name} callback`);world[name](...args);};
 const next=world.pointRegion(pawn.position.map(f));
 if(next.zone!==pawn.region.zone&&!test){
  invoke('actorLeaving',pawn.region.zone,pawn);invoke('zoneChange',pawn,next.zone);
  pawn.region={...next};invoke('actorEntered',next.zone,pawn);
 }else pawn.region={...next};
 if(!isPawn)return;
 const foot=world.pointRegion([f(pawn.position[0]),f(pawn.position[1]),f(pawn.position[2]-pawn.height)]);
 if(foot.zone!==pawn.footRegion.zone&&!test)invoke('footZoneChange',pawn,foot.zone);
 pawn.footRegion={...foot};
 const head=world.pointRegion([f(pawn.position[0]),f(pawn.position[1]),f(pawn.position[2]+pawn.baseEyeHeight)]);
 if(head.zone!==pawn.headRegion.zone&&!test)invoke('headZoneChange',pawn,head.zone);
 pawn.headRegion={...head};
 if(world.netMode!==3&&pawn.playerReplicationInfo)pawn.playerReplicationInfo.playerZone=pawn.region.zone;
}

const values=zone=>zone.values??zone;
function dry(...zones){if(zones.some(z=>values(z).bWaterZone||values(z).bPainZone))throw Error('Water/pain zone script effects are unsupported');}

/** Embedded ZoneInfo/Pawn/DeusExPlayer ordinary dry standalone script subset.
 * Bind only to audited ZoneInfo/LevelInfo/SkyZoneInfo instances and a JC pawn
 * in PlayerWalking. MakeNoise and any named zone event remain real callbacks.
 */
export function dryPlayerZoneCallbacks({timeSeconds,makeNoise,zoneEvent,traceWorld}={}){
 const count=(zone,pawn,delta)=>{
  dry(zone);const v=values(zone);v.ZonePlayerCount=((v.ZonePlayerCount??0)+delta)|0;
  if(v.ZonePlayerCount===(delta>0?1:0)&&v.ZonePlayerEvent){
   if(!zoneEvent)throw Error('ZonePlayerEvent requires original event dispatch');zoneEvent(zone,pawn,v.ZonePlayerEvent,delta>0);
  }
 };
 return {
  actorLeaving:(zone,pawn)=>count(zone,pawn,-1),
  actorEntered:(zone,pawn)=>count(zone,pawn,1),
  zoneChange(pawn,newZone){
   dry(pawn.region.zone,pawn.headRegion.zone,newZone);
   if(pawn.isCrouching){if(!traceWorld)throw Error('Crouched ZoneChange requires the original world trace');traceWorld(pawn.position.slice(),[pawn.position[0],pawn.position[1],f(pawn.position[2]-f(pawn.height+6))]);}
  },
  footZoneChange(pawn,newZone){
   dry(pawn.footRegion.zone,newZone,pawn.headRegion.zone);
   if(typeof timeSeconds!=='function')throw Error('FootZoneChange requires Level.TimeSeconds');
   const time=f(timeSeconds());
   if(f(time-f(pawn.splashTime??0))>f(.25)){
    pawn.splashTime=time;if(!makeNoise)throw Error('Dry FootZoneChange requires MakeNoise');makeNoise(pawn,pawn.physics===2?1:f(.3));
   }
  },
  headZoneChange(pawn,newZone){
   dry(pawn.headRegion.zone,newZone);
   const next=values(newZone),old=values(pawn.headRegion.zone);
   if(next.AmbientSound)next.SoundRadius=255;if(old.AmbientSound)old.SoundRadius=0;
  },
 };
}
