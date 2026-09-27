/** Original execSetRotation -> ULevel.MoveActor with Delta=0. Early unchanged/
 * rotation-only paths have no hash/zone/touch work. A based-rider branch uses
 * the live level's recovered MoveActor; unlinked actors and brushes fail.
 * Evidence: docs/script-set-rotation.md. */
export function setScriptRotation(receiver,newRotation,{levelFor,read,write}) {
  if(!receiver||typeof levelFor!=='function')throw new Error('SetRotation requires a live actor level');
  const level=levelFor(receiver);
  if(!level||typeof level.editor!=='boolean')throw new Error('SetRotation requires the original level/editor context');
  if(!Array.isArray(newRotation)||newRotation.length!==3)throw new Error('SetRotation requires an original rotator');
  const requested=newRotation.map(value=>value|0);
  if(!level.editor&&(read(receiver,'bStatic')||!read(receiver,'bMovable')))return false;
  if(read(receiver,'Rotation').every((value,index)=>value===requested[index]))return true;
  if(read(receiver,'Brush')!==null)
    throw new Error('SetRotation with a brush requires full MoveActor support');
  if(read(receiver,'StandingCount')!==0){
    if(typeof level.moveActor!=='function')
      throw new Error('SetRotation with riders requires the live MoveActor service');
    const hit=[0,0,0,0,0,0,0,0,0,1,-1];
    return Boolean(level.moveActor(receiver,[0,0,0],requested,hit,0,0,0,0));
  }
  write(receiver,'Rotation',requested);
  return true;
}
