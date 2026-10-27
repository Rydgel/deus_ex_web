/** Name lookups see only the classes the original holds (docs/class-graph-design.md, migration step 1c). StaticFindObject(UClass,
 * ANY_PACKAGE, name) (Core 0x10151de0) searches the objects in memory; in the original a class is in memory when a load request reached it
 * (or a DLL registered it), and Play also links classes for its own readiness that the original never loads. Play's lookup
 * (original-loaded.mjs findClass, ScriptRuntime.originalClass) goes over the original-loaded tracker instead of the linked classes.
 *
 * The original reference is the capture gc3 (`.work/travel/gc3.steps`, outside Git; docs/class-lifetime.md "Name lookups: gc3"): four SETs
 * typed on DX.dx, then `open 00_Training` and the ScaleGlow (0x18c) of the objects read back there. Its shots show the console's message
 * line after each SET: "Unrecognized class DeusEx.LightSwitch", none, none, "Unrecognized class NoSuchPackage.SecurityCamera" (transcribed
 * into EXPECTED below).
 *
 * Checks, with Play's session on DX (as validate-class-default-travel builds it):
 * - the capture's DX.dx dump: LightSwitch is not held; Multitool, NanoKey and SecurityCamera are, and keep their class object into Training;
 * - every class Play linked on DX is found by name exactly when the original's DX.dx dump holds it (the classes Play linked only for its
 *   readiness are misses), apart from the explicit boundaries (a class the DLLs register without a graph record);
 * - each SET prints the original's console line and writes the ScaleGlow default of the found classes only, and Training attaches to DX's
 *   process: Multitool and NanoKey are the same class objects there, with the written defaults;
 * - in Training, every object of the four classes has the original's ScaleGlow: LightSwitch and SecurityCamera keep the package default,
 *   Multitool has 0.5 (loaded, no live object: the default alone was written) and NanoKey 0.75 (`Engine.NanoKey`: Engine holds no NanoKey, so
 *   the ANY_PACKAGE walk finds DeusEx.NanoKey).
 *
 *   node scripts/validate-original-lookups.mjs [--captures .work/travel/gc3] */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import './census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { loadAssets, typeLine } from './chain-play.mjs';
import { openSession } from './census-stage5-session.mjs';
import { UnmodelledClassLookup } from '../src/runtime/original-loaded.mjs';

const NAME = 'validate-original-lookups';
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const captures = option('captures', '.work/travel/gc3');
// [console line, the original's message line (gc3's shots), the class whose objects are read in Training, the label of its read-back]
const EXPECTED = [
  ['set DeusEx.LightSwitch ScaleGlow 0.25', 'Unrecognized class DeusEx.LightSwitch', 'LightSwitch', 'training-lightswitch'],
  ['set DeusEx.Multitool ScaleGlow 0.5', '', 'Multitool', 'training-multitool'],
  ['set Engine.NanoKey ScaleGlow 0.75', '', 'NanoKey', 'training-nanokey'],
  ['set NoSuchPackage.SecurityCamera ScaleGlow 0.4', 'Unrecognized class NoSuchPackage.SecurityCamera', 'SecurityCamera', 'training-camera'],
];

try { gameDirectory(); } catch { console.log(`SKIP ${NAME}: no installed game data`); process.exit(0); }
const needed = ['dx.gflags.txt', 'training.gflags.txt', ...EXPECTED.map(([, , , label]) => `${label}.props.txt`)].map(file => join(captures, file));
const absent = needed.filter(file => !existsSync(file));
if (absent.length) { console.log(`SKIP ${NAME}: no original capture (${absent.join(', ')}; scripts/travel-probe.sh gc3 @.work/travel/gc3.steps)`); process.exit(0); }

const failures = [], notes = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };
// the original's classes at a stop: "package.class" -> class object address
const dumpClasses = stop => {
  const out = new Map();
  for (const line of readFileSync(join(captures, `${stop}.gflags.txt`), 'utf8').split('\n')) {
    const m = /^slot\s+\d+ index\s+\d+ Class\.(\S+) ptr (0x\w+) flags 0x\w+ outer 0x\w+ (\S*)/.exec(line);
    if (m) out.set(`${m[3]}.${m[1]}`.toLowerCase(), m[2]);
  }
  return out;
};
// the original's read-back: the ScaleGlow of each object of the class (`Class Name ScaleGlow=value` lines)
const readBack = (label, cls) => readFileSync(join(captures, `${label}.props.txt`), 'utf8').split('\n')
  .map(line => /^(\S+) (\S+) ScaleGlow=(\S+)$/.exec(line)).filter(m => m && m[1].toLowerCase() === cls.toLowerCase())
  .map(m => ({name: m[2], value: Math.fround(Number(m[3]))}));

const dx = dumpClasses('dx'), training = dumpClasses('training');
check(!dx.has('deusex.lightswitch'), 'gc3: the original holds LightSwitch on DX.dx');
for (const key of ['deusex.multitool', 'deusex.nanokey', 'deusex.securitycamera'])
  check(dx.has(key) && dx.get(key) === training.get(key), `gc3: ${key} is not held on DX.dx and kept into Training (${dx.get(key)} -> ${training.get(key)})`);

