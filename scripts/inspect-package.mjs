import { readFile } from 'node:fs/promises';
import { parsePackage, summarizePackage } from '../src/unreal/package.mjs';

const [filename, option] = process.argv.slice(2);
if (!filename || (option && option !== '--tables')) {
  console.error('Usage: npm run inspect -- <package.u|map.dx|textures.utx> [--tables]');
  process.exitCode = 2;
} else {
  try {
    const pkg = parsePackage(await readFile(filename));
    console.log(JSON.stringify(option === '--tables' ? pkg : summarizePackage(pkg), null, 2));
  } catch (error) {
    console.error(`${filename}: ${error.message}`);
    process.exitCode = 1;
  }
}
