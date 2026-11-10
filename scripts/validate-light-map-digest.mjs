/** The page's light-map records and BSP triangles unchanged by their compact storage (docs/firefox-60fps-plan.md "The collector's
 * window"). For each map: createWorld as the page does, then a SHA-256 over (1) every BSP triangle of the decoded map (points, surface,
 * node), (2) every light-map record the world's lighting made, in the order its surfaces list them (level surfaces by surface index,
 * then the movers' owned records): width, height, light-map index, zone, surface index, the surface and light-map tables' values, the
 * normal, the light lists (entries and the set), the facet and texel grid geometryFor gives, the texels, base texels and float
 * pixels (raw bytes), and the basis and uv functions sampled at the corners and the middle of the grid, and (3) the world's meshes'
 * attribute arrays (positions, normals, uvs, light-map coordinates and bounds), in scene order. NaN is hashed as one pattern; every
 * other double as its eight bytes. The digests in light-map-digests.json were recorded on c5809462, before the compact storage.
 *
 *   node scripts/validate-light-map-digest.mjs [--maps 01_NYC_UNATCOIsland,00_Training] [--record]
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createWorld } from '../src/viewer/world.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { gameDirectory } from './game-directory.mjs';

const NAME = 'validate-light-map-digest';
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const maps = option('maps', '01_NYC_UNATCOIsland,00_Training').split(',').filter(Boolean);
const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'light-map-digests.json');
let root; try { root = gameDirectory(); } catch { console.log(`SKIP ${NAME}: no installed game data`); process.exit(0); }

const NAN = Buffer.from('7ff8000000000000', 'hex');
function numbers(hash, values) {
  const out = Buffer.alloc(8 * values.length);
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(values[i])) NAN.copy(out, 8 * i); else out.writeDoubleLE(values[i], 8 * i);
  }
  hash.update(out);
}
const bytes = (hash, view) => hash.update(Buffer.from(view.buffer, view.byteOffset, view.byteLength));
function value(hash, v) {
  if (v === null || v === undefined) return void hash.update(`${v}|`);
  if (typeof v === 'number') return numbers(hash, [v]);
  if (typeof v === 'boolean' || typeof v === 'string') return void hash.update(`${v}|`);
  if (ArrayBuffer.isView(v)) return bytes(hash, v);
  if (Array.isArray(v)) { hash.update(`[${v.length}|`); for (const item of v) value(hash, item); return; }
  if (v instanceof Set) return value(hash, [...v].sort((a, b) => a - b));
  hash.update('{');
  for (const key of Object.keys(v).sort()) { hash.update(`${key}:`); value(hash, v[key]); }
  hash.update('}');
}

function recordDigest(hash, lighting, record) {
  const { width, height } = record;
  value(hash, [width, height, record.index, record.zone, record.surfaceIndex, record.dynamicLight, record.owner ?? null]);
  value(hash, record.surface); value(hash, record.lightMap); value(hash, record.normal);
  value(hash, record.lightEntries); value(hash, record.lightRefs);
  const { facet, grid } = lighting.geometryFor(record);
  value(hash, facet); value(hash, grid);
  value(hash, record.texels); value(hash, record.baseTexels); value(hash, record.pixels);
  value(hash, record.animated?.length ?? null); value(hash, record.staticPixels); value(hash, record.header); value(hash, record.pose?.facet ?? null);
  const { basis } = record;
  value(hash, basis.normal);
  for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1], [width >> 1, height >> 1]]) {
    const point = basis.point(x, y);
    value(hash, point); value(hash, basis.uv(point)); value(hash, record.uv(point)); value(hash, record.transform(point));
  }
  value(hash, record.transformNormal(basis.normal));
}

async function digest(name, assets) {
  const asset = await assets.get(name), map = decodeMap(asset.bytes);
  const triangles = createHash('sha256');
  for (const t of map.triangles) value(triangles, [t.points, t.surface, t.node]);
  const world = await createWorld(map, asset, assets);
  const { lightMaps: lighting } = world, records = createHash('sha256');
  let count = 0, animated = 0, texels = 0;
  const each = record => { recordDigest(records, lighting, record); count++; texels += record.width * record.height; if (record.animated?.length) animated++; };
  for (let surface = 0; surface < map.model.surfaces.length; surface++) for (const record of lighting.recordsFor(map.model, surface)) each(record);
  const owned = lighting.ownedRecords().length;
  for (const record of lighting.ownedRecords()) each(record);
  const meshes = createHash('sha256');
  let meshCount = 0;
  world.root.traverse(object => {
    if (!object.isMesh) return;
    meshCount++;
    for (const key of Object.keys(object.geometry.attributes).sort()) { meshes.update(`${key}|`); bytes(meshes, object.geometry.attributes[key].array); }
    if (object.geometry.index) bytes(meshes, object.geometry.index.array);
  });
  const result = { triangles: map.triangles.length, trianglesSha: triangles.digest('hex'), records: count, owned, animated, texels,
    recordsSha: records.digest('hex'), meshes: meshCount, meshesSha: meshes.digest('hex'), counts: world.counts };
  world.dispose?.();
  return result;
}

const files = [];
for (const directory of ['Maps', 'System', 'Textures']) for (const entry of await readdir(path.join(root, directory)))
  files.push({ path: `${directory}/${entry}`, read: () => readFile(path.join(root, directory, entry)) });
const assets = new AssetStore(files);
await loadScriptVmKernel();
const record = process.argv.includes('--record');
let golden = {};
try { golden = JSON.parse(await readFile(goldenPath, 'utf8')); } catch { /* a first recording */ }
let failed = 0;
for (const name of maps) {
  const got = await digest(name, assets);
  console.log(`${name}: ${got.triangles} triangles, ${got.records} light-map records (${got.owned} mover, ${got.animated} animated, ${got.texels} texels), ${got.meshes} meshes`);
  if (record) { golden[name] = got; continue; }
  const want = golden[name];
  if (!want) { console.log(`FAIL ${NAME}: no recorded digest for ${name}`); failed++; continue; }
  for (const key of Object.keys(want)) {
    if (JSON.stringify(want[key]) !== JSON.stringify(got[key])) { console.log(`FAIL ${NAME}: ${name} ${key}: recorded ${JSON.stringify(want[key])}, now ${JSON.stringify(got[key])}`); failed++; }
  }
}
if (record) { await writeFile(goldenPath, `${JSON.stringify(golden, null, 1)}\n`); console.log(`${NAME}: recorded ${maps.join(', ')} in ${path.relative(process.cwd(), goldenPath)}`); }
else if (failed) process.exit(1);
else console.log(`PASS ${NAME}: ${maps.join(', ')} (triangles, light-map records, world meshes) match the digests recorded before the compact storage`);
