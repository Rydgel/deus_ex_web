/** Real Play integration for the recovered alliance natives; 709 stays explicit. */
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';

const root=gameDirectory(),files=[];
for(const directory of ['Maps','System','Textures','Sounds','Music'])
  for(const name of await readdir(`${root}/${directory}`))
    files.push({path:`${directory}/${name}`,read:()=>readFile(`${root}/${directory}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1,presentation:true});
const {runtime,npcPawns,npcFailures}=game.doors.scriptRuntime;
const mib=npcPawns.find(actor=>actor.name==='mib1');
assert.ok(mib);
const get=name=>runtime.namedReference(mib,name).get();
const invoke=runtime.invokeNative.bind(runtime);
let enemyChecks=0;
runtime.invokeNative=call=>{
  const result=invoke(call);
  if(call.receiver===mib&&call.index===2105)enemyChecks++;
  return result;
};
for(let run=0;run<2;run++) {
  if(run)game.reset();
  enemyChecks=0;
  assert.equal(npcFailures.has(mib),false);
  game.tick(1/60,{});
  assert.equal(get('AnimSequence').toLowerCase(),'breathelight');
  const firstFrame=get('AnimFrame');
  assert.ok(firstFrame<0,'original startup selected a tween');
  let ticks=1;
  while(!npcFailures.has(mib)&&ticks<20) {game.tick(1/60,{});ticks++;}
  assert.ok(enemyChecks>0,'real script dispatch completed the recovered enemy native');
  assert.equal(get('Physics'),1,'MIB landed before the remaining wandering boundary');
  assert.ok(get('AnimFrame')>firstFrame,'animation progressed after the earlier failure');
  assert.ok(get('AnimFrame')<0,'remaining boundary still interrupts the startup tween');
  assert.match(npcFailures.get(mib),/native 709 in scriptedpawn\.wandering\.pickdestination/);
  console.log(`PASS MIB ${run?'reset':'load'}: ${enemyChecks} enemy checks; tick ${ticks} reaches the explicit AIPickRandomDestination709 boundary. Pose remains unresolved.`);
}
