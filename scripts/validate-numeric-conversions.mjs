import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {compileFunction} from '../src/runtime/script-vm.mjs';

const python=process.env.DEUS_EX_NATIVE_PYTHON??'.cache/native-probe-env/bin/python';
const cases=JSON.parse(execFileSync(python,['scripts/native-numeric-conversion-oracle.py',gameDirectory()],{encoding:'utf8'}));
function convert(value){
  const bytes=new Uint8Array(7);bytes.set([0x04,0x44,0x1e]);new DataView(bytes.buffer).setFloat32(3,value,true);
  return compileFunction({entry:{path:'fixture.FloatToInt'},pkg:{},bytes,size:bytes.length}).run({});
}
for(const c of cases){assert.equal(convert(c.input),c.output);assert.equal(c.codeAdvance,1);}
assert.throws(()=>convert(2**63),/nonfinite\/overflow/);
console.log(`Original Core FloatToInt passed ${cases.length} finite/truncation/int32-wrap cases.`);
