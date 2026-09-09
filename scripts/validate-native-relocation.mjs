import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { farMoveActor, setCollisionSize } from '../src/runtime/relocation.mjs';
import { gameDirectory } from './game-directory.mjs';

export function relocationCases() {
  const cases = [], booleans = [false, true];
  for (const actorFlags of [0, 1, 0x80000, 0x80001, 0xa0000])
    for (const collisionFlags of [0, 1, 2, 3])
      for (const editor of booleans) for (const test of [0, 1]) for (const noCheck of [0, 1])
        for (const fitSuccess of booleans) for (const encroached of booleans) for (const hashPresent of booleans)
          cases.push({ actorFlags, collisionFlags, editor, test, noCheck, fitSuccess, encroached, hashPresent, fitted: [101, 202, 303] });
  for (const netMode of [0, 3]) for (const standingCount of [0, 1, 255]) for (const test of [0, 1])
    cases.push({ netMode, standingCount, test, actorFlags: 0xa0000, collisionFlags: 1,
      children: [true, false, true], motionFlags: 0x420, oldLocation: [6, 7, 8] });
  for (const collisionFlags of [0, 1, 3]) for (const hashPresent of booleans)
    for (const newSize of [[20, 16], [20, 43], [0, 0], [-1, -2]]) cases.push({ collisionFlags, hashPresent, newSize });
  return cases;
}

/** Replay only explicit native scene callback fixtures; no geometry is implied. */
export function relocationFixture(c) {
  const f = Math.fround, events = [], world = {};
  const actor = { actorFlags: c.actorFlags ?? 0x80000, flags: c.collisionFlags ?? 3,
    position: (c.position ?? [1,2,3]).map(f), oldLocation: (c.oldLocation ?? [4,5,6]).map(f),
    rotation: c.rotation ?? [0,16384,0], radius: f(c.extent?.[0] ?? 20), height: f(c.extent?.[1] ?? 43),
    standingCount: c.standingCount ?? 0, motionFlags: c.motionFlags ?? 0 };
  let registered = Boolean((c.hashPresent ?? true) && (actor.flags & 1));
  const children = (c.children ?? []).map((based, id) => ({ id, base: based ? actor : world }));
  const state = () => ({ position: actor.position.slice(), oldLocation: actor.oldLocation.slice(),
    radius: actor.radius, height: actor.height, motionFlags: actor.motionFlags, registered });
  const event = (name, data = {}) => events.push({ event: name, before: state(), ...data });
  const level = { editor: c.editor ?? false, netMode: c.netMode ?? 0, actors: [world, actor, ...children],
    hash: (c.hashPresent ?? true) ? {
      removeActor() { event('remove'); registered = false; },
      addActor() { event('add'); registered = true; },
    } : null,
    findSpot(extent, position, ...options) {
      event('findSpot', { extent, position: position.slice(), options });
      position.splice(0, 3, ...(c.fitted ?? position).map(f));
      return c.fitSuccess ?? true;
    },
    checkEncroachment(target, position, rotation, notify) {
      event('encroachment', { position: position.slice(), rotation: rotation.slice(), notify });
      return c.encroached ?? false;
    },
    setBase(child, base, notify) { event('setBase', { actor: child.id, base: 0, notify: Number(notify) }); child.base = base; },
    setActorZone(target, ...options) { event('zone', { options }); },
  };
  const success = c.newSize ? (setCollisionSize(level, actor, ...c.newSize), null)
    : farMoveActor(level, actor, c.destination ?? [100,200,300], c.test ?? 0, c.noCheck ?? 0);
  return { success, ...state(), events, childrenBased: children.map(child => child.base === actor) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = 'reports/movement/native-relocation';
  await mkdir(directory, { recursive: true });
  const cases = relocationCases();
  await writeFile(`${directory}/cases.json`, JSON.stringify(cases));
  if (!process.argv.includes('--reuse')) {
    const native = spawnSync(process.env.NATIVE_PROBE_PYTHON ?? '.cache/native-probe-env/bin/python',
      ['scripts/native-relocation-oracle.py', gameDirectory(), `${directory}/cases.json`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (native.status !== 0) throw Error(native.stderr);
    await writeFile(`${directory}/original.json`, native.stdout);
  }
  const original = JSON.parse(await readFile(`${directory}/original.json`, 'utf8'));
  assert.equal(original.results.length, cases.length);
  let mismatches = 0;
  for (const [index, c] of cases.entries()) {
    const actual = relocationFixture(c);
    try { assert.deepEqual(actual, original.results[index]); }
    catch { if (mismatches++ < 5) console.log(JSON.stringify({ index, case: c, actual, expected: original.results[index] })); }
  }
  console.log(JSON.stringify({ cases: cases.length, mismatches }));
  if (mismatches) process.exitCode = 1;
}
