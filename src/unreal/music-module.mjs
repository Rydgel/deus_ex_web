/** UMusic module bytes. A Music export serializes its tagged properties, the
 * FName FileType, then the TLazyArray<BYTE> Data: for package version > 61 the
 * stored end offset (absolute in the file), a compact count, then the bytes.
 * UMusic::Serialize and the lazy array layout are the ones
 * scripts/validate-music-load-graph.mjs checks through the original load
 * queue; this helper only slices the bytes out (no copy). */
import { readObject, nameAt } from './objects.mjs';

export function readMusicExport(asset, index) {
  const object = readObject(asset.pkg, asset.bytes, index), reader = object.reader;
  const fileType = nameAt(asset.pkg, reader.compact());
  if (!(asset.pkg.version > 61)) throw new Error(`${asset.name}: music lazy arrays need package version > 61`);
  const end = reader.u32(), count = reader.compact();
  const start = asset.pkg.exports[index - 1].serialOffset + reader.offset;
  if (start + count !== end) throw new Error(`${asset.name}: music lazy array end offset ${end} != ${start}+${count}`);
  return { path: asset.pkg.exports[index - 1].path, fileType, bytes: asset.bytes.subarray(start, end) };
}

/** Every Music export of a loaded package asset ({pkg, bytes, name}). */
export function musicExports(asset) {
  const out = [];
  asset.pkg.exports.forEach((entry, i) => {
    if (entry.className === 'Music') out.push(readMusicExport(asset, i + 1));
  });
  return out;
}
