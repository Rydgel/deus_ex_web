import {readFieldLinks,readStructMetadata} from '../unreal/script-metadata.mjs';
import {linkScriptStruct,SCRIPT_STRUCT_LINK} from './script-struct-link.mjs';
import {SCRIPT_SCALAR_PROPERTY_LINK} from './script-scalar-property-link.mjs';
import {SCRIPT_BOOL_PROPERTY_LINK} from './script-bool-property-link.mjs';
import {SCRIPT_STR_PROPERTY_LINK} from './script-str-property-link.mjs';
import {SCRIPT_STRUCT_PROPERTY_LINK} from './script-struct-property-link.mjs';
import {NativeSlots} from './native-slots.mjs';

const vtables=new Map(Object.entries(SCRIPT_SCALAR_PROPERTY_LINK.properties)
  .map(([kind,body])=>[kind,body.vtable]));
vtables.set('BoolProperty',SCRIPT_BOOL_PROPERTY_LINK.boolProperty.vtable);
vtables.set('StrProperty',SCRIPT_STR_PROPERTY_LINK.strProperty.vtable);
vtables.set('StructProperty',SCRIPT_STRUCT_PROPERTY_LINK.structProperty.vtable);
const slot=(object,offset)=>object.nativeSlots.value(offset);
const put=(object,offset,value)=>object.nativeSlots.set(offset,value,4);

/** Original package metadata -> recovered UStruct/property Link slot boundary.
 * The returned native layout is separate from keyed logical VM value storage.
 * See docs/script-struct-layout.md for the original contract and exclusions. */
export async function loadScriptStructLayout(runtime,record,ancestry=[]) {
  if(record.kind!=='Struct')throw new Error(`Expected script Struct for layout: ${record.key}`);
  if(ancestry.includes(record.key))throw new Error(`Cyclic by-value script struct layout: ${record.key}`);
  const metadata=readStructMetadata(record.asset,record.index,{includeChildren:false});
  const path=[...ancestry,record.key];
  const base=metadata.baseRef?await runtime.structLayout(
    await runtime.objects.resolve(record.asset,metadata.baseRef),path):null;
  const layout={record,key:record.key,kind:'Struct',nativeVtable:0x10175698,
    nativeSlots:new NativeSlots(),fields:new Map(),preloaded:true};
  for(const [offset,value] of [[0,layout.nativeVtable],[0x28,base],[0x38,null],[0x3c,0]])put(layout,offset,value);
  let child=await runtime.objects.resolve(record.asset,metadata.childrenRef),previous=null;
  const seen=new Set();
  while(child){
    if(seen.has(child.key))throw new Error(`Cyclic struct layout Children: ${child.key}`);
    seen.add(child.key);
    const owner=await runtime.objects.resolve(child.asset,child.entry.outer);
    if(owner!==record)throw new Error(`Unsupported foreign Outer in struct layout: ${child.key}`);
    const node={record:child,key:child.key,kind:child.kind,nativeSlots:new NativeSlots(),preloaded:true};
    put(node,0x18,layout);put(node,0x2c,null);
    if(child.kind.endsWith('Property')){
      const field=await runtime.field(child,path),m=field.metadata;
      const vtable=vtables.get(child.kind);
      if(vtable===undefined)throw new Error(`Unsupported loaded struct property layout: ${child.kind}`);
      if(m.flags&0x20)throw new Error(`Unsupported replicated script struct member: ${child.key}`);
      node.nativeVtable=vtable;
      for(const [offset,value] of [[0,vtable],[0x34,m.arrayDim],[0x38,0],[0x3c,m.flags],[0x48,0]])put(node,offset,value);
      if(m.type==='bool')put(node,0x5c,1);
      if(m.type==='struct')put(node,0x5c,m.structLayout);
      layout.fields.set(child.key,node);
    }
    put(previous??layout,previous?0x2c:0x38,node);previous=node;
    const {nextRef}=readFieldLinks(child.asset,child.index);
    child=await runtime.objects.resolve(child.asset,nextRef);
  }
  const archive={preload(object){
    if(!object?.preloaded)throw new Error('Struct Link reached metadata before async preload completed');
  }};
  linkScriptStruct(layout,{archive,secondArgument:1,services:{isA(object,target){
    if(target===SCRIPT_STRUCT_LINK.propertyClass)return vtables.has(object.kind);
    if(target===SCRIPT_STRUCT_LINK.objectPropertyClass)return ['ObjectProperty','ClassProperty'].includes(object.kind);
    if(target===SCRIPT_STRUCT_LINK.structPropertyClass)return object.kind==='StructProperty';
    throw new Error(`Unsupported struct layout class test: ${target}`);
  }}});
  layout.propertiesSize=slot(layout,0x3c);
  layout.destroyHead=slot(layout,0x68);
  for(const node of layout.fields.values()){
    node.elementSize=slot(node,0x38);node.offset=slot(node,0x48);
    node.flags=slot(node,0x3c);node.bitMask=node.kind==='BoolProperty'?slot(node,0x5c):null;
    // Only stride and computed ownership flags affect logical value services.
    // Native offsets and packed masks remain in this independent layout graph.
    node.record.metadata.elementSize=node.elementSize;
    node.record.metadata.flags=node.flags;
  }
  return layout;
}
