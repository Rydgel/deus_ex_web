const f=Math.fround;

/** Original DeusExPlayer.GetDefaultCollisionHeight embedded source. */
export const defaultPawnCollisionHeight=defaultCollisionHeight=>f(f(defaultCollisionHeight)-4.5);

/** Source translation of standalone DeusExPlayer.SetBasedPawnSize.
 * setCollisionSize(r,h) must synchronously update pawn.radius/pawn.height through
 * the native resize/hash contract. move(delta) must return native MoveActor's
 * boolean and apply its movement; a failed movement is never rolled back here.
 * State also supplies prePivot/baseEyeHeight/eyeHeight and original defaults.
 */
export function setBasedPawnSize(pawn,newRadius,newHeight){
 if((pawn.netMode??0)!==0)throw Error('SetBasedPawnSize multiplayer branch is unsupported');
 newRadius=f(newRadius);newHeight=f(newHeight);
 if(!Number.isFinite(newRadius)||!Number.isFinite(newHeight))throw Error('Nonfinite stance dimensions are unsupported');
 if(newRadius<0)newRadius=0;if(newHeight<0)newHeight=0;
 const oldRadius=f(pawn.radius),oldHeight=f(pawn.height);
 if(oldRadius===newRadius&&oldHeight===newHeight)return true;
 if(pawn.carriedDecoration)throw Error('SetBasedPawnSize carried-decoration branch is unsupported');
 if(typeof pawn.setCollisionSize!=='function'||typeof pawn.move!=='function')throw Error('Stance requires SetCollisionSize and MoveActor callbacks');
 const difference=f(newHeight-oldHeight),centerDelta=[f(0*difference),f(0*difference),difference];
 const deltaEyeHeight=f(defaultPawnCollisionHeight(pawn.defaultCollisionHeight)-f(pawn.defaultBaseEyeHeight));
 let success;
 const move=()=>{const result=pawn.move(centerDelta.slice());if(typeof result!=='boolean')throw Error('Stance MoveActor callback must return its boolean success');return result;};
 if(newHeight<=pawn.height&&newRadius<=pawn.radius){
  pawn.setCollisionSize(newRadius,newHeight);success=move();
  if(!success)pawn.setCollisionSize(oldRadius,oldHeight);
 }else{
  success=move();if(success)pawn.setCollisionSize(newRadius,newHeight);
 }
 if(success){
  pawn.prePivot=pawn.prePivot.map((v,i)=>f(f(v)-centerDelta[i]));
  pawn.baseEyeHeight=f(newHeight-deltaEyeHeight);
  pawn.eyeHeight=f(f(pawn.eyeHeight)-centerDelta[2]);
 }
 return success;
}

/** Source ResetBasedPawnSize delegates to the same operation. */
export function resetBasedPawnSize(pawn){
 return setBasedPawnSize(pawn,pawn.defaultCollisionRadius,defaultPawnCollisionHeight(pawn.defaultCollisionHeight));
}
