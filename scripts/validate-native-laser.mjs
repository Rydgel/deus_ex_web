// ULaserIterator::CurrentItem (DeusEx.dll 0x1001a1a0) against
// src/runtime/script-laser.mjs laserCurrentItem (docs/lasers.md). Each case
// is one frame of the iterator protocol after the script Init: Index walks
// 0..MaxItems-1 over 1-3 active beams (inactive ones between), straight and
// bRandomBeam, with AddBeam's numSegments and edge cases (zero segments, an
// Index past every beam, savedLoc already moved, no proxy). Compared per
// item: every FarMoveActor/MoveActor argument, prevLoc, prevRand, savedLoc,
// savedRot, nextItem and the appFrand draws.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { gameDirectory } from './game-directory.mjs';
import { laserCurrentItem } from '../src/runtime/script-laser.mjs';

const python = process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python';
const io = new DataView(new ArrayBuffer(4));
const bits = v => (io.setFloat32(0, v, true), io.getUint32(0, true));
const num = b => (io.setUint32(0, b >>> 0, true), io.getFloat32(0, true));
let seed = 0x2545f491;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const between = (a, b) => Math.fround(a + (b - a) * random());
const vec = s => [between(-s, s), between(-s, s), between(-s, s)];
const rot = () => [Math.floor(random() * 65536) - 32768, Math.floor(random() * 65536), Math.floor(random() * 65536)];

const cases = [];
for (let c = 0; c < 160; c++) {
  const randomBeam = c % 2 === 1, owner = vec(4000);
  const beams = Array.from({ length: 8 }, () => ({ active: 0, location: [0, 0, 0], rotation: [0, 0, 0], length: 0, numSegments: 0 }));
  const active = 1 + (c % 3);
  for (let k = 0; k < active; k++) {
    const slot = k === 0 ? 0 : Math.min(7, k * 2 + (c % 2));
    const length = c % 17 === 0 ? 0 : between(0, c % 5 === 0 ? 5000 : 600);
    // AddBeam: (len / 15 or 16) + 1, FloatToInt truncation.
    const numSegments = c % 23 === 5 && k === 0 ? 0 : Math.trunc(Math.fround(length / (randomBeam ? 15 : 16)) + 1);
    beams[slot] = { active: 1, location: k ? vec(4000) : owner.map((v, i) => Math.fround(v + (i - 1) * 3)), rotation: rot(), length, numSegments };
  }
  const total = beams.reduce((n, b) => n + (b.active ? b.numSegments : 0), 0);
  const maxItems = c % 29 === 3 ? 0 : total + 1;
  const indices = c % 13 === 7 ? [0, total, total + 2] : Array.from({ length: Math.min(maxItems, 60) }, (_, i) => i);
  cases.push({
    ownerLocation: owner, beams, maxItems, indices, randomBeam: randomBeam ? 1 : 0, hasProxy: c % 31 !== 9,
    prevLoc: c % 7 === 4 ? vec(4000) : owner, prevRand: c % 3 === 0 ? [0, 0, 0] : vec(1),
    savedLoc: c % 11 === 6 ? vec(4000) : owner, savedRot: c % 11 === 6 ? rot() : [0, 0, 0],
    nextItem: c % 19 === 2 ? 5 : 0,
    frand: Array.from({ length: 4000 }, () => random()),
  });
}
const toBits = c => ({ ...c, ownerLocation: c.ownerLocation.map(bits), prevLoc: c.prevLoc.map(bits), prevRand: c.prevRand.map(bits),
  savedLoc: c.savedLoc.map(bits), beams: c.beams.map(b => ({ ...b, location: b.location.map(bits), length: bits(b.length) })) });
const reference = JSON.parse(execFileSync(python, ['scripts/native-laser-oracle.py', gameDirectory()],
  { input: JSON.stringify(cases.map(toBits)), encoding: 'utf8', maxBuffer: 1 << 28 }));

let items = 0, moves = 0, randomItems = 0, saved = 0, draws = 0;
cases.forEach((c, ci) => {
  const state = { beams: c.beams.map(b => ({ ...b, active: Boolean(b.active) })), index: 0, maxItems: c.maxItems,
    prevLoc: c.prevLoc.slice(), prevRand: c.prevRand.slice(), savedLoc: c.savedLoc.slice(), savedRot: c.savedRot.slice(),
    nextItem: c.nextItem, randomBeam: Boolean(c.randomBeam), hasProxy: c.hasProxy };
  const queue = c.frand.slice(), frand = () => { draws++; return queue.shift(); };
  c.indices.forEach((index, ii) => {
    const expected = reference.results[ci][ii], where = `case ${ci} index ${index}`;
    state.index = index;
    const result = laserCurrentItem(state, c.ownerLocation, frand);
    assert.equal(result ? 'proxy' : 'owner', expected.returned, `${where}: returned`);
    const calls = (result ?? []).map(m => m.location ? { far: [true, ...m.location.map(bits), 0, 0] }
      : { move: [true, [0, 0, 0], m.rotation, [0, 0, 0, 0]] });
    assert.deepEqual(calls, expected.calls, `${where}: proxy moves`);
    assert.deepEqual(state.prevLoc.map(bits), expected.prevLoc, `${where}: prevLoc`);
    assert.deepEqual(state.prevRand.map(bits), expected.prevRand, `${where}: prevRand`);
    assert.deepEqual(state.savedLoc.map(bits), expected.savedLoc, `${where}: savedLoc`);
    assert.deepEqual(state.savedRot, expected.savedRot, `${where}: savedRot`);
    assert.equal(state.nextItem, expected.nextItem, `${where}: nextItem`);
    assert.equal(queue.length, expected.frandLeft, `${where}: appFrand draws`);
    items++; moves += calls.length; if (c.randomBeam && result) randomItems++;
    if (state.savedLoc.some((v, i) => v !== c.ownerLocation[i])) saved++;
  });
});
assert.ok(randomItems > 1000 && saved > 100, 'cases reach the random beam and the savedLoc branch');
console.log(`ULaserIterator::CurrentItem: ${items} items over ${cases.length} iterators match the original (${moves} proxy moves, ${randomItems} random-beam items, ${draws} appFrand draws).`);
