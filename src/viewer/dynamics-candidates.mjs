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
const byOrder = (a, b) => a.order - b.order;
// The mesh record addresses of one packDynamics call (a scratch, grown as needed: the call's own array of them was a map's result).
let recordAt = new Uint32Array(1024);
/** `pool` (the main frame's call, whose entries nothing keeps past the frame): a `{ objects: [], list: [], sorted: [], used: 0 }`
 * the entries are made in and reused from frame to frame (an entry object per candidate each frame was most of this function's
 * allocation). The returned array is the pool's `list`; objects past the count are cleared so they keep no actor alive. */
export function packDynamics(occlusion, args) {
  const {levelIndex = null, pool = null, reads = null} = args;
  // The roster's pass (render.rs pack_order) for the main frame, when the layer's roster served this frame's reads
  if (pool !== null && levelIndex?.render && reads?.attn) {
    const packed = packFromRoster(occlusion, levelIndex, args);
    if (packed) { packStats.roster++; return packed; }
    packStats.declined++;
  }
  return packDynamicsJs(occlusion, args);
}
/** How often the main frame's candidates came from the roster's pass, were declined by it, and how many binding entries the host packed
 * for it (scripts/frame-alloc-meter.mjs prints them). */
export const packStats = {roster: 0, declined: 0, hosted: 0, entries: 0};

// packFromRoster's scratches: the skipped rows, and the items' and sprites' [order, class, index] triples.
const skipRows = [];
let extraWords = new Uint32Array(3 * 256);
const nonBinding = [];
/** packDynamics for the main frame from the layer's roster: the rows (actor-mesh-sim.mjs levelPositions) hold each binding's position,
 * block and mesh record, and Rust orders the candidates and writes the bindings' words (render.rs pack_order, pack_words); the host
 * makes the entries' objects, the mesh records in the order packDynamics would, the items' and sprites' words and the words of a
 * binding whose block has no current GetAnimSeq answer. The same entries and the same words packDynamicsJs gives; null when the
 * pass cannot run (the host's packDynamics runs). `verify` runs packDynamicsJs too and throws on a difference. */
