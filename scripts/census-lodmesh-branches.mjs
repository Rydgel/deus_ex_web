/** Which actors and scripts can reach DrawLodMesh's particle branch (Actor
 * `+0x194` bit 2, bParticles, Render.dll `0x10b0f7a0..`) and its wire /
 * orthographic branch (the viewport actor's RendMap `+0x600` equal to 1 or
 * 13..15, `0x10b0ed5b..0x10b0ed83`, `0x10b0f45c..`)?  An evidence tool
 * (docs/script-lodmesh-lod.md "Branches not ported"); it reads the installed
 * game and prints counts, nothing is written.
 *
 *   node scripts/census-lodmesh-branches.mjs
 *
 * Sources of a bParticles actor: a class default (own tag or inherited), a
 * map actor's own tag, a script assignment (an InstanceVariable store, or a
 * Context store through another actor).  Sources of a RendMap in 1 / 13..15:
 * a script store, Canvas.DrawActor's bWireframe (native 467 sets RendMap = 1
 * for the call, Engine.dll `0x10377f6f`), a class default / map tag, and the
 * RMODE console command (UViewport::Exec `0x10374215`). */
import {readFile, readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ClassDefaults, readClass, skipBytecode} from '../src/unreal/classes.mjs';
import {decodeScript} from '../src/unreal/bytecode.mjs';
import {readObject, nameAt} from '../src/unreal/objects.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files);
const packages = [...assets.files.values()].filter(f => /\.u$/i.test(f.path)).map(f => f.name);
const maps = [...assets.files.values()].filter(f => /\.(dx|unr)$/i.test(f.path)).map(f => f.name);

// Native index -> name over the packages that declare natives.
const natives = new Map();
for (const name of ['Core', 'Engine', 'Extension', 'DeusEx']) {
  const asset = await assets.get(name);
  asset.pkg.exports.forEach((entry, i) => {
    if (entry.className !== 'Function') return;
    try {
      const object = readObject(asset.pkg, asset.bytes, i + 1), r = object.reader;
      for (let k = 0; k < 4; k++) r.compact();
      nameAt(asset.pkg, r.compact());
      r.u32(); r.u32();
      const size = r.u32();
      skipBytecode(asset.pkg, r, size);
      const iNative = r.u16();
      if (iNative) natives.set(iNative, entry.name);
    } catch { /* not a plain function */ }
  });
}
const drawActorNative = [...natives].find(([, name]) => name === 'DrawActor')?.[0];
console.log(`Canvas.DrawActor is native ${drawActorNative}; ${packages.length} script packages, ${maps.length} maps`);

// --- Scripts -------------------------------------------------------------
const watched = new Set(['bparticles', 'rendmap']);
const stores = [], drawCalls = [], rmodeStrings = [], consoleCommands = [];
let functions = 0;
const literalOf = node => node && node.op === 'literal' ? node.value : undefined;
function walk(node, ctx, parent = null) {
  if (!node || typeof node !== 'object') return;
  // A store: Let (0x0f) / LetBool (0x14) to a watched instance variable, or through a Context.
  if ((node.op === 0x0f || node.op === 0x14) && node.left) {
    let target = node.left;
    while (target && (target.op === 0x19 || target.op === 0x12)) target = target.value;
    if (target && (target.op === 0x00 || target.op === 0x01) && watched.has(String(target.name).toLowerCase()))
      stores.push({where: ctx, name: target.name, context: node.left.op === 0x19 || node.left.op === 0x12, value: literalOf(node.right) ?? '(expression)'});
  }
  if (node.op === 'native' && node.index === drawActorNative)
    drawCalls.push({where: ctx, wireframe: literalOf(node.args[1]) ?? `(expression op 0x${node.args[1]?.op?.toString?.(16)} ${node.args[1]?.name ?? ''})`});
  if (node.op === 'literal' && typeof node.value === 'string' && /rmode|bparticles|rendmap/i.test(node.value))
    rmodeStrings.push({where: ctx, text: node.value});
  if (node.op === 'native' && /^consolecommand$/i.test(natives.get(node.index) ?? ''))
    consoleCommands.push({where: ctx, argument: literalOf(node.args[0]) ?? '(expression)'});
  if (node.op === 0x1b || node.op === 0x38 || node.op === 0x1c) {
    if (/^consolecommand$/i.test(node.name ?? '')) consoleCommands.push({where: ctx, argument: literalOf(node.args[0]) ?? '(expression)'});
  }
  for (const key of ['left', 'right', 'value', 'context']) if (node[key] && typeof node[key] === 'object' && !Array.isArray(node[key])) walk(node[key], ctx, node);
  for (const key of ['args']) if (Array.isArray(node[key])) for (const child of node[key]) walk(child, ctx, node);
}
for (const name of packages) {
  const asset = await assets.get(name), {pkg, bytes} = asset;
  for (let i = 0; i < pkg.exports.length; i++) {
    const entry = pkg.exports.at(i);
    if ((entry.className !== 'Function' && entry.className !== 'State') || !entry.serialSize) continue;
    try {
      const object = readObject(pkg, bytes, i + 1), r = object.reader;
      for (let k = 0; k < 4; k++) r.compact();
      nameAt(pkg, r.compact());
      r.u32(); r.u32();
      const size = r.u32(), start = r.offset;
      skipBytecode(pkg, r, size);
      const decoded = decodeScript({pkg, bytes: r.bytes.slice(start, r.offset), size});
      functions++;
      for (const {node} of decoded.statements.values()) walk(node, `${name}.${entry.path}`);
    } catch (error) { if (!/Unsupported|expanded|not a/i.test(error.message)) console.log(`  skip ${name}.${entry.path}: ${error.message}`); }
  }
}
console.log(`\nScripts: ${functions} functions/states decoded`);
console.log(`stores to bParticles / RendMap: ${stores.length}`, stores);
console.log(`Canvas.DrawActor calls: ${drawCalls.length}`);
const wire = new Map();
for (const call of drawCalls) { const key = String(call.wireframe); wire.set(key, (wire.get(key) ?? 0) + 1); }
console.log('  bWireframe argument:', Object.fromEntries(wire));
for (const call of drawCalls) console.log(`  ${call.where}: bWireframe = ${call.wireframe}`);
console.log(`string literals naming rmode / bParticles / RendMap: ${rmodeStrings.length}`, rmodeStrings);
const consoleLiteral = consoleCommands.filter(c => typeof c.argument === 'string' && c.argument !== '(expression)');
console.log(`ConsoleCommand calls: ${consoleCommands.length} (${consoleLiteral.length} with a literal argument)`);
for (const c of consoleLiteral) console.log(`  ${c.where}: ${JSON.stringify(c.argument)}`);

