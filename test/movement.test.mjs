import test from 'node:test';
import assert from 'node:assert/strict';
import { BspCollider, CollisionWorld, sweepCylinder, readCollisionHulls } from '../src/runtime/collision.mjs';
import { Player, FixedClock, FIXED_STEP } from '../src/runtime/player.mjs';
import { Doors } from '../src/runtime/doors.mjs';

function boxes(bounds) {
  const nodes = [], leafHulls = [], data = new DataView(new ArrayBuffer(4));
  for (const [min, max] of bounds) {
    const offset = nodes.length, start = leafHulls.length;
    const planes = [[1, 0, 0, max[0]], [-1, 0, 0, -min[0]], [0, 1, 0, max[1]], [0, -1, 0, -min[1]], [0, 0, 1, max[2]], [0, 0, -1, -min[2]]];
    for (const [i, plane] of planes.entries()) { nodes.push({ plane, collisionBound: i === 0 ? start : -1 }); leafHulls.push(offset + i); }
    leafHulls.push(-1, ...[...min, ...max].map(f => { data.setFloat32(0, f, true); return data.getInt32(0, true); }));
  }
  return { nodes, leafHulls };
}
const defaults = { CollisionRadius: 20, CollisionHeight: 47.5, BaseEyeHeight: 40, GroundSpeed: 320, AccelRate: 1000, JumpZ: 300, MaxStepHeight: 25, AirControl: .05, Bob: .016 };
const floor = [[-2000, -2000, -100], [2000, 2000, 0]];
function player(extra = []) { const collision = new CollisionWorld(boxes([floor, ...extra])); return new Player(collision, defaults, [0, 0, 43.05], () => ({ ZoneGravity: [0, 0, -950], ZoneGroundFriction: 8 })); }
function run(p, seconds, input = {}) { for (let n = 0; n < Math.round(seconds / FIXED_STEP); n++) p.tick(FIXED_STEP, input); }

test('compiled collision hulls block long sweeps, allow face sliding and validate binary spans', () => {
  const model = boxes([[[10, -100, -100], [12, 100, 100]]]), b = new BspCollider(model);
  assert.equal(b.sweep([0, 0, 0], [1000, 0, 0], [2, 2, 2]).time, 0, 'native extent backoff is at least 10% of trace length');
  assert.ok(Math.abs(b.sweep([0, 0, 0], [20, 0, 0], [2, 2, 2]).time - .3) < 1e-8);
  assert.equal(b.sweep([8, 0, 0], [0, 50, 0], [2, 2, 2]), null);
  assert.equal(b.sweep([8, 0, 0], [-20, 0, 0], [2, 2, 2]), null);
  assert.equal(b.overlaps([9, 0, 0], [2, 2, 2]), true);
  assert.throws(() => readCollisionHulls({ ...model, leafHulls: model.leafHulls.slice(0, -1) }), /Truncated/);
  assert.throws(() => readCollisionHulls({ ...model, leafHulls: [9999, ...model.leafHulls.slice(1)] }), /plane/);
});

test('original extent clipping permits floor-overlap escape and applies native floor clearance', () => {
  const b = new BspCollider(boxes([floor]));
  assert.equal(b.sweep([0, 0, 38], [0, 0, 30], [20, 20, 43]), null);
  assert.equal(b.sweep([0, 0, 38], [20, 0, 0], [20, 20, 43]), null);
  assert.equal(b.sweep([0, 0, 38], [0, 0, -30], [20, 20, 43]).time, 0);
  // physWalking's 27-unit probe reports 2.1 when the geometric feet gap is 4.8.
  assert.ok(Math.abs(b.sweep([0, 0, 47.8], [0, 0, -27], [20, 20, 43]).time * 27 - 2.1) < 1e-6);
  const p = player([[[100, -100, 0], [120, 100, 200]]]);
  p.position = [70, 0, 47.8]; p.move([10, 0, 0]);
  assert.ok(Math.abs(p.position[0] - 76.8) < 1e-6, 'MoveActor traces 12, applies model backoff, then subtracts 2');
});

test('actor cylinders collide on curved sides and caps without turning into square boxes', () => {
  const actor = { position: [0, 0, 0], radius: 10, height: 20 };
  assert.equal(sweepCylinder(actor, [-30, 0, 0], [60, 0, 0], [5, 5, 5]).time, .25);
  assert.equal(sweepCylinder(actor, [0, 0, 40], [0, 0, -30], [5, 5, 5]).time, .5);
  assert.equal(sweepCylinder(actor, [-30, 14.9, 0], [60, 0, 0], [0, 0, 0]), null);
});

test('player falls, lands, jumps once per press, and collides with a ceiling', () => {
  const p = player(); p.position[2] = 120; run(p, 1);
  assert.equal(p.grounded, true); assert.ok(p.position[2] >= 47.6 && p.position[2] <= 48.1);
  const jumpStart = p.position[2];
  let peak = p.position[2]; for (let i = 0; i < 120; i++) { p.tick(FIXED_STEP, { jump: true }); peak = Math.max(peak, p.position[2]); }
  assert.equal(p.jumps, 1); assert.ok(peak - jumpStart > 46 && peak - jumpStart < 48); assert.equal(p.grounded, true);
  const low = player([[[-100, -100, 100], [100, 100, 110]]]); run(low, .05); run(low, .1, { jump: true });
  assert.ok(low.position[2] + low.height < 100); assert.ok(low.velocity[2] <= 0);
});

