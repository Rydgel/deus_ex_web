/*
 * Core UObject mark/sweep driver.
 *
 * This is deliberately a small host boundary.  Core owns the mark archive,
 * registry/name scans, and ordering; the reflected serializer, conditional
 * destroy hook, class deleting destructor, and FName allocator remain native
 * services supplied by the caller.  See docs/script-gc.md for the original
 * addresses and raw masks.
 */

export const GC_FLAGS = Object.freeze({
  // UObject+0x1c bit cleared by the mark archive and tested by PurgeGarbage.
  unreachable: 0x00000002,
  // Initial mark value ORed by the archive constructor.
  archiveSerialize: 0x00000040,
  archiveMark: 0x00000042,
  // Archive SerializeObject excludes this raw flag before routing Serialize.
  archiveExcluded: 0x00000400,
  // PurgeGarbage's special native-object gate.
  native: 0x04000000,
  // Archive SerializeObject clears and diagnoses this raw route marker.
  serializeRoute: 0x40000000,
});

/** Raw constructor words, including version68/licensee1100. Native class
 * serializers inspect the version as well as the loading/saving flags. */
export const GC_ARCHIVE_WORDS = Object.freeze({
  ar04:0x44,ar08:0x44c,ar0c:0,ar10:0,ar14:0,ar18:0,ar1c:1,ar20:1,ar24:1,ar28:0,
});

const U32 = value => (Number(value) >>> 0);
const has = (value, mask) => (U32(value) & mask) !== 0;
const withBits = (value, mask) => U32(U32(value) | mask);
const withoutBits = (value, mask) => U32(U32(value) & U32(~mask));

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`GC requires ${name}`);
  return value;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`GC requires ${name} array`);
  return value;
}

function readFlags(record, callbacks, kind) {
  if (typeof callbacks.readFlags === 'function') return U32(callbacks.readFlags(record, kind));
  if (record && Object.hasOwn(record, 'flags')) return U32(record.flags);
  if (record && Object.hasOwn(record, 'objectFlags')) return U32(record.objectFlags);
  throw new TypeError(`GC ${kind} record must expose flags or services.readFlags`);
}

function writeFlags(record, value, callbacks, kind) {
  const flags = U32(value);
  if (typeof callbacks.writeFlags === 'function') {
    callbacks.writeFlags(record, flags, kind);
    return flags;
  }
  if (record && Object.hasOwn(record, 'flags')) {
    record.flags = flags;
    return flags;
  }
  if (record && Object.hasOwn(record, 'objectFlags')) {
    record.objectFlags = flags;
    return flags;
  }
  throw new TypeError(`GC ${kind} record must expose flags or services.writeFlags`);
}

function holderFor(valueOrHolder) {
  if (valueOrHolder && typeof valueOrHolder.get === 'function' &&
      typeof valueOrHolder.set === 'function') return valueOrHolder;
  if (valueOrHolder && typeof valueOrHolder === 'object' &&
      Object.hasOwn(valueOrHolder, 'value')) {
    return {
      get: () => valueOrHolder.value,
      set: value => { valueOrHolder.value = value; },
    };
  }
  throw new TypeError('GC SerializeObject requires a mutable reference holder');
}

function rootHolder(array, index) {
  return {get: () => array[index], set: value => { array[index] = value; }};
}

function defaultObjectPredicate(record) {
  return record !== null && record !== undefined && record.isUObject !== false;
}

function registryArrays(registry) {
  if (!registry || typeof registry !== 'object') throw new TypeError('GC requires a registry record');
  const objects = requireArray(registry.objects ?? registry.objectArray, 'registry.objects');
  const names = requireArray(registry.names ?? registry.nameArray, 'registry.names');
  const roots = registry.rootSet ?? registry.roots;
  requireArray(roots, 'registry.rootSet');
  return {objects, names, roots};
}

function nativePurgeEnabled(registry, callbacks) {
  if (typeof callbacks.nativePurgeEnabled === 'function') {
    return callbacks.nativePurgeEnabled(registry) === true;
  }
  // ProcessRegistrants sets Core's 0x101e559c gate.  Keep both names so a
  // host can use the descriptive form without losing the raw boundary.
  return registry.registrantsActive === true || registry.nativePurgeEnabled === true;
}

function setGarbageCollecting(registry, callbacks, active) {
  if (typeof callbacks.setGarbageCollecting === 'function') {
    callbacks.setGarbageCollecting(active, registry);
  } else {
    registry.garbageCollecting = active;
  }
}

function isNoGc(registry, callbacks) {
  if (typeof callbacks.isNoGc === 'function') return callbacks.isNoGc(registry) === true;
  return registry.noGc === true || registry.nogc === true;
}

function isObjectRecord(record, callbacks) {
  if (record === null || record === undefined) return false;
  if (typeof callbacks.isUObject === 'function') return callbacks.isUObject(record) === true;
  return defaultObjectPredicate(record);
}

