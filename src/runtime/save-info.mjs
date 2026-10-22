/** `SaveInfo.dxs`, read the way the original's StaticLoadObject reads it (docs/save-directory.md, docs/save-storage.md "The snapshot").
 *
 * A slot's `SaveInfo.dxs` is a version-68 package with three exports: the `Palette` and `Texture` of the snapshot (`Palette1`/`Texture1`, the
 * suffix the engine's unique-name counter gave them) and the `DeusExSaveInfo` object `MyDeusExSaveInfo` of the package `saveInfo`. The object's
 * serialized properties are the ones `DeusExSaveInfo.uc` declares (Year ... Second, DirectoryIndex, Description, MissionLocation, MapName,
 * saveCount, saveTime, bCheatsEnabled; a value equal to the class default is not stored) and `Snapshot`, an object reference to the Texture
 * export. The Texture is the 160 x 120 picture `XRootWindow::GenerateSnapshot` made, held in the next power-of-two size (the two real saves of
 * docs/save-directory.md: P8, 256 x 128, one mip, the picture in its top-left 160 x 120), its palette the `Palette` export (256 colours, 1024
 * bytes: the grey ramp GenerateSnapshot builds, docs/root-snapshot.md).
 *
 * `parseSaveInfo(bytes)` is the `parseInfo` of save-store.mjs: `{properties, snapshot}`, or null when the bytes are not a SaveInfo package.
 * `snapshot` is null (the property is unset) or `{texture, palette, image}`: the export names, and `image` the decoded picture
 * `{width, height, format, data, colors}` (P8 index bytes and the palette's RGBA colours), or null when the texture is in a form this reader does
 * not decode (it then draws nothing, as an unset Snapshot does). Only the package tables and the three exports are read; nothing is executed. */
import { parsePackage } from '../unreal/package.mjs';
import { readObject } from '../unreal/objects.mjs';
import { readTexture, readPalette, decodePixels, TEXTURE_FORMAT } from '../unreal/textures.mjs';

/** The properties of DeusExSaveInfo a loaded object is given (script-game-directory.mjs SAVE_INFO_PROPERTIES). */
export const SAVE_INFO_KEYS = Object.freeze(['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second', 'DirectoryIndex', 'Description', 'MissionLocation',
  'MapName', 'saveCount', 'saveTime', 'bCheatsEnabled']);

export function parseSaveInfo(bytes) {
  let pkg;
  try { pkg = parsePackage(bytes); } catch { return null; }
  const asset = { pkg, bytes };
  const index = pkg.exports.findIndex(entry => entry.className === 'DeusExSaveInfo');
  if (index < 0) return null;
  let object;
  try { object = readObject(pkg, bytes, index + 1); } catch { return null; }
  const properties = {};
  for (const key of SAVE_INFO_KEYS) if (object.values[key] !== undefined) properties[key] = object.values[key];
  let snapshot = null;
  const ref = object.values.Snapshot;
  if (Number.isInteger(ref) && ref > 0 && pkg.exports[ref - 1]) {
    const entry = pkg.exports[ref - 1];
    snapshot = { texture: entry.name, palette: null, image: null };
    try {
      const texture = readTexture(asset, ref);
      const paletteEntry = texture.palette > 0 ? pkg.exports[texture.palette - 1] : null;
      snapshot.palette = paletteEntry?.name ?? null;
      const mip = texture.mips[0];
      if (texture.format === TEXTURE_FORMAT.P8 && paletteEntry?.className === 'Palette' && mip) {
        snapshot.image = { width: mip.width, height: mip.height, format: texture.format, data: Uint8Array.from(mip.data), colors: Uint8Array.from(readPalette(asset, texture.palette)) };
      }
    } catch { /* an unreadable texture: the Snapshot object exists, its picture does not */ }
  }
  return { properties, snapshot };
}

/** The RGBA pixels the HUD draws for a snapshot image: P8 through its palette, index 0 kept at the palette's colour with alpha 0, the HUD
 * renderer's 'point' decode of every tile texture (textures.mjs decodePixels), so a masked style would discard it and a normal one draws it. */
export const snapshotPixels = image => decodePixels({ width: image.width, height: image.height, data: image.data }, TEXTURE_FORMAT.P8, image.colors, 'point');
