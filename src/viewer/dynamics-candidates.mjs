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
import { SETUP, SETUP_ROOT_EXCLUDED, SETUP_TEXTURE_SIZED, SETUP_TEXTURE_UNKNOWN, meshRecordFields } from '../runtime/bsp-occlusion.mjs';

/** ACTOR_OCCLUSION=frustum (Node) or ?actorOcclusion=frustum keeps the
 * frustum-tested drawn set (drawn-set.mjs) for the main frame's actors. */
export const actorOcclusionMode = () => (typeof process !== 'undefined' && process.env?.ACTOR_OCCLUSION)
  || globalThis.DEUS_EX_ACTOR_OCCLUSION || 'bsp';

/** Pack the frame's candidates into `occlusion`'s Setup buffer: `sprites`
 * (sprite-scan records), `iterators` (the actors iterating in their items'
 * place), and from the actor mesh layer `bindings`, `items` ({item,
 * binding}), `reads` (this frame's mesh_reads) and `levelIndex` (actor →
 * Level.Actors index). With `childFrames` (OccludeFrame's child frames),
 * a binding only child frames admit (the player in a mirror: the root
 * frame's excluded actor and ViewTarget) is a candidate too, flagged
 * SETUP_ROOT_EXCLUDED. Returns the entries in candidate order: {binding,
 * item, sprite, rootExcluded}. */
export function packDynamics(occlusion, { sprites = [], iterators = null, bindings = [], items = [], reads = null,
  levelIndex = null, childFrames = false }) {
  const entries = [];
  for (const binding of bindings) {
    if (iterators?.has(binding.actor)) continue;
    const index = levelIndex?.get(binding.actor);
    if (index === undefined) continue;
    if (binding.admitted(reads)) entries.push({ order: index * 65536, binding, item: null, sprite: null, rootExcluded: false });
    else if (childFrames && binding.childAdmitted?.(reads))
      entries.push({ order: index * 65536, binding, item: null, sprite: null, rootExcluded: true });
  }
  for (const { item, binding } of items) entries.push({ order: item.order, binding, item, sprite: null });
  for (const sprite of sprites) entries.push({ order: sprite.order, binding: null, item: null, sprite });
  entries.sort((a, b) => a.order - b.order);
  // Mesh records before the views: a new record may grow the memory.
  const records = entries.map(e => e.binding ? occlusion.meshRecord(e.binding.mesh.key, meshRecordFields(e.binding.payload)) : 0);
  const views = occlusion.setupCandidates(entries.length), { u32, f32, i32 } = views;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], at = views.at + SETUP.WORDS * i;
    if (e.binding) {
      e.binding.packSetup(views, at, i, records[i], reads, e.item);
      u32[at + SETUP.FLAGS] = e.rootExcluded ? SETUP_ROOT_EXCLUDED : 0;
      continue;
    }
    packSprite(views, at, i, e.sprite);
  }
  return entries;
}

/** A DT_Sprite or DT_SpriteAnimOnce record as Setup's candidate: its sprite
 * path reads the texture's size, Location and DrawScale. */
function packSprite({ u32, f32, i32 }, at, key, sprite) {
  u32.fill(0, at, at + SETUP.WORDS);
  u32[at + SETUP.KEY] = key; u32[at + SETUP.DRAWTYPE] = 1;
  if (sprite.size) {
    u32[at + SETUP.TEXTURE] = SETUP_TEXTURE_SIZED; i32[at + SETUP.USIZE] = sprite.size[0]; i32[at + SETUP.VSIZE] = sprite.size[1];
  } else u32[at + SETUP.TEXTURE] = SETUP_TEXTURE_UNKNOWN;
  for (let k = 0; k < 3; k++) f32[at + SETUP.LOCATION + k] = sprite.location[k];
  f32[at + SETUP.DRAWSCALE] = sprite.drawScale;
}

/** The root frame's packed candidates (what packDynamics last put in
 * `occlusion`'s candidate block), copied for patchDynamics. */
export function candidateWords(occlusion, count) {
  const views = occlusion.setupCandidates(count);
  return views.u32.slice(views.at, views.at + SETUP.WORDS * count);
}

