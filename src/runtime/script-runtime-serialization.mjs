import {serializeAActor} from './script-actor-serialization.mjs';
import {serializeGcObject} from './script-object-serialization.mjs';

const slot=(get,set)=>({get,set});
function preservedSlot(get,label) {
  return slot(get,value=>{
    if(value!==get())throw new Error(`GC replacement of ${label} is not linked`);
  });
}

/** Bind the verified Actor -> UObject GC serializer to live script storage.
 * The archive consumes script identities and FName strings (use the GC bridge
 * for native registry records). Native class layout and allocator operations
 * remain explicit services; this does not bootstrap a complete loaded world.
 */
export function serializeRuntimeActor(runtime,receiver,archive,options={}) {
  const instance=runtime.instance(receiver),object=instance.nativeObject;
  if(!object||!Object.hasOwn(object,'stateFrame'))
    throw new Error('Actor GC serialization requires a native UObject record');
  const identity=record=>{
    if(record===null)return null;
    if(!record?.identity)throw new Error('Native header reference lacks a registered script identity');
    return record.identity;
  };
  const headerReference=key=>slot(()=>identity(object[key]),value=>{
    if(value===null){object[key]=null;return;}
    const record=options.resolveObject?.(value);
    if(!record||record.identity!==value)throw new Error(`GC ${key} identity is not linked`);
    object[key]=record;
  });
  const layout={
    name:slot(()=>object.name,value=>{object.name=value;}),
    outer:headerReference('outer'),linker:headerReference('linker'),
    class:preservedSlot(()=>instance.cls.record,'an actor class'),
    stateFrame:slot(()=>object.stateFrame,value=>{
      object.stateFrame=value;instance.state=value;
    }),
  };
  const frameLayout=state=>{
    if(state!==instance.state)throw new Error('Native state-frame identity differs from live script continuation');
    const codeNode=()=>state.codeNode??state.stateNode??instance.cls;
    return {
      node:preservedSlot(()=>codeNode().record,'executing Node metadata'),
      state:preservedSlot(()=>state.stateNode?.record??instance.cls.record,'active State metadata'),
      probeMask:slot(()=>state.probeMask,value=>{state.probeMask=[...value];}),
      latentAction:slot(()=>state.latent,value=>{state.latent=value;}),
      // Host bytecode cursors are offsets. Null remains distinct from offset
      // zero, which names the first instruction of a non-null native Code.
      codePointer:slot(()=>state.execution?.cursor??null,value=>{
        if(state.execution)state.execution.cursor=value;
        else if(value!==null)throw new Error('GC cannot install code without a linked state execution');
      }),
    };
  };
  return serializeAActor(object,archive,{serializeUObject:(object,archive)=>serializeGcObject(object,archive,{
    ...options,layout,frameLayout,
    isCoreClassObject:value=>value===options.coreClassIdentity,
    nodeCodeRange:node=>{
      const state=runtime.states.get(node.key);
      if(state?.record===node)return {start:0,size:state.script.scriptSize};
      if(node===instance.cls.record)return {start:0,size:instance.cls.metadata.scriptSize};
      throw new Error(`GC state Code node is not prepared: ${node?.key??'<node>'}`);
    },
    serializeProperties:()=>runtime.serializeReferences(receiver,archive),
  })});
}
