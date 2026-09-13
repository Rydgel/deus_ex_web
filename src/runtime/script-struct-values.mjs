import {Reader,PackageError} from '../unreal/package.mjs';
import {nameAt,objectAt} from '../unreal/objects.mjs';
import {zeroValue,copyValue} from './script-values.mjs';

const singleField=field=>({...field,metadata:{...field.metadata,arrayDim:1}});

/** Decode one tagged StructProperty element through its linked SerializeBin
 * member order. Native layouts/padding are not serialized into this stream.
 * Source: Core.dll 101691b0 -> 10126610; docs/script-struct-values.md. */
export async function readScriptStructValue(asset,field,data,{initialValue,resolveObject,persistent}={}) {
  if(field.metadata?.type!=='struct')throw new TypeError('Expected a linked StructProperty');
  const reader=new Reader(data);
  async function element(property,initial) {
    const metadata=property.metadata;
    switch(metadata.type){
      case 'byte': return reader.u8();
      case 'int': return reader.i32();
      case 'float': return reader.f32();
      case 'bool': return reader.u8()!==0;
      case 'name': return nameAt(asset.pkg,reader.compact());
      case 'string': return reader.string(asset.pkg.version);
      case 'object': case 'class': {
        const index=reader.compact();objectAt(asset.pkg,index);
        if(!index)return null;
        if(typeof resolveObject!=='function')throw new Error(`Struct object resolution is not bound: ${property.key}`);
        return resolveObject(asset,index);
      }
      case 'struct': {
        if(metadata.structKey==='core.object.vector')return [reader.f32(),reader.f32(),reader.f32()];
        if(metadata.structKey==='core.object.rotator')return [reader.i32(),reader.i32(),reader.i32()];
        if(!metadata.structFields)throw new Error(`Struct member metadata is not linked: ${property.key}`);
        const value=initial===undefined?zeroValue(singleField(property)):copyValue(singleField(property),initial);
        for(const member of metadata.structFields){
          const flags=member.metadata.flags;
          if(flags&0x1000)continue;
          if(flags&0x2000){
            if(persistent===undefined)throw new Error(`Struct transient member requires archive persistence: ${member.key}`);
            if(persistent)continue;
          }
          const dim=member.metadata.arrayDim;
          if(!Number.isInteger(dim)||dim<1)throw new Error(`Invalid struct member ArrayDim: ${member.key}`);
          if(dim===1)value[member.key]=await element(member,value[member.key]);
          else for(let i=0;i<dim;i++)value[member.key][i]=await element(member,value[member.key][i]);
        }
        return value;
      }
      default: throw new Error(`Unsupported serialized struct member ${metadata.type}: ${property.key}`);
    }
  }
  const value=await element(field,initialValue);
  if(reader.offset!==data.length)throw new PackageError(`Unexpected serialized struct size: ${field.key}`,reader.offset);
  return value;
}
