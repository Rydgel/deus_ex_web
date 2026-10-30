/** Family check of every native Actor-class constructor (docs/script-spawn.md
 * "Native constructor family").
 *
 * Enumerates each RF_Native class export in the native-code script packages
 * whose ancestry reaches Engine.Actor, joins it with its registration row
 * (script-native-class-registry.mjs), and runs its original InternalConstructor
 * through scripts/native-actor-constructor-oracle.py. The generated table
 * src/runtime/script-native-actor-constructors.mjs must equal the oracle's
 * result for every class: final vtable, the body its +0x2c IsPendingKill slot reaches,
 * and the member bytes the body writes besides the vtable.
 *
 *   node scripts/validate-native-actor-constructors.mjs [--write]
 *
 * --write regenerates the table from the oracle instead of comparing. */
import {execFileSync} from 'node:child_process';
import {readFile, readdir, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AssetStore} from '../src/unreal/assets.mjs';
import {findNativeClassConstructor} from '../src/runtime/script-native-class-registry.mjs';
import {gameDirectory} from './game-directory.mjs';
import { exportAt, importAt } from '../src/unreal/objects.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PACKAGES = Object.freeze({Engine: 'Engine.dll', DeusEx: 'DeusEx.dll', Extension: 'Extension.dll', ConSys: 'ConSys.dll'});
const RF_NATIVE = 0x04000000;

const gameRoot = gameDirectory(), files = [];
for (const name of await readdir(path.join(gameRoot, 'System')))
  files.push({path: `System/${name}`, read: () => readFile(path.join(gameRoot, 'System', name))});
const assets = new AssetStore(files);
const packages = new Map();
for (const name of ['Core', ...Object.keys(PACKAGES)]) packages.set(name, await assets.get(name));

// Resolve a class reference to {package, name}; imports name their package
// through the outer chain.
const reference = (pkgName, index) => {
  const asset = packages.get(pkgName);
  if (index > 0) return {pkg: pkgName, name: exportAt(asset.pkg, index).name};
  if (index < 0) {
    const entry = importAt(asset.pkg, index);
    let outer = entry;
    while (outer.packageIndex ?? outer.outer) {
      const next = outer.packageIndex ?? outer.outer;
      outer = next < 0 ? importAt(asset.pkg, next) : exportAt(asset.pkg, next);
    }
    return {pkg: outer.objectName ?? outer.name, name: entry.objectName ?? entry.name};
  }
  return null;
};
const exportOf = ({pkg, name}) => {
  const asset = packages.get(pkg);
  const index = asset?.exportsByPath.get(name.toLowerCase()) ?? asset?.exportsByPath.get(name);
  return index ? {asset, entry: exportAt(asset.pkg, index)} : null;
};
const lineage = start => {
  const chain = [];
  for (let node = start; node;) {
    chain.push(`${node.pkg}.${node.name}`);
    const found = exportOf(node);
    if (!found) break;
    node = reference(node.pkg, found.entry.superIndex);
  }
  return chain;
};

const requests = [];
for (const [pkg, dll] of Object.entries(PACKAGES)) {
  const asset = packages.get(pkg);
  for (const entry of asset.pkg.exports) {
    if (entry.className !== 'Class' || !(entry.flags & RF_NATIVE)) continue;
    const chain = lineage({pkg, name: entry.name});
    if (!chain.includes('Engine.Actor')) continue;
    const internalCtor = findNativeClassConstructor(pkg, entry.name);
    requests.push({key: `${pkg}.${entry.name}`.toLowerCase(), dll, internalCtor, lineage: chain});
  }
}
const {ENGINE_CLASSES, DEUSEX_CLASSES, EXTENSION_CLASSES, CONSYS_CLASSES} = await import('../src/runtime/script-native-class-registry.mjs');
const rows = {Engine: ENGINE_CLASSES, DeusEx: DEUSEX_CLASSES, Extension: EXTENSION_CLASSES, ConSys: CONSYS_CLASSES};
for (const request of requests) {
  const [pkg, name] = request.lineage[0].split('.');
  request.row = rows[pkg]?.[name] ?? null;
  // Rows whose pushed size tail was not decoded get a page-sized buffer, so a
  // write past the real instance still lands inside the probed object.
  request.instanceSize = request.row?.instanceSize ?? 0x1000;
}

const runnable = requests.filter(request => Number.isInteger(request.internalCtor));
const python = process.env.NATIVE_PROBE_PYTHON || path.resolve(root, '.cache/native-probe-env/bin/python');
const output = execFileSync(python, [path.join(root, 'scripts/native-actor-constructor-oracle.py'), gameRoot], {
  input: JSON.stringify(runnable.map(({key, dll, internalCtor, instanceSize}) => ({key, dll, internalCtor, instanceSize}))),
  maxBuffer: 1 << 28, encoding: 'utf8'});
const results = new Map(JSON.parse(output).map(result => [result.key, result]));

// Patterned memory alone takes PlayerPawnExt's already-present FlagBase
// branch. Verify the null branch separately, retaining the allocation as a
// semantic constructor obligation instead of embedding a probe heap pointer.
for (const key of ['deusex.deusexplayer', 'extension.playerpawnext']) {
  const result = results.get(key);
  if (result?.error) continue;
  const variant = result?.nullFlagBaseCase, allocation = variant?.allocations?.[0];
  const pointerBytes = allocation && Array.from({length: 4}, (_, i) => [0x890 + i, (allocation.address >>> (8 * i)) & 255]);
  if (!allocation || variant.allocations.length !== 1 || allocation.class !== 'Extension.FlagBase' ||
      allocation.size !== 0x12c || allocation.vtable !== 0x1205c20c || allocation.tail !== 0 ||
      variant.vtable !== result.vtable || JSON.stringify(variant.memberBytes) !== JSON.stringify(pointerBytes))
    throw new Error(`${key}: original null FlagBase constructor branch changed`);
  result.conditionalFlagBase = {offset: 0x890, className: allocation.class,
    instanceSize: allocation.size, vtable: allocation.vtable, defaultExpiration: allocation.tail};
}
const playerResult = results.get('deusex.deusexplayer');
if (!playerResult?.error && JSON.stringify(playerResult.logs) !== JSON.stringify([
  {text: '*** DEUS EX VERSION Mon Mar 19 12:06:14 2001 v1.112fm ***', event: 762},
])) throw new Error('Original first DeusExPlayer constructor version log changed');

