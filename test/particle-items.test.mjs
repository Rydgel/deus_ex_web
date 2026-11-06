import test from 'node:test';
import assert from 'node:assert/strict';
import { particleIteratorItems } from '../src/runtime/script-particles.mjs';
import { NOT_RUN, particleItemCounts } from '../src/runtime/script-vm-particles.mjs';

// The host side of particleIteratorItems (docs/particles.md "The loop in Rust"): the reference loop, the Rust loop's hand-backs and the
// proxy the image cannot address, on a fake runtime. The Rust body itself is compared in scripts/validate-particle-items.mjs.
const MEMBER = name => `deusex.particleiterator.sparticle.${name}`;
const particle = (active, x) => ({ [MEMBER('bactive')]: active, [MEMBER('initvel')]: [0, 0, 0], [MEMBER('velocity')]: [0, 0, 0],
  [MEMBER('location')]: [x, 0, 0], [MEMBER('drawscale')]: 0.5 + x, [MEMBER('scaleglow')]: 1, [MEMBER('lifespan')]: 1 });

function fixture(active) {
  const fields = new Map(), log = [];
  const iterator = { name: 'ParticleIterator0' }, proxy = { name: 'ParticleProxy0' }, camera = { name: 'JC' };
  const particles = active.map((on, i) => particle(on, i));
  fields.set(iterator, { MaxItems: active.length, proxy, Index: -1, Observer: null, nextFreeParticle: -1, Particles: particles,
    bOwnerUsesGravity: false, bOwnerScales: false, bOwnerFades: false, OwnerZoneGravity: 0, OwnerRiseRate: 0, OwnerLifeSpan: 1, OwnerDrawScale: 1 });
  fields.set(proxy, { DrawScale: 1, ScaleGlow: 1, Location: [0, 0, 0] });
  const runtime = {
    readNamed: (object, name) => fields.get(object)[name],
    writeNamed: (object, name, value) => { log.push([object.name, name, value]); fields.get(object)[name] = value; },
    scriptVm: null,
  };
  const farMoveActor = (target, destination) => {
    log.push(['farMove', destination[0]]);
    if (destination[0] === 2) return false;
    fields.get(target).Location = [...destination];
    return true;
  };
  return { runtime, iterator, proxy, camera, fields, log, farMoveActor, processEvent: () => {} };
}

test('the reference loop writes Index at each step and moves the proxy to each active particle, deleting one whose move fails', () => {
  process.env.PARTICLE_ITEMS = 'js';
  try {
    const f = fixture([true, false, true, true]);
    const items = particleIteratorItems(f.runtime, f.iterator, f.camera, { processEvent: f.processEvent, farMoveActor: f.farMoveActor });
    assert.deepEqual(items.map(item => item.location[0]), [0, 3]);
    assert.deepEqual(items.map(item => item.drawScale), [0.5, 3.5]);
    const state = f.fields.get(f.iterator);
    assert.equal(state.Particles[2][MEMBER('bactive')], false, 'the failed move deleted the particle');
    assert.equal(state.nextFreeParticle, 2);
    assert.equal(state.Index, 4, 'Index ends at MaxItems');
    assert.equal(state.Observer, f.camera);
    assert.deepEqual(f.log.filter(entry => entry[1] === 'Index').map(entry => entry[2]), [0, 1, 2, 3, 4]);
  } finally { delete process.env.PARTICLE_ITEMS; }
});

test('the Rust loop hands back a declined step to the reference and goes on after it', () => {
  process.env.PARTICLE_ITEMS = 'rust';
  try {
    const f = fixture([true, true, true, true, true]);
    const calls = [], deleted = [];
    const host = {
      itemsInstance: () => ({ base: 1 }),
      // runs 0..1, declines at 2 (its move runs script), runs 3..4
      items: (instance, proxy, model, world, start, max, into) => {
        calls.push([start, max]);
        const stop = start < 2 ? 2 : max;
        for (let i = start; i < stop; i++) into.push({ actor: proxy, location: [i, 0, 0], drawScale: 0.5 + i, scaleGlow: 1 });
        return stop;
      },
      particle: (instance, index) => ({ active: true, location: [index, 0, 0], drawScale: 0.5 + index, scaleGlow: 1 }),
      deleteParticle: (instance, index) => deleted.push(index),
    };
    f.runtime.scriptVm = { particles: host };
    f.runtime.farMoveContext = () => ({ model: 1, world: 1 });
    const before = { ...particleItemCounts };
    const moves = [];
    const farMoveActor = (target, destination) => { moves.push(destination[0]); f.fields.get(target).Location = [...destination]; return true; };
    const items = particleIteratorItems(f.runtime, f.iterator, f.camera, { processEvent: f.processEvent, farMoveActor });
    assert.deepEqual(calls, [[0, 5], [3, 5]]);
    assert.deepEqual(moves, [2], 'only the handed-back step moves the proxy in JavaScript');
    assert.deepEqual(items.map(item => item.location[0]), [0, 1, 2, 3, 4], 'items stay in Index order');
    assert.deepEqual(deleted, [], 'a move that succeeds deletes nothing');
    assert.equal(particleItemCounts.handedBack - before.handedBack, 1);
    const written = f.log.filter(entry => entry[1] === 'Index').map(entry => entry[2]);
    assert.deepEqual(written, [2, 5], 'the handed-back step writes its Index, the loop ends at MaxItems');
  } finally { delete process.env.PARTICLE_ITEMS; }
});

test('a failed move on a handed-back step deletes the particle through the host', () => {
  process.env.PARTICLE_ITEMS = 'rust';
  try {
    const f = fixture([true, true, true]);
    const deleted = [];
    const host = {
      itemsInstance: () => ({ base: 1 }),
      items: (instance, proxy, model, world, start, max, into) => {
        if (start === 0) { into.push({ actor: proxy, location: [0, 0, 0], drawScale: 0.5, scaleGlow: 1 }); return 1; }
        return max;
      },
      particle: (instance, index) => ({ active: true, location: [index, 0, 0], drawScale: 0.5 + index, scaleGlow: 1 }),
      deleteParticle: (instance, index) => deleted.push(index),
    };
    f.runtime.scriptVm = { particles: host };
    f.runtime.farMoveContext = () => ({ model: 1, world: 1 });
    // index 1 is handed back; its location is 1, which succeeds; make the reference body fail it
    const farMoveActor = (target, destination) => destination[0] !== 1;
    const items = particleIteratorItems(f.runtime, f.iterator, f.camera, { processEvent: f.processEvent, farMoveActor });
    assert.deepEqual(items.map(item => item.location[0]), [0]);
    assert.deepEqual(deleted, [1]);
  } finally { delete process.env.PARTICLE_ITEMS; }
});

test('a proxy the image cannot address, or a level without the world BSP in the core, runs the reference loop whole', () => {
  process.env.PARTICLE_ITEMS = 'rust';
  try {
    for (const context of [{ model: 1, world: 1 }, { model: 1, world: 0 }, null]) {
      const f = fixture([true, true, false]);
      f.runtime.scriptVm = { particles: { itemsInstance: () => ({ base: 1 }), items: () => NOT_RUN } };
      f.runtime.farMoveContext = () => context;
      const items = particleIteratorItems(f.runtime, f.iterator, f.camera, { processEvent: f.processEvent, farMoveActor: f.farMoveActor });
      assert.deepEqual(items.map(item => item.location[0]), [0, 1]);
      assert.equal(f.fields.get(f.iterator).Index, 3);
    }
  } finally { delete process.env.PARTICLE_ITEMS; }
});
