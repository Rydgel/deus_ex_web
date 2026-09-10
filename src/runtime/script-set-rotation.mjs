/** Original execSetRotation -> ULevel.MoveActor with Delta=0. This implements
 * the early unchanged/rotation-only paths. Riders and brushes still require
 * the full MoveActor path; no hash/zone/touch work occurs on this short path.
 * Evidence: docs/script-set-rotation.md. */
export function setScriptRotation(receiver,newRotation,{levelFor,read,write}) {
  if(!receiver||typeof levelFor!=='function')throw new Error('SetRotation requires a live actor level');
  const level=levelFor(receiver);
  if(!level||typeof level.editor!=='boolean')throw new Error('SetRotation requires the original level/editor context');
  if(!Array.isArray(newRotation)||newRotation.length!==3)throw new Error('SetRotation requires an original rotator');
  const requested=newRotation.map(value=>value|0);
  if(!level.editor&&(read(receiver,'bStatic')||!read(receiver,'bMovable')))return false;
  if(read(receiver,'Rotation').every((value,index)=>value===requested[index]))return true;
  if(read(receiver,'StandingCount')!==0||read(receiver,'Brush')!==null)
    throw new Error('SetRotation with riders or a brush requires full MoveActor support');
  write(receiver,'Rotation',requested);
  return true;
}
