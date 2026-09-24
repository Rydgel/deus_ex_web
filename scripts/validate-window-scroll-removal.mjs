/** Compare original normal-return body, including script mutations and aliases. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {managerChildRemoved} from '../src/runtime/script-window-scroll-children.mjs';
const python=process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python';
const cases=JSON.parse(execFileSync(python,['scripts/native-window-scroll-removal-oracle.py',gameDirectory()],{encoding:'utf8',maxBuffer:1<<22}));
for(const c of cases){
  const memory=new Map(Object.entries(c.before).map(([o,hex])=>[Number(o),Buffer.from(hex,'hex')])),calls=[];
  const W={ptr:(o,off)=>memory.get(o).readUInt32LE(off)||null,
    setPtr:(o,off,value)=>memory.get(o).writeUInt32LE(value??0,off)};
  managerChildRemoved(W,c.object,c.child||null,(object,event,args)=>{
    assert.equal(event,'ChildRemoved');
    calls.push({object,event:c.event,child:args[0]??0,third:0});
    for(const [off,value] of Object.entries(c.mutations))W.setPtr(object,Number(off),value);
    if(c.name==='script-rewrites-argument')args[0]=null;
  });
  assert.deepEqual(calls,c.calls,c.name+' script call');
  for(const [o,hex] of Object.entries(c.after))assert.equal(memory.get(Number(o)).toString('hex'),hex,c.name+' full image '+o);
}
console.log(`window-scroll-removal: ${cases.length} original ChildRemoved comparisons pass`);
