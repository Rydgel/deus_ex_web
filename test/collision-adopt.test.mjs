import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollisionHash} from '../src/runtime/collision-hash.mjs';
import {kernelHashStore, runtimeLineKernel} from '../src/runtime/collision-kernel.mjs';
import {loadTraceKernel, createRuntimeTraceKernel, lineCheckImports} from '../src/runtime/trace-kernel.mjs';
import {ObjectArena} from '../src/runtime/script-object-arena.mjs';
import {instantiateScriptVm} from '../src/runtime/script-vm-kernel.mjs';

const kernel = await loadTraceKernel();
const f = Math.fround;
let seed = 0x1234567;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
// World positions around the level's middle cell: about 25 cells a side, so the registrations' lists overlap.
const bounds = () => {
  const min = [0, 1, 2].map(() => Math.floor(random() * 6000) - 3000);
  return {min, max: min.map(v => v + Math.floor(random() * 4) * 256 + Math.floor(random() * 200))};
};

/** A runtime's interpreter instance on a fresh object arena, as RustScriptVm makes one, with hash.rs's imports. */
async function runtimeKernel() {
  const arena = new ObjectArena(), exports = await instantiateScriptVm(arena.memory, lineCheckImports);
  const line = createRuntimeTraceKernel(exports, arena);
  line.imageHost = true;
  return line;
}

test('a hash moved into a runtime\'s instance visits registrations in the order it had', async () => {
  assert.ok(kernel, 'the trace kernel loads');
  const line = await runtimeKernel(), store = kernelHashStore();
  const hash = createCollisionHash({store}), reference = createCollisionHash();
  const actors = Array.from({length: 120}, (_, i) => ({id: i, lineage: i % 7 === 0 ? ['engine.mover'] : ['engine.actor']}));
  const registered = new Map();
  // Registrations, removals and re-registrations: a cell's list is LIFO by the order its live members were added.
  for (let step = 0; step < 600; step++) {
    const actor = actors[Math.floor(random() * actors.length)];
    if (registered.has(actor)) {
      const b = registered.get(actor);
      hash.removeActor(actor, b); reference.removeActor(actor, b);
      registered.delete(actor);
    } else {
      const b = bounds();
      hash.addActor(actor, b); reference.addActor(actor, b);
      registered.set(actor, b);
    }
  }
  const queries = Array.from({length: 80}, () => {
    const a = [0, 1, 2].map(() => f(Math.floor(random() * 6000) - 3000)), b = [0, 1, 2].map(() => f(Math.floor(random() * 6000) - 3000));
    return {start: a, end: b, extent: [800, 800, 800].map(v => f(v * random()))};
  });
  const orders = hash => queries.map(q => hash.lineCandidates(q).map(a => a.id));
  const expected = orders(reference);
  assert.ok(expected.some(order => order.length > 5), 'the queries visit several registrations');
  assert.deepEqual(orders(hash), expected, 'the trace kernel instance');
  store.adopt(line);
  assert.equal(store.kernel, line);
  assert.deepEqual(orders(hash), expected, 'the runtime\'s instance after adopt');
  // And on: registrations after the move go to the runtime's instance, and a removal frees the id for the next.
  for (let step = 0; step < 300; step++) {
    const actor = actors[Math.floor(random() * actors.length)];
    if (registered.has(actor)) {
      const b = registered.get(actor);
      hash.removeActor(actor, b); reference.removeActor(actor, b);
      registered.delete(actor);
    } else {
      const b = bounds();
      hash.addActor(actor, b); reference.addActor(actor, b);
      registered.set(actor, b);
    }
  }
  assert.deepEqual(orders(hash), orders(reference), 'after more registrations');
});

test('a registration\'s descriptor carries its lineage\'s class facts', async () => {
  const line = await runtimeKernel(), store = kernelHashStore(line);
  assert.equal(store.kernel, line);
  const hash = createCollisionHash({store});
  const kinds = [['engine.levelinfo', 4], ['engine.pawn', 1], ['engine.mover', 2], ['engine.zoneinfo', 8], ['engine.actor', 0]];
  const mover = {lineage: ['engine.mover', 'engine.brush', 'engine.actor']}, pawn = {lineage: ['engine.scriptedpawn', 'engine.pawn', 'engine.actor']};
  const plain = {lineage: ['engine.decoration', 'engine.actor']}, none = {}, zone = {lineage: ['engine.zoneinfo', 'engine.info', 'engine.actor']};
  const b = {min: [0, 0, 0], max: [10, 10, 10]};
  for (const actor of [mover, pawn, plain, none, zone]) hash.addActor(actor, b);
  const flags = actor => store.desc[4 * store.ids.get(actor) + 1];
  const D_KIND = 1, D_MOVER = 2, FILTER = flags => flags >>> 8 & 15;
  assert.equal(flags(mover) & D_KIND, D_KIND);
  assert.equal(flags(mover) & D_MOVER, D_MOVER);
  assert.equal(FILTER(flags(mover)), 2);
  assert.equal(FILTER(flags(pawn)), 1);
  assert.equal(FILTER(flags(zone)), 8);
  assert.equal(flags(pawn) & D_MOVER, 0);
  assert.equal(FILTER(flags(plain)), 0);
  assert.equal(flags(plain) & D_KIND, D_KIND);
  assert.equal(flags(none), 0, 'no lineage, no class facts');
  hash.removeActor(mover, b);
  assert.equal(store.desc.slice(0, 4)[1], 0, 'a removed registration describes nothing');
  assert.equal(kinds.length, 5);
});

test('COLLISION_HOST selects rust, verify or js', async () => {
  const saved = process.env.COLLISION_HOST;
  try {
    process.env.COLLISION_HOST = 'js';
    assert.equal(runtimeLineKernel({exports: {}, arena: null}), null, 'js keeps the hash in the trace kernel\'s instance');
    process.env.COLLISION_HOST = 'nonsense';
    assert.throws(() => runtimeLineKernel({exports: {}}), /COLLISION_HOST must be/);
  } finally {
    if (saved === undefined) delete process.env.COLLISION_HOST; else process.env.COLLISION_HOST = saved;
  }
});
