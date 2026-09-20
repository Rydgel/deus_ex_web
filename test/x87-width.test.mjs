import test from 'node:test';
import assert from 'node:assert/strict';
import {x87width} from '../src/runtime/script-vm.mjs';

test('x87 significand width is exact across limbs and the Number rounding boundary',()=>{
  assert.equal(x87width(0n),1);
  // Includes float significands, products, division/sqrt intermediates and
  // widely separated exponents. Values below 2^53/2^64 must not round up.
  for(const bits of [1,23,24,31,32,33,52,53,54,63,64,65,95,96,97,127,128,129,277]) {
    const power=1n<<BigInt(bits);
    assert.equal(x87width(power-1n),bits);
    assert.equal(x87width(power),bits+1);
    assert.equal(x87width(power+1n),bits+1);
  }
});
