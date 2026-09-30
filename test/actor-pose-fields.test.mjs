import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {installPoseFields, resetPoseField, keepLivePose, imagePoseField, posesField}
  from '../src/runtime/actor-pose-fields.mjs';
import {Player} from '../src/runtime/player.mjs';

// Stage 1e step 3 (docs/rust-core.md "1e-3"): an attached map actor's
// Location, Rotation, OldLocation and collision size are its object-image
// cells at the retail AActor offsets (sdk-layouts.mjs), and the host members
// the move, collision and physics code use are accessors over them.

const ROOT = 'Deus Ex GOTY Edition';

async function fixture() {
  const files = [];
  for (const name of await readdir(`${ROOT}/System`))
    if (/\.u$/i.test(name)) files.push({path: `System/${name}`, read: () => readFile(`${ROOT}/System/${name}`)});
  const assets = new AssetStore(files);
  const runtime = new ScriptRuntime(assets, {nativeClassLoading: true});
  const engine = await assets.get('Engine');
  const load = async name => {
    const cls = await runtime.loadClass(engine, engine.exportsByPath.get(name));
    const fields = new Map();
    for (let node = cls; node; node = node.base)
      for (const field of node.fields?.values() ?? []) if (!fields.has(field.key)) fields.set(field.key, field);
    await Promise.all([...fields.values()].map(field => runtime.field(field)));
    return {cls, fields: [...fields.values()]};
  };
  const attach = (name, {cls}, members = {}) => {
    const host = {name, values: {}, ...members};
    runtime.attach(host, cls);
    return host;
  };
  const cell = (host, offset, kind) => {
    const i = runtime.instance(host), at = i.base + offset, view = i.arena.view;
    if (kind === 'vector') return [0, 4, 8].map(step => view.getFloat32(at + step, true));
    if (kind === 'rotator') return [0, 4, 8].map(step => view.getInt32(at + step, true));
    return view.getFloat32(at, true);
  };
  return {runtime, load, attach, cell};
}

test('a map actor\'s pose members are its image cells at the retail offsets', async () => {
  const {runtime, load, attach, cell} = await fixture();
  const actor = await load('actor');
  for (const key of ['engine.actor.location', 'engine.actor.rotation', 'engine.actor.oldlocation',
    'engine.actor.collisionradius', 'engine.actor.collisionheight'])
    assert.equal(posesField(runtime.instance(attach('Probe', actor)), actor.fields.find(field => field.key === key)), true);
  // Level load left host copies; the installer adopts them into the cells.
  const host = attach('Barrel0', actor, {position: [1.5, -2, 3.25], rotation: [0, -16384, 0], radius: 20, height: 30.5,
    values: {Location: [9, 9, 9]}});
  const installed = installPoseFields(host, runtime.instance(host), actor.fields, {values: host.values, oldLocation: true});
  assert.deepEqual(installed.sort(), ['height', 'oldLocation', 'position', 'radius', 'rotation']);
  assert.deepEqual(cell(host, 0x114, 'vector'), [1.5, -2, 3.25]);
  assert.deepEqual(cell(host, 0x120, 'rotator'), [0, -16384, 0]);
  assert.equal(cell(host, 0x1d4), 20);
  assert.equal(cell(host, 0x1d8), 30.5);

  // Script writes and host writes are one storage.
  host.position = [10, 20, 30];
  assert.deepEqual(runtime.readNamed(host, 'Location'), [10, 20, 30]);
  runtime.writeNamed(host, 'Rotation', [1, 2, 3]);
  assert.deepEqual(host.rotation, [1, 2, 3]);
  host.radius = 11;
  assert.equal(runtime.readNamed(host, 'CollisionRadius'), 11);
  host.oldLocation = [4, 5, 6];
  assert.deepEqual(runtime.readNamed(host, 'OldLocation'), [4, 5, 6]);

  // A read is a fresh value; mutating it stores nothing.
  const read = host.position;
  read[2] = 99;
  assert.deepEqual(host.position, [10, 20, 30]);
  // Stores go through the codec: float32 components, int32 rotator words.
  host.position = [0.1, 0, 0];
  assert.equal(host.position[0], Math.fround(0.1));
  host.height = 0.1;
  assert.equal(host.height, Math.fround(0.1));
  host.rotation = [1.5, -2.5, 3];
  assert.deepEqual(host.rotation, [1, -2, 3]);

  // A leftover delete cannot split the storage again.
  assert.throws(() => { delete host.position; }, TypeError);
  // The reset path returns a member to the binding's fallback: values.X,
  // and for OldLocation the image value it fell back to (the attach's).
  resetPoseField(host, 'position');
  assert.deepEqual(host.position, [9, 9, 9]);
  resetPoseField(host, 'oldLocation');
  assert.deepEqual(host.oldLocation, [0, 0, 0]);
  resetPoseField(host, 'radius');
  assert.equal(host.radius, 0);
  // A member that is not installed is deleted.
  host.pawnFlags = 2;
  resetPoseField(host, 'pawnFlags');
  assert.equal('pawnFlags' in host, false);

  // Installed once; an accessor member is not host data.
  assert.throws(() => installPoseFields(host, runtime.instance(host), actor.fields), /already installed/);
  const other = attach('Other', actor);
  Object.defineProperty(other, 'position', {get: () => [0, 0, 0], configurable: true});
  assert.throws(() => installPoseFields(other, runtime.instance(other), actor.fields), /not a host data member/);
});

