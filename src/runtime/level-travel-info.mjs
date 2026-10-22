/** The saved Level's trailing fields (docs/travel.md "The .dxs": ULevel::Serialize after the reach specs): `TimeSeconds` (a double written as a float,
 * Engine 0x1039d5a2), `FirstDeleted` (a compact reference, 0 after CleanupDestroyed(1)), 16 empty `TextBlocks` (compact references) and `TravelInfo`, the
 * text pairs of the level's TMap<FString,FString> (a compact count, then key and value). `readLevel` (src/unreal/model.mjs) keeps these bytes whole in
 * `trailingData`; a level saved while it played carries the TravelInfo it was entered with (LoadMap with a NULL TravelInfo, as `?loadgame=` calls it,
 * keeps it: the level's `?restart` uses it). Returns [[key, text], ...]. */
import { Reader } from '../unreal/package.mjs';

export function readSavedTravelInfo(pkg, level) {
  const r = new Reader(level.trailingData);
  r.f32();                                      // TimeSeconds
  r.compact();                                  // FirstDeleted
  for (let i = 0; i < 16; i++) r.compact();     // TextBlocks
  const count = r.compact(), pairs = [];
  for (let i = 0; i < count; i++) pairs.push([r.string(pkg.version), r.string(pkg.version)]);
  return pairs;
}
