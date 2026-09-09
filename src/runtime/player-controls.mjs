/** Embedded DeusExPlayer.HandleWalking; movement/input-device processing is external. */
export function handleWalkingControls(previous,buttons={},settings={}){
 const state={...previous},duck=Boolean(buttons.duck);
 state.duck=duck;
 state.isWalking=(settings.alwaysRun??true)?Boolean(buttons.run)||duck:!buttons.run||duck;
 if(settings.toggleWalk)state.isWalking=!state.isWalking;
 if(settings.toggleCrouch){
  if(!state.crouchOn&&!state.wasCrouchOn&&duck)state.crouchOn=true;
  else if(state.crouchOn&&!state.wasCrouchOn&&!duck)state.wasCrouchOn=true;
  else if(state.crouchOn&&state.wasCrouchOn&&!duck&&state.lastDuck){state.crouchOn=false;state.wasCrouchOn=false;}
  if(state.crouchOn){state.isCrouching=true;state.duck=true;}
  state.lastDuck=state.duck;
 }
 return state;
}
/** DeusExPlayer.ProcessMove reads the prior flag, before its Super call. */
export const stanceCrouchRequested=state=>Boolean(state.isCrouching||state.forceDuck);
export function afterStanceControls(state,forceDuck){
 return {...state,forceDuck:Boolean(forceDuck),isWalking:Boolean(state.isWalking||state.isCrouching||forceDuck)};
}
/** Inherited ProcessMove updates this flag AFTER DoJump, only while walking. */
export function afterJumpControls(state,physics,animationGroup=''){
 const next={...state};let animation=null;
 if(physics===1&&animationGroup.toLowerCase()!=='dodge'){
  if(!next.isCrouching&&next.duck){next.isCrouching=true;animation='PlayDuck';}
  else if(next.isCrouching&&!next.duck){next.isCrouching=false;animation='TweenToRunning';}
 }
 return {state:next,animation};
}