test('absent members take the binding fallback; OldLocation only where it was bound', async () => {
  const {runtime, load, attach} = await fixture();
  const actor = await load('actor');
  // LevelInfo-like: no host pose at all. A mover's absent position falls back
  // to its interpolation state, as makeBinding's getter did.
  const host = attach('Mover3', actor, {interpolation: {position: [7, 8, 9], rotation: [0, 5, 0]},
    values: {CollisionRadius: 22, CollisionHeight: 23}});
  const installed = installPoseFields(host, runtime.instance(host), actor.fields, {values: host.values});
  assert.equal(installed.includes('oldLocation'), false);
  assert.equal('oldLocation' in host, false);
  assert.deepEqual(host.position, [7, 8, 9]);
  assert.deepEqual(host.rotation, [0, 5, 0]);
  assert.equal(host.radius, 22);
  assert.equal(host.height, 23);
  assert.deepEqual(runtime.readNamed(host, 'Location'), [7, 8, 9]);
});

test('a property reset keeps the live pose; OldLocation is restored', async () => {
  const {runtime, load, attach} = await fixture();
  const actor = await load('actor');
  const host = attach('Crate0', actor, {position: [1, 2, 3], rotation: [0, 0, 0], radius: 5, height: 6});
  installPoseFields(host, runtime.instance(host), actor.fields, {values: host.values, oldLocation: true});
  const snapshot = runtime.snapshotStorage(host);
  host.position = [4, 5, 6]; host.rotation = [0, 7, 0]; host.radius = 8; host.height = 9; host.oldLocation = [1, 1, 1];
  const keep = keepLivePose(host);
  runtime.restoreStorage(host, snapshot);
  keep();
  assert.deepEqual(host.position, [4, 5, 6]);
  assert.deepEqual(host.rotation, [0, 7, 0]);
  assert.equal(host.radius, 8);
  assert.equal(host.height, 9);
  assert.deepEqual(host.oldLocation, [0, 0, 0]);
});

test('the controlled player\'s pose members link to its identity\'s cells', async () => {
  const {runtime, load, attach} = await fixture();
  const pawn = await load('pawn');
  const identity = attach('JCDentonMale', pawn);
  const fields = pawn.fields.map(field => imagePoseField(runtime.instance(identity), field)).filter(Boolean);
  assert.equal(fields.length, 5);

  const player = Object.create(Player.prototype);
  player.poseFields = null;
  player.position = [100, 200, 48.5]; player.bodyRotation = [0, 16384, 0];
  player.radius = 17; player.height = 43; player.spawnOldLocation = [100, 200, 48.5];
  // The image adopts the members' values (the placeholder's never held them).
  player.linkPose(fields);
  assert.deepEqual(runtime.readNamed(identity, 'Location'), [100, 200, 48.5]);
  assert.equal(runtime.readNamed(identity, 'CollisionHeight'), 43);
  assert.deepEqual(runtime.readNamed(identity, 'Rotation'), [0, 16384, 0]);
  player.position = [1, 2, 3];
  assert.deepEqual(runtime.readNamed(identity, 'Location'), [1, 2, 3]);
  runtime.writeNamed(identity, 'OldLocation', [4, 5, 6]);
  assert.deepEqual(player.spawnOldLocation, [4, 5, 6]);
  // Unlinking keeps the values as host state.
  player.linkPose(null);
  player.position = [9, 9, 9];
  assert.deepEqual(runtime.readNamed(identity, 'Location'), [1, 2, 3]);
  // A value the cell cannot hold exactly is refused.
  player.position = [0.1, 0, 0];
  assert.throws(() => player.linkPose(fields), /not exact/);
});
