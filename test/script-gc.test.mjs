import test from 'node:test';
import assert from 'node:assert/strict';
import {collectGarbage,GC_FLAGS} from '../src/runtime/script-gc.mjs';

function runGc(registry,events,keepFlags=0) {
  return collectGarbage(registry,keepFlags,{
    conditionalDestroy: object => events.push(`destroy:${object.id}`),
    finalDelete: (object,scalar) => events.push(`release:${object.id}:${scalar}`),
    deleteName: (index,name) => events.push(`name:${index}:${name.id}`),
  });
}

test('mark archive retains a reachable cycle and purges objects before names',()=>{
  const liveName={id:'live',flags:0};
  const deadName={id:'dead',flags:0};
  const first={id:'first',flags:0,isUObject:true};
  const second={id:'second',flags:0,isUObject:true};
  const garbage={id:'garbage',flags:0,isUObject:true};
  const backEdge={value:null};
  first.serialize=archive=>{
    archive.serializeObject({value:second});
    archive.serializeName({value:liveName});
  };
  second.serialize=archive=>{
    backEdge.value=first;
    archive.serializeObject(backEdge);
  };
  const registry={objects:[first,second,garbage],names:[liveName,deadName],rootSet:[first]};
  const events=[];

  assert.deepEqual(runGc(registry,events),{
    skipped:null,objects:3,destroyed:1,released:1,names:1,refs:3,
  });
  assert.deepEqual(events,[
    'destroy:garbage',
    'release:garbage:1',
    'name:1:dead',
  ]);
  assert.equal(first.flags&GC_FLAGS.unreachable,0);
  assert.equal(second.flags&GC_FLAGS.unreachable,0);
  assert.equal(backEdge.value,first);
  assert.notEqual(garbage.flags&GC_FLAGS.unreachable,0);
  assert.equal(liveName.flags&GC_FLAGS.unreachable,0);
  assert.notEqual(deadName.flags&GC_FLAGS.unreachable,0);
});

test('root masks mark matching records while raw excluded roots are nulled and purged',()=>{
  const masked={id:'masked',flags:0x100,isUObject:true,serialize(){}};
  const excluded={id:'excluded',flags:GC_FLAGS.archiveExcluded,isUObject:true,serialize(){}};
  const registry={objects:[masked,excluded],names:[],rootSet:[excluded]};
  const events=[];

  runGc(registry,events,0x100);

  assert.equal(registry.rootSet[0],null);
  assert.equal(masked.flags&GC_FLAGS.unreachable,0);
  assert.notEqual(excluded.flags&GC_FLAGS.unreachable,0);
  assert.deepEqual(events,[
    'destroy:excluded',
    'release:excluded:1',
  ]);
});
