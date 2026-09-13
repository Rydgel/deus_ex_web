import {beginTouch,endTouch,isOverlapping} from './actor-touch.mjs';
const f=Math.fround;
/** Original IsBlockedBy controlled-player cylinder branch. */
export function playerBlockedBy(source,other,worldActor=source.worldActor){
 const flags=source.flags??0,otherFlags=other.flags??0;
 if(other===worldActor)return Boolean(flags&2);
 if(other.movingBrush)return Boolean(flags&2)&&Boolean(otherFlags&8);
 return Boolean(otherFlags&8)&&Boolean(flags&((other.controlledPlayer||other.projectile)?8:4));
}
/** Original IsBlockedBy1034c5e0 for a non-Brush source, including the
 * non-player branch the controlled-player specialization short-circuits.
 * The source side tests bCollideWorld (bit 0x2) against the world/brush
 * target; each ordinary-actor side picks its bBlockPlayers bit (0x8) when
 * the opposite actor is a controlled player or Projectile ancestry,
 * otherwise its bBlockActors bit (0x4).  Both direction tests must pass.
 * Brush sources keep the separate moving-brush entry (moverBlockedBy). */
export function actorBlockedBy(source,other,{worldActor=source.worldActor,
 isPlayerControlled=a=>Boolean(a?.controlledPlayer),isProjectile=a=>Boolean(a?.projectile),
 isBrush=a=>Boolean(a?.movingBrush)}={}){
 const flags=source.flags??0,otherFlags=other.flags??0;
 if(other===worldActor)return Boolean(flags&2);
 if(isBrush(other))return Boolean(flags&2)&&
   Boolean(otherFlags&(isPlayerControlled(source)||isProjectile(source)?8:4));
 if(isBrush(source))throw new Error('Brush CheckEncroachment sources use the mover helper');
 const otherBlocks=otherFlags&(isPlayerControlled(source)||isProjectile(source)?8:4);
 if(!otherBlocks)return false;
 return Boolean(flags&(isPlayerControlled(other)||isProjectile(other)?8:4));
}
/** Original CheckEncroachment1039a350 for a controlled player cylinder.
 * Returns true on rejection. Script effects are synchronous explicit callbacks. */
export function checkPlayerEncroachment(source,position,rotation,notify,{worldActor=source.worldActor,encroachmentCheck,dispatch,
 beginTouch:begin=(a,b)=>beginTouch(a,b,dispatch),endTouch:end=(a,b,suppress)=>endTouch(a,b,suppress,dispatch),isOverlapping:overlap=isOverlapping}){
 if(!source?.controlledPlayer||source.movingBrush)throw Error('CheckEncroachment entry requires a controlled player cylinder');
 if(!((source.flags??0)&0x0d))return false;
 const hits=encroachmentCheck(source,position.map(f),rotation.map(v=>v|0),0);
 const valid=other=>other!==source&&other!==worldActor;
 for(const hit of hits){const other=hit.actor;
  if(valid(other)&&playerBlockedBy(source,other,worldActor)&&dispatch(source,'EncroachingOn',[other]))return true;
 }
 if(notify){
  if(!Array.isArray(source.touching)||source.touching.length!==4)throw Error('Original Touching requires four explicit slots');
  for(let i=0;i<4;i++){const other=source.touching[i];if(other&&!overlap(source,other))end(source,other,false);}
 }
 for(const hit of hits){const other=hit.actor;if(!valid(other))continue;
  if(playerBlockedBy(source,other,worldActor))dispatch(other,'EncroachedBy',[source]);
  else if(notify)begin(source,other);
 }
 return false;
}

/** Original CheckEncroachment1039a350 for a non-player, non-Brush source
 * (e.g. a spawned Inventory actor). The query is the same hash extent check
 * the player specialization runs: the +0x1dc & 0x0d early return still comes
 * first, and a Brush source falls back to its own mover gate instead of this
 * entry. Both hit passes use the full IsBlockedBy (actorBlockedBy): loop one
 * dispatches EncroachingOn on the source and rejects on a true result, loop
 * two dispatches EncroachedBy on each blocking actor — or BeginTouch when the
 * notify argument is set. The native mover-push sub-branch (other.moveSmooth
 * plus the re-query) only runs for a non-static Mover source, so it is an
 * explicit error here rather than a silent skip. */
export function checkActorEncroachment(source,position,rotation,notify,{worldActor=source.worldActor,encroachmentCheck,dispatch,
 beginTouch:begin=(a,b)=>beginTouch(a,b,dispatch),
 endTouch:end=(a,b,suppress)=>endTouch(a,b,suppress,dispatch),isOverlapping:overlap=isOverlapping}={}){
 const flags=source.flags??0;
 if(!(flags&0xd)){
  const brush=source.model??source.brush??null;
  if(!brush)return false;
  if(!source.movingBrush||((source.actorFlags??0)&1))return false;
  throw Error('CheckEncroachment for a Brush source is not implemented');
 }
 if(source?.movingBrush)throw Error('Brush CheckEncroachment sources use the mover helper');
 const hits=encroachmentCheck(source,position.map(f),rotation.map(v=>v|0),0)??[];
 const valid=other=>other!==source&&other!==worldActor;
 const blocked=other=>actorBlockedBy(source,other,{worldActor});
 for(const hit of hits){const other=hit.actor;
  if(valid(other)&&blocked(other)&&dispatch(source,'EncroachingOn',[other]))return true;
 }
 if(notify){
  if(!Array.isArray(source.touching)||source.touching.length!==4)throw Error('Original Touching requires four explicit slots');
  for(let i=0;i<4;i++){const other=source.touching[i];if(other&&!overlap(source,other))end(source,other,false);}
 }
 for(const hit of hits){const other=hit.actor;if(!valid(other))continue;
  if(blocked(other))dispatch(other,'EncroachedBy',[source]);
  else if(notify)begin(source,other);
 }
 return false;
}

/** Original IsBlockedBy1034c5e0 for a Brush source. World/other-Brush tests
 * precede the source-Brush branch. Non-Pawn targets are legal. */
export function moverBlockedBy(source,other,worldActor=source.worldActor){
 if(!source.movingBrush)throw Error('Mover blocking predicate requires original Brush primitive/ancestry');
 const collisionFlags=a=>a.flags??((a.collideWorld?2:0)|(a.blockActors?4:0)|(a.blockPlayers?8:0));
 const flags=collisionFlags(source),otherFlags=collisionFlags(other);
 if(other===worldActor||other.world)return Boolean(flags&2);
 if(other.movingBrush)return Boolean(flags&2)&&Boolean(otherFlags&4);
 return Boolean(otherFlags&2)&&Boolean(flags&(other.controlledPlayer?8:4));
}
