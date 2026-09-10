import {GC_ARCHIVE_WORDS} from './script-gc.mjs';

/** Bridge the script host's canonical UObject identities/FName values to the
 * native registry records consumed by the recovered Core GC archive. This is
 * a storage adapter, not a native UObject or subclass Serialize implementation.
 * Reference writes must reach the original typed lvalue; no snapshot list of
 * edges is substituted for the native archive's mutable pointer arguments.
 */
export function createScriptGcBridge(archive,{registry,resolveObject,resolveName}) {
  if(typeof archive?.serializeObject!=='function'||typeof archive.serializeName!=='function')
    throw new Error('Script GC bridge requires the original object and name mark archive');
  if(!Array.isArray(registry?.objects)||!Array.isArray(registry.names)
    ||typeof resolveObject!=='function'||typeof resolveName!=='function')
    throw new Error('Script GC bridge requires complete native object/name registry bindings');
  const objectRecord=identity=>{
    if(identity===null)return null;
    const object=resolveObject(identity);
    if(!object||object.identity!==identity||!Number.isInteger(object.index)||registry.objects[object.index]!==object)
      throw new Error(`Script GC reference is not registered: ${identity?.key??identity?.name??'<object>'}`);
    return object;
  };
  const nameRecord=value=>{
    const name=resolveName(value);
    if(!name||!Number.isInteger(name.index)||registry.names[name.index]!==name)
      throw new Error(`Script GC name is not registered: ${String(value)}`);
    return name;
  };
  const reference=ref=>{
    if(typeof ref?.get!=='function'||typeof ref.set!=='function')
      throw new Error('Script GC requires a mutable typed reference');
    return ref;
  };
  const bridge={
    archiveState:archive.archiveState??{...GC_ARCHIVE_WORDS},
    mapObject(value){
      if(typeof archive.mapObject!=='function')throw new Error('GC archive MapObject is not bound');
      // The recovered collector MapObject ignores its argument. In
      // particular this must not perform a registry lookup or mark it.
      return archive.mapObject(value);
    },
    mapName(value){
      if(typeof archive.mapName!=='function')throw new Error('GC archive MapName is not bound');
      return archive.mapName(value);
    },
    objectReference(ref){
      reference(ref);
      archive.serializeObject({
        get:()=>objectRecord(ref.get()),
        set:object=>{
          if(object!==null&&objectRecord(object.identity)!==object)
            throw new Error('GC returned an invalid object reference');
          ref.set(object?.identity??null);
        },
      });
      return bridge;
    },
    nameReference(ref){
      reference(ref);
      archive.serializeName({
        get:()=>nameRecord(ref.get()),
        // The verified mark archive changes FNameEntry flags, never the
        // FName value itself. A load/save name fixup is a different archive.
        set:()=>{throw new Error('The Core mark archive must not rewrite FName values');},
      });
      return bridge;
    },
  };
  return bridge;
}
