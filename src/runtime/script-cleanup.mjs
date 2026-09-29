import {propertyReference} from './script-values.mjs';
import {bumpBaseEpoch} from './base-epoch.mjs';

const objectField=field=>field.metadata.type==='object'||field.metadata.type==='class';
const structField=field=>field.metadata.type==='struct';
const plainStruct=field=>['core.object.vector','core.object.rotator'].includes(field.metadata.structKey);

function elementReference(field,ref,index) {
  if(field.metadata.arrayDim===1)return ref;
  const scalar={...field,metadata:{...field.metadata,arrayDim:1,arrayDimension:1}};
  return propertyReference(scalar,()=>ref.get()[index],value=>{
    const array=ref.get();array[index]=value;ref.set(array);
  });
}

/** Core UStruct.CleanupDestroyed10127170. In play it visits the linked direct
 * object-property list before the struct list; editor mode uses their original
 * interleaved child/super order and calls Modify on a pending target first.
 * Arrays here are fixed UProperty ArrayDim slots. Native dynamic-array/map
 * properties are not visited by this routine. See docs/script-cleanup.md.
 */
export function cleanupScriptReferences(fields,reference,services,{editor=false}={}) {
  const visit=field=>{
    if(!objectField(field)&&!structField(field))return;
    if(structField(field)&&plainStruct(field))return;
    const whole=reference(field),count=field.metadata.arrayDim;
    for(let index=0;index<count;index++){
      const ref=elementReference(field,whole,index);
      if(objectField(field)){
        const target=ref.get();
        if(target===null)continue;
        if(typeof services.isValid!=='function'||services.isValid(target)!==true)
          throw new Error(`CleanupDestroyed found an invalid or unregistered reference: ${field.key}`);
        if(typeof services.isPendingKill!=='function')throw new Error('CleanupDestroyed requires the native IsPendingKill binding');
        if(services.isPendingKill(target)){
          if(editor){
            if(typeof services.modify!=='function')throw new Error('Editor CleanupDestroyed requires native Modify');
            services.modify(target);
          }
          ref.set(null);
        }
      }else{
        const members=field.metadata.structFields;
        if(!Array.isArray(members))throw new Error(`CleanupDestroyed struct is not linked: ${field.key}`);
        cleanupScriptReferences(members,member=>propertyReference(member,
          ()=>ref.get()[member.key],value=>{
            const struct=ref.get();struct[member.key]=value;ref.set(struct);
          }),services,{editor});
      }
    }
  };
  if(editor)for(const field of fields)visit(field);
  else{
    for(const field of fields)if(objectField(field))visit(field);
    for(const field of fields)if(structField(field))visit(field);
  }
}

/** Engine CompactActors103963e0: stable compaction only after Level+110.
 * A caller must supply that native index; filtering the whole array changes
 * the permanent-prefix indices and is not equivalent. */
export function compactScriptActors(level,{read,warning,recordArrayRemoval}={}) {
  const actors=level.actors,start=level.firstDynamicActor;
  if(!Array.isArray(actors)||!Number.isInteger(start)||start<0||start>actors.length)
    throw new Error('CompactActors requires the original Level+0x110 prefix index');
  if(!Object.hasOwn(level,'undo'))throw new Error('CompactActors requires the original undo context');
  let write=start;
  for(let index=start;index<actors.length;index++){
    const actor=actors[index];
    if(actor===null)continue;
    if(read(actor,'bDeleteMe'))warning?.({type:'PendingActorInArray',actor});
    else{if(write!==index)bumpBaseEpoch();actors[write++]=actor;}
  }
  if(write===actors.length)return;
  bumpBaseEpoch();
  if(level.undo!==null){
    if(typeof recordArrayRemoval!=='function')throw new Error('CompactActors requires array transaction recording');
    recordArrayRemoval(level,write,actors.length-write);
  }
  actors.length=write;
}

/** Engine ULevel.CleanupDestroyed103965a0. Finalization occurs only after all
 * surviving actor classes have cleared references. The release callback owns
 * the native deleting-destructor and object-registry removal. */
export function cleanupLevelDestroyed(level,services,force=false) {
  const {read,cleanupReferences,release,warning}=services;
  if(typeof level?.editor!=='boolean'||!Array.isArray(level.actors)||!Object.hasOwn(level,'pendingDeleted'))
    throw new Error('CleanupDestroyed requires a complete original level context');
  if(!level.editor&&!force)compactScriptActors(level,services);
  if(level.pendingDeleted===null)return;
  let count=0;
  const seen=new Set();
  for(let actor=level.pendingDeleted;actor!==null;actor=read(actor,'Deleted')){
    if(seen.has(actor))throw new Error('Cyclic original pending-deletion chain');
    seen.add(actor);count++;
  }
  if(count<128&&!force)return;
  for(let index=0;index<level.actors.length;index++){
    const actor=level.actors[index];
    if(actor!==null)cleanupReferences(actor,{editor:level.editor});
  }
  if(level.editor)return;
  while(level.pendingDeleted!==null){
    const actor=level.pendingDeleted;
    if(!read(actor,'bDeleteMe'))warning?.({type:'PendingChainActorNotDeleted',actor});
    level.pendingDeleted=read(actor,'Deleted');
    if(!read(actor,'bDeleteMe'))warning?.({type:'ReleasedActorNotDeleted',actor});
    const levelInfo=level.actors[0];
    if(!levelInfo)throw new Error('CleanupDestroyed requires the original LevelInfo');
    const manager=read(levelInfo,'EventManager');
    if(manager!==null){
      if(typeof services.destroyActorEvents!=='function')throw new Error('CleanupDestroyed requires EventManager.DestroyActor');
      services.destroyActorEvents(manager,actor);
    }
    release(actor,1);
  }
}
