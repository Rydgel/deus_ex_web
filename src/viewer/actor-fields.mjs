/** Pre-resolved property reads for the per-frame render adapters. An
 * accessor makes exactly the call runtime.readNamed makes,
 * readInstanceField(instance, field, codec, cell), with the object's instance
 * link and its class's field handle resolved on the first read instead of on
 * every read. The instance link is a non-writable symbol property, so the pair
 * stays valid; the released check readNamed performs runs on every read. An
 * object without that link keeps reading through readNamed. The first read is
 * readNamed itself, so it happens (and throws) exactly where it did before.
 * Read-only: nothing here writes script state or changes a read's value. */
export function fieldAccessor(runtime,receiver,name) {
  let read=()=>{
    const value=runtime.readNamed(receiver,name);
    const instance=runtime.instance(receiver);
    if(runtime.instanceKey===undefined||receiver[runtime.instanceKey]!==instance){
      read=()=>runtime.readNamed(receiver,name);return value;
    }
    const handle=runtime.namedHandle(instance,name),{field,cell}=handle,codec=handle.codec;
    read=()=>{
      if(instance.nativeObject?.released)throw new Error('Script object allocation has been released');
      return runtime.readInstanceField(instance,field,codec,cell);
    };
    return value;
  };
  return ()=>read();
}

/** Accessors for a fixed list of one object's names, as an object of
 * zero-argument functions. */
export function fieldAccessors(runtime,receiver,names) {
  const accessors={};
  for(const name of names)accessors[name]=fieldAccessor(runtime,receiver,name);
  return accessors;
}
