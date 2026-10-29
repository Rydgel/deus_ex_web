import {Reader,PackageError} from '../unreal/package.mjs';
import {nameAt,objectAt} from '../unreal/objects.mjs';
import {cloneMetadata} from './clone-metadata.mjs';
import {zeroValue,copyValue} from './script-values.mjs';

const singleField=field=>({...field,metadata:cloneMetadata(field.metadata,{arrayDim:1})});

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
      // the process table's spelling, as objects.mjs readObject reads a Name (unreal/name-spelling.mjs)
      case 'name': { const text=nameAt(asset.pkg,reader.compact()); return asset.pkg.nameSpelling?asset.pkg.nameSpelling.spell(text):text; }
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

/** Decode one tagged ArrayProperty element (UArrayProperty::SerializeItem): the compact element count, then each element as the inner property
 * serializes it. The runtime holds dynamic arrays whole and only for int, object and string elements (script-values.mjs), so those are the
 * element types read here; any other inner type stops by name. */
export async function readScriptArrayValue(asset,field,data,{resolveObject}={}) {
  if(field.metadata?.type!=='array')throw new TypeError('Expected a linked ArrayProperty');
  const inner=field.metadata.innerMetadata,innerType=inner?.type;
  const reader=new Reader(data),count=reader.compact(),out=[];
  if(count<0||count>data.length)throw new PackageError(`Invalid array count ${count}`,reader.offset);
  for(let i=0;i<count;i++){
    switch(innerType){
      case 'int': out.push(reader.i32()); break;
      case 'string': out.push(reader.string(asset.pkg.version)); break;
      case 'object': {
        const index=reader.compact();objectAt(asset.pkg,index);
        if(!index){out.push(null);break;}
        if(typeof resolveObject!=='function')throw new Error(`Array object resolution is not bound: ${field.key}`);
        out.push(await resolveObject(asset,index));
        break;
      }
      default: throw new Error(`Serialized array of ${innerType} is not supported: ${field.key}`);
    }
  }
  if(reader.offset!==data.length)throw new PackageError(`Unexpected serialized array size: ${field.key}`,reader.offset);
  return out;
}
