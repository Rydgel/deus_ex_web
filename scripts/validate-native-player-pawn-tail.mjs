import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {x87add,x87double,x87load,x87mul,x87store} from '../src/runtime/script-vm.mjs';

const directory='reports/movement/player-pawn-tail';
await mkdir(directory,{recursive:true});
const scene=await readFile('reports/movement/player-sequence/00_Training/scene.json');
const cases={avgPhysicsTime:[
  {name:'zero-old',old:0,dt:.1,timer:0},
  {name:'unit-old',old:1,dt:.1,timer:1},
  {name:'large-old',old:123.456,dt:1/120,timer:1},
  {name:'small-old',old:.001,dt:.05,timer:0},
],pendingTouch:{initial:'Plant2',next:'Plant3',dt:.05}};
const caseBytes=Buffer.from(JSON.stringify(cases));
await writeFile(`${directory}/scene.json`,scene);await writeFile(`${directory}/cases.json`,caseBytes);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
if(!process.argv.includes('--reuse')){
 const result=spawnSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
  ['scripts/native-player-pawn-tail-oracle.py',gameDirectory(),`${directory}/scene.json`,`${directory}/cases.json`],
  {encoding:'utf8',maxBuffer:8*1024*1024,timeout:120000});
 if(result.status!==0)throw Error(result.stderr||`native oracle exited ${result.status}`);
 await writeFile(`${directory}/original.json`,result.stdout);
}
const original=JSON.parse(await readFile(`${directory}/original.json`,'utf8'));
assert.equal(original.sceneSha256,hash(scene));assert.equal(original.casesSha256,hash(caseBytes));
assert.equal(original.avgPhysicsTime.length,cases.avgPhysicsTime.length);
const f=Math.fround;
for(const [i,input] of cases.avgPhysicsTime.entries()){
 const expected=x87store(x87add(x87mul(x87load(input.old),x87double(.8)),x87mul(x87load(f(input.dt)),x87double(.2))));
 assert.equal(original.avgPhysicsTime[i].avgPhysicsTime,expected,input.name);
 assert.equal(original.avgPhysicsTime[i].moveTimer,f(input.timer-f(input.dt)),`${input.name} MoveTimer`);
}
assert.equal(original.pendingTouch.head,cases.pendingTouch.next);
assert.equal(original.pendingTouch.initialNext,0);
assert.equal(original.pendingTouch.eventStubOnly,true);
assert.ok(original.pendingTouch.eventBoundaries.some(event=>event.actor===cases.pendingTouch.initial));
console.log({avgPhysicsTimeCases:original.avgPhysicsTime.length,pendingTouch:original.pendingTouch,verified:'original DLL tail and x87 helper; ProcessEvent script body remains a stub'});
