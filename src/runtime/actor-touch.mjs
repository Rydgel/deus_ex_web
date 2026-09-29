const f=Math.fround;
/** Host identity of a field view. The script pawn physics view (a JS wrapper
 * of script fields, script-pawn-physics.mjs) stores its host actor under this
 * key; any other object is its own identity. The original Touching slots,
 * Base links and the IsBasedOn/SetBase walks hold and compare AActor
 * pointers, so a view never belongs in them (docs/script-map-actor-move.md). */
export const ACTOR_IDENTITY=Symbol('actor identity');
export const identityOf=actor=>actor?.[ACTOR_IDENTITY]??actor;
function slots(actor){if(!Array.isArray(actor.touching)||actor.touching.length!==4)throw Error('Original Touching requires four explicit slots');return actor.touching;}
function identities(actor,other){if(actor?.[ACTOR_IDENTITY]||other?.[ACTOR_IDENTITY])throw Error('Touching slots hold actor identities: pass the host, not its field view');}
/** Original cylinder IsOverlapping10369430; brush/world exclusions are native. */
export function isOverlapping(actor,other){
 if(actor.movingBrush||other.movingBrush||other===actor.worldActor)return false;
 const a=actor.position.map(f),b=other.position.map(f),r=f(actor.radius)+f(other.radius),h=f(actor.height)+f(other.height);
 return (a[1]-b[1])**2+(a[0]-b[0])**2<r*r&&(a[2]-b[2])**2<h*h;
}
/** Original EndTouch clears each side before its synchronous UnTouch event. */
export function endTouch(actor,other,noNotifySelf,dispatch){
 if(actor===other)throw Error('Original EndTouch rejects self');
 identities(actor,other);
 let index=slots(actor).indexOf(other);
 if(index>=0){actor.touching[index]=null;if(!noNotifySelf)dispatch(actor,'UnTouch',[other]);}
 index=slots(other).indexOf(actor);
 if(index>=0){other.touching[index]=null;dispatch(other,'UnTouch',[actor]);}
}
/** Original BeginTouch pair order, last-empty selection, and capacity eviction. */
export function beginTouch(actor,other,dispatch){
 if(!actor||!other||actor===other)throw Error('Original BeginTouch requires distinct actors');
 identities(actor,other);
 const add=(a,b)=>{
  let empty=-1;
  for(let i=0;i<4;i++){const item=slots(a)[i];if(item===b)return true;if(item===null)empty=i;}
  if(empty<0){
   // Native IsValid asserts each live entry before reading its physics byte.
   for(let i=0;i<4;i++){
    const item=slots(a)[i];if(!item)throw Error('Original full Touching list contains an invalid actor');
    if(item.physics===undefined)throw Error('Touch eviction requires original actor physics');
    if(item.physics===0){endTouch(a,item,false,dispatch);empty=i;}
   }
   if(empty<0&&b.isPawn){
    for(let i=0;i<4;i++)if(!slots(a)[i].isPawn){endTouch(a,slots(a)[i],false,dispatch);empty=i;break;}
    if(empty<0&&(b.pawnFlags&2)){
     for(let i=0;i<4;i++)if(!slots(a)[i].isPawn||!(slots(a)[i].pawnFlags&2)){endTouch(a,slots(a)[i],false,dispatch);empty=i;break;}
    }
   }
   // Refused insertion still permits the reciprocal AddTouch.
   if(empty<0)return true;
  }
  a.touching[empty]=b;dispatch(a,'Touch',[b]);return a.touching[empty]===b;
 };
 if(add(actor,other))add(other,actor);
}
