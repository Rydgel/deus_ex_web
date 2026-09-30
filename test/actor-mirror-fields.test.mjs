import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {installMirrorFields, resetMirrorField, imageField, liveVector, mirrorsField, PLAYER_PORT}
  from '../src/runtime/actor-mirror-fields.mjs';
import {Player} from '../src/runtime/player.mjs';

// Stage 1e step 2 (docs/rust-core.md "1e-2"): a map actor's Physics,
// Velocity, Acceleration, StandingCount, pawn-list and navigation pointers
// and mover replication fields are its object-image cells at the retail
// offsets (sdk-layouts.mjs AActor/APawn/AMover/ALevelInfo), and the host
// members the physics code uses are accessors over them.

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
    if (kind === 'rotator' || kind === 'int') return kind === 'int' ? view.getInt32(at, true) : [0, 4, 8].map(step => view.getInt32(at + step, true));
    if (kind === 'byte') return view.getUint8(at);
    return view.getUint32(at, true);
  };
  return {runtime, load, attach, cell};
}

test('a map pawn\'s mirrored members are its image cells at the retail offsets', async () => {
  const {runtime, load, attach, cell} = await fixture();
  const pawn = await load('pawn');
  const goal = attach('PatrolPoint0', pawn);
  // Level load left host copies; the installer adopts them into the cells.
  const host = attach('UNATCOTroop6', pawn, {physics: 2, velocity: [1.5, -2, 3.25], standingCount: 1,
    specialGoal: goal, values: {Acceleration: [0, 0, -4]}});
  installMirrorFields(host, runtime.instance(host), pawn.fields, {values: host.values});
  assert.equal(cell(host, 0x30, 'byte'), 2);
  assert.deepEqual(cell(host, 0x144, 'vector'), [1.5, -2, 3.25]);
  // An absent member takes the value its binding fell back to.
  assert.deepEqual(cell(host, 0x150, 'vector'), [0, 0, -4]);
  assert.equal(cell(host, 0xd8, 'byte'), 1);
  assert.notEqual(cell(host, 0x45c), 0);
  assert.equal(runtime.readNamed(host, 'SpecialGoal'), goal);
  assert.equal(host.nextPawn, null);

  // Script writes and host writes are one storage.
  runtime.writeNamed(host, 'Physics', 1);
  assert.equal(host.physics, 1);
  host.velocity = [10, 20, 30];
  assert.deepEqual(runtime.readNamed(host, 'Velocity'), [10, 20, 30]);
  host.nextPawn = goal;
  assert.equal(runtime.readNamed(host, 'nextPawn'), goal);
  host.standingCount = (host.standingCount + 1) & 255;
  assert.equal(runtime.readNamed(host, 'StandingCount'), 2);

  // A read is a fresh value; mutating it stores nothing.
  const read = host.velocity;
  read[2] = 99;
  assert.deepEqual(host.velocity, [10, 20, 30]);
  // The element-writable view stores one component.
  const live = liveVector(host, 'velocity');
  assert.ok(Array.isArray(live));
  live[1] = -7.5;
  assert.deepEqual(runtime.readNamed(host, 'Velocity'), [10, -7.5, 30]);
  assert.deepEqual(live.map(v => v), [10, -7.5, 30]);
  assert.equal(liveVector(host, 'physics'), null);

  // Stores go through the field's codec: float32 components, a byte.
  host.velocity = [0.1, 0, 0];
  assert.equal(host.velocity[0], Math.fround(0.1));

  // A leftover delete cannot split the storage again.
  assert.throws(() => { delete host.velocity; }, TypeError);
  // The reset path returns a member to the binding's fallback.
  resetMirrorField(host, 'acceleration');
  assert.deepEqual(host.acceleration, [0, 0, -4]);
  resetMirrorField(host, 'specialGoal');
  assert.equal(runtime.readNamed(host, 'SpecialGoal'), null);
  resetMirrorField(host, 'physics');
  assert.equal(host.physics, 0);
  // A member that is no mirror is deleted.
  host.pawnFlags = 2;
  resetMirrorField(host, 'pawnFlags');
  assert.equal('pawnFlags' in host, false);

  // Installed once; an accessor member is not host data.
  assert.throws(() => installMirrorFields(host, runtime.instance(host), pawn.fields), /already installed/);
  const other = attach('Other', pawn);
  Object.defineProperty(other, 'velocity', {get: () => [0, 0, 0], configurable: true});
  assert.throws(() => installMirrorFields(other, runtime.instance(other), pawn.fields), /not a host data member/);
});

