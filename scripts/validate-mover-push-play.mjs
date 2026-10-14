/** A moving brush meeting a non-Pawn actor in live Play (docs/mover-push.md).
 *
 * The original CheckEncroachment (Engine.dll 0x1039a350) pushes every
 * blocking non-Brush hit with AActor::moveSmooth (0x1039a577, 0x1039a75d),
 * Pawn or not. Play paused with "Unsupported blocking non-Pawn mover push"
 * for the first non-Pawn it met.
 *
 * Part A, 10_Paris_Club: JC frobs the grill at the bottom of the toilet wall
 * (DeusExMover4, a pure roll about its top edge, ME_IgnoreWhenEncroach) and
 * the panel swings through the toilet (Toilet0, a Toilet2 decoration). The
 * push vector of a roll-only move is zero: the toilet does not move,
 * Mover.EncroachingOn crushes it with 10000 'Crushed' damage, which its
 * bInvincible refuses, and returns false for ME_IgnoreWhenEncroach; the
 * grill opens fully. validate-native-mover-push.mjs runs the same
 * CheckEncroachment in the original for this geometry (paris-grill scene).
 *
 * Part B, 00_Training: UN_maindoor's leaf (DeusExMover16) closes on an
 * Ammo10mm2 placed at its -Y edge against the frame. Recorded pushes of this
 * run (scripts/mover-push-play-door.mjs) end where the original's
 * CheckEncroachment ends them: validate-native-mover-push.mjs fails unless
 * the original reaches the same positions (play-door scene). */
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';
import {createPlayerInputFixture} from './player-input-fixture.mjs';
import {AMMO, GROUPS} from './mover-push-play-door.mjs';

const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory)))
    files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
const assets = new AssetStore(files);
const boot = async name => {
  const asset = await assets.get(name);
  const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1});
  const runtime = game.doors.scriptRuntime.runtime;
  return {game, runtime, level: runtime.levelFor(game.player.collisionActor),
    read: (actor, field) => runtime.readNamed(actor, field), tick: () => game.tick(1 / 120, {})};
};
const bits = actor => new Float32Array(actor.position).join();

// ---- Part A: the Paris club toilet grill ------------------------------------
{
  const {game, runtime, level, read, tick} = await boot('10_Paris_Club');
  const grill = game.collision.movers.find(m => m.name === 'DeusExMover4');
  const toilet = level.actors.find(a => a?.name === 'Toilet0');
  assert.ok(grill && toilet, 'DeusExMover4 and Toilet0 are in the club');
  assert.equal(read(grill, 'MoverEncroachType'), 3, 'the grill is ME_IgnoreWhenEncroach');
  assert.equal(read(grill, 'NumKeys'), 2);
  assert.deepEqual(read(grill, 'KeyPos')[1], [0, 0, 0], 'KeyPos[1] is the base position: a roll, not a translation');
  assert.deepEqual(read(grill, 'KeyRot')[1], [0, 0, -16384], 'KeyRot[1] rolls the panel a quarter turn');
  assert.equal(runtime.instance(toilet).cls.record.name, 'Toilet2');
  assert.ok(toilet.lineage.includes('engine.decoration') && !toilet.lineage.includes('engine.pawn'), 'a non-Pawn decoration');
  assert.equal(toilet.flags & 0xf, 0xf, 'bCollideActors, bCollideWorld, bBlockActors and bBlockPlayers');
  assert.equal(read(toilet, 'bInvincible'), true);
  const hitPoints = read(toilet, 'HitPoints'), start = bits(toilet);

  const pushes = [], events = [];
  const moveSmoothActor = runtime.moveSmoothActor?.bind(runtime);   // absent before the fix: the run then pauses, which is what fails below
  if (moveSmoothActor) runtime.moveSmoothActor = (actor, delta) => { pushes.push({actor: actor.name, delta: [...delta]}); return moveSmoothActor(actor, delta); };
  const processEvent = runtime.processEvent.bind(runtime);
  runtime.processEvent = (receiver, name, ...rest) => {
    // JC stands in the swing too and is pushed by the player's own recovered path; the toilet's events are filtered by argument.
    if ((receiver === grill && name === 'EncroachingOn' && rest[0]?.[0] === toilet) || (receiver === toilet && name === 'EncroachedBy'))
      events.push({receiver: receiver.name, name: String(name), roll: read(grill, 'Rotation')[2]});
    return processEvent(receiver, name, ...rest);
  };

  for (let i = 0; i < 120; i++) tick();
  const input = createPlayerInputFixture(game);
  // JC stands in the stall beside the grill, looking at its lower half. The
  // swing reaches him as well as the toilet (the Pawn path, which already
  // existed); a roll leaves the mover's Location unchanged, so neither is
  // displaced.
  input.aim(grill, {position: [-1680, -1425, -160], point: [-1706, -1425, -184]});
  assert.equal(game.interaction.frobTarget, grill, 'the view trace selects the grill');
  const jc = [...game.player.position];
  let jcContacts = 0;
  const countJc = runtime.processEvent;
  runtime.processEvent = (receiver, name, ...rest) => {
    if (receiver === grill && name === 'EncroachingOn' && rest[0]?.[0] === game.player.collisionActor) jcContacts++;
    return countJc(receiver, name, ...rest);
  };
  assert.deepEqual(game.use(), {ok: true, message: ''}, 'ParseRightClick frobs the grill (DeusExMover.Frob)');

  let error = null, ticks = 0;
  for (; ticks < 1200; ticks++) {
    try { tick(); } catch (e) { error = String(e?.message ?? e).split('\n')[0]; break; }
    if (read(grill, 'KeyNum') === 1 && !read(grill, 'bInterpolating')) break;
  }
  assert.equal(error, null, 'opening the grill does not pause Play');
  assert.equal(read(grill, 'KeyNum'), 1, 'the grill reached its open key');
  assert.deepEqual(read(grill, 'Rotation').map(v => v | 0), [0, -16384, -16384], 'BaseRot + KeyRot[1]');

  const crushed = events.filter(e => e.receiver === 'DeusExMover4'), encroached = events.filter(e => e.receiver === 'Toilet0');
  assert.ok(crushed.length > 0, 'Mover.EncroachingOn ran for the toilet');
  assert.equal(encroached.length, crushed.length, 'every blocking hit is followed by EncroachedBy on the toilet');
  // Native contact (validate-native-mover-push.mjs, paris-grill): clear at roll -9213, in contact at -10000.
  assert.ok(crushed[0].roll > -10000, `contact begins before the roll reaches -10000 (committed roll ${crushed[0].roll})`);
  assert.ok(pushes.length >= 2 * crushed.length && pushes.every(p => p.actor === 'Toilet0' && p.delta.every(v => v === 0)),
    'a roll leaves the mover at its Location: every push vector is zero (forward and reverse)');
  assert.equal(bits(toilet), start, 'the toilet is not displaced');
  assert.equal(read(toilet, 'HitPoints'), hitPoints, 'bInvincible refuses the Crushed damage');
  assert.equal(read(toilet, 'bDeleteMe'), false, 'the toilet is not destroyed');
  assert.ok(jcContacts > 0, 'JC stands in the swing too: the Pawn path ran beside the non-Pawn one');
  assert.deepEqual(game.player.position, jc, 'a zero push vector does not displace JC either');
  console.log(JSON.stringify({part: 'A 10_Paris_Club grill', jcContacts, ticks, contacts: crushed.length, firstContactRoll: crushed[0].roll, zeroPushes: pushes.length}));
}

