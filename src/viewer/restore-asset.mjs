/** A filed level as a package asset: the bytes of `Save\Current\<file>` (the save directory, save-directory.mjs) parsed like a map. The package's
 * name is the file's stem (the original names the loaded package after the file: `Possessed PlayerPawn: JCDentonMale 01_NYC_UNATCOIsland.JCDentonMale1`).
 * `restore` is the request's `{file, name}` (travel.mjs). */
import { parsePackage } from '../unreal/package.mjs';
import { decodeMap } from '../unreal/map.mjs';

export function restoredLevel(directory, restore, options) {
  const bytes = directory.readFile('Current', restore.file);
  if (!bytes) throw new Error(`Save\\Current\\${restore.file} is not in the save directory`);
  return filedLevel(bytes, restore, options);
}

/** The same asset from the file's bytes (the page's copy, main.mjs loadMap). `options` are decodeMap's. */
export function filedLevel(bytes, restore, options) {
  const pkg = parsePackage(bytes);
  const stem = restore.package ?? restore.file.replace(/\.dxs$/i, '');   // a live package of the same name keeps its spelling (travel.mjs loadGame)
  const asset = { name: stem, path: `Save/Current/${restore.file}`, bytes, pkg, exportsByPath: new Map(pkg.exports.map((entry, i) => [entry.path.toLowerCase(), i + 1])) };
  return { asset, map: decodeMap(bytes, options) };
}
