import test from 'node:test';
import assert from 'node:assert/strict';
import {fastLineCheck} from '../src/runtime/fast-line-check.mjs';

test('FastLineCheck matches the focused original DLL plane/flag reference',()=>{
  const node={plane:[1,0,0,0],back:-1,front:-1,flags:0,vertexCount:0};
  const model={nodes:[node],rootOutside:1};
  for(const [first,second,flags,clear] of [
    [1,2,0,true],[-1,-2,0,false],[1,-1,0,false],[-1,1,0,false],
    [.0001,-.0001,0,false],[1,-1,0x20,false],[1,-1,1,true],[0,0,0,true],
  ]){
    node.flags=flags;
    assert.equal(fastLineCheck(model,[first,0,0],[second,0,0]),clear);
  }
  assert.equal(fastLineCheck({nodes:[],rootOutside:0},[0,0,0],[1,0,0]),false);
  // Original two-node slab: both endpoints outside, but the segment crosses solid.
  const slab={rootOutside:1,nodes:[
    {plane:[1,0,0,1],back:1,front:-1,flags:0},
    {plane:[-1,0,0,1],back:-1,front:-1,flags:0},
  ]};
  assert.equal(fastLineCheck(slab,[-2,0,0],[2,0,0]),false);
  assert.equal(fastLineCheck(slab,[2,0,0],[-2,0,0]),false);
  assert.equal(fastLineCheck(slab,[2,0,0],[3,0,0]),true);
});
