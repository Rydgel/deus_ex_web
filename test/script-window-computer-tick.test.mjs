// The doubles-where-exact steps of XComputerWindow::Tick (1000f7b0) against the x87 model's BigInt path, over random and edge float32 values
// (docs/live-heap.md "Cut: script VM values"). A step that answers must answer what the model does; a step may decline.
import test from 'node:test';
import assert from 'node:assert/strict';
import {cursorStep, computeTimeStep, timeStep, exactSum} from '../src/runtime/script-window-computer-playback.mjs';
import {x87load as X, x87add as A, x87neg as N, x87mul as M, x87store as S, x87cmp} from '../src/runtime/script-vm.mjs';

const sub = (a, b) => A(a, N(b));
const lt = (a, b) => ['lt', 'un'].includes(x87cmp(a, b));
const gt = (a, b) => x87cmp(a, b) === 'gt';
const f = Math.fround;
const bits = new DataView(new ArrayBuffer(4));
const same = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));

let seed = 0x2468ace1;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000; };
const EDGES = [0, -0, 1, -1, 0.5, 0.25, 1e-45, -1e-45, 1.1754944e-38, 3.4028235e38, -3.4028235e38, Infinity, -Infinity, NaN, 16777216, 0.1, 0.01666667, 1 / 60].map(f);
const value = () => {
  const kind = random();
  if (kind < 0.15) return EDGES[Math.floor(random() * EDGES.length)];
  if (kind < 0.35) { bits.setUint32(0, Math.floor(random() * 0x100000000), true); return bits.getFloat32(0, true); }
  if (kind < 0.7) return f((random() - 0.5) * 10 ** Math.floor(random() * 8 - 3));
  return f(random() * 4);
};

test('cursorStep answers the model\'s stored value, or declines', () => {
  let answered = 0;
  for (let i = 0; i < 200000; i++) {
    const next = value(), delta = value(), got = cursorStep(next, delta);
    if (got === undefined) continue;
    answered++;
    const cursor = sub(X(next), X(delta));
    assert.equal(lt(cursor, X(0)), false, `${next} ${delta} wraps in the model`);
    assert.ok(same(got, S(cursor)), `${next} - ${delta}: ${got} against ${S(cursor)}`);
  }
  assert.ok(answered > 50000, `answered only ${answered}`);
});

test('computeTimeStep answers the model\'s two stored values, or declines', () => {
  let answered = 0, withNext = 0;
  for (let i = 0; i < 200000; i++) {
    const delta = value(), throttle = value(), current0 = value(), last = value(), interval = value();
    if (!computeTimeStep(delta, throttle, current0, last, interval)) continue;
    answered++;
    const current = A(M(X(delta), X(throttle)), X(current0));
    assert.ok(same(timeStep.current, S(current)), `time ${timeStep.current} against ${S(current)} for ${delta} ${throttle} ${current0}`);
    const passed = gt(sub(current, X(last)), X(interval));
    assert.equal(timeStep.hasNext, passed, `${delta} ${throttle} ${current0} ${last} ${interval}`);
    if (passed) { withNext++; assert.ok(same(timeStep.next, S(A(current, X(interval)))), 'next'); }
  }
  assert.ok(answered > 30000, `answered only ${answered}`);
  assert.ok(withNext > 1000, `the passed branch ran only ${withNext} times`);
});

test('exactSum is null for an inexact or non-finite sum', () => {
  assert.equal(exactSum(1, 2 ** -60), null);
  assert.equal(exactSum(Infinity, 1), null);
  assert.equal(exactSum(NaN, 1), null);
  assert.equal(exactSum(0.5, 0.25), 0.75);
  assert.ok(Object.is(exactSum(-0, -0), -0));
  assert.ok(Object.is(exactSum(0, -0), 0));
});
