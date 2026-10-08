import test from 'node:test';
import assert from 'node:assert/strict';
import {childFrameSprites, iteratorSpritesByOrder, sameSprite, packDynamics, patchDynamics, candidateWords} from '../src/viewer/dynamics-candidates.mjs';
import {SETUP} from '../src/runtime/bsp-occlusion.mjs';

// A sprite record as sprite-scan.mjs makes it.
const record = (order, extra = {}) => ({handle: 7, order, texture: {key: 'k', package: 'p', index: 3}, style: 3,
  location: [1, 2, 3], drawScale: 0.5, scaleGlow: 1, ...extra});

test('a child frame keeps the root\'s plain sprites and shares equal iterator records', () => {
  const plain = record(65536, {handle: 1});
  const items = [record(131072, {viaIterator: true}), record(131073, {viaIterator: true})];
  const root = [plain, ...items];
  const known = iteratorSpritesByOrder(root), made = [];
  const again = [record(131072, {viaIterator: true}), record(131073, {viaIterator: true})];
  const {sprites, added} = childFrameSprites(root, again, known, r => made.push(r));
  assert.deepEqual(sprites, [plain, ...items]);
  assert.equal(sprites[1], items[0], 'the root\'s own record, not a copy');
  assert.deepEqual([added, made], [[], []]);
});

test('a different item is a record of its own, shared by later frames that equal it', () => {
  const items = [record(10, {viaIterator: true}), record(11, {viaIterator: true})];
  const known = iteratorSpritesByOrder(items), made = [];
  const moved = record(11, {viaIterator: true, location: [1, 2, 4]});
  const first = childFrameSprites(items, [record(10, {viaIterator: true}), moved], known, r => { r.childOnly = true; made.push(r); });
  assert.equal(first.sprites[0], items[0]);
  assert.equal(first.sprites[1], moved);
  assert.deepEqual(first.added, [moved]);
  assert.ok(moved.childOnly);
  // A later frame with the same moved item shares it; a third place makes another.
  const later = childFrameSprites(items, [record(10, {viaIterator: true}), record(11, {viaIterator: true, location: [1, 2, 4]})], known, r => made.push(r));
  assert.equal(later.sprites[1], moved);
  assert.deepEqual(later.added, []);
  const other = record(11, {viaIterator: true, location: [9, 9, 9]});
  assert.deepEqual(childFrameSprites(items, [other], known, r => made.push(r)).added, [other]);
  assert.equal(made.length, 2);
});

test('a frame\'s item count may change: records are matched by order, not by position', () => {
  const items = [record(5, {viaIterator: true}), record(6, {viaIterator: true}), record(7, {viaIterator: true})];
  const known = iteratorSpritesByOrder(items);
  const {sprites} = childFrameSprites(items, [record(5, {viaIterator: true}), record(7, {viaIterator: true})], known, () => {});
  assert.deepEqual(sprites, [items[0], items[2]]);
});

test('records equal only in every drawn field, NaN-safe on the place', () => {
  assert.ok(sameSprite(record(1, {location: [NaN, 0, 0]}), record(1, {location: [NaN, 0, 0]})));
  for (const change of [{handle: 8}, {style: 4}, {drawScale: 1}, {scaleGlow: 0.5}, {location: [1, 2, 3.5]}, {texture: {key: 'k', package: 'p', index: 4}}])
    assert.ok(!sameSprite(record(1), record(1, change)), JSON.stringify(change));
});

// ---- patchDynamics ----

function fakeOcclusion() {
  const u32 = new Uint32Array(1 << 14), f32 = new Float32Array(u32.buffer), i32 = new Int32Array(u32.buffer);
  return {views: {u32, f32, i32, at: 16}, setupCandidates() { return this.views; }, meshRecord: key => 1000 + key};
}
const payload = {boundingBox: {min: [0, 0, 0], max: [1, 1, 1], valid: true}, arrays: new Map([[0xa8, {data: new Uint8Array(0)}]]),
  scale: [1, 1, 1], origin: [0, 0, 0], rotation: [0, 0, 0]};
