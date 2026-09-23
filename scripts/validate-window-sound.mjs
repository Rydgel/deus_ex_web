/** Native1473 original exec/defaults/body, ending at the audio virtual leaf. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {dispatchWindowSoundNative, windowPlaySound} from '../src/runtime/script-window-sound.mjs';

const samples = [
  {name: 'default'}, {name: 'log-volume', args: [.75]},
  {name: 'explicit', args: [.3, 1.25, 300.25, -40]},
  {name: 'left-clamp', args: [-1, 1, -100, 0]},
  {name: 'right-clamp', args: [-1, 1, 1000, 0]},
  {name: 'hidden', hidden: true}, {name: 'mono', stereo: 0},
  {name: 'tiny-width', rootWidth: 0},
  {name: 'offsets', windowX: 30.125, rootX: 10, rotation: [1234, -17000, 23000]},
  {name: 'argument-resize', resizeOnVolume: [199.5, 70.25]},
  {name: 'null-sound', nullSound: true}, {name: 'no-root', noRoot: true},
  {name: 'no-pawn', noPawn: true},
];
const input = {gameRoot: gameDirectory(), samples};
const originalText = execFileSync(process.env.NATIVE_PROBE_PYTHON || path.resolve('.cache/native-probe-env/bin/python'),
  [path.resolve('scripts/native-window-sound-oracle.py')],
  {input: JSON.stringify(input), encoding: 'utf8', timeout: 30000, maxBuffer: 2 ** 20});
const directory = path.resolve('.cache/window-sound'); mkdirSync(directory, {recursive: true});
writeFileSync(path.join(directory, 'original-input.json'), JSON.stringify(input));
writeFileSync(path.join(directory, 'original.json'), originalText);
const original = JSON.parse(originalText), io = new DataView(new ArrayBuffer(4));
const bits = value => (io.setFloat32(0, value, true), io.getUint32(0, true));
assert.equal(original.hash, '93c35502d3c6fe61ecbecc7dba526d09281a9fbce16ee045061b1a4d8b916d9c');
for (const [index, s] of samples.entries()) {
  const pawn = {}, sound = {}, root = {0x28: 3, 0x588: s.noPawn ? null : pawn, 0x30: 1,
    0x5c0: s.stereo ?? 1, 0x80: s.rootWidth ?? 640, 0xd4: s.rootX ?? 0};
  const parent = {0x138: root, 0x30: s.hidden ? 0 : 1};
  const window = {0x138: s.noRoot ? null : parent, 0x30: 1, 0xd4: s.windowX ?? 0,
    0x80: (s.size ?? [100, 50])[0], 0x84: (s.size ?? [100, 50])[1], 0x114: s.volume ?? .5};
  const audio = [], evaluated = [], requests = [];
  const W = {u8: (o, k) => o[k] ?? 0, ptr: (o, k) => o[k] ?? null, f32: (o, k) => Math.fround(o[k] ?? 0),
    soundPawnFields: value => {assert.equal(value, pawn); return {location: s.location ?? [10, 20, 30], viewRotation: s.rotation ?? [2000, 1000, 4000]};},
    deferWindowSound: r => {requests.push(r); audio.push([0, 0, r.sound === sound,
      ...r.location.map(bits), bits(r.volume), bits(r.radius), bits(r.pitch)]);}};
  const result = dispatchWindowSoundNative(W, {index: 1473, receiver: window, argumentCount: 5,
    evaluateArgument(i) {
      evaluated.push(i);
      if (i === 1 && s.resizeOnVolume) [window[0x80], window[0x84]] = s.resizeOnVolume;
      return i === 0 ? s.nullSound ? null : sound : s.args?.[i - 1];
    }});
  assert.deepEqual(result, {handled: true, value: undefined});
  assert.deepEqual(evaluated, original.cases[index].events.map(row => row[1]), `${s.name}: argument order`);
  assert.deepEqual(audio, original.cases[index].audio, `${s.name}: final audio call`);
  assert.equal(original.cases[index].codeOffset, 6);
  if (requests.length) {
    const r = requests[0]; assert.equal(r.window, window); assert.equal(r.pawn, pawn); assert.equal(r.root, root);
    assert.deepEqual([r.requestedVolume, r.pitch, r.posX, r.posY].map(bits), original.cases[index].bodyArgs, `${s.name}: defaults`);
  }
  if (s.name === 'default') {
    audio.length = 0;
    windowPlaySound(W, window, sound, -1, 1);
    assert.deepEqual(audio, original.cases[index].audio, 'internal three-argument overload defaults');
  }
}
assert.deepEqual(dispatchWindowSoundNative({}, {index: 1474}), {handled: false});
console.log(`Window PlaySound: ${samples.length} original exec/body comparisons; defaults, evaluation order, and audio arguments bit-exact`);
