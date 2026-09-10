/**
 * Native AActor::Serialize dispatch for the verified CameraPoint class.
 *
 * CameraPoint's Engine body contains no actor-specific serialization work:
 * it forwards the FArchive to UObject::Serialize and returns.  The Core base
 * serializer owns the object header, state-frame, and linked-property walks;
 * this module keeps that call boundary explicit instead of duplicating it.
 * See docs/script-actor-serialization.md for the original addresses and
 * archive-state evidence.
 */

export const ACTOR_SERIALIZE = Object.freeze({
  cameraPointVtable: 0x10427178,
  keypointVtable: 0x10427020,
  actorVtable: 0x104268dc,
  engineThunk: 0x1030166d,
  engineBody: 0x10369ad0,
  coreImport: 0x10599b10,
  coreThunk: 0x1010178f,
  coreBody: 0x10150210,
});

/**
 * The mark archive made by Core's collector constructor at 0x1015eac0 has
 * these raw words for the GC path used by CameraPoint.  They are descriptive
 * metadata for callers and are deliberately not written by this wrapper.
 */
export const CAMERA_POINT_GC_ARCHIVE_STATE = Object.freeze({
  ar0c: 0,
  ar10: 0,
  ar14: 0,
  ar18: 0,
  ar1c: 1,
  ar20: 1,
  ar24: 1,
});

const VERIFIED_ACTOR_VTABLES = new Set([
  ACTOR_SERIALIZE.cameraPointVtable,
  ACTOR_SERIALIZE.keypointVtable,
  ACTOR_SERIALIZE.actorVtable,
]);

function requireObject(object) {
  if (!object || typeof object !== 'object') {
    throw new TypeError('AActor::Serialize requires an object record');
  }
  return object;
}

function requireArchive(archive) {
  if (!archive || typeof archive !== 'object') {
    throw new TypeError('AActor::Serialize requires an FArchive record');
  }
  return archive;
}

function requireBaseSerializer(services) {
  const serializeUObject = services?.serializeUObject;
  if (typeof serializeUObject !== 'function') {
    throw new TypeError(
      'AActor::Serialize requires the verified UObject::Serialize base service',
    );
  }
  return serializeUObject;
}

function callBase(object, archive, services) {
  const serializeUObject = requireBaseSerializer(services);
  // Engine's body leaves ECX as `this`, pushes only the archive, and returns
  // the base result unchanged.  Do not mutate archive flags or call an
  // invented native-member serializer here.
  return serializeUObject(object, archive);
}

/**
 * Dispatch the exact native body selected by CameraPoint's vtable +0x28.
 * The vtable check prevents silently applying this contract to an untraced
 * native subclass.
 */
export function serializeCameraPointActor(object, archive, services = {}) {
  requireObject(object);
  requireArchive(archive);
  if (object.nativeVtable !== ACTOR_SERIALIZE.cameraPointVtable) {
    throw new Error(
      `CameraPoint AActor::Serialize requires native vtable 0x${ACTOR_SERIALIZE.cameraPointVtable.toString(16)}`,
    );
  }
  return callBase(object, archive, services);
}

/**
 * The same body is selected by the recovered AActor and AKeypoint vtables.
 * Use this only when the object's native vtable is one of those three
 * explicitly verified tables.
 */
export function serializeAActor(object, archive, services = {}) {
  requireObject(object);
  requireArchive(archive);
  if (!VERIFIED_ACTOR_VTABLES.has(object.nativeVtable)) {
    throw new Error(
      'AActor::Serialize requires one of the verified Actor native vtables',
    );
  }
  return callBase(object, archive, services);
}

// Keep the generic name convenient for callers while retaining the strict
// verified-vtable gate above.  The CameraPoint-specific export is preferred
// when the class identity is known.
export const serializeActor = serializeAActor;
export const serializeScriptActor = serializeAActor;