test('a mover\'s replication fields and LevelInfo.PawnList are image cells', async () => {
  const {runtime, load, attach, cell} = await fixture();
  const mover = await load('mover'), levelInfo = await load('levelinfo'), pawn = await load('pawn');
  const host = attach('DeusExMover7', mover, {clientUpdate: 0, realRotation: [0, -16384, 0],
    values: {Location: [1, 2, 3], SimOldPos: [4, 5, 6]}});
  installMirrorFields(host, runtime.instance(host), mover.fields, {values: host.values});
  assert.deepEqual(cell(host, 0x524, 'rotator'), [0, -16384, 0]);
  assert.deepEqual(cell(host, 0x4f4, 'vector'), [4, 5, 6]);
  host.clientUpdate = (host.clientUpdate - 1) | 0;
  assert.equal(cell(host, 0x530, 'int'), -1);
  assert.equal(runtime.readNamed(host, 'ClientUpdate'), -1);
  host.realPosition = [7, 8, 9];
  assert.deepEqual(runtime.readNamed(host, 'RealPosition'), [7, 8, 9]);
  const waiting = attach('Waiter', pawn);
  host.waitingPawn = waiting;
  assert.equal(runtime.readNamed(host, 'WaitingPawn'), waiting);
  assert.equal(host.marker, null);

  // Inventory.MyMarker shares the host `marker` member.
  const inventory = await load('inventory');
  const item = attach('Medkit0', inventory, {marker: waiting});
  installMirrorFields(item, runtime.instance(item), inventory.fields, {values: item.values});
  assert.equal(runtime.readNamed(item, 'MyMarker'), waiting);
  assert.notEqual(cell(item, 0x398), 0);

  // PawnList's member is the scene level's.
  const info = attach('LevelInfo0', levelInfo), level = {pawnList: waiting};
  installMirrorFields(info, runtime.instance(info), levelInfo.fields, {target: info});
  assert.equal('pawnList' in info, false);
  installMirrorFields(info, runtime.instance(info), levelInfo.fields, {target: level});
  assert.equal(runtime.readNamed(info, 'PawnList'), waiting);
  level.pawnList = null;
  assert.equal(cell(info, 0x54c), 0);
});

test('the controlled player\'s velocity links to its identity\'s field; Physics stays bound', async () => {
  const {runtime, load, attach} = await fixture();
  const pawn = await load('pawn');
  const identity = attach('JCDentonMale', pawn);
  const velocityField = pawn.fields.find(field => field.key === 'engine.actor.velocity');
  const physicsField = pawn.fields.find(field => field.key === 'engine.actor.physics');
  assert.equal(PLAYER_PORT.has(velocityField.key) && PLAYER_PORT.has(physicsField.key), true);
  assert.equal(mirrorsField(identity, runtime.instance(identity), physicsField, {exclude: new Set([physicsField.key])}), false);

  const player = Object.create(Player.prototype);
  player.velocityField = null;
  player.velocity = [0, 0, 0];
  player.linkVelocity(imageField(runtime.instance(identity), velocityField));
  player.velocity = [5, 6, 7];
  assert.deepEqual(runtime.readNamed(identity, 'Velocity'), [5, 6, 7]);
  runtime.writeNamed(identity, 'Velocity', [1, 2, 3]);
  assert.deepEqual(player.velocity, [1, 2, 3]);
  // Unlinking keeps the value as host state.
  player.linkVelocity(null);
  player.velocity = [9, 9, 9];
  assert.deepEqual(runtime.readNamed(identity, 'Velocity'), [1, 2, 3]);
  // Linking requires both to agree.
  assert.throws(() => player.linkVelocity(imageField(runtime.instance(identity), velocityField)), /differs/);
});
