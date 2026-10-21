/** GOTY v68 LodMesh resource view. Original contract: docs/script-mesh-payload.md. */
import {readObject, nameAt, objectAt} from '../unreal/objects.mjs';
import {LodMeshError} from './lodmesh.mjs';
import {constructMesh, constructLodMesh, serializeMesh, serializeLodMesh, loadMeshLazyArray, reallocateMeshArray}
  from './script-mesh-load.mjs';

const empty = new Uint8Array();
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const asFloat = bits => {
  const buffer = new ArrayBuffer(4), v = new DataView(buffer);
  v.setUint32(0, bits, true); return v.getFloat32(0, true);
};

/** The same presentation of fields works for detached inspection and the graph. */
export function meshPayloadView(object, services, {entry, archive, classic = false}) {
  const get = offset => services.read(object, offset), arrays = new Map(), lazyArrays = new Map();
  const project = (a, lazy = null) => {
    let lastData, lastNum, bytes = empty;
    const result = {
      get num() { return a.num; }, get max() { return a.max; }, elementSize: a.elementSize,
      get data() {
        if (lastData !== a.data || lastNum !== a.num) {
          lastData = a.data; lastNum = a.num;
          bytes = a.data?.subarray(0, a.num * a.elementSize) ?? empty;
        }
        return bytes;
      },
    };
    if (a.notifyArrays) result.notifyArrays = a.notifyArrays.map(n => project(n));
    if (lazy) Object.defineProperties(result, {
      savedPosition: {enumerable: true, get: () => lazy.savedPosition},
      attached: {enumerable: true, get: () => lazy.archive === archive},
      load: {value: () => { loadMeshLazyArray(lazy, services); return result; }},
    });
    return result;
  };
  for (const offset of [0x54, 0x6c, 0x90, 0xc0]) {
    const lazy = get(offset), a = project(lazy.array, lazy);
    lazyArrays.set(offset, a); arrays.set(offset + 12, a);
  }
  // A classic UMesh (0x12c bytes) ends at +0xe4; the rest is ULodMesh's.
  for (const offset of [0x84, 0xa8, 0xb4, 0xd8, 0xe4, ...(classic ? [] : [0x12c, 0x138, 0x144,
    0x150, 0x15c, 0x168, 0x174, 0x1a0])]) arrays.set(offset, project(get(offset)));
  const scalarBits = new Map();
  for (let offset = 0xf0; offset <= 0x128; offset += 4) scalarBits.set(offset, get(offset));
  if (!classic) {
    for (let offset = 0x180; offset <= 0x19c; offset += 4) scalarBits.set(offset, get(offset));
    scalarBits.set(0x1ac, get(0x1ac));
  }
  const floats = offsets => offsets.map(offset => asFloat(get(offset)));
  return {entry, arrays, lazyArrays, scalarBits,
    boundingBox: {min: floats([0x28, 0x2c, 0x30]), max: floats([0x34, 0x38, 0x3c]), valid: !!(get(0x40) & 255)},
    boundingSphere: {center: floats([0x44, 0x48, 0x4c]), radius: asFloat(get(0x50))},
    sequences: get(0x84).sequences, nameReferences: get(0x84).nameReferences,
    objectReferences: get(0xd8).references,
    eagerEnd: object.meshSequenceEnd - entry.serialOffset,
    serializedEnd: object.meshSerializedEnd - entry.serialOffset,
    get archivePosition() { return archive.tell(); },
    frameVertexCount: get(0xf0), frameCount: get(0xf4),
    scale: floats([0x100, 0x104, 0x108]), origin: floats([0x10c, 0x110, 0x114]),
    rotation: [0x118, 0x11c, 0x120].map(offset => get(offset) | 0),
    payloadStatus: classic ? 'decoded-mesh' : 'decoded-lodmesh', payloadComplete: false,
    unsupported: [classic ? 'Classic UMesh frame decoding and rendering are not bound (Stage 4); sequences are'
      : 'LodMesh live Play load finalization, renderer and final release are not bound'],
  };
}

/** Detached package inspection uses the exact shared native serializer. A
 * `Mesh` export is a classic UMesh (the game has five: docs/umesh.md), which
 * UMesh::Serialize reads alone; a `LodMesh` continues with ULodMesh's arrays. */
export function decodeLodMeshPayload(pkg, bytes, exportIndex, {lazy = true} = {}) {
  if (pkg.version !== 68) throw new LodMeshError(`Full LodMesh payload version ${pkg.version} is unsupported`);
  const stored = readObject(pkg, bytes, exportIndex), {entry, reader: r} = stored;
  const classic = entry.className === 'Mesh';
  if ((entry.className !== 'LodMesh' && !classic) || stored.stack)
    throw new LodMeshError('Expected a version 68 LodMesh or Mesh without a saved execution stack');
  const prefix = r.offset, object = {values: new Map()};
  // Native registration supplies zero defaults; constructor writes follow.
  for (let offset = 0x28; offset < 0x1b0; offset += 4) object.values.set(offset, 0);
  r.seek(0);
  const archive = {ar04: pkg.version, ar0c: 1, ar10: 0,
    tell: () => entry.serialOffset + r.offset,
    seek: position => r.seek(position - entry.serialOffset),
    readRaw: size => r.take(size), readU32: () => r.u32(), readCompact: () => r.compact(),
    countBytes() {},
    readName() { const index = r.compact(); return {index, name: index, text: nameAt(pkg, index)}; },
    readObject() { const index = r.compact(); objectAt(pkg, index); return {index, object: index}; },
  };
  const services = {
    read: (o, offset) => o.values.get(offset),
    write: (o, offset, value, type) => o.values.set(offset,
      type === 'u8' ? ((o.values.get(offset) ?? 0) & 0xffffff00) | (value & 255) : value),
    objectConstructor: o => o.values.set(0, 0x10179dfc),
    objectSerialize: () => r.seek(prefix),
    arrayRealloc: reallocateMeshArray,
    attach: (ar, loader) => { loader.archive = ar; loader.savedPosition = ar.tell(); },
    getLazyLoad: () => Number(lazy), referenceToken: ref => ref >>> 0,
  };
  (classic ? constructMesh : constructLodMesh)(object, services);
  (classic ? serializeMesh : serializeLodMesh)(object, archive, services);
  if (r.offset !== r.bytes.length) throw new LodMeshError(`LodMesh payload has ${r.bytes.length - r.offset} unconsumed bytes`);
  return meshPayloadView(object, services, {entry, archive, classic});
}

/** Original signed-word vertex unpack only: no animation tween or transform. */
export function readLodMeshFrame(mesh, frame) {
  if (!Number.isInteger(frame) || frame < 0 || frame >= mesh.frameCount)
    throw new LodMeshError(`Mesh frame ${frame} is out of range`);
  const vertices = mesh.arrays.get(0x60).load(), count = mesh.frameVertexCount;
  if ((frame + 1) * count > vertices.num) throw new LodMeshError('Mesh frame exceeds loaded vertices');
  const result = new Float32Array(count * 3), v = view(vertices.data);
  for (let i = 0; i < count; i++) for (let axis = 0; axis < 3; axis++)
    result[i * 3 + axis] = v.getInt16((frame * count + i) * 8 + axis * 2, true);
  return result;
}
