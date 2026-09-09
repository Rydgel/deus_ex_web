import {beginTouch,endTouch,isOverlapping} from './actor-touch.mjs';
const f=Math.fround;
/** Original IsBlockedBy controlled-player cylinder branch. */
export function playerBlockedBy(source,other,worldActor=source.worldActor){
 const flags=source.flags??0,otherFlags=other.flags??0;
 if(other===worldActor)return Boolean(flags&2);
 if(other.movingBrush)return Boolean(flags&2)&&Boolean(otherFlags&8);
 return Boolean(otherFlags&8)&&Boolean(flags&((other.controlledPlayer||other.projectile)?8:4));
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
