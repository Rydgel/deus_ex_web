import { counted, nameAt, objectAt, readObject, vector } from './objects.mjs';
import { PackageError } from './package.mjs';
import { modelFromObjects, PolygonNodes } from './bsp-model.mjs';

export function readPolys(pkg, bytes, index) {
  const { entry, reader: r } = readObject(pkg, bytes, index);
  if (entry.className !== 'Polys') throw new Error('Expected Polys');
  const count = r.i32(), capacity = r.i32();
  if (capacity < count) throw new PackageError('Invalid polygon capacity', r.offset);
  const ref = () => { const v = r.compact(); objectAt(pkg, v); return v; };
  const polygons = counted(r, 58, () => {
    const vertexCount = r.compact();
    const base = vector(r), normal = vector(r), textureU = vector(r), textureV = vector(r);
    const vertices = counted(r, 12, () => vector(r), vertexCount);
    const flags = r.u32(), actor = ref(), texture = ref(), name = nameAt(pkg, r.compact());
    const link = r.compact(), brushPolygon = r.compact(), pan = [r.i16(), r.i16()];
    return { base, normal, textureU, textureV, vertices, flags, actor, texture, name, link, brushPolygon, pan };
  }, count);
  if (r.offset !== r.bytes.length) throw new PackageError('Trailing Polys data', r.offset);
  return polygons;
}

/** A mover drawn as the original draws it: Engine's brush tracker
 * (0x1037b5c0, run for every non-static brush when the level's tracker is
 * built) appends one level surface per brush polygon, with the polygon's
 * texture, pan, base, normal and texture vectors, PolyFlags & 0x3cffffff
 * (PF_SpecialLit added for a bSpecialLit mover) and iLightMap = the
 * polygon's iBrushPoly, an index into the brush model's light maps (-1 for
 * invisible polygons); Update (0x1037a400) then transforms the polygons, not
 * the brush model's compiled BSP surfaces, whose light indices are all -1.
 * Returns that model (the brush's light maps, shadow bits and light lists
 * kept) with one node per polygon and its triangle fan. `trackedIndex`
 * gives each point's place among the polygons' vertices in order (the
 * tracker's transformed vertices, brush-tracker.mjs `moverPoints`), -1 for a
 * polygon's base point. */
export function moverModelFromPolys(model, polygons, { specialLit = false } = {}) {
  const points = [], vectors = [], surfaces = [], nodes = [], triangles = [], trackedIndex = [];
  let vertexOrdinal = 0;
  polygons.forEach((polygon, index) => {
    const base = points.push(polygon.base) - 1, normal = vectors.push(polygon.normal) - 1;
    trackedIndex.push(-1);
    const textureU = vectors.push(polygon.textureU) - 1, textureV = vectors.push(polygon.textureV) - 1;
    const flags = ((polygon.flags & 0x3cffffff) | (specialLit ? 0x100000 : 0)) >>> 0;
    surfaces.push({ texture: polygon.texture, flags, base, normal, textureU, textureV, lightMap: polygon.brushPolygon,
      brushPolygon: index, pan: polygon.pan });
    const [nx, ny, nz] = polygon.normal, [bx, by, bz] = polygon.base;
    nodes.push({ plane: [nx, ny, nz, nx * bx + ny * by + nz * bz], surface: index, vertexCount: polygon.vertices.length });
    const first = points.length;
    for (const vertex of polygon.vertices) { points.push(vertex); trackedIndex.push(vertexOrdinal++); }
    if (flags & 1) return;
    for (let k = 1; k < polygon.vertices.length - 1; k++) triangles.push({ points: [first, first + k, first + k + 1], surface: index, node: index });
  });
  // The tables (bsp-model.mjs) the brush's own were read as; the nodes keep their planes' offsets as doubles.
  const typed = modelFromObjects({ points, vectors, surfaces }), polygonNodes = new PolygonNodes(nodes.length);
  nodes.forEach((node, i) => { polygonNodes.planes.set(node.plane, 4 * i); polygonNodes.surfaces[i] = node.surface; polygonNodes.counts[i] = node.vertexCount; });
  return { model: { ...model, points: typed.points, vectors: typed.vectors, surfaces: typed.surfaces, nodes: polygonNodes, trackedIndex }, triangles };
}
