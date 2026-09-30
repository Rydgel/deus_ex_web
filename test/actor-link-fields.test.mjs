import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {installLinkFields, linksField, hasLinkField, isLinkProp, resetLinkField} from '../src/runtime/actor-link-fields.mjs';
import {baseEpoch, riderEpochOf} from '../src/runtime/base-epoch.mjs';
import {handleOf} from '../src/runtime/script-object-handles.mjs';

// Stage 1e step 4 (docs/rust-core.md "1e-4"): an attached map actor's Base
// and Touching are its object-image cells at the retail AActor offsets
// (sdk-layouts.mjs), and the host members the move, rider and touch code
// use are accessors over them.

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
  const word = (host, offset) => {
    const i = runtime.instance(host);
    return i.arena.view.getUint32(i.base + offset, true);
  };
  return {runtime, load, attach, word};
}

test('a map actor\'s Base and Touching members are its image cells at the retail offsets', async () => {
  const {runtime, load, attach, word} = await fixture();
  const actor = await load('actor');
  const probe = attach('Probe', actor);
  for (const key of ['engine.actor.base', 'engine.actor.touching'])
    assert.equal(linksField(runtime.instance(probe), actor.fields.find(field => field.key === key)), true);
  assert.equal(linksField(runtime.instance(probe), actor.fields.find(field => field.key === 'engine.actor.location')), false);

  const floor = attach('Floor0', actor), other = attach('Crate0', actor), third = attach('Crate1', actor);
  // Level load left host copies; the installer adopts them into the cells.
  const host = attach('Barrel0', actor, {base: floor, touching: [other, null, third, null]});
  const epoch = baseEpoch();
  const installed = installLinkFields(host, runtime.instance(host), actor.fields);
  assert.deepEqual(installed.sort(), ['base', 'touching']);
  assert.ok(baseEpoch() > epoch, 'adopting the host Base bumps the base epoch');
  assert.equal(word(host, 0xc4), handleOf(floor));
  assert.deepEqual([0, 4, 8, 12].map(step => word(host, 0xe8 + step)), [handleOf(other), 0, handleOf(third), 0]);
  assert.equal(hasLinkField(host, 'base'), true);
  assert.equal(hasLinkField(host, 'touching'), true);

  // The script field and the host member are one storage, both ways.
  assert.equal(runtime.readNamed(host, 'Base'), floor);
  assert.deepEqual(runtime.readNamed(host, 'Touching'), [other, null, third, null]);
  // A Base store counts on the old and the new base (base-epoch.mjs), not
  // on the global epoch.
  const before = baseEpoch(), counts = [riderEpochOf(floor), riderEpochOf(other)];
  host.base = other;
  assert.equal(baseEpoch(), before, 'a host Base store leaves the base epoch');
  assert.deepEqual([riderEpochOf(floor), riderEpochOf(other)], counts.map(c => c + 1), 'a host Base store counts on both bases');
  assert.equal(runtime.readNamed(host, 'Base'), other);
  assert.equal(word(host, 0xc4), handleOf(other));
  runtime.writeNamed(host, 'Base', null);
  assert.equal(host.base, null);
  assert.equal(word(host, 0xc4), 0);

  // The touching array keeps the surface actor-touch.mjs uses: an Array of
  // four slots with element stores, indexOf and fill, one object per host.
  const slots = host.touching;
  assert.equal(Array.isArray(slots), true);
  assert.equal(slots.length, 4);
  assert.equal(host.touching, slots);
  assert.equal(slots.indexOf(third), 2);
  slots[1] = floor;
  assert.deepEqual(runtime.readNamed(host, 'Touching'), [other, floor, third, null]);
  runtime.writeNamed(host, 'Touching', [null, null, null, floor]);
  assert.deepEqual([...slots], [null, null, null, floor]);
  assert.equal(word(host, 0xe8 + 12), handleOf(floor));
  slots.fill(null);
  assert.deepEqual(runtime.readNamed(host, 'Touching'), [null, null, null, null]);
  // The binding-era whole-array assignment stores into the four cells.
  host.touching = [third, null, null, null];
  assert.equal(host.touching, slots);
  assert.deepEqual(runtime.readNamed(host, 'Touching'), [third, null, null, null]);
  assert.throws(() => { host.touching = [third]; }, /four explicit slots/);
  assert.throws(() => { slots[0] = 3; }, TypeError);
  assert.throws(() => { host.base = 'x'; }, TypeError);

  // A second install is refused, and a delete cannot split the storage.
  assert.throws(() => installLinkFields(host, runtime.instance(host), actor.fields), /already installed/);
  assert.throws(() => { 'use strict'; delete host.base; }, TypeError);
  // The NPC startup reset returns each member to the binding-era value
  // after a delete: base to None, touching to the (restored) cells.
  host.base = floor; host.touching = [other, null, null, null];
  assert.equal(isLinkProp('base') && isLinkProp('touching') && !isLinkProp('physics'), true);
  resetLinkField(host, 'base'); resetLinkField(host, 'touching');
  assert.equal(host.base, null);
  assert.deepEqual([...host.touching], [other, null, null, null]);
  assert.equal(host.touching, slots);
  const plain = {name: 'Plain', base: floor};
  resetLinkField(plain, 'base');
  assert.equal('base' in plain, false);
});

test('an absent host Base reads None and a host without live slots gets no touching array', async () => {
  const {runtime, load, attach, word} = await fixture();
  const actor = await load('actor');
  const host = attach('Lamp0', actor);
  // makeBinding read `host.base ?? null`: the cell takes None whatever the
  // image held. Touching stays the image's: isMapMoveHost's predicate
  // (Array.isArray(host.touching)) is unchanged for this host.
  const view = runtime.instance(host);
  view.arena.view.setUint32(view.base + 0xc4, handleOf(attach('Ghost0', actor)), true);
  const installed = installLinkFields(host, view, actor.fields);
  assert.deepEqual(installed, ['base']);
  assert.equal(host.base, null);
  assert.equal(word(host, 0xc4), 0);
  assert.equal('touching' in host, false);
  assert.equal(hasLinkField(host, 'touching'), false);
  // A host whose member is already an accessor is an error, not silently
  // shadowed.
  const odd = attach('Odd0', actor);
  Object.defineProperty(odd, 'base', {get: () => null, configurable: true});
  assert.throws(() => installLinkFields(odd, runtime.instance(odd), actor.fields), /not a host data member/);
});