// --- Class defaults ------------------------------------------------------
const defaults = new ClassDefaults(assets);
const classDefaults = [];
let classCount = 0;
for (const name of packages) {
  const asset = await assets.get(name);
  for (let i = 0; i < asset.pkg.exports.length; i++) {
    if (asset.pkg.exports.at(i).className !== 'Class' || !asset.pkg.exports.at(i).serialSize) continue;
    classCount++;
    let values;
    try { values = await defaults.get(asset, i + 1); } catch (error) { console.log(`  defaults ${name}.${asset.pkg.exports.at(i).path}: ${error.message}`); continue; }
    if (values.bParticles || (values.RendMap !== undefined && values.RendMap !== 5))
      classDefaults.push({class: `${name}.${asset.pkg.exports.at(i).path}`, bParticles: values.bParticles ?? false, RendMap: values.RendMap, DrawType: values.DrawType});
  }
}
console.log(`\nClass defaults: ${classCount} classes; with bParticles or RendMap != 5: ${classDefaults.length}`, classDefaults);

// --- Map actors ----------------------------------------------------------
let actorCount = 0, meshActors = 0;
const mapHits = [];
const drawTypes = new Map();
for (const name of maps) {
  const asset = await assets.get(name), {pkg, bytes} = asset;
  for (let i = 0; i < pkg.exports.length; i++) {
    const entry = pkg.exports.at(i);
    if (!entry.serialSize || ['Class', 'Function', 'State', 'Model', 'Polys', 'Texture', 'Sound', 'Music', 'TextBuffer', 'Level', 'Palette', 'Font', 'LodMesh', 'Mesh', 'Struct', 'Enum', 'Const', 'Package', 'Script', 'ScriptedTexture', 'FireTexture', 'WaterTexture', 'WaveTexture', 'FractalTexture', 'IceTexture', 'WetTexture', 'Skin'].includes(entry.className)) continue;
    let props;
    try { props = readObject(pkg, bytes, i + 1).properties; } catch { continue; }
    if (!props.some(p => p.name === 'Location')) continue;
    actorCount++;
    const named = n => props.find(p => p.name === n);
    if (named('Mesh')) meshActors++;
    const particles = named('bParticles'), rend = named('RendMap');
    if (particles?.value || rend) mapHits.push({map: name, actor: entry.path, class: entry.className, bParticles: particles?.value, RendMap: rend?.value});
  }
}
const histogram = new Map();
for (const hit of mapHits) { const key = `${hit.class} bParticles=${hit.bParticles ?? '-'} RendMap=${hit.RendMap ?? '-'}`; histogram.set(key, (histogram.get(key) ?? 0) + 1); }
console.log(`\nMap actors: ${actorCount} with a Location over ${maps.length} maps; with a bParticles=True or RendMap tag: ${mapHits.length}`);
for (const [key, count] of [...histogram].sort()) console.log(`  ${count} x ${key}`);
