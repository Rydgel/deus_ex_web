/** three.js layers the Play renderer uses beyond the default layer 0. */

/** Decals (decal-scene.mjs): the main camera shows them; mirror and sky
 * child cameras leave them out, as ClipDecal empties every fragment in a
 * mirror frame (docs/decals.md). */
export const DECAL_LAYER = 1;
