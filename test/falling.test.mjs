import test from 'node:test';
import assert from 'node:assert/strict';
import { falling } from '../src/runtime/falling.mjs';

// Fixed results captured by executing the original DLL via
// scripts/validate-native-falling.mjs, with clear or specified world responses.
const f = Math.fround;
function pawn(changes = {}, responses = []) {
  const events = [], p = { position: [0, 0, 100], velocity: [0, 0, 300], acceleration: [2400, 0, 0],
    groundSpeed: 320, accelRate: 1000, airControl: .05, gravity: [0, 0, -950],
    zoneVelocity: [0, 0, 0], terminalVelocity: 2500, physics: 2, events, ...changes,
    airControlBlocked: () => false,
    move(delta) {
      events.push({ move: [...delta] });
      const hit = responses.shift() ?? { time: 1, normal: [0, 0, 0] };
      p.position = p.position.map((v, i) => f(v + f(delta[i] * hit.time)));
      return hit;
    },
    hitWall(hit) { events.push({ wall: hit.normal }); },
    landed(hit, remaining, iterations) { events.push({ landed: hit.normal, remaining, iterations }); p.physics = 1; },
  };
  return p;
}

test('original falling boosts initial horizontal air steering and retains float32 position feedback', () => {
  const p = pawn(); falling(p, 1 / 120);
  assert.deepEqual(p.position, [0.0434027761220932, 0, 102.46701049804688]);
  assert.deepEqual(p.velocity, [10.416666030883789, 0, 292.08245849609375]);
  assert.deepEqual(p.acceleration, [2400, 0, 0]);
});

test('original falling preserves excess horizontal speed and subdivides a float32 0.1-second interval', () => {
  const p = pawn({ velocity: [500, 0, 300] }); falling(p, .1);
  assert.equal(p.events.length, 2);
  assert.deepEqual(p.position, [50.00499725341797, 0, 125.25]);
  assert.deepEqual(p.velocity, [500.09991455078125, 0, 205]);
});

test('original floor impact passes the unused interval and measured impact velocity to landing', () => {
  const p = pawn({ velocity: [200, 30, -300], acceleration: [200, 1000, 0] }, [{ time: f(.3), normal: [0, 0, 1] }]);
  falling(p, .1);
  assert.equal(p.physics, 1);
  assert.deepEqual(p.events.at(-1), { landed: [0, 0, 1], remaining: 0.08500000089406967, iterations: 1 });
  assert.deepEqual(p.velocity, [200.24514770507812, 31.225725173950195, -323.7497863769531]);
  assert.deepEqual(p.acceleration, [9.805807113647461, 49.02903366088867, 0]);
});

// bBounce fragment cases captured from the original physFalling
// (scripts/validate-native-falling.mjs, fragment ancestry, controlled HitWall).
function fragment(response, script) {
  const events = [], p = { position: [-804.27, 1125.16, -84.02].map(f), velocity: [120, -40, -300], acceleration: [0, 0, 0],
    gravity: [0, 0, -950], zoneVelocity: [0, 0, 0], terminalVelocity: 2500, physics: 2, bBounce: true, events,
    move(delta) {
      events.push({ move: [...delta] });
      const hit = events.length === 1 ? response : { time: 1, normal: [0, 0, 0] };
      p.position = p.position.map((v, i) => f(v + f(delta[i] * hit.time)));
      return { ...hit, actor: hit.time < 1 ? 'level' : null };
    },
    hitWall() { throw new Error('bouncing falls never reach processHitWall'); },
    landed() { throw new Error('bouncing falls never reach processLanded'); },
  };
  const hitWallEvent = (normal, actor) => { events.push({ hitWallEvent: normal, actor }); script(p, normal); };
  return { p, run: seconds => falling(p, seconds, 0, { nonPawn: true, bounce: true, hitWallEvent }) };
}
const reflect = (p, n) => {
  const v = p.velocity, d = f((v[0] * n[0] + v[1] * n[1]) + v[2] * n[2]);
  p.velocity = v.map((a, i) => f(f(.4) * f(f(f(d * n[i]) * -2) + a)));
};

test('a bouncing floor contact dispatches HitWall, refunds time and keeps the script velocity', () => {
  const { p, run } = fragment({ time: f(.25), normal: [0, 0, 1] }, reflect);
  run(.1);
  assert.deepEqual(p.events.map(e => Object.keys(e)[0]), ['move', 'hitWallEvent', 'move']);
  assert.deepEqual(p.events[1], { hitWallEvent: [0, 0, 1], actor: 'level' });
  assert.deepEqual(p.events[2].move, [4.199999809265137, -1.399999976158142, 7.694530963897705]);
  assert.equal(p.physics, 2);
  assert.deepEqual(p.position, [-798.5700073242188, 1123.260009765625, -80.3723373413086]);
  assert.deepEqual(p.velocity, [48.000282287597656, -16.00055694580078, 46.37507629394531]);
});

test('a bouncing contact whose HitWall sets PHYS_None ends physFalling at once', () => {
  const stop = p => { p.physics = 0; p.velocity = [0, 0, 0]; p.acceleration = [0, 0, 0]; p.bBounce = false; };
  const { p, run } = fragment({ time: f(.25), normal: [-1, 0, 0] }, stop);
  run(.1);
  assert.equal(p.events.length, 2);
  assert.deepEqual(p.position, [-802.77001953125, 1124.6600341796875, -88.0668716430664]);
  assert.deepEqual(p.velocity, [0, 0, 0]);
});

test('the bounce branch requires the explicit script HitWall dispatch', () => {
  const p = { position: [0, 0, 0], velocity: [0, 0, -10], acceleration: [0, 0, 0], gravity: [0, 0, -950],
    zoneVelocity: [0, 0, 0], terminalVelocity: 2500, physics: 2, move: () => ({ time: 1, normal: [0, 0, 0] }) };
  assert.throws(() => falling(p, .1, 0, { nonPawn: true, bounce: true }), /hitWallEvent/);
});
