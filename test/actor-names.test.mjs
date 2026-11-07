import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorNames} from '../src/runtime/actor-names.mjs';

// A seeded random walk over Level.Actors: spawns (append), destroys (an entry turned null), compactions (nulls removed, the others
// shifted), name collisions, and an array swap; after every step the kept map equals a fresh build's, for both kinds of map.
function walk(seed, steps, {last, live}) {
  let state = seed >>> 0;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  let actors = [], serial = 0;
  const names = new ActorNames({last, live});
  let epoch = 0;
  const spawn = () => {
    // a name that was used before 1 time in 6 (a duplicate), else a fresh one
    const name = random() < 1 / 6 && serial ? `N${Math.floor(random() * serial)}` : `N${serial++}`;
    actors.push({name});
  };
  for (let i = 0; i < 40; i++) spawn();
  const fresh = list => {
    const byName = new Map();
    for (const actor of list) if (actor && (last || !byName.has(actor.name))) byName.set(actor.name, actor);
    return byName;
  };
  const stats = {updates: 0, rebuilds: 0};
  for (let step = 0; step < steps; step++) {
    const action = random();
    if (action < 0.4) spawn();
    else if (action < 0.7) { const live = actors.map((a, k) => (a ? k : -1)).filter(k => k >= 0); if (live.length) actors[live[Math.floor(random() * live.length)]] = null; }
    else if (action < 0.75) actors.push(null);
    else if (action < 0.8) { const kept = actors.filter(Boolean); actors.length = 0; actors.push(...kept); }
    else if (action < 0.82) actors = actors.slice();
    else if (action < 0.84) { const k = Math.floor(random() * actors.length); if (!actors[k]) { spawn(); actors[k] = actors.pop(); } }
    if (random() < 0.7) {
      epoch++;
      const before = names.counts.rebuilds;
      const got = names.at(actors, epoch, step % 3 === 0 ? 'verify' : 'kept');
      const want = fresh(actors);
      assert.equal(got.size, want.size, `step ${step}`);
      for (const [name, actor] of want) assert.equal(got.get(name), actor, `step ${step} ${name}`);
      if (live) {
        const want2 = new Set(actors);
        assert.equal(names.live.size, want2.size, `step ${step} live`);
        for (const actor of want2) assert.ok(names.live.has(actor), `step ${step} live member`);
      }
      stats.rebuilds += names.counts.rebuilds - before;
      stats.updates++;
    }
  }
  return {stats, counts: names.counts};
}

for (const [label, options] of [['first wins', {last: false, live: false}], ['last wins with the membership set', {last: true, live: true}]]) {
  test(`ActorNames keeps the fresh build's map: ${label}`, () => {
    let incremental = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const {counts} = walk(seed, 400, options);
      incremental += counts.updates;
    }
    // most advances are followed incrementally (the walk compacts and swaps now and then)
    assert.ok(incremental > 2000, `${incremental} incremental updates`);
  });
}

test('ActorNames js mode rebuilds at every advance', () => {
  const names = new ActorNames();
  const actors = [{name: 'a'}, {name: 'b'}];
  names.at(actors, 1, 'js');
  actors.push({name: 'c'});
  names.at(actors, 2, 'js');
  names.at(actors, 3, 'js');
  assert.equal(names.counts.rebuilds, 3);
  assert.equal(names.counts.updates, 0);
});

test('ActorNames follows an append and a destroy without rebuilding, and rebuilds for a shared name', () => {
  const names = new ActorNames();
  const a = {name: 'a'}, b = {name: 'b'}, b2 = {name: 'b'};
  const actors = [a, b];
  names.at(actors, 1);
  assert.equal(names.counts.rebuilds, 1);
  actors.push(b2);
  names.at(actors, 2);
  actors[2] = null;
  actors[0] = null;
  assert.equal(names.at(actors, 3).get('b'), b);
  assert.equal(names.at(actors, 3).has('a'), false);
  assert.equal(names.counts.rebuilds, 1);
  // the holder of a shared name is destroyed: the next entry of the name is first, which only a rebuild settles
  actors.push(b2);
  names.at(actors, 4);
  actors[1] = null;
  assert.equal(names.at(actors, 5).get('b'), b2);
  assert.equal(names.counts.rebuilds, 2);
});

test('ActorNames follows a compaction with a destroy and a spawn in the same advance, and rebuilds for a reordering', () => {
  const names = new ActorNames({last: true, live: true});
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(name => ({name}));
  const actors = [a, b, c, d];
  // (Level.Actors is one array, changed in place)
  const become = list => { actors.length = 0; actors.push(...list); };
  names.at(actors, 1);
  assert.equal(names.counts.rebuilds, 1);
  // b destroyed, the null entry compacted away, e spawned: every slot after b shifted
  become([a, c, d, e]);
  names.at(actors, 2, 'verify');
  assert.equal(names.counts.rebuilds, 1);
  assert.deepEqual([...names.byName.keys()], ['a', 'c', 'd', 'e']);
  assert.equal(names.live.has(b), false);
  assert.equal(names.live.has(null), false);
  // a destroyed (null) and a spawn: the Set holds null while the slot does
  const f = {name: 'f'};
  become([null, c, d, e, f]);
  names.at(actors, 3, 'verify');
  assert.equal(names.counts.rebuilds, 1);
  assert.equal(names.live.has(null), true);
  // the same actors in another order are not a spawn and a destroy
  become([d, c, e, f, null]);
  names.at(actors, 4, 'verify');
  assert.equal(names.counts.rebuilds, 2);
  // an actor seen again at the end is not a spawn
  become([d, c, e, f, null, d]);
  names.at(actors, 5, 'verify');
  assert.equal(names.counts.rebuilds, 3);
});

test("ActorNames js mode with the 'append' reference follows appends and rebuilds for any other change (the mesh lighting's old rule)", () => {
  const names = new ActorNames({last: true, live: true, reference: 'append'});
  const a = {name: 'a'}, b = {name: 'b'};
  const actors = [a];
  names.at(actors, 1, 'js');
  actors.push(b);
  names.at(actors, 2, 'js');
  assert.equal(names.counts.rebuilds, 1);
  assert.equal(names.byName.get('b'), b);
  actors[0] = null;
  names.at(actors, 3, 'js');
  assert.equal(names.counts.rebuilds, 2);
  assert.equal(names.byName.has('a'), false);
  assert.equal(names.live.has(a), false);
});
