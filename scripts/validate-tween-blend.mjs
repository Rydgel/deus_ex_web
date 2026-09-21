import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {gameDirectory} from './game-directory.mjs';
import {execTweenBlendAnim} from '../src/runtime/play-anim.mjs';
const samples=[['MouthClosed',.1],['MouthClosed',.125,3],['MouthClosed',0,1],['MouthClosed',-.2,2],['MouthClosed',.17,0]].map((args,i)=>({
 name:`blend-${i}`,native:'TweenBlendAnim',args,sequences:[{name:'MouthClosed',numFrames:3,rate:30}]}));
const native=JSON.parse(execFileSync(process.env.NATIVE_PROBE_PYTHON??'.cache/native-probe-env/bin/python',
 ['scripts/native-tween-blend-oracle.py'],{input:JSON.stringify({gameRoot:gameDirectory(),samples}),encoding:'utf8'}));
for(let i=0;i<samples.length;i++){
 const blends=Array.from({length:4},()=>({AnimSequence:'None',AnimFrame:0,AnimRate:0,TweenRate:0,AnimLast:0,AnimMinRate:0,OldAnimRate:0,
  simAnim:{frame:0,rate:0,tween:0,last:0}}));
 execTweenBlendAnim({blends},{sequences:samples[i].sequences},...samples[i].args);
 assert.deepEqual(blends.map(({AnimSequence,...rest})=>({sequence:AnimSequence,...rest})),native[i]);
}
console.log('5 original TweenBlendAnim cases passed, all four slots and SimBlend stores checked.');
