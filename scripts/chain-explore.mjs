/** Scratch exploration of a map in Play's headless session (not part of the harness).
 *   node scripts/chain-explore.mjs <map> <classes,comma|*> [props,comma] [--event name] [--tag name] */
import { readdir, readFile } from 'node:fs/promises';
import './census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { openSession } from './census-stage5-session.mjs';
const args = process.argv.slice(2);
const flagValue = name => { const i = args.indexOf(`--${name}`); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const wantEvent = flagValue('event'), wantTag = flagValue('tag');
const map = args[0] ?? '00_Training';
const classes = (args[1] ?? 'Teleporter,MapExit').split(',');
const extra = (args[2] ?? '').split(',').filter(Boolean);
const root = gameDirectory();
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);
const { c } = await openSession(map, assets, { travel: {} });
c.frames(30);
const rows = classes[0] === '*' ? c.actors() : classes.flatMap(cls => c.byClass(cls));
for (const a of rows) {
  const get = f => { try { const v = c.read(a, f); return v?.name ?? v; } catch { return undefined; } };
  if (wantEvent && String(get('Event')).toLowerCase() !== wantEvent.toLowerCase()) continue;
  if (wantTag && String(get('Tag')).toLowerCase() !== wantTag.toLowerCase()) continue;
  const row = { name: a.name, at: c.pos(a).map(Math.round) };
  for (const f of ['Tag', 'URL', 'DestMap', 'Event', 'datalinkTag', 'bCollideActors', 'CollisionRadius', 'CollisionHeight', 'bEnabled', ...extra]) { const v = get(f); if (v !== undefined && v !== '' && v !== null && v !== 'None') row[f] = Array.isArray(v) ? [...v] : v; }
  console.log(JSON.stringify(row));
}
process.exit(0);
