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

/** fieldAccessors for the per-binding lists: the same reads, held without a closure for each. An object made by fieldAccessors keeps,
 * for each of its names, an arrow function, the context of its `read` variable and the function that replaces `read` after the first
 * read, with that function's own context: about four heap objects a name, and a mesh binding keeps twenty-three names (docs/live-heap.md
 * "Step 4's results"). Here the readers are methods of a class made once for the list of names, and an object keeps the instance link
 * and one slot a name: undefined before the first read, `false` when the receiver has no instance link and reads through readNamed,
 * else the name's field handle (runtime.namedHandle: the linked field, its codec and its cell, which the closures captured). Every
 * read does what the closure did: the first is readNamed, the later ones readInstanceField after the released check. A caller adds
 * or replaces a reader by assigning an own property (`Object.assign(readers, overrides)`), as for fieldAccessors' object;
 * `hasReader` tells whether a name has a reader. */
const readerClasses=new Map();
export function fieldReaders(runtime,receiver,names) {
  const key=names.join(',');
  let Readers=readerClasses.get(key);
  if(Readers===undefined){
    Readers=class FieldReaders {
      constructor(runtime,receiver){this.runtime=runtime;this.receiver=receiver;this.instance=undefined;this.handles=new Array(names.length).fill(undefined);}
    };
    Readers.names=new Set(names);
    names.forEach((name,index)=>{
      Object.defineProperty(Readers.prototype,name,{configurable:true,writable:true,value:function(){return readHandle(this,index,name);}});
    });
    readerClasses.set(key,Readers);
  }
  return new Readers(runtime,receiver);
}
/** Whether `readers` (a fieldReaders object, or a fieldAccessors object) reads `name`. */
export const hasReader=(readers,name)=>Object.hasOwn(readers,name)||readers.constructor.names?.has(name)===true;

function readHandle(self,index,name) {
  const handles=self.handles,handle=handles[index],runtime=self.runtime;
  if(handle===undefined){
    const receiver=self.receiver,value=runtime.readNamed(receiver,name);
    const linked=runtime.instance(receiver);
    // (the instance link of a receiver never changes once defined; a different one would read through readNamed)
    if(runtime.instanceKey===undefined||receiver[runtime.instanceKey]!==linked||(self.instance!==undefined&&self.instance!==linked)){handles[index]=false;return value;}
    self.instance=linked;handles[index]=runtime.namedHandle(linked,name);
    return value;
  }
  if(handle===false)return runtime.readNamed(self.receiver,name);
  const instance=self.instance;
  if(instance.nativeObject?.released)throw new Error('Script object allocation has been released');
  return runtime.readInstanceField(instance,handle.field,handle.codec,handle.cell);
}

/** fieldAccessor for one name as an object: `read(runtime, name)` is the accessor's call. The level keeps one of these for the Mesh of
 * every actor in it (a closure pair and two contexts each as an accessor, docs/live-heap.md "Step 4's results"); the fields are the
 * state the closures held (handle undefined: not read yet; false: no instance link, read through readNamed). The caller names the
 * runtime and the property, the same for all of them. */
export class FieldReader {
  constructor(receiver) {
    this.receiver=receiver;this.instance=undefined;this.handle=undefined;
  }
  read(runtime,name) {
    const handle=this.handle;
    if(handle===undefined){
      const receiver=this.receiver,value=runtime.readNamed(receiver,name);
      const linked=runtime.instance(receiver);
      if(runtime.instanceKey===undefined||receiver[runtime.instanceKey]!==linked){this.handle=false;return value;}
      this.instance=linked;this.handle=runtime.namedHandle(linked,name);
      return value;
    }
    if(handle===false)return runtime.readNamed(this.receiver,name);
    if(this.instance.nativeObject?.released)throw new Error('Script object allocation has been released');
    return runtime.readInstanceField(this.instance,handle.field,handle.codec,handle.cell);
  }
}
