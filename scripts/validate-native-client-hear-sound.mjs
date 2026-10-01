// Original APawn::execClientHearSound, AActor::execStopSound and the
// standalone AActor::ProcessRemoteFunction against their JS translations
// (script-sound.mjs, process-remote-function.mjs). The oracle runs the
// hash-pinned Engine.dll bodies on fabricated objects
// (scripts/native-client-hear-sound-oracle.py); floats compare as bits.
//
//   node scripts/validate-native-client-hear-sound.mjs
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {execPawnClientHearSound, execActorStopSound} from '../src/runtime/script-sound.mjs';
import {actorProcessRemoteFunction} from '../src/runtime/process-remote-function.mjs';

const io = new DataView(new ArrayBuffer(4));
const bits = value => { io.setFloat32(0, value, true); return io.getUint32(0, true); };
const float = word => { io.setUint32(0, word >>> 0, true); return io.getFloat32(0, true); };
let seed = 0x5eed1234;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
const SPECIAL = [0, 0x80000000, 0x7fc00000, 0xffc00000, 0x7f800001, 0x7f800000, 0xff800000, 1, 0x807fffff,
  0x7f7fffff, 0x3f800000, 0x42c80000, 0xc2c80000, 0x00800000, 0x3c23d70a, 0x4f000000, 0x447a0000];
const word = () => random() % 3 === 0 ? SPECIAL[random() % SPECIAL.length]
  : random() % 2 ? random() : bits(((random() % 200000) - 100000) / 64);

const cases = [];
const base = {kind: 'hear', pawnClass: 'exact', player: 'exact', audio: true, actor: 'live', actorFlags: 0, id: 547874,
  location: [bits(1), bits(-2), bits(3.5)], parameters: [bits(100), bits(0), bits(100)]};
// Every gate: PlayerPawn ancestry, the Player viewport, Audio, bDeleteMe.
for (const pawnClass of ['exact', 'sub', 'other'])
  for (const player of ['none', 'exact', 'sub', 'other'])
    for (const audio of [true, false])
      for (const [actor, actorFlags] of [['none', 0], ['live', 0], ['live', 0x7f], ['live', 0x80], ['live', 0xff]])
        cases.push({...base, pawnClass, player, audio, actor, actorFlags});
// Parameter arithmetic: Volume/Pitch scale, the Radius zero/unordered test.
for (let i = 0; i < 400; i++)
  cases.push({...base, id: random() | 0, location: [word(), word(), word()], parameters: [word(), word(), word()]});
for (const id of [0, 1, -1, 0x7fffffff, -0x80000000, 547874, random() | 0])
  for (const audio of [true, false]) cases.push({kind: 'stop', audio, id});
for (const functionFlags of [0, 0x400, 0x500, 0x2400, 0x2000, 0x100, 0xffffffff])
  for (const role of [0, 1, 2, 3, 4, 255])
    for (const actorFlags of [0, 0x80])
      for (const demo of [null, 'server'])
        cases.push({kind: 'remote', functionFlags, role, actorFlags, ...(demo ? {demo} : {}), netMode: 0});

const dir = path.resolve('reports/audio');
await mkdir(dir, {recursive: true});
const casesPath = path.join(dir, 'client-hear-sound-cases.json');
await writeFile(casesPath, JSON.stringify(cases));
const {stdout} = await promisify(execFile)(process.env.NATIVE_PROBE_PYTHON ?? 'python3',
  ['scripts/native-client-hear-sound-oracle.py', gameDirectory(), casesPath], {maxBuffer: 64 * 1024 * 1024});
const native = JSON.parse(stdout);
assert.equal(native.results.length, cases.length);

