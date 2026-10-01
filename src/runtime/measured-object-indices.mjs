import {TRAINING_NPC_IDENTITIES} from './training-npc-identities.mjs';
import {ISLAND_NPC_IDENTITIES} from './island-npc-identities.mjs';
import {MAP_NPC_IDENTITIES} from './map-npc-identities.mjs';
import {mapObjectIndex} from './map-object-indices.mjs';

const PAWN_TABLES = {...MAP_NPC_IDENTITIES, '00_training': TRAINING_NPC_IDENTITIES, '01_nyc_unatcoisland': ISLAND_NPC_IDENTITIES};

/** Give each pre-placed actor its measured global UObject index: the pawn
 * tables first (scripts/build-npc-identities.mjs; Training's is also used by
 * GetFrame), then every other actor measured in the same map's capture
 * (scripts/build-map-object-indices.mjs). Channel ids (execPlaySound, Galaxy's
 * ambient ids) are formed from these; an actor in neither stays unmeasured. */
export function assignMeasuredObjectIndices(runtime, actors) {
  for (const object of actors) {
    const map = object?.asset?.name?.toLowerCase();
    if (!map) continue;
    let index = PAWN_TABLES[map]?.[object.name];
    if (!Number.isInteger(index) && Number.isInteger(object.index)) index = mapObjectIndex(map, object.index);
    if (Number.isInteger(index)) runtime.instance(object).globalIndex = index;
  }
}
