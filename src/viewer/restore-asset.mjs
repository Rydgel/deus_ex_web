/** A filed level as a package asset: the bytes of `Save\Current\<file>` (the save directory, save-directory.mjs) parsed like a map. The package's
 * name is the file's stem (the original names the loaded package after the file: `Possessed PlayerPawn: JCDentonMale 01_NYC_UNATCOIsland.JCDentonMale1`).
 * `restore` is the request's `{file, name}` (travel.mjs). */
import { parsePackage } from '../unreal/package.mjs';
import { decodeMap } from '../unreal/map.mjs';

export function restoredLevel(directory, restore) {
  const bytes = directory.readFile('Current', restore.file);
  if (!bytes) throw new Error(`Save\\Current\\${restore.file} is not in the save directory`);
  const pkg = parsePackage(bytes);
  const stem = restore.file.replace(/\.dxs$/i, '');
  const asset = { name: stem, path: `Save/Current/${restore.file}`, bytes, pkg, exportsByPath: new Map(pkg.exports.map((entry, i) => [entry.path.toLowerCase(), i + 1])) };
  return { asset, map: decodeMap(bytes) };
}