/** A child frame's candidates when its own SetupDynamics (the iterators run
 * again) changed only the iterator-made ones: the root's `entries` and
 * their packed `words` (candidateWords), with each iterator-made candidate
 * (a mesh item's binding, a sprite record) packed again from this frame's
 * `items` ({item, binding}, actor-mesh-sim.mjs `itemCandidates`) and
 * `sprites` (the frame's list, childFrameSprites). The same candidates
 * packDynamics would give, in the same order, when this frame's iterator-made
 * entries stand in the root's places (the same orders, bindings and kinds:
 * the sort puts them where the root's stood); null when they do not, and the
 * caller packs the frame from scratch. Returns the entries. */
export function patchDynamics(occlusion, rootEntries, rootWords, { items, sprites, reads = null }) {
  const own = [];
  for (const { item, binding } of items) own.push({ order: item.order, binding, item, sprite: null });
  for (const sprite of sprites) if (sprite.viaIterator) own.push({ order: sprite.order, binding: null, item: null, sprite });
  own.sort((a, b) => a.order - b.order);
  const places = [];
  for (let i = 0; i < rootEntries.length; i++) if (rootEntries[i].item || rootEntries[i].sprite?.viaIterator) places.push(i);
  if (places.length !== own.length) return null;
  for (let k = 0; k < places.length; k++) {
    const root = rootEntries[places[k]], mine = own[k];
    if (root.order !== mine.order || root.binding !== mine.binding || Boolean(root.item) !== Boolean(mine.item)) return null;
  }
  const entries = rootEntries.slice();
  const views = occlusion.setupCandidates(entries.length);
  views.u32.set(rootWords, views.at);
  for (let k = 0; k < places.length; k++) {
    const i = places[k], e = own[k], at = views.at + SETUP.WORDS * i;
    if (e.binding) {
      // The slot's mesh record is the root candidate's.
      e.binding.packSetup(views, at, i, rootWords[SETUP.WORDS * i + SETUP.MESH], reads, e.item);
      views.u32[at + SETUP.FLAGS] = 0;
    } else packSprite(views, at, i, e.sprite);
    entries[i] = e;
  }
  return entries;
}

/** Whether two sprite records draw the same (sprite-scan.mjs records): the
 * same actor, texture, style, place and scale. */
export const sameSprite = (a, b) => a.handle === b.handle && a.style === b.style && a.texture.key === b.texture.key
  && a.texture.package === b.texture.package && a.texture.index === b.texture.index && a.drawScale === b.drawScale
  && a.scaleGlow === b.scaleGlow && a.location.every((v, k) => Object.is(v, b.location[k]));

/** A child frame's sprite records after its own SetupDynamics ran the
 * iterators again (docs/bsp-occlusion.md "Child frames"): `rootSprites` are
 * the root frame's records (those from iterators carry `viaIterator`) and
 * `scanned` the records the frame's own run made, in order. The frame's
 * list is the root's other records and, for each scanned one, the root's
 * record of the same `order` it equals (a particle's, which draws the same
 * in every frame) or else a record of its own: `make(record)` completes it
 * (texture size) and it joins `known` so that later frames' equal records
 * share it. Returns the list and the records made. */
export function childFrameSprites(rootSprites, scanned, known, make) {
  const sprites = rootSprites.filter(sprite => !sprite.viaIterator), added = [];
  for (const record of scanned) {
    let found = known.get(record.order)?.find(other => sameSprite(other, record));
    if (!found) {
      make(record); added.push(record);
      if (!known.has(record.order)) known.set(record.order, []);
      known.get(record.order).push(record);
      found = record;
    }
    sprites.push(found);
  }
  return { sprites, added };
}

/** The root frame's iterator-made sprite records by `order`, for
 * childFrameSprites's `known`. */
export function iteratorSpritesByOrder(rootSprites) {
  const known = new Map();
  for (const sprite of rootSprites) {
    if (!sprite.viaIterator) continue;
    if (!known.has(sprite.order)) known.set(sprite.order, []);
    known.get(sprite.order).push(sprite);
  }
  return known;
}