test('stairs climb and descend, while a tall wall and diagonal corners remain solid', () => {
  const p = player([[[80, -100, 0], [120, 100, 16]], [[120, -100, 0], [160, 100, 32]], [[160, -100, 0], [200, 100, 48]], [[300, -100, 0], [320, 100, 150]]]);
  let peak = 0;
  for (let i = 0; i < 240; i++) { p.tick(FIXED_STEP, { forward: 1 }); peak = Math.max(peak, p.position[2]); }
  assert.ok(peak > 94); assert.ok(p.position[0] > 277 && p.position[0] < 280); assert.equal(p.grounded, true);
  assert.ok(p.position[2] >= 47.6 && p.position[2] <= 48.1);
  const corner = player([[[100, -1000, 0], [120, 1000, 200]], [[-1000, 100, 0], [1000, 120, 200]]]);
  run(corner, 2, { forward: 1, right: 1 }); assert.ok(corner.position[0] <= 80 && corner.position[1] <= 80);
});

test('crouching preserves feet, traverses low passages, and prevents standing into the roof', () => {
  const p = player([[[100, -100, 64], [300, 100, 100]]]); run(p, .1);
  const feet = p.position[2] - p.height; run(p, .1, { crouch: true });
  assert.equal(p.height, 16); assert.ok(Math.abs(p.position[2] - p.height - feet) < .01);
  run(p, 2, { crouch: true, forward: 1 }); run(p, .1);
  assert.equal(p.forceDuck, true); assert.equal(p.height, 16);
  run(p, 2, { forward: 1 }); assert.equal(p.height, 43); assert.equal(p.forceDuck, false);
});

test('original stair routine climbs a low step when the ceiling prevents the full upward probe', () => {
  const p = player([[[80, -100, 0], [240, 100, 16]], [[-100, -100, 112], [400, 100, 120]]]);
  let peak = 0;
  for (let i = 0; i < 120; i++) { p.tick(FIXED_STEP, { forward: 1 }); peak = Math.max(peak, p.position[2]); }
  assert.ok(p.position[0] > 240, 'passes the step despite blocked headroom');
  assert.ok(peak > 63 && peak + p.height < 112);
});

test('fixed steps give the same movement at different render rates, with bounded catch-up', () => {
  const positions = [3, 10, 30, 60, 144].map(rate => { const p = player(), c = new FixedClock(); for (let i = 0; i < rate * 2; i++) c.advance(1 / rate, dt => p.tick(dt, { forward: 1 })); return p.position; });
  for (const position of positions) assert.deepEqual(position, positions[0]);
  let count = 0; new FixedClock().advance(60, () => count++); assert.equal(count, 48);
});

test('CheckBob receives movement state before this tick changes speed, rotation or jump physics', () => {
  const p = player(), calls = []; run(p, .1);
  p.checkBob = { run(state, locals) { calls.push({ groundSpeed: state.GroundSpeed, ...structuredClone(locals) }); } };
  p.velocity = [100, 0, 0];
  p.tick(FIXED_STEP, { forward: -1, yaw: Math.PI / 2, jump: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].Speed2D, 100);
  assert.equal(calls[0].groundSpeed, 320);
  assert.deepEqual(calls[0].Y, [0, 1, 0]);
  assert.equal(p.grounded, false);
  p.tick(FIXED_STEP, { yaw: Math.PI / 2 });
  assert.equal(calls.length, 1, 'falling decays bob without executing CheckBob');
  p.grounded = true; p.velocity = [0, 0, 0];
  p.tick(FIXED_STEP, { yaw: Math.PI / 2 });
  assert.equal(calls[1].Y[0], -1);
});

test('camera eye height smooths stance changes independently of the collision body', () => {
  const p = player(); run(p, .1);
  const oldEye = p.eye[2]; p.tick(FIXED_STEP, { crouch: true });
  assert.ok(oldEye - p.eye[2] > 0 && oldEye - p.eye[2] < 10, 'crouch camera eases rather than snapping 54 units');
  run(p, 1, { crouch: true }); assert.ok(Math.abs(p.eye[2] - p.traceEye[2]) < .01);
});

test('door use respects range, occlusion, locks, authored tags, glide timing and reversal', () => {
  const collision = new CollisionWorld(boxes([]));
  const make = (name, y) => ({ name, values: { Location: [100, y, 0], InitialState: 'TriggerToggle', NumKeys: 2, Tag: 'Double', MoveTime: 2, MoverGlideType: 1, bFrobbable: true, 'KeyPos[1]': [0, y > 0 ? 56 : -56, 0] }, blocking: true, collider: new BspCollider(boxes([[[100, y - 20, -64], [108, y + 20, 64]]])) });
  collision.movers.push(make('left', -20), make('right', 20));
  const doors = new Doors(collision.movers, 112);
  assert.equal(doors.target(collision, [-20, -20, 0], [1, 0, 0]), null);
  const target = doors.target(collision, [0, -20, 0], [1, 0, 0]); target.mover.values.bLocked = true;
  assert.equal(doors.use(target, [0, 0, 0]).ok, false); target.mover.values.bLocked = false;
  assert.deepEqual(doors.use(target, [0, 0, 0]).actors, ['left', 'right']); doors.tick(.5);
  assert.equal(collision.movers[0].collider.offset[1], -8.75);
  doors.use(target, [0, 0, 0]); doors.tick(.5); assert.equal(collision.movers[0].alpha, 0);
  collision.bsp = new BspCollider(boxes([[[50, -100, -100], [60, 100, 100]]]));
  assert.equal(doors.target(collision, [0, -20, 0], [1, 0, 0]), null);
});