function serializeObjectBody(object, archive, callbacks) {
  if (typeof callbacks.serializeObject === 'function') {
    callbacks.serializeObject(object, archive);
    return;
  }
  if (typeof object.serialize === 'function') {
    object.serialize(archive);
    return;
  }
  throw new TypeError('GC requires serializeObject for a marked object');
}

/**
 * The GC archive installed by the original constructor at Core 0x1015eac0.
 * Its public methods intentionally use reference holders because the native
 * SerializeObject routine receives UObject** and nulls that slot when the
 * raw exclusion tests reject it.  Callers must pass a {value} holder or an
 * object implementing get()/set(); a direct object is rejected so a required
 * null write cannot be silently dropped.
 */
export function createGarbageArchive(registry, services = {}) {
  const {objects, names} = registryArrays(registry);
  const callbacks = services ?? {};

  // The native constructor at 0x1015eac0 performs these two registry scans
  // before any root or object reference is routed through the archive.
  for (const object of objects) {
    if (object === null || object === undefined) continue;
    if (isObjectRecord(object, callbacks)) {
      writeFlags(object, withBits(readFlags(object, callbacks, 'object'), GC_FLAGS.archiveMark), callbacks, 'object');
    }
  }
  for (const name of names) {
    if (name === null || name === undefined) continue;
    writeFlags(name, withBits(readFlags(name, callbacks, 'name'), GC_FLAGS.unreachable), callbacks, 'name');
  }

  let current = null;
  let serialised = 0;

  const archive = {
    archiveState:{...GC_ARCHIVE_WORDS},
    // Collector vtable1017a2f0 inherits these base methods. Map operations
    // return zero without visiting, validating or marking their argument;
    // the tagged-property measuring archive invokes them before Serialize.
    mapName:()=>0, // +20 ->10101541 ->10106960
    mapObject:()=>0, // +24 ->10102c84 ->10106980
    get currentObject() { return current; },
    get serializedCount() { return serialised; },

    serializeObject(reference) {
      const holder = holderFor(reference);
      // Core 0x1015ecb8-0x1015ecbf increments the global reference count at
      // entry, before loading or testing the holder.  Visited, excluded, and
      // null references therefore all count as archive visits.
      serialised++;
      const object = holder.get();
      if (object === null || object === undefined) {
        return archive;
      }

      const flags = readFlags(object, callbacks, 'object');
      // Core 0x1015ec90: testb $0x4,%dh, which is ObjectFlags bit 0x400.
      // Only this archive exclusion writes a non-null holder back to null.
      // An already-marked reference remains intact at 0x1015ecee-0x1015ecf2.
      if (has(flags, GC_FLAGS.archiveExcluded)) {
        holder.set(null);
        return archive;
      }
      if (!has(flags, GC_FLAGS.unreachable)) return archive;

      // The native body clears the candidate bit and the route marker before
      // routing Serialize.  The archive-serialization bit (0x40) is kept as
      // the per-object permission to recurse into reflected references.
      const recurse = has(flags, GC_FLAGS.archiveSerialize);
      writeFlags(object, withoutBits(flags, GC_FLAGS.unreachable | GC_FLAGS.serializeRoute), callbacks, 'object');
      if (recurse) {
        const saved = current;
        current = object;
        try {
          serializeObjectBody(object, archive, callbacks);
          const after = readFlags(object, callbacks, 'object');
          // The native JNE at 0x1015ed20 skips the warning when the route
          // marker remains set.  A clear marker after the Serialize callback
          // is the diagnosed failure.  The callback runs while the native
          // current-object slot still names this object.
          if (!has(after, GC_FLAGS.serializeRoute)) {
            callbacks.onSerializeRouteFailure?.(object, archive);
          }
        } finally {
          current = saved;
        }
      } else {
        // 0x1015ed45 reports a separate missing-0x40 route with the current
        // outer object and this object.  No Serialize virtual is dispatched.
        callbacks.onSerializeMissingRoute?.(object, current, archive);
      }
      // Core 1015ecd8 returns the archive (EDI), including on early exits.
      // Metadata helpers chain subsequent archive operators on this value.
      return archive;
    },

    serializeName(reference) {
      const holder = holderFor(reference);
      const name = holder.get();
      if (name === null || name === undefined) {
        throw new TypeError('GC FName requires a registered name entry, including None');
      }
      const flags = readFlags(name, callbacks, 'name');
      writeFlags(name, withoutBits(flags, GC_FLAGS.unreachable), callbacks, 'name');
      // Core 1015ee00 retains the archive in EAX and never rewrites FName.
      return archive;
    },

    // Names are routed by the reflected property serializers through the
    // same +0x1c archive slot; this alias makes that contract explicit.
    serializeFName(reference) {
      return archive.serializeName(reference);
    },

    // Exposed for source-backed tests and host adapters that need the raw
    // registry arrays while emulating FArray's element loop.
    objects,
    names,
  };
  return archive;
}

