import test from 'node:test';
import assert from 'node:assert/strict';
import {findSpot} from '../src/runtime/fitting.mjs';

test('original AdjustSpot retains Z beyond a binary64 midpoint',()=>{
  const starts=[];
  const queries={pointCheck:()=>1,lineCheck(start){starts.push(start);return starts.length===1?{time:0,normal:[0,0,-1]}:{time:1,normal:[0,0,0]};}};
  const position=findSpot(queries,[0,0,-111.1500015258789],[20,20,43],0,0);
  assert.deepEqual(position,[0,0,-132.15000915527344]);
  assert.equal(starts.length,6);
  for(const start of starts.slice(1))assert.equal(start[2],-132.15000915527344);
});
