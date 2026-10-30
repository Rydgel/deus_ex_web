import { parsePackage, PackageError } from './package.mjs';
import { readObject } from './objects.mjs';
import { readLevel, readModel, triangulateModel } from './model.mjs';

/** A map package decoded. `triangles: false` leaves out the BSP's triangle list (null), which only the page's world build reads: the
 * simulation worker keeps the decoded map as long as the level lives, and the list is about 110,000 objects on the Island.
 * `properties: false` leaves out the actors' property tags (null), which only the simulation's attach reads (script-map-properties.mjs
 * prepareMapProperties, which reads them again from the package when they are null): the page of a level the worker simulates keeps the
 * decoded map and has no use for 83,000 tag objects on the Island. */
export function decodeMap(bytes, { triangles: withTriangles = true, properties: withProperties = true } = {}) {
  const pkg = parsePackage(bytes);
  const levelIndices = pkg.exports.flatMap((e, i) => e.className === 'Level' ? [i + 1] : []);
  if (levelIndices.length !== 1) throw new PackageError('Expected exactly one Level export', 0);
  const level = readLevel(pkg, bytes, levelIndices[0]);
  const model = readModel(pkg, bytes, level.model);
  const actors = level.actors.filter(ref => ref > 0).map(ref => {
    const object = readObject(pkg, bytes, ref);
    return {
      index: ref, name: object.entry.name, className: object.entry.className,
      // Every field in the literal, in the order of the tag (readProperties) with `byteLength` for `data`: a late-added `byteLength` was a
      // property array of its own on each of the Island's 83,000 tags.
      properties: object.properties.map(({ name, type, struct, arrayIndex, value, decoded, data }) =>
        ({ name, type, struct, arrayIndex, value, decoded, byteLength: data.length })),
      values: object.values, nativeBytes: object.reader.bytes.length - object.reader.offset,
      // The saved FStateFrame (RF_HasStack exports): Node, StateNode, ProbeMask, LatentAction and the code offset (a saved level).
      stack: object.stack,
    };
  });
  const triangles = withTriangles ? triangulateModel(model) : null;
  const undecodedActorProperties = actors.reduce((n, a) => n + a.properties.filter(p => !p.decoded).length, 0);
  if (!withProperties) for (const a of actors) a.properties = null;
  const summary = {
    version: pkg.version, worldModel: model.entry.name,
    points: model.points.length, nodes: model.nodes.length, surfaces: model.surfaces.length,
    triangles: triangles?.length ?? null, actors: actors.length,
    playerStarts: actors.filter(a => a.className === 'PlayerStart').map(a => ({ name: a.name, location: a.values.Location ?? null, rotation: a.values.Rotation ?? null })),
    lightMaps: model.lightMaps.length, lightBitBytes: model.lightBits.length,
    unknownLevelBytes: level.trailingData.length,
    undecodedActorProperties,
    ...model.diagnostics,
  };
  return { pkg, level, model, actors, triangles, summary };
}
