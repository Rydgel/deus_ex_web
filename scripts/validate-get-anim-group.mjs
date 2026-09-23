/** Original native293 execution and its unchanged UMesh sequence lookup. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {gameDirectory} from './game-directory.mjs';
import {execGetAnimGroup} from '../src/runtime/script-get-anim-group.mjs';

const rows = [{name:'Still',group:'Waiting'}, {name:'Down',group:'Select'}, {name:'Attack',group:'AttackGroup'}];
const samples = [
  {name:'no-mesh',noMesh:true,sequence:'Down'}, {name:'empty',sequence:'Down',sequences:[]},
  ...['Still','Down','Attack','dOwN','Missing'].map(sequence=>({name:sequence,sequence,sequences:rows})),
  {name:'none-group',sequence:'Still',sequences:[{name:'Still',group:'None'}]},
  {name:'duplicate',sequence:'Down',sequences:[{name:'Down',group:'First'},{name:'down',group:'Second'}]},
  {name:'none-sequence',sequence:'None',sequences:[{name:'None',group:'Allowed'}]},
];
const input = {gameRoot:gameDirectory(),samples};
const originalText = execFileSync(process.env.NATIVE_PROBE_PYTHON || path.resolve('.cache/native-probe-env/bin/python'),
  [path.resolve('scripts/native-get-anim-group-oracle.py')],
  {input:JSON.stringify(input),encoding:'utf8',timeout:30000,maxBuffer:2**20});
const directory=path.resolve('.cache/get-anim-group');mkdirSync(directory,{recursive:true});
writeFileSync(path.join(directory,'original-input.json'),JSON.stringify(input));
writeFileSync(path.join(directory,'original.json'),originalText);
const original=JSON.parse(originalText);
assert.equal(original.hashes['Engine.dll'],'0c3a8b18239ca98ae132506a1bd966cb5d91c6852e650e179cb15860832c20b4');
for(const [index,sample] of samples.entries()){
  const events=[],warnings=[];
  const value=execGetAnimGroup({argumentCount:1,evaluateArgument:i=>{assert.equal(i,0);events.push('argument');return sample.sequence;}},
    {mesh:()=>{events.push('mesh');return sample.noMesh?null:{entry:{name:'FixtureMesh'},sequences:sample.sequences};},
      log:(kind,details)=>warnings.push({kind,...details})});
  assert.equal(value,original.cases[index].group,sample.name);
  assert.deepEqual(events,['argument','mesh'],sample.name);
  const nativeWarnings=original.cases[index].events.filter(e=>e.op==='Warning');
  assert.equal(warnings.length,nativeWarnings.length,sample.name);
  for(const [i,warning]of nativeWarnings.entries()){
    const message=warning.format.replace('%s',sample.sequence).replace('%s','FixtureMesh');
    assert.equal(warnings[i].message,message,sample.name);
  }
  assert.equal(original.cases[index].actorUnchanged,true,sample.name);
  assert.equal(original.cases[index].codeAdvance,2,sample.name);
}
console.log(`GetAnimGroup: ${samples.length} unchanged original native/mesh lookup cases passed (FName groups, warnings, argument order, no actor mutation)`);
