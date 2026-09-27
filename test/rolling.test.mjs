import test from 'node:test';
import assert from 'node:assert/strict';
import { rolling } from '../src/runtime/rolling.mjs';

const f = Math.fround;
const zone = (over = {}) => ({ ZoneGravity: [0, 0, -950], ZoneVelocity: [0, 0, 0], ZoneGroundFriction: 8, ZoneFluidFriction: f(.02), ...over });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-4, `${actual} != ${expected}`);

function worldHit(start, delta, walls, floorNormal) {
  const floor = floorNormal ?? [0, 0, 1];
  let time = 1, normal = [0, 0, 0];
  const depth = floor[0] * delta[0] + floor[1] * delta[1] + floor[2] * delta[2];
  if (depth < 0) {
    const candidate = -(floor[0] * start[0] + floor[1] * start[1] + floor[2] * start[2]) / depth;
    if (candidate >= 0 && candidate < time) { time = candidate; normal = floor.slice(); }
  }
  for (const [axis, sign, plane] of walls) {
    if (delta[axis] * sign > 0) {
      const candidate = (plane - start[axis]) / delta[axis];
      if (candidate >= 0 && candidate < time) { time = candidate; normal = [0, 0, 0]; normal[axis] = sign; }
    }
  }
  return { time, normal };
}

function run(input) {
  const events = [];
  const host = { position: input.position.map(f), velocity: input.velocity.map(f), acceleration: input.acceleration.map(f),
    physics: input.physics ?? 7, base: input.base ?? null, justTeleported: false };
  rolling(host, input.dt, {
    zone: input.zone,
    move(delta) {
      const start = host.position.map(f);
      const { time, normal } = worldHit(start, delta, input.walls ?? [], input.floorNormal);
      const location = start.map((value, axis) => f(value + f(delta[axis] * time)));
      host.position = location;
      events.push({ move: delta.map(f), time: f(time), normal: normal.map(f), position: location.slice() });
      return { time: f(time), normal: normal.map(f), actor: null };
    },
    eventHitWall() { events.push({ event: 'HitWall' }); },
    eventFalling() { events.push({ event: 'Falling' }); },
    setPhysics(next) { host.physics = next; },
    physFalling(remaining, iterations) { events.push({ physFalling: [f(remaining), iterations] }); },
    setBase(actor) { host.base = actor; },
  });
  return { position: host.position, velocity: host.velocity, physics: host.physics, events };
}

// Expectations captured from the original AActor.physRolling through
// scripts/native-rolling-oracle.py (Engine.dll 0x103d4b80) with the same
// controlled floor/wall world. See docs/rolling.md.

test('flat-floor sliding: friction decay, substep halving and displacement velocity', () => {
  const result = run({ position: [0, 0, 10], velocity: [100, 0, 0], acceleration: [0, 0, 0], dt: .1, zone: zone() });
  close(result.position[0], 1.9959999322891235);
  close(result.position[2], 0);
  close(result.velocity[0], 19.959999084472656);
  close(result.velocity[2], -100);
  assert.deepEqual(result.events.map(e => e.move.map(v => Math.round(v * 1e4) / 1e4)), [[.998, 0, 0], [0, 0, -16], [.998, 0, 0], [0, 0, -16]]);
});

test('ground/fluid friction asymmetry (X double, Y/Z stepped, Z acceleration extended)', () => {
  const result = run({ position: [0, 0, 10], velocity: [200, -50, 0], acceleration: [0, 0, 0], dt: .1, zone: zone({ ZoneGroundFriction: 16, ZoneFluidFriction: f(.5) }) });
  close(result.position[0], -11.40000057220459);
  close(result.position[1], 2.8500001430511475);
  close(result.velocity[0], -114.00000762939453);
  close(result.velocity[1], 28.500001907348633);
});

test('airborne: no floor contact transitions to Falling and recurses into physFalling', () => {
  const result = run({ position: [0, 0, 1000], velocity: [80, -40, 0], acceleration: [0, 0, 0], dt: .1, zone: zone() });
  assert.equal(result.physics, 2);
  close(result.velocity[0], 15.968000411987305);
  close(result.velocity[2], 0);
  assert.deepEqual(result.events.filter(e => e.event).map(e => e.event), ['Falling']);
  assert.equal(result.events.at(-1).physFalling[1], 1);
});

test('wall contact dispatches HitWall and slides along the floor', () => {
  const result = run({ position: [0, 0, 2], velocity: [150, 60, 0], acceleration: [0, 0, 0], dt: .1, walls: [[0, 1, 5]], zone: zone() });
  assert.equal(result.physics, 7);
  close(result.position[0], 2.994000196456909);
  close(result.velocity[0], 29.94000244140625);
});

test('HitWall can enable bounce live; callback velocity and Falling writes remain visible', () => {
  const host = { position: [0, 0, 100], velocity: [1000, 0, 0], acceleration: [0, 0, 0],
    physics: 7, base: null, justTeleported: false, bBounce: false };
  const moves = [], events = [];
  rolling(host, .1, {
    zone: zone(),
    move(delta) {
      moves.push(delta.map(f));
      return moves.length === 1
        ? { time: .5, normal: [-1, 0, 0], actor: null }
        : { time: 1, normal: [0, 0, 0], actor: null };
    },
    eventHitWall() {
      events.push({ hitWallVelocity: host.velocity.slice() });
      host.bBounce = true;
    },
    eventFalling() {
      host.velocity = [77, 88, 99];
      host.justTeleported = true;
    },
    setPhysics(next) { host.physics = next; },
    physFalling(remaining, iterations) { events.push({ physFalling: [remaining, iterations, host.velocity.slice()] }); },
    setBase(actor) { host.base = actor; },
  });
  assert.deepEqual(events[0], { hitWallVelocity: [199.60000610351562, 0, 0] },
    'HitWall observes the native friction/fluid Velocity store');
  assert.deepEqual(moves[1], [0, 0, -16], 'the live bBounce store skips the wall-slide MoveActor');
  assert.deepEqual(host.velocity, [77, 88, 0], 'the just-teleported Falling branch preserves callback X/Y');
  assert.deepEqual(events[1], { physFalling: [f(.125), 1, [77, 88, 0]] },
    'physFalling receives rolling iterations and the live callback velocity');
});

test('sloped floor reports DropHitZ<1 and enters the Falling transition', () => {
  const result = run({ position: [0, 0, 10], velocity: [60, 40, 0], acceleration: [0, 0, 0], dt: .2, floorNormal: [.6, 0, .8], zone: zone() });
  assert.equal(result.physics, 2);
  assert.deepEqual(result.events.filter(e => e.event).map(e => e.event), ['Falling']);
});
