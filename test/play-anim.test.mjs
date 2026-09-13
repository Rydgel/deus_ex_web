import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {parsePackage} from '../src/unreal/package.mjs';
import {decodeLodMesh, findSequence} from '../src/runtime/lodmesh.mjs';
import {execPlayAnim, findAnimSeq} from '../src/runtime/play-anim.mjs';

const DECO = 'Deus Ex GOTY Edition/System/DeusExDeco.u';
const CHARACTERS = 'Deus Ex GOTY Edition/System/DeusExCharacters.u';
const f = Math.fround;
const floatFromBits = bits => {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits >>> 0, true);
  return view.getFloat32(0, true);
};

async function loadDeco() {
  return parsePackage(await fs.readFile(DECO));
}

// Reference values produced by executing the original Engine.dll
// ULodMesh::Serialize in scripts/native-lodmesh-oracle.py
// (docs/lodmesh-serialization.md).

test('LightSwitch mesh decodes the original AnimSeq table and bbox', async () => {
  const pkg = await loadDeco();
  const mesh = decodeLodMesh(pkg, pkg.bytes ?? (await fs.readFile(DECO)), 606);
  assert.equal(mesh.entry.name, 'LightSwitch');
  assert.equal(mesh.entry.serialSize, 1272);
  assert.deepEqual(mesh.boundingBox.min, [-960, -162, -1600]);
  assert.deepEqual(mesh.boundingBox.max, [960, 162, 1600]);
  assert.equal(mesh.boundingBox.valid, true);
  assert.equal(mesh.boundingSphere.radius, floatFromBits(0x44ea5980));
  assert.deepEqual(mesh.sequences.map(s => [s.name, s.group, s.startFrame, s.numFrames, s.notifyCount]), [
    ['All', 'None', 0, 2, 0],
    ['Still', 'None', 0, 1, 0],
    ['Off', 'None', 0, 1, 0],
    ['On', 'None', 1, 1, 0],
  ]);
  for (const sequence of mesh.sequences) assert.equal(sequence.rate, 30);
  assert.ok(mesh.eagerEnd < 1272);
});

test('Tree1 decodes through the AnimSeq boundary like the original serializer', async () => {
  const pkg = await loadDeco();
  const bytes = await fs.readFile(DECO);
  const mesh = decodeLodMesh(pkg, bytes, 454);
  assert.equal(mesh.entry.serialSize, 992);
  // scripts/native-lodmesh-oracle.py: Tree1 consumed 992 of 992 eagerly with
  // sequences All/Still; our decoder reaches the same AnimSeq content and
  // stops after it (the remaining byte order belongs to the Stage 4 renderer).
  assert.deepEqual(mesh.sequences.map(s => s.name), ['All', 'Still']);
  assert.ok(mesh.eagerEnd > 0 && mesh.eagerEnd < 992);
});

test('GM_Trench decodes multi-byte compact names and the original HitTorso sequence', async () => {
  const bytes = await fs.readFile(CHARACTERS);
  const pkg = parsePackage(bytes);
  const mesh = decodeLodMesh(pkg, bytes, 669);
  assert.equal(mesh.entry.name, 'GM_Trench');
  assert.equal(mesh.entry.serialSize, 1019128);
  assert.equal(mesh.sequences.length, 71);
  assert.deepEqual(mesh.sequences.slice(0, 5).map(sequence => sequence.name),
    ['All', 'Still', 'Walk', 'Run', 'CrouchWalk']);
  assert.deepEqual(findSequence(mesh, 'HitTorso'), {
    name: 'HitTorso', group: 'TakeHit', startFrame: 71, numFrames: 4,
    notifyCount: 0, notifies: [], rate: 10,
  });
  assert.equal(mesh.eagerEnd, 993850);
});

test('execPlayAnim guards return without animation writes', () => {
  const actor = {AnimSequence: 'None', animFlags: 0};
  const logs = [];
  execPlayAnim(actor, null, 'Off', 1, -1, (kind, details) => logs.push([kind, details]));
  assert.deepEqual(logs, [['playAnimNoMesh', {sequence: 'Off'}]]);
  assert.equal(actor.AnimSequence, 'None');
  assert.equal(actor.simAnim, undefined);
  const mesh = {entry: {name: 'LightSwitch'}, sequences: []};
  execPlayAnim(actor, mesh, 'Missing', 1, -1, (kind, details) => logs.push([kind, details]));
  assert.equal(logs[1][0], 'playAnimUnknownSequence');
  assert.equal(actor.simAnim, undefined);
});

