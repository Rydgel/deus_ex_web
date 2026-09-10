/** Bind serialized map properties to canonical script identities. Class defaults
 * keep their original package provenance; only map-authored refs use map indices.
 * See docs/script-map-actors.md. */
export async function prepareMapProperties(runtime, asset, actor, cls, actors) {
  const authored = new Map();
  for (const property of actor.properties ?? []) {
    const field = runtime.lookupMember(cls, 'fields', property.name);
    if (!field) throw new Error(`Map property is not linked: ${actor.name}.${property.name}`);
    await runtime.field(field);
    let value = property.value;
    if (!property.decoded) value = {unsupported: `Undecoded map property ${actor.name}.${property.name}`};
    else if ([5, 8].includes(property.type)) {
      value = property.value > 0 && actors.has(property.value)
        ? actors.get(property.value) : await runtime.objects.resolve(asset, property.value);
    } else if (property.type === 10) value = runtime.authoredStructValue(field, value);
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
