import { counted, nameAt, objectAt, readObject, vector } from './objects.mjs';
import { PackageError } from './package.mjs';

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

/** Runtime mover polygons carry their polygon ordinal as the lighting index.
 * Match the compiled surfaces explicitly, rather than assuming the same order. */
export function withMoverLightmaps(model, polygons) {
  const equal = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-5);
  const surfaces = model.surfaces.map(s => {
    const matches = polygons.map((p, i) => ({ p, i })).filter(({ p }) => p.texture === s.texture &&
      equal(p.base, model.points[s.base]) && equal(p.normal, model.vectors[s.normal]) &&
      equal(p.textureU, model.vectors[s.textureU]) && equal(p.textureV, model.vectors[s.textureV]) && equal(p.pan, s.pan));
    if (matches.length !== 1) throw new Error('Ambiguous mover polygon lighting correspondence');
    const lightMap = matches[0].i;
    if (lightMap >= model.lightMaps.length) throw new Error('Missing mover polygon lightmap');
    return { ...s, lightMap };
  });
  return { ...model, surfaces };
}