test('execPlayAnim Off/On follows the NumFrames==1 and -1-tween branches', async () => {
  const pkg = await loadDeco();
  const bytes = await fs.readFile(DECO);
  const mesh = decodeLodMesh(pkg, bytes, 606);
  const actor = {AnimSequence: 'None', animFlags: 0};
  // First call with no previous sequence: TweenTime collapses to 0 and the
  // NumFrames==1 path takes the TweenRate=10 fallback (0x103e02a2).
  execPlayAnim(actor, mesh, 'Off', 1, -1);
  assert.equal(actor.AnimSequence, 'Off');
  assert.equal(actor.AnimFrame, f(1 / -1.0));
  assert.equal(actor.AnimRate, 0);
  assert.equal(actor.TweenRate, 10);
  assert.equal(actor.AnimLast, 0);
  assert.equal(actor.simAnim.frame, f(-1 * 10000.0));
  assert.equal(actor.simAnim.rate, 0);
  assert.equal(actor.simAnim.tween, f(10 * 1000.0));
  assert.equal(actor.animFlags & 0x39, 0);

  // Second call: previous sequence exists; 'On' still has NumFrames=1 so the
  // NumFrames==1 path keeps the TweenRate=10 fallback regardless of tween.
  execPlayAnim(actor, mesh, 'On', 1, -1);
  assert.equal(actor.AnimSequence, 'On');
  assert.equal(actor.TweenRate, 10);
  assert.equal(actor.simAnim.tween, f(10 * 1000.0));

  // Explicit positive TweenTime: TweenRate = NumFrames * TweenTime.
  execPlayAnim(actor, mesh, 'Off', 2, 0.5);
  assert.equal(actor.TweenRate, f(1 * 0.5));
  assert.equal(actor.simAnim.tween, f(0.5 * 1000.0));

  // NumFrames=2 'All' exercises the != 1 paths. A fresh actor has no previous
  // sequence so the tween collapses to 0 -> the "< 0 and != -1" branch.
  const fresh = {AnimSequence: 'None', animFlags: 0};
  execPlayAnim(fresh, mesh, 'All', 1, -1);
  assert.equal(fresh.AnimFrame, f(0.001));
  assert.equal(fresh.AnimLast, f(1.0 - 2));
  assert.equal(fresh.TweenRate, 0);
  assert.equal(fresh.AnimRate, f(1 * 30 / 2));
  assert.equal((fresh.animFlags & 0x20), 0);

  // With a previous sequence, TweenTime == -1 and OldAnimRate 0 gives
  // TweenRate = NumFrames * 0.025 (0x103e03a8).
  const again = {AnimSequence: 'Still', animFlags: 0};
  execPlayAnim(again, mesh, 'All', 1, -1);
  assert.equal(again.TweenRate, f(2 * 0.025));
  assert.equal(again.AnimFrame, f(2 / -1.0));

  // A negative OldAnimRate (the previous animation was velocity-scaled) takes
  // the norm path: TweenRate = max(-OldAnimRate * |Velocity|, AnimRate * .5).
  // Velocity magnitude 4, OldAnimRate -3 -> A = 12 > B = 7.5.
  const scaled = {AnimSequence: 'Still', animFlags: 0, OldAnimRate: -3, Velocity: [0, 0, 4]};
  execPlayAnim(scaled, mesh, 'All', 1, -1);
  assert.equal(scaled.TweenRate, 12);

  // A slower velocity leaves AnimRate * 0.5 in charge (B = 7.5 wins).
  const clamped = {AnimSequence: 'Still', animFlags: 0, OldAnimRate: -3, Velocity: [0, 0, 1]};
  execPlayAnim(clamped, mesh, 'All', 1, -1);
  assert.equal(clamped.TweenRate, 7.5);

  // A mesh with a non-empty notify table feeds the loop flag bit.
  const loopMesh = {entry: {name: 'x'}, sequences: [
    {name: 'Loop', group: 'None', startFrame: 0, numFrames: 3, notifyCount: 1, notifies: [], rate: 10},
  ]};
  const looper = {AnimSequence: 'None', animFlags: 0};
  execPlayAnim(looper, loopMesh, 'Loop', 1, -1);
  assert.equal((looper.animFlags & 0x20) !== 0, true);
  assert.equal(looper.AnimLast, f(1.0 - 3));
});

test('findAnimSeq performs the original linear scan', async () => {
  const pkg = await loadDeco();
  const bytes = await fs.readFile(DECO);
  const mesh = decodeLodMesh(pkg, bytes, 606);
  assert.equal(findAnimSeq(mesh, 'On').startFrame, 1);
  assert.equal(findSequence(mesh, 'Still').numFrames, 1);
  assert.equal(findAnimSeq(null, 'On'), null);
});
