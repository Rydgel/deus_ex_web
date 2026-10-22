import {readObject} from '../unreal/objects.mjs';
import {readScriptArrayValue} from './script-struct-values.mjs';

/** The standalone map linker's ContextFlags word (+0xa0): GIsClient|GIsServer,
 * the same value script-load-graph.mjs installs on every game linker. */
const STANDALONE_CONTEXT_FLAGS = 0x00030000;

/**
 * The two admission gates `ULinkerLoad::CreateExport` applies before an export
 * becomes an object (recovered at docs/script-create-export.md):
 *
 * - `0x1012e278`–`0x1012e283`: `Export.ObjectFlags & ContextFlags` must be
 *   nonzero. A local game links its map with GIsClient|GIsServer
 *   (`0x30000`), so exports authored with only `RF_LoadForEdit` — Training's
 *   992 Brush exports (`0x2340001`) and the four UnrealEd viewport cameras
 *   (`0x2340000`) — are refused before construction and `_Object` stays null.
 * - `0x1012e2fd`–`0x1012e318`: `LoadClass->Name == NAME_Camera` refuses any
 *   export whose class object is named `Camera`, independent of its flags.
 *
 * A refused export is never constructed: every serialized reference to it —
 * a `Level.Actors` slot, an Owner/Base/MyMarker property — resolves to null,
 * exactly like an authored zero reference.
 */
export function mapExportAdmitted(pkg, ref) {
  const entry = pkg.exports[ref - 1];
  if (!entry) throw new Error(`Invalid map export reference: ${ref}`);
  return (entry.flags & STANDALONE_CONTEXT_FLAGS) !== 0 && entry.className !== 'Camera';
}

/** UProperty::GetID of each property class: the tag type id the tagged-property loader compares with the file's (UObject
 * SerializeTaggedProperties: `Type mismatch in %s of %s: file %i, class %i`, then the value is skipped). A ClassProperty is an ObjectProperty
 * subclass that does not override GetID: its tags say 5 (the saved `DeusExLevelInfo.Script`, `Trigger.ClassProximityType`). */
const PROPERTY_TAG_TYPES = Object.freeze({ ByteProperty: 1, IntProperty: 2, BoolProperty: 3, FloatProperty: 4, ObjectProperty: 5, NameProperty: 6,
  StringProperty: 7, ClassProperty: 5, ArrayProperty: 9, StructProperty: 10, VectorProperty: 11, RotatorProperty: 12, StrProperty: 13,
  MapProperty: 14, FixedArrayProperty: 15 });

/** Bind serialized map properties to canonical script identities. Class defaults
 * keep their original package provenance; only map-authored refs use map indices.
 * See docs/script-map-actors.md. */
