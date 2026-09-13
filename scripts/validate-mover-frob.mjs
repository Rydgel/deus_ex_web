/** Original DeusExMover.Frob in live Training Play.
 *
 * Checks that using a door is decided by the original body and not by a host
 * substitute: the bFrobbable gate, the bLocked branch with its localized
 * ClientMessage, the empty-hand branch, and the Tag fanout through native
 * AllActors(class'DeusExMover', Tag). See docs/script-mover-frob.md. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1 });
const runtime = game.doors.scriptRuntime.runtime;
const byName = new Map(game.collision.movers.map(mover => [mover.name, mover]));
const ref = (actor, field) => runtime.namedReference(actor, field).get();
const use = mover => game.doors.use({ ...game.doors.describe(mover), mover }, game.player.position);
const tick = seconds => { for (let frame = 0; frame < Math.round(seconds * 120); frame++) game.tick(1 / 120, {}); };

// The body is the prepared original, not a host reimplementation.
const frobRecord = runtime.lookup(byName.get('DeusExMover16'), 'Frob');
assert.equal(frobRecord.key, 'deusex.deusexmover.frob',
  'a door frob resolves to the original DeusExMover.Frob, not the empty Actor.Frob');
assert.ok(frobRecord.function, 'DeusExMover.Frob is prepared');

// Training's authored door state, read through the runtime's typed properties.
const authored = [
  ['DeusExMover16', 'UN_maindoor', true, false], ['DeusExMover17', 'UN_maindoor', true, false],
  ['DeusExMover19', 'darkdoor', true, false], ['DeusExMover20', 'darkdoor', true, false],
  ['DeusExMover45', 'gundoor', true, true], ['DeusExMover46', 'gundoor', true, true],
  ['DeusExMover47', 'keydoor', true, true], ['DeusExMover48', 'keydoor', true, true],
  ['DeusExMover50', 'MedDoor', true, true],
  ['DeusExMover26', 'paddoor', false, true], ['DeusExMover18', 'paddoor', false, true],
  ['DeusExMover37', 'hackdoor', false, true], ['DeusExMover38', 'hackdoor', false, true],
];
for (const [name, tag, frobbable, locked] of authored) {
  const mover = byName.get(name);
  assert.ok(mover, `${name} is a live Training mover`);
  assert.equal(ref(mover, 'Tag'), tag);
  assert.equal(ref(mover, 'bFrobbable'), frobbable, `${name} bFrobbable`);
  assert.equal(ref(mover, 'bLocked'), locked, `${name} bLocked`);
  assert.equal(ref(mover, 'bOneWay'), false);
  assert.equal(ref(mover, 'bSlave'), false);
  assert.equal(ref(mover, 'KeyNum'), 0, `${name} starts closed, so the KeyNum/PrevKeyNum branch is not taken`);
  assert.equal(ref(mover, 'PrevKeyNum'), 0);
}

// A locked door refuses and reports the class's own localized msgLocked. The
// original delivers it through Player.Console; that presentation is Stage 4, so
// the recorded string is what the bytecode selected.
for (const name of ['DeusExMover45', 'DeusExMover47', 'DeusExMover50']) {
  const mover = byName.get(name);
  const before = mover.interpolation.key;
  const outcome = use(mover);
  assert.deepEqual(outcome, { ok: false, message: ref(mover, 'msgLocked'), actors: [] },
    `${name} takes the original locked branch`);
  assert.equal(outcome.message, "It's locked");
  assert.equal(mover.interpolation.key, before, `${name} is not retargeted`);
  assert.equal(mover.target, 0);
}

// A non-frobbable door returns before the body assigns any message.
for (const name of ['DeusExMover26', 'DeusExMover37']) {
  const outcome = use(byName.get(name));
  assert.deepEqual(outcome, { ok: false, message: '', actors: [] },
    `${name} returns at the original !bFrobbable gate with no message`);
}

// An unlocked door with an empty hand takes `else if (!bLocked)`, triggers
// itself, and fans out to its like-tagged partner through native AllActors.
const createIterator = runtime.createIterator.bind(runtime);
const iterations = [];
runtime.createIterator = call => {
  const iterator = createIterator(call), record = { native: call.index, next: 0, matches: 0 };
  iterations.push(record);
  return { next() { record.next++; const found = iterator.next(); if (found) record.matches++; return found; } };
};
const opened = use(byName.get('DeusExMover16'));
assert.deepEqual(opened.actors, ['DeusExMover16', 'DeusExMover17'],
  'the original Tag fanout triggers both UN_maindoor panels');
assert.equal(opened.ok, true);
assert.deepEqual(iterations, [{ native: 304, next: 3, matches: 2 }],
  'Frob runs exactly one AllActors pass, matching both like-tagged DeusExMovers');
runtime.createIterator = createIterator;
tick(2.1);
assert.deepEqual(['DeusExMover16', 'DeusExMover17'].map(name => byName.get(name).interpolation.key), [1, 1],
  'both panels reached their open key');

// `Tag == 'DeusExMover'` is the original's own fanout exclusion, so the two
// class-default-tagged movers are never reached by a like-tagged frob.
assert.deepEqual(['DeusExMover49', 'DeusExMover32'].map(name => ref(byName.get(name), 'Tag')),
  ['DeusExMover', 'DeusExMover']);

// Frobbing an open door closes it through the same body and fanout.
const closed = use(byName.get('DeusExMover16'));
assert.deepEqual(closed.actors, ['DeusExMover16', 'DeusExMover17']);
tick(2.1);
assert.deepEqual(['DeusExMover16', 'DeusExMover17'].map(name => byName.get(name).interpolation.key), [0, 0]);

game.reset();
assert.equal(game.doors.uses, 0);
console.log('Original DeusExMover.Frob passed in live Training Play: prepared body, authored door state, ' +
  'locked branch with its localized ClientMessage, !bFrobbable early return, and the AllActors Tag fanout ' +
  'opening and closing both UN_maindoor panels.');
