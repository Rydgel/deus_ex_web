/** three.js layers the Play renderer uses beyond the default layer 0. */

/** Decals (decal-scene.mjs): the main camera shows them; mirror and sky
 * child cameras leave them out, as ClipDecal empties every fragment in a
 * mirror frame (docs/decals.md). */
export const DECAL_LAYER = 1;

/** The detail-texture pass (detail-scene.mjs) draws after the opaque surfaces and before the decals (DrawComplexSurface draws a
 * surface's fans right after the surface; the decals follow the occluding surfaces), so below the decals' -1. */
export const DETAIL_RENDER_ORDER = -2;
