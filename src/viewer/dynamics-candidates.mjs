/** SetupDynamics' sprites for Play's main frame (docs/bsp-occlusion.md
 * "Play"). URender::SetupDynamics (0x10b22d90) constructs an FDynamicSprite
 * for each admitted actor in Level.Actors order, an iterating actor's items
 * in its place; FDynamicSprite::Setup (setup.rs, Rust) decides each one's
 * rectangle and OccludeBsp keeps those it reaches through free spans in
 * Frame->Sprite, the actors DrawFrame draws and stamps.
 *
 * The simulation side already scans in that order, in two halves: the
 * sprite scan (sprite-scan.mjs: DT_Sprite actors and render-iterator items,
 * each with its `order`) and the actor mesh layer (actor-mesh-sim.mjs: the
 * mesh bindings, admitted by the root frame's rules, and the iterator items'
 * bindings). This host glue merges them by order and packs each as Setup's
 * candidate; the candidate's key is its index in the returned entries.
 *
 * Host limits (explicit): an actor the page has no binding or decoded
 * texture for is not a candidate (it is neither drawn nor stamped, as
 * before); RenderIterator classes other than ParticleIterator and
 * LaserIterator and the bHighDetail rule are the sprite scan's. */
import { SETUP, SETUP_TEXTURE_SIZED, SETUP_TEXTURE_UNKNOWN, meshRecordFields } from '../runtime/bsp-occlusion.mjs';

/** ACTOR_OCCLUSION=frustum (Node) or ?actorOcclusion=frustum keeps the
 * frustum-tested drawn set (drawn-set.mjs) for the main frame's actors. */
export const actorOcclusionMode = () => (typeof process !== 'undefined' && process.env?.ACTOR_OCCLUSION)
  || globalThis.DEUS_EX_ACTOR_OCCLUSION || 'bsp';

/** Pack the frame's candidates into `occlusion`'s Setup buffer: `sprites`
 * (sprite-scan records), `iterators` (the actors iterating in their items'
 * place), and from the actor mesh layer `bindings`, `items` ({item,
 * binding}), `reads` (this frame's mesh_reads) and `levelIndex` (actor →
 * Level.Actors index). Returns the entries in candidate order: {binding,
 * item, sprite}. */
export function packDynamics(occlusion, { sprites = [], iterators = null, bindings = [], items = [], reads = null,
  levelIndex = null }) {
  const entries = [];
  for (const binding of bindings) {
    if (iterators?.has(binding.actor)) continue;
    const index = levelIndex?.get(binding.actor);
    if (index === undefined || !binding.admitted(reads)) continue;
    entries.push({ order: index * 65536, binding, item: null, sprite: null });
  }
  for (const { item, binding } of items) entries.push({ order: item.order, binding, item, sprite: null });
  for (const sprite of sprites) entries.push({ order: sprite.order, binding: null, item: null, sprite });
  entries.sort((a, b) => a.order - b.order);
  // Mesh records before the views: a new record may grow the memory.
  const records = entries.map(e => e.binding ? occlusion.meshRecord(e.binding.mesh.key, meshRecordFields(e.binding.payload)) : 0);
  const views = occlusion.setupCandidates(entries.length), { u32, f32, i32 } = views;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], at = views.at + SETUP.WORDS * i;
    if (e.binding) { e.binding.packSetup(views, at, i, records[i], reads, e.item); continue; }
    // A DT_Sprite or DT_SpriteAnimOnce record: Setup's sprite path reads
    // the texture's size, Location and DrawScale.
    const sprite = e.sprite;
    u32.fill(0, at, at + SETUP.WORDS);
    u32[at + SETUP.KEY] = i; u32[at + SETUP.DRAWTYPE] = 1;
    if (sprite.size) {
      u32[at + SETUP.TEXTURE] = SETUP_TEXTURE_SIZED; i32[at + SETUP.USIZE] = sprite.size[0]; i32[at + SETUP.VSIZE] = sprite.size[1];
    } else u32[at + SETUP.TEXTURE] = SETUP_TEXTURE_UNKNOWN;
    for (let k = 0; k < 3; k++) f32[at + SETUP.LOCATION + k] = sprite.location[k];
    f32[at + SETUP.DRAWSCALE] = sprite.drawScale;
  }
  return entries;
}
