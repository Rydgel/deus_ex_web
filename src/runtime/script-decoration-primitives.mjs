import {coordsDotX87,getAxes} from './camera.mjs';
import {rotatorSin} from './coords.mjs';
import {x87Precision} from './x87-precision.mjs';
import {r24,r24prod} from './x87-r24.mjs';
const f=Math.fround;
const bits=new DataView(new ArrayBuffer(4));
const value=arg=>arg?.reference?arg.get():arg;
export const decorationPrimitiveIndices=new Set([152,153,159,161,162,178,246,275]);
export const decorationOutPrimitiveIndices=new Set([159,161,162]);

/** Core FVector::Rotation (0x10144390) at 24 bits (inside the render pass,
 * render-precision.mjs): yaw `ftol(atan2(y, x)·K)`, pitch
 * `ftol(atan2(z, √(y² + x²))·K)` with K the embedded double
 * 10430.219195527361 (0x10178050), the sum and appSqrt's FSQRT at 24 bits
 * and each product rounded once from the exact value. FPATAN (unaffected by
 * precision control) is the host's Math.atan2, as below. */
export function vectorToRotator24(vector) {
  const [x,y,z]=vector.map(f),K=10430.219195527361;
  if(![x,y,z].every(Number.isFinite))throw new Error('Original nonfinite vector rotation is not implemented');
  // Products of floats are exact in doubles; r24 rounds each step once.
  const root=f(r24(Math.sqrt(r24(r24(y*y)+r24(x*x)))));
  return [Math.trunc(r24prod(Math.atan2(z,root),K))|0,Math.trunc(r24prod(Math.atan2(y,x),K))|0,0];
}

/** The vector-to-rotator cast (Core 0x10136f90: Step, FVector::Rotation, a
 * copy of the rotator). */
export function vectorToRotator(vector) {
  if(!Array.isArray(vector)||vector.length!==3)throw new Error('VectorToRotator requires three components');
  if(x87Precision===24)return vectorToRotator24(vector);
  const [x,y,z]=vector.map(f),scale=10430.219195527361;
  if(![x,y,z].every(Number.isFinite))throw new Error('Original nonfinite vector rotation is not implemented');
  const yaw=Math.trunc(Math.atan2(y,x)*scale)|0;
  const pitch=Math.trunc(Math.atan2(z,Math.sqrt(x*x+y*y))*scale)|0;
  return [pitch,yaw,0];
}

/** Core FRotator::Vector via the recovered sine table; the rotation matrix X
 * row (roll cancels), matching the execGetAxes convention in camera.mjs. */
export function rotatorToVector(rotation) {
  if(!Array.isArray(rotation)||rotation.length!==3||rotation.some(v=>!Number.isInteger(v)))throw new Error('RotatorToVector requires integer Unreal rotator units');
  const [pitch,yaw]=rotation;
  const sp=rotatorSin(pitch),cp=rotatorSin((pitch+16384)|0);
  const sy=rotatorSin(yaw),cy=rotatorSin((yaw+16384)|0);
  return [f(cp*cy),f(cp*sy),sp];
}

function truncateIntFloatProduct(a,b) {
  bits.setFloat32(0,b,true);
  const word=bits.getUint32(0,true),exponent=(word>>>23)&255;
  if(exponent===255)throw new Error('Original _ftol nonfinite conversion is not implemented');
  const fraction=word&0x7fffff,significand=exponent?fraction|0x800000:fraction;
  const shift=(exponent?exponent-127:1-127)-23;
  const product=BigInt(a)*BigInt(significand)*(word>>>31?-1n:1n);
  const magnitude=product<0n?-product:product;
  const integral=shift<0?magnitude>>BigInt(-shift):magnitude<<BigInt(shift);
  const signed=product<0n?-integral:integral;
  if(signed<-(1n<<63n)||signed>=(1n<<63n))throw new Error('Original _ftol overflow conversion is not implemented');
  return Number(BigInt.asIntN(32,signed));
}

/** Original Core wrappers after left-to-right argument evaluation. For out
 * operands the caller preserves the reference until all arguments are ready. */
export function executeDecorationPrimitive(index,args) {
  if(!decorationPrimitiveIndices.has(index))throw new Error(`Unsupported decoration native ${index}`);
  if(args.length!==(index===246?3:2))throw new Error(`Invalid argument count for native ${index}`);
  const a=value(args[0]),b=value(args[1]);
  if(index===275){
    if(!Array.isArray(a)||a.length!==3)throw new Error('Vector shift requires three components');
    const vector=a.map(f);
    // A.TransformVectorBy(GMath.UnitCoords / B) (Core 0x10137d90): the
    // GetAxes coordinates, then one FCoords dot per axis on the x87 model
    // (NaN components follow the x87; 24 bits inside the render pass).
    return getAxes(b).map(axis=>coordsDotX87(vector,axis));
  }
  if(index===152)return (a|0)<=(b|0);
  if(index===153)return (a|0)>=(b|0);
  if(index===178)return !(f(a??0)>f(b??0));
  if(index===246){
    const v=f(a??0),low=f(b??0),high=f(value(args[2])??0);
    return v<low||Number.isNaN(v)||Number.isNaN(low)?low
      :v<high||Number.isNaN(high)?v:high;
  }
  const result=index===159?truncateIntFloatProduct(a|0,f(b??0))
    :index===161?((a|0)+(b|0))|0:((a|0)-(b|0))|0;
  if(args[0]?.reference)args[0].set(result);
  return result;
}
