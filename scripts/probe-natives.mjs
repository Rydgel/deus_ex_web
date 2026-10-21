/** Send every native the packages declare through the live invokeNative chain of a headless game and record what answers
 * (docs/native-census.md "The probe"). It is the independent check of the registry: the registry says which dispatchers route
 * a native by reading their code, the probe says which ones do by calling them.
 *
 * A call with no arguments and no receiver reaches the first line of whatever body routes the native, which refuses it with
 * its own message (an argument count, a missing receiver, a missing service). A native no dispatcher routes ends at the
 * chain's last branch, "Unsupported original door native N" (script-doors.mjs nativeCall), or at one of the other refusals
 * of an unrouted native ("Unimplemented original native", "VM does not support native", "Original iterator native is not
 * implemented"). The first kind is `routed`, the second `unsupported`. Primitive operators never reach invokeNative; they
 * are `primitive`. The probe changes nothing it can observe: a refused call has done no work, and the game is discarded.
 *
 *   node scripts/probe-natives.mjs [--map 00_Training] [--out .work/native-probe.json] */
import {readFile, readdir, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {primitiveNativeIndices} from '../src/runtime/script-vm.mjs';
import {gameDirectory} from './game-directory.mjs';
import {openSystemPackages, scriptPackageNames, scanNativeCalls} from './native-reachability.mjs';

const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const map = option('map', '00_Training'), out = option('out', '.work/native-probe.json');

const root = gameDirectory(), files = [];
for (const dir of ['Maps', 'System', 'Textures', 'Sounds', 'Music'])
  for (const name of await readdir(`${root}/${dir}`)) files.push({path: `${dir}/${name}`, read: () => readFile(`${root}/${dir}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get(map);
const scan = await scanNativeCalls(await openSystemPackages(root), await scriptPackageNames(root));

const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed: 1, presentation: true});
const runtime = game.doors.scriptRuntime.runtime;
const primitive = new Set(primitiveNativeIndices);

class ProbeStop extends Error {}
const UNROUTED = /Unsupported original door native|Unimplemented original native|VM does not support native|Original iterator native is not implemented|Unsupported original latent action/;
const outcomes = {};
let done = 0;
for (const decl of scan.declarations) {
  const key = decl.key.toLowerCase(), slot = decl.index ? String(decl.index) : key;
  if (decl.index && primitive.has(decl.index)) { outcomes[slot] = {kind: 'primitive'}; continue; }
  const call = {index: decl.index, record: {key, entry: {path: decl.path}}, receiver: null, argumentCount: 0,
    evaluateArgument: () => { throw new ProbeStop('probe: an argument was evaluated'); }, resultDiscarded: false};
  let outcome;
  try {
    if (decl.iterator && decl.index) runtime.createIterator(call); else runtime.invokeNative(call);
    outcome = {kind: 'routed', result: 'returned'};
  } catch (error) {
    const message = String(error?.message ?? error).split('\n')[0].slice(0, 200);
    outcome = UNROUTED.test(message) ? {kind: 'unsupported', message} : {kind: 'routed', result: error instanceof ProbeStop ? 'evaluated an argument' : message};
  }
  // Two declarations can share an index (2054): the index is routed if either call is.
  if (!outcomes[slot] || outcomes[slot].kind === 'unsupported') outcomes[slot] = outcome;
  if (++done % 100 === 0) console.error('probed', done, decl.key);
}
await mkdir(path.dirname(path.resolve(out)), {recursive: true});
await writeFile(out, JSON.stringify({map, declared: scan.declarations.length, outcomes}, null, 1) + '\n');
const kinds = {};
for (const outcome of Object.values(outcomes)) kinds[outcome.kind] = (kinds[outcome.kind] ?? 0) + 1;
console.log(JSON.stringify(kinds), 'written', out);
process.exit(0);