// A binding that packs its place and item into the candidate's words.
const binding = (id, place) => ({id, actor: {id}, mesh: {key: id}, payload, admitted: () => true,
  packSetup({u32, f32}, at, key, record, reads, item) {
    u32[at + SETUP.KEY] = key; u32[at + SETUP.MESH] = record;
    const location = item ? item.location : place;
    for (let k = 0; k < 3; k++) f32[at + SETUP.LOCATION + k] = location[k];
    for (const word of [SETUP.DRAWTYPE, SETUP.TEXTURE, SETUP.USIZE, SETUP.VSIZE, SETUP.ROTATION, SETUP.DRAWSCALE, SETUP.PREPIVOT,
      SETUP.PARTICLES, SETUP.SEQ, SETUP.SEQ_START, SETUP.SEQ_FRAMES, SETUP.ANIMFRAME]) u32[at + word] = item ? 7 : 5;
  }});

test('patching the iterator-made candidates equals packing the frame from scratch', () => {
  const plain = [binding(1, [1, 0, 0]), binding(2, [2, 0, 0])], slot = binding(3, [0, 0, 0]);
  const levelIndex = new Map([[plain[0].actor, 1], [plain[1].actor, 3]]);
  const spriteAt = (order, x) => ({...record(order, {viaIterator: true, location: [x, 0, 0]}), size: [16, 16]});
  const rootItems = [{item: {order: 2 * 65536, location: [10, 0, 0]}, binding: slot}, {item: {order: 2 * 65536 + 1, location: [11, 0, 0]}, binding: slot}];
  const rootSprites = [spriteAt(4 * 65536, 20), {...record(5 * 65536 + 9), size: [8, 8]}];
  const common = {bindings: plain, levelIndex, iterators: new Set()};
  const occlusion = fakeOcclusion();
  const rootEntries = packDynamics(occlusion, {...common, sprites: rootSprites, items: rootItems});
  const rootWords = candidateWords(occlusion, rootEntries.length);
  // The same orders with other items (a laser's last item elsewhere, a moved sprite).
  const items = [{item: {order: 2 * 65536, location: [10, 0, 0]}, binding: slot}, {item: {order: 2 * 65536 + 1, location: [12, 5, 0]}, binding: slot}];
  const sprites = [spriteAt(4 * 65536, 21), rootSprites[1]];
  const patched = patchDynamics(occlusion, rootEntries, rootWords, {items, sprites});
  assert.ok(patched);
  const patchedWords = occlusion.views.u32.slice(16, 16 + SETUP.WORDS * patched.length);
  const fresh = packDynamics(occlusion, {...common, sprites, items});
  const freshWords = occlusion.views.u32.slice(16, 16 + SETUP.WORDS * fresh.length);
  assert.deepEqual(patched.map(e => e.order), fresh.map(e => e.order));
  assert.deepEqual(patched.map(e => e.item ?? e.sprite ?? e.binding), fresh.map(e => e.item ?? e.sprite ?? e.binding));
  assert.deepEqual([...patchedWords], [...freshWords]);
});

test('patching is declined when the iterator-made candidates are not where the root\'s were', () => {
  const slot = binding(3, [0, 0, 0]);
  const occlusion = fakeOcclusion();
  const rootItems = [{item: {order: 100, location: [1, 0, 0]}, binding: slot}, {item: {order: 101, location: [2, 0, 0]}, binding: slot}];
  const rootEntries = packDynamics(occlusion, {bindings: [], levelIndex: new Map(), iterators: new Set(), sprites: [], items: rootItems});
  const words = candidateWords(occlusion, rootEntries.length);
  // One item fewer, an item at another order, another binding, a sprite for an item.
  assert.equal(patchDynamics(occlusion, rootEntries, words, {items: rootItems.slice(0, 1), sprites: []}), null);
  assert.equal(patchDynamics(occlusion, rootEntries, words, {items: [rootItems[0], {item: {order: 102, location: [2, 0, 0]}, binding: slot}], sprites: []}), null);
  assert.equal(patchDynamics(occlusion, rootEntries, words, {items: [rootItems[0], {item: rootItems[1].item, binding: binding(4, [0, 0, 0])}], sprites: []}), null);
  assert.equal(patchDynamics(occlusion, rootEntries, words, {items: [rootItems[0]], sprites: [{...record(101, {viaIterator: true}), size: [4, 4]}]}), null);
  assert.ok(patchDynamics(occlusion, rootEntries, words, {items: rootItems, sprites: []}));
});
