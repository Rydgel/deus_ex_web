/** The typed BSP model (src/unreal/bsp-model.mjs, docs/live-heap.md "Step 9's results") against the object reader it replaced
 * (test/helpers/model-reference.mjs), on every Model export of every map of the installed game: the level's world model and each
 * mover's brush. For each: every vector, point, node (plane, masks, links, bounds, zones, vertex count, flags, leaves), surface,
 * vertex, zone, light map, render bound, leaf, leaf-hull word and light actor, old object form against the typed tables as raw
 * words (Object.is on every number, so -0 and NaN are told apart), the scalar fields, the light bits, the diagnostics, the fan
 * triangulation, and the error a Model that does not read raises. Also the collision hulls (src/runtime/collision.mjs) against the
 * object hulls: see validate-collision-hulls.mjs.
 *
 *   node scripts/validate-bsp-model.mjs [--maps 01_NYC_UNATCOIsland,00_Training] */
import { readFile, readdir } from 'node:fs/promises';
import { parsePackage } from '../src/unreal/package.mjs';
import { readModel, triangulateModel } from '../src/unreal/model.mjs';
import { modelObjects } from '../src/unreal/bsp-model.mjs';
import { readModel as referenceReadModel, triangulateModel as referenceTriangulate } from '../test/helpers/model-reference.mjs';
import { gameDirectory } from './game-directory.mjs';

let root;
try { root = gameDirectory(); } catch { console.log('SKIP validate-bsp-model: no installed game data'); process.exit(0); }
const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const wanted = option('maps', '').split(',').filter(Boolean);
const files = (await readdir(`${root}/Maps`)).filter(name => /\.(dx|unr)$/i.test(name) && (!wanted.length || wanted.includes(name.replace(/\.[^.]+$/, ''))));

const stats = { maps: 0, models: 0, errors: 0, nodes: 0, surfaces: 0, vertices: 0, points: 0, vectors: 0, zones: 0, lightMaps: 0, renderBounds: 0, leaves: 0, leafHulls: 0, lights: 0, triangles: 0, fields: 0 };
let failures = 0;
const fail = (label, detail) => { if (failures++ < 25) console.error(`FAIL ${label}: ${detail}`); };

/** Equal as raw values: the same type and structure, numbers by Object.is. */
function same(a, b, path, label) {
  stats.fields++;
  if (typeof a === 'number' || typeof b === 'number') {
    if (!Object.is(a, b)) { fail(label, `${path}: ${a} against ${b}`); return false; }
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    if (a !== b) { fail(label, `${path}: ${String(a)} against ${String(b)}`); return false; }
    return true;
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.length !== b.length) { fail(label, `${path}: lengths`); return false; }
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) { fail(label, `${path}[${i}]: ${a[i]} against ${b[i]}`); return false; }
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) { fail(label, `${path}: array against object`); return false; }
  const keys = Object.keys(a);
  if (keys.join() !== Object.keys(b).join()) { fail(label, `${path}: keys ${keys} against ${Object.keys(b)}`); return false; }
  for (const key of keys) if (!same(a[key], b[key], `${path}.${key}`, label)) return false;
  return true;
}

for (const name of files) {
  const bytes = await readFile(`${root}/Maps/${name}`), pkg = parsePackage(bytes);
  stats.maps++;
  for (let i = 0; i < pkg.exports.length; i++) {
    if (pkg.exports[i].className !== 'Model') continue;
    const label = `${name} ${pkg.exports[i].name}`;
    let reference = null, referenceError = null, typed = null, typedError = null;
    try { reference = referenceReadModel(pkg, bytes, i + 1); } catch (error) { referenceError = error; }
    try { typed = readModel(pkg, bytes, i + 1); } catch (error) { typedError = error; }
    stats.models++;
    if (referenceError || typedError) {
      stats.errors++;
      if (!referenceError || !typedError) fail(label, `only one reader threw: ${referenceError?.message} against ${typedError?.message}`);
      else if (referenceError.message !== typedError.message || referenceError.constructor !== typedError.constructor) fail(label, `${referenceError.message} against ${typedError.message}`);
      continue;
    }
    const objects = modelObjects(typed);
    // Every node zone is a byte, as the original's FBspNode holds it.
    for (const field of ['vectors', 'points', 'nodes', 'surfaces', 'vertices', 'zones', 'lightMaps', 'renderBounds', 'leaves', 'leafHulls', 'lights']) {
      stats[field] += reference[field].length;
      if (reference[field].length !== typed[field].length) { fail(label, `${field}: ${reference[field].length} against ${typed[field].length}`); continue; }
      same(reference[field], objects[field], field, label);
    }
    for (const field of ['entry', 'bounds', 'sphere', 'sharedSides', 'polygons', 'lightBits', 'rootOutside', 'linked', 'diagnostics'])
      same(reference[field], typed[field], field, label);
    for (const includeInvisible of [false, true]) {
      const expected = referenceTriangulate(reference, { includeInvisible }), actual = triangulateModel(typed, { includeInvisible });
      stats.triangles += expected.length;
      same(expected, actual, `triangles(${includeInvisible})`, label);
    }
  }
}
console.log(JSON.stringify(stats));
if (failures) { console.error(`${failures} differences`); process.exit(1); }
console.log('validate-bsp-model: the typed tables hold every value of the object reader');
