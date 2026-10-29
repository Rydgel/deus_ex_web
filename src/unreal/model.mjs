import { PackageError } from './package.mjs';
import { counted, objectAt, readObject, vector } from './objects.mjs';
import { BspNodes, Vec3s, Surfaces, Vertices, Zones, LightMaps, RenderBounds, Leaves, SURF, ZONE, LIGHT_MAP, BOUND, LEAF } from './bsp-model.mjs';

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

/** The array count `counted` (objects.mjs) accepts: the data left must hold that many records of at least `minimumBytes`. */
function recordCount(r, minimumBytes, n = r.compact()) {
  if (n < 0 || n > 1_000_000 || n > Math.floor((r.bytes.length - r.offset) / minimumBytes)) throw new PackageError(`Invalid array count ${n}`, r.offset);
  return n;
}

/** UE1 v68–69 compiled BSP data. No editor-brush reconstruction is involved. The tables are typed (bsp-model.mjs); the values are
 * the ones the object reader gave, read in the same order with the same checks (test/helpers/model-reference.mjs is that reader). */
export function readModel(pkg, bytes, index) {
  if (pkg.version < 68) throw new PackageError('Legacy model payload layout is not supported', 0);
  const { reader: r, entry } = readObject(pkg, bytes, index);
  if (entry.className !== 'Model') throw new PackageError('Expected Model export', 0);
  const bounds = box(r), sphere = [...vector(r), r.f32()];
  const readVec3s = () => {
    const table = new Vec3s(recordCount(r, 12)), d = table.data;
    for (let i = 0; i < d.length; i++) d[i] = r.f32();
    return table;
  };
  const vectors = readVec3s();
  const points = readVec3s();
  const nodes = new BspNodes(recordCount(r, 43));
  {
    const { i32, f32, u8 } = nodes;
    for (let i = 0; i < nodes.length; i++) {
      const o = i << 4, at = i << 6;
      f32[o] = r.f32(); f32[o + 1] = r.f32(); f32[o + 2] = r.f32(); f32[o + 3] = r.f32();
      i32[o + 4] = r.u32(); i32[o + 5] = r.u32(); u8[at + 55] = r.u8();
      i32[o + 6] = r.compact(); i32[o + 7] = r.compact(); i32[o + 8] = r.compact(); i32[o + 9] = r.compact();
      i32[o + 10] = r.compact(); i32[o + 11] = r.compact(); i32[o + 12] = r.compact();
      // The zones are bytes in the original's FBspNode; a value that is not a byte could not be held.
      const zone0 = r.compact(), zone1 = r.compact();
      if (!(zone0 >= 0 && zone0 <= 255 && zone1 >= 0 && zone1 <= 255)) throw new PackageError(`Node zone ${zone0 >= 0 && zone0 <= 255 ? zone1 : zone0} is not a byte`, r.offset);
      u8[at + 52] = zone0; u8[at + 53] = zone1;
      u8[at + 54] = r.u8(); i32[o + 14] = r.i32(); i32[o + 15] = r.i32();
    }
  }
  const surfaces = new Surfaces(recordCount(r, 16));
  {
    const w = surfaces.words;
    for (let i = 0; i < surfaces.length; i++) {
      const o = SURF.WORDS * i;
      w[o] = r.compact(); w[o + 1] = r.u32(); w[o + 2] = r.compact(); w[o + 3] = r.compact(); w[o + 4] = r.compact(); w[o + 5] = r.compact();
      w[o + 6] = r.compact(); w[o + 7] = r.compact(); w[o + 8] = r.i16(); w[o + 9] = r.i16(); w[o + 10] = r.compact();
    }
  }
  const vertices = new Vertices(recordCount(r, 2));
  for (let i = 0; i < vertices.words.length; i++) vertices.words[i] = r.compact();
  const sharedSides = r.i32();
  const zoneCount = r.i32();
  if (zoneCount > 64) throw new PackageError('Invalid zone count', r.offset);
  const zones = new Zones(recordCount(r, 17, zoneCount));
  for (let i = 0; i < zones.words.length; i++) zones.words[i] = i % ZONE.WORDS === 0 ? r.compact() : r.u32();
  const polygons = r.compact();
  const lightMaps = new LightMaps(recordCount(r, 30));
  {
    const { words, floats } = lightMaps;
    for (let i = 0; i < lightMaps.length; i++) {
      const o = LIGHT_MAP.WORDS * i;
      words[o] = r.i32(); floats[o + 1] = r.f32(); floats[o + 2] = r.f32(); floats[o + 3] = r.f32();
      words[o + 4] = r.compact(); words[o + 5] = r.compact(); floats[o + 6] = r.f32(); floats[o + 7] = r.f32(); words[o + 8] = r.i32();
    }
  }
  const lightBits = r.take(r.compact());
  const renderBounds = new RenderBounds(recordCount(r, 25));
  {
    const { words, floats } = renderBounds;
    for (let i = 0; i < renderBounds.length; i++) {
      const o = BOUND.WORDS * i;
      for (let k = 0; k < 6; k++) floats[o + k] = r.f32();
      words[o + 6] = r.u8() ? 1 : 0;
    }
  }
  const leafHulls = new Int32Array(recordCount(r, 4));
  for (let i = 0; i < leafHulls.length; i++) leafHulls[i] = r.i32();
  const leaves = new Leaves(recordCount(r, 11));
  for (let i = 0; i < leaves.length; i++) {
    const o = LEAF.WORDS * i, w = leaves.words;
    w[o] = r.compact(); w[o + 1] = r.compact(); w[o + 2] = r.compact(); w[o + 3] = r.u32(); w[o + 4] = r.u32();
  }
  const lights = new Int32Array(recordCount(r, 1));
  for (let i = 0; i < lights.length; i++) lights[i] = r.compact();
  const rootOutside = r.i32(), linked = r.i32();
  if (r.offset !== r.bytes.length) throw new PackageError('Trailing Model data', r.offset);

  function validIndex(value, length, label, optional = false) {
    if (optional && value === -1) return;
    if (!Number.isInteger(value) || value < 0 || value >= length) throw new PackageError(`Invalid ${label} index ${value}`, r.offset);
  }
  for (let i = 0; i < nodes.length; i++) {
    validIndex(nodes.surface(i), surfaces.length, 'surface');
    for (const ref of [nodes.back(i), nodes.front(i), nodes.coplanar(i)]) validIndex(ref, nodes.length, 'node', true);
    const vertexCount = nodes.vertexCount(i), vertexPool = nodes.vertexPool(i);
    if (vertexCount && (vertexPool < 0 || vertexPool + vertexCount > vertices.length)) {
      throw new PackageError('Node vertex span outside pool', r.offset);
    }
  }
  const usedVertices = new Uint8Array(vertices.length);
  for (let n = 0; n < nodes.length; n++) {
    const vertexPool = nodes.vertexPool(n);
    for (let i = 0; i < nodes.vertexCount(n); i++) usedVertices[vertexPool + i] = 1;
  }
  let unusedInvalidVertices = 0;
  for (let i = 0; i < vertices.length; i++) {
    const point = vertices.point(i);
    if (usedVertices[i]) validIndex(point, points.length, 'point');
    else if (point < 0 || point >= points.length) unusedInvalidVertices++;
  }
  for (let i = 0; i < surfaces.length; i++) {
    objectAt(pkg, surfaces.texture(i)); objectAt(pkg, surfaces.brushActor(i));
    validIndex(surfaces.base(i), points.length, 'surface base');
    for (const ref of [surfaces.normal(i), surfaces.textureU(i), surfaces.textureV(i)]) validIndex(ref, vectors.length, 'surface vector');
    validIndex(surfaces.lightMap(i), lightMaps.length, 'light map', true);
  }
  return { entry, bounds, sphere, vectors, points, nodes, surfaces, vertices, sharedSides, zones,
    polygons, lightMaps, lightBits, renderBounds, leafHulls, leaves, lights, rootOutside, linked,
    diagnostics: { unusedInvalidVertices } };
}

/** Fan triangulation of convex BSP polygons, preserving surface IDs and engine coordinates. */
export function triangulateModel(model, { includeInvisible = false } = {}) {
  const triangles = [];
  const { nodes, surfaces, vertices } = model;
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const surface = nodes.surface(nodeIndex), vertexCount = nodes.vertexCount(nodeIndex);
    if (!includeInvisible && (surfaces.flags(surface) & 1)) continue;
    if (vertexCount < 3) continue;
    const pool = nodes.vertexPool(nodeIndex), point = i => vertices.point(pool + i);
    for (let i = 1; i < vertexCount - 1; i++) {
      triangles.push({ points: [point(0), point(i), point(i + 1)], surface, node: nodeIndex });
    }
  }
  return triangles;
}
