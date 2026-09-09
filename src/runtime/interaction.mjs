import { getAxes } from './camera.mjs';
const f=Math.fround;

/** Original FRotator.Vector1011d1c0 returns the inverse rotation X axis. */
export const interactionDirection=rotation=>getAxes(rotation)[0];

/** Original execTraceActors103e4bc0. queries is createLevelQueries' interface.
 * The parsed BaseClass is unused by the original. No owner/self/class/world
 * stop filter belongs here. Optional out preserves the iterator's out params.
 */
export function* traceActors(queries,source,end,start=source.position,extent=[0,0,0],out={}){
 const hits=queries.multiLineCheck({end:end.map(f),start:start.map(f),extent:extent.map(f),checkActors:1,worldActor:queries.levelInfo,extra:0});
 for(const hit of hits){
  out.actor=hit.actor;out.location=[...hit.location];out.normal=[...hit.normal];
  yield {...hit,location:[...hit.location],normal:[...hit.normal]};
 }
 out.actor=null;
}

function isA(actor,name){
 if(!actor)return false;
 if(!Array.isArray(actor.lineage))throw Error('Interaction actors require original class ancestry');
 const key=name.toLowerCase();return actor.lineage.some(value=>value.toLowerCase().split('.').at(-1)===key);
}
const values=actor=>actor?.values??actor??{};

/** Original DeusExPlayer.IsFrobbable: class membership, not use permission. */
export function isFrobbable(actor){
 return Boolean(actor&&!values(actor).bHidden&&['Mover','DeusExDecoration','Inventory','ScriptedPawn','DeusExCarcass','DeusExProjectile'].some(name=>isA(actor,name)));
}

/** Original IsHighlighted is deliberately separate from target selection. */
export function isHighlighted(state,actor){
 if(state.behindView)return false;
 if(!actor)return true;
 const v=values(actor);
 if(v.bDeleteMe||v.bHidden)return false;
 if(isA(actor,'Pawn')&&!state.npcHighlighting)return false;
 if(isA(actor,'DeusExMover')&&!v.bHighlight)return false;
 else if(isA(actor,'Mover')&&!isA(actor,'DeusExMover'))return false;
 else if(isA(actor,'DeusExDecoration')&&!v.bHighlight)return false;
 else if(isA(actor,'DeusExCarcass')&&!v.bHighlight)return false;
 else if(isA(actor,'ThrownProjectile')&&!v.bHighlight)return false;
 else if(isA(actor,'DeusExProjectile')&&!v.bStuck)return false;
 else if(isA(actor,'ScriptedPawn')&&!v.bHighlight)return false;
 return true;
}

/** Original HighlightCenterObject2732–2791. trace(end,start,extent) yields raw
 * TraceActors hits. Mutates frobTarget/frobTime only when the cadence fires.
 * Caller runs this before UpdateRotation/ProcessMove, using BaseEyeHeight.
 */
export function highlightCenterObject(state,trace){
 if(state.stateName?.toLowerCase()==='dying')return state.frobTarget;
 if(!(state.frobTime>=f(.1)))return state.frobTarget;
 const position=state.position.map(f),direction=interactionDirection(state.viewRotation);
 const end=position.map((v,i)=>f(v+f(direction[i]*f(state.maxFrobDistance))));
 const start=[...position];start[2]=f(start[2]+f(state.baseEyeHeight));end[2]=f(end[2]+f(state.baseEyeHeight));
 let target=null,minSize=99999,first=true;
 for(const hit of trace(end,start,[0,0,0])){
  const actor=hit.actor;
  if(!isFrobbable(actor)||actor===state.carriedDecoration)continue;
  if(isA(actor,'ScriptedPawn')||(isA(actor,'Mover')&&first)){target=actor;break;}
  const radius=f(values(actor).CollisionRadius??0);
  if(radius<minSize){minSize=radius;target=actor;first=false;}
 }
 state.frobTarget=target;state.frobTime=0;
 return target;
}

/** The dry PlayerWalking.PlayerTick order: query, then add deltaTime. Physics
 * may be Walking or Falling while this script state remains PlayerWalking.
 */
export function tickWalkingInteraction(state,deltaTime,trace){
 if(state.stateName&&state.stateName.toLowerCase()!=='playerwalking')throw Error('Interaction tick requires PlayerWalking script state');
 highlightCenterObject(state,trace);state.frobTime=f(state.frobTime+f(deltaTime));
 return state.frobTarget;
}
