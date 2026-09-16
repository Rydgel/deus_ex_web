/**
 * Dump decoded UFont exports as JSON for the text-metrics oracle.
 *
 * Usage: node scripts/dump-font-image.mjs GAME_ROOT [Package.Font ...]
 *
 * Prints {"fonts": {"Package.Font": {format, pageCount, charsPerPage,
 * serialSize, pages: [{header:[..4 bytes..], chars:[[startU,startV,uSize,
 * vSize] x charsPerPage]}]}}} on stdout.  The decode is the shared model's
 * decodeFontExport; the oracle re-verifies the byte layout before building
 * its Unicorn image.
 */
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeFontExport} from '../src/runtime/script-font-model.mjs';

const root = path.resolve(process.argv[2] ?? '.');
const names = process.argv.slice(3);

const assets = new AssetStore((await readdir(path.join(root, 'System'))).map(name => ({
  path: `System/${name}`,
  read: () => readFile(path.join(root, 'System', name)),
})));

const fonts = {};
for (const name of names) {
  const [pkgName, fontName] = name.split('.', 2);
  const asset = await assets.get(pkgName);
  const exp = asset.pkg.exports.find(e => e.name === fontName && e.className === 'Font');
  if (!exp) throw new Error(`no Font export ${name}`);
  const bytes = new Uint8Array(asset.bytes.buffer, asset.bytes.byteOffset + exp.serialOffset, exp.serialSize);
  fonts[name] = decodeFontExport(bytes, name);
}
process.stdout.write(JSON.stringify({fonts}));
