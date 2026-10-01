/** Engine UMusic construction and serialization (docs/script-music-load.md).
 *
 * UMusic is native-only (Engine.dll initializer 0x10370eb0: size 0x4c, class
 * flags 0x40, Super and Within Core.Object, config System, InternalConstructor
 * 0x103036a7, UObject's static constructor). Its fields: +0x28 Data, a
 * TLazyArray<BYTE> (loader vtable 0x104267fc at +0x28, SavedAr +0x2c,
 * SavedPos +0x30, FArray +0x34/+0x38/+0x3c), +0x40 FileType (FName), +0x44
 * OriginalSize, +0x48 the audio subsystem's handle. */
import {serializeLazyBytes} from './script-texture-load.mjs';

export const MUSIC_NATIVE = Object.freeze({
  instanceSize: 0x4c, registeredClassFlags: 0x52, staticConstructor: 0x10101041,
  vtable: 0x104295e4, lazyArrayVtable: 0x104267fc,
  constructor: 0x1034d170, serialize: 0x10370bd0, postLoad: 0x10370df0,
});

/** UMusic::UMusic 0x1034d170: UObject's constructor, the FArray at +0x34
 * zeroed and Realloc(1), SavedAr/SavedPos 0, the loader vtable, then the
 * UMusic vtable. FileType, OriginalSize and Handle keep the class default's
 * zero bytes. */
export function constructMusic(object, services) {
  const bytes = {data: null, num: 0, max: 0};
  services.arrayRealloc(bytes, 1);
  services.write(object, 0x28, {vtable: MUSIC_NATIVE.lazyArrayVtable, archive: null, savedPosition: 0, bytes});
  services.writeVtable(object, MUSIC_NATIVE.vtable);
}

/** UMusic::Serialize 0x10370bd0: UObject::Serialize; Ar << FileType (FArchive
 * vtable +0x1c); when the archive is loading (+0x0c) or saving (+0x10),
 * Ar << Data (0x103039ef) and, loading, OriginalSize = Data.Num; otherwise
 * Ar.CountBytes(OriginalSize, OriginalSize). Only loading is translated. */
export function serializeMusic(object, archive, services) {
  services.uobjectSerialize(object, archive);
  services.write(object, 0x40, archive.readName().name);
  if (!archive.ar0c) throw new Error('UMusic::Serialize for a non-loading archive is not translated');
  const data = services.read(object, 0x28);
  serializeLazyBytes(data, archive, services);
  services.write(object, 0x44, data.bytes.num);
}
