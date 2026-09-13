/** Validate the hash-pinned Engine.dll FinishAnim native and its translated body. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  FINISH_ANIM_FLAGS,
  FINISH_ANIM_LATENT_ACTION,
  FINISH_ANIM_NATIVE_CONTRACT,
  dispatchFinishAnim,
  execFinishAnim,
  pollFinishAnim,
} from '../src/runtime/finish-anim.mjs';
import { gameDirectory } from './game-directory.mjs';

const root = gameDirectory();
const dll = new Uint8Array(await readFile(`${root}/System/Engine.dll`));
const expectedHash = FINISH_ANIM_NATIVE_CONTRACT.engineSha256;
assert.equal(createHash('sha256').update(dll).digest('hex'), expectedHash, 'Engine.dll hash');

const u16 = offset => dll[offset] | (dll[offset + 1] << 8);
const u32 = offset => (dll[offset] | (dll[offset + 1] << 8) |
  (dll[offset + 2] << 16) | (dll[offset + 3] << 24)) >>> 0;
const pe = u32(0x3c);
assert.deepEqual([...dll.subarray(pe, pe + 4)], [0x50, 0x45, 0, 0], 'PE signature');
const coff = pe + 4;
const sectionCount = u16(coff + 2);
const optionalSize = u16(coff + 16);
const optional = coff + 20;
assert.equal(u16(optional), 0x10b, 'PE32 optional header');
const imageBase = u32(optional + 28);
assert.equal(imageBase, 0x10300000, 'Engine image base');
const sections = [];
for (let index = 0; index < sectionCount; index++) {
  const section = optional + optionalSize + index * 40;
  sections.push({
    virtualAddress: u32(section + 12),
    virtualSize: u32(section + 8),
    rawOffset: u32(section + 20),
    rawSize: u32(section + 16),
  });
}
function rvaOffset(rva) {
  for (const section of sections) {
    const size = Math.max(section.virtualSize, section.rawSize);
    if (rva >= section.virtualAddress && rva < section.virtualAddress + size)
      return section.rawOffset + rva - section.virtualAddress;
  }
  throw new Error(`Engine RVA outside installed sections: 0x${rva.toString(16)}`);
}
function bytesAt(address, length) {
  const offset = rvaOffset(address - imageBase);
  return [...dll.subarray(offset, offset + length)];
}
function u32At(address) {
  const offset = rvaOffset(address - imageBase);
  return u32(offset);
}
function expectBytes(address, expected, label) {
  assert.deepEqual(bytesAt(address, expected.length), expected, label);
}
function thunkTarget(address) {
  const offset = rvaOffset(address - imageBase);
  assert.equal(dll[offset], 0xe9, `native thunk at 0x${address.toString(16)}`);
  const displacement = new DataView(dll.buffer, dll.byteOffset + offset + 1, 4).getInt32(0, true);
  return (address + 5 + displacement) >>> 0;
}

const contract = FINISH_ANIM_NATIVE_CONTRACT;
assert.equal(contract.nativeIndex, 261);
assert.equal(contract.latentAction, FINISH_ANIM_LATENT_ACTION);
expectBytes(contract.execThunk, contract.execThunkBytes, 'FinishAnim export thunk bytes');
assert.equal(thunkTarget(contract.execThunk), contract.execBody, 'FinishAnim thunk target');
expectBytes(contract.execBody, contract.execBodyBytes, 'FinishAnim body bytes');
expectBytes(contract.pollThunk, contract.pollThunkBytes, 'PollFinishAnim export thunk bytes');
assert.equal(thunkTarget(contract.pollThunk), contract.pollBody, 'PollFinishAnim thunk target');
expectBytes(contract.pollBody, contract.pollBodyBytes, 'PollFinishAnim body bytes');

const zeroSingle = contract.constants.zeroSingle;
const zeroDouble = contract.constants.zeroDouble;
expectBytes(zeroSingle.address, zeroSingle.bytes, 'FinishAnim fcomps zero constant');
expectBytes(zeroDouble.address, zeroDouble.bytes, 'FinishAnim fcompl zero constant');
assert.equal(new DataView(dll.buffer, dll.byteOffset + rvaOffset(zeroSingle.address - imageBase), 4)
  .getFloat32(0, true), zeroSingle.value);
assert.equal(new DataView(dll.buffer, dll.byteOffset + rvaOffset(zeroDouble.address - imageBase), 8)
  .getFloat64(0, true), zeroDouble.value);

assert.deepEqual(FINISH_ANIM_FLAGS, {AnimFinished: 0x08, AnimLoop: 0x10, AnimNotify: 0x20});
assert.equal(contract.actorOffsets.flags, 0x28);
assert.equal(contract.actorOffsets.animSequence, 0x54);
assert.equal(contract.actorOffsets.animFrame, 0x58);
assert.equal(contract.actorOffsets.animRate, 0x5c);
assert.equal(contract.actorOffsets.tweenRate, 0x60);
assert.equal(contract.actorOffsets.animLast, 0x220);
assert.equal(contract.stateFrameLatentOffset, 0x24);

const makeAnimation = (overrides = {}) => ({
  AnimSequence: 'Walk', AnimFrame: 0, AnimRate: 1, TweenRate: 1, AnimLast: 1,
  animFlags: 0, ...overrides,
});
const body = {animation: makeAnimation(), state: {latent: 9}};
dispatchFinishAnim(body);
assert.equal(body.state.latent, FINISH_ANIM_LATENT_ACTION, 'translated decoded body');
const raw = {animation: makeAnimation({animFlags: 0x1f}), frame: {code: 0x20}, state: {latent: 9}};
execFinishAnim(raw);
assert.equal(raw.frame.code, 0x21, 'translated raw FFrame increment');
assert.equal(raw.animation.animFlags, 0x07, 'translated conditional flag clear');
const poll = {animation: makeAnimation({animFlags: FINISH_ANIM_FLAGS.AnimFinished}), state: {latent: 9}};
pollFinishAnim(poll);
assert.equal(poll.state.latent, 0, 'translated latent poll');

console.log('Original Engine.dll FinishAnim261/0x181 passed hash, thunk/body-byte, zero-constant, flag-offset, x87-branch and translated dispatch checks.');
