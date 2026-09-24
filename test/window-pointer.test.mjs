import test from 'node:test';
import assert from 'node:assert/strict';
import {pointerButtonKey,windowPointerSample} from '../src/viewer/window-pointer.mjs';

test('pointer buttons map to original EInputKey values',()=>{
  assert.deepEqual([0,1,2,3].map(pointerButtonKey),[1,4,2,-1]);
});

test('CSS pointer coordinates map to WebGL drawing-buffer pixels',()=>{
  const rect={left:100,top:50,width:640,height:360};
  assert.deepEqual(windowPointerSample({clientX:420,clientY:230},rect,1280,720),
    {relative:false,x:640,y:360});
  assert.deepEqual(windowPointerSample({movementX:-3,movementY:4},rect,1280,720,true),
    {relative:true,dx:-6,dy:8});
});
