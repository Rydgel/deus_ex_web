/** Scratch probe: restore an original .dxs (session A), save it with Play's writer, restore that file (session B) and compare the two live levels.
 *   node scripts/probe-roundtrip.mjs <file.dxs> <stem> */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import './census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { parsePackage } from '../src/unreal/package.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { createSaveDirectory } from '../src/runtime/save-directory.mjs';
import { classFields } from '../src/runtime/level-save.mjs';
import { identicalValues } from '../src/runtime/tagged-write.mjs';

const [file, stem] = process.argv.slice(2);
const root = gameDirectory();
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);

async function open(bytes, directory) {
  const pkg = parsePackage(bytes);
  const asset = { name: stem, path: stem, bytes, pkg, exportsByPath: new Map(pkg.exports.map((e, i) => [e.path.toLowerCase(), i + 1])) };
  const map = decodeMap(bytes);
  const arrival = { map: stem, portal: '', url: `..\\Save\\Current\\${stem}.dxs`, options: ['Name=Player', 'Class=DeusEx.JCDentonMale'], travelInfo: [], restore: { file: `${stem}.dxs`, name: stem } };
  const game = await createGame(map, asset, assets, { randomSeed: 1, presentation: true, restore: true, saveDirectory: directory, travel: { arrival, lastURL: null } });
  return { game, map, asset, runtime: game.doors.scriptRuntime.runtime };
}

const directory = createSaveDirectory();
const A = await open(new Uint8Array(await readFile(file)), directory);
console.log('A restored:', A.map.actors.length, 'actors');
const saver = A.game.doors.scriptRuntime.levelSaver;
if (!saver) throw new Error('no level saver');
saver.pruneTravelActors();
const t0 = performance.now();
const saved = saver.saveCurrentLevel(-2);
console.log(`saved: ${saved.bytes.length} bytes, ${saved.exports} exports, ${saved.names} names, ${saved.imports} imports in ${Math.round(performance.now() - t0)} ms (original ${(await readFile(file)).length} bytes)`);
await writeFile(process.env.OUT ?? '/tmp/claude-1000/-home-rydgel-projects-deus-ex-web/17ffb3cc-f14b-449a-b0d4-176585a0cff8/scratchpad/mine/roundtrip.dxs', saved.bytes);
console.log(A.game.doors.scriptRuntime.engineLog.slice(-8).join('\n'));
const B = await open(saved.bytes, directory);
console.log('B restored:', B.map.actors.length, 'actors');

// compare the two live levels: every non-transient property of every actor present in both, by actor name
const levelOf = S => S.runtime.levelFor(S.game.player.collisionActor);
const byName = S => new Map(levelOf(S).actors.filter(Boolean).map(a => [a.name, a]));
const canon = (field, value) => {
  const t = field.metadata.type;
  if (t === 'object' || t === 'class') return value === null ? null : typeof value.key === 'string' ? value.key : (value.name ?? '?');
  if (t === 'array') return (value ?? []).map(x => (x && typeof x === 'object') ? (x.key ?? x.name) : x);
  if (t === 'struct' && value && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, (v && typeof v === 'object' && !Array.isArray(v)) ? (v.key ?? v.name ?? '?') : v]));
  return value;
};
const safe = value => { const seen = new WeakSet(); return JSON.stringify(value, (k, v) => { if (v && typeof v === 'object') { if (seen.has(v)) return '[cycle]'; seen.add(v); if (!Array.isArray(v) && (typeof v.key === 'string' || typeof v.name === 'string') && v.constructor === Object && k !== '') return v.key ?? v.name; } return v; }); };
const a = byName(A), b = byName(B);
const only = (x, y) => [...x.keys()].filter(k => !y.has(k));
console.log('actors only in A:', only(a, b).length, only(a, b).slice(0, 12).join(' '));
console.log('actors only in B:', only(b, a).length, only(b, a).slice(0, 12).join(' '));
const diffs = new Map(); let compared = 0;
for (const [name, actorA] of a) {
  const actorB = b.get(name); if (!actorB) continue;
  const cls = A.runtime.instance(actorA).cls, clsB = B.runtime.instance(actorB).cls;
  for (const field of classFields(cls)) {
    if (field.metadata.flags & 0x3000) continue;
    const fieldB = classFields(clsB).find(f => f.key === field.key); if (!fieldB) continue;
    let va, vb;
    try { va = canon(field, A.runtime.fieldReference(actorA, field).get()); vb = canon(field, B.runtime.fieldReference(actorB, fieldB).get()); } catch { continue; }
    compared++;
    if (safe(va) !== safe(vb)) {
      const key = `${cls.record.name}.${field.name}`;
      const list = diffs.get(key) ?? diffs.set(key, []).get(key);
      list.push(`${name}: A ${safe(va)?.slice(0, 60)} B ${safe(vb)?.slice(0, 60)}`);
    }
  }
}
console.log(`compared ${compared} property values; ${diffs.size} differing (class.property)`);
for (const [k, list] of [...diffs].sort((x, y) => y[1].length - x[1].length).slice(0, 40)) console.log(String(list.length).padStart(5), k, list[0]);
