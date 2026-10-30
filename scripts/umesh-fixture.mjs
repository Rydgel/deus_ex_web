/** Classic UMesh fixtures for the native comparisons (docs/umesh.md): the game's
 * five classic meshes as their packages hold them, and synthetic multi-frame
 * meshes built by re-encoding the Fly's payload with other vertex frames,
 * sequences and tables. The synthetic payloads are not authored game assets
 * and are never written back to a package; the original serializer
 * (UMesh::Serialize) reads them in the oracle exactly as it reads the real
 * ones. */
import {readFile} from 'node:fs/promises';
import {parsePackage} from '../src/unreal/package.mjs';
import { readObject, exportAt } from '../src/unreal/objects.mjs';
import {decodeLodMeshPayload} from '../src/runtime/lodmesh-payload.mjs';

/** The five classic meshes: [package, export (1-based), name]. */
export const CLASSIC_MESHES = [['DeusExDeco', 397, 'EidosLogo'], ['DeusExDeco', 407, 'IonStormLogo'], ['DeusExDeco', 408, 'DXText'],
  ['DeusExDeco', 415, 'DXLogo'], ['DeusExCharacters', 723, 'Fly']];

/** UE1 FCompactIndex: sign, continuation and six payload bits in byte 0, then 7-bit groups. */
export function compact(value) {
  const negative = value < 0;
  let magnitude = Math.abs(value);
  const bytes = [(negative ? 0x80 : 0) | (magnitude & 0x3f)];
  magnitude = Math.floor(magnitude / 64);
  if (magnitude) bytes[0] |= 0x40;
  while (magnitude) {
    const chunk = magnitude & 0x7f;
    magnitude = Math.floor(magnitude / 128);
    bytes.push(chunk | (magnitude ? 0x80 : 0));
  }
  return Buffer.from(bytes);
}

/** One classic mesh as a native-oracle case: its package, bytes, export index, decoded payload and `spec.mesh`. */
export async function classicMeshCase(root, packageName, index) {
  const bytes = await readFile(`${root}/System/${packageName}.u`), pkg = parsePackage(bytes), entry = exportAt(pkg, index);
  return {pkg, bytes, index, entry, spec: meshSpec(pkg, bytes, index, entry)};
}
function meshSpec(pkg, bytes, index, entry, payload = bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize)) {
  return {name: entry.name, version: 68, start: entry.serialOffset, prefixSize: readObject(pkg, bytes, index).reader.offset,
    payload: payload.toString('base64'), lazy: 1, classic: true};
}
export const nameTable = pkg => Object.fromEntries(pkg.names.map((n, i) => [n.name, i]));

/** The Fly's payload re-encoded as a mesh of `frames` frames of its 7 vertices, with `sequences`
 * ({name, start, frames, rate}), pseudo-random int16 vertices and one bounding box and sphere per
 * frame. Names must be in the Fly's package name table. */
export async function syntheticMeshCase(root, {frames = 8, sequences, seed = 1} = {}) {
  const base = await classicMeshCase(root, 'DeusExCharacters', 723), names = nameTable(base.pkg);
  const m = decodeLodMeshPayload(base.pkg, base.bytes, base.index);
  for (const array of m.lazyArrays.values()) array.load();
  const count = m.frameVertexCount;
  let state = seed >>> 0;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000;
  const verts = Buffer.alloc(frames * count * 8);
  for (let i = 0; i < frames * count; i++) {
    for (let axis = 0; axis < 3; axis++) verts.writeInt16LE(Math.round((random() - 0.5) * 6000), i * 8 + axis * 2);
    verts.writeUInt16LE(Math.round(random() * 65535), i * 8 + 6);
  }
  const parts = [], position = () => parts.reduce((total, part) => total + part.length, 0);
  const push = (...chunks) => parts.push(...chunks.map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; };
  const f32 = value => { const b = Buffer.alloc(4); b.writeFloatLE(value); return b; };
  const lazy = (blob) => { push(u32(base.entry.serialOffset + position() + 4 + blob.length), blob); };
  const bounds = () => {
    push(...[...m.boundingBox.min, ...m.boundingBox.max].map(f32), [m.boundingBox.valid ? 1 : 0],
      ...[...m.boundingSphere.center, m.boundingSphere.radius].map(f32));
  };
  push([0]); // the tagged properties: None
  bounds();
  lazy(Buffer.concat([compact(frames * count), verts]));
  const tris = m.arrays.get(0x78);
  lazy(Buffer.concat([compact(tris.num), Buffer.from(tris.data)]));
  push(compact(sequences.length));
  for (const seq of sequences) {
    if (!(seq.name in names)) throw new Error(`Fixture sequence name ${seq.name} is not in the package name table`);
    push(compact(names[seq.name]), compact(0), u32(seq.start), u32(seq.frames), compact(0), f32(seq.rate ?? 30));
  }
  const connects = m.arrays.get(0x9c);
  lazy(Buffer.concat([compact(connects.num), Buffer.from(connects.data)]));
  bounds();
  const links = m.arrays.get(0xcc);
  lazy(Buffer.concat([compact(links.num), Buffer.from(links.data)]));
  push(compact(m.objectReferences.length), ...m.objectReferences.map(ref => compact(ref.index)));
  // BoundingBoxes: six floats and the valid byte (25 file bytes, 28 in memory); BoundingSpheres: four floats.
  push(compact(frames));
  for (let frame = 0; frame < frames; frame++) {
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) for (let a = 0; a < 3; a++) {
      const v = verts.readInt16LE((frame * count + i) * 8 + a * 2);
      min[a] = Math.min(min[a], v); max[a] = Math.max(max[a], v);
    }
    push(...min.map(f32), ...max.map(f32), [1]);
  }
  push(compact(frames));
  for (let frame = 0; frame < frames; frame++) push(...[0, 0, 0, 4000].map(f32));
  const scalar = m.scalarBits;
  for (let offset = 0xf0; offset <= 0x128; offset += 4) {
    push(u32(offset === 0xf4 ? frames : scalar.get(offset)));
  }
  const floats = m.arrays.get(0xe4);
  push(compact(floats.num), Buffer.from(floats.data));
  const payload = Buffer.concat(parts);
  const entry = {...base.entry, serialSize: payload.length}, bytes = Buffer.alloc(entry.serialOffset + payload.length);
  payload.copy(bytes, entry.serialOffset);
  const pkg = {...base.pkg, exports: base.pkg.exports.slice()};
  exportAt(pkg, base.index) = entry;
  // readObject parses the tagged-property prefix from the package bytes, so the synthetic entry reads its own.
  return {pkg, bytes, index: base.index, entry, names, synthetic: true,
    spec: {...meshSpec(pkg, bytes, base.index, entry, payload), name: `Synthetic${frames}`}};
}