export async function prepareMapProperties(runtime, asset, actor, cls, actors) {
  const authored = new Map(), authoredFields = [];
  let rawProperties;
  // Map-authored object refs keep actor-slot identities; class records also
  // need their linked ancestry — the original package linker always builds it.
  // Refs to exports the standalone linker refused resolve to the same null
  // the original's unconstructed _Object slot yields.
  const resolveMapObject=async(source,index)=>{
    if(index>0&&!mapExportAdmitted(source.pkg,index))return null;
    if(index>0&&actors.has(index))return actors.get(index);
    const object=await runtime.objects.resolve(source,index);
    if(object?.kind==='Class')await runtime.loadClass(source,index);
    return object;
  };
  for (const [ordinal,property] of (actor.properties ?? []).entries()) {
    const field = runtime.lookupMember(cls, 'fields', property.name);
    if (!field) throw new Error(`Map property is not linked: ${actor.name}.${property.name}`);
    await runtime.field(field);
    // A tag whose type is not the linked property's is read past and dropped, with the loader's warning: a saved
    // GameReplicationInfo carries Actor.Region (a struct) under a name its own class redeclares as an int
    // (the measured restore logs `Type mismatch in Region of GameReplicationInfo: file 10, class 2`, docs/travel.md).
    const classType = PROPERTY_TAG_TYPES[field.metadata.className];
    if (classType && property.type !== classType) {
      runtime.logDevice?.({ tag: 'Warning', text: `Type mismatch in ${property.name} of ${cls.record.name}: file ${property.type}, class ${classType}` });
      runtime.logDevice?.({ tag: 'Warning', text: `Skipping ${property.byteLength} bytes of type ${property.type}` });
      continue;
    }
    let value = property.value;
    if (property.type === 10 && property.decoded) value=runtime.authoredStructValue(field,value);
    else if (property.type === 10) {
      // decodeMap's diagnostic actor descriptions omit raw property payloads.
      // Recover this original tag when the linked decoder needs its bytes.
      if(!property.data)rawProperties??=readObject(asset.pkg,asset.bytes,actor.index).properties;
      const raw=property.data?property:rawProperties[ordinal];
      if(!raw||raw.name!==property.name||raw.arrayIndex!==property.arrayIndex||raw.type!==property.type)
        throw new Error(`Original map property order changed: ${actor.name}.${property.name}`);
      const initial=authored.get(field.key)?.get(property.arrayIndex)??cls.defaults.get(field.key)?.get(property.arrayIndex);
      value=await runtime.authoredStructProperty(asset,field,raw,initial,resolveMapObject);
    } else if (property.type === 9) {
      // A dynamic array tag: the element count, then each element as its inner property serializes it (UArrayProperty::SerializeItem).
      if(!property.data)rawProperties??=readObject(asset.pkg,asset.bytes,actor.index).properties;
      const raw=property.data?property:rawProperties[ordinal];
      if(!raw||raw.name!==property.name||raw.arrayIndex!==property.arrayIndex||raw.type!==property.type)
        throw new Error(`Original map property order changed: ${actor.name}.${property.name}`);
      value=await readScriptArrayValue(asset,field,raw.data,{resolveObject:resolveMapObject});
    } else if (!property.decoded) value = {unsupported: `Undecoded map property ${actor.name}.${property.name}`};
    else if ([5, 8].includes(property.type)) value=await resolveMapObject(asset,property.value);
    if (!authored.has(field.key)) { authored.set(field.key, new Map()); authoredFields.push(field); }
    authored.get(field.key).set(property.arrayIndex, value);
  }
  const snapshot = new Map(cls.defaults);
  // The initial value of one field: its authored elements over the class
  // defaults. `authoredFields` lists the fields the map authors.
  return Object.assign(field => {
    const overrides = authored.get(field.key);
    if (!overrides) return runtime.defaultValue(cls, field, snapshot);
    for (const value of overrides.values()) if (value?.unsupported) throw new Error(value.unsupported);
    if (field.metadata.arrayDim > 1) {
      const value = runtime.defaultValue(cls, field, snapshot);
      for (const [index, item] of overrides) value[index] = item;
      return value;
    }
    return overrides.has(0) ? overrides.get(0) : runtime.defaultValue(cls, field, snapshot);
  }, {authoredFields});
}

/** Preserve the serialized Level.Actors order and null slots. The existing
 * collision world's LevelInfo is the same script object as map slot zero.
 * SpawnActor's append behavior is recovered at Engine 103951bc–103951d6. */
export function mapActorArray(map, actors, levelInfo, spawned = []) {
  const first = actors.get(map.level.actors[0]);
  if (!first || first.className !== 'LevelInfo') throw new Error('Original actor slot zero is not LevelInfo');
  if (!levelInfo || typeof levelInfo !== 'object') throw new Error('The scene requires its live LevelInfo identity');
  if (first !== levelInfo) {
    for (const name of ['index', 'name', 'className', 'properties']) levelInfo[name] = first[name];
    actors.set(first.index, levelInfo);
  }
  const result = map.level.actors.map(ref => {
    if (ref === 0) return null;
    // An export the standalone linker's CreateExport refused was never
    // constructed; its serialized slot resolves to null like an authored
    // zero reference (docs/script-map-actors.md, mapExportAdmitted).
    if (!mapExportAdmitted(map.pkg, ref)) return null;
    if (!actors.has(ref)) throw new Error(`Original actor-array reference is not linked: ${ref}`);
    return actors.get(ref);
  });
  return result.concat(spawned);
}
