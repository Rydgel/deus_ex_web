import test from 'node:test';
import assert from 'node:assert/strict';
import { runDecorationPhysics, PHYS_NONE, PHYS_FALLING } from '../src/runtime/decoration-physics.mjs';

const f = Math.fround;

// A decoration host (the shared collision/VM actor) plus fake level queries and a
// zone. The underlying physFalling, MoveActor and processLanded fidelity is proven
// by the native oracles (validate-native-falling / -move-query / -landing); this
// exercises only that runDecorationPhysics composes them and writes the host back.
function scene(hitResponse, host = {}) {
  const events = [];
  const levelInfo = { id: '$world' };
  const queries = { levelInfo,
    multiLineCheck(query) { events.push({ query: { end: query.end } }); return hitResponse(query); },
    changeActor(actor, change) { events.push({ changeActor: actor === decoration }); change(); },
  };
  const decoration = { name: 'Plant7', flags: 15, actorFlags: 0x80000, physics: PHYS_FALLING,
    position: [0, 0, 100], velocity: [0, 0, 0], radius: 23.26, height: 43.88,
    values: { Physics: PHYS_FALLING, Location: [0, 0, 100], CollisionRadius: 23.26, CollisionHeight: 43.88 }, ...host };
  const zone = { ZoneGravity: [0, 0, -950], ZoneVelocity: [0, 0, 0], ZoneTerminalVelocity: 2500 };
  const landings = [];
  const opts = { queries, zone, landedEvent: normal => landings.push(normal) };
  return { decoration, opts, events, landings };
}

test('a decoration in free air falls under gravity and stays PHYS_Falling', () => {
  const { decoration, opts, events } = scene(() => []);
  const physics = runDecorationPhysics(decoration, f(1 / 60), opts);
  assert.equal(physics, PHYS_FALLING);
  assert.equal(decoration.physics, PHYS_FALLING);
  assert.ok(decoration.velocity[2] < 0, 'gains downward velocity from gravity');
  assert.ok(decoration.position[2] < 100, 'descends');
  assert.ok(events.some(e => e.query), 'issued a collision move query');
});

test('a decoration that meets a floor lands: PHYS_None, based on the floor, velocity and acceleration zeroed', () => {
  const floor = { id: '$world' };
  const { decoration, opts, events, landings } = scene(query => [{ time: f(.25),
    actor: query.worldActor ?? floor, normal: [0, 0, 1], location: [...query.end], item: 0 }]);
  decoration.velocity = [40, -10, -260];
  const physics = runDecorationPhysics(decoration, f(1 / 60), opts);
  assert.equal(physics, PHYS_NONE);
  assert.equal(decoration.physics, PHYS_NONE);
  assert.deepEqual(decoration.velocity, [0, 0, 0]);
  assert.deepEqual(decoration.acceleration, [0, 0, 0]);
  assert.ok(decoration.base && decoration.base === opts.queries.levelInfo, 'rebased onto the floor world actor');
  assert.equal(landings.length, 1, 'dispatched the script Landed event once');
  assert.deepEqual(landings[0], [0, 0, 1], 'Landed received the floor hit normal');
  assert.ok(events.some(e => e.changeActor === true), 'moved through the collision hash');
});

test('a wall contact during a decoration fall reaches the recovered non-Pawn processHitWall', () => {
  const { decoration, opts } = scene(query => [{ time: f(.25),
    actor: query.worldActor ?? { id: '$world' }, normal: [-1, 0, 0], location: [...query.end], item: 0 }]);
  decoration.velocity = [200, 0, -20];
  const walls = [];
  const physics = runDecorationPhysics(decoration, f(1 / 60), { ...opts, onHitWall: hit => walls.push(hit) });
  assert.equal(physics, PHYS_FALLING, 'a wall hit slides and keeps falling; it does not land');
  assert.ok(walls.length >= 1, 'dispatched the non-Pawn processHitWall boundary for the wall contact');
  assert.ok(walls[0].normal[2] <= f(.7), 'a wall normal (not a floor) reaches processHitWall');
  assert.equal(walls[0].actor, opts.queries.levelInfo, 'the world wall actor is passed through to HitWall');
});

test('a decoration wall contact requires the recovered processHitWall handler when none is supplied', () => {
  const { decoration, opts } = scene(query => [{ time: f(.25),
    actor: query.worldActor ?? { id: '$world' }, normal: [-1, 0, 0], location: [...query.end], item: 0 }]);
  decoration.velocity = [200, 0, -20];
  assert.throws(() => runDecorationPhysics(decoration, f(1 / 60), opts), /processHitWall/);
});

test('a decoration that is not PHYS_Falling is left untouched by this phase', () => {
  const { decoration, opts, events } = scene(() => assert.fail('should not query'), { physics: PHYS_NONE });
  const physics = runDecorationPhysics(decoration, f(1 / 60), opts);
  assert.equal(physics, PHYS_NONE);
  assert.equal(events.length, 0, 'no physics performed for a resting decoration');
});