function packFromRoster(occlusion, roster, { sprites = [], iterators = null, bindings = [], items = [], reads = null, childFrames = false, pool }) {
  const render = roster.render?.();
  if (!render || roster.count !== bindings.length || roster.bindings !== bindings) return null;
  skipRows.length = 0;
  if (iterators?.size) for (const actor of iterators) {
    const binding = roster.map.get(actor);
    if (binding && binding.row >= 0) skipRows.push(binding.row);
  }
  const extraN = items.length + sprites.length;
  if (extraWords.length < 3 * extraN) extraWords = new Uint32Array(6 * extraN);
  for (let k = 0; k < items.length; k++) { extraWords[3 * k] = items[k].item.order; extraWords[3 * k + 1] = 1; extraWords[3 * k + 2] = k; }
  for (let k = 0; k < sprites.length; k++) {
    const at = 3 * (items.length + k);
    extraWords[at] = sprites[k].order; extraWords[at + 1] = 2; extraWords[at + 2] = k;
  }
  const order = render.packOrder(roster.rows, roster.count, childFrames, skipRows, extraWords, extraN);
  if (!order) return null;
  const n = order.n, entries = pool.list, arena = render.vm.arena;
  if (recordAt.length < n) recordAt = new Uint32Array(2 * n);
  const records = recordAt, stride = roster.ROW_WORDS;
  nonBinding.length = 0;
  let count = 0;
  {
    // (views of the arena for this loop only: a mesh record may grow the occlusion kernel's memory, never the arena)
    const refs = new Uint32Array(arena.memory.buffer, order.refs, n), rows = roster.u32();
    for (let i = 0; i < n; i++) {
      const ref = refs[i], index = ref & 0x1fffffff, cls = ref >>> 30;
      if (cls === 0) {
        const binding = bindings[index], at = stride * index;
        count = addEntry(entries, pool, count, rows[at + 3] * 65536, binding, null, null, (ref & 0x20000000) !== 0);
        let record = rows[at + 4];
        if (record === 0) {
          const key = binding.mesh.key;
          record = occlusion.meshRecordAt?.(key) ?? occlusion.meshRecord(key, meshRecordFields(binding.payload));
          rows[at + 4] = record;
        }
        records[i] = record;
      } else if (cls === 1) {
        const {item, binding} = items[index], key = binding.mesh.key;
        count = addEntry(entries, pool, count, item.order, binding, item, null, undefined);
        records[i] = occlusion.meshRecordAt?.(key) ?? occlusion.meshRecord(key, meshRecordFields(binding.payload));
        nonBinding.push(i);
      } else {
        count = addEntry(entries, pool, count, sprites[index].order, null, null, sprites[index], undefined);
        records[i] = 0;
        nonBinding.push(i);
      }
    }
  }
  for (let k = count; k < pool.used; k++) { const stale = pool.objects[k]; stale.binding = stale.item = stale.sprite = null; }
  pool.used = count;
  entries.length = count;
  // Mesh records before the views: a new record may grow the memory.
  render.packWords(roster.rows, order);
  const views = occlusion.setupCandidates(count), {u32, f32, i32} = views;
  const words = new Uint32Array(arena.memory.buffer);
  u32.set(words.subarray(order.words >> 2, (order.words >> 2) + SETUP.WORDS * count), views.at);
  for (let k = 0; k < nonBinding.length; k++) {
    const i = nonBinding[k], e = entries[i], at = views.at + SETUP.WORDS * i;
    if (e.binding) {
      e.binding.packSetup(views, at, i, records[i], reads, e.item);
      u32[at + SETUP.FLAGS] = 0;
    } else packSprite(views, at, i, e.sprite);
  }
  const host = new Uint32Array(arena.memory.buffer, order.host, 1 + count), hosted = host[0];
  packStats.hosted += hosted; packStats.entries += count;
  for (let k = 0; k < hosted; k++) {
    const i = host[1 + k], e = entries[i], at = views.at + SETUP.WORDS * i;
    e.binding.packSetup(views, at, i, records[i], reads, null);
    u32[at + SETUP.FLAGS] = e.rootExcluded ? SETUP_ROOT_EXCLUDED : 0;
  }
  if (roster.verify) verifyRosterPack(occlusion, entries, count, views, arguments[2]);
  return entries;
}

/** ACTOR_PLUMBING=verify: packDynamicsJs on the same arguments gives these entries and these words. */
function verifyRosterPack(occlusion, entries, count, views, args) {
  const made = entries.slice(0, count).map(e => [e.order, e.binding, e.item, e.sprite, e.rootExcluded]);
  const wordsMade = views.u32.slice(views.at, views.at + SETUP.WORDS * count);
  const reference = packDynamicsJs(occlusion, args);
  const fail = message => { throw new Error(`ACTOR_PLUMBING=verify: roster pack: ${message}`); };
  if (reference.length !== count) fail(`${count} entries, the reference ${reference.length}`);
  const again = occlusion.setupCandidates(count);
  for (let i = 0; i < count; i++) {
    const e = reference[i], m = made[i];
    if (e.order !== m[0] || e.binding !== m[1] || e.item !== m[2] || e.sprite !== m[3] || e.rootExcluded !== m[4]) fail(`entry ${i} differs`);
    for (let k = 0; k < SETUP.WORDS; k++)
      if (again.u32[again.at + SETUP.WORDS * i + k] !== wordsMade[SETUP.WORDS * i + k]) fail(`entry ${i} word ${k} is ${wordsMade[SETUP.WORDS * i + k]}, the reference ${again.u32[again.at + SETUP.WORDS * i + k]}`);
  }
}

