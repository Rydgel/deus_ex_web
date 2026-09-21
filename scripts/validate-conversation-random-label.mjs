/** Focused validation of the ConEventRandomLabel natives (ConSys.dll
 * 2060 GetLabelCount / 2061 GetLabel / 2062 GetRandomLabel), recovered from the
 * hash-pinned ConSys.dll bodies at 0x1000a0c0 / 0x1000a110 / 0x1000a270.
 *
 * Evidence: docs/script-instructor-conversation.md,
 * src/runtime/script-conversation-random-label.mjs. The MunitionsTrooperFrob
 * event-list head (DeusExConText.ConEventRandomLabel3) decodes to
 * ["A1".."A5"] with bCycleEvents=bCycleRandom=true, so GetRandomLabel returns
 * the five labels in order (cycleIndex 0..4) and then draws appRand()%5 once
 * bLabelsCycled is set — exactly the recovered body. Requires the local game
 * install. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { readObject } from '../src/unreal/objects.mjs';
import { Reader } from '../src/unreal/package.mjs';
import { gameDirectory } from './game-directory.mjs';
import {
  decodeRandomLabelLabels, getLabelCount, getLabel, getRandomLabel,
} from '../src/runtime/script-conversation-random-label.mjs';
import { createNativeRng } from '../src/runtime/rng.mjs';

const root = gameDirectory();

// --- 1. Pure decode of the authored labels from the package -----------------
const conText = await new AssetStore([{ path: 'System/DeusExConText.u',
  read: () => readFile(`${root}/System/DeusExConText.u`) }]).get('DeusExConText');
const conP = conText.pkg;
const rlIndex = conP.exports.findIndex(e => e.name === 'ConEventRandomLabel3' && e.className === 'ConEventRandomLabel');
assert.ok(rlIndex >= 0, 'ConEventRandomLabel3 export present');
const stored = readObject(conP, conText.bytes, rlIndex + 1);
const labels = decodeRandomLabelLabels(stored.reader, conP.version);
assert.deepEqual(labels, ['A1', 'A2', 'A3', 'A4', 'A5'], 'MunitionsTrooperFrob random labels decode');
assert.equal(stored.reader.offset, conP.exports[rlIndex].serialSize, 'labels payload consumes the whole export');

// --- 2. GetLabelCount / GetLabel edges --------------------------------------
assert.equal(getLabelCount(labels), 5);
assert.deepEqual([0, 1, 2, 3, 4].map(i => getLabel(labels, i)), labels);
assert.equal(getLabel(labels, -1), '', 'out-of-range index returns the empty string');
assert.equal(getLabel(labels, 5), '', 'index==Num returns the empty string');

// --- 3. GetRandomLabel cycle: sequential A1..A5, then appRand()%5 -----------
// bCycleEvents=true, bCycleRandom=true (as authored). Reproduce the recovered
// body's mutation of cycleIndex/bLabelsCycled.
const rng = createNativeRng(1);
const flags = { bCycleEvents: true, bCycleOnce: false, bCycleRandom: true };
const state = { cycleIndex: 0, bLabelsCycled: false };
const picks = [];
for (let call = 0; call < 5; call++) {
  const r = getRandomLabel(labels, flags, state, () => rng.rand());
  picks.push(r.label);
  state.cycleIndex = r.cycleIndex; state.bLabelsCycled = r.bLabelsCycled;
}
assert.deepEqual(picks, ['A1', 'A2', 'A3', 'A4', 'A5'], 'first five picks are sequential');
assert.equal(state.cycleIndex, 5);
// Sixth call: cycleIndex==Num -> bLabelsCycled set -> random branch.
const before = rng.state;
const sixth = getRandomLabel(labels, flags, state, () => rng.rand());
assert.equal(state.cycleIndex, 5, 'random branch does not advance cycleIndex');
assert.equal(sixth.bLabelsCycled, true);
assert.ok(labels.includes(sixth.label), 'random pick is one of the labels');
assert.notEqual(rng.state, before, 'random branch consumed the shared appRand stream');

// A non-cycling event (bCycleEvents=false) is random from the first call.
const rng2 = createNativeRng(7);
const pureRandom = getRandomLabel(labels, { bCycleEvents: false, bCycleOnce: false, bCycleRandom: false },
  { cycleIndex: 0, bLabelsCycled: false }, () => rng2.rand());
assert.ok(labels.includes(pureRandom.label));

// --- 4. Integrated native path through the live runtime ---------------------
const files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({ path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`) });
const assets = new AssetStore(files);
const mapAsset = await assets.get('00_Training');
const map = decodeMap(mapAsset.bytes);
const { createGame } = await import('../src/viewer/game.mjs');
const game = await createGame(map, mapAsset, assets, { randomSeed: 1 });
const runtime = game.doors.scriptRuntime.runtime;
const randomLabelObject = await runtime.objects.resolve(conText, rlIndex + 1);
await runtime.prepareObject(randomLabelObject);
assert.deepEqual(runtime.instance(randomLabelObject).randomLabels, labels, 'runtime attached the decoded labels');
const invoke = index => runtime.invokeNative({ index, receiver: randomLabelObject,
  argumentCount: 0, evaluateArgument: () => undefined });
assert.equal(invoke(2060), 5, 'native GetLabelCount');
assert.equal(runtime.invokeNative({ index: 2061, receiver: randomLabelObject, argumentCount: 1,
  evaluateArgument: () => 2 }), 'A3', 'native GetLabel(2)');
const nativePicks = [];
for (let i = 0; i < 5; i++) nativePicks.push(invoke(2062));
assert.deepEqual(nativePicks, ['A1', 'A2', 'A3', 'A4', 'A5'], 'native GetRandomLabel cycles A1..A5');
assert.equal(runtime.namedReference(randomLabelObject, 'cycleIndex').get(), 5, 'native wrote cycleIndex');
assert.equal(runtime.namedReference(randomLabelObject, 'bLabelsCycled').get(), false, 'bLabelsCycled set only when cycleIndex==Num on the next call');
const sixthNative = invoke(2062);
assert.ok(labels.includes(sixthNative), 'sixth native pick is random');
assert.equal(runtime.namedReference(randomLabelObject, 'bLabelsCycled').get(), true);

console.log('ConEventRandomLabel natives validated: labels', labels.join(','),
  '; GetLabelCount/GetLabel/GetRandomLabel match the recovered ConSys.dll bodies (2060/2061/2062).');
