import { parsePackage, PackageError } from './package.mjs';
import { readObject } from './objects.mjs';
import { readLevel, readModel, triangulateModel } from './model.mjs';

export function decodeMap(bytes) {
  const pkg = parsePackage(bytes);
  const levelIndices = pkg.exports.flatMap((e, i) => e.className === 'Level' ? [i + 1] : []);
  if (levelIndices.length !== 1) throw new PackageError('Expected exactly one Level export', 0);
  const level = readLevel(pkg, bytes, levelIndices[0]);
  const model = readModel(pkg, bytes, level.model);
  const actors = level.actors.filter(ref => ref > 0).map(ref => {
    const object = readObject(pkg, bytes, ref);
    return {
      index: ref, name: object.entry.name, className: object.entry.className,
      properties: object.properties.map(({ data, ...property }) => ({ ...property, byteLength: data.length })),
      values: object.values, nativeBytes: object.reader.bytes.length - object.reader.offset,
    };
  });
  const triangles = triangulateModel(model);
  const summary = {
    version: pkg.version, worldModel: model.entry.name,
    points: model.points.length, nodes: model.nodes.length, surfaces: model.surfaces.length,
    triangles: triangles.length, actors: actors.length,
    playerStarts: actors.filter(a => a.className === 'PlayerStart').map(a => ({ name: a.name, location: a.values.Location ?? null, rotation: a.values.Rotation ?? null })),
    lightMaps: model.lightMaps.length, lightBitBytes: model.lightBits.length,
    unknownLevelBytes: level.trailingData.length,
    undecodedActorProperties: actors.reduce((n, a) => n + a.properties.filter(p => !p.decoded).length, 0),
    ...model.diagnostics,
  };
  return { pkg, level, model, actors, triangles, summary };
}
