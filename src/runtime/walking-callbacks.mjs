import {safeNormal} from './steps.mjs';
const f=Math.fround;

/** Original SetBase10369c80. dispatch(target,event,args) runs synchronously;
 * script event effects belong to the caller. worldActor retains Level identity. */
export function setBase(pawn,target,dispatch,notify=true){
 for(let base=target;base;base=base.base)if(base===pawn)return;
 if(target===pawn.base)return;
 const old=pawn.base;
 if(old && old!==pawn.worldActor){
  old.standingCount=(old.standingCount-1)&255;
  dispatch(old,'Detach',[pawn]);
 }
 pawn.base=target;
 if(target && target!==pawn.worldActor){
  target.standingCount=(target.standingCount+1)&255;
  dispatch(target,'Attach',[pawn]);
 }
 if(notify)dispatch(pawn,'BaseChange',[]);
}

/** Original SetSupportBase103c9390 dispatches SupportActor; it does not set Base. */
export function setSupportBase(pawn,target,dispatch){
 if(target)dispatch(target,'SupportActor',[pawn]);
 else setBase(pawn,null,dispatch);
}

/** Bounded original setPhysics103c95f0 transitions. findBase must supply the
 * original FindBase query/event behavior when entering Walking without support. */
export function setWalkingPhysics(pawn,next,support,{dispatch,findBase}){
 if(next!==1 && next!==2)throw Error(`Unsupported walking transition ${next}`);
 if(pawn.physics===next)return;
 pawn.physics=next;
 if(next===2){if(pawn.base)setBase(pawn,null,dispatch);}
 else if(support){if(support!==pawn.base)setSupportBase(pawn,support,dispatch);}
 else findBase(pawn);
 // Native re-reads Physics after synchronous events, which may change it.
 if(pawn.physics===0 || pawn.physics===5){pawn.velocity=[0,0,0];pawn.acceleration=[0,0,0];}
}

/** Pawn branch of native processHitWall103cecc0. isPawn is decoded class
 * ancestry; isProbing reflects the current script state's HitWall probe. */
export function processPlayerHitWall(pawn,normal,wall,{isProbing,dispatch}){
 if(wall?.isPawn)return;
 if(pawn.acceleration.every(x=>f(x)===0))return;
 const direction=safeNormal(pawn.destination.map((x,i)=>f(f(x)-f(pawn.position[i]))));
 normal=normal.map(f);
 if(pawn.physics===1){normal[2]=0;direction[2]=0;}
 const dot=direction[1]*normal[1]+normal[0]*direction[0]+direction[2]*normal[2];
 if(dot>f(pawn.minHitWall))return;
 if(isProbing(pawn,'HitWall') || pawn.physics===2)dispatch(pawn,'HitWall',[normal,wall]);
 else {pawn.moveTimer=-1;pawn.pawnFlags=(pawn.pawnFlags|0x100000)>>>0;}
}
