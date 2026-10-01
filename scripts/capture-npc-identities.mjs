// Pre-placed pawn identities from an original GObjObjects capture
// (docs/object-index-captures.md): loads <map> in this checkout, matches every
// pre-placed Pawn of the map's package to the capture by class and name, and
// prints {count, missing, identities}; the identities object is the table a
// src/runtime/<map>-npc-identities.mjs holds.
//   node scripts/capture-npc-identities.mjs <capture.txt> <map>
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root0 = path.dirname(path.dirname(new URL(import.meta.url).pathname)), imp = p => import(pathToFileURL(path.join(root0, p)).href);
const { AssetStore } = await imp('src/unreal/assets.mjs');
const { decodeMap } = await imp('src/unreal/map.mjs');
const { createGame } = await imp('src/viewer/game.mjs');
const { gameDirectory } = await imp('scripts/game-directory.mjs');
const { loadOriginalGObjects } = await imp('scripts/original-gobjects.mjs');
const root = gameDirectory(), files = [];
for (const d of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${d}`)) files.push({ path: `${d}/${name}`, read: () => readFile(`${root}/${d}/${name}`) });
const mapName = process.argv[3] ?? process.env.MAP;
if (!process.argv[2] || !mapName) { console.error('usage: capture-npc-identities.mjs <capture.txt> <map>'); process.exit(2); }
const assets = new AssetStore(files), asset = await assets.get(mapName);
const game = await createGame(decodeMap(asset.bytes), asset, assets, { randomSeed: 1, presentation: false });
const runtime = game.doors.scriptRuntime.runtime;
const cap = await loadOriginalGObjects(process.argv[2]);
const level = runtime.levelFor(game.player.collisionActor);
const isA = (a, key) => { for (let c = runtime.instance(a).cls; c; c = c.base) if (c.record.key === key) return true; return false; };
const out = {}, missing = [];
for (const a of level.actors) {
  if (!a || a === game.player.collisionActor || a.asset?.name?.toLowerCase() !== mapName.toLowerCase()) continue;
  if (!isA(a, 'engine.pawn')) continue;
  const cls = runtime.instance(a).cls.record.name, name = runtime.readNamed(a, 'Name');
  const index = cap.indexFor(cls, name);
  if (Number.isInteger(index)) out[name] = index; else missing.push(`${cls}.${name}`);
}
console.log(JSON.stringify({ count: Object.keys(out).length, missing, identities: out }));
process.exit(0);
