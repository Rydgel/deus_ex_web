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
// _ftol's integer indefinite for int64 overflow and (through native 172
// Divide_FloatFloat: 0/0, +-1/0) nonfinite operands — validate-x87-ftol-hardware.
for(const v of [2**63,-(2**64)])assert.equal(convert(v),0);
for(const [a,b] of [[0,0],[1,0],[-1,0]]){
  const bytes=new Uint8Array(14);bytes.set([0x04,0x44,0xac,0x1e]);const d=new DataView(bytes.buffer);
  d.setFloat32(4,a,true);bytes[8]=0x1e;d.setFloat32(9,b,true);bytes[13]=0x16;
  assert.equal(compileFunction({entry:{path:'fixture.FloatToInt'},pkg:{},bytes,size:bytes.length}).run({}),0);
}
console.log(`Original Core FloatToInt passed ${cases.length} finite/truncation/int32-wrap cases; nonfinite/overflow give 0.`);
