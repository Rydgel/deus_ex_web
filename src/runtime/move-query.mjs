const f=Math.fround;
const flags=actor=>actor.flags??0;
function basedOn(actor,source){
  const seen=new Set();
  for(let current=actor;current;current=current.base){
    if(current===source)return true;
    if(seen.has(current))throw new Error('Cyclic actor Base chain');
    seen.add(current);
  }
  return false;
}

/** Original controlled-player MoveActor translation/query prefix.
 * Actor traits: flags (native collision bit mask), controlledPlayer, projectile,
 * movingBrush (nonnull Brush and IsA(Brush)), base. The source must be a
 * controlled player cylinder. multiLineCheck returns original ordered hits.
 * success is the original accepted-scene return, not an override for a scene
 * rejection. Scene mutation/events and nondefault move flags are not implemented here.
 * Evidence and original comparisons: docs/move-query.md.
 */
export function moveQuery({source,worldActor,start,delta,extent,multiLineCheck}){
  if(!source?.controlledPlayer || source.movingBrush)throw new Error('Move query requires a controlled-player cylinder');
  start=start.map(f);delta=delta.map(f);extent=extent.map(f);
  if([...start,...delta,...extent].some(v=>!Number.isFinite(v)))throw new Error('Nonfinite movement query unsupported');
  // Original non-editor immovable/static rejection precedes the tiny gate.
  if(source.static||source.movable===false)return {success:false,delta:[0,0,0],position:start,time:1,hit:null};
  if(delta.every(v=>Math.abs(v)<.0001))return {success:true,delta:[0,0,0],position:start,time:1,hit:null};
  const length=Math.sqrt(delta[2]*delta[2]+delta[1]*delta[1]+delta[0]*delta[0]),size=f(length),reciprocal=f(1/length);
  const direction=delta.map(v=>f(v*reciprocal)),extended=delta.map((v,i)=>f(v+2*direction[i]));
  let hit=null,time=1,displacement=delta;
  const sourceFlags=flags(source);
  if(sourceFlags&3){
    const hits=multiLineCheck({end:start.map((v,i)=>f(v+extended[i])),start:start.slice(),extent:extent.slice(),
      checkActors:!!(sourceFlags&1),worldActor:sourceFlags&2?worldActor:null,extra:0});
    if(sourceFlags&14)for(const candidate of hits){
      const other=candidate.actor;
      if(basedOn(other,source))continue;
      let blocks;
      if(other===worldActor)blocks=!!(sourceFlags&2);
      else if(other.movingBrush)blocks=!!(sourceFlags&2)&&!!(flags(other)&8);
      else blocks=!!(flags(other)&8)&&!!(sourceFlags&((other.controlledPlayer||other.projectile)?8:4));
      if(blocks){hit={...candidate,location:candidate.location?.slice(),normal:candidate.normal?.slice()};break;}
    }
  }
  if(hit){
    time=f(hit.time);
    if(time<1){
      const distance=(size+2)*time,storedDistance=f(distance);
      if(distance<=2){displacement=[0,0,0];time=0;}
      else {
        displacement=extended.map((v,i)=>f(f(v*time)-f(direction[i]*2)));
        time=f((storedDistance-2)/size);
      }
    }
    hit.time=time;
  }
  return {success:time>0,delta:displacement,position:start.map((v,i)=>f(v+displacement[i])),time,hit};
}
