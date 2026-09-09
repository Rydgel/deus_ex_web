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
