/** Scratch trace v3: full Secretary0 patrol after PatrolPoint startup fix.
 * Logs state/latent/phys/loc/MoveTarget/MoveTimer/destPoint + native calls. */
import {readdir, readFile} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';

const root = gameDirectory(), files = [];
for (const directory of ['Maps','System','Textures','Sounds','Music'])
  for (const name of await readdir(`${root}/${directory}`))
    files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets = new AssetStore(files), asset = await assets.get('00_Training');
const game = await createGame(decodeMap(asset.bytes), asset, assets, {randomSeed:1, presentation:true});
const {runtime, npcPawns, npcFailures} = game.doors.scriptRuntime;
const secretary = npcPawns.find(actor => actor.name === 'Secretary0');
const get = name => runtime.namedReference(secretary, name).get();
const fmt = v => Array.isArray(v) ? v.map(x => +(+x).toFixed(1)).join(',') : v;
const inst = runtime.instance(secretary);
const stateName = () => inst.state?.stateNode?.record?.name ?? '?';
let tick = -1, lastState = '', lastDest = null, lastMt = null, lastLatent = 0, lastPhys = -1;

// patrol-point link sanity after load
const lv = runtime.levelFor(secretary);
for (const n of ['PatrolPoint4','PatrolPoint5','PatrolPoint0','PatrolPoint1']) {
  const pp = lv.actors.find(a => a && a.name === n);
  console.log(`${n}: NextPatrolPoint=${runtime.namedReference(pp,'NextPatrolPoint').get()?.name ?? 'None'} lookDir=${fmt(runtime.namedReference(pp,'lookDir').get())}`);
}

const NATIVE = {500:'MoveTo',502:'MoveToward',508:'TurnTo',510:'TurnToward',517:'FindPathToward',527:'WaitForLanding',511:'TurnToward.poll',503:'MoveToward.poll'};
const invoke = runtime.invokeNative.bind(runtime);
runtime.invokeNative = call => {
  if (call.receiver === secretary && NATIVE[call.index])
    console.log(`  t=${tick} native ${call.index}(${NATIVE[call.index]}) state=${stateName()} loc=[${fmt(get('Location'))}]`);
  return invoke(call);
};

for (let i = 0; i < 2400 && !npcFailures.has(secretary); i++) {
  tick = i;
  game.tick(1/60, {});
  const st = stateName(), dest = get('destPoint'), mt = get('MoveTarget'), lat = inst.state.latent, phys = get('Physics');
  if (st !== lastState || dest !== lastDest || lat !== lastLatent) {
    console.log(`t=${tick} state=${st} latent=${lat} phys=${phys} dest=${dest?.name ?? 'null'} mt=${mt?.name ?? 'null'} loc=[${fmt(get('Location'))}] vel=[${fmt(get('Velocity'))}] mTimer=${(+get('MoveTimer')).toFixed(2)}`);
    lastState = st; lastDest = dest; lastLatent = lat;
  }
  if (mt !== lastMt) {
    console.log(`    t=${tick} MoveTarget ${lastMt?.name ?? 'null'} -> ${mt?.name ?? 'null'} loc=[${fmt(get('Location'))}]`);
    lastMt = mt;
  }
  if (phys !== lastPhys) { console.log(`    t=${tick} phys ${lastPhys} -> ${phys} loc=[${fmt(get('Location'))}] vel=[${fmt(get('Velocity'))}]`); lastPhys = phys; }
  if (i % 300 === 299) console.log(`  --- t=${tick} loc=[${fmt(get('Location'))}] state=${st} ---`);
}
console.log('final state:', stateName(), 'loc:', JSON.stringify(get('Location')), 'failures:', [...npcFailures.keys()].map(a=>a.name));
