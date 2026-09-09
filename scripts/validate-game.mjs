import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gameDirectory } from './game-directory.mjs';
import { decodeMap } from '../src/unreal/map.mjs';

try {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : gameDirectory();
  const directory = path.join(root, 'Maps');
  const files = (await readdir(directory)).filter(f => /\.dx$/i.test(f)).sort();
  const maps = [];
  for (const filename of files) {
    try {
      const { summary } = decodeMap(await readFile(path.join(directory, filename)));
      maps.push({ file: filename, ...summary });
    } catch (error) {
      maps.push({ file: filename, error: error.message });
    }
  }
  const errors = maps.filter(m => m.error);
  console.log(JSON.stringify({ maps: maps.length, errors: errors.length, results: maps }, null, 2));
  if (errors.length || !maps.length) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
