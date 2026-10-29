// XComputerWindow::Tick's blink and time arithmetic (1000f7b0) on the Rust x87 model (native/script-vm/src/computer.rs) against the
// BigInt body of script-window-computer-playback.mjs, over random and edge float32 values (docs/live-heap.md "Cut: script VM values").
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadScriptVmKernel} from '../src/runtime/script-vm-kernel.mjs';
import {x87load as X, x87add as A, x87neg as N, x87mul as M, x87store as S, x87cmp} from '../src/runtime/script-vm.mjs';

const sub = (a, b) => A(a, N(b));
const lt = (a, b) => ['lt', 'un'].includes(x87cmp(a, b));
const gt = (a, b) => x87cmp(a, b) === 'gt';
const eq = (a, b) => ['eq', 'un'].includes(x87cmp(a, b));
const f = Math.fround;
const bits = new DataView(new ArrayBuffer(4));
const same = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));

let seed = 0x2468ace1;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000; };
const EDGES = [0, -0, 1, -1, 0.5, 0.25, 1e-45, -1e-45, 1.1754944e-38, 3.4028235e38, -3.4028235e38, Infinity, -Infinity, NaN, 16777216, 0.1, 0.01666667, 1 / 60, 0.3, 139.55355834960938].map(f);
const value = () => {
  const kind = random();
  if (kind < 0.15) return EDGES[Math.floor(random() * EDGES.length)];
  if (kind < 0.35) { bits.setUint32(0, Math.floor(random() * 0x100000000), true); return bits.getFloat32(0, true); }
  if (kind < 0.7) return f((random() - 0.5) * 10 ** Math.floor(random() * 8 - 3));
  return f(random() * 4);
};

const kernel = (await loadScriptVmKernel()).computer;

test('the loaded script VM has the computer window steps', () => {
  assert.ok(kernel, 'no computer.rs exports');
});

test('cursorStep: the model\'s stored value, wrap flag and wrapped value', () => {
  let wrapped = 0;
  for (let i = 0; i < 200000; i++) {
    const next = value(), delta = value(), blink = value();
    const got = kernel.cursorStep(next, delta, blink);
    const cursor = sub(X(next), X(delta));
    assert.ok(same(got.stored, S(cursor)), `${next} - ${delta}: ${got.stored} against ${S(cursor)}`);
    const wrap = lt(cursor, X(0));
    assert.equal(got.flag, wrap, `${next} - ${delta} wraps ${wrap}`);
    if (wrap) { wrapped++; assert.ok(same(got.other, S(A(cursor, X(blink)))), `wrapped ${got.other} against ${S(A(cursor, X(blink)))}`); }
  }
  assert.ok(wrapped > 10000, `the wrap ran only ${wrapped} times`);
});

test('timeStep: the model\'s two stored values', () => {
  let passedCount = 0;
  for (let i = 0; i < 200000; i++) {
    const delta = value(), throttle = value(), current0 = value(), last = value(), interval = value();
    const got = kernel.timeStep(delta, throttle, current0, last, interval);
    const current = A(M(X(delta), X(throttle)), X(current0));
    assert.ok(same(got.stored, S(current)), `time ${got.stored} against ${S(current)} for ${delta} ${throttle} ${current0}`);
    const passed = gt(sub(current, X(last)), X(interval));
    assert.equal(got.flag, passed, `${delta} ${throttle} ${current0} ${last} ${interval}`);
    if (passed) { passedCount++; assert.ok(same(got.other, S(A(current, X(interval)))), 'next'); }
  }
  assert.ok(passedCount > 1000, `the passed branch ran only ${passedCount} times`);
});

test('timeStep at the values a running window holds', () => {
  const delta = f(1 / 60);
  for (const throttle of [1, 0.5, f(0.3), 2, f(1.7)]) {
    let t = 0;
    for (let i = 0; i < 6000; i++) {
      const got = kernel.timeStep(delta, throttle, t, f(t - 0.05), f(0.1));
      const expected = S(A(M(X(delta), X(throttle)), X(t)));
      assert.ok(same(got.stored, expected), `${throttle} at ${i}: ${got.stored} against ${expected}`);
      t = got.stored;
    }
  }
});

test('fadeStep: the model\'s stored value and the zeroing flag', () => {
  let zeroed = 0;
  for (let i = 0; i < 200000; i++) {
    const v = value(), delta = value(), got = kernel.fadeStep(v, delta);
    const stored = S(sub(X(v), X(delta)));
    assert.ok(same(got.stored, stored), `${v} - ${delta}: ${got.stored} against ${stored}`);
    const below = lt(X(stored), X(0));
    assert.equal(got.flag, below, `${v} - ${delta}`);
    if (below) zeroed++;
  }
  assert.ok(zeroed > 10000, `the zeroing ran only ${zeroed} times`);
});

test('fadeOutStep: the model\'s held timer and the completed flag', () => {
  let completed = 0;
  for (let i = 0; i < 200000; i++) {
    const timer = value(), delta = value(), got = kernel.fadeOutStep(timer, delta);
    let fade = sub(X(timer), X(delta));
    if (!lt(X(0), fade)) fade = X(0);
    assert.ok(same(got.stored, S(fade)), `${timer} - ${delta}: ${got.stored} against ${S(fade)}`);
    assert.equal(got.flag, eq(fade, X(0)), `${timer} - ${delta}`);
    if (got.flag) completed++;
  }
  assert.ok(completed > 5000, `the completed flag ran only ${completed} times`);
});
