/** Original-DLL same-heap diff for AActor::performPhysics's dispatch/brackets.
 * Movement routines are explicit boundary doubles here; their separate oracles
 * remain authoritative for the body. No Play or latent calls are driven. */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {performActorPhysics} from '../src/runtime/actor-physics.mjs';
import {gameDirectory} from './game-directory.mjs';
const f = Math.fround, cases = [];
const offsets = {Physics: 0x30, Location: 0x114, OldLocation: 0x12c, Velocity: 0x144, RotationRate: 0x1fc, PendingTouch: 0x21c};
function vectorBytes(vector, integers = false) {
  const result = Buffer.alloc(12);
  vector.forEach((value, axis) => integers ? result.writeInt32LE(value, axis * 4) : result.writeFloatLE(value, axis * 4));
  return result;
}
function add({physics, seconds = 1 / 60, location = [0, 0, 0], after = [0, 0, 0], oldAfter,
  rate = [0, 0, 0], rateAfter, physicsAfter} = {}) {
  const heap = Buffer.alloc(0x400);
  heap.writeUInt8(physics, offsets.Physics);
  for (const [field, value] of Object.entries({Location: location, OldLocation: [12, 34, 56], Velocity: [123, -456, 789], RotationRate: rate}))
    vectorBytes(value, field === 'RotationRate').copy(heap, offsets[field]);
  const bodyPatches = [[offsets.Location, vectorBytes(after).toString('hex')]];
  if (oldAfter) bodyPatches.push([offsets.OldLocation, vectorBytes(oldAfter).toString('hex')]);
  if (rateAfter) bodyPatches.push([offsets.RotationRate, vectorBytes(rateAfter, true).toString('hex')]);
  if (physicsAfter !== undefined) bodyPatches.push([offsets.Physics, Buffer.from([physicsAfter]).toString('hex')]);
  cases.push({heap: heap.toString('hex'), seconds: f(seconds), bodyPatches});
}
// Every switch entry, the unsigned out-of-range entries and low-word rotation gate.
for (const physics of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 255])
  for (const rate of [[0, 0, 0], [65536, -65536, 0], [0, 1, 0]]) add({physics, rate, location: [1, 2, 3], after: [4, -5, 6]});
// Body writes observed by the wrapper and tail, including changed Physics.
for (const physics of [2, 6, 7, 8, 9, 11]) {
  add({physics, location: [-220, 800, -64], after: [-220, 791.25, -64], rateAfter: [0, 1, 0], physicsAfter: 0});
  add({physics, location: [1, 2, 3], after: [4, 5, 6], oldAfter: [7, 8, 9], rate: [1, 0, 0], rateAfter: [65536, 0, 0]});
}
// The stored X/Y reciprocal can differ by one ULP from Z's extended result.
for (const physics of [8, 9]) for (const seconds of [1/60, 1/120, .005, .1, .4, 1/3])
  for (const [location, after] of [
    [[-220, 800, -64], [-220, 791.25, -64]],
    [[0, 0, 0], [1, 1, 1]],
    [[100000, -100000, 100000], [.01, -.01, .01]],
    [[-1e-20, 1e-20, -1e-20], [1e20, -1e20, 1e20]],
  ]) add({physics, seconds, location, after});
// Execute the actual mover body before its bInterpolating/dt gate. KeyNum's
// clamp is local (no actor write); no interpolation storage is needed here.
for (const key of [0, 7, 8, 255]) for (const gate of ['idle', 'zero-dt', 'not-mover']) {
  add({physics: 9, seconds: gate === 'zero-dt' ? 0 : 1/60});
  const input = cases.at(-1), heap = Buffer.from(input.heap, 'hex');
  heap.writeUInt32LE(gate === 'not-mover' ? 0 : 0x1058bb58, 0x24);
  heap.writeUInt32LE(gate === 'idle' ? 0 : 0x80, 0x1ec);
  heap.writeUInt8(key, 0x377);
  input.heap = heap.toString('hex'); input.bodyPatches = []; input.realMovingBrushGate = true;
}
const directory = 'reports/movement/native-actor-physics';
await mkdir(directory, {recursive:true});
const inputPath = `${directory}/cases.json`;
await writeFile(inputPath, JSON.stringify(cases));
const {stdout} = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python',
  ['scripts/native-actor-physics-oracle.py', gameDirectory(), inputPath], {maxBuffer: 16*1024*1024});
const original = JSON.parse(stdout);
await writeFile(`${directory}/original.json`, stdout);
const mismatches = [], methods = ['physFalling', 'physProjectile', 'physRolling', 'physPathing', 'physMovingBrush', 'physTrailer', 'physicsRotation'];
for (const [index, input] of cases.entries()) {
  const heap = Buffer.from(input.heap, 'hex'), events = [], actor = {};
  const read = (_, name) => {
    const offset = offsets[name];
    if (name === 'Physics') return heap.readUInt8(offset);
    if (name === 'PendingTouch') return null;
    return [0,1,2].map(axis => name === 'RotationRate' ? heap.readInt32LE(offset+axis*4) : heap.readFloatLE(offset+axis*4));
  };
  const write = (_, name, value) => vectorBytes(value).copy(heap, offsets[name]);
  const services = {read, write, unsupported: (_, what) => {throw new Error(what);}};
  for (const name of methods) services[name] = (_, seconds) => {
    const event = {body: name, seconds};
    if (['physFalling','physProjectile','physRolling'].includes(name)) event.iterations = 0;
    events.push(event);
    if (name !== 'physicsRotation') for (const [offset, bytes] of input.bodyPatches) Buffer.from(bytes, 'hex').copy(heap, offset);
  };
  performActorPhysics(actor, input.seconds, services);
  const actual = {heap: heap.toString('hex'), events};
  try {assert.deepEqual(actual, original.results[index]);}
  catch {mismatches.push({index, input, actual, expected: original.results[index]});}
}
await writeFile(`${directory}/comparison.json`, JSON.stringify({cases:cases.length,mismatches}, null, 2));
console.log(JSON.stringify({cases:cases.length,mismatches:mismatches.length,hashes:original.hashes}));
assert.equal(mismatches.length, 0, 'original AActor::performPhysics dispatch and complete actor heap diff');
