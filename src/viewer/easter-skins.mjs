/** The ?easter=1 mod's skin hook (docs/easter-egg.md). The actor mesh draw (actor-mesh-draw.mjs build) asks `easterSkins.current`
 * for each face group's skin once a skin is decoded; it is null unless the mod registered the two actors, so every other actor and
 * every page without ?easter=1 takes the stock skin untouched. The generating code is easter-skin-art.mjs, loaded on demand. */
export const easterSkins = { current: null };
