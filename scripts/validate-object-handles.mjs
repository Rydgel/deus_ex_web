#!/usr/bin/env node
/**
 * R1a and R1a-2 of docs/rust-core.md: an object or class pointer in an object
 * image is a handle in its four bytes, and those bytes are its only storage.
 *
 * Training boots and runs three seconds of Level time. Then, for every object
 * in the live registry (GObjObjects) and every Level actor with an image, and
 * for the class default image each was built from:
 *
 * 1. Each object or class pointer, struct members and fixed-array elements
 *    included, holds 0 (None) or a live handle. A released handle would read
 *    as None, where the reference it replaced still named the freed object;
 *    a handle the table never issued would be a stray write.
 * 2. Each property read through its cell (the storage beneath any host
 *    binding) names exactly the identities the byte walk names, so composite
 *    reads and handleSlots agree on every offset.
 * 3. The reference array holds no pointer: only names, strings and dynamic
 *    arrays.
 *
 * validate-object-image checks the class defaults and direct writes against
 * the value codec; validate-loadmap-gc checks that handles end with their
 * objects. This checks the paths between: map-authored values, snapshots,
 * resets, spawns, the collection's reference clearing and script writes.
 */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {handleSlots, scalarCell, isFixedCell} from '../src/runtime/script-object-image.mjs';
import {identityOfHandle, handleState, liveHandleCount} from '../src/runtime/script-object-handles.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime;
for (let frame = 0; frame < 180; frame++) game.tick(1 / 60);

const level = runtime.levelFor(game.player.collisionActor);
const registry = runtime.actorLifecycle.construction.registry;
const identities = new Set(level.actors.filter(Boolean));
for (const object of registry.objects) if (object?.identity && !object.released) identities.add(object.identity);

// The pointers of one logical value, in handleSlots order.
function pointers(cell, value, out) {
  if (scalarCell(cell)?.kind === 'object') out.push(value);
  else if (isFixedCell(cell)) for (let index = 0; index < cell.dim; index++) pointers(cell.element, value[index], out);
  else if (cell.members) for (const member of cell.members) pointers(member, value[member.key], out);
  return out;
}
const slotCache = new Map();
const slotsOf = (key, cell) => {
  let slots = slotCache.get(cell);
  if (!slots) slotCache.set(cell, slots = handleSlots(new Map([[key, cell]])));
  return slots;
};
const label = identity => String(identity?.name ?? identity?.key ?? identity?.record?.key ?? '?');

// 1. Every pointer slot of an image holds None or a live handle.
function checkSlots(what, cells, view, base) {
  let slots = 0, nonNull = 0;
  for (const [key, cell] of cells) for (const offset of slotsOf(key, cell)) {
    const handle = view.getUint32(base + offset, true), state = handleState(handle);
    assert.ok(state === 'none' || state === 'live', `${what} ${key} at +0x${offset.toString(16)}: handle ${handle} is ${state}`);
    slots++;
    if (handle) nonNull++;
  }
  return {slots, nonNull};
}

let objects = 0, pointerCount = 0, nonNull = 0, reads = 0, refValues = 0;
const classes = new Set();
for (const identity of identities) {
  let instance;
  try { instance = runtime.instance(identity); } catch { continue; }
  if (!instance.base || !instance.cells) continue;
  const view = instance.arena.view, name = label(identity);
  const counted = checkSlots(name, instance.cells, view, instance.base);
  pointerCount += counted.slots;
  nonNull += counted.nonNull;
  classes.add(instance.cls);

  // 2. Cell reads name what the bytes name.
  const fields = instance.imageSource.layout.fields;
  for (const [key, cell] of instance.cells) {
    const slots = slotsOf(key, cell);
    if (!slots.length || instance.poison?.has(key)) continue;
    const named = pointers(cell, runtime.readStoredField(identity, fields.get(key)), []);
    assert.ok(named.length === slots.length, `${name} ${key}: ${named.length} pointers read, ${slots.length} slots`);
    for (let index = 0; index < slots.length; index++) {
      const expected = identityOfHandle(view.getUint32(instance.base + slots[index], true));
      assert.ok(named[index] === expected, `${name} ${key} pointer ${index} at +0x${slots[index].toString(16)} reads its handle`);
    }
    reads++;
  }

  // 3. No pointer in the reference array.
  for (const value of instance.refs ?? []) {
    assert.ok(value == null || typeof value === 'string' || Array.isArray(value),
      `${name}: reference array holds a ${typeof value}`);
    refValues++;
  }
  objects++;
}

// 1, for the current default images of the live objects' classes.
let defaultPointers = 0;
for (const cls of classes) {
  const source = runtime.classImage(cls);
  defaultPointers += checkSlots(`${cls.record.key} default`, source.layout.cells, source.arena.view, source.base).slots;
}

assert.ok(objects > 400 && nonNull > 2000, `the scan reached the level (${objects} objects, ${nonNull} pointers)`);
console.log(`validate-object-handles: after 180 Training ticks, ${objects} live objects hold ${pointerCount} pointers ` +
  `(${nonNull} non-None) and their ${classes.size} class default images ${defaultPointers}, all None or live handles; ` +
  `${reads} pointer properties read their handles; ${refValues} reference-array values, no pointers; ` +
  `${liveHandleCount()} live handles: ok`);
