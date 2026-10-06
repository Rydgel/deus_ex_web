import {propertyReference} from './script-values.mjs';
import {bumpBaseEpoch} from './base-epoch.mjs';
import {identityOfHandle} from './script-object-handles.mjs';

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
// A struct member of the struct value `ref` reads and writes.
const memberReference=(member,ref)=>propertyReference(member,
  ()=>ref.get()[member.key],value=>{
    const struct=ref.get();struct[member.key]=value;ref.set(struct);
  });

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
        cleanupScriptReferences(members,member=>memberReference(member,ref),services,{editor});
      }
    }
  };
  if(editor)for(const field of fields)visit(field);
  else{
    for(const field of fields)if(objectField(field))visit(field);
    for(const field of fields)if(structField(field))visit(field);
  }
}

/** Play's cleanupScriptReferences order as a flat list of the object
 * references it visits, each {key, top, path}: the property's key, its
 * top-level field's key, and per struct level the property and its
 * fixed-array index. Null where that routine would throw (a struct that
 * is not linked), so the caller runs it instead. Host work: the sites are
 * the same slots in the same order. */
export function cleanupSites(fields) {
  const sites=[];
  const walk=(fields,path)=>{
    for(const field of fields)if(objectField(field))
      for(let index=0;index<field.metadata.arrayDim;index++){
        const at=[...path,{field,index}];
        sites.push({key:field.key,top:at[0].field.key,path:at});
      }
    for(const field of fields)if(structField(field)&&!plainStruct(field)){
      const members=field.metadata.structFields;
      if(!Array.isArray(members))return false;
      for(let index=0;index<field.metadata.arrayDim;index++)if(!walk(members,[...path,{field,index}]))return false;
    }
    return true;
  };
  return walk(fields,[])?sites:null;
}
/** The fields cleanupScriptReferences reads at the top level in play. */
export const cleanupFields=fields=>fields.filter(field=>objectField(field)||structField(field)&&!plainStruct(field));

// The reference cleanupScriptReferences visits at a site (cleanupSites).
function siteReference(site,reference) {
  let ref=null;
  for(const {field,index} of site.path)
    ref=elementReference(field,ref===null?reference(field):memberReference(field,ref),index);
  return ref;
}

/** cleanupScriptReferences in play over pointers read from an object image:
 * `sites` (cleanupSites) at their image offsets `offsets` from `base`. A
 * site under a top-level field in `bound` (the object's host bindings) is
 * read through `reference`, as that routine reads it. Each referenced object
 * is validated and asked IsPendingKill once per `verdicts` (one
 * CleanupDestroyed pass: neither answer changes while the pass clears
 * references); a pending one's site is cleared through `reference`, as
 * cleanupScriptReferences clears it. */
export function cleanupImageSites(sites,offsets,view,base,bound,reference,services,verdicts) {
  for(let index=0;index<sites.length;index++){
    const site=sites[index];
    let target;
    if(bound!==null&&bound.has(site.top))target=siteReference(site,reference).get();
    else{
      const handle=view.getUint32(base+offsets[index],true);
      target=handle===0?null:identityOfHandle(handle);
    }
    if(target===null)continue;
    let pending=verdicts.get(target);
    if(pending===undefined){
      if(typeof services.isValid!=='function'||services.isValid(target)!==true)
        throw new Error(`CleanupDestroyed found an invalid or unregistered reference: ${site.key}`);
      if(typeof services.isPendingKill!=='function')throw new Error('CleanupDestroyed requires the native IsPendingKill binding');
      pending=Boolean(services.isPendingKill(target));
      verdicts.set(target,pending);
    }
    if(pending)siteReference(site,reference).set(null);
  }
}

/** Engine CompactActors103963e0: stable compaction only after Level+110.
 * A caller must supply that native index; filtering the whole array changes
 * the permanent-prefix indices and is not equivalent. */
export function compactScriptActors(level,{read,warning,recordArrayRemoval,settled}={}) {
  const actors=level.actors,start=level.firstDynamicActor;
  if(!Array.isArray(actors)||!Number.isInteger(start)||start<0||start>actors.length)
    throw new Error('CompactActors requires the original Level+0x110 prefix index');
  if(!Object.hasOwn(level,'undo'))throw new Error('CompactActors requires the original undo context');
  // Host work: `settled` (level.rs) is true only when the loop below would
  // warn of nothing and move nothing.
  if(settled?.(actors,start))return;
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
