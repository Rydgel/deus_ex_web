/** Render.dll's light-manager state that every GlobalLighting caller shares
 * (docs/mesh-lighting.md "LightType functions"): process globals in the
 * original, one record per script runtime here (the simulation's).
 *
 * - `strobe`: Strobe's flag (0x10b49ea8) and the TimeSeconds it last saw
 *   (0x10b49ea4). The Strobe type function (0x10b05b30) flips the flag when
 *   it is called with a TimeSeconds other than the stored one, so the flag
 *   flips once on each frame in which some Strobe light is set up: by
 *   SetupForSurf (a drawn surface's per-frame light map), by SetupForActor
 *   (a lit mesh) or by Galaxy's Update (an ambient sound's volume). The
 *   page's light maps take the flag the simulation leaves (sim-session.mjs).
 * - `noise`: the per-frame light noise (0x10b13080, static-lighting.mjs
 *   createLightNoise) that URender::PreRender advances from the game's
 *   shared appFrand stream; its table A drives Flicker.
 * - `previousA`: table A as it was before this frame's PreRender, which
 *   Galaxy's Update (called before PreRender in UGameEngine::Draw, after it
 *   in Play's frame) reads.
 * - `flickerKeyOf(actor)`: Flicker's table index. The original takes the low
 *   byte of the actor's address (0x10b05af0), which depends on the
 *   allocator's history; the host's stand-in, the same for every caller, is
 *   the low byte of a map-placed actor's export index (as the light maps'
 *   `ref & 0xff`), else of its Level.Actors slot (game.mjs sets it). */
const records = new WeakMap();
const ZERO_A = new Float32Array(256);

export function lightGlobals(runtime) {
  let record = records.get(runtime);
  if (!record) records.set(runtime, record = { strobe: { time: 0, flag: 0 }, noise: null, previousA: new Float32Array(256),
    flickerKeyOf: () => 0 });
  return record;
}

/** Table A for a caller without a running noise (headless checks): zeros,
 * as the light manager's tables are before the first PreRender. */
export const noiseTableA = runtime => lightGlobals(runtime).noise?.A ?? ZERO_A;
