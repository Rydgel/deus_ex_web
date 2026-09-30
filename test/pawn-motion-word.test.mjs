import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {installActorFlagWords, flagWord, MOTION_WORD} from '../src/runtime/actor-flag-words.mjs';
import {pawnPhysicsView} from '../src/runtime/script-pawn-physics.mjs';
import {installActorCollisionView} from '../src/runtime/script-actor-collision.mjs';

// A pawn's physics reads and writes the pawn's own AActor +0x1ec word
// (Engine.dll: physWalking 0x103ca83e, physFalling 0x103d0f04, physFlying
// 0x103d3177 and physSwimming 0x103d3d76 clear bJustTeleported 0x100;
// FarMoveActor 0x10398db7 and stepUp 0x103ce64e set it; APawn::physicsRotation
// 0x103c9faa sets bRotateToDesired 0x40 and clears bFixedRotationDir 0x20).
// Regression: a map pawn's physics view kept a host copy that started at 0
// while the image (the script bools) started at the Pawn default 0x140, so
// the physics' writes never reached the fields scripts and the digest read.

const ROOT = 'Deus Ex GOTY Edition';

async function pawnFixture() {
  const files = [];
  for (const name of await readdir(`${ROOT}/System`))
    if (/\.u$/i.test(name)) files.push({path: `System/${name}`, read: () => readFile(`${ROOT}/System/${name}`)});
  const assets = new AssetStore(files);
  const runtime = new ScriptRuntime(assets, {nativeClassLoading: true});
  const engine = await assets.get('Engine');
  const cls = await runtime.loadClass(engine, engine.exportsByPath.get('pawn'));
  const attach = name => {
    const host = {name, values: {bJustTeleported: true}, touching: [null, null, null, null], standingCount: 0};
    runtime.attach(host, cls);
    return host;
  };
  const word = (host, offset) => { const i = runtime.instance(host); return i.arena.view.getUint32(i.base + offset, true); };
  const hash = {removeActor() {}, addActor() {}, actorEncroachmentCheck: () => [],
    lineCheck: () => ({time: 1, actor: null, location: [0, 0, 0], normal: [0, 0, 0]})};
  const level = {hash, actors: [], netMode: 0, model: null,
    pointRegion: () => ({zone: null, leaf: -1, zoneNumber: 0}), findSpot: () => true};
  const services = {level, worldActor: {name: '$world'},
    field: (actor, name) => runtime.namedReference(actor, name),
    read: (actor, name) => runtime.readNamed(actor, name),
    write: (actor, name, value) => runtime.writeNamed(actor, name, value),
    isA: (actor, key) => { for (let c = runtime.instance(actor).cls; c; c = c.base) if (c.record.key === key) return true; return false; },
    zoneFields: () => ({}), isProbing: () => false, dispatch: () => {}};
  return {runtime, attach, word, services};
}

test('a map pawn view reads and writes the +0x1ec image word the script bools live in', async () => {
  const {runtime, attach, word, services} = await pawnFixture();
  const host = attach('UNATCOTroop6');
  // Level load: the host collision and actor words equal the image.
  host.flags = word(host, 0x1dc) & 0x1f;
  host.actorFlags = word(host, 0x28) & 0xa0081;
  installActorFlagWords(host, runtime.instance(host), {collision: true, actor: true, motion: true});
  // Pawn's defaults: bRotateToDesired plus Actor's bJustTeleported=True.
  assert.equal(host.motionFlags, 0x140);
  const view = pawnPhysicsView(host, services);
  assert.equal(view.motionFlags, 0x140);
  assert.equal(view.justTeleported, true);

  // A physics body's clear is the script field's clear.
  view.justTeleported = false;
  assert.equal(word(host, 0x1ec) & 0x1ff, 0x40);
  assert.equal(runtime.readNamed(host, 'bJustTeleported'), false);
  assert.equal(runtime.readNamed(host, 'bRotateToDesired'), true);

  // APawn::physicsRotation's mode write reaches bFixedRotationDir too.
  runtime.writeNamed(host, 'bFixedRotationDir', true);
  runtime.writeNamed(host, 'bRotateToDesired', false);
  assert.equal(view.motionFlags, 0x20);
  view.motionFlags = ((view.motionFlags & ~0x20) | 0x40) >>> 0;
  assert.equal(runtime.readNamed(host, 'bFixedRotationDir'), false);
  assert.equal(runtime.readNamed(host, 'bRotateToDesired'), true);

  // FarMoveActor (not a test move) sets bJustTeleported in the image.
  assert.equal(view.farMove([100, 0, 0], 0, 1), true);
  assert.equal(runtime.readNamed(host, 'bJustTeleported'), true);
  assert.equal(word(host, 0x1ec) & 0x1ff, 0x140);
  // A test move leaves it.
  view.justTeleported = false;
  assert.equal(view.farMove([200, 0, 0], 1, 1), true);
  assert.equal(runtime.readNamed(host, 'bJustTeleported'), false);

  // The word is storage, not a host prop: a reset restores it with the image
  // and cannot delete it.
  assert.throws(() => { delete host.motionFlags; }, TypeError);
});

test('a map pawn with installed flag words must have its motion word', async () => {
  const {runtime, attach, word, services} = await pawnFixture();
  const host = attach('Doctor0');
  host.flags = word(host, 0x1dc) & 0x1f;
  host.actorFlags = word(host, 0x28) & 0xa0081;
  installActorFlagWords(host, runtime.instance(host), {collision: true, actor: true});
  assert.throws(() => pawnPhysicsView(host, services), /no \+0x1ec image word/);
});

test('a spawned pawn view writes the whole +0x1ec image word', async () => {
  const {runtime, attach, services} = await pawnFixture();
  const spawned = attach('Pawn1');
  installActorCollisionView(spawned, {
    read: (actor, name) => runtime.readNamed(actor, name), write: (actor, name, value) => runtime.writeNamed(actor, name, value),
    worldActor: services.worldActor, lineage: ['engine.pawn', 'engine.actor'],
    motionWord: flagWord(runtime.instance(spawned), MOTION_WORD)});
  runtime.writeNamed(spawned, 'bRotateToDesired', false);
  runtime.writeNamed(spawned, 'bFixedRotationDir', true);
  const view = pawnPhysicsView(spawned, services);
  assert.equal(view.motionFlags, 0x120);
  view.motionFlags = ((view.motionFlags & ~0x20) | 0x40) >>> 0;
  view.justTeleported = false;
  assert.equal(runtime.readNamed(spawned, 'bRotateToDesired'), true);
  assert.equal(runtime.readNamed(spawned, 'bFixedRotationDir'), false);
  assert.equal(runtime.readNamed(spawned, 'bJustTeleported'), false);
  assert.equal(spawned.motionFlags, 0x40);
});
