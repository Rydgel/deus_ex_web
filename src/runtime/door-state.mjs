/** Original zero-delay two-key TriggerToggle scheduling. See docs/door-state.md.
 * interpolation is the state consumed by mover-interpolation.mjs. Statement
 * callbacks retain original script side effects; they must not reenter state flow.
 */
export function createDoorState(interpolation,values={}){
 if(values.DelayTime||values.bTriggerOnceOnly||values.Event)throw Error('Unsupported TriggerToggle state branch');
 return{interpolation,values,code:null,latent:0,revision:0,savedTrigger:null,instigator:null,opening:false,delaying:false,ambientSound:null};
}
export function gotoDoorLabel(door,label){
 if(label!=='open'&&label!=='close')throw Error('Unsupported TriggerToggle label');
 door.code=label;door.latent=0;door.revision++;
}
export function triggerDoorState(door,other,instigator,{dispatch}){
 if(door.values.bDestroyed)return false;
 door.savedTrigger=other;door.instigator=instigator;
 if(other)dispatch(other,'BeginEvent',[]);
 const m=door.interpolation;
 gotoDoorLabel(door,m.key===0||m.key<m.previousKey?'open':'close');
 return true;
}
/** Call only at this actor's original ProcessState phase, before its physics. */
export function processDoorState(door,callbacks){
 if(!door.code)return;
 if(door.latent){if(door.latent!==302)throw Error('Unsupported door latent action');if(door.interpolation.interpolating)return;door.latent=0;}
 const revision=door.revision;
 const call=(name,...args)=>{if(typeof callbacks[name]!=='function')throw Error(`Door state requires ${name}`);callbacks[name](...args);if(door.revision!==revision)throw Error('Reentrant door state callbacks are unsupported');};
 if(door.code==='open'||door.code==='close'){
  const opening=door.code==='open';door.opening=opening;door.delaying=false;
  call('interpolateTo',door,opening?1:Math.max(0,door.interpolation.key-1),door.values.MoveTime);
  call('playSound',door,opening?'OpeningSound':'ClosingSound');
  door.ambientSound=door.values.MoveAmbientSound??null;
  door.code=opening?'finishOpen':'finishClose';door.latent=302;return;
 }
 if(door.code==='finishOpen'){
  call('playSound',door,'OpenedSound');call('finishNotify',door);
  if(door.savedTrigger)call('dispatch',door.savedTrigger,'EndEvent',[]);
 }else if(door.code==='finishClose'){
  call('playSound',door,'ClosedSound');
  if(door.savedTrigger)call('dispatch',door.savedTrigger,'EndEvent',[]);
  door.savedTrigger=null;door.instigator=null;call('finishNotify',door);
 }else throw Error('Unsupported door state continuation');
 door.code=null;
}
/** Frob gates and inherited Frob have already succeeded. orderedDoors is the
 * original AllActors(DeusExMover,Tag) enumeration, not spatial/hash order. */
export function triggerFrobbedDoor(door,other,instigator,orderedDoors,callbacks){
 triggerDoorState(door,other,instigator,callbacks);
 const tag=door.values.Tag;
 if(!tag||tag.toLowerCase()==='deusexmover'||tag.toLowerCase()==='none')return;
 for(const linked of orderedDoors)if(linked!==door)triggerDoorState(linked,other,instigator,callbacks);
}
