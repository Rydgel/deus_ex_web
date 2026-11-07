import test from 'node:test';
import assert from 'node:assert/strict';
import {loadScriptVmKernel} from '../src/runtime/script-vm-kernel.mjs';
import {setX87Precision} from '../src/runtime/script-vm.mjs';
import {fcoordsAxesReference} from '../src/runtime/script-pawn-locomotion.mjs';

// percep.rs fcoords_axes keeps the last 32 distinct rotations' axes (a pure function of the rotation, the x87 precision control and the
// sine table). The kernel's FCoords must equal the BigInt body (fcoordsAxesReference) for a rotation asked for the first time, again
// from the memo, after other rotations hashed to the same slot, and at the other precision control.
const kernel = await loadScriptVmKernel();
const words = fields => fields.map(v => v.map(x => Math.fround(x)));

let seed = 0x1badb002;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const angle = () => random() % 5 === 0 ? [0, 0x4000, 0x8000, 0xc000, -0x4000, 0x7fffffff, -0x80000000, 1, 3, 4][random() % 10] : random() | 0;
const rotations = Array.from({length: 400}, () => [angle(), angle(), angle()]);

test('FCoords from the kernel equal the BigInt body, asked once and again', () => {
  setX87Precision(64); kernel.setPrecision(64);
  for (const rotation of rotations) {
    const want = words(fcoordsAxesReference(rotation));
    assert.deepEqual(words(kernel.fcoordsAxes(rotation)), want, `first ask ${rotation}`);
    assert.deepEqual(words(kernel.fcoordsAxes(rotation)), want, `second ask ${rotation}`);
  }
});

test('FCoords stay right when many rotations share the memo, in any order', () => {
  setX87Precision(64); kernel.setPrecision(64);
  const wanted = rotations.map(r => words(fcoordsAxesReference(r)));
  for (let round = 0; round < 3; round++)
    for (let k = 0; k < rotations.length; k++) {
      const i = round === 1 ? rotations.length - 1 - k : (k * 7 + round) % rotations.length;
      assert.deepEqual(words(kernel.fcoordsAxes(rotations[i])), wanted[i], `round ${round} rotation ${rotations[i]}`);
    }
});

test('FCoords are keyed by the precision control', () => {
  try {
    for (const rotation of rotations.slice(0, 60)) {
      setX87Precision(64); kernel.setPrecision(64);
      const wide = words(kernel.fcoordsAxes(rotation));
      assert.deepEqual(wide, words(fcoordsAxesReference(rotation)), `64 ${rotation}`);
      setX87Precision(24); kernel.setPrecision(24);
      assert.deepEqual(words(kernel.fcoordsAxes(rotation)), words(fcoordsAxesReference(rotation)), `24 ${rotation}`);
      setX87Precision(64); kernel.setPrecision(64);
      assert.deepEqual(words(kernel.fcoordsAxes(rotation)), wide, `64 again ${rotation}`);
    }
  } finally { setX87Precision(64); kernel.setPrecision(64); }
});
