import { x87load, x87int32, x87mul, x87add, x87neg, x87div, x87cmp, x87store, x87ftol, x87double } from './script-vm.mjs';
const f=Math.fround;
const vector=v=>v.map(f);

/** Mover.InterpolateTo, original embedded Mover.uc309–342, two translating keys.
 * Key rotations must be constant; position/basePosition/keyPositions are UE xyz.
 * Caller supplies setPhysics when its physics transition has observable effects.
 * Fixture path only: Play runs the original InterpolateTo bytecode.
 */
export function interpolateMoverTo(mover,key,seconds){
 if(key!==0&&key!==1||mover.keyPositions.length!==2)throw Error('Only two translating mover keys are supported');
 if(key===mover.previousKey&&mover.key!==mover.previousKey){
  mover.alpha=f(1-mover.alpha);
  mover.oldPosition=mover.basePosition.map((v,i)=>f(v+mover.keyPositions[mover.key][i]));
 }else{mover.oldPosition=vector(mover.position);mover.alpha=0;}
 mover.setPhysics?.(9);mover.physics=9;mover.interpolating=true;
 mover.previousKey=mover.key;mover.key=key;mover.rate=f(1/Math.max(f(seconds),f(.005)));
}

const ZERO=x87double(0),ONE=x87double(1),THREE=x87double(3);
const X=x87load;
const sub32=(a,b)=>x87store(x87add(X(a),x87neg(X(b))));
const add32=(a,b)=>x87store(x87add(X(a),X(b)));
const io=new DataView(new ArrayBuffer(12));
// KeyNum clamps to 8, one past both arrays (SDK AMover: KeyPos[8] at +0x3c8,
// KeyRot[8] at +0x428, BasePos at +0x488): KeyPos[8] is KeyRot[0]'s three
// ints read as floats and KeyRot[8] is BasePos's three floats read as ints.
const keyPosition=(state,key)=>{
 if(key<8)return state.keyPositions[key]??[0,0,0];
 const r=state.keyRotations[0]??[0,0,0];
 for(let i=0;i<3;i++)io.setInt32(i*4,r[i]|0,true);
 return [0,1,2].map(i=>io.getFloat32(i*4,true));
};
const keyRotation=(state,key)=>{
 if(key<8)return state.keyRotations[key]??[0,0,0];
 const p=state.basePosition;
 for(let i=0;i<3;i++)io.setFloat32(i*4,p[i],true);
 return [0,1,2].map(i=>io.getInt32(i*4,true));
};

/** AMover::physMovingBrush, Engine.dll 0x103de690–0x103dea2e (docs/doors.md
 * "physMovingBrush"). `state` holds the mover's native fields: key (KeyNum),
 * alpha (PhysAlpha), rate (PhysRate), interpolating (bInterpolating),
 * keyPositions/keyRotations (8 each), basePosition/baseRotation (BasePos,
 * BaseRot) and oldPosition/oldRotation (OldPos, OldRot). Services:
 * `location()` the live Location; `glideType()` MoverGlideType;
 * `move(delta, rotation)` ULevel::MoveActor (level vtable +0x88, all flags
 * zero) returning its success; `interpolateEnd()` the InterpolateEnd(None)
 * ProcessEvent after bInterpolating is cleared. Every intermediate follows the
 * x87 instruction sequence: the alpha sum, the clamp ratio and the smoothstep
 * stay extended, each FST/FSTP stores float32, and the rotation offsets are
 * _ftol of the exact FILD*glide product. */
export function physMovingBrush(state,seconds,{location,glideType,move,interpolateEnd}){
 // 0x103de6e1: KeyNum clamped once, before the loop.
 const key=Math.min(state.key&0xff,8);
 let dt=f(seconds);
 while(state.interpolating&&x87cmp(X(dt),ZERO)==='gt'){
  const prior=f(state.alpha);
  let alpha=x87add(x87mul(X(dt),X(f(state.rate))),X(prior));
  let stored=x87store(alpha);
  if(x87cmp(alpha,ONE)==='gt'){
   const ratio=x87div(x87add(alpha,x87neg(ONE)),x87add(alpha,x87neg(X(prior))));
   dt=x87store(x87mul(ratio,X(dt)));
   alpha=X(1);stored=1;
  }else dt=0;
  let glide;
  if(glideType()===1){
   const square=x87mul(alpha,alpha);
   const cube=x87mul(alpha,square);
   glide=x87store(x87add(x87mul(square,THREE),x87neg(x87add(cube,cube))));
  }else glide=x87store(alpha);
  // 0x103de7c3–0x103de871: int32 rotator arithmetic, then _ftol(FILD*glide).
  const keyRot=keyRotation(state,key),base=state.baseRotation,old=state.oldRotation;
  const rotation=[0,1,2].map(i=>{
   const span=(((base[i]|0)+(keyRot[i]|0))|0)-(old[i]|0)|0;
   return ((old[i]|0)+x87ftol(x87mul(x87int32(span),X(glide))))|0;
  });
  // 0x103de877–0x103de954: Target, Target-OldPos, *glide, +OldPos, -Location.
  const keyPos=keyPosition(state,key),oldPos=state.oldPosition,here=location();
  const target=state.basePosition.map((v,i)=>add32(v,keyPos[i]));
  const desired=target.map((v,i)=>add32(x87store(x87mul(X(sub32(v,oldPos[i])),X(glide))),oldPos[i]));
  const delta=desired.map((v,i)=>sub32(v,here[i]));
  if(!move(delta,rotation))continue;
  // 0x103de9a7: commit alpha; C3 (equal or unordered) ends the interpolation.
  state.alpha=stored;
  const end=x87cmp(X(stored),ONE);
  if(end==='eq'||end==='un'){
   state.interpolating=false;
   interpolateEnd();
  }
 }
}

/** The pre-VM door fixture over physMovingBrush: a host `mover` state whose
 * `position`, `glideType`, `move` and `onInterpolateEnd` stand in for the
 * live actor. Without scriptInterpolateEnd it applies the two-key script's
 * PrevKeyNum=KeyNum and PhysAlpha=0 before notification. */
export function tickMoverInterpolation(mover,seconds){
 physMovingBrush(mover,seconds,{
  location:()=>mover.position,
  glideType:()=>mover.glideType,
  move:(delta,rotation)=>{
   if(typeof mover.move!=='function')throw Error('Mover interpolation requires a MoveActor callback');
   return mover.move(delta,rotation);
  },
  interpolateEnd:()=>{
   if(!mover.scriptInterpolateEnd){mover.previousKey=mover.key;mover.alpha=0;}
   mover.onInterpolateEnd?.();
  },
 });
}
