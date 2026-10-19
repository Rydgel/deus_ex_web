/** Census of the skipped arguments in the shipped script bytecode (docs/skipped-optional-arguments.md): every call whose
 * argument list holds an EX_Nothing (0x0b), grouped by target, with the hole positions over the argument count. A native's
 * exec thunk pre-stores each optional slot before stepping its token, so an EX_Nothing keeps that slot's default; Play's
 * native bodies receive `undefined` for it and must give the same default. The UnrealScript compiler omits trailing optional
 * arguments rather than emitting EX_Nothing for them (the `trailing` column is 0 throughout), so only holes before a given
 * argument reach a native.
 *
 *   node scripts/census-skipped-arguments.mjs [--json out.json]
 */
import {readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata, readStateMetadata} from '../src/unreal/script-metadata.mjs';
import {decodeScript} from '../src/unreal/bytecode.mjs';
import {gameDirectory} from './game-directory.mjs';

const packageNames = ['Core', 'Engine', 'Extension', 'ConSys', 'DeusEx', 'UWindow', 'Fire', 'IpDrv', 'UBrowser'];
const root = gameDirectory(), files = [];
for (const name of await readdir(path.join(root, 'System'))) files.push({path: name, read: () => readFile(path.join(root, 'System', name))});
const assets = new AssetStore(files);
// lower-case function key -> native index (0 for a native without one); short name -> keys
const natives = new Map(), nativeNames = new Map();
const sites = [];
for (const name of packageNames) {
  const asset = await assets.get(name);
  for (const [i, entry] of asset.pkg.exports.entries()) {
    if (!['Function', 'State'].includes(entry.className)) continue;
    const key = `${name}.${entry.path}`;
    const script = (entry.className === 'Function' ? readFunctionMetadata : readStateMetadata)(asset, i + 1, {includeChildren: false});
    if (script.functionFlags & 0x400) {
      natives.set(key.toLowerCase(), script.nativeIndex);
      const short = key.split('.').pop().toLowerCase();
      nativeNames.set(short, [...(nativeNames.get(short) ?? []), key]);
    }
    for (const node of decodeScript(script).expressions.values()) {
      if (!Array.isArray(node.args)) continue;
      const holes = node.args.flatMap((a, j) => a.op === 0x0b ? [j] : []);
      if (!holes.length) continue;
      let target;
      if (node.op === 'native') target = `native(${node.index})`;
      else if (node.op === 0x11) target = 'EX_New';
      else if (node.op === 0x1c) target = (await assets.resolve(asset, node.functionIndex)).key;
      else target = `${node.op === 0x1b ? 'virtual' : 'global'} ${node.name}`;
      sites.push({in: key, target, argc: node.args.length, holes, trailing: holes.includes(node.args.length - 1)});
    }
  }
}
const groups = new Map();
for (const s of sites) {
  const g = groups.get(s.target) ?? {count: 0, trailing: 0, patterns: new Map(), callers: new Set()};
  g.count++;
  if (s.trailing) g.trailing++;
  const pattern = `${s.holes.join(',')}/${s.argc}`;
  g.patterns.set(pattern, (g.patterns.get(pattern) ?? 0) + 1);
  g.callers.add(s.in.split('.')[0]);
  groups.set(s.target, g);
}
const kindOf = target => {
  if (target.startsWith('native(') || target === 'EX_New') return 'native';
  const key = target.toLowerCase();
  if (natives.has(key)) return `native(${natives.get(key)})`;
  const short = key.split(' ').pop();
  return target.includes(' ') && nativeNames.has(short) ? `native? ${nativeNames.get(short).join('/')}` : 'script';
};
console.log('target'.padEnd(44), 'kind'.padEnd(12), 'sites trailing  holes/argc x count  [packages]');
for (const [target, g] of [...groups].sort((a, b) => b[1].count - a[1].count))
  console.log(target.padEnd(44), kindOf(target).padEnd(12), String(g.count).padStart(5), String(g.trailing).padStart(8), ' ',
    [...g.patterns].map(([p, c]) => `${p}x${c}`).join(' '), ` [${[...g.callers].join(' ')}]`);
const out = process.argv.indexOf('--json');
if (out > 0) await writeFile(process.argv[out + 1], JSON.stringify(sites, null, 1));