const assets = await loadAssets();
let session = null, c = null;
const open = async (map, options) => {
  session?.dispose(); session = null; c = null;
  for (let i = 0; i < 2; i++) await new Promise(resolve => setImmediate(resolve));
  session = await openSession(map, assets, options);
  c = session.c;
};
await open('DX', { travel: { snapshotSource: () => null } });
c.frames(60);

// every class Play linked on DX: found by name exactly when the original holds it
{
  let found = 0, misses = 0, boundaries = 0;
  const wrong = [];
  for (const cls of c.runtime.linkedClasses) {
    const key = cls.record.key;
    let result;
    try { result = c.runtime.originalClass(key); } catch (error) {
      if (!(error instanceof UnmodelledClassLookup)) throw error;
      boundaries++;
      if (!dx.has(key)) wrong.push(`${key} (a boundary, but the original does not hold it)`);
      continue;
    }
    if (result) found++; else misses++;
    if (Boolean(result) !== dx.has(key)) wrong.push(`${key} (${result ? 'found' : 'missed'}; the original ${dx.has(key) ? 'holds' : 'does not hold'} it)`);
    if (result && result !== cls) wrong.push(`${key} finds ${result.record.key}`);
  }
  check(!wrong.length, `class lookups on DX disagree with the original's dump: ${wrong.slice(0, 8).join(', ')}`);
  notes.push(`DX: of ${c.runtime.linkedClasses.size} classes Play linked, ${found} are found by name, ${misses} are misses (linked only for Play's readiness; the original does not hold them), ${boundaries} explicit boundaries`);
}

// the ScaleGlow default of each of the four classes Play has linked, and the class object (the process keeps a class into the next level)
const scaleGlowDefaults = () => new Map([...c.runtime.linkedClasses].filter(cls => EXPECTED.some(([, , name]) => cls.record.key.endsWith(`.${name.toLowerCase()}`)))
  .map(cls => [cls.record.key, {cls, value: Math.fround(c.runtime.classDefaultReference(cls, c.runtime.lookupMember(cls, 'fields', 'ScaleGlow')).get())}]));
const unwritten = scaleGlowDefaults();
const outputs = EXPECTED.map(([line, message]) => {
  const output = String(typeLine(c, line) ?? '');
  c.frames(2);
  check(output === message, `"${line}" printed "${output}" (the original: "${message}")`);
  return output;
});
notes.push(`DX console lines: ${outputs.map(output => JSON.stringify(output)).join(', ')}`);

typeLine(c, 'LocalTravel 00_Training');
let request = null;
for (let i = 0; i < 10 && !request; i++) { c.frames(1); request = c.takeTravel(); }
if (!check(Boolean(request), 'LocalTravel 00_Training made no travel request')) {
  console.log(`FAIL ${NAME}:\n  ${failures.join('\n  ')}`); process.exit(1);
}
const written = scaleGlowDefaults();
const changed = [...written].filter(([key, {value}]) => value !== unwritten.get(key)?.value).map(([key, {value}]) => `${key} ${value}`);
check(changed.length === 2 && written.get('deusex.multitool')?.value === Math.fround(0.5) && written.get('deusex.nanokey')?.value === Math.fround(0.75),
  `the SETs wrote ScaleGlow defaults ${JSON.stringify(changed)} (expected Multitool 0.5 and NanoKey 0.75 only)`);

await open(request.map, { travel: { snapshotSource: () => null, arrival: request, lastURL: request.lastURL } });
c.frames(30);
// Training's process is DX's: Multitool and NanoKey are the classes the SETs wrote, Defaults included (the original keeps them: gc3's dumps)
const kept = scaleGlowDefaults();
for (const key of ['deusex.multitool', 'deusex.nanokey'])
  check(kept.get(key)?.cls === written.get(key)?.cls && kept.get(key)?.value === written.get(key)?.value,
    `Training's ${key} is not the class DX's SET wrote (${kept.get(key)?.value} after ${written.get(key)?.value})`);
for (const [, , cls, label] of EXPECTED) {
  const original = readBack(label, cls), play = c.byClass(cls).map(actor => ({name: c.runtime.instance(actor).name ?? '?', value: Math.fround(c.read(actor, 'ScaleGlow'))}));
  const originalValues = [...new Set(original.map(o => o.value))], playValues = [...new Set(play.map(p => p.value))];
  check(original.length > 0 && play.length > 0 && originalValues.length === 1 && playValues.length === 1 && originalValues[0] === playValues[0],
    `Training's ${cls} ScaleGlow: Play ${JSON.stringify(play)}, the original ${JSON.stringify(original)}`);
  notes.push(`Training ${cls}: the original ${original.length} objects at ${originalValues.join('/')}, Play ${play.length} at ${playValues.join('/')}`);
}
session?.dispose();

for (const note of notes) console.log(`  ${note}`);
if (failures.length) { console.log(`FAIL ${NAME}:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log(`PASS ${NAME}: on DX.dx, SET finds a class by name exactly when the original holds it (a class Play linked only for its readiness is "Unrecognized"), the ANY_PACKAGE walk and ResolveName's miss match the original, and Training's objects carry the original's ScaleGlow (capture gc3)`);
