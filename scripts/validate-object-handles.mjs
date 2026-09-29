#!/usr/bin/env node
/**
 * R1a of docs/rust-core.md: object and class pointers in live object images
 * hold handles that name the identity the property holds.
 *
 * Training boots and runs three seconds of Level time. Then, for every object
 * in the live registry (GObjObjects) and every Level actor with an image,
 * each object or class pointer, struct members and fixed-array elements
 * included, must satisfy identityOfHandle(bytes) === the reference array's
 * value (None is zero). validate-object-image checks the class defaults and
 * direct writes; validate-loadmap-gc checks that handles end with their
 * objects. This checks the paths between: map-authored values, snapshots,
 * resets, spawns, the collection's reference clearing and script writes.
 */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {handleSlots} from '../src/runtime/script-object-image.mjs';
import {identityOfHandle, liveHandleCount} from '../src/runtime/script-object-handles.mjs';
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

const slotCache = new Map();
let objects = 0, pointers = 0, nonNull = 0;
for (const identity of identities) {
  let instance;
  try { instance = runtime.instance(identity); } catch { continue; }
  if (!instance.base || !instance.cells) continue;
  let slots = slotCache.get(instance.cells);
  if (!slots) slotCache.set(instance.cells, slots = handleSlots(instance.cells));
  const view = instance.arena.view;
  for (const [offset, ref] of slots) {
    const expected = instance.refs[ref] ?? null;
    const handle = view.getUint32(instance.base + offset, true);
    assert.equal(identityOfHandle(handle), expected,
      `${identity.name ?? identity.key} pointer at +0x${offset.toString(16)} names its reference`);
    assert.equal(handle === 0, expected === null, `${identity.name ?? identity.key} +0x${offset.toString(16)}: None is zero`);
    pointers++;
    if (expected !== null) nonNull++;
  }
  objects++;
}
assert.ok(objects > 400 && nonNull > 2000, `the scan reached the level (${objects} objects, ${nonNull} pointers)`);
console.log(`validate-object-handles: ${objects} live objects, ${pointers} pointers (${nonNull} non-None) name their ` +
  `references after 180 Training ticks; ${liveHandleCount()} live handles: ok`);
