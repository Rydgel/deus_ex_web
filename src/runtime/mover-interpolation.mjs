const f=Math.fround;
const vector=v=>v.map(f);

/** Mover.InterpolateTo, original embedded Mover.uc309–342, two translating keys.
 * Key rotations must be constant; position/basePosition/keyPositions are UE xyz.
 * Caller supplies setPhysics when its physics transition has observable effects.
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

/** AMover.physMovingBrush103de690, constant-rotation two-key subset.
 * move(delta,rotation) MUST update mover.position as original MoveActor does,
 * and return its boolean success. No interpolation alpha commits on failure.
 * With scriptInterpolateEnd, the callback executes original InterpolateEnd
 * bytecode and owns its fields. The legacy two-key adapter otherwise applies
 * previousKey=key and alpha=0 before notification. Script latent resumption is
 * owned by the caller. See docs/doors.md for explicit collision/VM limits.
 */
export function tickMoverInterpolation(mover,seconds){
 let remaining=f(seconds),iterations=0;
 while(mover.interpolating&&remaining>0){
  if(++iterations>64)throw Error('Mover callback failed to make bounded progress');
  const prior=f(mover.alpha);let alpha=prior+remaining*f(mover.rate),stored=f(alpha);
  if(alpha>1){remaining=f((alpha-1)/(alpha-prior)*remaining);alpha=1;stored=1;}else remaining=0;
  const glide=f(mover.glideType===1?3*(alpha*alpha)-2*(alpha*(alpha*alpha)):alpha);
  const target=mover.basePosition.map((v,i)=>f(v+mover.keyPositions[mover.key][i]));
  const desired=target.map((v,i)=>f(mover.oldPosition[i]+f(f(v-mover.oldPosition[i])*glide)));
  const delta=desired.map((v,i)=>f(v-mover.position[i]));
  if(typeof mover.move!=='function')throw Error('Mover interpolation requires a MoveActor callback');
  if(!mover.move(delta,(mover.rotation??[0,0,0]).slice()))continue;
  mover.alpha=stored;
  if(stored===1){
   mover.interpolating=false;
   if(!mover.scriptInterpolateEnd){mover.previousKey=mover.key;mover.alpha=0;}
   mover.onInterpolateEnd?.();
  }
 }
}