// ---- Part B: a pickup squeezed by a Training door leaf ----------------------
{
  const {game, runtime, level, read, tick} = await boot('00_Training');
  const leaf = game.collision.movers.find(m => m.name === 'DeusExMover16');
  const other = game.collision.movers.find(m => m.name === 'DeusExMover17');
  const ammo = level.actors.find(a => a?.name === AMMO.name);
  assert.ok(leaf && other && ammo);
  assert.equal(read(leaf, 'MoverEncroachType'), 3, 'ME_IgnoreWhenEncroach');
  assert.ok(ammo.lineage.includes('engine.inventory') && !ammo.lineage.includes('engine.pawn'));
  assert.equal(ammo.flags & 0xf, AMMO.bits);
  assert.equal(ammo.radius, AMMO.radius);
  assert.equal(ammo.height, AMMO.height);

  for (let i = 0; i < 120; i++) tick();
  assert.ok(runtime.farMoveActor(ammo, AMMO.start, 0, 1), 'the fixture places the pickup in the leaf\'s path');
  for (let i = 0; i < 240; i++) tick();
  assert.deepEqual(ammo.position, AMMO.start);

  const steps = [];
  const moveSmoothActor = runtime.moveSmoothActor?.bind(runtime);
  if (moveSmoothActor) runtime.moveSmoothActor = (actor, delta) => {
    const step = {actor: actor.name, delta: [...delta], mover: [...leaf.position], other: [...other.position], before: [...actor.position]};
    const result = moveSmoothActor(actor, delta);
    steps.push({...step, after: [...actor.position], result});
    return result;
  };
  const player = game.player.collisionActor;
  runtime.processEvent(leaf, 'Trigger', [player, player]);
  runtime.processEvent(other, 'Trigger', [player, player]);
  let error = null;
  for (let i = 0; i < 600; i++) {
    try { tick(); } catch (e) { error = String(e?.message ?? e).split('\n')[0]; break; }
  }
  assert.equal(error, null, 'closing a door leaf on a pickup does not pause Play');
  assert.equal(read(leaf, 'KeyNum'), 1, 'the leaf reached its key');
  assert.ok(steps.length > 100 && steps.every(s => s.actor === AMMO.name), `the pickup is pushed by every step (${steps.length})`);

  // Each recorded group (forward push, then the reverse push) ends where the original ends it.
  let matched = 0;
  GROUPS.forEach((group, index) => {
    const at = steps.findIndex(s => bits({position: s.mover}) === bits({position: group.mover}) &&
      bits({position: s.before}) === bits({position: group.ammo}) && bits({position: s.delta}) === bits({position: group.delta}));
    assert.ok(at >= 0, `group ${index}: Play makes the recorded push`);
    const reverse = steps[at + 1];
    assert.deepEqual(reverse.delta, group.delta.map(v => Math.fround(-v)), `group ${index}: the reverse push follows`);
    assert.deepEqual(reverse.after, group.final, `group ${index}: the pickup ends where the original leaves it`);
    matched++;
  });
  assert.deepEqual(ammo.position, GROUPS.at(-1).final, 'the pickup ends squeezed where the last original group leaves it');
  console.log(JSON.stringify({part: 'B 00_Training door leaf', pushes: steps.length, originalGroups: matched, final: ammo.position}));
}
process.exit(0);
