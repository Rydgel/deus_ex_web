import test from 'node:test';
import assert from 'node:assert/strict';
import {createScriptNames,hashScriptNameBucket} from '../src/runtime/script-names.mjs';

test('FName DeleteEntry unlinks, frees before nulling, and reuses the LIFO hole',()=>{
  const names=[{index:0,flags:0,hashNext:null,text:'None'}];
  const freeIndices=[];
  const buckets=Array(0x1000).fill(null);
  const events=[];
  const allocator={
    free:(entry,index,bucket)=>events.push({kind:'free',entry,index,bucket,slot:names[index],next:entry.hashNext}),
  };
  const table=createScriptNames({names,freeIndices,buckets,allocator});
  const first=table.intern('Alpha');
  const second=table.intern('Beta');
  assert.equal(table.find('alpha'),first.index);
  assert.equal(table.find('BETA'),second.index);
  assert.equal(table.find('\u0000IgnoredSuffix'),0);
  const existingNativeRequest=table.intern('aLPHA',2);
  assert.equal(existingNativeRequest.index,first.index);
  assert.equal(names[first.index].flags,0);

  const terminated=table.intern('Trim\u0000IgnoredSuffix');
  assert.equal(terminated.name,'Trim');
  assert.equal(table.find('trim\u0000DifferentSuffix'),terminated.index);

  table.deleteEntry(first.index);
  assert.deepEqual(events,[{
    kind:'free',entry:names[first.index] ?? events[0].entry,index:first.index,
    bucket:hashScriptNameBucket('Alpha'),slot:events[0].entry,next:null,
  }]);
  assert.equal(names[first.index],null);
  assert.deepEqual(freeIndices,[first.index]);
  assert.equal(table.find('alpha'),-1);

  const reused=table.intern('Gamma');
  assert.equal(reused.index,first.index);
  assert.equal(names[first.index].text,'Gamma');
  assert.deepEqual(freeIndices,[]);
  assert.equal(table.find('gAmMa'),first.index);
  assert.equal(table.freeNameCapacity,33);

  const oversizedNames=[{index:0,flags:0,hashNext:null,text:'None'},null];
  const oversized= createScriptNames({
    names:oversizedNames,
    freeIndices:[1],
    buckets:Array(0x1000).fill(null),
    freeNameCapacity:0x1001,
    allocator:{free:()=>{}},
  });
  oversized.intern('Reused');
  assert.equal(oversized.freeNameCapacity,0);
});
