/** The script process and the level (docs/class-graph-design.md "The process and the level", migration steps 2-3;
 * src/runtime/script-process.mjs). A level's ScriptRuntime keeps its own identities (its package's exports, the objects it attaches)
 * and shares the package identities, readiness, classes and class loader with its process.
 *
 * Step 2, after a cold load of 00_Training:
 * - the process table holds no export of the level package and no object a level attaches (script-objects.mjs exportScope), and every
 *   identity in it is one the process holds (ScriptProcess.owns), so a level's handle release keeps it;
 * - the level table holds only the level package's exports and the objects the level attaches, none of them the process's;
 * - the runtime's classes, linked classes and readiness tables are the process's.
 *
 * Step 3, one process over the gc2 probe's map changes (DX, then `open` 00_Training, 01_NYC_UNATCOIsland, 00_Training; capture gc2,
 * docs/class-lifetime.md), each arrival a session that attaches to the process of the session left (census-stage5-session.mjs):
 * - the arrival's runtime is new and its process is the one left: every class linked before is the same class object (its Defaults and
 *   its ClassUnique counter kept), unless the arrival's collection purged it (step 4a, validate-process-collection checks which), and
 *   only the classes the level adds are linked;
 * - the level left's identities leave the handle table and the process's keep their handles;
 * - no process identity is attached as a script instance of any level (an attached identity would pin its level's runtime);
 * - each level runs its first 120 frames;
 * - after the last arrival a full GC frees every level left: nothing the process keeps (readiness, the class loader's services)
 *   holds a runtime (two did: a compiled body's operand cache kept the services of the runtime that ran it last, and the class
 *   loader's closures shared the first runtime's constructor scope).
 *
 *   node scripts/validate-script-process.mjs */
import { readFile, readdir } from 'node:fs/promises';
import v8 from 'node:v8';
import vm from 'node:vm';
import { gameDirectory } from './game-directory.mjs';
import { METADATA_KINDS } from '../src/runtime/original-loaded.mjs';
import { entryOf } from '../src/unreal/objects.mjs';

