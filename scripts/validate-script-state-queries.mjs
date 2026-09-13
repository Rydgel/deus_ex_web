import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';
import {gameDirectory} from './game-directory.mjs';
import {AssetStore} from '../src/unreal/assets.mjs';
import {readFunctionMetadata} from '../src/unreal/script-metadata.mjs';
import {scriptIsInState,scriptGetStateName} from '../src/runtime/script-state-queries.mjs';

const root=gameDirectory(),python=process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python';
const cases=JSON.parse(execFileSync(python,['scripts/native-script-state-query-oracle.py',root],{encoding:'utf8'}));
const spelling=index=>index===0?'None':`Name${index}`;
for(const c of cases){
  let node=null;
  for(const index of c.names.toReversed())node={record:{name:spelling(index)},base:node};
  if(!c.hasFrame)node=null;
  assert.equal(scriptIsInState(node,spelling(c.testName)),Boolean(c.inside));
  assert.equal(scriptGetStateName(node),spelling(c.name));
  assert.equal(c.isInAdvance,2);assert.equal(c.getNameAdvance,1);
}
const files=(await readdir(root+'/System')).map(name=>({path:'System/'+name,read:()=>readFile(root+'/System/'+name)}));
const core=await new AssetStore(files).get('Core');
for(const [path,index] of [['object.isinstate',281],['object.getstatename',284]])
  assert.equal(readFunctionMetadata(core,core.exportsByPath.get(path)).nativeIndex,index);
console.log(`Original Core state query declarations and ${cases.length} native frame/node/ancestry cases passed.`);
