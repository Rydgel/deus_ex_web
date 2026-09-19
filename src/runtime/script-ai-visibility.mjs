/** Original Actor natives 700/701 and AICanSee's internal visibility service.
 * Evidence, call order and limits: docs/script-ai-visibility.md. */
import {refValue,x87load,x87add,x87neg,x87mul,x87div,x87sqrt,x87store,x87storeDouble,x87width} from './script-vm.mjs';

const ld=x87load,st=x87store,sub=(a,b)=>x87add(a,x87neg(b));
const double=value=>{
  const io=new DataView(new ArrayBuffer(8));io.setFloat64(0,value,true);
  const bits=io.getBigUint64(0,true),e=Number((bits>>52n)&0x7ffn);
  return {neg:Number(bits>>63n),sig:(bits&0xfffffffffffffn)|(e?1n<<52n:0n),exp:e?e-1075:-1074};
};
const ZERO=ld(0),ONE=ld(1),HALF=ld(0.5),QUARTER=ld(0.25);
const SAT_BIAS=double(127.5),SAT_SCALE=double(0.00261437908496732),BRIGHT_SCALE=double(0.00392156862745098);
// FCOM's below/equal/unordered flags. Comparisons must retain x87 precision.
function compare(a,b) {
  if(a.nan!==undefined||b.nan!==undefined)return {below:true,equal:true};
  let order;
  if(a.inf||b.inf)order=a.inf&&b.inf?(a.neg===b.neg?0:a.neg?-1:1):a.inf?(a.neg?-1:1):(b.neg?1:-1);
  else if(a.sig===0n&&b.sig===0n)order=0;
  else if(a.sig===0n)order=b.neg?1:-1;
  else if(b.sig===0n)order=a.neg?-1:1;
  else if(a.neg!==b.neg)order=a.neg?-1:1;
  else {
    const ea=a.exp+x87width(a.sig),eb=b.exp+x87width(b.sig);
    if(ea!==eb)order=ea<eb?-1:1;
    else {const e=Math.min(a.exp,b.exp),aa=a.sig<<BigInt(a.exp-e),bb=b.sig<<BigInt(b.exp-e);order=aa===bb?0:aa<bb?-1:1;}
    if(a.neg)order=-order;
  }
  return {below:order<0,equal:order===0};
}
const clamp=value=>compare(value,ZERO).below?ZERO:compare(value,ONE).below?value:ONE;
const scalar=(brightness,saturation)=>x87mul(
  x87mul(x87add(ld(Number(saturation)&255),SAT_BIAS),SAT_SCALE),
  x87mul(ld(Number(brightness)&255),BRIGHT_SCALE));
const squareSum=v=>x87add(x87add(x87mul(v[0],v[0]),x87mul(v[1],v[1])),x87mul(v[2],v[2]));
const read=(services,actor,name)=>{
  const value=services.read(actor,name);
  if(value===undefined)throw new Error(`AI visibility requires original ${name}`);
  return value;
};
const extended=value=>typeof value==='number'?ld(value):value;
const queryLight=(actor,point,services)=>services.lighting
  ?extended(services.lighting(actor,point)):actorLightLevelExtended(actor,point,services);

