import {GC_ARCHIVE_WORDS} from './script-gc.mjs';

/** Original Core.dll instance vtables, not native class-object addresses. */
export const PROPERTY_SERIALIZER_VTABLES=Object.freeze({
  Property:0x10175a44,IntProperty:0x10175bc4,FloatProperty:0x10175d44,
  NameProperty:0x10175f84,StrProperty:0x10176044,ByteProperty:0x10175b04,
  BoolProperty:0x10175c84,ObjectProperty:0x10175e04,ClassProperty:0x10175ec4,
  FixedArrayProperty:0x10176104,ArrayProperty:0x101761c4,MapProperty:0x10176284,
  StructProperty:0x10176344,
});
const classes=new Map(Object.entries(PROPERTY_SERIALIZER_VTABLES).map(([name,address])=>[address,name]));

/** Serialize the UProperty metadata object, not its instance value storage.
 * UField and all pointer slots must be bound to the original live graph.
 * The concrete mark archive inherits a no-op raw Serialize; observing raw
 * bytes is optional and never justifies inventing unlinked native values.
 */
export function serializeGcProperty(object,archive,services={}) {
  const name=classes.get(object?.nativeVtable);
  if(!name)throw new Error('GC property serializer requires a verified Core property vtable');
  for(const key of ['ar04','ar08','ar0c','ar10','ar14','ar18','ar1c','ar20','ar24']){
    if(archive?.archiveState?.[key]!==GC_ARCHIVE_WORDS[key])
      throw new Error(`GC property serializer requires collector archive ${key}`);
  }
  if(typeof services.serializeUField!=='function'||typeof services.slot!=='function')
    throw new Error('GC property serializer requires UField serialization and native storage slots');
  const objectReference=archive.objectReference??archive.serializeObject;
  const nameReference=archive.nameReference??archive.serializeName;
  if(typeof objectReference!=='function'||typeof nameReference!=='function')
    throw new Error('GC property serializer requires object and name archive operations');
  const slot=offset=>{
    const reference=services.slot(object,offset);
    if(typeof reference?.get!=='function'||typeof reference.set!=='function')
      throw new Error(`Unlinked ${name} serialization slot +${offset.toString(16)}`);
    return reference;
  };
  const context=offset=>({kind:'property-metadata',object,className:name,offset});
  const raw=(offset,size)=>{
    if(typeof archive.serializeRaw==='function')archive.serializeRaw(slot(offset),size,context(offset));
  };
  const ref=offset=>objectReference.call(archive,slot(offset),context(offset));
  services.serializeUField(object,archive);
  raw(0x34,4);raw(0x3c,4);
  nameReference.call(archive,slot(0x40),context(0x40));
  const flags=slot(0x3c).get();
  if(!Number.isInteger(flags))throw new Error('Unlinked native UProperty flags');
  if(flags&0x20)raw(0x44,2);
  switch(name){
    case 'ClassProperty':ref(0x5c);ref(0x64);break;
    case 'MapProperty':ref(0x5c);ref(0x60);break;
    case 'FixedArrayProperty':ref(0x5c);raw(0x60,4);break;
    case 'ByteProperty':case 'ObjectProperty':case 'ArrayProperty':case 'StructProperty':ref(0x5c);break;
    case 'BoolProperty':raw(0x5c,4);break;
  }
}
