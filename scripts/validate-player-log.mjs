/** Original native allocation/constructor plus original AddLog list bytecode. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {AssetStore} from '../src/unreal/assets.mjs';
import {decodeMap} from '../src/unreal/map.mjs';
import {createGame} from '../src/viewer/game.mjs';
import {gameDirectory} from './game-directory.mjs';
import {constructPlayerLog,preparePlayerLogStore} from '../src/runtime/script-player-log.mjs';
const root=gameDirectory();
const original=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON||path.resolve('.cache/native-probe-env/bin/python'),
  [path.resolve('scripts/native-player-log-oracle.py'),root],{encoding:'utf8'}));
assert.equal(original.hash,'b91002f3e7658c0562d28bccc887cf9db79a47a19f5e09e8be460c9d0c0bee04');
const writes=[],nativeObject={text:'template',next:null};
Object.defineProperty(nativeObject,'nativeVtable',{set:value=>writes.push(value)});
constructPlayerLog(nativeObject,{destroyObjectBase:()=>{}});
assert.deepEqual(writes,original.cases[0].stores);
for(const [i,c] of original.cases.entries()){
  assert.equal(c.null,!!i);assert.equal(c.code,0x22110001);
  assert.deepEqual(c.members,[0x55555555,0x55555555,0x55555555,0x55555555]);
  assert.deepEqual(c.events,[['fname',0],['outer'],['allocate',0,0,null]]);
}
assert.deepEqual(original.cases[1].stores,[]);
const files=[];
for(const dir of ['Maps','System','Textures','Sounds','Music'])for(const name of await readdir(`${root}/${dir}`))
  files.push({path:`${dir}/${name}`,read:()=>readFile(`${root}/${dir}/${name}`)});
const assets=new AssetStore(files),asset=await assets.get('00_Training');
const game=await createGame(decodeMap(asset.bytes),asset,assets,{randomSeed:1});
const runtime=game.doors.scriptRuntime.runtime,player=game.player.collisionActor;
const store=await preparePlayerLogStore({runtime,assets,player});
const get=(o,k)=>runtime.namedReference(o,k).get();
const append=text=>runtime.callFunction(runtime.lookup(player,'AddLog'),player,1,()=>text);
const a=append('Crowbar acquired.'),b=append('Original log — café');
assert.equal(get(player,'FirstLog'),a);assert.equal(get(player,'LastLog'),b);
assert.equal(get(a,'next'),b);assert.equal(get(b,'next'),null);
assert.equal(get(a,'text'),'Crowbar acquired.');assert.equal(get(b,'text'),'Original log — café');
for(const object of [a,b]){
  const native=runtime.instance(object).nativeObject;
  assert.equal(native.nativeVtable,0x10027ad0);
  assert.equal(native.outer,runtime.playerNativeObject(player).outer);
  assert.notEqual(native.outer,runtime.playerNativeObject(player));
  assert.equal(runtime.instance(object).cls.record.key,'deusex.deusexlog');
}
// The retired player's FirstLog/LastLog are nulled by ADeusExPlayer::Destroy,
// not by a host reset; the reload's collection then releases the detached
// logs (test/script-player-destroy.test.mjs, scripts/validate-loadmap-gc.mjs).
console.log('Player log passed: two original native branches, vtable/member writes, original AddLog linked list and package Outer');