function packDynamicsJs(occlusion, { sprites = [], iterators = null, bindings = [], items = [], reads = null,
  levelIndex = null, childFrames = false, pool = null }) {
  const entries = pool === null ? [] : pool.list;
  let count = 0;
  // `levelIndex`: a Map from actor to its Level.Actors index, or the actor mesh layer's roster (actor-mesh-sim.mjs levelPositions): its
  // rows, in the order of `bindings`, hold the index in their fourth word (NO_POS for none)
  const rows = levelIndex?.u32 && levelIndex.bindings === bindings ? levelIndex.u32() : null, none = levelIndex?.NO_POS, stride = levelIndex?.ROW_WORDS;
  for (let b = 0; b < bindings.length; b++) {
    const binding = bindings[b];
    if (iterators?.has(binding.actor)) continue;
    const index = rows ? rows[stride * b + 3] : levelIndex?.get(binding.actor);
    if (index === undefined || index === none) continue;
    if (binding.admitted(reads)) count = addEntry(entries, pool, count, index * 65536, binding, null, null, false);
    else if (childFrames && binding.childAdmitted?.(reads)) count = addEntry(entries, pool, count, index * 65536, binding, null, null, true);
  }
  for (let k = 0; k < items.length; k++) count = addEntry(entries, pool, count, items[k].item.order, items[k].binding, items[k].item, null, undefined);
  for (let k = 0; k < sprites.length; k++) count = addEntry(entries, pool, count, sprites[k].order, null, null, sprites[k], undefined);
  if (pool !== null) {
    for (let k = count; k < pool.used; k++) { const stale = pool.objects[k]; stale.binding = stale.item = stale.sprite = null; }
    pool.used = count;
    entries.length = count;
    stableSortByOrder(entries, count, pool.sorted);
  } else entries.sort(byOrder);
  // Mesh records before the views: a new record may grow the memory. A mesh's record is made once (meshRecord keeps it by key), so
  // its fields are read from the payload only for a key not seen.
  if (recordAt.length < entries.length) recordAt = new Uint32Array(2 * entries.length);
  const records = recordAt;
  for (let i = 0; i < entries.length; i++) {
    const binding = entries[i].binding;
    if (!binding) { records[i] = 0; continue; }
    const key = binding.mesh.key;
    records[i] = occlusion.meshRecordAt?.(key) ?? occlusion.meshRecord(key, meshRecordFields(binding.payload));
  }
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

// One entry of packDynamics: a new object, or the pool's next one with its fields set.
function addEntry(entries, pool, count, order, binding, item, sprite, rootExcluded) {
  if (pool === null) { entries.push({ order, binding, item, sprite, rootExcluded }); return count; }
  let entry = pool.objects[count];
  if (entry === undefined) pool.objects[count] = entry = { order, binding, item, sprite, rootExcluded };
  else { entry.order = order; entry.binding = binding; entry.item = item; entry.sprite = sprite; entry.rootExcluded = rootExcluded; }
  entries[count] = entry;
  return count + 1;
}

/** Array.prototype.sort(byOrder) of the first `count` entries (stable, so equal orders keep their places) by a bottom-up merge in a
 * scratch array: the built-in sort makes working arrays of its own at each call. */
function stableSortByOrder(entries, count, scratch) {
  if (count < 2) return;
  scratch.length = count;
  let from = entries, to = scratch;
  for (let width = 1; width < count; width *= 2) {
    for (let low = 0; low < count; low += 2 * width) {
      const middle = Math.min(low + width, count), high = Math.min(low + 2 * width, count);
      let a = low, b = middle, out = low;
      while (a < middle && b < high) to[out++] = from[b].order < from[a].order ? from[b++] : from[a++];
      while (a < middle) to[out++] = from[a++];
      while (b < high) to[out++] = from[b++];
    }
    const swap = from; from = to; to = swap;
  }
  if (from !== entries) for (let k = 0; k < count; k++) entries[k] = from[k];
  scratch.fill(null, 0, count);
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
    // A frame's item that differs from the root's has a binding of its own (actor-mesh-sim.mjs
    // itemCandidates), with the same mesh record: its candidate is packed from its own item.
    if (root.order !== mine.order || (root.binding !== mine.binding && root.binding?.mesh?.key !== mine.binding?.mesh?.key)
      || Boolean(root.item) !== Boolean(mine.item)) return null;
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
