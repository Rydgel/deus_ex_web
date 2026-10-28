/** three.js layers the Play renderer uses beyond the default layer 0. */

/** Decals (decal-scene.mjs): the main camera shows them; mirror and sky
 * child cameras leave them out, as ClipDecal empties every fragment in a
 * mirror frame (docs/decals.md). */
export const DECAL_LAYER = 1;

/** The detail-texture pass (detail-scene.mjs) draws after the opaque surfaces and before the decals (DrawComplexSurface draws a
 * surface's fans right after the surface; the decals follow the occluding surfaces), so below the decals' -1. */
export const DETAIL_RENDER_ORDER = -2;

/** The fog-map pass (fog-pass.mjs) draws after the detail fans and before the decals: D3DDrv's DrawComplexSurface (`0x10003900`)
 * draws a surface's fog map as its last pass, and DrawFrame (`0x10b1a2d0`) calls it (`+0x74`, `0x10b1b057`) before the surface's
 * decal block (DrawGouraudPolygon `+0x78` at `0x10b1b2a7`) and before every later list item, sprite and corona
 * (docs/bsp-occlusion.md "DrawFrame's draw order"). Translucent and modulated items, which write no depth, then blend over the
 * fogged surface, as in the original. FOG_RENDER_ORDER_LAST is the place it had before (after every other world item), kept as
 * a validation arm (viewer fogOrder). */
export const FOG_RENDER_ORDER = -1.5;
export const FOG_RENDER_ORDER_LAST = 1;
/** A masked surface is a Draw[2] item (OccludeBsp), drawn after the first sprite pass, and D3DDrv's fog pass over it is not
 * alpha-tested (`SetBlending(0x10000000)` at `0x10004d40`): the fog covers the surface's holes and writes their depth. Its fog map
 * therefore draws in the non-occluding list's band (render order 0, the world's translucent and modulated surfaces), after the
 * first sprite pass and before the second, so what lies behind the surface and was drawn before it shows through the holes, fogged. */
export const FOG_RENDER_ORDER_MASKED = 0;

/** DrawFrame's two passes over Frame->Sprite (`0x10b1b3f6..0x10b1b44b`): on a device that is not span based (D3D,
 * `[RenDev+0x48]` 0) an actor whose Style is not STY_Translucent (`cmpb $3, 0x165(actor)` at `0x10b1b40d`) is drawn after
 * the occluding list and before the non-occluding one (the world's translucent, modulated and masked surfaces, render
 * order 0 here), a translucent one after the non-occluding list. Sprites and the transparent groups of actor meshes take
 * these bands by their actor's Style; within a band three.js's back-to-front sort stands for the RenderNext order. */
export const ACTOR_PASS_RENDER_ORDER = Object.freeze({ first: -0.5, second: 0.5 });
// Measurement only: ?actorPasses=off keeps every sprite and transparent mesh group at render order 0 (three.js's depth sort with
// the world's surfaces), the order before 2026-10-28.
const actorPasses = !/[?&]actorPasses=off(&|$)/.test(globalThis.location?.search ?? '');
export const actorPassRenderOrder = style => !actorPasses ? 0 : style === 3 ? ACTOR_PASS_RENDER_ORDER.second : ACTOR_PASS_RENDER_ORDER.first;