const table = {};
for (const request of requests) {
  const result = results.get(request.key);
  table[request.key] = result && !result.error
    ? {dll: request.dll, internalCtor: request.internalCtor, vtable: result.vtable, pendingKillSlot: result.pendingKillSlot,
      pendingKillBody: result.pendingKillBody, memberBytes: result.memberBytes, sizeDecoded: Boolean(request.row?.instanceSize),
      ...(result.conditionalFlagBase ? {conditionalFlagBase: result.conditionalFlagBase} : {})}
    : {dll: request.dll, internalCtor: request.internalCtor ?? null, unresolved: result?.error ?? 'no registered InternalConstructor'};
}
await mkdir(path.join(root, '.cache'), {recursive: true});
await writeFile(path.join(root, '.cache/native-actor-constructors.json'),
  JSON.stringify(requests.map(request => ({...request, row: undefined, result: results.get(request.key)})), null, 1));

const hex = value => `0x${value.toString(16)}`;
const render = () => {
  const lines = Object.entries(table).sort(([a], [b]) => a.localeCompare(b)).map(([key, row]) => {
    if (row.unresolved) return `  '${key}': row({dll: '${row.dll}', internalCtor: ${row.internalCtor == null ? 'null' : hex(row.internalCtor)}, unresolved: ${JSON.stringify(row.unresolved.slice(0, 160))}}),`;
    const members = row.memberBytes.length ? `, memberBytes: freeze([${row.memberBytes.map(([o, v]) => `[${hex(o)}, ${hex(v)}]`).join(', ')}])` : '';
    const conditional = row.conditionalFlagBase ? `, conditionalFlagBase: freeze(${JSON.stringify(row.conditionalFlagBase)})` : '';
    return `  '${key}': row({dll: '${row.dll}', internalCtor: ${hex(row.internalCtor)}, vtable: ${hex(row.vtable)}, pendingKillBody: ${hex(row.pendingKillBody)}${members}${conditional}}),`;
  });
  return `/**
 * Every native Actor-class constructor, generated from the original DLLs by
 * scripts/validate-native-actor-constructors.mjs --write (do not edit by hand).
 *
 * UClass::Bind copies the nearest native ancestor's ClassConstructor down to a
 * script-only class, so this table is the construction contract of every
 * SpawnActor product. Each row is the registered InternalConstructor run once
 * on a patterned instance: \`vtable\` is the final +0 store, \`pendingKillBody\`
 * the body its +0x2c IsPendingKill entry reaches through jump thunks, and
 * \`memberBytes\` the bytes the body
 * writes besides the vtable ([offset, value]; absent when it writes none, which
 * leaves template members intact in the patterned case). \`conditionalFlagBase\`
 * records the original allocation required when the inherited FlagBase is null;
 * it is verified in a separate null-pointer case. The command line is empty.
 * \`unresolved\` rows name why the
 * body could not be run. Evidence: docs/script-spawn.md "Native constructor family".
 */
const freeze = value => Object.freeze(value);
const row = fields => freeze(fields);

export const NATIVE_ACTOR_CONSTRUCTORS = freeze({
${lines.join('\n')}
});
`;
};
const modulePath = path.join(root, 'src/runtime/script-native-actor-constructors.mjs');
if (process.argv.includes('--write')) {
  await writeFile(modulePath, render());
  console.log(`wrote ${path.relative(root, modulePath)}: ${Object.keys(table).length} classes`);
} else {
  const {NATIVE_ACTOR_CONSTRUCTORS: committed} = await import(modulePath);
  const mismatches = [];
  for (const [key, row] of Object.entries(table)) {
    const have = committed[key];
    if (!have) { mismatches.push(`${key}: missing from the committed table`); continue; }
    for (const field of ['internalCtor', 'vtable', 'pendingKillBody'])
      if ((have[field] ?? null) !== (row[field] ?? null)) mismatches.push(`${key}.${field}: committed ${have[field]} oracle ${row[field]}`);
    if (JSON.stringify(have.memberBytes ?? []) !== JSON.stringify(row.memberBytes ?? []))
      mismatches.push(`${key}.memberBytes differ`);
    if (JSON.stringify(have.conditionalFlagBase ?? null) !== JSON.stringify(row.conditionalFlagBase ?? null))
      mismatches.push(`${key}.conditionalFlagBase differs`);
    if (Boolean(have.unresolved) !== Boolean(row.unresolved)) mismatches.push(`${key}: resolution differs`);
  }
  for (const key of Object.keys(committed)) if (!table[key]) mismatches.push(`${key}: not a native Actor class in the packages`);
  if (mismatches.length) { console.error(mismatches.join('\n')); process.exit(1); }
  console.log(`native actor constructors: ${Object.keys(table).length} classes match the original DLLs`);
}
const summary = Object.values(table);
console.log(`  vtable-only: ${summary.filter(row => !row.unresolved && !row.memberBytes.length).length}` +
  `, member writes: ${summary.filter(row => !row.unresolved && row.memberBytes.length).length}` +
  `, unresolved: ${summary.filter(row => row.unresolved).length}`);
