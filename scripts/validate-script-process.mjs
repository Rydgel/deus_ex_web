/** The script process and the level (docs/class-graph-design.md "The process and the level", migration steps 2-3;
 * src/runtime/script-process.mjs). A level's ScriptRuntime keeps its own identities (its package's exports, the objects it attaches)
 * and shares the package identities, readiness, classes and class loader with its process.
 *
 * Checks, after a cold load of 00_Training:
 * - the process table holds no export of the level package and no object a level attaches (script-objects.mjs exportScope), and every
 *   identity in it is one the process holds (ScriptProcess.owns), so a level's handle release keeps it;
 * - the level table holds only the level package's exports and the objects the level attaches, none of them the process's;
 * - the runtime's classes, linked classes and readiness tables are the process's.
 *
 *   node scripts/validate-script-process.mjs */
import { readFile, readdir } from 'node:fs/promises';
import { gameDirectory } from './game-directory.mjs';
import { METADATA_KINDS } from '../src/runtime/original-loaded.mjs';

const NAME = 'validate-script-process';
try { gameDirectory(); } catch { console.log(`SKIP ${NAME}: no installed game data`); process.exit(0); }
const { AssetStore } = await import('../src/unreal/assets.mjs');
const { decodeMap } = await import('../src/unreal/map.mjs');
const { createGame } = await import('../src/viewer/game.mjs');

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({ path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`) });
const assets = new AssetStore(files);
const failures = [], notes = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };

const asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: true });
const runtime = game.doors.scriptRuntime.runtime, shared = runtime.process, objects = runtime.objects;
const levelPackage = identity => /\.(dx|dxs|unr)$/i.test(identity.asset?.path ?? '');

{
  const misplaced = [], unheld = [];
  for (const [key, identity] of shared.packageObjects) {
    if (levelPackage(identity) || !(METADATA_KINDS.has(identity.kind) || objects.tableOf(identity.asset, identity.entry) === shared.packageObjects)) misplaced.push(key);
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
    else if (objects.tableOf(identity.asset, identity.entry) === objects.objects && !METADATA_KINDS.has(identity.kind)) attached++;
    else misplaced.push(key);
    if (shared.owns(identity)) misplaced.push(`${key} (held by the process)`);
  }
  check(!misplaced.length, `the level table holds process identities: ${misplaced.slice(0, 8).join(' ')}`);
  notes.push(`level table: ${objects.objects.size} identities, ${fromLevel} of the level package, ${attached} objects the level attaches`);
}
check(runtime.classes === shared.classes && runtime.linkedClasses === shared.linkedClasses && runtime.functions === shared.functions &&
  runtime.states === shared.states && runtime.structs === shared.structs && runtime.structLayouts === shared.structLayouts &&
  runtime.contextResults === shared.contextResults && runtime.classLoader === shared.classLoader && runtime.resources === shared.resources,
  'the runtime\'s classes, readiness, class loader or resource registry are not the process\'s');
check(runtime.actorClass && runtime.actorClass === shared.actorClass, 'Engine.Actor\'s class is not the process\'s');
notes.push(`classes: ${shared.linkedClasses.size} linked, ${shared.functions.size} prepared functions, ${shared.states.size} prepared states`);

for (const note of notes) console.log(`  ${note}`);
if (failures.length) { console.log(`FAIL ${NAME}:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log(`PASS ${NAME}: on a cold 00_Training load the level's identities and the process's are apart, and the classes, readiness and class loader are the process's`);
process.exit(0);
