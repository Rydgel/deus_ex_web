// The navigation points a map places (PathNode, PlayerStart, PatrolPoint, HidePoint, AmbushPoint, SpawnPoint), read from the map file
// offline (src/unreal/map.mjs decodeMap), and a farthest-point sample of them: the spots scripts/spot-census.mjs visits. Measurement
// tooling only; the simulation does not use it.
//
//   node scripts/map-nav-points.mjs MAP [--limit 40]      (prints the sample as JSON)
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gameDirectory} from './game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';

export const NAV_CLASSES = /^(PathNode|PlayerStart|PatrolPoint|HidePoint|AmbushPoint|SpawnPoint|WanderPoint)$/;

let store = null;
async function assetStore() {
  if (store) return store;
  const root = gameDirectory(), files = [];
  for (const directory of ['Maps', 'System'])
    for (const name of await readdir(path.join(root, directory))) files.push({path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name))});
  return store = new AssetStore(files);
}

/** Every Maps/*.dx's name, without the extension. */
export async function mapNames() {
  return (await readdir(path.join(gameDirectory(), 'Maps'))).filter(n => /\.dx$/i.test(n)).map(n => n.replace(/\.dx$/i, '')).sort();
}

/** The placed navigation points of a map: [{cls, location:[x,y,z]}], in actor order, duplicates (same rounded location) dropped. */
export async function navPoints(map) {
  const model = decodeMap((await (await assetStore()).get(map)).bytes), seen = new Set(), points = [];
  for (const a of model.actors) {
    if (!a.values.Location || !NAV_CLASSES.test(a.className)) continue;
    const key = a.values.Location.map(v => Math.round(v)).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({cls: a.className, location: [...a.values.Location]});
  }
  return points;
}

/** Farthest-point sampling in 3D: the first point is the first PlayerStart (else the first point), each next one the point farthest from
 * those chosen. Deterministic. */
export function farthestPoints(points, limit = 40) {
  if (points.length <= limit) return [...points];
  const start = Math.max(0, points.findIndex(p => p.cls === 'PlayerStart'));
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const chosen = [points[start]], near = points.map(p => distance(p.location, points[start].location));
  while (chosen.length < limit) {
    let best = 0;
    for (let i = 1; i < points.length; i++) if (near[i] > near[best]) best = i;
    chosen.push(points[best]);
    for (let i = 0; i < points.length; i++) near[i] = Math.min(near[i], distance(points[i].location, points[best].location));
  }
  return chosen;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const map = process.argv[2], i = process.argv.indexOf('--limit'), limit = i < 0 ? 40 : Number(process.argv[i + 1]);
  const all = await navPoints(map), sample = farthestPoints(all, limit);
  console.log(JSON.stringify({map, points: all.length, sample}, null, 1));
}
