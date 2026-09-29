import test from 'node:test';
import assert from 'node:assert/strict';
import { pawnPhysicsView } from '../src/runtime/script-pawn-physics.mjs';
import { beginTouch, endTouch } from '../src/runtime/actor-touch.mjs';

// The script pawn physics view is a JS wrapper of a map pawn's script fields.
// The original stores and compares AActor pointers: Touching slots, Base
// links, IsBasedOn and the SetBase guard see the actor itself, never a view.
// Regression for Island's OfficeChair0.Touching holding UNATCOTroop6's view
// after ScriptedPawn.Sitting.Tick's SetLocation (FarMoveActor ->
// CheckEncroachment notify 1 -> BeginTouch).

const zone = { name: 'Zone' };
const cylinder = (name, extra = {}) => ({ name, position: [0, 0, 0], radius: 16, height: 20, flags: 1,
  physics: 0, isPawn: false, pawnFlags: 0, touching: [null, null, null, null], base: null, standingCount: 0, ...extra });

function scene() {
  const events = [], hash = { encroachers: [], lineHits: [], lineHit: null,
    removeActor() {}, addActor() {},
    actorEncroachmentCheck: () => hash.encroachers.map(actor => ({ actor })),
    multiLineCheck: () => hash.lineHits,
    lineCheck: () => hash.lineHit ?? { time: 1, actor: null, location: [0, 0, 0], normal: [0, 0, 0] } };
  const level = { hash, actors: [], netMode: 0, model: null,
    pointRegion: () => ({ zone, leaf: 0, zoneNumber: 1 }), findSpot: () => true };
  const troop = { name: 'UNATCOTroop6', lineage: ['engine.pawn', 'engine.actor'], fields: {
    Location: [0, 0, 0], Rotation: [0, 0, 0], Velocity: [0, 0, 0], Acceleration: [0, 0, 0], Physics: 2,
    CollisionRadius: 20, CollisionHeight: 43, EyeHeight: 38, StandingCount: 0, Base: null, Owner: null,
    bCollideActors: true, bBlockActors: true, bBlockPlayers: true, bCollideWorld: false, bMovable: true } };
  const services = { level, worldActor: { name: '$world' },
    field: (actor, name) => ({ get: () => actor.fields[name], set: value => { actor.fields[name] = value; } }),
    isA: (actor, key) => actor.lineage.includes(key), zoneFields: () => ({}), isProbing: () => false,
    dispatch: (target, event, args) => { events.push([target.name, event, ...args.map(a => a?.name ?? a)]); } };
  const view = pawnPhysicsView(troop, services);
  // Host collision state the level move services read (map-actor-native.mjs).
  Object.defineProperty(troop, 'base', { get: () => troop.fields.Base, set: value => { troop.fields.Base = value; } });
  return { events, hash, troop, view };
}

test('FarMoveActor encroachment BeginTouch stores the pawn identity in the reciprocal slot', () => {
  const { events, hash, troop, view } = scene(), chair = cylinder('OfficeChair0');
  assert.notEqual(view, troop);
  hash.encroachers = [chair];
  assert.equal(view.farMove([1, 0, 0], 0, 0), true);
  assert.equal(chair.touching[3], troop, 'the chair slot holds the pawn, not its physics view');
  assert.equal(troop.touching[3], chair);
  assert.deepEqual(events, [['UNATCOTroop6', 'Touch', 'OfficeChair0'], ['OfficeChair0', 'Touch', 'UNATCOTroop6']]);
  // A later MoveActor matches that slot against the pawn and clears both
  // sides (EndTouch 0x10369970): the chair receives its UnTouch.
  events.length = 0; hash.encroachers = [];
  assert.equal(view.moveActor([200, 0, 0]), true);
  assert.deepEqual(chair.touching, [null, null, null, null]);
  assert.deepEqual(troop.touching, [null, null, null, null]);
  assert.deepEqual(events, [['UNATCOTroop6', 'UnTouch', 'OfficeChair0'], ['OfficeChair0', 'UnTouch', 'UNATCOTroop6']]);
});

test('BeginTouch and EndTouch refuse a field view in place of an actor', () => {
  const { view } = scene(), chair = cylinder('OfficeChair0');
  assert.throws(() => beginTouch(view, chair, () => {}), /actor identities/);
  assert.throws(() => beginTouch(chair, view, () => {}), /actor identities/);
  assert.throws(() => endTouch(view, chair, false, () => {}), /actor identities/);
  assert.deepEqual(chair.touching, [null, null, null, null]);
});

test('MoveActor skips a blocking actor based on the moving pawn (Hit.Actor->IsBasedOn(Actor))', () => {
  const { events, hash, troop, view } = scene();
  const rider = cylinder('Rider', { flags: 15, base: troop, position: [30, 0, 0] });
  hash.lineHits = [{ actor: rider, time: 0.5, location: [10, 0, 0], normal: [-1, 0, 0] }];
  const hit = view.moveActorHit([20, 0, 0]);
  assert.equal(hit.actor, null);
  assert.deepEqual(troop.fields.Location, [20, 0, 0]);
  assert.deepEqual(rider.touching, [null, null, null, null]);
  assert.deepEqual(events, []);
});

test('SetBase refuses a NewBase whose Base chain reaches the pawn', () => {
  const { events, troop, view } = scene(), rider = cylinder('Rider', { base: troop });
  view.setBase(rider);
  assert.equal(troop.fields.Base, null);
  assert.equal(rider.standingCount, 0);
  assert.deepEqual(events, []);
});

test('FindBase ignores a floor actor based on the pawn', () => {
  const { events, hash, troop, view } = scene(), rider = cylinder('Rider', { base: troop });
  hash.lineHit = { time: 0.5, actor: rider, location: [0, 0, -40], normal: [0, 0, 1] };
  view.setPhysics(1);
  assert.equal(troop.fields.Physics, 1);
  assert.deepEqual(events, []);
});