/** AActor::AIGetLightLevel 1036b980. Returns the retained x87 value. */
export function actorLightLevelExtended(actor,point,services) {
  point=point.map(Math.fround); // Input FVector is passed by value.
  const zone=services.zone(actor),level=services.level(actor);
  if(!zone)throw new Error('AIGetLightLevel requires the original Region.Zone');
  let sum=0;
  if(read(services,actor,'bUnlit'))sum=1;
  else {
    // The original reloads both TArray.Data and Num after each callback.
    for(let i=0;i<services.levelActors(level).length;i++) {
      const light=services.levelActors(level)[i];
      if(!light||!(Number(read(services,light,'LightType'))&255)
        ||!(Number(read(services,light,'LightBrightness'))&255)||light===actor)continue;
      const radius=services.worldLightRadius?extended(services.worldLightRadius(light))
        :x87mul(ld((Number(read(services,light,'LightRadius'))&255)+1),ld(25));
      const radiusSq=st(x87mul(radius,radius));
      const start=read(services,light,'Location');
      const distanceSq=st(squareSum(point.map((v,i)=>sub(ld(v),ld(start[i])))));
      const comparison=compare(ld(radiusSq),ld(distanceSq));
      if(comparison.below||comparison.equal)continue;
      if(read(services,light,'bStatic')) {
        if(typeof services.lightLineCheck!=='function')throw new Error('AIGetLightLevel requires original SingleLineCheck');
        if(!services.lightLineCheck(level,actor,point,start))continue;
      }
      const root=x87storeDouble(x87sqrt(x87storeDouble(x87div(ld(distanceSq),ld(radiusSq)))));
      const attenuation=st(sub(ONE,root));
      sum=st(x87add(x87mul(scalar(read(services,light,'LightBrightness'),read(services,light,'LightSaturation')),
        ld(attenuation)),ld(sum)));
    }
    sum=st(x87mul(ld(sum),HALF));
  }
  const ambient=scalar(read(services,zone,'AmbientBrightness'),read(services,zone,'AmbientSaturation'));
  return clamp(x87add(x87add(ambient,ambient),ld(sum)));
}

/** AActor::AIVisibility 1036bca0; do not round before AICanSee multiplies it. */
export function actorVisibilityExtended(actor,includeVelocity,services) {
  const level=services.level(actor),info=services.levelInfo(level);
  if(!info||!services.isA(info,'LevelInfo'))throw new Error('AIVisibility requires Actors[0] to be LevelInfo');
  const time=ld(read(services,info,'TimeSeconds'));
  const elapsed=st(sub(time,ld(read(services,actor,'VisUpdateTime'))));
  let base;
  if(compare(HALF,ld(elapsed)).below) {
    services.write(actor,'VisUpdateTime',st(time));
    const value=st(queryLight(actor,read(services,actor,'Location'),services));
    services.write(actor,'CurrentVisibility',value);services.write(actor,'LastVisibility',value);
    base=ld(value);
  }else {
    const comparison=compare(ld(elapsed),QUARTER);
    if(!comparison.below&&!comparison.equal) {
      services.write(actor,'LastVisibility',read(services,actor,'CurrentVisibility'));
      services.write(actor,'VisUpdateTime',st(time));
      const value=st(queryLight(actor,read(services,actor,'Location'),services));
      base=ld(read(services,actor,'LastVisibility'));
      services.write(actor,'CurrentVisibility',value);
    }else {
      const last=ld(read(services,actor,'LastVisibility'));
      base=x87add(x87mul(sub(ld(read(services,actor,'CurrentVisibility')),last),x87div(ld(elapsed),QUARTER)),last);
    }
  }
  if(includeVelocity) {
    const stored=ld(st(base));
    const squared=x87storeDouble(squareSum(read(services,actor,'Velocity').map(ld)));
    const speed=squared.nan!==undefined?squared:x87sqrt(squared);
    const ratio=clamp(x87div(sub(speed,ld(30)),ld(170)));
    base=x87add(x87mul(x87mul(ratio,stored),HALF),stored);
  }
  return clamp(base);
}

export function execAIGetLightLevel(call,services) {
  if(call.argumentCount!==1)throw new Error('AIGetLightLevel requires one vector');
  return st(queryLight(call.receiver,refValue(call.evaluateArgument(0)).map(Math.fround),services));
}
export function execAIVisibility(call,services) {
  if(call.argumentCount>1)throw new Error('AIVisibility accepts one optional boolean');
  const includeVelocity=(call.argumentCount?refValue(call.evaluateArgument(0)):undefined)??true;
  return st(actorVisibilityExtended(call.receiver,includeVelocity,services));
}
