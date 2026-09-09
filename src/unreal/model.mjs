import { PackageError } from './package.mjs';
import { counted, objectAt, readObject, vector } from './objects.mjs';

const mask64 = r => [r.u32(), r.u32()];
const box = r => ({ min: vector(r), max: vector(r), valid: Boolean(r.u8()) });

/** Decode a compiled level's world-model reference and actor list. */
export function readLevel(pkg, bytes, index) {
  const { reader: r, ...object } = readObject(pkg, bytes, index);
  if (object.entry.className !== 'Level') throw new PackageError('Expected Level export', 0);
  const count = r.i32(), capacity = r.i32();
  if (capacity < count) throw new PackageError('Invalid actor capacity', r.offset);
  const actors = counted(r, 1, () => { const ref = r.compact(); objectAt(pkg, ref); return ref; }, count);
  const url = { protocol: r.string(pkg.version), host: r.string(pkg.version), map: r.string(pkg.version), portal: r.string(pkg.version) };
  url.options = counted(r, 1, () => r.string(pkg.version));
  url.port = r.i32();
  const urlValid = r.u32();
  const model = r.compact();
  if (objectAt(pkg, model)?.className !== 'Model' || model <= 0) throw new PackageError('Level has no local Model', r.offset);
  const reachSpecs = counted(r, 19, () => ({
    distance: r.i32(), start: r.compact(), end: r.compact(),
    radius: r.i32(), height: r.i32(), flags: r.i32(), pruned: r.u8(),
  }));
  // Deus Ex levels carry additional engine-specific fields after reach specs.
  // Preserve their bytes explicitly until that serialization is understood.
  const trailingData = r.take(r.bytes.length - r.offset);
  return { ...object, actors, model, url, urlValid, reachSpecs, trailingData };
}

/** UE1 v68–69 compiled BSP data. No editor-brush reconstruction is involved. */
export function readModel(pkg, bytes, index) {
  if (pkg.version < 68) throw new PackageError('Legacy model payload layout is not supported', 0);
  const { reader: r, entry } = readObject(pkg, bytes, index);
  if (entry.className !== 'Model') throw new PackageError('Expected Model export', 0);
  const bounds = box(r), sphere = [...vector(r), r.f32()];
  const vectors = counted(r, 12, () => vector(r));
  const points = counted(r, 12, () => vector(r));
  const nodes = counted(r, 43, () => ({
    plane: [...vector(r), r.f32()], zoneMask: mask64(r), flags: r.u8(),
    vertexPool: r.compact(), surface: r.compact(), back: r.compact(), front: r.compact(),
    coplanar: r.compact(), collisionBound: r.compact(), renderBound: r.compact(),
    zones: [r.compact(), r.compact()], vertexCount: r.u8(), leaves: [r.i32(), r.i32()],
  }));
  const surfaces = counted(r, 16, () => ({
    texture: r.compact(), flags: r.u32(), base: r.compact(), normal: r.compact(),
    textureU: r.compact(), textureV: r.compact(), lightMap: r.compact(),
    brushPolygon: r.compact(), pan: [r.i16(), r.i16()], brushActor: r.compact(),
  }));
  const vertices = counted(r, 2, () => ({ point: r.compact(), side: r.compact() }));
  const sharedSides = r.i32();
  const zoneCount = r.i32();
  if (zoneCount > 64) throw new PackageError('Invalid zone count', r.offset);
  const zones = counted(r, 17, () => ({ actor: r.compact(), connectivity: mask64(r), visibility: mask64(r) }), zoneCount);
  const polygons = r.compact();
  const lightMaps = counted(r, 30, () => ({
    dataOffset: r.i32(), pan: vector(r), clamp: [r.compact(), r.compact()],
    scale: [r.f32(), r.f32()], lightActors: r.i32(),
  }));
  const lightBits = r.take(r.compact());
  const renderBounds = counted(r, 25, () => box(r));
  const leafHulls = counted(r, 4, () => r.i32());
  const leaves = counted(r, 11, () => ({ zone: r.compact(), permeating: r.compact(), volumetric: r.compact(), visibleZones: mask64(r) }));
  const lights = counted(r, 1, () => r.compact());
  const rootOutside = r.i32(), linked = r.i32();
  if (r.offset !== r.bytes.length) throw new PackageError('Trailing Model data', r.offset);

  function validIndex(value, array, label, optional = false) {
    if (optional && value === -1) return;
    if (!Number.isInteger(value) || value < 0 || value >= array.length) throw new PackageError(`Invalid ${label} index ${value}`, r.offset);
  }
  for (const node of nodes) {
    validIndex(node.surface, surfaces, 'surface');
    for (const ref of [node.back, node.front, node.coplanar]) validIndex(ref, nodes, 'node', true);
    if (node.vertexCount && (node.vertexPool < 0 || node.vertexPool + node.vertexCount > vertices.length)) {
      throw new PackageError('Node vertex span outside pool', r.offset);
    }
  }
  const usedVertices = new Uint8Array(vertices.length);
  for (const n of nodes) {
    for (let i = 0; i < n.vertexCount; i++) usedVertices[n.vertexPool + i] = 1;
  }
  let unusedInvalidVertices = 0;
  for (const [i, v] of vertices.entries()) {
    if (usedVertices[i]) validIndex(v.point, points, 'point');
    else if (v.point < 0 || v.point >= points.length) unusedInvalidVertices++;
  }
  for (const s of surfaces) {
    objectAt(pkg, s.texture); objectAt(pkg, s.brushActor);
    validIndex(s.base, points, 'surface base');
    for (const ref of [s.normal, s.textureU, s.textureV]) validIndex(ref, vectors, 'surface vector');
    validIndex(s.lightMap, lightMaps, 'light map', true);
  }
  return { entry, bounds, sphere, vectors, points, nodes, surfaces, vertices, sharedSides, zones,
    polygons, lightMaps, lightBits, renderBounds, leafHulls, leaves, lights, rootOutside, linked,
    diagnostics: { unusedInvalidVertices } };
}

/** Fan triangulation of convex BSP polygons, preserving surface IDs and engine coordinates. */
export function triangulateModel(model, { includeInvisible = false } = {}) {
  const triangles = [];
  for (const [nodeIndex, node] of model.nodes.entries()) {
    const surface = model.surfaces[node.surface];
    if (!includeInvisible && (surface.flags & 1)) continue;
    if (node.vertexCount < 3) continue;
    const point = i => model.vertices[node.vertexPool + i].point;
    for (let i = 1; i < node.vertexCount - 1; i++) {
      triangles.push({ points: [point(0), point(i), point(i + 1)], surface: node.surface, node: nodeIndex });
    }
  }
  return triangles;
}
