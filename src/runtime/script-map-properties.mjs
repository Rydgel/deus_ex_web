import {readObject} from '../unreal/objects.mjs';

/** Bind serialized map properties to canonical script identities. Class defaults
 * keep their original package provenance; only map-authored refs use map indices.
 * See docs/script-map-actors.md. */
export async function prepareMapProperties(runtime, asset, actor, cls, actors) {
  const authored = new Map();
  let rawProperties;
  // Map-authored object refs keep actor-slot identities; class records also
  // need their linked ancestry — the original package linker always builds it.
  const resolveMapObject=async(source,index)=>{
    if(index>0&&actors.has(index))return actors.get(index);
    const object=await runtime.objects.resolve(source,index);
    if(object?.kind==='Class')await runtime.loadClass(source,index);
    return object;
  };
  for (const [ordinal,property] of (actor.properties ?? []).entries()) {
    const field = runtime.lookupMember(cls, 'fields', property.name);
    if (!field) throw new Error(`Map property is not linked: ${actor.name}.${property.name}`);
    await runtime.field(field);
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
    } else if (!property.decoded) value = {unsupported: `Undecoded map property ${actor.name}.${property.name}`};
    else if ([5, 8].includes(property.type)) value=await resolveMapObject(asset,property.value);
    if (!authored.has(field.key)) authored.set(field.key, new Map());
    authored.get(field.key).set(property.arrayIndex, value);
  }
  const snapshot = new Map(cls.defaults);
  return field => {
    const overrides = authored.get(field.key);
    if (!overrides) return runtime.defaultValue(cls, field, snapshot);
    for (const value of overrides.values()) if (value?.unsupported) throw new Error(value.unsupported);
    if (field.metadata.arrayDim > 1) {
      const value = runtime.defaultValue(cls, field, snapshot);
      for (const [index, item] of overrides) value[index] = item;
      return value;
    }
    return overrides.has(0) ? overrides.get(0) : runtime.defaultValue(cls, field, snapshot);
  };
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
    if (!actors.has(ref)) throw new Error(`Original actor-array reference is not linked: ${ref}`);
    return actors.get(ref);
  });
  return result.concat(spawned);
}
