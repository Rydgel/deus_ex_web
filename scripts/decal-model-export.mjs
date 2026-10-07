/** A map's compiled model and placed actors as the decal oracles read them
 * (scripts/native-decal-oracle.py, native-decal-cases.py): float fields as
 * f32 bit patterns, each surface's brush actor class.
 *
 *   node scripts/decal-model-export.mjs <map> <out.json>
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameDirectory } from './game-directory.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { objectAt } from '../src/unreal/objects.mjs';

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const bits = v => (f32[0] = v, u32[0]);

/** The oracle JSON of a decoded map (`decodeMap`). `model` replaces the
 * map's (the moving brush tracker's filtered model, brush-tracker.mjs
 * trackedModel: its surfaces' `mover` index gives `moverRotation(index)` as
 * the surface Actor's Rotation, and only `originalNodes` reach Surf.Nodes). */
export function decalModelJson(name, map, { model = map.model, moverRotation = null } = {}) {
  return {
    map: name,
    model: {
      ...(model.originalNodes !== undefined ? { originalNodes: model.originalNodes } : {}),
      nodes: model.nodes.map(n => ({ planeBits: n.plane.map(bits), zoneMask: n.zoneMask, vertexPool: n.vertexPool,
        surface: n.surface, back: n.back, front: n.front, coplanar: n.coplanar, collisionBound: n.collisionBound,
        renderBound: n.renderBound, zones: n.zones, vertexCount: n.vertexCount, flags: n.flags, leaves: n.leaves })),
      verts: model.vertices.map(v => [v.point, v.side]),
      vectorBits: model.vectors.map(p => p.map(bits)), pointBits: model.points.map(p => p.map(bits)),
      surfs: model.surfaces.map(s => ({ flags: s.flags >>> 0, base: s.base, normal: s.normal,
        brushActor: s.brushActor ? objectAt(map.pkg, s.brushActor).className : null,
        ...(s.dynamic ? { mover: moverRotation(s.mover) } : {}) })),
      leafHulls: model.leafHulls, rootOutside: model.rootOutside,
    },
    actors: map.actors.filter(a => a.values.Location).map(a => ({ index: a.index, name: a.name, className: a.className,
      location: a.values.Location, collisionRadius: a.values.CollisionRadius, collisionHeight: a.values.CollisionHeight })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [name = '00_Training', out] = process.argv.slice(2);
  if (!out) throw new Error('usage: decal-model-export.mjs <map> <out.json>');
  const root = gameDirectory(), files = [];
  for (const directory of ['Maps', 'System', 'Textures'])
    for (const file of await readdir(path.join(root, directory)))
      files.push({ path: `${directory}/${file}`, read: () => readFile(path.join(root, directory, file)) });
  const assets = new AssetStore(files), asset = await assets.get(name);
  await writeFile(out, JSON.stringify(decalModelJson(name, decodeMap(asset.bytes))));
}
