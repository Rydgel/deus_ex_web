import assert from 'node:assert/strict';
import test from 'node:test';
import {copyMeshLightColors} from '../src/viewer/mesh-light-colors.mjs';

// Adapter boundary only: original lighting and byte quantization are covered
// by validate-mesh-lighting-play.mjs. The existing scatter used face order
// [0,2,1] after converting Unreal's handedness to the viewer's coordinates.
const scatter=(source,faces)=>Uint32Array.from(faces.flatMap(face=>
  [0,1,2,6,7,8,3,4,5].map(corner=>source[face*9+corner])));
test('light colors preserve reflected corners, face order and changed tails',()=>{
  const source=Uint32Array.from({length:90},(_,i)=>i+0x3f000000),faces=[7,1,5,9];
  const target=new Uint32Array(faces.length*9);
  assert.equal(copyMeshLightColors(target,source,faces),true);
  assert.deepEqual(target,scatter(source,faces));
  assert.equal(copyMeshLightColors(target,source,faces),false);
  for(const changedFace of faces){
    for(let corner=0;corner<9;corner++)source[changedFace*9+corner]++;
    assert.equal(copyMeshLightColors(target,source,faces),true);
    assert.deepEqual(target,scatter(source,faces));
    assert.equal(copyMeshLightColors(target,source,faces),false);
  }
});
test('light color comparison uses exact words and respects sliced storage',()=>{
  const backing=new Uint32Array(36).fill(0xdeadbeef),target=backing.subarray(9,27);
  const source=new Uint32Array(27).fill(0),faces=[2,0];
  source[0]=0x80000000;source[20]=0x7fc00001;
  assert.equal(copyMeshLightColors(target,source,faces),true);
  assert.deepEqual(target,scatter(source,faces));
  assert.equal(copyMeshLightColors(target,source,faces),false);
  assert.ok(backing.subarray(0,9).every(word=>word===0xdeadbeef));
  assert.ok(backing.subarray(27).every(word=>word===0xdeadbeef));
  source[20]=0x7fc00002;
  assert.equal(copyMeshLightColors(target,source,faces),true);
  assert.deepEqual(target,scatter(source,faces));
  assert.equal(copyMeshLightColors(target,source,[]),false);
});
