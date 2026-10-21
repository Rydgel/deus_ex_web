import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IST, MAX_NOTCHES_PER_EVENT, WHEEL_DELTA, WHEEL_IDLE_MS, createWheelAccumulator, wheelMessage, wheelUnits,
} from '../src/viewer/wheel-input.mjs';
import { GAME_KEY_CODES, inputKeyNameForCode } from '../src/viewer/input-key-names.mjs';

const PIXEL = 0, LINE = 1, PAGE = 2;

test('WM_MOUSEWHEEL is IK_MouseW with the raw delta, then the wheel key pressed and released (WinDrv 0x1110b29e)', () => {
  assert.deepEqual(wheelMessage(120), [
    { name: 'MouseW', action: IST.axis, delta: 120 },
    { name: 'MouseWheelUp', action: IST.press, delta: 0 }, { name: 'MouseWheelUp', action: IST.release, delta: 0 }]);
  assert.deepEqual(wheelMessage(-120).map(({ name, action }) => [name, action]),
    [['MouseW', 4], ['MouseWheelDown', 1], ['MouseWheelDown', 3]]);
  assert.equal(wheelMessage(-120)[0].delta, -120);
  assert.deepEqual(wheelMessage(0), []);                       // a zero delta does nothing
  // Several notches in one message are still one press and release, with the whole delta on the axis.
  assert.equal(wheelMessage(360).length, 3); assert.equal(wheelMessage(360)[0].delta, 360);
  // HIWORD(wParam) is a signed 16-bit value (movsx).
  assert.equal(wheelMessage(0xff88)[0].delta, -120); assert.equal(wheelMessage(0xff88)[1].name, 'MouseWheelDown');
  assert.deepEqual(wheelMessage(0x10000), []);
});

test('wheel events are converted to Windows units: 120 per notch, positive away from the user', () => {
  // pixels: a notch is 100 px of deltaY, or the browser's own tick count in wheelDeltaY
  assert.equal(wheelUnits({ deltaMode: PIXEL, deltaY: -100 }), 120);
  assert.equal(wheelUnits({ deltaMode: PIXEL, deltaY: 100 }), -120);
  assert.equal(wheelUnits({ deltaMode: PIXEL, deltaY: 53, wheelDeltaY: -120 }), -120);   // Chromium on Linux: 53 px, 120 units
  assert.equal(wheelUnits({ deltaMode: PIXEL, deltaY: -53, wheelDeltaY: 120 }), 120);
  assert.equal(wheelUnits({ deltaMode: PIXEL, deltaY: 10, wheelDeltaY: 30 }), -12);       // a wheelDeltaY of the wrong sign is ignored
  assert.equal(wheelUnits({ deltaMode: PIXEL, deltaY: 10, wheelDeltaY: undefined }), -12);
  // lines: three to a notch (SPI_GETWHEELSCROLLLINES), pages: one notch each
  assert.equal(wheelUnits({ deltaMode: LINE, deltaY: 3 }), -120);
  assert.equal(wheelUnits({ deltaMode: LINE, deltaY: -1 }), 40);
  assert.equal(wheelUnits({ deltaMode: PAGE, deltaY: 1 }), -120);
  assert.equal(wheelUnits({ deltaMode: PAGE, deltaY: -2 }), 240);
  assert.equal(wheelUnits({ deltaMode: PIXEL, deltaY: 0, deltaX: 40 }), 0);               // a sideways scroll is no wheel notch
});

test('the accumulator cuts units into one-notch messages and keeps the remainder', () => {
  const wheel = createWheelAccumulator();
  assert.deepEqual(wheel.push(120, 0), [120]);
  assert.deepEqual(wheel.push(-120, 10), [-WHEEL_DELTA]);
  assert.deepEqual(wheel.push(240, 20), [120, 120]);          // reversed; 240 units are two notches in one browser event
  assert.deepEqual(wheel.push(120, 20), [120]);
  const touchpad = createWheelAccumulator();
  const notches = [];
  for (let k = 0; k < 10; k++) notches.push(...touchpad.push(-35, k * 16));   // 350 units in ten small events
  assert.deepEqual(notches, [-120, -120]);
  assert.equal(touchpad.pending, -350 + 240);
});

test('a reversal or a pause drops the partial notch; a spin is bounded', () => {
  const wheel = createWheelAccumulator();
  assert.deepEqual(wheel.push(80, 0), []);
  assert.deepEqual(wheel.push(-80, 10), []);                  // reversed: back to zero, then -80
  assert.equal(wheel.pending, -80);
  assert.deepEqual(wheel.push(-80, 20), [-120]);
  assert.equal(wheel.pending, -40);
  assert.deepEqual(wheel.push(-80, 20 + WHEEL_IDLE_MS + 1), []);   // after a pause the old -40 is forgotten
  assert.equal(wheel.pending, -80);
  const spin = createWheelAccumulator();
  assert.equal(spin.push(120 * 50, 0).length, MAX_NOTCHES_PER_EVENT);
  assert.equal(spin.pending, 0);
  assert.deepEqual(spin.push(NaN, 1), []);
});

test('every code the page takes maps to an original key (Keyboard Lock list, preventDefault)', () => {
  assert.equal(new Set(GAME_KEY_CODES).size, GAME_KEY_CODES.length);
  for (const code of GAME_KEY_CODES) assert.ok(inputKeyNameForCode(code), code);
  for (const code of ['Escape', 'Tab', 'F1', 'F3', 'F5', 'F6', 'F7', 'F11', 'F12', 'Pause', 'CapsLock', 'ControlLeft', 'AltRight'])
    assert.ok(GAME_KEY_CODES.includes(code), code);
});
