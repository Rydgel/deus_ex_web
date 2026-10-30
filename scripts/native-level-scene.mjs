import { readModel } from '../src/unreal/model.mjs';
import { nativeModel } from './native-model.mjs';
import { exportAt } from '../src/unreal/objects.mjs';

// The native level-query scene of a decoded map: the level model plus every
// actor with bCollideActors, in map order.  validate-native-level feeds it to
// native-level-oracle.py; validators that reuse the scene build it here rather
// than reading native-level's report, which may be rewritten mid-sweep.
export async function nativeLevelScene(defaults, asset, map) {
  const actors = [];
  for (const actor of map.actors) {
    const values = await defaults.forActor(asset, actor);
    if (!values.bCollideActors) continue;
    const lineage = await defaults.lineage(asset, exportAt(asset.pkg, actor.index).classIndex);
    const kind = ['Pawn', 'Mover', 'ZoneInfo'].find(k => lineage.includes(`engine.${k.toLowerCase()}`)) ?? 'Actor';
    const model = values.Brush > 0 ? readModel(asset.pkg, asset.bytes, values.Brush) : null;
    actors.push({ id: actor.name, index: actor.index, kind, lineage, values,
      collisionBits: 1 | (values.bBlockActors ? 4 : 0) | (values.bBlockPlayers ? 8 : 0) | (values.bProjTarget ? 16 : 0),
      model: model && nativeModel(model) });
  }
  for (const actor of actors) actor.owner = actors.find(a => a.index === actor.values.Owner)?.id ?? null;
  return { model: nativeModel(map.model), actors };
}
