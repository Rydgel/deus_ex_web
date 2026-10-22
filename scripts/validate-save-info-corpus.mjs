/** Every SaveInfo.dxs of a directory tree of original saves against save-info-write.mjs (docs/travel.md "SaveGame in full", "The SaveInfo.dxs file").
 *
 * For each file the writer is given what the original's file holds (properties, the picture's P8 indices, GUID, InternalTime, the two object names, the export
 * order) and must write the same bytes. Also checked on every file: the Texture is 256 x 128 (USize/VSize, UBits 8 / VBits 7, UClamp/VClamp the same), one P8
 * mip whose bytes outside the 160 x 120 picture are all zero, the Palette the grey ramp (i, i, i, 255), the tag order of the SaveInfo and the 33 names.
 * The sweep reports what varies across the files (name tables, export orders, property sets, sizes) so the writer's rules rest on all of them. Two things vary with
 * the original process's history and are given to the writer as they are: the order of the three object names at the end of the name table (FName index order)
 * and the order of the Texture and the Palette in the export table (GObjObjects order); everything else must come out the same.
 *
 *   node scripts/validate-save-info-corpus.mjs [--dir DIR]      (default: the main checkout's .work/internet-saves, then .work/travel/save-backup-pw1) */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parsePackage } from '../src/unreal/package.mjs';
import { readObject } from '../src/unreal/objects.mjs';
import { parseSaveInfo } from '../src/runtime/save-info.mjs';
import { writeSaveInfo } from '../src/runtime/save-info-write.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const here = new URL('..', import.meta.url).pathname;
const candidates = [option('dir', null), `${here}.work/internet-saves`, `${here}.work/travel/save-backup-pw1`, `${here}.work/travel/dxs`].filter(Boolean);
const dir = candidates.find(candidate => existsSync(candidate));
if (!dir) { console.log('SKIP validate-save-info-corpus: no SaveInfo.dxs files (the corpus is outside Git: .work/internet-saves)'); process.exit(0); }

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/(^|[^a-z])SaveInfo\.dxs$/i.test(entry.name)) yield full;
  }
}
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); return ok; };
const tally = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const tails = new Map(), nameTables = new Map(), orders = new Map(), propertySets = new Map(), sizes = [], textureSizes = new Map(), cheats = new Map(), zeroFields = new Map();
let files = 0, equal = 0;
const GREY = Uint8Array.from({ length: 1024 }, (_, i) => i % 4 === 3 ? 255 : i >> 2);
for await (const file of walk(dir)) {
  files++;
  const label = path.relative(dir, file);
  const bytes = new Uint8Array(await readFile(file));
  const pkg = parsePackage(bytes), info = parseSaveInfo(bytes);
  const textureIndex = pkg.exports.findIndex(entry => entry.className === 'Texture'), paletteIndex = pkg.exports.findIndex(entry => entry.className === 'Palette');
  if (!check(textureIndex >= 0 && paletteIndex >= 0 && info?.snapshot?.image, `${label}: no Texture and Palette exports`)) continue;
  const texture = readObject(pkg, bytes, textureIndex + 1).values;
  const image = info.snapshot.image;
  tally(textureSizes, `${texture.USize}x${texture.VSize} bits ${texture.UBits}/${texture.VBits} clamp ${texture.UClamp}x${texture.VClamp} mip ${image.width}x${image.height} format ${image.format}`);
  // the picture is the top-left 160 x 120; every byte outside it is zero (Init's, never written by GenerateSnapshot)
  let outside = 0, insideZero = 0;
  for (let i = 0; i < image.data.length; i++) {
    const inside = i % image.width < 160 && (i / image.width | 0) < 120;
    if (!inside && image.data[i] !== 0) outside++;
    if (inside && image.data[i] === 0) insideZero++;
  }
  check(outside === 0, `${label}: ${outside} nonzero bytes outside the 160 x 120 picture`);
  tally(zeroFields, insideZero === 0 ? 'no zero index in the picture' : 'zero indices inside the picture');
  check(image.colors.every((value, i) => value === GREY[i]), `${label}: the Palette is not the grey ramp`);
  const names = pkg.names.map(entry => entry.name);
  tally(nameTables, names.slice(0, names.length - 3).join(' ') + ` | +${names.length - 30}`);
  tally(orders, `${pkg.exports.map(entry => entry.className).join(',')}`);
  tally(propertySets, Object.keys(info.properties).join(','));
  tally(cheats, `bCheatsEnabled ${info.properties.bCheatsEnabled === undefined ? 'absent' : info.properties.bCheatsEnabled}`);
  sizes.push(bytes.length);
  const written = writeSaveInfo({ properties: info.properties, snapshot: { pitch: image.width, height: image.height, data: image.data }, textureFirst: textureIndex < paletteIndex,
    guid: Uint8Array.from(Buffer.from(pkg.guid, 'hex')), textureName: info.snapshot.texture, paletteName: info.snapshot.palette,
    internalTime: [texture.InternalTime, texture['InternalTime[1]']], nameTail: names.slice(names.indexOf('Core') + 1) });
  tally(tails, names.slice(names.indexOf('Core') + 1).map(name => name.replace(/\d+$/, '#')).join(' ') + ` / exports ${pkg.exports.map(entry => entry.className).join(' ')}`);
  let first = -1;
  for (let i = 0; i < Math.max(written.length, bytes.length) && first < 0; i++) if (written[i] !== bytes[i]) first = i;
  if (first < 0) equal++;
  else check(false, `${label}: the writer's bytes differ from the original's at ${first} (sizes ${written.length} / ${bytes.length}; properties ${Object.keys(info.properties)}; names ${names.join(' ')})`);
}
const show = (title, map) => { console.log(`${title}:`); for (const [key, count] of [...map].sort((a, b) => b[1] - a[1])) console.log(`  ${count} x ${key}`); };
show('end of the name table / export order (process history: not reproduced)', tails); show('Texture/mip form', textureSizes); show('picture indices', zeroFields); show('export orders', orders); show('property sets', propertySets); show('bCheatsEnabled', cheats);
console.log(`name tables (first 30 names + count of the rest): ${nameTables.size} distinct`);
console.log(`sizes ${Math.min(...sizes)}..${Math.max(...sizes)}`);
for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(failures.length ? `FAIL validate-save-info-corpus: ${files - equal} of ${files} files differ` : `PASS validate-save-info-corpus: the writer reproduces all ${files} SaveInfo.dxs files under ${dir} byte for byte`);
process.exit(failures.length ? 1 : 0);
