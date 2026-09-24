/** Original exec argument/lvalue boundaries; workers have their own native comparisons. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {dispatchWindowHostNative} from '../src/runtime/script-window-host-natives.mjs';
const cases=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',['scripts/native-window-scroll-exec-oracle.py',gameDirectory()],{encoding:'utf8',maxBuffer:1<<20}));
for(const c of cases){
 const calls=[],position=[7,11],outputs=[101,202],win={};
 const worker=(_,...args)=>calls.push({op:'worker',args});
 const W={i32:(_,off)=>position[off===0x174?0:1],native:{setTickPosition:worker,moveThumb:worker,setClipPosition:worker}};
 const refs={first:{reference:true,set:v=>{outputs[0]=v;}},second:{reference:true,set:v=>{outputs[1]=v;}},row:{reference:true,set:v=>{position[1]=v;}},none:null};
 const result=dispatchWindowHostNative(W,{index:c.index,receiver:win,argumentCount:c.args.length,evaluateArgument:i=>{
  calls.push({op:'evaluate',index:i});if(c.mutate&&i===1)position.splice(0,2,31,47);
  return c.refs?refs[c.refs[i]]:c.args[i]??undefined;
 }});
 assert.equal(result.handled,true);assert.equal(result.value,undefined,'void native result');
 assert.deepEqual(calls,c.calls,'native '+c.index+' argument/call order');
 assert.deepEqual(position,c.position);assert.deepEqual(outputs,c.outputs);
 assert.equal(c.cursor,c.args.length+1,'original EndFunctionParms cursor');assert.equal(c.result,0xdeadbeef,'original void result preservation');
}
console.log(`window-scroll-exec: ${cases.length} original native wrapper comparisons pass`);
