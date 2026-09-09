import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parsePackage, summarizePackage } from '../src/unreal/package.mjs';
import { gameDirectory } from './game-directory.mjs';

let root;
const extensions = new Set(['.u', '.utx', '.uax', '.umx', '.dx', '.unr']);

async function walk(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(filename));
    else if (entry.isFile()) paths.push(filename);
  }
  return paths.sort();
}

try {
  root = process.argv[2] ? path.resolve(process.argv[2]) : gameDirectory();
  const files = await walk(root);
  const packages = [];
  const errors = [];
  const fileTypes = {};
  let totalBytes = 0;
  for (const filename of files) {
    const extension = path.extname(filename).toLowerCase() || '(none)';
    fileTypes[extension] = (fileTypes[extension] ?? 0) + 1;
    totalBytes += (await stat(filename)).size;
    if (!extensions.has(extension)) continue;
    const relative = path.relative(root, filename).split(path.sep).join('/');
    try {
      const bytes = await readFile(filename);
      packages.push({
        path: relative, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        ...summarizePackage(parsePackage(bytes)),
      });
    } catch (error) {
      errors.push({ path: relative, error: error.message });
    }
  }
  const available = new Set(packages.map(pkg => path.parse(pkg.path).name.toLowerCase()));
  for (const pkg of packages) {
    pkg.unresolvedDependencies = pkg.dependencies.filter(name => !available.has(name.toLowerCase()));
  }
  const result = {
    files: files.length, totalBytes, fileTypes, packages, errors,
    note: 'Package tables only; payloads, native DLL behavior, and gameplay are not decoded.',
  };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length || !packages.length) process.exitCode = 1;
} catch (error) {
  console.error(`Cannot inventory ${root}: ${error.message}`);
  process.exitCode = 1;
}