const mismatches = [];
const tally = {hear: 0, played: 0, stop: 0, remote: 0, absorbed: 0, signalingLocation: 0};
for (let i = 0; i < cases.length; i++) {
  const c = cases[i], expected = native.results[i];
  tally[c.kind]++;
  try {
    if (c.kind === 'hear') {
      const calls = [];
      const objects = {pawn: {name: 'Pawn'}, player: {name: 'Player'}, xlevel: {name: 'XLevel'}, engine: {name: 'Engine'},
        actor: {name: 'Actor'}, sound: {name: 'Sound'}};
      const audio = {name: 'Audio', playSound: (actor, id, sound, location, volume, radius, pitch) => calls.push({op: 'play',
        this: 'Audio', actor: actor?.name ?? 0, id, sound: sound.name, location: location.map(bits), volume: bits(volume),
        radius: bits(radius), pitch: bits(pitch)})};
      const ancestry = {exact: true, sub: true, other: false};
      const services = {
        isA: (object, key) => key === 'Engine.PlayerPawn' ? (object === objects.pawn && ancestry[c.pawnClass])
          : key === 'Engine.Viewport' ? (object === objects.player && ancestry[c.player]) : assert.fail(`isA ${key}`),
        read: (object, name) => {
          if (object === objects.pawn && name === 'Player') return c.player === 'none' ? null : objects.player;
          if (object === objects.pawn && name === 'XLevel') return objects.xlevel;
          if (object === objects.xlevel && name === 'Engine') return objects.engine;
          if (object === objects.engine && name === 'Audio') return c.audio ? audio : null;
          if (object === objects.actor && name === 'bDeleteMe') return Boolean(c.actorFlags & 0x80);
          throw new Error(`unexpected read ${object.name}.${name}`);
        },
      };
      const args = [c.actor === 'none' ? null : objects.actor, c.id, objects.sound, c.location.map(float), c.parameters.map(float)];
      execPawnClientHearSound(objects.pawn, args, services);
      // The native copies SoundLocation with integer moves, so a signaling
      // NaN survives; a JS number cannot hold a float32 sNaN (the conversion
      // quiets it), so the runtime's floats never carry one. Expect the
      // quieted word for exactly those inputs (host representation limit).
      const quieted = expected.calls.map(call => ({...call, location: call.location.map(w =>
        (w & 0x7f800000) === 0x7f800000 && (w & 0x7fffff) && !(w & 0x400000) ? (w | 0x400000) >>> 0 : w)}));
      if (JSON.stringify(quieted) !== JSON.stringify(expected.calls)) tally.signalingLocation++;
      assert.deepEqual(calls, quieted);
      assert.equal(expected.codeAdvance, 6, 'five P_GETs and P_FINISH');
      if (calls.length) tally.played++;
    } else if (c.kind === 'stop') {
      const calls = [], receiver = {name: 'Actor'}, xlevel = {}, engine = {};
      const audio = {stopSoundId: id => calls.push({op: 'stop', this: 'Audio', id})};
      const services = {read: (object, name) => object === receiver && name === 'XLevel' ? xlevel
        : object === xlevel && name === 'Engine' ? engine : object === engine && name === 'Audio' ? (c.audio ? audio : null)
          : assert.fail(`unexpected read ${name}`)};
      execActorStopSound({receiver, argumentCount: 1, evaluateArgument: () => c.id}, services);
      assert.deepEqual(calls, expected.calls);
      assert.equal(expected.codeAdvance, 2, 'one P_GET and P_FINISH');
    } else {
      const actor = {}, xlevel = {}, info = {}, driver = {}, connection = {};
      const read = (object, name) => {
        if (object === actor) return {bDeleteMe: Boolean(c.actorFlags & 0x80), Role: c.role, XLevel: xlevel, Level: info}[name];
        if (object === xlevel && name === 'DemoRecDriver') return c.demo ? driver : null;
        if (object === driver && name === 'ServerConnection') return c.demo === 'server' ? connection : null;
        if (object === info && name === 'NetMode') return c.netMode;
        throw new Error(`unexpected read ${name}`);
      };
      const result = actorProcessRemoteFunction(actor, c.functionFlags >>> 0, {read});
      assert.equal(result, expected.result);
      if (result) tally.absorbed++;
    }
  } catch (error) {
    mismatches.push({i, case: c, expected, message: error.message.slice(0, 600)});
  }
}
await writeFile(path.join(dir, 'client-hear-sound-comparison.json'),
  JSON.stringify({cases: cases.length, tally, hashes: native.hashes, mismatches: mismatches.slice(0, 20)}, null, 1));
console.log(JSON.stringify({cases: cases.length, tally, mismatches: mismatches.length, first: mismatches[0]}));
assert.equal(mismatches.length, 0);
assert.ok(tally.played > 300 && tally.absorbed > 0, 'every branch reached');
