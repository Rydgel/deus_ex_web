import assert from 'node:assert/strict';
import test from 'node:test';
import { execParabolicTrace, parabolicTraceWords, twoWallAdjustWords } from '../src/runtime/script-actor-parabolic-trace.mjs';
import { f32bits, f32num, refValue } from '../src/runtime/script-vm.mjs';

// Reference values captured from Engine.dll under Unicorn (scripts/native-parabolic-trace-oracle.py, exec 0x1036e190) for a
// floor at z = 0, gravity (0, 0, -950), a pawn at (0, 0, 100) with Velocity (200, 40, 150) and the default arguments.
// The level services here are a minimal floor with the oracle's own arithmetic; the full corpus is
// scripts/validate-parabolic-trace.mjs.
const W = f32bits, words = v => v.map(W);
const level = { id: 'level' };
const zone = (over = {}) => ({ gravity: words([0, 0, -950]), velocity: words([0, 0, 0]), terminalVelocity: W(2500), water: false, ...over });
function services({ zones = [zone()], regionFor = () => ({ zone: 0, zoneNumber: 1 }), floor = 0 } = {}) {
  return {
    levelInfo: level,
    pointRegion(position) {
      const r = regionFor(position.map(f32num));
      return { zone: zones[r.zone], leaf: 0, zoneNumber: r.zoneNumber };
    },
    multiLineCheck({ end, start, extent }) {
      const s = start.map(f32num), e = end.map(f32num), h = f32num(extent[2]);
      const d0 = s[2] - floor, d1 = e[2] - floor;
      if (!(d0 >= h && d1 < h)) return [];
      const t = Math.fround((d0 - h) / (d0 - d1));
      return [{ actor: level, time: W(t), location: s.map((c, i) => W(Math.fround(c + t * (e[i] - s[i])))), normal: words([0, 0, 1]), item: 0, primitive: 0 }];
    },
    isOwnedBy: () => false,
    blocksActors: () => false,
  };
}
const pawn = { name: 'Pawn' };
const fields = { Velocity: [200, 40, 150], Location: [0, 0, 100], bCollideActors: true, CollisionRadius: 4, CollisionHeight: 4, bBounce: false };
function run(args, svc = services()) {
  const slot = { value: null };
  const call = { receiver: pawn, argumentCount: args.length + 1,
    evaluateArgument: i => (i === 0 ? { reference: true, get: () => slot.value, set: v => { slot.value = v; } } : args[i - 1]) };
  const time = execParabolicTrace(call, { read: (_, name) => fields[name], services: () => svc, refValue, writeSlot: v => (v?.reference ? v : { set() {} }) });
  return { time, final: slot.value };
}

test('the default arguments come from the actor and the trace lands on the floor', () => {
  const { time, final } = run([]);
  assert.equal(time, 0.625);
  assert.deepEqual(final, [122.73026275634766, 24.546051025390625, 5.817235946655273]);
});

test('entering water returns the granularity and the start location; a zone number 0 returns time 0', () => {
  const water = services({ zones: [zone(), zone({ water: true })], regionFor: p => (p[2] < 20 ? { zone: 1, zoneNumber: 2 } : { zone: 0, zoneNumber: 1 }), floor: -400 });
  assert.deepEqual(run([], water), { time: f32num(W(0.025)), final: [0, 0, 100] });
  const outside = services({ regionFor: p => ({ zone: 0, zoneNumber: p[0] > 80 ? 0 : 1 }) });
  assert.deepEqual(run([], outside), { time: 0, final: [0, 0, 100] });
});

test('a maxTime below the landing time fails with time 0 and the start location', () => {
  assert.deepEqual(run([undefined, undefined, undefined, undefined, 0.5]), { time: 0, final: [0, 0, 100] });
});

test('granularity below 0.005 or NaN clamps to 0.005 and 1.0 is the upper bound', () => {
  const base = { startLocation: words([0, 0, 100]), startVelocity: words([200, 40, 150]), cylinder: words([4, 4, 4]), checkActors: 1,
    maxTime: W(5), elasticity: W(0.9), bounce: 0, landingSpeed: W(60) };
  const time = granularity => f32num(parabolicTraceWords(services(), pawn, { ...base, granularity }).time);
  assert.equal(time(W(0.0001)), time(W(0.005)));
  assert.equal(time(0x7fc00000), time(W(0.005)));
  assert.equal(time(W(7)), time(W(1)));
});

test('TwoWallAdjust: parallel normals slide along the wall, a crease uses the cross product, a reversed result is zeroed or flipped', () => {
  const adjust = (desired, delta, normal, old, t) => {
    const d = words(delta);
    twoWallAdjustWords(words(desired), d, words(normal), words(old), W(t));
    return d.map(f32num);
  };
  // dot(n, old) > 0: delta minus its component into the wall, scaled by 1 - t, kept while it still points along desired.
  assert.deepEqual(adjust([1, 0, 0], [3, 4, -5], [0, 0, 1], [0, 0, 1], 0.25), [2.25, 3, 0]);
  assert.deepEqual(adjust([-1, 0, 0], [3, 4, -5], [0, 0, 1], [0, 0, 1], 0.25), [0, 0, 0]);
  // dot(n, old) <= 0: the crease n x old = (0, 1, 0), scaled by (crease . delta) * (1 - t) = 4 * 0.5.
  assert.deepEqual(adjust([1, 0, 0], [3, 4, 5], [0, 0, 1], [1, 0, 0], 0.5), [0, 2, 0]);
  // ... and flipped when it opposes desired.
  assert.deepEqual(adjust([0, -1, 0], [3, 4, 5], [0, 0, 1], [1, 0, 0], 0.5), [-0, -2, -0]);
});
