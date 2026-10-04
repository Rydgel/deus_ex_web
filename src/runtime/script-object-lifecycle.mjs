/** Core UObject lifetime operations on an explicitly registered native record.
 * The record holds identity/index/flags/outer/linker/linkerIndex; script storage
 * and native subclass destruction are supplied by the runtime. See the source
 * addresses and supported property cleanup in docs/script-object-lifecycle.md. */
export function setObjectLinker(object,linker,index) {
  if(object.linker){
    const entry=object.linker.exports[object.linkerIndex];
    if(!entry?.object||entry.object!==object.identity)throw new Error('Original linker export/object identity mismatch');
    entry.object=null;
  }
  object.linker=linker;object.linkerIndex=index;
}

export function destroyScriptObject(object,{exitProperties}) {
  if(typeof exitProperties!=='function')throw new Error('Object destruction requires linked property cleanup');
  object.flags=(object.flags|0x80000000)>>>0;
  exitProperties(object.identity);
  setObjectLinker(object,null,-1);
  // Native +0x14 stores the outer index after the linker has been removed.
  // A pre-placed map actor Outer is not in Play's registry; its measured
  // GObjObjects index (hashIndex) is the index its owned objects hash by
  // (ScriptObjectRegistry.add), e.g. a ParticleGenerator's RenderInterface.
  const outer=object.outer;
  object.linkerIndex=outer?(Number.isInteger(outer.index)?outer.index:outer.hashIndex??outer.index):0;
}

export function conditionalDestroyScriptObject(object,{destroy,warning}) {
  if(object.index===-1||object.flags&0x00800000)return false;
  if(typeof destroy!=='function')throw new Error('Object destruction requires its native virtual hook');
  object.flags=(object.flags|0x00800000)>>>0;
  destroy(object.identity);
  if(!(object.flags&0x80000000))warning?.({type:'MissingBaseDestroy',object:object.identity});
  return true;
}

export function modifyScriptObject(object,undo) {
  if(undo&&object.flags&1){
    if(typeof undo.saveObject!=='function')throw new Error('Transactional Modify requires the original undo boundary');
    undo.saveObject(object.identity);
  }
}
