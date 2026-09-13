import {destructScriptObject,freeScriptObject} from './script-object-release.mjs';

/** ConSys ConListItem constructor1000ecc0 after StaticAllocateObject. */
export function constructConversationItem(object,{write}={}) {
  if(typeof write!=='function')throw new Error('ConListItem constructor requires typed fields');
  object.nativeVtable=0x10179dfc;
  object.nativeVtable=0x1001346c;
  write(object.identity,'con',null);
  write(object.identity,'next',null);
}

/** ConSys ConListItem deleting wrapper10002ed0, scalar branch. */
export function releaseConversationItem(object,flags,services) {
  if(object.nativeVtable!==0x1001346c)throw new Error('ConListItem release requires its native vtable');
  if(!Number.isInteger(flags)||flags&2)throw new Error('ConListItem array release is unsupported');
  if(typeof services.conditionalDestroy!=='function')throw new Error('ConListItem release requires ConditionalDestroy');
  for(const table of [0x1001346c,0x100131c4]){
    object.nativeVtable=table;services.conditionalDestroy(object);
  }
  destructScriptObject(object,services);
  if(flags&1)freeScriptObject(object,services);
  return object;
}
