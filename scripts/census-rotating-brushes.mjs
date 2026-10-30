#!/usr/bin/env node
/** Census of rotating brushes (docs/rotating-brushes.md "Census"): which installed actors can be turned by AActor::physicsRotation while they carry a Brush.
 *
 * Inputs are original data only: every actor of the 83 single-player maps with its serialized properties over its class defaults (classes.mjs), and every
 * ScriptText buffer of the installed script packages (System/*.u). Reports
 *   - the movers (Engine.Mover descendants) and how many carry a RotationRate with a nonzero low word (the performPhysics tail's gate);
 *   - every brush-carrying actor in Physics 5 (PHYS_Rotating);
 *   - the Physics 5 / RotationRate actors without a brush, by class (the non-brush short path of MoveActor);
 *   - the script lines that write RotationRate, bFixedRotationDir or Physics = PHYS_Rotating, with the class they are in.
 *
 *   node scripts/census-rotating-brushes.mjs [--maps A,B] [--json out.json] */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AssetStore } from '../src/unreal/assets.mjs';
import { decodeMap } from '../src/unreal/map.mjs';
import { ClassDefaults } from '../src/unreal/classes.mjs';
import { gameDirectory } from './game-directory.mjs';
import { exportAt } from '../src/unreal/objects.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
let root;
try { root = gameDirectory(); } catch { console.log('SKIP census-rotating-brushes: no installed game data'); process.exit(0); }
const files = [];
for (const directory of ['Maps', 'System'])
  for (const name of await readdir(path.join(root, directory))) files.push({ path: `${directory}/${name}`, read: () => readFile(path.join(root, directory, name)) });
const assets = new AssetStore(files), defaults = new ClassDefaults(assets);
const selected = option('maps', null)?.split(',');
const maps = (await readdir(path.join(root, 'Maps'))).filter(n => n.toLowerCase().endsWith('.dx') && !/^dxmp_/i.test(n))
  .map(n => path.basename(n, '.dx')).filter(n => !selected || selected.includes(n)).sort();

const result = { movers: 0, moversWithRate: [], brushesInPhysics5: [], moverPhysics: {}, moverEncroach: {}, nonBrush: {}, scriptWriters: [] };
for (const map of maps) {
  const asset = await assets.get(map), decoded = decodeMap(asset.bytes);
  for (const actor of decoded.actors) {
    let values, lineage;
    try { values = await defaults.forActor(asset, actor); lineage = await defaults.lineage(asset, exportAt(asset.pkg, actor.index).classIndex); } catch { continue; }
    const rate = values.RotationRate ?? [0, 0, 0], spins = rate.some(v => (v & 0xffff) !== 0);
    const isMover = lineage.includes('engine.mover'), brush = Boolean(values.Brush) && lineage.includes('engine.brush') && !(lineage[0] === 'engine.brush');
    if (isMover) {
      result.movers++;
      result.moverPhysics[values.Physics ?? 0] = (result.moverPhysics[values.Physics ?? 0] ?? 0) + 1;
      if (spins) result.moversWithRate.push({ map, name: actor.name, class: lineage[0], physics: values.Physics, rate, fixed: Boolean(values.bFixedRotationDir),
        toDesired: Boolean(values.bRotateToDesired), collide: Boolean(values.bCollideActors), encroach: values.MoverEncroachType, location: values.Location, rotation: values.Rotation });
    }
    if ((isMover || brush) && values.Physics === 5) result.brushesInPhysics5.push({ map, name: actor.name, class: lineage[0] });
    if (!isMover && !brush && (values.Physics === 5 || spins) && values.Brush == null) {
      const key = `${lineage[0]} physics=${values.Physics ?? 0} rate=${rate.join(',')}`;
      result.nonBrush[key] = (result.nonBrush[key] ?? 0) + 1;
    }
  }
}

// ScriptText: a TextBuffer named ScriptText under each class; no tagged properties, Pos and Top (int32), then the FString (compact length, Latin-1).
const writer = /(RotationRate|bFixedRotationDir|PHYS_Rotating)/;
for (const name of files.filter(f => f.path.startsWith('System/') && f.path.toLowerCase().endsWith('.u')).map(f => path.basename(f.path, '.u'))) {
  const asset = await assets.get(name);
  for (const entry of asset.pkg.exports) {
    if (entry.className !== 'TextBuffer' || entry.name !== 'ScriptText' || !entry.serialSize) continue;
    const owner = entry.outer > 0 ? exportAt(asset.pkg, entry.outer)?.name : null;
    const bytes = asset.bytes.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize);
    let at = 0;
    const compact = () => { const b0 = bytes[at++]; let value = b0 & 0x3f; if (b0 & 0x40) for (let shift = 6, b; ; shift += 7) { b = bytes[at++]; value |= (b & 0x7f) << shift; if (!(b & 0x80)) break; } return b0 & 0x80 ? -value : value; };
    if (asset.pkg.names.at(compact())?.name !== 'None') continue;
    at += 8;
    const length = compact();
    if (length <= 0) continue;
    Buffer.from(bytes.subarray(at, at + length - 1)).toString('latin1').split(/\r?\n/).forEach((line, n) => {
      if (!/^\s*\/\//.test(line) && writer.test(line) && /(=|SetPhysics)/.test(line)) result.scriptWriters.push(`${name}.${owner}:${n + 1}: ${line.trim()}`);
    });
  }
}

console.log(`${maps.length} maps: ${result.movers} movers, Physics ${JSON.stringify(result.moverPhysics)}; ${result.moversWithRate.length} with a RotationRate:`);
for (const m of result.moversWithRate) console.log(`  ${m.map} ${m.name} ${m.class} physics=${m.physics} rate=${m.rate} fixed=${m.fixed} toDesired=${m.toDesired} collide=${m.collide} encroachType=${m.encroach}`);
console.log(`brush actors in PHYS_Rotating: ${result.brushesInPhysics5.length}`);
console.log('actors without a Brush that spin or are in PHYS_Rotating (class physics rate: count):');
for (const [key, count] of Object.entries(result.nonBrush).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${String(count).padStart(4)}  ${key}`);
const moverWriters = result.scriptWriters.filter(line => /Mover|Brush|Breakable/i.test(line.split(':')[0]));
console.log(`script lines writing RotationRate / bFixedRotationDir / PHYS_Rotating: ${result.scriptWriters.length}, in a Mover or Brush class: ${moverWriters.length}`);
const out = option('json', null);
if (out) await writeFile(out, JSON.stringify(result, null, 1));
