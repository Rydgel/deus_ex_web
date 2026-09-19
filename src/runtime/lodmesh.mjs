/**
 * Decoded original LodMesh payloads (GOTY), limited to what script behavior
 * needs today: the AnimSeq table consumed by native PlayAnim (259).
 *
 * Layout evidence: docs/lodmesh-serialization.md, recovered by executing the
 * original Engine.dll ULodMesh::Serialize in scripts/native-lodmesh-oracle.py
 * (thunks 0x10301717 UMesh, 0x103024b9 ULodMesh, body 0x10354ab0;
 * UPrimitive::Serialize body 0x103d82d0; AnimSeq helper 0x103a9370).
 *
 * This small prefix reader remains for sequence-only callers. The full v68
 * payload and deferred vertex arrays are decoded in lodmesh-payload.mjs;
 * docs/script-mesh-payload.md supersedes the old probe's tail interpretation.
 */
export class LodMeshError extends Error {}

/**
 * Decode one LodMesh export's script-visible payload.
 * Returns {entry, boundingBox, boundingSphere, sequences, eagerEnd}.
 */
export function decodeLodMesh(pkg, bytes, exportIndex) {
  const entry = pkg.exports[exportIndex - 1];
  if (!entry || !entry.serialSize) throw new LodMeshError(`Invalid LodMesh export ${exportIndex}`);
  const r = new Reader(bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize));
  skipTaggedProperties(r);
  // UPrimitive::Serialize: bbox, valid byte, sphere (radius only when Ver > 61).
  const boundingBox = {
    min: [r.f32(), r.f32(), r.f32()],
    max: [r.f32(), r.f32(), r.f32()],
    valid: r.u8() !== 0,
  };
  const center = [r.f32(), r.f32(), r.f32()];
  const radius = pkg.version > 61 ? r.f32() : 0;
  const boundingSphere = {center, radius};
  // UMesh::Serialize: TLazyArray markers at mesh+0x54 and mesh+0x6c. The
  // 4-byte values are package file offsets where the next field begins; the
  // inline blobs are retained by the separate full-payload decoder.
  for (let i = 0; i < 2; i++) {
    const marker = r.u32();
    skipLazyBlob(r, marker - entry.serialOffset);
  }
  // AnimSeq array (mesh+0x84, helper 0x103a9370): compact count, 0x20-byte
  // entries, serialized eagerly in this order.
  const sequences = [];
  const count = r.compact();
  for (let i = 0; i < count; i++) {
    const name = nameAt(pkg, r.compact());
    const group = nameAt(pkg, r.compact());
    const startFrame = r.i32();
    const numFrames = r.i32();
    const notifyCount = r.compact();
    const notifies = [];
    for (let n = 0; n < notifyCount; n++) {
      const time = r.f32();
      notifies.push({time, name: nameAt(pkg, r.compact())});
    }
    const rate = r.f32();
    sequences.push({name, group, startFrame, numFrames, notifyCount, notifies, rate});
  }
  return {entry, boundingBox, boundingSphere, sequences, eagerEnd: r.offset};
}

/** Linear scan of the decoded table (mesh vtable +0x68 bodies). */
export function findSequence(mesh, name) {
  if (!mesh) return null;
  return mesh.sequences.find(sequence => sequence.name === name) || null;
}

function nameAt(pkg, index) {
  const name = pkg.names[index];
  if (!name) throw new LodMeshError(`Invalid mesh name reference ${index}`);
  return name.name;
}

function skipTaggedProperties(r) {
  // Authored overrides until the None terminator. Same format as
  // src/unreal/objects.mjs readProperties: info byte with type, size code and
  // array-index flag, optional struct name, size, optional array index.
  while (true) {
    const index = r.compact();
    if (index === 0) return;
    const info = r.u8();
    const type = info & 15;
    const sizeCode = (info >> 4) & 7;
    if (type === 10) r.compact();
    const size = sizeCode < 5 ? [1, 2, 4, 12, 16][sizeCode]
      : sizeCode === 5 ? r.u8() : sizeCode === 6 ? r.u16() : r.u32();
    if ((info & 128) && type !== 3) {
      const first = r.u8();
      if ((first & 192) === 192) r.take(3);
      else if (first & 128) r.u8();
    }
    r.take(type === 3 ? 0 : size);
  }
}

function skipLazyBlob(r, payloadEnd) {
  if (payloadEnd < r.offset || payloadEnd > r.limit) {
    throw new LodMeshError(`Lazy marker outside payload at ${r.offset}`);
  }
  r.seek(payloadEnd);
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.limit = bytes.length;
    this.offset = 0;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8() {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16() {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32() {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32() {
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f32() {
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  compact() {
    // FCompactIndex is not LEB128. The first byte carries sign, continuation,
    // and six payload bits; later bytes carry 7+7+7+5 payload bits and use
    // bit 7 as continuation. This is the same format read by ULinkerLoad's
    // FName/FCompactIndex archive operators during ULodMesh::Serialize.
    const start = this.offset;
    let byte = this.u8();
    const negative = (byte & 0x80) !== 0;
    let value = byte & 0x3f;
    let more = (byte & 0x40) !== 0;
    for (let index = 1; more; index++) {
      byte = this.u8();
      if (index === 4 && byte > 0x1f) throw new LodMeshError(`Compact index overflow at ${start}`);
      value += (byte & (index === 4 ? 0x1f : 0x7f)) * 2 ** (6 + (index - 1) * 7);
      more = index < 4 && (byte & 0x80) !== 0;
    }
    if (value > (negative ? 0x80000000 : 0x7fffffff))
      throw new LodMeshError(`Compact index exceeds signed 32-bit range at ${start}`);
    return negative && value !== 0 ? -value : value;
  }

  take(length) {
    if (this.offset + length > this.limit) throw new LodMeshError('Payload overrun');
    const bytes = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  seek(offset) {
    this.offset = offset;
  }
}
