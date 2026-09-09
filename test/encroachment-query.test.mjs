import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollisionHash} from '../src/runtime/collision-hash.mjs';
import {primitiveCollisionBounds} from '../src/runtime/brush-bounds.mjs';
import {actorEncroachmentCheck} from '../src/runtime/encroachment-query.mjs';

test('native encroachment appends candidate order, checks posed source and restores pose',()=>{
 const actors=[100,104,104].map((x,i)=>({id:['a','b','c'][i],lineage:['engine.actor'],values:{Location:[x,0,0],Rotation:[0,0,0],CollisionRadius:10,CollisionHeight:10}}));
 const hash=createCollisionHash();for(const a of actors)hash.addActor(a,primitiveCollisionBounds(null,a.values),{location:a.values.Location});
 const hits=actorEncroachmentCheck(hash,actors[0],[102,0,0],[0,0,0]);
 assert.deepEqual(hits.map(h=>h.actor.id),['c','b']);
 for(const h of hits){assert.deepEqual(h.location,[92,0,0]);assert.deepEqual(h.normal,[1,0,0]);assert.equal(h.time,1);assert.equal(h.primitive,null);}
 assert.deepEqual(actors[0].values.Location,[100,0,0]);
 assert.deepEqual(actors[0].values.Rotation,[0,0,0]);
 // The source's old registration still removes with its original bounds.
 assert.equal(hash.removeActor(actors[0],primitiveCollisionBounds(null,actors[0].values),{location:[100,0,0]}),true);
});