function serializeRootSet(registry, keepFlags, requiredFlags, archive, services) {
  const {objects, roots} = registryArrays(registry);
  // SerializeRootSet begins by archiving the root FArray at 0x1029e5f8.
  // Keep the live array and current slot order; callbacks can change it.
  for (let index = 0; index < roots.length; index++) {
    archive.serializeObject(rootHolder(roots, index));
  }

  const keep = U32(keepFlags);
  const required = U32(requiredFlags);
  const isObject = services.isUObject ?? defaultObjectPredicate;
  for (let index = 0; index < objects.length; index++) {
    const object = objects[index];
    if (object === null || object === undefined || isObject(object) !== true) continue;
    const flags = readFlags(object, services, 'object');
    // Core 0x1015814e requires any KeepFlags bit; 0x10158156 requires all
    // RequiredFlags bits.  A local UObject* holder is used by the original
    // loop, so a rejection cannot erase GObjObjects[index].
    if ((flags & keep) === 0 || (flags & required) !== required) continue;
    archive.serializeObject({value: object});
  }
}

function runPurgeGarbage(registry, services) {
  const {objects, names} = registryArrays(registry);
  const callbacks = services ?? {};
  if (isNoGc(registry, callbacks)) {
    callbacks.onGarbageSkipped?.({reason: 'NOGC', registry});
    return {skipped: 'NOGC', objects: 0, destroyed: 0, released: 0, names: 0, refs: 0};
  }

  const nativeAllowed = nativePurgeEnabled(registry, callbacks);
  const conditionalDestroy = requireFunction(callbacks.conditionalDestroy, 'conditionalDestroy');
  const finalDelete = requireFunction(callbacks.finalDelete ?? callbacks.deleteObject, 'finalDelete');
  const deleteName = requireFunction(callbacks.deleteName, 'deleteName');
  let objectCount = 0;
  let destroyed = 0;
  let released = 0;
  let deletedNames = 0;
  let refs = Number(registry.serializedCount ?? registry.markedReferences ?? 0) || 0;

  setGarbageCollecting(registry, callbacks, true);
  callbacks.onPurgeStart?.({registry, nativeAllowed});
  try {
    // Core 0x10158272 first pass.  The original reloads GObjObjects/count
    // each iteration; retaining a live array here preserves callback edits.
    for (let index = 0; index < objects.length; index++) {
      const object = objects[index];
      if (object === null || object === undefined) continue;
      objectCount++;
      const flags = readFlags(object, callbacks, 'object');
      if (!has(flags, GC_FLAGS.unreachable)) continue;
      if (has(flags, GC_FLAGS.native) && !nativeAllowed) continue;
      conditionalDestroy(object);
      destroyed++;
    }

    // Core 0x10158322 second pass.  This is the class scalar deleting
    // destructor entry (vtable +0x0c) with argument 1.  Native-flagged
    // entries are deliberately skipped by this independent gate.
    for (let index = 0; index < objects.length; index++) {
      const object = objects[index];
      if (object === null || object === undefined) continue;
      const flags = readFlags(object, callbacks, 'object');
      if (!has(flags, GC_FLAGS.unreachable) || has(flags, GC_FLAGS.native)) continue;
      finalDelete(object, 1);
      released++;
    }

    // Core 0x10158400 name pass, after all object deleting destructors.  The
    // same unreachable/native masks are applied to FNameEntry+0x04.
    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      if (name === null || name === undefined) continue;
      const flags = readFlags(name, callbacks, 'name');
      if (!has(flags, GC_FLAGS.unreachable) || has(flags, GC_FLAGS.native)) continue;
      deleteName(index, name);
      deletedNames++;
    }
  } finally {
    setGarbageCollecting(registry, callbacks, false);
    callbacks.onPurgeEnd?.({registry, objectCount, destroyed, released, names: deletedNames, refs});
  }
  return {skipped: null, objects: objectCount, destroyed, released, names: deletedNames, refs};
}

/**
 * Core UObject::CollectGarbage (thunk 0x101010c8, body 0x10158500).
 * `keepFlags` is passed as SerializeRootSet's first mask; the second mask is
 * the original fixed 0x40.  Marking occurs before PurgeGarbage's NOGC gate,
 * matching the native call order.
 */
export function collectGarbage(registry, keepFlags = 0, services = {}) {
  const callbacks = services ?? {};
  const archive = createGarbageArchive(registry, callbacks);

  // SerializeRootSet(archive, keepFlags, 0x40), then PurgeGarbage.
  serializeRootSet(registry, keepFlags, GC_FLAGS.archiveSerialize, archive, callbacks);
  registry.serializedCount = archive.serializedCount;
  registry.markedReferences = archive.serializedCount;
  return purgeGarbage(registry, callbacks);
}

/** Core UObject::PurgeGarbage (thunk 0x1010335a, body 0x101581f0). */
export function purgeGarbage(registry, services = {}) {
  return runPurgeGarbage(registry, services);
}

export const collectScriptGarbage = collectGarbage;
