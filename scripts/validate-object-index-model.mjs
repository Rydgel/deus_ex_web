/** Validate the general global-UObject-index model against the live 00_Training
 * GObjObjects capture (.cache/original-gobjects.txt, read from the running game
 * by tools/dump-gobjects-win.c). Plan A wired one measured index (LightSwitch0);
 * Plan B is the model that produces indices the load-time capture cannot cover on
 * its own -- runtime spawns -- by continuing the recovered Core AddObject rule
 * from the measured registry state. Model and evidence: docs/boot-replay.md,
 * docs/script-object-release.md, docs/script-sound.md.
 *
 * This checks three things purely from the capture (no game install needed):
 *  1. the capture is a valid AddObject state (dense from 0 with exactly the
 *     freed holes, nothing at or above the high-water count);
 *  2. seeding a ScriptObjectRegistry at that measured state and allocating
 *     forward reproduces the reused hole then the appended tail, landing only on
 *     slots the capture left free;
 *  3. the capture's own tail is runtime spawns (the highest slots because they
 *     were appended last), while pre-placed map actors sit far below -- the
 *     construction-order evidence that disproves N0 + exportIndex.
 */
import assert from 'node:assert/strict';
import { loadOriginalGObjects } from './original-gobjects.mjs';
import { seedScriptObjectRegistry } from '../src/runtime/script-object-construction.mjs';

const capture = await loadOriginalGObjects('.cache/original-gobjects.txt');
const present = new Set(capture.rows.map(row => row.index));
const maxIndex = Math.max(...present);

// -- 1. The capture is a valid AddObject registry state ----------------------
// GObjObjects is dense from 0 to the high-water mark, with the freed slots (on
// GObjAvailable) as its only holes and nothing at or beyond the count.
assert.equal(capture.count, 42167);                 // Core.dll +0x19e62c high-water
assert.deepEqual(capture.freeIndices, [42156]);      // exactly one freed slot in this state
assert.equal(maxIndex, capture.count - 1);           // no live object at/above the count
assert.equal(capture.rows.length + capture.freeIndices.length, capture.count);
for (const hole of capture.freeIndices) assert.equal(present.has(hole), false);
// Every index below the high-water mark is either occupied or a known free slot.
for (let i = 0; i < capture.count; i++)
  assert.ok(present.has(i) || capture.freeIndices.includes(i), `index ${i} is neither occupied nor free`);

// -- 2. Forward model: reuse the hole LIFO, then append into virgin slots -----
const registry = seedScriptObjectRegistry({ count: capture.count, freeIndices: capture.freeIndices });
const object = (nameIndex) => ({ index: -1, nameIndex, outer: null, hashNext: null });
const spawned = [registry.add(object(1))];             // reuses 42156 (the freed slot)
for (let i = 0; i < 3; i++) spawned.push(registry.add(object(2 + i)));
assert.deepEqual(spawned, [42156, 42167, 42168, 42169]);
// The reused slot was the capture's hole; the appended slots are all above the
// measured high-water mark, so the model never collides with a captured object.
assert.equal(present.has(42156), false);
for (const index of spawned.slice(1)) assert.ok(index >= capture.count && !present.has(index));

// -- 3. Construction-order evidence: the tail is runtime spawns ---------------
const byIndex = new Map(capture.rows.map(row => [row.index, row.key]));
const tail = [];
for (let i = capture.count - 1; i >= capture.count - 11; i--) if (byIndex.has(i)) tail.push(byIndex.get(i));
// The highest live slots are transient runtime objects (garbage records, AI
// receiver events, a carcass) -- created last, so numbered highest.
assert.ok(tail.every(key => /^(GC|AIReceiverEvent|FlagBool|UNATCOTroopCarcass)\./.test(key)),
  `unexpected tail objects: ${tail.join(', ')}`);
assert.ok(tail.some(key => key.startsWith('UNATCOTroopCarcass.')), 'a runtime-spawned carcass tops the registry');

// A pre-placed map actor (LightSwitch0) is measured far below the runtime tail,
// interleaved with its class load rather than in an N0 + exportIndex block.
const switchIndex = capture.indexFor('LightSwitch', 'LightSwitch0');
assert.equal(switchIndex, 34242);
assert.ok(switchIndex < capture.count - 100, 'the pre-placed switch sits below the runtime-spawn tail');

// The provider never guesses: a non-unique reflection key (Function.Tick occurs
// per class) resolves to null so a spawn falls through to its modeled slot.
assert.equal(capture.indexFor('Function', 'Tick'), null);

// -- Sound-path input: both index sources feed the same channel-id formula ----
// PlaySound forms its channel id as (Index << 4) + (Slot << 1) + bNoOverride
// (docs/script-sound.md; the formula itself is validated in
// test/script-sound.test.mjs). Plan B supplies the Index for both a pre-placed
// actor (measured) and a runtime spawn (modeled).
const channelId = (index, slot, noOverride) => ((index << 4) + (slot << 1) + noOverride) | 0;
assert.equal(channelId(switchIndex, 1, 0), 547874);      // LightSwitch0, slot 1 (matches validate-script-lights)
assert.equal(channelId(spawned[1], 1, 0), (42167 << 4) + 2); // a modeled spawn on slot 1

console.log(`Global-index model validated against the live capture: count ${capture.count}, ` +
  `freed slots ${JSON.stringify(capture.freeIndices)}; the seeded registry reused ${spawned[0]} then ` +
  `appended ${spawned.slice(1).join(', ')} into free slots. Runtime-spawn tail: ${tail.slice(0, 4).join(', ')}...; ` +
  `pre-placed LightSwitch0 measured at ${switchIndex}. Channel id from a measured index: 547874.`);