const NAME = 'validate-script-process';
try { gameDirectory(); } catch { console.log(`SKIP ${NAME}: no installed game data`); process.exit(0); }
// The harness's simulated clock first (census-stage5-drivers.mjs), before any module captures the real timers: a level's real-time
// timer still pending at the retention check would hold its runtime until it fires.
await import('./census-stage5-drivers.mjs');
const { AssetStore } = await import('../src/unreal/assets.mjs');
const { decodeMap } = await import('../src/unreal/map.mjs');
const { createGame } = await import('../src/viewer/game.mjs');

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({ path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`) });
const assets = new AssetStore(files);
const failures = [], notes = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };

// Step 3 first: one process over the probe's map changes.
const { typeLine } = await import('./chain-play.mjs');
const { openSession } = await import('./census-stage5-session.mjs');
const { liveHandleIdentities } = await import('../src/runtime/script-object-handles.mjs');
const stopsLabel = stops => stops.at(-1)?.split(':')[0] ?? 'a level';
// The left level's identities as WeakRefs, and how many of them still hold a handle: holding the identities themselves here would keep
// the left runtime alive for the retention check below.
const levelIdentities = runtime => [...runtime.objects.objects.values()].map(identity => new WeakRef(identity));
const stillHeld = refs => { const live = new Set(liveHandleIdentities()); return refs.filter(ref => live.has(ref.deref())).length; };
// Each arrival runs in a function of its own and returns plain data with a WeakRef to the runtime it left: a level's identities or
// runtime held in the module's frame would keep that runtime alive for the retention check below.
let session = null, shared = null, firstClasses = null;
async function arrive(map, stops) {
  const left = session.c.runtime, before = shared.linkedClasses.size, ref = new WeakRef(left);
  typeLine(session.c, `open ${map}`);
  let request = null;
  for (let i = 0; i < 10 && !request; i++) { session.c.frames(1); request = session.c.takeTravel(); }
  if (!check(Boolean(request), `open ${map} made no travel request`)) return null;
  const leftLevel = levelIdentities(left);
  session.dispose(); session = null;
  for (let i = 0; i < 2; i++) await new Promise(resolve => setImmediate(resolve));
  const released = stillHeld(leftLevel);
  check(released === 0, `${map}: ${released} identities of the level left still hold handles`);
  const start = process.hrtime.bigint();
  session = await openSession(request.map, assets, { travel: { snapshotSource: () => null, arrival: request, lastURL: request.lastURL }, process: shared });
  const ms = Number((process.hrtime.bigint() - start) / 1000000n), runtime = session.c.runtime;
  check(session.process === shared && runtime !== left && runtime.process === shared && shared.runtime === runtime, `${map}: the arrival did not attach to the process left`);
  const changed = [...firstClasses].filter(([key, cls]) => !cls.purged && (!shared.linkedClasses.has(cls) || runtime.classes.get(key) === undefined)).map(([key]) => key);
  check(!changed.length, `${map}: classes linked on DX left the process without a collection: ${changed.slice(0, 6).join(' ')}`);
  const attached = [];
  // ScriptRuntime.linkInstance defines the runtime's `instanceKey` symbol on an attached object (readiness caches use other symbols)
  for (const identity of shared.packageObjects.values())
    if (Object.getOwnPropertySymbols(identity).some(symbol => symbol.description === 'ScriptRuntime instance')) attached.push(identity.key);
  check(!attached.length, `${map}: process identities attached as instances: ${attached.slice(0, 6).join(' ')}`);
  // a frame that reaches a runtime error throws (census-stage5-session.mjs)
  try { session.c.frames(120); } catch (error) { check(false, `${map}: ${String(error.message).slice(0, 300)}`); }
  stops.push(`${map}: ${ms} ms to open, ${shared.linkedClasses.size - before} classes linked (${shared.linkedClasses.size} in the process)`);
  return { map: stopsLabel(stops.slice(0, -1)), ref };
}
{
  session = await openSession('DX', assets, { travel: { snapshotSource: () => null } });
  shared = session.process; firstClasses = new Map([...shared.linkedClasses].map(cls => [cls.record.key, cls]));
  session.c.frames(120);
  const stops = [`DX: ${shared.linkedClasses.size} classes`], leftRuntimes = [];
  for (const map of ['00_Training', '01_NYC_UNATCOIsland', '00_Training']) {
    const left = await arrive(map, stops);
    if (!left) break;
    leftRuntimes.push(left);
  }
  firstClasses = null;
  v8.setFlagsFromString('--expose_gc');
  const gc = vm.runInNewContext('gc');
  for (let i = 0; i < 4; i++) { gc(); await new Promise(resolve => setImmediate(resolve)); }
  const alive = leftRuntimes.filter(entry => entry.ref.deref()).map(entry => entry.map);
  check(!alive.length, `levels left that a GC does not free (their runtimes stay alive): ${alive.join(', ')}`);
  stops.push(`after a GC: ${leftRuntimes.length - alive.length} of ${leftRuntimes.length} levels left freed`);
  session?.dispose(); session = null; shared = null;
  notes.push(...stops);
}

// Step 2, after step 3: its cold game is never disposed, and an undisposed game in the same node process keeps another process's left
// runtimes alive (docs/class-graph-design.md, step 3, open), which step 3's retention check must not see.
await (async () => {
  const asset = await assets.get('00_Training');
  const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
  const runtime = game.doors.scriptRuntime.runtime, shared = runtime.process, objects = runtime.objects;
  const levelPackage = identity => /\.(dx|dxs|unr)$/i.test(identity.asset?.path ?? '');

  {
    const misplaced = [], unheld = [];
    for (const [key, identity] of shared.packageObjects) {
      if (levelPackage(identity) || !(METADATA_KINDS.has(identity.kind) || objects.tableOf(identity.asset, entryOf(identity)) === shared.packageObjects)) misplaced.push(key);
      if (!shared.owns(identity)) unheld.push(key);
    }
    check(!misplaced.length, `the process table holds level identities: ${misplaced.slice(0, 8).join(' ')}`);
    check(!unheld.length, `process identities the process does not hold: ${unheld.slice(0, 8).join(' ')}`);
    notes.push(`process table: ${shared.packageObjects.size} identities`);
  }
  {
    const misplaced = [];
    let fromLevel = 0, attached = 0;
    for (const [key, identity] of objects.objects) {
      if (levelPackage(identity)) fromLevel++;
      else if (objects.tableOf(identity.asset, entryOf(identity)) === objects.objects && !METADATA_KINDS.has(identity.kind)) attached++;
      else misplaced.push(key);
      if (shared.owns(identity)) misplaced.push(`${key} (held by the process)`);
    }
    check(!misplaced.length, `the level table holds process identities: ${misplaced.slice(0, 8).join(' ')}`);
    notes.push(`level table: ${objects.objects.size} identities, ${fromLevel} of the level package, ${attached} objects the level attaches`);
  }
  check(runtime.classes === shared.classes && runtime.linkedClasses === shared.linkedClasses && runtime.functions === shared.functions &&
    runtime.states === shared.states && runtime.structs === shared.structs && runtime.structLayouts === shared.structLayouts &&
    runtime.objects.links === shared.scriptLinks && runtime.classLoader === shared.classLoader && runtime.resources === shared.resources,
    'the runtime\'s classes, readiness, class loader or resource registry are not the process\'s');
  check(runtime.actorClass && runtime.actorClass === shared.actorClass, 'Engine.Actor\'s class is not the process\'s');
  notes.push(`classes: ${shared.linkedClasses.size} linked, ${shared.functions.size} prepared functions, ${shared.states.size} prepared states`);
})();

for (const note of notes) console.log(`  ${note}`);
if (failures.length) { console.log(`FAIL ${NAME}:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log(`PASS ${NAME}: the level's identities and the process's are apart; over DX, 00_Training, 01_NYC_UNATCOIsland and 00_Training one process keeps its classes, and each level's identities are released when it is left`);
process.exit(0);
