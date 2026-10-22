/** Scratch probe (not a validator): open a session on a .dxs file as the level package and compare the live objects with the file. */
import { readdir, readFile } from 'node:fs/promises';
import './census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { parsePackage } from '../src/unreal/package.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { createSimSession } from '../src/viewer/sim-session.mjs';

const file = process.argv[2], stem = process.argv[3], ticks = Number(process.argv[4] ?? 10);
const root = gameDirectory();
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);
const bytes = new Uint8Array(await readFile(file));
const pkg = parsePackage(bytes);
const asset = { name: stem, path: file, bytes, pkg, exportsByPath: new Map(pkg.exports.map((e, i) => [e.path.toLowerCase(), i + 1])) };
const map = decodeMap(bytes);
const game = await createGame(map, asset, assets, { randomSeed: 1, presentation: true, restore: true,
  travel: { arrival: { map: stem, portal: '', url: `..\\Save\\Current\\${stem}.dxs?Name=Player?Class=DeusEx.JCDentonMale`, options: ['Name=Player', 'Class=DeusEx.JCDentonMale'], travelInfo: [], restore: { file: `${stem}.dxs`, name: stem } }, lastURL: null } });
const runtime = game.doors.scriptRuntime.runtime;
const level = runtime.levelFor(game.player.collisionActor);
console.log('created; level actors', level.actors.length, 'file actors', map.level.actors.length);

// compare the live objects with the file's tagged values
const byIndex = new Map(); for (const actor of level.actors) if (actor?.index) byIndex.set(actor.index, actor);
const mismatches = new Map(); let compared = 0, missing = 0;
const same = (a, b) => {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.fround(a) === Math.fround(b) || (Number.isNaN(a) && Number.isNaN(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  return false;
};
for (const actor of map.actors) {
  const live = byIndex.get(actor.index);
  if (!live) { missing++; (mismatches.get('(not in the live level)') ?? mismatches.set('(not in the live level)', []).get('(not in the live level)')).push(actor.name); continue; }
  for (const p of actor.properties) {
    if (!p.decoded || ![1, 2, 3, 4, 6, 13, 11, 12].includes(p.type) && !(p.type === 10 && ['Vector', 'Rotator'].includes(p.struct))) continue;
    let value;
    try { value = runtime.readNamed(live, p.name); } catch (error) { continue; }
    if (Array.isArray(value) && !(p.type === 10 && ['Vector', 'Rotator'].includes(p.struct))) value = value[p.arrayIndex];
    compared++;
    const want = p.type === 6 ? p.value : p.value;
    if (!same(want, value) && !(typeof want === 'string' && String(value).toLowerCase() === want.toLowerCase())) {
      const key = `${actor.className}.${p.name}`;
      const list = mismatches.get(key) ?? mismatches.set(key, []).get(key);
      list.push(`${actor.name}: file ${JSON.stringify(want)} live ${JSON.stringify(value)}`);
    }
  }
}
console.log(`compared ${compared} properties; ${missing} file actors missing; ${mismatches.size} differing (class.property)`);
for (const [key, list] of [...mismatches].sort((a, b) => b[1].length - a[1].length).slice(0, Number(process.env.SHOW ?? 40))) console.log(String(list.length).padStart(5), key, list[0]);

const sim = createSimSession(game, { assets });
for (let i = 0; i < ticks; i++) { game.tick(1 / 60); sim.sprites(); }
console.log('ticked', ticks);
console.log(game.doors.scriptRuntime.engineLog.slice(0, 60).join('\n'));
