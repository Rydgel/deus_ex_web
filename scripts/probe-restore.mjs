/** Scratch probe (not committed as a validator): open a session on a .dxs file as the level package. */
import { readdir, readFile } from 'node:fs/promises';
import './census-stage5-drivers.mjs';
import { gameDirectory } from './game-directory.mjs';
import { AssetStore } from '../src/unreal/assets.mjs';
import { parsePackage } from '../src/unreal/package.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createGame } from '../src/viewer/game.mjs';
import { createSimSession } from '../src/viewer/sim-session.mjs';

const file = process.argv[2], stem = process.argv[3];
const root = gameDirectory();
const files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${directory}`)) files.push({ path: `${directory}/${name}`, read: () => readFile(`${root}/${directory}/${name}`) });
const assets = new AssetStore(files);
const bytes = new Uint8Array(await readFile(file));
const pkg = parsePackage(bytes);
const asset = { name: stem, path: file, bytes, pkg, exportsByPath: new Map(pkg.exports.map((e, i) => [e.path.toLowerCase(), i + 1])) };
const map = decodeMap(bytes);
const game = await createGame(map, asset, assets, { randomSeed: 1, presentation: true, restore: true });
console.log('created');
const sim = createSimSession(game, { assets });
for (let i = 0; i < 10; i++) { game.tick(1 / 60); sim.sprites(); }
console.log('ticked');
