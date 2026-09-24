/** Focused original instruction guards and embedded SetPause/state cases.
 * Authority and scope: docs/script-viewport-console.md. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {AssetStore} from '../src/unreal/assets.mjs';
import {ScriptRuntime} from '../src/runtime/script-runtime.mjs';
import {attachLocalViewportConsole} from '../src/runtime/script-viewport-console.mjs';
import {gameDirectory} from './game-directory.mjs';
const root=gameDirectory(),files=[];
for(const name of await readdir(`${root}/System`))files.push({path:`System/${name}`,read:()=>readFile(`${root}/System/${name}`)});
const assets=new AssetStore(files),runtime=new ScriptRuntime(assets,{nativeClassLoading:true});
const engine=await assets.get('Engine');
const attach=async(name)=>{const object={name};runtime.attach(object,await runtime.loadClass(engine,engine.exportsByPath.get(name.toLowerCase())));return object;};
const player=await attach('PlayerPawn'),level=await attach('LevelInfo'),game=await attach('GameInfo'),pri=await attach('PlayerReplicationInfo');
const set=(o,n,v)=>runtime.namedReference(o,n).set(v),get=(o,n)=>runtime.namedReference(o,n).get();
set(player,'Level',level);set(game,'Level',level);set(level,'Game',game);set(player,'PlayerReplicationInfo',pri);
set(pri,'PlayerName','Original pause reference');
const viewport={actor:player};
const consoleObject=await attachLocalViewportConsole({runtime,assets,engine,viewport,player});
assert.equal(get(player,'Player'),viewport);assert.equal(get(viewport,'Actor'),player);
assert.equal(get(viewport,'Console'),consoleObject);assert.equal(get(consoleObject,'Viewport'),viewport);
assert.equal(get(consoleObject,'TopLine'),63);assert.equal(get(consoleObject,'BorderSize'),1);
assert.equal(runtime.instance(consoleObject).state.stateNode,null);
await runtime.prepareState(engine,engine.exportsByPath.get('console.menuing'));
for(const path of ['Console.Menuing.BeginState','Console.Menuing.EndState','PlayerPawn.SetPause','GameInfo.SetPause'])
 await runtime.prepareFunction(engine,engine.exportsByPath.get(path.toLowerCase()));
runtime.gotoState(consoleObject,'Menuing');runtime.gotoState(consoleObject,'');
assert.equal(runtime.instance(consoleObject).state.stateNode,null);
for(const [netMode,pauseable,admin,pause,expected,result] of [
 [0,false,false,false,'',true], [0,false,false,true,'Original pause reference',true],
 [1,false,false,false,'sentinel',false], [1,true,false,false,'',true], [1,false,true,false,'',true],
]){
 set(level,'NetMode',netMode);set(game,'bPauseable',pauseable);set(player,'bAdmin',admin);set(level,'Pauser','sentinel');
 assert.equal(runtime.callFunction(runtime.lookup(player,'SetPause'),player,1,()=>pause),result);
 assert.equal(get(level,'Pauser'),expected);
}
// These guards bind the translated identity stores and initialization constants
// to original instructions. They are evidence guards, not a full ctor oracle.
const binary=await readFile(`${root}/System/Engine.dll`);
assert.equal(createHash('sha256').update(binary).digest('hex'),'0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4');
const pe=binary.readUInt32LE(60),opt=pe+24,base=binary.readUInt32LE(opt+28),sections=opt+binary.readUInt16LE(pe+20);
function at(va,size){for(let i=0;i<binary.readUInt16LE(pe+6);i++){
 const s=sections+40*i,rva=va-base,start=binary.readUInt32LE(s+12);
 if(rva>=start&&rva<start+binary.readUInt32LE(s+16)){
  const p=binary.readUInt32LE(s+20)+rva-start;return binary.subarray(p,p+size);
 }}throw Error('Unmapped evidence address');}
for(const [address,hex] of [[0x103723a1,'68681658106868cd5810'],[0x10389702,'894634'],
 [0x103796a8,'894e2c'],[0x103796ad,'c786100100003f000000'],[0x103796b7,'c7862007000001000000'],
 [0x10368ce7,'89bed4050000897730']])assert.equal(at(address,hex.length/2).toString('hex'),hex);
assert.equal(at(0x1047e6b4,50).toString('utf16le'),'ini:Engine.Engine.Console');
console.log('Viewport/Console: original native linkage guards, no-state/Menuing transitions and five embedded SetPause branch cases passed');
