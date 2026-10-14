#!/usr/bin/env node
/** Light-map diagnostics over every single-player map (docs/light-effects.md "Coverage"): builds the static light map of every level
 * surface of each map through Play's own lighting (src/unreal/lighting.mjs createLighting, the Rust core's spatial.rs and light-merge kernel)
 * and lists the notes it raised. A note is Play's statement that a light was left out or taken steady ("Light effect X is not
 * translated", "A spatially dynamic light in the static cache ... is not modelled", a texture-palette LightType, a class 2 light in a
 * static list), so a map with none of the effect notes draws every light of its surfaces through a translated body.
 *
 *   node scripts/census-light-notes.mjs [--maps a,b] [--text]
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { createLighting } from '../src/unreal/lighting.mjs';
import { loadScriptVmKernel } from '../src/runtime/script-vm-kernel.mjs';
import { POLY } from '../src/unreal/geometry.mjs';
import { gameDirectory } from './game-directory.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const root = gameDirectory(), files = [];
for (const directory of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(path.join(root, directory))) files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files);
const selected = option('maps', null)?.split(',');
const maps = (await readdir(path.join(root, 'Maps'))).filter(n => n.toLowerCase().endsWith('.dx') && !/^dxmp_/i.test(n))
  .map(n => path.basename(n, '.dx')).filter(n => !selected || selected.includes(n)).sort();
const kernel = await loadScriptVmKernel(), report = {}, byNote = new Map();
for (const mapName of maps) {
  const asset = await assets.get(mapName), map = decodeMap(asset.bytes), model = map.model;
  const lighting = await createLighting(map, asset, assets, { kernel });
  await lighting.prepare(model);
  const seen = new Set();
  let built = 0, refused = 0, animated = 0;
  for (const t of map.triangles) {
    const zone = model.nodes[t.node].zones[1], key = `${t.surface}:${zone}`, surface = model.surfaces[t.surface];
    if (seen.has(key) || surface.flags & (POLY.Invisible | POLY.FakeBackdrop | POLY.Unlit)) continue;
    seen.add(key);
    try { const record = lighting.surface(model, t.surface, zone); built++; if (record?.animated?.length) animated++; } catch { refused++; }
  }
  const notes = [...lighting.notes].sort();
  report[mapName] = { surfaces: built, refused, animatedSurfaces: animated, lightActors: lighting.stats.lightActors, notes };
  for (const note of notes) { const e = byNote.get(note) ?? []; e.push(mapName); byNote.set(note, e); }
  lighting.dispose();
}
if (argv.includes('--text')) {
  let surfaces = 0, animatedSurfaces = 0;
  for (const [name, r] of Object.entries(report)) { surfaces += r.surfaces; animatedSurfaces += r.animatedSurfaces; console.log(`${name.padEnd(34)} ${String(r.surfaces).padStart(6)} surfaces, ${String(r.animatedSurfaces).padStart(4)} animated, ${r.refused} refused${r.notes.length ? `, notes ${r.notes.length}` : ''}`); }
  console.log(`\n${maps.length} maps, ${surfaces} level surfaces, ${animatedSurfaces} with an animated light`);
  console.log(byNote.size ? '\nNotes:' : '\nNo notes.');
  for (const [note, where] of byNote) console.log(`  ${note}\n    ${where.length} maps: ${where.slice(0, 8).join(', ')}${where.length > 8 ? ', ...' : ''}`);
} else console.log(JSON.stringify({ maps: maps.length, notes: Object.fromEntries(byNote), report }, null, 1));
